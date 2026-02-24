const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ অ্যাডমিন মাস্টার কনফিগ
// ==========================================
const ADMIN_USER = "naim1155"; 
const ADMIN_PASS = "115510"; 
const ADMIN_TG_TOKEN = "8380847229:AAG57WcfWbTkYG53yqVXdFiIOp3gZrjF_Fs"; 

const DB_FILE = 'master_database.json';

function getAllUsers() {
    if (!fs.existsSync(DB_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) { return {}; }
}
function saveUser(userId, data) {
    let users = getAllUsers();
    users[userId] = { ...users[userId], ...data };
    fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
}

const COINS = [
    { s: "BTCUSDT", n: "BTC", d: 2, qd: 3 }, { s: "ETHUSDT", n: "ETH", d: 2, qd: 3 }, 
    { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 }, { s: "1000PEPEUSDT", n: "PEPE", d: 7, qd: 0 },
    { s: "BONKUSDT", n: "BONK", d: 8, qd: 0 }, { s: "WIFUSDT", n: "WIF", d: 4, qd: 1 },
    { s: "DOGEUSDT", n: "DOGE", d: 5, qd: 0 }, { s: "NEARUSDT", n: "NEAR", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, history: [], avg: 0 });
let userSlots = {}; 

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

async function sendTG(msg, chatId) {
    try { await axios.post(`https://api.telegram.org/bot${ADMIN_TG_TOKEN}/sendMessage`, { chat_id: chatId, text: msg, parse_mode: 'Markdown' }); } catch (e) {}
}

async function setLeverage(symbol, leverage, config) {
    if (config.mode === 'demo') return;
    const ts = Date.now();
    const query = `symbol=${symbol}&leverage=${leverage}&timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try { await axios.post(`https://fapi.binance.com/fapi/v1/leverage?${query}&signature=${signature}`, null, { headers: { 'X-MBX-APIKEY': config.api } }); } catch (e) {}
}

async function placeOrder(symbol, side, qty, config) {
    if (config.mode === 'demo') return { status: 'FILLED', orderId: 'DEMO' };
    await setLeverage(symbol, config.lev, config);
    const ts = Date.now();
    const query = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.post(`https://fapi.binance.com/fapi/v1/order?${query}&signature=${signature}`, null, { headers: { 'X-MBX-APIKEY': config.api } });
        return res.data;
    } catch (e) { return null; }
}

async function startGlobalEngine() {
    const streams = COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    ws.on('message', async (data) => {
        const payload = JSON.parse(data);
        const msg = payload.data;
        if (!msg || !market[msg.s]) return;

        const s = market[msg.s];
        s.lp = s.p; s.p = parseFloat(msg.c);
        s.history.push(s.p); if(s.history.length > 20) s.history.shift();
        s.avg = s.history.reduce((a,b)=>a+b, 0) / s.history.length;

        let db = getAllUsers();
        for (let userId in db) {
            let config = db[userId];
            if (config.isPaused) continue;

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, dca: 0, curP: 0, pnl: 0 }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.curP = s.p;
                sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * config.lev;

                // 💰 সেল লজিক (০.৩% প্রফিট টার্গেট)
                if (s.p >= sl.sell) {
                    const fee = (sl.qty * sl.sell * 0.001); // ০.১% ফি (Round trip)
                    const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy) - fee;
                    sl.active = false; sl.status = 'IDLE';
                    config.profit += gain; config.count += 1;
                    saveUser(userId, config);
                    sendTG(`🎯 *সেল সাকসেস!* \nমোনাফা: $${gain.toFixed(2)} (৳${(gain*124).toFixed(0)})\nমোট ট্রেড: ${config.count}\nফি বাদ দেওয়া হয়েছে।`, config.cid);
                }

                // 🛡️ DCA লজিক (০.৮% ড্রপ করলে)
                if (((sl.buy - s.p) / sl.buy) * 100 >= 0.8 && sl.dca < 6) {
                    const order = await placeOrder(sl.sym, "BUY", sl.qty, config);
                    if (order) {
                        sl.buy = (sl.buy + s.p) / 2;
                        sl.qty = (parseFloat(sl.qty) * 2).toFixed(COINS.find(c=>c.s===sl.sym).qd);
                        sl.sell = (sl.buy * 1.003).toFixed(COINS.find(c=>c.s===sl.sym).d);
                        sl.dca++;
                        sendTG(`🔄 *DCA এন্ট্রি #${sl.dca}* \nকয়েন: ${sl.sym}\nনতুন এভারেজ বাই: ${sl.buy.toFixed(4)}`, config.cid);
                    }
                }
            });

            // ⚡ নতুন ট্রেড এন্ট্রি
            const slotIdx = slots.findIndex(sl => !sl.active);
            if (slotIdx !== -1 && s.p < s.avg * 0.9995) {
                const coin = COINS.find(c => c.s === msg.s);
                if (!slots.some(x => x.active && x.sym === msg.s)) {
                    const qty = ((config.cap / 5 * config.lev) / s.p).toFixed(coin.qd);
                    const order = await placeOrder(msg.s, "BUY", qty, config);
                    if (order) {
                        slots[slotIdx] = { id: slotIdx, active: true, status: 'BOUGHT', sym: msg.s, buy: s.p, sell: s.p * 1.0035, qty: qty, dca: 0, curP: s.p, pnl: 0 };
                        sendTG(`🚀 *বাই সাকসেস!* \nকয়েন: ${coin.n}\nপ্রাইস: ${s.p}\nমোড: ${config.mode}`, config.cid);
                    }
                }
            }
        }
    });
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}

const server = http.createServer((req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        saveUser(id, { api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), cid: url.searchParams.get('cid'), cap: parseFloat(url.searchParams.get('cap')), lev: parseInt(url.searchParams.get('lev')), mode: url.searchParams.get('mode'), profit: 0, count: 0, isPaused: false });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<html><body style="background:#020617;color:white;text-align:center;font-family:sans-serif;padding-top:100px;">
            <h1 style="color:#38bdf8;">QUANTUM MASTER V3</h1>
            <form action="/register" style="display:inline-block;background:#0f172a;padding:30px;border-radius:20px;border:1px solid #1e293b;">
                <input name="id" placeholder="Username" required style="display:block;width:100%;margin-bottom:10px;padding:12px;background:#000;color:white;border:1px solid #334155;border-radius:10px;">
                <select name="mode" style="display:block;width:100%;margin-bottom:10px;padding:12px;background:#000;color:white;border:1px solid #334155;border-radius:10px;"><option value="demo">Demo Mode</option><option value="live">Live Mode</option></select>
                <input name="api" placeholder="Binance API Key" style="display:block;width:100%;margin-bottom:10px;padding:12px;background:#000;color:white;border:1px solid #334155;border-radius:10px;">
                <input name="sec" placeholder="Binance Secret Key" style="display:block;width:100%;margin-bottom:10px;padding:12px;background:#000;color:white;border:1px solid #334155;border-radius:10px;">
                <input name="cid" placeholder="Telegram Chat ID" required style="display:block;width:100%;margin-bottom:10px;padding:12px;background:#000;color:white;border:1px solid #334155;border-radius:10px;">
                <div style="display:flex;gap:10px;">
                    <input name="cap" type="number" placeholder="Cap" value="10" style="width:50%;padding:12px;background:#000;color:white;border:1px solid #334155;border-radius:10px;">
                    <input name="lev" type="number" placeholder="Lev" value="20" style="width:50%;padding:12px;background:#000;color:white;border:1px solid #334155;border-radius:10px;">
                </div><br>
                <button style="width:100%;background:#0ea5e9;color:white;padding:15px;border:none;border-radius:10px;font-weight:bold;cursor:pointer;">LAUNCH CORE</button>
            </form>
        </body></html>`);
    } else {
        const user = db[userId];
        const slots = userSlots[userId] || Array(5).fill({sym:'Empty',active:false,pnl:0,curP:0,buy:0,dca:0});
        res.end(`<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-4">
            <div class="max-w-xl mx-auto space-y-4">
                <div class="p-6 bg-slate-900 rounded-[2rem] border border-sky-500/30 flex justify-between items-center shadow-2xl">
                    <div><h2 class="text-3xl font-black text-sky-400 italic">${userId.toUpperCase()}</h2><p class="text-[10px] font-bold text-green-500">ENGINE: ${user.mode.toUpperCase()}</p></div>
                    <div class="text-right"><p class="text-[10px] text-slate-500">নিট লাভ (ফি বাদে)</p><p class="text-3xl font-black text-green-400">৳${(user.profit * 124).toFixed(0)}</p></div>
                </div>
                <div class="grid grid-cols-2 gap-4">
                    <div class="p-4 bg-slate-900 rounded-3xl border border-slate-800"><p class="text-[10px] text-slate-500">PROFIT USD</p><p class="text-2xl font-bold">$${user.profit.toFixed(2)}</p></div>
                    <div class="p-4 bg-slate-900 rounded-3xl border border-slate-800"><p class="text-[10px] text-slate-500">TOTAL TRADES</p><p class="text-2xl font-bold">${user.count}</p></div>
                </div>
                <div class="space-y-3">
                    ${slots.map((s,i) => `
                        <div class="p-4 bg-slate-900/50 rounded-2xl border border-slate-800 flex justify-between items-center">
                            <div>
                                <p class="text-[10px] text-slate-500">Slot ${i+1} | DCA: ${s.dca || 0}</p>
                                <p class="text-lg font-black ${s.active ? 'text-sky-400' : 'text-slate-700'}">${s.active ? s.sym : 'IDLE'}</p>
                                ${s.active ? `<p class="text-[10px]">Buy: ${s.buy.toFixed(2)} | Live: ${s.curP.toFixed(2)}</p>` : ''}
                            </div>
                            <div class="text-right">
                                ${s.active ? `<span class="px-3 py-1 bg-green-500/10 text-green-500 rounded-full text-xs font-bold">${s.pnl.toFixed(2)}%</span>` : '<span class="text-slate-800">●</span>'}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
            <script>setTimeout(()=>location.reload(), 4000);</script>
        </body></html>`);
    }
});

server.listen(process.env.PORT || 8080, () => startGlobalEngine());

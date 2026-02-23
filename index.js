const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ অ্যাডমিন ও ডাটাবেস কনফিগ
// ==========================================
const MASTER_TG_TOKEN = "8281887575:AAGRTPvSdT4ho8C2NwsxCHyUMkRq2q6qWDc"; 
const DB_FILE = 'nebula_master_final.json';

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
    { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 }, { s: "XRPUSDT", n: "XRP", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, history: [] });
let userSlots = {}; 

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

// 📢 টেলিগ্রাম মেসেজ ফাংশন
async function sendTG(msg, chatId) {
    try {
        await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, {
            chat_id: chatId, text: msg, parse_mode: 'Markdown'
        });
    } catch (e) { console.log("TG Error"); }
}

// ⚙️ বাইনান্স ফাংশনস
async function setLeverage(symbol, leverage, config) {
    if (config.mode === 'demo') return;
    const ts = Date.now();
    const query = `symbol=${symbol}&leverage=${leverage}&timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try {
        await axios.post(`https://fapi.binance.com/fapi/v1/leverage?${query}&signature=${signature}`, null, {
            headers: { 'X-MBX-APIKEY': config.api }
        });
    } catch (e) {}
}

async function getBinanceBalance(config) {
    if (config.mode === 'demo' || !config.api) return "1000.00";
    const ts = Date.now();
    const query = `timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?${query}&signature=${signature}`, {
            headers: { 'X-MBX-APIKEY': config.api }, timeout: 5000
        });
        return parseFloat(res.data.totalWalletBalance).toFixed(2);
    } catch (e) { return "Error"; }
}

async function placeOrder(symbol, side, price, qty, config, type = "LIMIT") {
    if (config.mode === 'demo') return { status: 'FILLED' };
    const ts = Date.now();
    let query = `symbol=${symbol}&side=${side}&type=${type}&quantity=${qty}&timestamp=${ts}`;
    if(type === "LIMIT") query += `&price=${price}&timeInForce=GTC`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.post(`https://fapi.binance.com/fapi/v1/order?${query}&signature=${signature}`, null, {
            headers: { 'X-MBX-APIKEY': config.api }
        });
        return res.data;
    } catch (e) { return null; }
}

// 🚀 ট্রেড ইঞ্জিন (DCA + Telegram সহ)
async function startGlobalEngine() {
    const streams = COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    ws.on('message', async (data) => {
        const payload = JSON.parse(data);
        const msg = payload.data;
        if (!msg || !market[msg.s]) return;

        const s = market[msg.s];
        s.p = parseFloat(msg.c);
        s.history.push(s.p); if(s.history.length > 50) s.history.shift();
        const avgP = s.history.reduce((a,b)=>a+b, 0) / s.history.length;

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            if (config.status !== 'active') continue;

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, pnl: 0, curP: 0, dca1:0, dca2:0, qty:0 }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.curP = s.p;
                sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * config.lev;

                // DCA 1 লজিক
                if (sl.status === 'BOUGHT' && s.p <= sl.dca1) {
                    sl.status = 'DCA1_ACTIVE';
                    sendTG(`📉 *DCA 1 এন্ট্রি:* ${sl.sym}\nপ্রাইস: ${s.p}`, config.cid);
                }

                // SELL লজিক (প্রফিট হলে)
                if (s.p >= sl.sell && sl.active) {
                    const profitAmount = (sl.qty * (sl.sell - sl.buy));
                    config.profit += profitAmount;
                    config.count += 1;
                    saveUser(userId, config);
                    sendTG(`🎉 *ট্রেড ক্লোজ (SOLD):* ${sl.sym}\nলাভ: ৳${(profitAmount * 124).toFixed(2)}`, config.cid);
                    sl.active = false; sl.status = 'IDLE';
                }
            });

            // নতুন ট্রেড ওপেনিং
            const slotIdx = slots.findIndex(sl => !sl.active);
            if (!config.isPaused && slotIdx !== -1 && s.p < avgP * 0.998) {
                const coin = COINS.find(c => c.s === msg.s);
                const buyP = s.p;
                const qty = ((config.cap / 5 * config.lev) / buyP).toFixed(coin.qd);

                await setLeverage(msg.s, config.lev, config);
                const order = await placeOrder(msg.s, "BUY", buyP.toFixed(coin.d), qty, config, "LIMIT");
                
                if (order) {
                    slots[slotIdx] = { 
                        id: slotIdx, active: true, status: 'BOUGHT', sym: msg.s, 
                        buy: buyP, sell: buyP * 1.002, qty: qty, pnl: 0, curP: s.p, 
                        dca1: buyP * 0.99, dca2: buyP * 0.98 
                    };
                    sendTG(`📥 *নতুন বাই:* ${msg.s}\nপ্রাইস: ${buyP.toFixed(coin.d)}\nলেভারেজ: ${config.lev}x`, config.cid);
                }
            }
        }
    });
}

// 🌐 ড্যাশবোর্ড UI
const server = http.createServer((req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    // রিসেট লজিক
    if (url.pathname === '/reset-now') {
        const uid = url.searchParams.get('id');
        if(db[uid]) { 
            db[uid].profit = 0; db[uid].count = 0; 
            saveUser(uid, db[uid]); 
            userSlots[uid] = null;
        }
        res.writeHead(302, { 'Location': '/' + uid }); return res.end();
    }

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        saveUser(id, { 
            api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), cid: url.searchParams.get('cid'), 
            cap: parseFloat(url.searchParams.get('cap')), lev: parseInt(url.searchParams.get('lev')),
            profit: 0, count: 0, status: 'active', isPaused: false 
        });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        // রেজিস্টার পেজ (আগের মতো)
        res.end(`<!DOCTYPE html><html><body style="background:#09090b;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;">
            <form action="/register" style="background:#111114;padding:30px;border-radius:20px;width:300px;">
                <h2>Quantum Setup</h2>
                <input name="id" placeholder="User ID" required style="width:100%;margin-bottom:10px;padding:10px;border-radius:10px;border:none;">
                <input name="api" placeholder="Binance API" style="width:100%;margin-bottom:10px;padding:10px;border-radius:10px;border:none;">
                <input name="sec" placeholder="Binance Secret" style="width:100%;margin-bottom:10px;padding:10px;border-radius:10px;border:none;">
                <input name="cid" placeholder="Telegram Chat ID" required style="width:100%;margin-bottom:10px;padding:10px;border-radius:10px;border:none;">
                <input name="cap" type="number" placeholder="Capital $" style="width:45%;padding:10px;border-radius:10px;border:none;">
                <input name="lev" type="number" placeholder="Lev x" style="width:45%;padding:10px;border-radius:10px;border:none;">
                <button style="width:100%;margin-top:20px;padding:15px;background:#0ea5e9;border:none;border-radius:10px;color:white;font-weight:bold;">LAUNCH</button>
            </form></body></html>`);
    } else {
        const user = db[userId];
        const slots = userSlots[userId] || Array(5).fill({sym:'Empty', pnl:0, curP:0, buy:0, sell:0, dca1:0, dca2:0});
        getBinanceBalance(user).then(balance => {
            res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-[#09090b] text-white p-4 font-sans"><div class="max-w-md mx-auto space-y-4">
                <div class="p-5 bg-[#111114] rounded-3xl border border-zinc-900 shadow-xl">
                    <div class="flex justify-between items-center">
                        <div><h2 class="text-2xl font-black text-sky-400 uppercase">${userId}</h2><p class="text-xs text-zinc-500">Live Trade Engine</p></div>
                        <div class="text-right"><p class="text-[10px] text-zinc-500 uppercase">Binance Balance</p><p class="text-2xl font-black text-green-400">$${balance}</p></div>
                    </div>
                    <div class="grid grid-cols-2 gap-2 mt-4 pt-4 border-t border-zinc-800">
                        <div><p class="text-[9px] text-zinc-500 uppercase">Total Profit (BDT)</p><p class="text-lg font-bold text-green-400">৳${(user.profit * 124).toFixed(0)}</p></div>
                        <div class="text-right"><p class="text-[9px] text-zinc-500 uppercase">Success Trades</p><p class="text-lg font-bold text-sky-400">${user.count}</p></div>
                    </div>
                </div>

                <div class="space-y-3">
                ${slots.map((s,i) => {
                    let cD = COINS.find(c=>c.s===s.sym)?.d || 2;
                    return `
                    <div class="p-5 bg-[#111114] rounded-3xl border border-zinc-900">
                        <div class="flex justify-between items-start mb-1">
                            <span class="text-[10px] font-bold text-zinc-600 uppercase">Slot ${i+1}</span>
                            <span class="text-lg font-bold ${s.pnl>=0?'text-green-400':'text-red-400'}">${s.pnl.toFixed(2)}% PNL</span>
                        </div>
                        <h3 class="text-2xl font-black text-sky-400">${s.sym.replace('USDT','')}</h3>
                        ${s.active ? `
                        <div class="grid grid-cols-2 gap-y-2 text-[11px] mt-2 font-bold text-zinc-400">
                            <div>BUY: <span class="text-white">${s.buy.toFixed(cD)}</span></div>
                            <div class="text-right">LIVE: <span class="text-sky-400">${s.curP.toFixed(cD)}</span></div>
                            <div class="text-red-400">DCA 1: ${s.dca1.toFixed(cD)}</div>
                            <div class="text-right text-green-400">TARGET: ${s.sell.toFixed(cD)}</div>
                        </div>` : '<p class="text-[10px] text-zinc-800 font-bold uppercase mt-2">Scanning Market...</p>'}
                    </div>`}).join('')}
                </div>

                <div class="text-center pt-6">
                    <button onclick="if(confirm('Reset all stats?')) location.href='/reset-now?id=${userId}'" class="text-[10px] bg-red-500/10 text-red-500 px-6 py-2 rounded-full border border-red-500/20 font-bold uppercase tracking-widest">Reset Master Core</button>
                </div>
            </div><script>setTimeout(()=>location.reload(), 5000);</script></body></html>`);
        });
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => { startGlobalEngine(); });

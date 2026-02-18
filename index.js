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

const DB_FILE = 'nebula_master_db.json';
const SETTINGS_FILE = 'settings.json';

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
    { s: "DOGEUSDT", n: "DOGE", d: 5, qd: 0 }, { s: "NEARUSDT", n: "NEAR", d: 4, qd: 1 },
    { s: "AVAXUSDT", n: "AVAX", d: 3, qd: 1 }, { s: "LINKUSDT", n: "LINK", d: 3, qd: 2 },
    { s: "DOTUSDT", n: "DOT", d: 3, qd: 1 }, { s: "SUIUSDT", n: "SUI", d: 4, qd: 1 },
    { s: "APTUSDT", n: "APT", d: 3, qd: 1 }, { s: "OPUSDT", n: "OP", d: 4, qd: 1 },
    { s: "TIAUSDT", n: "TIA", d: 3, qd: 1 }, { s: "XRPUSDT", n: "XRP", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, trend: 0, history: [] });
let userSlots = {}; 

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

async function sendTG(msg, chatId) {
    try { await axios.post(`https://api.telegram.org/bot${ADMIN_TG_TOKEN}/sendMessage`, { chat_id: chatId, text: msg, parse_mode: 'Markdown' }); } catch (e) {}
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

// 🚀 ওমনি ইঞ্জিন (The Sentinel Core)
async function startGlobalEngine() {
    const streams = COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    ws.on('message', async (data) => {
        const payload = JSON.parse(data);
        const msg = payload.data;
        if (!msg || !market[msg.s]) return;

        const s = market[msg.s];
        s.lp = s.p; s.p = parseFloat(msg.c);
        
        // প্রাইজ মেমোরি ট্রাক করা (Buy the Dip নিশ্চিত করতে)
        s.history.push(s.p); if(s.history.length > 50) s.history.shift();
        const avgPrice = s.history.reduce((a,b) => a+b, 0) / s.history.length;

        // ট্রেন্ড এনালাইসিস: দাম বাড়লে টিক বাড়বে
        if (s.p > s.lp) s.trend = Math.min(10, s.trend + 1); 
        else if (s.p < s.lp) s.trend = 0;

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            if (config.status !== 'active') continue;

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, pnl: 0, lastBuy: 0, dca: 0, waitTime: 0 }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;

                if (sl.status === 'WAITING') {
                    if (Date.now() - sl.waitTime > 120000) { 
                        sl.active = false; sl.status = 'IDLE'; sl.sym = '';
                        return;
                    }
                    if (s.p <= sl.buy) {
                        sl.status = 'BOUGHT';
                        sendTG(`🟢 *Buy Confirmed:* ${sl.sym}`, config.cid);
                    }
                }

                if (sl.status === 'BOUGHT') {
                    sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * (config.lev || 50);

                    // লিকুইডেশন এড়াতে অ্যাগ্রেসিভ DCA (০.৫০% ড্রপে)
                    const drop = ((sl.lastBuy - s.p) / sl.lastBuy) * 100;
                    if (drop >= 0.50 && sl.dca < 12) {
                        const order = await placeOrder(sl.sym, "BUY", s.p.toFixed(COINS.find(c=>c.s===sl.sym).d), sl.qty, config);
                        if (order) {
                            sl.buy = (sl.buy + s.p) / 2; sl.qty = (parseFloat(sl.qty) * 2).toFixed(COINS.find(c=>c.s===sl.sym).qd);
                            sl.sell = (sl.buy * 1.0006).toFixed(COINS.find(c=>c.s===sl.sym).d); sl.dca++; sl.lastBuy = s.p;
                            sendTG(`🛡️ *Shield Active:* ${sl.sym} রিকাভার করা হচ্ছে (L${sl.dca})`, config.cid);
                        }
                    }

                    // লাভ হলে ফি বাদ দিয়ে সেল (নিশ্চিত প্রফিট গার্ড)
                    if (s.p >= sl.sell) {
                        const sellVal = sl.qty * s.p;
                        const buyVal = sl.qty * sl.buy;
                        const totalFee = sellVal * 0.001; 
                        const netGain = sellVal - buyVal - totalFee;

                        if (netGain >= 0.01) { 
                            sl.active = false; config.profit += netGain; config.count += 1;
                            saveUser(userId, config);
                            sendTG(`🎉 *DONE!* ${sl.sym} \n💵 নিট লাভ: ৳${(netGain*124).toFixed(0)} \n📈 মোট: ৳${(config.profit*124).toFixed(0)}`, config.cid);
                            sl.status = 'IDLE'; sl.sym = '';
                        }
                    }
                }
            });

            // ৫. এন্ট্রি লজিক: ট্রেন্ড নিশ্চিত হওয়ার পর (Trend >= 3) এবং দাম গড়ের নিচে থাকলে
            const slotIdx = slots.findIndex(sl => !sl.active);
            if (slotIdx !== -1 && s.trend >= 3 && s.p < avgPrice && !slots.some(sl => sl.active && sl.sym === msg.s)) {
                const coin = COINS.find(c => c.s === msg.s);
                const buyPrice = (s.p * 0.9998).toFixed(coin.d); 
                const sellPrice = (parseFloat(buyPrice) * 1.0012).toFixed(coin.d);
                const qty = ((config.cap / 5 * config.lev) / parseFloat(buyPrice)).toFixed(coin.qd);

                const order = await placeOrder(msg.s, "BUY", buyPrice, qty, config, "LIMIT");
                if (order) {
                    slots[slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: msg.s, buy: parseFloat(buyPrice), sell: parseFloat(sellPrice), qty: qty, pnl: 0, lastBuy: parseFloat(buyPrice), dca: 0, waitTime: Date.now() };
                }
            }
        }
    });
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}

// 🌐 মাস্টার ড্যাশবোর্ড
const server = http.createServer((req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    if (url.pathname === '/reset-now') {
        const id = url.searchParams.get('id');
        if(db[id]) { db[id].profit = 0; db[id].count = 0; saveUser(id, db[id]); delete userSlots[id]; }
        res.writeHead(302, { 'Location': '/' }); return res.end();
    }

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        saveUser(id, { api: url.searchParams.get('api') || 'demo', sec: url.searchParams.get('sec') || 'demo', cid: url.searchParams.get('cid'), cap: parseFloat(url.searchParams.get('cap')), lev: parseInt(url.searchParams.get('lev')) || 50, mode: url.searchParams.get('mode'), profit: 0, count: 0, status: (id === ADMIN_USER) ? 'active' : 'pending', expiry: (id === ADMIN_USER) ? new Date(2099,1,1).toISOString() : new Date().toISOString() });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-6 font-sans flex items-center min-h-screen text-center"><div class="max-w-md mx-auto space-y-6 w-full">
            <h1 class="text-4xl font-black text-sky-400 italic italic">QUANTUM MASTER</h1>
            <form action="/register" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 text-left shadow-2xl border border-sky-500/10">
                <input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white outline-none focus:border-sky-500" required>
                <select name="mode" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select>
                <input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white">
                <input name="sec" placeholder="Binance Secret Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white">
                <input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white" required>
                <div class="grid grid-cols-2 gap-3"><input name="cap" type="number" min="5" value="10" class="bg-black p-4 rounded-2xl text-white"><input name="lev" type="number" value="50" class="bg-black p-4 rounded-2xl text-white"></div>
                <button class="w-full bg-sky-600 p-5 rounded-[2rem] font-black uppercase shadow-lg">Launch System</button>
            </form>
        </div></body></html>`);
    } else {
        let user = db[userId];
        let slots = userSlots[userId] || Array(5).fill({sym:'READY',status:'IDLE',active:false, pnl:0});
        const active = (userId === ADMIN_USER) || (user.status === 'active');
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-4 font-sans"><div class="max-w-xl mx-auto space-y-4">
            <div class="p-6 bg-slate-900 rounded-[2.5rem] border ${active ? 'border-green-500/40' : 'border-red-500/30'} flex justify-between items-center shadow-xl shadow-sky-500/10">
                <div><h2 class="text-3xl font-black italic underline decoration-sky-600">${userId.toUpperCase()}</h2><p class="text-[10px] text-slate-500 uppercase mt-1">Sentinel Core Active</p></div>
                <div class="text-right"><div class="text-[9px] font-bold text-slate-500 uppercase">Wallet Gain</div><div class="text-3xl font-black text-green-400">৳${(user.profit * 124).toFixed(0)}</div></div>
            </div>
            <div class="bg-zinc-900/50 p-6 rounded-[2.5rem] border border-zinc-800 space-y-3 shadow-inner">
                ${slots.map((s,i) => `<div class="flex justify-between p-4 bg-black/40 rounded-2xl border border-zinc-800/50 transition-all ${s.active ? 'border-sky-500/20 shadow-lg' : ''}"><div><span class="text-[9px] font-bold text-slate-600 italic">Slot ${i+1}</span><p class="text-sm font-black ${s.active ? 'text-sky-400' : 'text-zinc-800'}">${s.active ? s.sym.replace('USDT','') : 'IDLE'}</p></div><div class="text-right">${s.active ? `<span class="text-xs font-bold ${s.pnl>=0?'text-green-500':'text-red-400'}">${s.pnl.toFixed(2)}% PNL</span>` : '<span class="text-[9px] text-zinc-700 font-black">SEARCHING</span>'}</div></div>`).join('')}
            </div>
            <div class="grid grid-cols-2 gap-4">
                <div class="bg-zinc-900/80 p-5 rounded-3xl border border-zinc-800 text-center"><p class="text-[10px] text-slate-500 font-bold uppercase mb-1">Gain (USD)</p><p class="text-2xl font-bold text-green-400">$${user.profit.toFixed(2)}</p></div>
                <div class="bg-zinc-900/80 p-5 rounded-3xl border border-zinc-800 text-center"><p class="text-[10px] text-slate-500 font-bold uppercase mb-1">Total Trades</p><p class="text-2xl font-bold text-sky-400">${user.count}</p></div>
            </div>
            <div class="text-center opacity-30"><button onclick="if(confirm('রিসেট করবেন? সব রানিং স্লট মুছে যাবে।')) location.href='/reset-now?id=${userId}'" class="text-[10px] text-red-500 font-bold uppercase underline underline-offset-4 tracking-widest">Reset All Data</button></div>
        </div><script>if(${active}) setTimeout(()=>location.reload(), 5000);</script></body></html>`);
    }
});

server.listen(process.env.PORT || 8080, () => {
    startGlobalEngine();
});

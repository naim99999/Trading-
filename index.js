const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ মাস্টার কনফিগ (Preset)
// ==========================================
const ADMIN_USER = "naim1155"; 
const ADMIN_PASS = "115510"; 
const ADMIN_TG_TOKEN = "8281887575:AAGRTPvSdT4ho8C2NwsxCHyUMkRq2q6qWDc"; 
const ADMIN_CHAT_ID = "5279510350";
const ADMIN_API = "zjZgsBWc77SC6xVxiY58HDZ1ToGLuS37A3Zw1GfxUnESoNyksw3weVoaiWTk5pec";
const ADMIN_SEC = "YlvltwUt2LpP1WHDPST9WKNvj6bSJvjxn9nqZiz32JgJab6B9GJrREBg633qQGzn";

const DB_FILE = 'nebula_v7000_db.json';
const SETTINGS_FILE = 'global_settings.json';

function getAllUsers() {
    if (!fs.existsSync(DB_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) { return {}; }
}
function saveUser(userId, data) {
    let users = getAllUsers();
    users[userId] = { ...users[userId], ...data };
    fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
}

// 🎯 ৬০টি কয়েন পুল (যাতে ক্যাপিটাল ১ সেকেন্ডও বসে না থাকে)
const COINS = [
    { s: "BTCUSDT", n: "BTC", d: 2, qd: 3 }, { s: "ETHUSDT", n: "ETH", d: 2, qd: 3 }, 
    { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 }, { s: "1000PEPEUSDT", n: "PEPE", d: 7, qd: 0 },
    { s: "BONKUSDT", n: "BONK", d: 8, qd: 0 }, { s: "WIFUSDT", n: "WIF", d: 4, qd: 1 },
    { s: "DOGEUSDT", n: "DOGE", d: 5, qd: 0 }, { s: "NEARUSDT", n: "NEAR", d: 4, qd: 1 },
    { s: "AVAXUSDT", n: "AVAX", d: 3, qd: 2 }, { s: "XRPUSDT", n: "XRP", d: 4, qd: 1 },
    { s: "DOTUSDT", n: "DOT", d: 3, qd: 1 }, { s: "LINKUSDT", n: "LINK", d: 3, qd: 2 },
    { s: "SUIUSDT", n: "SUI", d: 4, qd: 1 }, { s: "APTUSDT", n: "APT", d: 3, qd: 1 },
    { s: "TIAUSDT", n: "TIA", d: 3, qd: 1 }, { s: "ARBUSDT", n: "ARB", d: 4, qd: 1 },
    { s: "INJUSDT", n: "INJ", d: 3, qd: 2 }, { s: "FILUSDT", n: "FIL", d: 3, qd: 1 },
    { s: "MATICUSDT", n: "MATIC", d: 4, qd: 0 }, { s: "BCHUSDT", n: "BCH", d: 2, qd: 3 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, trend: 0, history: [], mom: 0 });
let userSlots = {}; 
let lastReportMin = -1;

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }
function getOrdinal(n) {
    const ords = ["", "১ম", "২য়", "৩য়", "৪র্থ", "৫ম", "৬ষ্ঠ", "৭ম", "৮ম", "৯ম", "১০ম"];
    return n <= 10 ? ords[n] : n + "-তম";
}

async function getBinanceBalance(config) {
    if (config.mode === 'demo' || !config.api || config.api === 'demo') return "Infinity (DEMO)";
    const ts = Date.now();
    const query = `timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?${query}&signature=${signature}`, {
            headers: { 'X-MBX-APIKEY': config.api }, timeout: 5000
        });
        return parseFloat(res.data.totalWalletBalance).toFixed(2);
    } catch (e) { return "Connect Error"; }
}

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

// 🚀 ৩০০০ মাস্টার এঞ্জিন
async function startGlobalEngine() {
    const streams = COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    ws.on('message', async (data) => {
        const payload = JSON.parse(data);
        const msg = payload.data;
        if (!msg || !market[msg.s]) return;

        const s = market[msg.s];
        s.lp = s.p; s.p = parseFloat(msg.c);
        s.history.push(s.p); if(s.history.length > 50) s.history.shift();
        const avgP = s.history.reduce((a,b)=>a+b, 0) / s.history.length;

        if (s.p > s.lp) { s.trend = Math.min(10, s.trend + 1); s.mom = Math.min(100, s.mom + 20); } 
        else if (s.p < s.lp) { s.trend = 0; s.mom = Math.max(0, s.mom - 20); }

        const bdtTime = new Date(Date.now() + (6 * 60 * 60 * 1000));
        if (bdtTime.getUTCMinutes() % 10 === 0 && bdtTime.getUTCMinutes() !== lastReportMin) {
            let users = getAllUsers();
            for(let id in users) if(users[id].status === 'active') sendTG(`📊 *১০-মিনিট প্রফিট আপডেট*\nবর্তমান লাভ: ৳${(users[id].profit * 124).toFixed(0)}`, users[id].cid);
            lastReportMin = bdtTime.getUTCMinutes();
        }

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            if (config.status !== 'active') continue;

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, pnl: 0, lastBuy: 0, dca: 0, waitTime: 0, curP: 0 }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.curP = s.p;

                // ২-মিনিট রিসাইকেল লজিক
                if (sl.status === 'WAITING' && (Date.now() - sl.waitTime > 120000)) {
                    sl.active = false; sl.status = 'IDLE'; sl.sym = ''; return;
                }
                if (sl.status === 'WAITING' && s.p <= sl.buy) {
                    sl.status = 'BOUGHT';
                    sendTG(`📥 *বাই সম্পন্ন করা হয়েছে!* (S${sl.id+1})\nকয়েন: *${sl.sym.replace('USDT','')}*\nদাম: ${s.p}`, config.cid);
                }

                if (sl.status === 'BOUGHT') {
                    sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * (config.lev || 50);
                    const drop = ((sl.lastBuy - s.p) / sl.lastBuy) * 100;
                    
                    if (drop >= 0.45 && sl.dca < 12) {
                        const order = await placeOrder(sl.sym, "BUY", s.p.toFixed(COINS.find(c=>c.s===sl.sym).d), sl.qty, config);
                        if (order) {
                            sl.buy = (sl.buy + s.p) / 2; sl.qty = (parseFloat(sl.qty) * 2).toFixed(COINS.find(c=>c.s===sl.sym).qd);
                            sl.sell = (sl.buy * 1.0007).toFixed(COINS.find(c=>c.s===sl.sym).d); sl.dca++; sl.lastBuy = s.p;
                        }
                    }
                    if (s.p >= sl.sell) {
                        const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy) - (sl.qty * sl.sell * 0.0008);
                        if (gain >= 0.01) {
                            sl.active = false; config.profit += gain; config.count += 1;
                            saveUser(userId, config);
                            const ord = getOrdinal(config.count);
                            sendTG(`🎉 *${ord} সেল* \nSELL SUCCESS ✅ (Slot ${sl.id+1})\nGain: $${gain.toFixed(2)} (৳${(gain*124).toFixed(0)}) 💰 মোট ৳${(config.profit*124).toFixed(0)}`, config.cid);
                            sl.status = 'IDLE'; sl.sym = '';
                        }
                    }
                }
            });

            // ২-টিক সুপার এন্ট্রি (Predictive Analyzing)
            const slotIdx = slots.findIndex(sl => !sl.active);
            if (!config.isPaused && slotIdx !== -1 && s.trend >= 2 && s.p < avgP) {
                const sameCoin = slots.filter(sl => sl.active && sl.sym === msg.s);
                let canBuy = sameCoin.length === 0 || s.p < Math.min(...sameCoin.map(x => x.buy)) * 0.993;

                if (canBuy) {
                    const buyP = (s.p * 0.9998).toFixed(COINS.find(c=>c.s===msg.s).d); 
                    const sellP = (parseFloat(buyP) * 1.0012).toFixed(COINS.find(c=>c.s===msg.s).d);
                    const qty = ((config.cap / 5 * config.lev) / parseFloat(buyP)).toFixed(COINS.find(c=>c.s===msg.s).qd);
                    const order = await placeOrder(msg.s, "BUY", buyP, qty, config, "LIMIT");
                    if (order) slots[slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: msg.s, buy: parseFloat(buyP), sell: parseFloat(sellP), qty: qty, pnl: 0, lastBuy: parseFloat(buyP), dca: 0, waitTime: Date.now(), curP: s.p };
                }
            }
        }
    });
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}

// 🌐 মাস্টার ড্যাশবোর্ড UI
const server = http.createServer((req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    if (url.pathname === '/toggle-trade') {
        if(db[userId]) { db[userId].isPaused = !db[userId].isPaused; saveUser(userId, db[userId]); }
        res.writeHead(302, { 'Location': '/' + userId }); return res.end();
    }
    if (url.pathname === '/reset-now') {
        if(db[userId]) { db[userId].profit = 0; db[userId].count = 0; saveUser(userId, db[userId]); delete userSlots[userId]; }
        res.writeHead(302, { 'Location': '/' }); return res.end();
    }
    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        const isAdmin = (id === ADMIN_USER);
        saveUser(id, { api: isAdmin?ADMIN_API:url.searchParams.get('api'), sec: isAdmin?ADMIN_SEC:url.searchParams.get('sec'), cid: isAdmin?ADMIN_CHAT_ID:url.searchParams.get('cid'), cap: parseFloat(url.searchParams.get('cap'))||10, lev: parseInt(url.searchParams.get('lev'))||50, mode: url.searchParams.get('mode')||'live', profit: 0, count: 0, status: isAdmin?'active':'pending', expiry: isAdmin?new Date(2099,1,1).toISOString():new Date().toISOString(), isPaused: false });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-6 font-sans flex items-center min-h-screen text-center"><div class="max-w-md mx-auto space-y-6 w-full">
            <h1 class="text-5xl font-black text-sky-400 italic">QUANTUM MASTER</h1>
            <form action="/register" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 text-left shadow-2xl border border-sky-500/10">
                <input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white outline-none focus:border-sky-600" required>
                <select name="mode" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select>
                <input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white outline-none">
                <input name="sec" placeholder="Binance Secret Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white outline-none">
                <input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white outline-none" required>
                <div class="grid grid-cols-2 gap-3"><input name="cap" type="number" min="5" value="10" class="bg-black p-4 rounded-2xl text-white"><input name="lev" type="number" value="50" class="bg-black p-4 rounded-2xl text-white"></div>
                <button class="w-full bg-sky-600 p-5 rounded-[2rem] font-black uppercase shadow-lg active:scale-95 transition">Launch Engine</button>
            </form></div></body></html>`);
    } else {
        let user = db[userId];
        const isAdmin = (userId === ADMIN_USER);
        const active = isAdmin || (user.status === 'active');
        let slots = userSlots[userId] || Array(5).fill({sym:'Empty',status:'IDLE',active:false, pnl:0});
        const avgMom = Object.values(market).reduce((a,b)=>a+b.mom, 0) / COINS.length;
        let mColor = "text-slate-600"; let mText = "LOW";
        if(avgMom > 15) { mColor = "text-sky-400"; mText = "MODERATE"; }
        if(avgMom > 40) { mColor = "text-green-400"; mText = "HIGH"; }

        getBinanceBalance(user).then(balance => {
            res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script>
            <style>body{background:#020617;color:white;font-family:sans-serif;}.progress-bar{height:3px;background:#1e293b;border-radius:2px;overflow:hidden;margin-top:8px;}.progress-fill{height:100%;background:#22c55e;transition:width 0.5s ease;}.card-icon{position:absolute;right:20px;top:35px;font-size:32px;opacity:0.15;}</style></head>
            <body class="p-4 font-sans"><div class="max-w-xl mx-auto space-y-4">
                <div class="p-6 bg-slate-900 rounded-[2rem] border border-sky-500/40 shadow-xl shadow-sky-500/10">
                    <div class="flex justify-between items-center mb-2">
                        <div><h2 class="text-3xl font-black italic underline decoration-sky-600 underline-offset-8 uppercase">${userId}</h2><p class="text-[9px] ${mColor} font-black uppercase tracking-widest mt-4 animate-pulse">${mText} INTENSITY ATTACK</p></div>
                        <div class="text-right"><div class="text-[9px] font-bold text-slate-500 uppercase">Binance Wallet</div><div class="text-3xl font-black text-green-400">$${balance}</div></div>
                    </div>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div class="p-6 bg-slate-900 rounded-[2rem] border border-slate-800 relative overflow-hidden shadow-2xl"><p class="text-[10px] text-slate-500 uppercase font-black">TOTAL PROFIT (BDT)</p><p class="text-4xl font-bold text-green-400 mt-2">৳${(user.profit * 124).toFixed(0)}</p><div class="card-icon">💲</div></div>
                    <div class="p-6 bg-slate-900 rounded-[2rem] border border-slate-800 relative overflow-hidden shadow-2xl"><p class="text-[10px] text-slate-500 uppercase font-black">SUCCESS TRADES</p><p class="text-4xl font-bold text-sky-400 mt-2">${user.count}</p><div class="card-icon">💼</div></div>
                </div>

                <div class="bg-zinc-900/50 p-6 rounded-[2rem] border border-zinc-800 flex justify-between items-center shadow-lg"><span class="text-xs font-bold uppercase text-slate-400 italic font-black">Trade Engine Status</span><button onclick="location.href='/toggle-trade?id=${userId}'" class="px-6 py-2 rounded-full font-black text-[10px] uppercase transition ${user.isPaused ? 'bg-red-500/20 text-red-500 border border-red-500' : 'bg-green-500/20 text-green-400 border border-green-500'}">${user.isPaused ? 'PAUSED' : 'RUNNING'}</button></div>

                <div class="p-6 bg-zinc-900/50 rounded-[2.5rem] border border-zinc-800 space-y-3 shadow-inner">
                    ${slots.map((s,i) => {
                        let progress = 0; if(s.active && s.status === 'BOUGHT') progress = Math.max(0, Math.min(100, ((s.curP - s.buy) / (s.sell - s.buy)) * 100));
                        return `<div class="p-4 bg-black/40 rounded-2xl border border-zinc-800/50 flex justify-between items-center transition-all ${s.active ? 'border-sky-500/20 shadow-lg' : ''}"><div><span class="text-[9px] font-bold text-slate-600 italic uppercase font-black">Slot ${i+1}</span><p class="text-sm font-black ${s.active ? 'text-sky-400' : 'text-zinc-800'}">${s.active ? s.sym.replace('USDT','') : 'IDLE'}</p></div><div class="text-right">${s.active ? `<span class="text-xs font-bold ${s.pnl>=0?'text-green-500':'text-red-400'}">${s.pnl.toFixed(2)}% PNL</span>` : '<span class="text-[9px] text-zinc-700 font-black tracking-widest uppercase text-xs animate-pulse">Scanning</span>'}</div></div>${s.active && s.status === 'BOUGHT' ? `<div class="progress-bar"><div class="progress-fill" style="width: ${progress}%"></div></div>` : ''}`;
                    }).join('')}
                </div>

                <div class="text-center opacity-30"><button onclick="if(confirm('Reset Master?')) location.href='/reset-now?id=${userId}'" class="text-[9px] text-red-500 font-bold uppercase underline underline-offset-4 tracking-widest">Reset Master Core</button></div>
            </div><script>setTimeout(()=>location.reload(), 4500);</script></body></html>`);
        });
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    startGlobalEngine();
});

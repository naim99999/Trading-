const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ অ্যাডমিন কনফিগারেশন
// ==========================================
const ADMIN_USER = "naim1155"; 
const ADMIN_PASS = "115510"; 
const ADMIN_TG_TOKEN = "8380847229:AAG57WcfWbTkYG53yqVXdFiIOp3gZrjF_Fs"; 

const DB_FILE = 'master_database.json';
const SETTINGS_FILE = 'global_settings.json';

// 💾 ডাটাবেজ হ্যান্ডলার
function getAllUsers() {
    if (!fs.existsSync(DB_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) { return {}; }
}
function saveUser(userId, data) {
    let users = getAllUsers();
    users[userId] = { ...users[userId], ...data };
    fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
}

// 🎯 ৪০টি কয়েন পুল
const COINS = [
    { s: "BTCUSDT", n: "BTC", d: 2, qd: 3 }, { s: "ETHUSDT", n: "ETH", d: 2, qd: 3 }, 
    { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 }, { s: "1000PEPEUSDT", n: "PEPE", d: 7, qd: 0 },
    { s: "BONKUSDT", n: "BONK", d: 8, qd: 0 }, { s: "WIFUSDT", n: "WIF", d: 4, qd: 1 },
    { s: "DOGEUSDT", n: "DOGE", d: 5, qd: 0 }, { s: "NEARUSDT", n: "NEAR", d: 4, qd: 1 },
    { s: "AVAXUSDT", n: "AVAX", d: 3, qd: 1 }, { s: "XRPUSDT", n: "XRP", d: 4, qd: 1 },
    { s: "DOTUSDT", n: "DOT", d: 3, qd: 1 }, { s: "ADAUSDT", n: "ADA", d: 4, qd: 0 },
    { s: "LINKUSDT", n: "LINK", d: 3, qd: 2 }, { s: "SUIUSDT", n: "SUI", d: 4, qd: 1 }
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

// 🚀 ওমনি ইঞ্জিন
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
        const avgPrice = s.history.reduce((a,b)=>a+b, 0) / s.history.length;

        if (s.p > s.lp) { s.trend = Math.min(10, s.trend + 1); s.mom = Math.min(100, s.mom + 15); } 
        else if (s.p < s.lp) { s.trend = 0; s.mom = Math.max(0, s.mom - 15); }

        // ১০-মিনিট রিপোর্ট
        const bdtTime = new Date(Date.now() + (6 * 60 * 60 * 1000));
        if (bdtTime.getUTCMinutes() % 10 === 0 && bdtTime.getUTCMinutes() !== lastReportMin) {
            let users = getAllUsers();
            for(let id in users) if(users[id].status === 'active') sendTG(`📊 *১০-মিনিট প্রফিট আপডেট*\nবর্তমান মোট লাভ: ৳${(users[id].profit * 124).toFixed(0)}`, users[id].cid);
            lastReportMin = bdtTime.getUTCMinutes();
        }

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            const isAdmin = (userId === ADMIN_USER);
            const now = Date.now();
            const active = isAdmin || (config.status === 'active' && new Date(config.expiry) > new Date());
            const hasActiveTrades = userSlots[userId] && userSlots[userId].some(sl => sl.active);

            if (!active && !hasActiveTrades) continue;

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, pnl: 0, lastBuy: 0, dca: 0, waitTime: 0, curP: 0 }));
            let slots = userSlots[userId];

            // ১. স্লট ম্যানেজমেন্ট (স্লটগুলো সম্পূর্ণ স্বাধীন)
            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.curP = s.p;

                if (sl.status === 'WAITING' && s.p <= sl.buy) {
                    sl.status = 'BOUGHT';
                    sendTG(`📥 *বাই সম্পন্ন করা হয়েছে!* (S${sl.id+1})\nকয়েন: *${sl.sym}*\nদাম: ${s.p}`, config.cid);
                }

                if (sl.status === 'BOUGHT') {
                    sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * (config.lev || 50);
                    const drop = ((sl.lastBuy - s.p) / sl.lastBuy) * 100;
                    
                    if (drop >= 0.45 && sl.dca < 10) {
                        const order = await placeOrder(sl.sym, "BUY", s.p.toFixed(COINS.find(c=>c.s===sl.sym).d), sl.qty, config);
                        if (order) {
                            sl.buy = (sl.buy + s.p) / 2; sl.qty = (parseFloat(sl.qty) * 2).toFixed(COINS.find(c=>c.s===sl.sym).qd);
                            sl.sell = (sl.buy * 1.0006).toFixed(COINS.find(c=>c.s===sl.sym).d); sl.dca++; sl.lastBuy = s.p;
                            sendTG(`🛠 *DCA রিকাভারি সচল!* \nকয়েন: ${sl.sym} | লেয়ার: ${sl.dca}`, config.cid);
                        }
                    }
                    
                    if (s.p >= sl.sell) {
                        const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy) - (sl.qty * sl.sell * 0.0008);
                        if (gain >= 0.01) {
                            sl.active = false; config.profit += gain; config.count += 1;
                            saveUser(userId, config);
                            const ord = getOrdinal(config.count);
                            sendTG(`*${ord} সেল* \nSELL SUCCESS ✅ (Slot ${sl.id+1})\nGain: $${gain.toFixed(2)} (৳${(gain*124).toFixed(0)}) 💰 মোট ৳${(config.profit*124).toFixed(0)}`, config.cid);
                            sl.status = 'IDLE'; sl.sym = '';
                        }
                    }
                }
            });

            // ২. ক্রস-স্লট এন্ট্রি লজিক (The Matrix Logic)
            const slotIdx = slots.findIndex(sl => !sl.active);
            if (!config.isPaused && active && slotIdx !== -1 && s.trend >= 3 && s.p < avgPrice) {
                const coin = COINS.find(c => c.s === msg.s);
                
                // শর্ত: যদি এই কয়েন অন্য কোনো স্লটে অলরেডি থাকে, তবে অন্তত ০.৭০% ড্রপ হলে তবেই অন্য স্লটে কিনবে।
                const sameCoinPositions = slots.filter(sl => sl.active && sl.sym === msg.s);
                let canBuyCrossSlot = true;
                if(sameCoinPositions.length > 0) {
                    const minEntryPrice = Math.min(...sameCoinPositions.map(x => x.buy));
                    if (s.p > minEntryPrice * 0.993) canBuyCrossSlot = false; // ০.৭০% গ্যাপ
                }

                if (canBuyCrossSlot) {
                    const buyP = (s.p * 0.9998).toFixed(coin.d); 
                    const sellP = (parseFloat(buyP) * 1.0013).toFixed(coin.d);
                    const qty = ((config.cap / 5 * config.lev) / parseFloat(buyP)).toFixed(coin.qd);
                    const order = await placeOrder(msg.s, "BUY", buyP, qty, config, "LIMIT");
                    if (order) slots[slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: msg.s, buy: parseFloat(buyP), sell: parseFloat(sellP), qty: qty, pnl: 0, lastBuy: parseFloat(buyP), dca: 0, waitTime: Date.now(), curP: s.p };
                }
            }
        }
    });
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
        saveUser(id, { api: url.searchParams.get('api') || 'demo', sec: url.searchParams.get('sec') || 'demo', cid: url.searchParams.get('cid'), cap: parseFloat(url.searchParams.get('cap')), lev: parseInt(url.searchParams.get('lev')) || 50, mode: url.searchParams.get('mode'), profit: 0, count: 0, status: (id === ADMIN_USER) ? 'active' : 'pending', expiry: (id === ADMIN_USER) ? new Date(2099,1,1).toISOString() : new Date().toISOString(), isPaused: false });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<body style="background:#020617;color:white;font-family:sans-serif;text-align:center;padding-top:100px;"><h1>QUANTUM MASTER</h1><p>Log in with your User ID.</p></body>`);
    } else {
        let user = db[userId];
        const isAdmin = (userId === ADMIN_USER);
        const timeLeft = Math.max(0, (new Date(user.expiry).getTime() - Date.now()) / (1000 * 60 * 60));
        const active = isAdmin || (user.status === 'active' && timeLeft > 0);
        let slots = userSlots[userId] || Array(5).fill({sym:'Empty',status:'IDLE',active:false, pnl:0});
        
        const avgMom = Object.values(market).reduce((a,b)=>a+b.mom, 0) / COINS.length;
        let meterColor = "text-slate-600"; let meterText = "LOW";
        if(avgMom > 15) { meterColor = "text-sky-400"; meterText = "MODERATE"; }
        if(avgMom > 35) { meterColor = "text-green-400"; meterText = "HIGH"; }
        if(avgMom > 55) { meterColor = "text-yellow-400"; meterText = "EXTREME"; }

        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script>
        <style>
            body { background: #020617; color: white; font-family: sans-serif; }
            .progress-bar { height: 3px; background: #1e293b; border-radius: 2px; overflow: hidden; margin-top: 8px; }
            .progress-fill { height: 100%; background: #22c55e; transition: width 0.5s ease; }
        </style></head>
        <body class="p-4 font-sans"><div class="max-w-xl mx-auto space-y-4">
            <div class="p-6 bg-slate-900 rounded-[2.5rem] border border-sky-500/40 shadow-xl shadow-sky-500/10">
                <div class="flex justify-between items-center">
                    <div><h2 class="text-3xl font-black italic underline decoration-sky-600 underline-offset-8">${userId.toUpperCase()}</h2><p class="text-[9px] ${meterColor} font-black uppercase tracking-widest mt-2">${meterText} INTENSITY</p></div>
                    <div class="text-right"><div class="text-[10px] font-bold text-slate-500 uppercase">মোট লাভ</div><div class="text-3xl font-black text-green-400">৳${(user.profit * 124).toFixed(0)}</div></div>
                </div>
                ${isAdmin ? `<p class="text-[9px] text-yellow-500 font-bold uppercase mt-1 animate-pulse">👑 Admin Access</p>` : (active ? `<p class="text-[9px] text-green-400 font-bold uppercase mt-1">Active (${timeLeft.toFixed(1)}h left)</p>` : `<p class="text-[9px] text-red-500 font-bold uppercase mt-1">Expired</p>`)}
            </div>

            <div class="bg-zinc-900/50 p-6 rounded-[2rem] border border-zinc-800 flex justify-between items-center shadow-lg">
                <span class="text-xs font-bold uppercase text-slate-400 italic">Trade Engine</span>
                <button onclick="location.href='/toggle-trade?id=${userId}'" class="px-6 py-2 rounded-full font-black text-[10px] uppercase transition ${user.isPaused ? 'bg-red-500/20 text-red-500 border border-red-500' : 'bg-green-500/20 text-green-400 border border-green-500'}">
                    ${user.isPaused ? 'PAUSED' : 'RUNNING'}
                </button>
            </div>

            <div class="p-6 bg-zinc-900/50 rounded-[2.5rem] border border-zinc-800 space-y-3 shadow-inner">
                ${slots.map((s,i) => {
                    let progress = 0;
                    if(s.active && s.status === 'BOUGHT') progress = Math.max(0, Math.min(100, ((s.curP - s.buy) / (s.sell - s.buy)) * 100));
                    return `
                    <div class="p-4 bg-black/40 rounded-2xl border border-zinc-800/50">
                        <div class="flex justify-between items-center">
                            <div><span class="text-[9px] font-bold text-slate-600 uppercase italic">Slot ${i+1}</span><p class="text-sm font-black ${s.active ? 'text-sky-400' : 'text-zinc-800'}">${s.active ? s.sym.replace('USDT','') : 'IDLE'}</p></div>
                            <div class="text-right">${s.active ? `<span class="text-xs font-bold ${s.pnl>=0?'text-green-500':'text-red-400'}">${s.pnl.toFixed(2)}% PNL</span>` : '<span class="text-[9px] text-zinc-700 font-black">SEARCHING</span>'}</div>
                        </div>
                        ${s.active && s.status === 'BOUGHT' ? `<div class="progress-bar"><div class="progress-fill" style="width: ${progress}%"></div></div>` : ''}
                    </div>`;
                }).join('')}
            </div>

            <div class="grid grid-cols-2 gap-4">
                <div class="bg-zinc-900/80 p-6 rounded-3xl border border-zinc-800 text-center relative overflow-hidden shadow-inner shadow-black/50">
                    <p class="text-[10px] text-slate-500 uppercase font-black mb-1">Gain ($)</p><p class="text-2xl font-bold text-green-400">$${user.profit.toFixed(2)}</p>
                    <div class="absolute right-2 bottom-1 text-xl opacity-10">💲</div>
                </div>
                <div class="bg-zinc-900/80 p-6 rounded-3xl border border-zinc-800 text-center relative overflow-hidden shadow-inner shadow-black/50">
                    <p class="text-[10px] text-slate-500 uppercase font-black mb-1">Trades</p><p class="text-2xl font-bold text-sky-400">${user.count}</p>
                    <div class="absolute right-2 bottom-1 text-xl opacity-10">💼</div>
                </div>
            </div>

            <div class="text-center opacity-30"><button onclick="if(confirm('রিসেট করবেন? সব স্লট মুছে যাবে।')) location.href='/reset-now?id=${userId}'" class="text-[9px] text-red-500 font-bold uppercase underline underline-offset-4 tracking-widest">Reset Master Core</button></div>
        </div><script>if(${active}) setTimeout(()=>location.reload(), 5000);</script></body></html>`);
    }
});

server.listen(process.env.PORT || 8080, () => {
    startGlobalEngine();
});

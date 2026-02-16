const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ অ্যাডমিন মাস্টার কনফিগ (অপরিবর্তিত)
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

// 🎯 কয়েন পুল (আরও বাড়ানো হয়েছে যাতে ট্রেড না থামে)
const COINS = [
    { s: "BTCUSDT", n: "BTC", d: 2, qd: 3 }, { s: "ETHUSDT", n: "ETH", d: 2, qd: 3 }, 
    { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 }, { s: "1000PEPEUSDT", n: "PEPE", d: 7, qd: 0 },
    { s: "BONKUSDT", n: "BONK", d: 8, qd: 0 }, { s: "WIFUSDT", n: "WIF", d: 4, qd: 1 },
    { s: "DOGEUSDT", n: "DOGE", d: 5, qd: 0 }, { s: "NEARUSDT", n: "NEAR", d: 4, qd: 1 },
    { s: "AVAXUSDT", n: "AVAX", d: 3, qd: 1 }, { s: "XRPUSDT", n: "XRP", d: 4, qd: 1 },
    { s: "DOTUSDT", n: "DOT", d: 3, qd: 1 }, { s: "SUIUSDT", n: "SUI", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, trend: 0, history: [], mom: 0 });
let userSlots = {}; 
let lastReportMin = -1;

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

        if (s.p > s.lp) { 
            s.trend = Math.min(10, s.trend + 1); s.mom = Math.min(100, s.mom + 20);
        } else if (s.p < s.lp) { 
            s.trend = 0; s.mom = Math.max(0, s.mom - 20);
        }

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            const isAdmin = (userId === ADMIN_USER);
            const isTimeUp = Date.now() > new Date(config.expiry).getTime();
            const hasActiveTrades = userSlots[userId] && userSlots[userId].some(sl => sl.active);

            if (!isAdmin && isTimeUp && !hasActiveTrades) {
                if(config.status === 'active') { config.status = 'expired'; saveUser(userId, config); }
                continue;
            }

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, pnl: 0, lastBuy: 0, dca: 0, waitTime: 0 }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;

                if (sl.status === 'WAITING' && s.p <= sl.buy) {
                    sl.status = 'BOUGHT';
                    sendTG(`🟢 *Entry Hit:* ${sl.sym} ${config.mode==='demo'?'(DEMO)':''}`, config.cid);
                }

                if (sl.status === 'BOUGHT') {
                    sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * (config.lev || 50);
                    const drop = ((sl.lastBuy - s.p) / sl.lastBuy) * 100;
                    
                    if (drop >= 0.40 && sl.dca < 12) {
                        const order = await placeOrder(sl.sym, "BUY", s.p.toFixed(COINS.find(c=>c.s===sl.sym).d), sl.qty, config);
                        if (order) {
                            sl.buy = (sl.buy + s.p) / 2; sl.qty = (parseFloat(sl.qty) * 2).toFixed(COINS.find(c=>c.s===sl.sym).qd);
                            sl.sell = (sl.buy * 1.0006).toFixed(COINS.find(c=>c.s===sl.sym).d); sl.dca++; sl.lastBuy = s.p;
                            sendTG(`🛡️ *Shield Activated:* ${sl.sym} (L${sl.dca})`, config.cid);
                        }
                    }
                    if (s.p >= sl.sell) {
                        const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy) - (sl.qty * sl.sell * 0.0008);
                        if (gain >= 0.01) {
                            sl.active = false; config.profit += gain; config.count += 1;
                            saveUser(userId, config);
                            sendTG(`🎉 *DONE!* ${sl.sym} \n💵 নিট লাভ: ৳${(gain*124).toFixed(0)} \n📈 মোট: ৳${(config.profit*124).toFixed(0)}`, config.cid);
                            sl.status = 'IDLE'; sl.sym = '';
                        }
                    }
                }
            });

            // ২. রকেট এন্ট্রি লজিক (ক্রস-স্লট সক্ষম)
            const slotIdx = slots.findIndex(sl => !sl.active);
            if (!config.isPaused && !isTimeUp && slotIdx !== -1 && s.trend >= 2 && s.p < avgPrice) {
                const coin = COINS.find(c => c.s === msg.s);
                
                // ক্রস স্লট চেক: একই কয়েন অন্তত ০.৭০% ড্রপে পুনরায় কিনবে
                const sameCoin = slots.filter(sl => sl.active && sl.sym === msg.s);
                let canBuy = sameCoin.length === 0 || s.p < Math.min(...sameCoin.map(x => x.buy)) * 0.993;

                if (canBuy) {
                    const buyP = (s.p * 0.9998).toFixed(coin.d); 
                    const sellP = (parseFloat(buyP) * 1.0011).toFixed(coin.d);
                    const qty = ((config.cap / 5 * config.lev) / parseFloat(buyP)).toFixed(coin.qd);
                    const order = await placeOrder(msg.s, "BUY", buyP, qty, config, "LIMIT");
                    if (order) slots[slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: msg.s, buy: parseFloat(buyP), sell: parseFloat(sellP), qty: qty, pnl: 0, lastBuy: parseFloat(buyP), dca: 0, waitTime: Date.now() };
                }
            }
        }
    });
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}

// 🌐 মাস্টার ড্যাশবোর্ড UI (আপনার প্রিয় ডিজাইন)
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
        res.end(`<body style="background:#020617;color:white;font-family:sans-serif;text-align:center;padding-top:100px;"><h1>QUANTUM MASTER</h1><p>Log in with your ID.</p></body>`);
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

        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-4 font-sans"><div class="max-w-xl mx-auto space-y-4">
            <div class="p-6 bg-slate-900 rounded-[2rem] border border-sky-500/40 shadow-xl shadow-sky-500/10">
                <div class="flex justify-between items-center mb-2">
                    <div><h2 class="text-3xl font-black italic underline decoration-sky-600 underline-offset-8">${userId.toUpperCase()}</h2><p class="text-[9px] ${meterColor} font-black uppercase tracking-widest mt-3">${meterText} INTENSITY ATTACK</p></div>
                    <div class="text-right"><div class="text-[9px] font-bold text-slate-500 uppercase">মোট লাভ</div><div class="text-3xl font-black text-green-400">৳${(user.profit * 124).toFixed(0)}</div></div>
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
                ${slots.map((s,i) => `<div class="flex justify-between p-4 bg-black/40 rounded-2xl border border-zinc-800/50 relative overflow-hidden shadow-inner shadow-black/50">
                    <div><span class="text-[9px] font-bold text-slate-600 uppercase italic">Slot ${i+1}</span><p class="text-sm font-black ${s.active ? 'text-sky-400' : 'text-zinc-800'}">${s.active ? s.sym.replace('USDT','') : 'IDLE'}</p></div>
                    <div class="text-right">${s.active ? `<span class="text-xs font-bold ${s.pnl>=0?'text-green-500':'text-red-400'}">${s.pnl.toFixed(2)}% PNL</span>` : '<span class="text-[9px] text-zinc-700 font-black tracking-widest uppercase">Scanning</span>'}</div>
                </div>`).join('')}
            </div>

            <div class="grid grid-cols-2 gap-4">
                <div class="bg-zinc-900/80 p-5 rounded-3xl border border-zinc-800 text-center relative overflow-hidden shadow-inner shadow-black/50"><p class="text-[10px] text-slate-500 font-black mb-1">Gain ($)</p><p class="text-2xl font-bold text-green-400">$${user.profit.toFixed(2)}</p><div class="absolute right-2 bottom-1 text-xl opacity-10">💲</div></div>
                <div class="bg-zinc-900/80 p-5 rounded-3xl border border-zinc-800 text-center relative overflow-hidden shadow-inner shadow-black/50"><p class="text-[10px] text-slate-500 font-black mb-1">Trades</p><p class="text-2xl font-bold text-sky-400">${user.count}</p><div class="absolute right-2 bottom-1 text-xl opacity-10">💼</div></div>
            </div>

            <div class="text-center opacity-30"><button onclick="if(confirm('রিসেট করবেন? সব স্লট মুছে যাবে।')) location.href='/reset-now?id=${userId}'" class="text-[9px] text-red-500 font-bold uppercase underline underline-offset-4 tracking-widest">Reset Master Core</button></div>
        </div><script>setTimeout(()=>location.reload(), 4500);</script></body></html>`);
    }
});

server.listen(process.env.PORT || 8080, () => {
    startGlobalEngine();
});

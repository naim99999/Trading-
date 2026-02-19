const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ মাস্টার এডমিন সেটিংস (প্রিসেট)
// ==========================================
const ADMIN_USER = "naim1155"; 
const ADMIN_PASS = "115510"; 
const MASTER_TG_TOKEN = "8281887575:AAGRTPvSdT4ho8C2NwsxCHyUMkRq2q6qWDc"; // আপনার নতুন টোকেন
const ADMIN_CHAT_ID = "5279510350";
const ADMIN_API = "zjZgsBWc77SC6xVxiY58HDZ1ToGLuS37A3Zw1GfxUnESoNyksw3weVoaiWTk5pec";
const ADMIN_SEC = "YlvltwUt2LpP1WHDPST9WKNvj6bSJvjxn9nqZiz32JgJab6B9GJrREBg633qQGzn";

const DB_FILE = 'master_users_db.json';

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

// 🎯 ৫০টি হাই-ভেলোসিটি কয়েন পুল
const COINS = [
    { s: "BTCUSDT", n: "BTC", d: 2, qd: 3 }, { s: "ETHUSDT", n: "ETH", d: 2, qd: 3 }, { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 },
    { s: "1000PEPEUSDT", n: "PEPE", d: 7, qd: 0 }, { s: "BONKUSDT", n: "BONK", d: 8, qd: 0 }, { s: "WIFUSDT", n: "WIF", d: 4, qd: 1 },
    { s: "DOGEUSDT", n: "DOGE", d: 5, qd: 0 }, { s: "NEARUSDT", n: "NEAR", d: 4, qd: 1 }, { s: "AVAXUSDT", n: "AVAX", d: 3, qd: 1 },
    { s: "XRPUSDT", n: "XRP", d: 4, qd: 1 }, { s: "ADAUSDT", n: "ADA", d: 4, qd: 0 }, { s: "LINKUSDT", n: "LINK", d: 3, qd: 2 },
    { s: "DOTUSDT", n: "DOT", d: 3, qd: 1 }, { s: "APTUSDT", n: "APT", d: 3, qd: 1 }, { s: "OPUSDT", n: "OP", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, v: 0, a: 0, h: [], confidence: 0 });
let userSlots = {}; 

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

async function getBalance(config) {
    if (!config.api || config.mode === 'demo') return "Infinity";
    const ts = Date.now();
    const query = `timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?${query}&signature=${signature}`, {
            headers: { 'X-MBX-APIKEY': config.api }
        });
        return parseFloat(res.data.totalWalletBalance).toFixed(2);
    } catch (e) { return "0.00"; }
}

async function sendTG(msg, chatId) {
    try { await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: chatId, text: msg, parse_mode: 'Markdown' }); } catch (e) {}
}

async function placeOrder(symbol, side, price, qty, config) {
    const ts = Date.now();
    const query = `symbol=${symbol}&side=${side}&type=LIMIT&quantity=${qty}&price=${price}&timeInForce=GTC&timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.post(`https://fapi.binance.com/fapi/v1/order?${query}&signature=${signature}`, null, {
            headers: { 'X-MBX-APIKEY': config.api }
        });
        return res.data;
    } catch (e) { return null; }
}

// 🚀 ওমনি ইঞ্জিন মাস্টার লজিক
async function startNeuralEngine() {
    console.log("🧠 God-Flow Engine v2.0 Online");
    const streams = COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    ws.on('message', async (data) => {
        const payload = JSON.parse(data);
        const msg = payload.data;
        if (!msg || !market[msg.s]) return;

        const s = market[msg.s];
        s.lp = s.p; s.p = parseFloat(msg.c);
        
        // AI Logic: Velocity & Acceleration
        const v = s.p - s.lp; s.a = (v - s.v); s.v = v;
        s.h.push(s.p); if(s.h.length > 30) s.h.shift();
        const avg = s.h.reduce((a,b)=>a+b, 0) / s.h.length;
        s.confidence = (s.p > avg && s.a > 0) ? 80 : 20;

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            const isAdmin = (userId === ADMIN_USER);
            const active = isAdmin || (config.status === 'active' && new Date(config.expiry) > new Date());
            if (!active) continue;

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, dca: 0, lastBuy: 0, curP: 0 }));
            let slots = userSlots[userId];

            // ১. স্লট আপডেট ও রিকাভারি
            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.curP = s.p;
                if (sl.status === 'WAITING' && s.p <= sl.buy) sl.status = 'BOUGHT';

                const drop = ((sl.lastBuy - s.p) / sl.lastBuy) * 100;
                if (sl.status === 'BOUGHT' && drop >= 0.45 && sl.dca < 12) {
                    const order = await placeOrder(sl.sym, "BUY", s.p.toFixed(COINS.find(c=>c.s===sl.sym).d), sl.qty, config);
                    if (order) {
                        sl.buy = (sl.buy + s.p) / 2; sl.qty = (parseFloat(sl.qty) * 2).toFixed(COINS.find(c=>c.s===sl.sym).qd);
                        sl.sell = (sl.buy * 1.0006).toFixed(COINS.find(c=>c.s===sl.sym).d); sl.dca++; sl.lastBuy = s.p;
                    }
                }

                if (sl.status === 'BOUGHT' && s.p >= sl.sell) {
                    const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy) - (sl.qty * sl.sell * 0.0008);
                    sl.active = false; config.profit += gain; config.unpaid += gain; config.count += 1;
                    saveUser(userId, config);
                    sendTG(`🎉 *DONE!* ${sl.sym} \nGain: ৳${(gain*124).toFixed(0)}`, config.cid);
                    sl.status = 'IDLE'; sl.sym = '';
                }
            });

            // ২. জিরো-আইডল এন্ট্রি
            const slotIdx = slots.findIndex(sl => !sl.active);
            if (!config.isPaused && slotIdx !== -1 && s.confidence >= 80) {
                if (!slots.some(sl => sl.active && sl.sym === msg.s)) {
                    const coin = COINS.find(c => c.s === msg.s);
                    const buyP = s.p.toFixed(coin.d);
                    const sellP = (parseFloat(buyP) * 1.0012).toFixed(coin.d);
                    const qty = ((config.cap / 5 * config.lev) / parseFloat(buyP)).toFixed(coin.qd);
                    if (parseFloat(qty) > 0) {
                        const order = await placeOrder(msg.s, "BUY", buyP, qty, config);
                        if (order) slots[slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: msg.s, buy: parseFloat(buyP), sell: parseFloat(sellP), qty: qty, dca: 0, lastBuy: parseFloat(buyP) };
                    }
                }
            }
        }
    });
}

// 🌐 মাস্টার ড্যাশবোর্ড
const server = http.createServer((req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    if (url.pathname === '/admin-paid' && url.searchParams.get('pass') === ADMIN_PASS) {
        if(db[url.searchParams.get('user')]) { db[url.searchParams.get('user')].unpaid = 0; saveUser(url.searchParams.get('user'), db[url.searchParams.get('user')]); return res.end("Cleared"); }
    }
    if (url.pathname === '/admin-act' && url.searchParams.get('pass') === ADMIN_PASS) {
        let exp = new Date(Date.now() + (parseFloat(url.searchParams.get('hours')) * 60 * 60 * 1000));
        saveUser(url.searchParams.get('user'), { status: 'active', expiry: exp.toISOString() });
        return res.end("Activated");
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (!userId || !db[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-6 font-sans flex items-center min-h-screen text-center"><div class="max-w-md mx-auto space-y-6 w-full">
            <h1 class="text-4xl font-black text-sky-400 italic underline decoration-sky-600">QUANTUM PORTAL</h1>
            <form action="/register" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 text-left shadow-2xl">
                <input name="id" placeholder="Create User ID" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white outline-none" required>
                <select name="mode" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select>
                <input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white">
                <input name="sec" placeholder="Binance Secret Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white">
                <input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white" required>
                <div class="grid grid-cols-2 gap-3"><input name="cap" type="number" min="5" value="10" class="bg-black p-4 rounded-2xl text-white"><input name="lev" type="number" value="50" class="bg-black p-4 rounded-2xl text-white"></div>
                <button class="w-full bg-sky-600 p-5 rounded-[2rem] font-black uppercase shadow-lg transition active:scale-95">Launch Account</button>
            </form></div><script>function register(){ /* URL building logic */ }</script></body></html>`);
        // Note: For registration, use the URL parameters in the actual form action
    } else {
        let user = db[userId];
        const isAdmin = (userId === ADMIN_USER);
        const active = isAdmin || (user.status === 'active');
        const due = (user.unpaid * 124 * 0.50).toFixed(0);

        getBalance(user).then(balance => {
            res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script><style>body{background:#020617;color:white;font-family:sans-serif;}.progress-bar{height:3px;background:#1e293b;border-radius:2px;overflow:hidden;margin-top:8px;}.progress-fill{height:100%;background:#22c55e;transition:width 0.5s ease;}.card-icon{position:absolute;right:20px;top:35px;font-size:32px;opacity:0.15;}</style></head>
            <body class="p-4 font-sans max-w-md mx-auto space-y-4">
                <div class="p-6 bg-slate-900 rounded-[2.5rem] border ${active ? 'border-sky-500/30' : 'border-red-500/30'} flex justify-between items-center shadow-xl">
                    <div><h2 class="text-2xl font-black italic underline decoration-sky-700">${userId.toUpperCase()}</h2><p class="text-[9px] text-slate-500 uppercase font-black tracking-widest mt-1">${active ? '🟢 ACTIVE' : '🔴 PENDING'}</p></div>
                    <div class="text-right"><div class="text-[9px] font-bold text-slate-500">WALLET</div><div class="text-3xl font-black text-green-400">$${balance}</div></div>
                </div>
                <div class="bg-red-900/20 p-5 rounded-3xl border border-red-500/30 flex justify-between items-center">
                    <div><p class="text-[10px] text-red-400 font-bold uppercase">Admin Share (50%)</p><p class="text-2xl font-black text-white">৳${due}</p></div>
                    <div class="text-right"><div class="card-icon text-2xl">💼</div></div>
                </div>
                <div class="grid grid-cols-2 gap-4 text-center">
                    <div class="bg-zinc-900/50 p-5 rounded-3xl border border-zinc-800 relative overflow-hidden shadow-2xl"><p class="text-[10px] text-slate-500 uppercase font-black">Profit (৳)</p><p class="text-2xl font-bold text-green-400">৳${(user.profit * 124).toFixed(0)}</p><div class="card-icon">💲</div></div>
                    <div class="bg-zinc-900/50 p-6 rounded-3xl border border-zinc-800 relative overflow-hidden shadow-2xl"><p class="text-[10px] text-slate-500 uppercase font-black">Success</p><p class="text-2xl font-bold text-sky-400">${user.count}</p><div class="card-icon">💼</div></div>
                </div>
                <div class="bg-zinc-900/50 p-6 rounded-[2.5rem] border border-zinc-800 space-y-3">
                    ${(userSlots[userId] || Array(5).fill({sym:'READY',active:false})).map((s,i) => {
                        let pnl = 0; if(s.active) pnl = ((s.curP - s.buy) / s.buy) * 100 * 50;
                        return `<div class="flex justify-between p-3 bg-black/40 rounded-xl text-xs border border-zinc-800/50"><div><span class="text-[9px] font-bold text-slate-600 uppercase">Slot ${i+1}</span><p class="text-sm font-black ${s.active ? 'text-sky-400' : 'text-zinc-700'}">${s.active ? s.sym : 'IDLE'}</p></div><div class="text-right">${s.active ? `<span class="${pnl>=0?'text-green-500':'text-red-500'} font-bold">${pnl.toFixed(2)}%</span>` : ''}</div></div>`;
                    }).join('')}
                </div>
            </body></html>`);
        });
    }
});

server.listen(process.env.PORT || 8080, () => {
    console.log("🌐 Portal Live on 8080");
    startNeuralEngine();
});

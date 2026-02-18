const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ অ্যাডমিন কনফিগারেশন (Preset)
// ==========================================
const ADMIN_USER = "naim1155"; 
const ADMIN_PASS = "115510"; 
const ADMIN_TG_TOKEN = "8380847229:AAG57WcfWbTkYG53yqVXdFiIOp3gZrjF_Fs"; 
const ADMIN_CHAT_ID = "5279510350";
const ADMIN_API = "zjZgsBWc77SC6xVxiY58HDZ1ToGLuS37A3Zw1GfxUnESoNyksw3weVoaiWTk5pec";
const ADMIN_SEC = "YlvltwUt2LpP1WHDPST9WKNvj6bSJvjxn9nqZiz32JgJab6B9GJrREBg633qQGzn";

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
    { s: "AVAXUSDT", n: "AVAX", d: 3, qd: 1 }, { s: "LINKUSDT", n: "LINK", d: 3, qd: 2 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, trend: 0, history: [], mom: 0 });
let userSlots = {}; 
let lastReportMin = -1;

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

// 🔍 এপিআই চেক করার ফাংশন
async function testBinanceAPI(config) {
    const ts = Date.now();
    const query = `timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?${query}&signature=${signature}`, {
            headers: { 'X-MBX-APIKEY': config.api }
        });
        return { ok: true, balance: res.data.totalWalletBalance };
    } catch (e) {
        return { ok: false, msg: e.response?.data?.msg || "Invalid Keys" };
    }
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
        const payload = JSON.parse(data).data;
        if (!payload || !market[payload.s]) return;

        const s = market[payload.s];
        s.lp = s.p; s.p = parseFloat(payload.c);
        s.history.push(s.p); if(s.history.length > 50) s.history.shift();
        const avgP = s.history.reduce((a,b)=>a+b, 0) / s.history.length;

        if (s.p > s.lp) { s.trend = Math.min(10, s.trend + 1); s.mom = Math.min(100, s.mom + 15); } 
        else if (s.p < s.lp) { s.trend = 0; s.mom = Math.max(0, s.mom - 15); }

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            const isAdmin = (userId === ADMIN_USER);
            const activeStatus = isAdmin || (config.status === 'active');
            if (!activeStatus) continue;

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, pnl: 0, lastBuy: 0, dca: 0, curP: 0 }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== payload.s) return;
                sl.curP = s.p;
                if (sl.status === 'WAITING' && s.p <= sl.buy) sl.status = 'BOUGHT';
                if (sl.status === 'BOUGHT') {
                    sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * (config.lev || 50);
                    if (s.p >= sl.sell) {
                        const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy) - (sl.qty * sl.sell * 0.0008);
                        if (gain >= 0.01) {
                            sl.active = false; config.profit += gain; config.count += 1;
                            saveUser(userId, config);
                            sl.status = 'IDLE'; sl.sym = '';
                        }
                    }
                }
            });

            const slotIdx = slots.findIndex(sl => !sl.active);
            if (!config.isPaused && slotIdx !== -1 && s.trend >= 2 && s.p < avgP) {
                const coin = COINS.find(c => c.s === payload.s);
                if (!slots.some(sl => sl.active && sl.sym === payload.s)) {
                    const buyP = (s.p * 0.9998).toFixed(coin.d); 
                    const sellP = (parseFloat(buyP) * 1.0012).toFixed(coin.d);
                    const qty = ((config.cap / 5 * config.lev) / parseFloat(buyP)).toFixed(coin.qd);
                    const order = await placeOrder(payload.s, "BUY", buyP, qty, config, "LIMIT");
                    if (order) slots[slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: payload.s, buy: parseFloat(buyP), sell: parseFloat(sellP), qty: qty, pnl: 0, lastBuy: parseFloat(buyP), dca: 0, waitTime: Date.now(), curP: s.p };
                }
            }
        }
    });
}

// 🌐 ড্যাশবোর্ড
const server = http.createServer((req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    // এপিআই টেস্ট করার রাউট
    if (url.pathname === '/api-test') {
        const id = url.searchParams.get('id');
        if(db[id]) {
            testBinanceAPI(db[id]).then(result => {
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                if(result.ok) res.end(`✅ API Success! Balance: $${result.balance}`);
                else res.end(`❌ API Error: ${result.msg}`);
            });
        } else res.end("User Not Found");
        return;
    }

    if (url.pathname === '/toggle-trade') {
        if(db[userId]) { db[userId].isPaused = !db[userId].isPaused; saveUser(userId, db[userId]); }
        res.writeHead(302, { 'Location': '/' + userId }); return res.end();
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
        <body class="bg-[#020617] text-white p-6 font-sans flex items-center min-h-screen"><div class="max-w-md mx-auto space-y-6 w-full text-center">
            <h1 class="text-5xl font-black text-sky-400 italic">QUANTUM</h1><form action="/register" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 text-left shadow-2xl border border-sky-500/10">
                <input name="id" placeholder="User ID" class="w-full bg-black p-4 rounded-2xl border border-slate-800 outline-none text-white" required>
                <input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white">
                <input name="sec" placeholder="Binance Secret Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white">
                <input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white" required>
                <div class="grid grid-cols-2 gap-3"><input name="cap" type="number" min="5" value="10" class="bg-black p-4 rounded-2xl text-white"><input name="lev" type="number" value="50" class="bg-black p-4 rounded-2xl text-white"></div>
                <button class="w-full bg-sky-600 p-5 rounded-[2rem] font-black uppercase shadow-lg active:scale-95 transition">Launch Engine</button>
            </form></div></body></html>`);
    } else {
        let user = db[userId];
        const active = (userId === ADMIN_USER) || (user.status === 'active');
        let slots = userSlots[userId] || Array(5).fill({sym:'Empty',status:'IDLE',active:false, pnl:0});

        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script>
        <style>body{background:#020617;color:white;font-family:sans-serif;}.progress-bar{height:3px;background:#1e293b;border-radius:2px;overflow:hidden;margin-top:8px;}.progress-fill{height:100%;background:#22c55e;transition:width 0.5s ease;}.card-icon{position:absolute;right:20px;top:35px;font-size:32px;opacity:0.15;}</style></head>
        <body class="p-4 font-sans"><div class="max-w-xl mx-auto space-y-4">
            <div class="p-6 bg-slate-900 rounded-[2rem] border border-sky-500/40 shadow-xl">
                <div class="flex justify-between items-center">
                    <div><h2 class="text-3xl font-black italic underline decoration-sky-600 underline-offset-8 uppercase">${userId}</h2>
                    <button onclick="fetch('/api-test?id=${userId}').then(r=>r.text()).then(t=>alert(t))" class="mt-4 px-4 py-1 bg-sky-500/10 text-sky-400 border border-sky-500/30 rounded-full text-[10px] font-bold uppercase tracking-widest">Test API Connection</button>
                    </div>
                    <div class="text-right"><div class="text-[9px] font-bold text-slate-500 uppercase">Wallet Profit</div><div class="text-3xl font-black text-green-400">৳${(user.profit * 124).toFixed(0)}</div></div>
                </div>
            </div>
            
            <!-- PROFITS -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div class="p-6 bg-slate-900 rounded-[2rem] border border-slate-800 relative overflow-hidden shadow-2xl"><p class="text-[10px] text-slate-500 uppercase font-black">TOTAL PROFIT (USD)</p><p class="text-4xl font-bold text-green-400 mt-2">$${user.profit.toFixed(2)}</p><div class="card-icon">💲</div></div>
                <div class="p-6 bg-slate-900 rounded-[2rem] border border-slate-800 relative overflow-hidden shadow-2xl"><p class="text-[10px] text-slate-500 uppercase font-black">SUCCESS TRADES</p><p class="text-4xl font-bold text-sky-400 mt-2">${user.count}</p><div class="card-icon">💼</div></div>
            </div>

            <!-- SLOTS -->
            <div class="p-6 bg-zinc-900/50 rounded-[2.5rem] border border-zinc-800 space-y-3">
                <div class="flex justify-between items-center mb-2"><span class="text-xs font-bold uppercase text-slate-400 italic">Trade Status</span><button onclick="location.href='/toggle-trade?id=${userId}'" class="px-6 py-2 rounded-full font-black text-[10px] uppercase transition ${user.isPaused ? 'bg-red-500/20 text-red-500 border border-red-500' : 'bg-green-500/20 text-green-400 border border-green-500'}">${user.isPaused ? 'PAUSED' : 'RUNNING'}</button></div>
                ${slots.map((s,i) => {
                    let progress = 0; if(s.active && s.status === 'BOUGHT') progress = Math.max(0, Math.min(100, ((s.curP - s.buy) / (s.sell - s.buy)) * 100));
                    return `<div class="p-4 bg-black/40 rounded-2xl border border-zinc-800/50 flex justify-between items-center transition-all ${s.active ? 'border-sky-500/20' : ''}"><div><span class="text-[9px] font-bold text-slate-600 italic uppercase">Slot ${i+1}</span><p class="text-sm font-black ${s.active ? 'text-sky-400' : 'text-zinc-800'}">${s.active ? s.sym.replace('USDT','') : 'IDLE'}</p></div><div class="text-right">${s.active ? `<span class="text-xs font-bold ${s.pnl>=0?'text-green-500':'text-red-400'}">${s.pnl.toFixed(2)}% PNL</span>` : ''}</div></div>${s.active && s.status === 'BOUGHT' ? `<div class="progress-bar"><div class="progress-fill" style="width: ${progress}%"></div></div>` : ''}`;
                }).join('')}
            </div>
        </div><script>setTimeout(()=>location.reload(), 5000);</script></body></html>`);
    }
});

server.listen(process.env.PORT || 8080, () => {
    startGlobalEngine();
});

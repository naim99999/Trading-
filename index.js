const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

const ADMIN_USER = "naim1155"; 
const ADMIN_PASS = "115510"; 
const DB_FILE = 'database_master.json';
const SETTINGS_FILE = 'global_settings.json';

// 💾 ডাটাবেজ
function getAllUsers() {
    if (!fs.existsSync(DB_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) { return {}; }
}
function saveUser(userId, data) {
    let users = getAllUsers();
    users[userId] = { ...users[userId], ...data };
    fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
}

// 🎯 ট্রেডিং কনফিগারেশন (৫০টি কয়েন)
const COINS = [
    { s: "BTCUSDT", d: 2, qd: 3 }, { s: "ETHUSDT", d: 2, qd: 3 }, { s: "SOLUSDT", d: 3, qd: 2 },
    { s: "1000PEPEUSDT", d: 7, qd: 0 }, { s: "BONKUSDT", d: 8, qd: 0 }, { s: "WIFUSDT", d: 4, qd: 1 },
    { s: "DOGEUSDT", d: 5, qd: 0 }, { s: "NEARUSDT", d: 4, qd: 1 }, { s: "AVAXUSDT", d: 3, qd: 2 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, trend: 0 });
let userSlots = {}; 

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

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

// 🚀 হাই-স্পিড এঞ্জিন কোর
async function startGlobalEngine() {
    const streams = COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    ws.on('message', async (data) => {
        const payload = JSON.parse(data);
        const msg = payload.data;
        if (!msg || !market[msg.s]) return;

        const s = market[msg.s];
        s.lp = s.p; s.p = parseFloat(msg.c);
        if (s.p > s.lp) s.trend = Math.min(10, s.trend + 1); else s.trend = 0;

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            const isAdmin = (userId === ADMIN_USER);
            const now = Date.now();
            const expiryTime = new Date(config.expiry).getTime();
            
            if (!isAdmin && (config.status !== 'active' || now > expiryTime)) {
                if(config.status === 'active') { config.status = 'expired'; saveUser(userId, config); }
                continue;
            }

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, dca: 0, lastBuy: 0 }));
            let slots = userSlots[userId];

            // ১. অটো প্রফিট ও ১০-লেয়ার DCA
            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                if (sl.status === 'WAITING' && s.p <= sl.buy) sl.status = 'BOUGHT';

                const drop = ((sl.lastBuy - s.p) / sl.lastBuy) * 100;
                if (sl.status === 'BOUGHT' && drop >= 0.38 && sl.dca < 10) {
                    const coin = COINS.find(c => c.s === sl.sym);
                    const order = await placeOrder(sl.sym, "BUY", s.p.toFixed(coin.d), sl.qty, config);
                    if (order) {
                        sl.buy = (sl.buy + s.p) / 2; sl.qty = (parseFloat(sl.qty) * 2).toFixed(coin.qd);
                        sl.sell = (sl.buy * 1.0007).toFixed(coin.d); sl.dca++; sl.lastBuy = s.p;
                    }
                }

                if (sl.status === 'BOUGHT' && s.p >= sl.sell) {
                    const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy) - (sl.qty * sl.sell * 0.0008);
                    sl.active = false; config.profit += gain; config.count += 1;
                    saveUser(userId, config);
                    sl.status = 'IDLE'; sl.sym = '';
                }
            });

            // ২. জিরো-সেকেন্ড এন্ট্রি (Trend >= 2)
            const slotIdx = slots.findIndex(sl => !sl.active);
            if (slotIdx !== -1 && s.trend >= 2) { 
                if (!slots.some(sl => sl.active && sl.sym === msg.s)) {
                    const coin = COINS.find(c => c.s === msg.s);
                    const buyP = s.p.toFixed(coin.d);
                    const sellP = (parseFloat(buyP) * 1.0011).toFixed(coin.d);
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

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);
    let users = getAllUsers();

    if (url.pathname === '/admin-act' && url.searchParams.get('pass') === ADMIN_PASS) {
        let hours = parseFloat(url.searchParams.get('hours'));
        let target = url.searchParams.get('user');
        let newExp = new Date(Date.now() + (hours * 60 * 60 * 1000));
        saveUser(target, { status: 'active', expiry: newExp.toISOString() });
        return res.end("User Activated");
    }
    
    if (url.pathname === '/reset-now') {
        const id = url.searchParams.get('id');
        if(users[id]) { users[id].profit = 0; users[id].count = 0; saveUser(id, users[id]); }
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        const isAdmin = (id === ADMIN_USER);
        saveUser(id, {
            api: url.searchParams.get('api'), sec: url.searchParams.get('sec'),
            tok: url.searchParams.get('tok'), cid: url.searchParams.get('cid'),
            cap: Math.max(5, parseFloat(url.searchParams.get('cap'))), lev: parseInt(url.searchParams.get('lev')),
            profit: 0, count: 0, status: isAdmin ? 'active' : 'pending',
            expiry: isAdmin ? new Date(2099, 1, 1).toISOString() : new Date().toISOString()
        });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (!userId || !users[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-6 font-sans flex items-center min-h-screen text-center"><div class="max-w-md mx-auto space-y-6 w-full">
            <h1 class="text-4xl font-black text-sky-400 italic underline decoration-sky-600 underline-offset-8">QUANTUM PORTAL</h1>
            <form action="/register" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-3 text-left shadow-2xl">
                <input name="id" placeholder="Create Username" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white outline-none" required>
                <input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white outline-none" required>
                <input name="sec" placeholder="Binance Secret Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white outline-none" required>
                <div class="grid grid-cols-2 gap-2"><input name="cap" type="number" min="5" placeholder="Capital $" class="bg-black p-4 rounded-2xl text-white outline-none"><select name="lev" class="bg-black p-4 rounded-2xl text-slate-500"><option value="50">Leverage: 50x</option><option value="100">Leverage: 100x</option></select></div>
                <div class="grid grid-cols-2 gap-2"><input name="tok" placeholder="TG Token" class="bg-black p-4 rounded-2xl text-white outline-none"><input name="cid" placeholder="TG ID" class="bg-black p-4 rounded-2xl text-white outline-none"></div>
                <button class="w-full bg-sky-600 p-5 rounded-2xl font-black uppercase text-sm mt-2 active:scale-95 transition">Launch Portal</button>
            </form>
        </div></body></html>`);
    } else {
        let user = users[userId];
        const isAdmin = (userId === ADMIN_USER);
        const timeLeft = Math.max(0, (new Date(user.expiry).getTime() - Date.now()) / (1000 * 60 * 60));
        const active = isAdmin || (user.status === 'active' && timeLeft > 0);
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-4 font-sans"><div class="max-w-md mx-auto space-y-4">
            <div class="text-center p-6 bg-slate-900 rounded-[2.5rem] border ${active ? 'border-green-500/30' : 'border-red-500/30'} shadow-2xl">
                <h2 class="text-2xl font-black text-sky-400 italic uppercase">${userId}</h2>
                ${isAdmin ? `<p class="text-[10px] text-yellow-400 font-bold uppercase mt-2 tracking-widest animate-pulse">👑 Admin Access</p>` : (active ? `<p class="text-[10px] text-green-400 font-bold uppercase mt-1">Status: Active</p><p class="text-xs text-slate-400 mt-2 font-mono">Time Left: ${timeLeft.toFixed(2)} Hours</p>` : `<p class="text-xs text-red-500 font-bold mt-1 uppercase tracking-widest">Expired</p>`)}
            </div>
            <div class="grid grid-cols-2 gap-4">
                <div class="bg-zinc-900/80 p-6 rounded-3xl border border-zinc-800 text-center"><p class="text-[10px] text-slate-500 uppercase font-bold mb-1">Gain (USD)</p><p class="text-2xl font-bold text-green-400">$${user.profit.toFixed(2)}</p></div>
                <div class="bg-zinc-900/80 p-6 rounded-3xl border border-zinc-800 text-center"><p class="text-[10px] text-slate-500 uppercase font-bold mb-1">Trades</p><p class="text-2xl font-bold text-sky-400">${user.count}</p></div>
            </div>
            <div class="bg-zinc-900/80 p-6 rounded-[2.5rem] border border-zinc-800 space-y-2">
                ${(userSlots[userId] || Array(5).fill({sym:'READY',active:false})).map((s,i) => `<div class="flex justify-between p-3 bg-black/40 rounded-xl text-xs border border-zinc-800/50"><span>Slot ${i+1}</span><span class="${s.active ? 'text-green-400 animate-pulse' : 'text-zinc-700'} font-black">${s.active ? s.sym : 'WAITING...'}</span></div>`).join('')}
            </div>
            <button onclick="if(confirm('Reset all profit counts?')) location.href='/reset-now?id=${userId}'" class="w-full bg-red-600/20 text-red-500 py-3 rounded-2xl font-black uppercase text-xs active:scale-95 transition">Reset All Stats</button>
        </div><script>if(${active}) setTimeout(()=>location.reload(), 6000);</script></body></html>`);
    }
});

server.listen(process.env.PORT || 8080, () => {
    console.log("🌐 Portal Live");
    startGlobalEngine();
});

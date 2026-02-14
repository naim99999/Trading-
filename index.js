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

const DB_FILE = 'master_db_v12.json';
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
function getSettings() {
    if (!fs.existsSync(SETTINGS_FILE)) {
        const init = { hourlyPrice: 10 };
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(init));
        return init;
    }
    return JSON.parse(fs.readFileSync(SETTINGS_FILE));
}
function saveSettings(data) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2)); }

// 🎯 ২৫টি হাই-ভলিউম কয়েন পুল
const COINS = [
    { s: "BTCUSDT", n: "BTC", d: 2, qd: 3 }, { s: "ETHUSDT", n: "ETH", d: 2, qd: 3 }, { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 },
    { s: "1000PEPEUSDT", n: "PEPE", d: 7, qd: 0 }, { s: "BONKUSDT", n: "BONK", d: 8, qd: 0 }, { s: "WIFUSDT", n: "WIF", d: 4, qd: 1 },
    { s: "1000SHIBUSDT", n: "SHIB", d: 7, qd: 0 }, { s: "1000FLOKIUSDT", n: "FLOKI", d: 5, qd: 0 }, { s: "DOGEUSDT", n: "DOGE", d: 5, qd: 0 },
    { s: "NEARUSDT", n: "NEAR", d: 4, qd: 1 }, { s: "AVAXUSDT", n: "AVAX", d: 3, qd: 2 }, { s: "ADAUSDT", n: "ADA", d: 4, qd: 0 },
    { s: "LINKUSDT", n: "LINK", d: 3, qd: 2 }, { s: "DOTUSDT", n: "DOT", d: 3, qd: 1 }, { s: "SUIUSDT", n: "SUI", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, mom: 0, trend: 0 });
let userSlots = {}; 
let lastReportMin = -1;

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

async function sendTG(msg, chatId) {
    try { await axios.post(`https://api.telegram.org/bot${ADMIN_TG_TOKEN}/sendMessage`, { chat_id: chatId, text: msg, parse_mode: 'Markdown' }); } catch (e) {}
}

async function placeOrder(symbol, side, price, qty, config) {
    if (config.mode === 'demo') return { status: 'FILLED' };
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

// 🚀 ওমনি এঞ্জিন ভেলোসিটি
async function startGlobalEngine() {
    const streams = COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    ws.on('message', async (data) => {
        const payload = JSON.parse(data);
        const msg = payload.data;
        if (!msg || !market[msg.s]) return;

        const s = market[msg.s];
        s.lp = s.p; s.p = parseFloat(msg.c);
        if (s.p > s.lp) { s.trend = Math.min(10, s.trend + 1); s.mom = Math.min(100, s.mom + 20); }
        else if (s.p < s.lp) { s.trend = 0; s.mom = Math.max(0, s.mom - 20); }

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            const isAdmin = (userId === ADMIN_USER);
            const now = Date.now();
            const timeLeft = (new Date(config.expiry).getTime() - now);
            
            if (!isAdmin && (config.status !== 'active' || timeLeft <= 0)) continue;

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, pnl: 0, lastBuy: 0, dca: 0 }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                if (sl.status === 'WAITING' && s.p <= sl.buy) sl.status = 'BOUGHT';
                if (sl.status === 'BOUGHT') sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * (config.lev || 20);

                // ১২-লেয়ার শিল্ড DCA
                const drop = ((sl.lastBuy - s.p) / sl.lastBuy) * 100;
                if (sl.status === 'BOUGHT' && drop >= 0.35 && sl.dca < 12) {
                    const coin = COINS.find(c => c.s === sl.sym);
                    const order = await placeOrder(sl.sym, "BUY", s.p.toFixed(coin.d), sl.qty, config);
                    if (order) {
                        sl.buy = (sl.buy + s.p) / 2; sl.qty = (parseFloat(sl.qty) * 2).toFixed(coin.qd);
                        sl.sell = (sl.buy * 1.0006).toFixed(coin.d); sl.dca++; sl.lastBuy = s.p;
                    }
                }

                if (sl.status === 'BOUGHT' && s.p >= sl.sell) {
                    const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy) - (sl.qty * sl.sell * 0.0008);
                    sl.active = false; config.profit += gain; config.count += 1;
                    saveUser(userId, config);
                    sendTG(`🎉 *DONE!* ${sl.sym} (S${sl.id+1})\nProfit: $${gain.toFixed(2)} (৳${(gain*124).toFixed(0)})`, config.cid);
                    sl.status = 'IDLE'; sl.sym = '';
                }
            });

            // ২-টিক এন্ট্রি (রকেট স্পিড)
            const slotIdx = slots.findIndex(sl => !sl.active);
            if (slotIdx !== -1 && s.trend >= 2 && !slots.some(sl => sl.active && sl.sym === msg.s)) {
                const coin = COINS.find(c => c.s === msg.s);
                const buyP = s.p.toFixed(coin.d);
                const sellP = (parseFloat(buyP) * 1.0008).toFixed(coin.d);
                const qty = ((config.cap / 5 * config.lev) / parseFloat(buyP)).toFixed(coin.qd);
                if (parseFloat(qty) > 0) {
                    const order = await placeOrder(msg.s, "BUY", buyP, qty, config);
                    if (order) slots[slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: msg.s, buy: parseFloat(buyP), sell: parseFloat(sellP), qty: qty, pnl: 0, lastBuy: parseFloat(buyP), dca: 0 };
                }
            }
        }
    });
}

// 🌐 মাস্টার ড্যাশবোর্ড
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);
    let users = getAllUsers();
    let settings = getSettings();

    if (url.pathname === '/admin-act' && url.searchParams.get('pass') === ADMIN_PASS) {
        let hours = parseFloat(url.searchParams.get('hours'));
        let target = url.searchParams.get('user');
        let currentExp = (users[target] && new Date(users[target].expiry) > new Date()) ? new Date(users[target].expiry).getTime() : Date.now();
        saveUser(target, { status: 'active', expiry: new Date(currentExp + (hours * 60 * 60 * 1000)).toISOString() });
        return res.end("User Activated");
    }

    if (url.pathname === '/reset-now') {
        const id = url.searchParams.get('id');
        if(users[id]) { users[id].profit = 0; users[id].count = 0; saveUser(id, users[id]); }
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        saveUser(id, { api: url.searchParams.get('api') || 'demo', sec: url.searchParams.get('sec') || 'demo', cid: url.searchParams.get('cid'), cap: parseFloat(url.searchParams.get('cap')), lev: parseInt(url.searchParams.get('lev')), mode: url.searchParams.get('mode'), profit: 0, count: 0, status: (id === ADMIN_USER) ? 'active' : 'pending', expiry: (id === ADMIN_USER) ? new Date(2099,1,1).toISOString() : new Date().toISOString() });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (!userId || !users[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-6 font-sans flex items-center min-h-screen"><div class="max-w-md mx-auto space-y-6 w-full">
            <div class="text-center"><h1 class="text-5xl font-black text-sky-400 italic">QUANTUM</h1><p class="text-xs text-yellow-500 font-bold uppercase tracking-widest mt-2 border border-yellow-500/20 inline-block px-4 py-1 rounded-full">৳${settings.hourlyPrice} / ঘণ্টা</p></div>
            <form action="/register" class="bg-slate-900 p-8 rounded-[3rem] space-y-4 shadow-2xl border border-sky-500/10">
                <input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-2xl border border-slate-800 focus:border-sky-500 outline-none" required>
                <select name="mode" class="w-full bg-black p-4 rounded-2xl border border-slate-800"><option value="live">Live Trading (API Key)</option><option value="demo">Demo Mode (Free)</option></select>
                <input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800">
                <input name="sec" placeholder="Binance Secret Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800">
                <input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-2xl border border-slate-800" required>
                <div class="grid grid-cols-2 gap-3"><input name="cap" type="number" min="5" value="10" class="bg-black p-4 rounded-2xl border border-slate-800"><select name="lev" class="bg-black p-4 rounded-2xl border border-slate-800"><option value="20">20x</option><option value="50" selected>50x</option><option value="100">100x</option></select></div>
                <button class="w-full bg-sky-600 p-5 rounded-[2rem] font-black uppercase text-sm tracking-widest shadow-lg shadow-sky-900/40">Connect Portal</button>
            </form>
        </div></body></html>`);
    } else {
        let user = users[userId];
        const isAdmin = (userId === ADMIN_USER);
        const timeLeft = Math.max(0, (new Date(user.expiry).getTime() - Date.now()) / (1000 * 60 * 60));
        const active = isAdmin || (user.status === 'active' && timeLeft > 0);
        let slots = userSlots[userId] || Array(5).fill({sym:'READY',status:'IDLE',active:false, pnl:0});
        
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-4 font-sans"><div class="max-w-xl mx-auto space-y-4">
            <div class="p-6 bg-slate-900 rounded-[2.5rem] border ${active ? 'border-sky-500/40' : 'border-red-500/30'} flex justify-between items-center shadow-xl">
                <div><h2 class="text-3xl font-black text-white italic italic">${userId.toUpperCase()}</h2>${isAdmin ? `<p class="text-[9px] text-yellow-500 font-bold uppercase mt-1">👑 Administrator Access</p>` : (active ? `<p class="text-[9px] text-green-400 font-bold uppercase mt-1">Status: Active</p><p class="text-[10px] text-slate-500 mt-1">Expires in: ${timeLeft.toFixed(2)}h</p>` : `<p class="text-[9px] text-red-500 font-bold uppercase mt-1">Expired</p>`)}</div>
                <div class="text-right">
                    <div class="text-xs font-bold text-slate-500">WALLET (BDT)</div>
                    <div class="text-3xl font-black text-green-400">৳${(user.profit * 124).toFixed(0)}</div>
                </div>
            </div>

            <div class="bg-zinc-900/50 p-6 rounded-[2.5rem] border border-zinc-800">
                <p class="text-[10px] text-slate-500 font-bold uppercase mb-4 tracking-widest">● LIVE ATTACK SLOTS</p>
                <div class="space-y-2">
                    ${slots.map((s,i) => `<div class="flex justify-between p-4 bg-black/40 rounded-2xl border border-zinc-800/50"><div><span class="text-[10px] font-bold text-slate-600 italic">Slot ${i+1}</span><p class="text-sm font-black ${s.active ? 'text-sky-400' : 'text-zinc-800'}">${s.active ? s.sym : 'WAITING'}</p></div><div class="text-right">${s.active ? `<span class="text-xs font-bold ${s.pnl>=0?'text-green-500':'text-red-500'}">${s.pnl.toFixed(2)}%</span>` : `<span class="text-[9px] text-zinc-800 font-black">SEARCHING</span>`}</div></div>`).join('')}
                </div>
            </div>

            <div class="p-6 bg-zinc-900/50 rounded-[2.5rem] border border-zinc-800 space-y-4">
               <div class="grid grid-cols-2 gap-3 text-center">
                  <div class="bg-black/20 p-4 rounded-3xl"><p class="text-[9px] text-slate-600 font-bold">SUCCESS</p><p class="text-xl font-bold text-green-400">${user.count}</p></div>
                  <div class="bg-black/20 p-4 rounded-3xl"><p class="text-[9px] text-slate-600 font-bold">PROFIT (USD)</p><p class="text-xl font-bold text-sky-400">$${user.profit.toFixed(2)}</p></div>
               </div>
               <button onclick="if(confirm('Reset all stats?')) location.href='/reset-now?id=${userId}'" class="w-full text-red-500/50 text-[10px] font-bold uppercase tracking-widest hover:text-red-500 transition">Reset Trading Data</button>
            </div>
            
            <div class="text-center opacity-40"><button onclick="location.href='/'" class="text-[10px] text-slate-500 font-bold uppercase underline">Switch Terminal</button></div>
        </div><script>if(${active}) setTimeout(()=>location.reload(), 6000);</script></body></html>`);
    }
});

server.listen(process.env.PORT || 8080, () => {
    startGlobalEngine();
});

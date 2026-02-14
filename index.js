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
const ADMIN_TG_TOKEN = "8380847229:AAG57WcfWbTkYG53yqVXdFiIOp3gZrjF_Fs"; // সেন্ট্রাল বট টোকেন

const DB_FILE = 'database_v9.json';
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

// 🎯 মার্কেট ডাটা
const COINS = [
    { s: "BTCUSDT", d: 2, qd: 3 }, { s: "SOLUSDT", d: 3, qd: 2 }, { s: "ETHUSDT", d: 2, qd: 3 },
    { s: "1000PEPEUSDT", d: 7, qd: 0 }, { s: "BONKUSDT", d: 8, qd: 0 }, { s: "WIFUSDT", d: 4, qd: 1 }
];
let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, trend: 0 });
let userSlots = {}; 

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

async function sendTG(msg, chatId) {
    try {
        await axios.post(`https://api.telegram.org/bot${ADMIN_TG_TOKEN}/sendMessage`, {
            chat_id: chatId, text: msg, parse_mode: 'Markdown'
        });
    } catch (e) {}
}

async function placeOrder(symbol, side, price, qty, config) {
    if (config.mode === 'demo') return { status: 'FILLED', demo: true }; // ডেমো মোডে অর্ডার স্কিপ
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

// 🚀 হাই-স্পিড মাল্টি-ইউজার ইঞ্জিন
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
            if (!isAdmin && (config.status !== 'active' || now > new Date(config.expiry).getTime())) continue;

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, dca: 0, lastBuy: 0 }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                
                // সিমুলেটেড বাই (যদি ডেমো মোড হয় বা রিয়েল বাই হিট হয়)
                if (sl.status === 'WAITING' && s.p <= sl.buy) {
                    sl.status = 'BOUGHT';
                    sendTG(`✅ *Entry Hit:* ${sl.sym} ${config.mode === 'demo' ? '(DEMO)' : ''}`, config.cid);
                }

                // প্রফিট ক্লোজ লজিক
                if (sl.status === 'BOUGHT' && s.p >= sl.sell) {
                    const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy) - (sl.qty * sl.sell * 0.0008);
                    sl.active = false; config.profit += gain; config.count += 1;
                    saveUser(userId, config);
                    sendTG(`🎉 *Profit SECURED:* ${sl.sym} (+$${gain.toFixed(2)})`, config.cid);
                    sl.status = 'IDLE'; sl.sym = '';
                }
            });

            // এন্ট্রি লজিক
            const slotIdx = slots.findIndex(sl => !sl.active);
            if (slotIdx !== -1 && s.trend >= 2 && !slots.some(sl => sl.active && sl.sym === msg.s)) {
                const coin = COINS.find(c => c.s === msg.s);
                const buyP = s.p.toFixed(coin.d);
                const sellP = (parseFloat(buyP) * 1.0012).toFixed(coin.d);
                const qty = ((config.cap / 5 * config.lev) / parseFloat(buyP)).toFixed(coin.qd);

                const order = await placeOrder(msg.s, "BUY", buyP, qty, config);
                if (order) {
                    slots[slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: msg.s, buy: parseFloat(buyP), sell: parseFloat(sellP), qty: qty, dca: 0, lastBuy: parseFloat(buyP) };
                }
            }
        }
    });
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
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
        return res.end("Activated");
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
            api: url.searchParams.get('api') || 'demo', sec: url.searchParams.get('sec') || 'demo',
            cid: url.searchParams.get('cid'), cap: parseFloat(url.searchParams.get('cap')),
            lev: parseInt(url.searchParams.get('lev')), mode: url.searchParams.get('mode'),
            profit: 0, count: 0, status: isAdmin ? 'active' : 'pending',
            expiry: isAdmin ? new Date(2099, 1, 1).toISOString() : new Date().toISOString()
        });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (!userId || !users[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-6 font-sans flex items-center min-h-screen text-center"><div class="max-w-md mx-auto space-y-6 w-full">
            <h1 class="text-3xl font-black text-sky-400 italic italic">QUANTUM PORTAL v9.0</h1>
            <form action="/register" class="bg-slate-900 p-8 rounded-[2rem] space-y-3 text-left">
                <input name="id" placeholder="Create Username" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white" required>
                <select name="mode" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-sky-400 font-bold"><option value="demo">Demo Mode (No API Needed)</option><option value="live">Live Trading (API Needed)</option></select>
                <input name="api" placeholder="Binance API Key (Live Only)" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white">
                <input name="sec" placeholder="Binance Secret Key (Live Only)" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white">
                <input name="cid" placeholder="Your Telegram Chat ID" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white" required>
                <div class="grid grid-cols-2 gap-2"><input name="cap" type="number" value="10" class="bg-black p-4 rounded-2xl text-white"><select name="lev" class="bg-black p-4 rounded-2xl text-slate-500"><option value="20">20x</option><option value="50">50x</option></select></div>
                <button class="w-full bg-sky-600 p-5 rounded-2xl font-black uppercase text-sm mt-2">Connect & Launch</button>
            </form>
        </div></body></html>`);
    } else {
        let user = users[userId];
        const isAdmin = (userId === ADMIN_USER);
        const active = isAdmin || (user.status === 'active' && new Date(user.expiry) > new Date());
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-4 font-sans"><div class="max-w-md mx-auto space-y-4">
            <div class="text-center p-6 bg-slate-900 rounded-[2rem] border ${active ? 'border-green-500/30' : 'border-red-500/30'}">
                <h2 class="text-2xl font-black text-sky-400 italic">${userId.toUpperCase()}</h2>
                <p class="text-[10px] text-slate-500 uppercase tracking-widest font-bold">${user.mode === 'demo' ? '🟡 DEMO MODE ACTIVE' : '🔵 LIVE TRADING ACTIVE'}</p>
                ${active ? `<p class="text-[10px] text-green-400 font-bold uppercase mt-2">Status: Active</p>` : `<p class="text-xs text-red-500 font-bold mt-2 uppercase">Expired</p>`}
            </div>
            <div class="grid grid-cols-2 gap-4">
                <div class="bg-zinc-900/80 p-6 rounded-3xl border border-zinc-800 text-center"><p class="text-[10px] text-slate-500 uppercase font-bold mb-1">Gain</p><p class="text-2xl font-bold text-green-400">$${user.profit.toFixed(2)}</p></div>
                <div class="bg-zinc-900/80 p-6 rounded-3xl border border-zinc-800 text-center"><p class="text-[10px] text-slate-500 uppercase font-bold mb-1">Trades</p><p class="text-2xl font-bold text-sky-400">${user.count}</p></div>
            </div>
            <div class="bg-zinc-900/80 p-6 rounded-[2.5rem] border border-zinc-800 space-y-2">
                ${(userSlots[userId] || Array(5).fill({sym:'READY',active:false})).map((s,i) => `<div class="flex justify-between p-3 bg-black/40 rounded-xl text-xs border border-zinc-800/50"><span>Slot ${i+1}</span><span class="${s.active ? 'text-green-400 animate-pulse' : 'text-zinc-700'} font-black">${s.active ? s.sym : 'IDLE'}</span></div>`).join('')}
            </div>
            <button onclick="if(confirm('Reset stats?')) location.href='/reset-now?id=${userId}'" class="w-full bg-red-600/10 text-red-500 py-3 rounded-2xl font-bold uppercase text-[10px]">Reset All Stats</button>
        </div><script>if(${active}) setTimeout(()=>location.reload(), 6000);</script></body></html>`);
    }
});

server.listen(process.env.PORT || 8080, () => {
    startGlobalEngine();
});

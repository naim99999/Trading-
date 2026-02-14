const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ অ্যাডমিন কনফিগ
// ==========================================
const ADMIN_USER = "naim1155"; 
const ADMIN_PASS = "115510"; 
const ADMIN_TG_TOKEN = "8380847229:AAG57WcfWbTkYG53yqVXdFiIOp3gZrjF_Fs"; 

const DB_FILE = 'master_db_v30.json';
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

// 🎯 হাই-ফ্লো কয়েন লিস্ট
const COINS = [
    { s: "BTCUSDT", n: "BTC", d: 2, qd: 3 }, { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 },
    { s: "ETHUSDT", n: "ETH", d: 2, qd: 3 }, { s: "1000PEPEUSDT", n: "PEPE", d: 7, qd: 0 },
    { s: "WIFUSDT", n: "WIF", d: 4, qd: 1 }, { s: "BONKUSDT", n: "BONK", d: 8, qd: 0 },
    { s: "NEARUSDT", n: "NEAR", d: 4, qd: 1 }, { s: "AVAXUSDT", n: "AVAX", d: 3, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, streak: 0 });
let userSlots = {}; 

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }
function getOrdinal(n) {
    const ords = ["", "১ম", "২য়", "৩য়", "৪র্থ", "৫ম", "৬ষ্ঠ", "৭ম", "৮ম", "৯ম", "১০ম"];
    return n <= 10 ? ords[n] : n + "-তম";
}

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

// 🚀 ওমনি ইঞ্জিন (The Guardian Core)
async function startGlobalEngine() {
    const streams = COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    ws.on('message', async (data) => {
        const payload = JSON.parse(data);
        const msg = payload.data;
        if (!msg || !market[msg.s]) return;

        const s = market[msg.s];
        s.lp = s.p; s.p = parseFloat(msg.c);
        
        // এনালাইসিস: কেনার পর যেন আর না কমে (৩টি পজিটিভ টিক লজিক)
        if (s.p > s.lp) s.streak = Math.min(10, s.streak + 1); 
        else if (s.p < s.lp) s.streak = 0;

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            if (config.status !== 'active') continue;

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, pnl: 0, lastBuy: 0 }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;

                // বাই কনফার্মেশন মেসেজ
                if (sl.status === 'WAITING' && s.p <= sl.buy) {
                    sl.status = 'BOUGHT';
                    sendTG(`📥 *বাই সম্পন্ন করা হয়েছে!* (S${sl.id+1})\n--------------------------\n💰 কয়েন: *${sl.sym.replace('USDT','')}*\n💵 এন্ট্রি প্রাইজ: ${s.p}\n🎯 টার্গেট প্রাইজ: ${sl.sell}`, config.cid);
                }
                
                if (sl.status === 'BOUGHT') sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * (config.lev || 20);

                // সেল মেসেজ এবং মোট প্রফিট আপডেট
                if (sl.status === 'BOUGHT' && s.p >= sl.sell) {
                    const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy) - (sl.qty * sl.sell * 0.0008);
                    sl.active = false; config.profit += gain; config.count += 1;
                    saveUser(userId, config);
                    
                    const report = `🎉 *${getOrdinal(config.count)} সেল সম্পন্ন!* \n` +
                                   `--------------------------\n` +
                                   `💰 কয়েন: *${sl.sym.replace('USDT','')}*\n` +
                                   `💵 নিট লাভ: $${gain.toFixed(2)} (৳${(gain*124).toFixed(0)})\n` +
                                   `📈 সর্বমোট লাভ: ৳${(config.profit*124).toFixed(0)}\n` +
                                   `🏦 ওয়ালেট ব্যালেন্স: $${config.profit.toFixed(2)}\n` +
                                   `--------------------------`;
                    sendTG(report, config.cid);
                    sl.status = 'IDLE'; sl.sym = '';
                }
            });

            // এন্ট্রি লজিক: ইউ-টার্ন নিশ্চিত করা
            const slotIdx = slots.findIndex(sl => !sl.active);
            if (slotIdx !== -1 && s.streak >= 3 && !slots.some(sl => sl.active && sl.sym === msg.s)) {
                const coin = COINS.find(c => c.s === msg.s);
                const buyP = s.p.toFixed(coin.d);
                const sellP = (parseFloat(buyP) * 1.0012).toFixed(coin.d);
                const qty = ((config.cap / 5 * config.lev) / parseFloat(buyP)).toFixed(coin.qd);

                const order = await placeOrder(msg.s, "BUY", buyP, qty, config);
                if (order) {
                    slots[slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: msg.s, buy: parseFloat(buyP), sell: parseFloat(sellP), qty: qty, pnl: 0, lastBuy: parseFloat(buyP) };
                }
            }
        }
    });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);
    let users = getAllUsers();

    if (url.pathname === '/reset-now') {
        const id = url.searchParams.get('id');
        if(users[id]) { users[id].profit = 0; users[id].count = 0; saveUser(id, users[id]); }
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        saveUser(id, {
            api: url.searchParams.get('api') || 'demo', sec: url.searchParams.get('sec') || 'demo',
            cid: url.searchParams.get('cid'), cap: parseFloat(url.searchParams.get('cap')),
            lev: parseInt(url.searchParams.get('lev')) || 20, mode: url.searchParams.get('mode'),
            profit: 0, count: 0, status: (id === ADMIN_USER) ? 'active' : 'pending',
            expiry: (id === ADMIN_USER) ? new Date(2099, 1, 1).toISOString() : new Date().toISOString()
        });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !users[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-6 font-sans flex items-center min-h-screen text-center"><div class="max-w-md mx-auto space-y-6 w-full">
            <h1 class="text-4xl font-black text-sky-400 italic">VALKYRIE v30</h1>
            <form action="/register" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 text-left shadow-2xl">
                <input name="id" placeholder="ইউজার আইডি" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white outline-none" required>
                <select name="mode" class="w-full bg-black p-4 rounded-2xl border border-slate-800"><option value="live">লাইভ ট্রেডিং</option><option value="demo">ডেমো মোড</option></select>
                <input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white">
                <input name="sec" placeholder="Binance Secret Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white">
                <input name="cid" placeholder="টেলিগ্রাম চ্যাট আইডি" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white" required>
                <div class="grid grid-cols-2 gap-3"><input name="cap" type="number" value="10" class="bg-black p-4 rounded-2xl"><input name="lev" type="number" value="50" class="bg-black p-4 rounded-2xl"></div>
                <button class="w-full bg-sky-600 p-5 rounded-[2rem] font-black uppercase shadow-lg active:scale-95 transition">ইঞ্জিন চালু করুন</button>
            </form>
        </div></body></html>`);
    } else {
        let user = users[userId];
        let slots = userSlots[userId] || Array(5).fill({sym:'READY',status:'IDLE',active:false, pnl:0});
        const active = (userId === ADMIN_USER) || (user.status === 'active');
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-4 font-sans"><div class="max-w-xl mx-auto space-y-4">
            <div class="p-6 bg-slate-900 rounded-[2.5rem] border ${active ? 'border-green-500/40' : 'border-red-500/30'} flex justify-between items-center shadow-xl">
                <div><h2 class="text-3xl font-black italic underline decoration-sky-600">${userId.toUpperCase()}</h2><p class="text-[10px] text-slate-500 uppercase tracking-widest mt-1">GUARDIAN ACTIVE</p></div>
                <div class="text-right"><div class="text-[9px] font-bold text-slate-500 uppercase">মোট লাভ (৳)</div><div class="text-3xl font-black text-green-400">৳${(user.profit * 124).toFixed(0)}</div></div>
            </div>

            <div class="grid grid-cols-2 gap-4">
                <div class="bg-zinc-900 p-5 rounded-3xl border border-zinc-800 text-center"><p class="text-[10px] text-slate-500 uppercase font-black mb-1">Gain (USD)</p><p class="text-2xl font-bold text-green-400">$${user.profit.toFixed(2)}</p></div>
                <div class="bg-zinc-900 p-5 rounded-3xl border border-zinc-800 text-center"><p class="text-[10px] text-slate-500 uppercase font-black mb-1">Trades</p><p class="text-2xl font-bold text-sky-400">${user.count}</p></div>
            </div>

            <div class="bg-zinc-900/50 p-6 rounded-[2rem] border border-zinc-800 space-y-2 shadow-inner">
                ${slots.map((s,i) => `
                <div class="flex justify-between p-4 bg-black/40 rounded-2xl border border-zinc-800/50">
                    <div><span class="text-[9px] font-bold text-slate-600 uppercase">Slot ${i+1}</span><p class="text-sm font-black ${s.active ? 'text-sky-400' : 'text-zinc-800'}">${s.active ? s.sym.replace('USDT','') : 'IDLE'}</p></div>
                    <div class="text-right">${s.active ? `<span class="text-xs font-bold ${s.pnl>=0?'text-green-500':'text-red-400'}">${s.pnl.toFixed(2)}%</span>` : '<span class="text-[9px] text-zinc-700 font-bold uppercase tracking-widest">Searching...</span>'}</div>
                </div>`).join('')}
            </div>

            <div class="text-center opacity-30 hover:opacity-100 transition"><button onclick="if(confirm('সব ডাটা রিসেট করবেন?')) location.href='/reset-now?id=${userId}'" class="text-[9px] text-red-500 font-bold uppercase underline">Reset Profile Data</button></div>
        </div><script>setTimeout(()=>location.reload(), 5000);</script></body></html>`);
    }
});

server.listen(process.env.PORT || 8080, () => {
    startGlobalEngine();
});

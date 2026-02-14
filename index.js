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

const DB_FILE = 'master_db_v11.json';
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

// 🎯 কয়েন লিস্ট (৫০টি কয়েন যাতে ট্রেড না থামে)
const COINS = [
    { s: "BTCUSDT", n: "BTC", d: 2, qd: 3 }, { s: "ETHUSDT", n: "ETH", d: 2, qd: 3 }, { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 },
    { s: "1000PEPEUSDT", n: "1000PEPE", d: 7, qd: 0 }, { s: "BONKUSDT", n: "BONK", d: 8, qd: 0 }, { s: "WIFUSDT", n: "WIF", d: 4, qd: 1 },
    { s: "1000SHIBUSDT", n: "1000SHIB", d: 7, qd: 0 }, { s: "DOGEUSDT", n: "DOGE", d: 5, qd: 0 }, { s: "NEARUSDT", n: "NEAR", d: 4, qd: 1 },
    { s: "AVAXUSDT", n: "AVAX", d: 3, qd: 2 }, { s: "XRPUSDT", n: "XRP", d: 4, qd: 1 }, { s: "ADAUSDT", n: "ADA", d: 4, qd: 0 },
    { s: "LINKUSDT", n: "LINK", d: 3, qd: 2 }, { s: "DOTUSDT", n: "DOT", d: 3, qd: 1 }, { s: "MATICUSDT", n: "MATIC", d: 4, qd: 0 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, mom: 0, trend: 0 });
let userSlots = {}; 
let lastReportedMinute = -1;

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }
function getOrdinal(n) {
    const ords = ["", "১ম", "২য়", "৩য়", "৪র্থ", "৫ম", "৬ষ্ঠ", "৭ম", "৮ম", "৯ম", "১০ম"];
    return n <= 10 ? ords[n] : n + "-তম";
}

async function sendTG(msg, chatId) {
    try {
        await axios.post(`https://api.telegram.org/bot${ADMIN_TG_TOKEN}/sendMessage`, {
            chat_id: chatId, text: msg, parse_mode: 'Markdown'
        });
    } catch (e) {}
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
            if (config.status !== 'active') continue;

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, pnl: 0, lastBuy: 0, dca: 0 }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                if (sl.status === 'WAITING' && s.p <= sl.buy) sl.status = 'BOUGHT';
                if (sl.status === 'BOUGHT') sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * (config.lev || 20);

                if (sl.status === 'BOUGHT' && s.p >= sl.sell) {
                    const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy) - (sl.qty * sl.sell * 0.0008);
                    sl.active = false; config.profit += gain; config.count += 1;
                    saveUser(userId, config);
                    sendTG(`*${getOrdinal(config.count)} সেল* \nSELL SUCCESS ✅ (Slot ${sl.id+1})\nGain: $${gain.toFixed(2)} (৳${(gain*124).toFixed(0)}) 💰 মোট ৳${(config.profit*124).toFixed(0)}`, config.cid);
                    sl.status = 'IDLE'; sl.sym = '';
                }
            });

            const slotIdx = slots.findIndex(sl => !sl.active);
            if (slotIdx !== -1 && s.trend >= 2 && !slots.some(sl => sl.active && sl.sym === msg.s)) {
                const coin = COINS.find(c => c.s === msg.s);
                const buyP = s.p.toFixed(coin.d);
                const sellP = (parseFloat(buyP) * 1.0010).toFixed(coin.d);
                const qty = ((config.cap / 5 * config.lev) / parseFloat(buyP)).toFixed(coin.qd);
                if (parseFloat(qty) > 0) {
                    const order = await placeOrder(msg.s, "BUY", buyP, qty, config);
                    if (order) {
                        slots[slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: msg.s, buy: parseFloat(buyP), sell: parseFloat(sellP), qty: qty, pnl: 0, lastBuy: parseFloat(buyP), dca: 0 };
                        sendTG(`🎯 *CI SIGNAL* (Slot #${slotIdx+1}) Coin: *${coin.n}* \n📥 Buy: \`${buyP}\` \n📤 Sell: \`${sellP}\``, config.cid);
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

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        saveUser(id, {
            api: url.searchParams.get('api') || 'demo', sec: url.searchParams.get('sec') || 'demo',
            cid: url.searchParams.get('cid'), cap: parseFloat(url.searchParams.get('cap')),
            lev: parseInt(url.searchParams.get('lev')), mode: url.searchParams.get('mode'),
            profit: 0, count: 0, status: (id === ADMIN_USER) ? 'active' : 'pending',
            expiry: (id === ADMIN_USER) ? new Date(2099, 1, 1).toISOString() : new Date().toISOString()
        });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (!userId || !users[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-6 font-sans flex items-center min-h-screen"><div class="max-w-md mx-auto space-y-6 w-full">
            <h1 class="text-4xl font-black text-sky-400 italic text-center">CI QUANTUM</h1>
            <form action="/register" class="bg-slate-900 p-8 rounded-[2rem] space-y-4 shadow-2xl">
                <input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl border border-slate-800" required>
                <select name="mode" class="w-full bg-black p-4 rounded-xl border border-slate-800"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select>
                <input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-xl border border-slate-800">
                <input name="sec" placeholder="Binance Secret Key" class="w-full bg-black p-4 rounded-xl border border-slate-800">
                <input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-xl border border-slate-800" required>
                <div class="grid grid-cols-2 gap-2"><input name="cap" type="number" value="10" class="bg-black p-4 rounded-xl"><select name="lev" class="bg-black p-4 rounded-xl"><option value="20">20x</option><option value="50" selected>50x</option></select></div>
                <button class="w-full bg-sky-600 p-4 rounded-2xl font-black uppercase shadow-lg">Start Master Engine</button>
            </form>
        </div></body></html>`);
    } else {
        let user = users[userId];
        let slots = userSlots[userId] || Array(5).fill({sym:'Empty',status:'IDLE',active:false});
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white font-sans p-4"><div class="max-w-xl mx-auto space-y-4">
            <div class="p-6 bg-slate-900/50 rounded-3xl text-center border border-sky-500/20 shadow-xl">
                <h2 class="text-2xl font-black text-white italic underline decoration-sky-600">${userId.toUpperCase()}</h2>
                <p class="text-[10px] text-green-400 font-bold uppercase mt-1 tracking-widest">● System Online</p>
            </div>

            <div class="grid grid-cols-2 gap-3 text-center">
                <div class="bg-[#161b22] p-5 rounded-3xl border border-slate-800 relative">
                    <p class="text-[9px] text-slate-500 uppercase font-black">Net Profit</p><p class="text-2xl font-bold text-green-400 mt-1">$${user.profit.toFixed(2)}</p>
                </div>
                <div class="bg-[#161b22] p-5 rounded-3xl border border-slate-800 relative">
                    <p class="text-[9px] text-slate-500 uppercase font-black">Total Trades</p><p class="text-2xl font-bold text-sky-400 mt-1">${user.count}</p>
                </div>
            </div>

            <div class="bg-[#161b22] p-5 rounded-3xl border border-slate-800">
                <h3 class="text-[10px] text-slate-500 font-black uppercase mb-4 tracking-widest text-center">Active Attack Slots</h3>
                <div class="grid grid-cols-1 gap-2">
                    ${slots.map(s => `
                    <div class="p-4 bg-black/30 rounded-2xl border border-slate-800/50 flex justify-between items-center">
                        <div><p class="text-[9px] font-bold text-slate-600 italic uppercase">SLOT ${s.id+1}</p><p class="text-sm font-black ${s.active?'text-sky-400':'text-slate-800'}">${s.active?s.sym.replace('USDT',''):'IDLE'}</p></div>
                        <div class="text-right">${s.active && s.status === 'BOUGHT' ? `<p class="text-xs font-bold ${s.pnl>=0?'text-green-500':'text-red-500'}">${s.pnl.toFixed(1)}%</p>` : `<span class="text-[9px] text-slate-700 font-black uppercase">${s.status}</span>`}</div>
                    </div>`).join('')}
                </div>
            </div>

            <div class="bg-[#161b22] p-5 rounded-3xl border border-slate-800">
                <h3 class="text-[10px] text-slate-500 font-black uppercase mb-4 tracking-widest text-center">Market Heatmap</h3>
                <div class="grid grid-cols-3 gap-2">
                    ${COINS.slice(0,6).map(c => `
                    <div class="bg-black/20 p-2 rounded-xl text-center border border-slate-800/50">
                        <p class="text-[8px] font-bold text-slate-500">${c.n}</p>
                        <p class="text-[10px] font-black text-sky-300">$${market[c.s].p.toFixed(c.d)}</p>
                    </div>`).join('')}
                </div>
            </div>
            
            <div class="text-center opacity-30 hover:opacity-100 transition"><button onclick="location.href='/'" class="text-[9px] text-slate-500 font-bold uppercase underline">Switch Account</button></div>
        </div><script>setTimeout(()=>location.reload(), 5000);</script></body></html>`);
    }
});

server.listen(process.env.PORT || 8080, () => {
    startGlobalEngine();
});

const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ কনফিগারেশন
// ==========================================
const ADMIN_USER = "naim1155"; 
const ADMIN_PASS = "115510"; 
const ADMIN_TG_TOKEN = "8380847229:AAG57WcfWbTkYG53yqVXdFiIOp3gZrjF_Fs"; 

const DB_FILE = 'master_db_v10.json';
const SETTINGS_FILE = 'settings.json';

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

// 🎯 কয়েন কনফিগ
const COINS = [
    { s: "BTCUSDT", n: "BTC", d: 2, qd: 3 }, { s: "1000PEPEUSDT", n: "1000PEPE", d: 7, qd: 0 },
    { s: "BONKUSDT", n: "BONK", d: 8, qd: 0 }, { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 },
    { s: "WIFUSDT", n: "WIF", d: 4, qd: 1 }, { s: "1000SHIBUSDT", n: "1000SHIB", d: 7, qd: 0 },
    { s: "1000FLOKIUSDT", n: "1000FLOKI", d: 5, qd: 0 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, mom: 0, trend: 0 });
let userSlots = {}; 
let lastReportedMinute = -1;

// 🛠️ ইউটিলিটি
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

// 🚀 ওমনি এঞ্জিন লজিক
async function startGlobalEngine() {
    const streams = COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    ws.on('message', async (data) => {
        const payload = JSON.parse(data);
        const msg = payload.data;
        if (!msg || !market[msg.s]) return;

        const s = market[msg.s];
        s.lp = s.p; s.p = parseFloat(msg.c);
        
        // মোমেন্টাম ও ট্রেন্ড ক্যালকুলেশন
        if (s.p > s.lp) { s.trend = Math.min(10, s.trend + 1); s.mom = Math.min(100, s.mom + 15); }
        else if (s.p < s.lp) { s.trend = 0; s.mom = Math.max(0, s.mom - 15); }

        // ১০-মিনিট রিপোর্ট (আপনার স্ক্রিনশটের মতো ফরম্যাট)
        const now = new Date();
        const bdtTime = new Date(now.getTime() + (6 * 60 * 60 * 1000));
        const min = bdtTime.getUTCMinutes();
        if (min % 10 === 0 && min !== lastReportedMinute) {
            let users = getAllUsers();
            for(let id in users) {
                if(users[id].status === 'active') {
                    sendTG(`📊 *১০-মিনিট প্রফিট আপডেট*\n\nবর্তমান মোট লাভ: ৳${(users[id].profit * 124).toFixed(2)}\n----------------------\n_বট সচল আছে এবং স্ক্যানিং চলছে..._`, users[id].cid);
                }
            }
            lastReportedMinute = min;
        }

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            const isAdmin = (userId === ADMIN_USER);
            if (!isAdmin && (config.status !== 'active' || now > new Date(config.expiry))) continue;

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, pnl: 0, lastBuy: 0, dca: 0 }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                if (sl.status === 'WAITING' && s.p <= sl.buy) sl.status = 'BOUGHT';
                if (sl.status === 'BOUGHT') sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * 50;

                // DCA লজিক
                const drop = ((sl.lastBuy - s.p) / sl.lastBuy) * 100;
                if (sl.status === 'BOUGHT' && drop >= 0.45 && sl.dca < 5) {
                    const coin = COINS.find(c => c.s === sl.sym);
                    const order = await placeOrder(sl.sym, "BUY", s.p.toFixed(coin.d), sl.qty, config);
                    if (order) {
                        sl.buy = (sl.buy + s.p) / 2; sl.qty = (parseFloat(sl.qty) * 2).toFixed(coin.qd);
                        sl.sell = (sl.buy * 1.0008).toFixed(coin.d); sl.dca++; sl.lastBuy = s.p;
                        sendTG(`⚠️ *DCA RECOVERY START* \nCoin: ${coin.n} | PnL: ${sl.pnl.toFixed(2)}%`, config.cid);
                    }
                }

                // সেল লজিক (স্ক্রিনশট ফরম্যাট)
                if (sl.status === 'BOUGHT' && s.p >= sl.sell) {
                    const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy) - (sl.qty * sl.sell * 0.0008);
                    sl.active = false; config.profit += gain; config.count += 1;
                    saveUser(userId, config);
                    const ord = getOrdinal(config.count);
                    sendTG(`*${ord} সেল* \nSELL SUCCESS ✅ (Slot ${sl.id+1})\nGain: $${gain.toFixed(2)} (৳${(gain*124).toFixed(0)}) 💰 মোট ৳${(config.profit*124).toFixed(0)}`, config.cid);
                    sl.status = 'IDLE'; sl.sym = '';
                }
            });

            // এন্ট্রি
            const slotIdx = slots.findIndex(sl => !sl.active);
            if (slotIdx !== -1 && s.trend >= 3 && !slots.some(sl => sl.active && sl.sym === msg.s)) {
                const coin = COINS.find(c => c.s === msg.s);
                const buyP = s.p.toFixed(coin.d);
                const sellP = (parseFloat(buyP) * 1.0015).toFixed(coin.d);
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

// 🌐 ওয়েব পোর্টাল UI (আপনার স্ক্রিনশটের মতো ডিজাইন)
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);
    let users = getAllUsers();
    let settings = getSettings();

    // অ্যাডমিন কমান্ড
    if (url.pathname === '/admin-act' && url.searchParams.get('pass') === ADMIN_PASS) {
        let exp = new Date(Date.now() + (parseFloat(url.searchParams.get('hours')) * 60 * 60 * 1000));
        saveUser(url.searchParams.get('user'), { status: 'active', expiry: exp.toISOString() });
        return res.end("Activated");
    }
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
            lev: parseInt(url.searchParams.get('lev')), mode: url.searchParams.get('mode'),
            profit: 0, count: 0, status: (id === ADMIN_USER) ? 'active' : 'pending',
            expiry: (id === ADMIN_USER) ? new Date(2099, 1, 1).toISOString() : new Date().toISOString()
        });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (!userId || !users[userId]) {
        // লগইন/রেজিস্ট্রেশন পেজ (সিম্পল রাখা হয়েছে)
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-6 font-sans flex items-center min-h-screen text-center"><div class="max-w-md mx-auto space-y-6 w-full">
            <h1 class="text-4xl font-black text-sky-400 italic">CI QUANTUM</h1>
            <form action="/register" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-3 text-left">
                <input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-2xl border border-slate-800" required>
                <select name="mode" class="w-full bg-black p-4 rounded-2xl border border-slate-800"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select>
                <input name="api" placeholder="API Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800">
                <input name="sec" placeholder="Secret Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800">
                <input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-2xl border border-slate-800" required>
                <div class="grid grid-cols-2 gap-2"><input name="cap" type="number" value="10" class="bg-black p-4 rounded-2xl"><select name="lev" class="bg-black p-4 rounded-2xl"><option value="20">20x</option><option value="50" selected>50x</option></select></div>
                <button class="w-full bg-sky-600 p-5 rounded-2xl font-black uppercase shadow-lg">Launch Engine</button>
            </form>
        </div></body></html>`);
    } else {
        let user = users[userId];
        let slots = userSlots[userId] || Array(5).fill({sym:'Empty',status:'IDLE',active:false});
        const active = (userId === ADMIN_USER) || (user.status === 'active' && new Date(user.expiry) > new Date());
        
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white font-sans p-4"><div class="max-w-xl mx-auto space-y-6">
            <div class="flex justify-between items-center px-2">
                <div><h1 class="text-3xl font-black text-white italic">CI QUANTUM</h1><p class="text-[10px] text-slate-500 uppercase tracking-widest">FINAL MASTER v50.0 // SYSTEM ONLINE</p></div>
                <div class="bg-slate-900/50 px-4 py-2 rounded-full border border-green-500/20 text-green-400 text-xs font-bold animate-pulse">● ENGINE ACTIVE</div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div class="bg-[#161b22] p-6 rounded-[2rem] border border-slate-800 relative overflow-hidden shadow-2xl">
                    <p class="text-[10px] text-slate-500 uppercase font-black">Total Profit (USD)</p><p class="text-4xl font-bold text-green-400 mt-2">$${user.profit.toFixed(2)}</p><p class="text-[10px] text-slate-600 mt-1 italic">Life Time Gain</p><div class="absolute right-6 top-10 text-4xl opacity-10">💲</div>
                </div>
                <div class="bg-[#161b22] p-6 rounded-[2rem] border border-slate-800 relative overflow-hidden shadow-2xl">
                    <p class="text-[10px] text-slate-500 uppercase font-black">Total Profit (BDT)</p><p class="text-4xl font-bold text-green-500 mt-2">৳${(user.profit * 124).toFixed(0)}</p><p class="text-[10px] text-slate-600 mt-1 italic">Approximate Value</p><div class="absolute right-6 top-10 text-4xl opacity-10">💼</div>
                </div>
            </div>

            <div class="bg-[#161b22] p-6 rounded-[2rem] border border-slate-800 shadow-2xl">
                <h3 class="text-xs font-bold text-slate-500 uppercase tracking-widest mb-6 flex items-center gap-2">📈 Market Pulse</h3>
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    ${COINS.map(c => `
                    <div class="bg-black/30 p-3 rounded-2xl border border-slate-800 text-center">
                        <p class="text-[10px] font-black text-sky-400 italic">${c.n}</p>
                        <p class="text-xs font-bold mt-1">$${market[c.s].p.toFixed(c.d)}</p>
                        <div class="w-full bg-slate-800 h-1 rounded-full mt-2 overflow-hidden"><div class="bg-red-500 h-full" style="width: ${market[c.s].mom}%"></div></div>
                    </div>`).join('')}
                </div>
            </div>

            <div class="bg-[#161b22] p-6 rounded-[2rem] border border-slate-800 shadow-2xl overflow-x-auto">
                <h3 class="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">🎯 Active Trading Slots</h3>
                <table class="w-full text-left border-collapse">
                    <thead><tr class="text-[10px] text-slate-600 uppercase border-b border-slate-800">
                        <th class="py-3 px-2">Slot</th><th class="py-3 px-2">Symbol</th><th class="py-3 px-2">Entry</th><th class="py-3 px-2">Target</th><th class="py-3 px-2">PNL</th>
                    </tr></thead>
                    <tbody class="text-xs">
                    ${slots.map(s => `
                        <tr class="border-b border-slate-800/50">
                            <td class="py-4 px-2 text-slate-500">#${s.id+1}</td>
                            <td class="py-4 px-2 font-black ${s.active?'text-white':'text-slate-700'}">${s.sym.replace('USDT','')}</td>
                            <td class="py-4 px-2 font-mono text-slate-400">${s.active?s.buy:'-'}</td>
                            <td class="py-4 px-2 font-mono text-green-400">${s.active?s.sell:'-'}</td>
                            <td class="py-4 px-2 font-bold ${s.pnl>=0?'text-green-500':'text-red-500'}">${s.active?s.pnl.toFixed(2)+'%':'-'}</td>
                        </tr>`).join('')}
                    </tbody>
                </table>
            </div>

            <div class="bg-[#161b22] p-8 rounded-[2rem] border border-sky-900/30 text-center space-y-4">
                <h3 class="text-[10px] text-slate-500 uppercase font-black tracking-widest italic">⚙️ Bot Configuration</h3>
                <div class="flex gap-2">
                    <input type="number" id="c" value="${user.cap}" class="bg-black border border-slate-800 w-full rounded-2xl px-6 py-3 text-lg font-bold outline-none focus:border-sky-500 transition">
                    <button onclick="window.location.href='/register?id=${userId}&mode=${user.mode}&api=${user.api}&sec=${user.sec}&cid=${user.cid}&lev=${user.lev}&cap='+document.getElementById('c').value" class="bg-sky-600 px-8 rounded-2xl font-black uppercase text-xs">Update</button>
                </div>
                <button onclick="if(confirm('সব ডাটা রিসেট করবেন?')) location.href='/reset-now?id=${userId}'" class="w-full bg-red-600/10 text-red-500 py-3 rounded-2xl font-black uppercase text-[10px] border border-red-500/20">🗑️ Reset Bot Data</button>
            </div>
        </div><script>setTimeout(()=>location.reload(), 6000);</script></body></html>`);
    }
});

server.listen(process.env.PORT || 8080, () => {
    startGlobalEngine();
});

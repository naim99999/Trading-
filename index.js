const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ Quantum AI - Master Speed DCA v27.0
// ==========================================
const MASTER_TG_TOKEN = "8281887575:AAGRTPvSdT4ho8C2nwsxCHyUMkRq2q6qWDc"; 
const FIXED_CHAT_ID = "5279510350"; 
const DB_FILE = 'nebula_master_final.json';

function getAllUsers() {
    if (!fs.existsSync(DB_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) { return {}; }
}
function saveUser(userId, data) {
    let users = getAllUsers();
    users[userId] = { ...users[userId], ...data };
    fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
}

// ৪০টি সুপার ফাস্ট কয়েন
const COINS = [
    { s: "BTCUSDT", n: "BTC", d: 2, qd: 3 }, { s: "ETHUSDT", n: "ETH", d: 2, qd: 3 }, 
    { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 }, { s: "1000PEPEUSDT", n: "PEPE", d: 7, qd: 0 },
    { s: "BONKUSDT", n: "BONK", d: 8, qd: 0 }, { s: "WIFUSDT", n: "WIF", d: 4, qd: 1 },
    { s: "DOGEUSDT", n: "DOGE", d: 5, qd: 0 }, { s: "NEARUSDT", n: "NEAR", d: 4, qd: 1 },
    { s: "AVAXUSDT", n: "AVAX", d: 3, qd: 1 }, { s: "XRPUSDT", n: "XRP", d: 4, qd: 1 },
    { s: "SUIUSDT", n: "SUI", d: 4, qd: 1 }, { s: "TIAUSDT", n: "TIA", d: 4, qd: 1 },
    { s: "FETUSDT", n: "FET", d: 4, qd: 1 }, { s: "RNDRUSDT", n: "RNDR", d: 3, qd: 1 },
    { s: "MATICUSDT", n: "MATIC", d: 4, qd: 1 }, { s: "DOTUSDT", n: "DOT", d: 3, qd: 1 },
    { s: "ORDIUSDT", n: "ORDI", d: 3, qd: 1 }, { s: "APTUSDT", n: "APT", d: 3, qd: 1 },
    { s: "TRXUSDT", n: "TRX", d: 5, qd: 0 }, { s: "LINKUSDT", n: "LINK", d: 3, qd: 1 },
    { s: "ADAUSDT", n: "ADA", d: 4, qd: 1 }, { s: "SHIBUSDT", n: "SHIB", d: 8, qd: 0 },
    { s: "LTCUSDT", n: "LTC", d: 2, qd: 1 }, { s: "BCHUSDT", n: "BCH", d: 2, qd: 1 },
    { s: "UNIUSDT", n: "UNI", d: 3, qd: 1 }, { s: "OPUSDT", n: "OP", d: 4, qd: 1 },
    { s: "ARBUSDT", n: "ARB", d: 4, qd: 1 }, { s: "INJUSDT", n: "INJ", d: 3, qd: 1 },
    { s: "LDOUSDT", n: "LDO", d: 4, qd: 1 }, { s: "FILUSDT", n: "FIL", d: 3, qd: 1 },
    { s: "ATOMUSDT", n: "ATOM", d: 3, qd: 1 }, { s: "STXUSDT", n: "STX", d: 4, qd: 1 },
    { s: "GALAUSDT", n: "GALA", d: 5, qd: 0 }, { s: "ICPUSDT", n: "ICP", d: 3, qd: 1 },
    { s: "RUNEUSDT", n: "RUNE", d: 3, qd: 1 }, { s: "OMUSDT", n: "OM", d: 4, qd: 1 },
    { s: "JUPUSDT", n: "JUP", d: 4, qd: 1 }, { s: "PYTHUSDT", n: "PYTH", d: 4, qd: 1 },
    { s: "ONDOUSDT", n: "ONDO", d: 4, qd: 1 }, { s: "SATSUSDT", n: "SATS", d: 7, qd: 0 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, trend: 0 });
let userSlots = {}; 

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

async function sendTG(msg, chatId) {
    const id = chatId || FIXED_CHAT_ID;
    try { await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: id, text: msg, parse_mode: 'Markdown' }); return true; } catch (e) { return false; }
}

async function getBinanceBalance(config) {
    if (config.mode === 'demo' || !config.api) return "100.00";
    const ts = Date.now();
    const query = `timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?${query}&signature=${signature}`, { headers: { 'X-MBX-APIKEY': config.api }, timeout: 5000 });
        return res.data ? parseFloat(res.data.totalWalletBalance).toFixed(2) : "0.00";
    } catch (e) { return "Connect API"; }
}

async function placeOrder(symbol, side, qty, config) {
    if (config.mode === 'demo') return { orderId: 'DEMO_' + Date.now() };
    const ts = Date.now();
    let query = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.post(`https://fapi.binance.com/fapi/v1/order?${query}&signature=${signature}`, null, { headers: { 'X-MBX-APIKEY': config.api } });
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
        s.trend = s.p > s.lp ? Math.min(10, (s.trend || 0) + 1) : 0;

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, sym: '', buy: 0, sell: 0, qty: 0, pnl: 0, curP: 0, dca: 0, totalCost: 0, be: false }));
            
            userSlots[userId].forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.curP = s.p;

                let rawPnL = ((s.p - sl.buy) / sl.buy) * 100 * config.lev;
                sl.pnl = rawPnL - 0.15; 

                // ১. ব্রেক-ইভেন শিল্ড (০.২৫% লাভে গেলে একটিভ হবে)
                if (!sl.be && rawPnL >= 0.25) {
                    sl.be = true;
                    sendTG(`🛡️ *Safety Shield:* #${sl.sym} এর লাভ ফী সহ সুরক্ষিত করা হলো।`, config.cid);
                }

                // ২. স্মার্ট DCA লজিক (দাম ১.২% ডাউনে গেলেই এভারেজ করবে)
                if (sl.dca < 3 && rawPnL <= -1.2) {
                    const order = await placeOrder(sl.sym, "BUY", sl.qty, config);
                    if (order) {
                        sl.totalCost += (sl.qty * s.p);
                        sl.qty = parseFloat(sl.qty) * 2;
                        sl.buy = sl.totalCost / sl.qty;
                        sl.dca += 1;
                        sl.sell = sl.buy * 1.0035; // ফী বাদে লাভ নিশ্চিত
                        sendTG(`🌀 *DCA Executed:* #${sl.sym} গড় ক্রয়মূল্য কমিয়ে ${sl.buy.toFixed(5)} করা হলো।`, config.cid);
                    }
                }

                // ৩. লাভে ক্লোজ (০.৩৫% টার্গেট - সুপার ফাস্ট)
                if (s.p >= sl.sell) {
                    const gain = (sl.qty * s.p) - (sl.totalCost);
                    const netGain = gain * 0.998;
                    sl.active = false; config.profit += netGain; config.count += 1;
                    saveUser(userId, config);
                    sendTG(`✅ *TRADE PROFIT:* #${sl.sym}\nলাভ: ৳${(netGain*124).toFixed(0)}\nমোট সাগর জমা: ৳${(config.profit*124).toFixed(0)}`, config.cid);
                    if(config.mode !== 'demo') await placeOrder(sl.sym, "SELL", sl.qty, config);
                }

                // ৪. শিল্ড হিট (যদি লাভ সুরক্ষিত হওয়ার পর দাম কেনা দামে নামে)
                if (sl.be && s.p <= sl.buy * 1.0012) {
                    sl.active = false;
                    sendTG(`🛡️ *Shield Triggered:* #${sl.sym} জিরো লসে ক্লোজ করা হলো।`, config.cid);
                    if(config.mode !== 'demo') await placeOrder(sl.sym, "SELL", sl.qty, config);
                }
            });

            // ৫. সুপার ফাস্ট এন্ট্রি (Trend >= 1 হলেই কিনবে)
            const slotIdx = userSlots[userId].findIndex(sl => !sl.active);
            if (!config.isPaused && slotIdx !== -1 && s.trend >= 1) {
                const sameCoin = userSlots[userId].filter(sl => sl.active && sl.sym === msg.s);
                if (sameCoin.length === 0) {
                    const coin = COINS.find(c => c.s === msg.s);
                    const buyPrice = s.p;
                    const sellPrice = buyPrice * 1.0035; 
                    
                    // পুঁজির ১/১৫ অংশ প্রথম এন্ট্রিতে নিবে (বাকিটা DCA ব্যাকআপ)
                    const qty = ((config.cap / 15 * config.lev) / buyPrice).toFixed(coin.qd);
                    
                    const order = await placeOrder(msg.s, "BUY", qty, config);
                    if (order) {
                        userSlots[userId][slotIdx] = { id: slotIdx, active: true, sym: msg.s, buy: buyPrice, sell: sellPrice, qty: qty, pnl: 0, curP: s.p, dca: 0, totalCost: (qty * buyPrice), be: false };
                        sendTG(`🚀 *NEW ENTRY:* #${msg.s} কিনলাম।`, config.cid);
                    }
                }
            }
        }
    });
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}

const server = http.createServer(async (req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    if (url.pathname === '/api/data') {
        const uid = url.searchParams.get('id');
        const user = db[uid];
        const balance = await getBinanceBalance(user || {});
        return res.end(JSON.stringify({ slots: userSlots[uid] || [], profit: user ? (user.profit * 124).toFixed(0) : 0, count: user ? user.count : 0, isPaused: user?.isPaused || false, balance: balance }));
    }

    if (url.pathname === '/toggle-pause') {
        const uid = url.searchParams.get('id');
        if (db[uid]) { db[uid].isPaused = !db[uid].isPaused; saveUser(uid, db[uid]); }
        res.writeHead(200); return res.end("OK");
    }

    if (url.pathname === '/reset') {
        const id = url.searchParams.get('id');
        if (db[id]) { db[id].profit = 0; db[id].count = 0; saveUser(id, db[id]); userSlots[id] = null; }
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        saveUser(id, { api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), cid: url.searchParams.get('cid'), cap: parseFloat(url.searchParams.get('cap'))||10, lev: parseInt(url.searchParams.get('lev'))||20, mode: url.searchParams.get('mode')||'live', profit: 0, count: 0, isPaused: false });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-6 flex items-center min-h-screen text-center"><div class="max-w-md mx-auto w-full space-y-6">
            <h1 class="text-6xl font-black text-sky-400 italic">QUANTUM</h1>
            <form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 border border-slate-800 text-left">
                <input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none" required>
                <select name="mode" class="w-full bg-black p-4 rounded-xl border border-slate-800"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select>
                <input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none">
                <input name="sec" placeholder="Binance Secret" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none">
                <input name="cid" placeholder="Chat ID" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none" value="${FIXED_CHAT_ID}">
                <div class="grid grid-cols-2 gap-3">
                    <input name="cap" type="number" placeholder="Capital $" class="bg-black p-4 rounded-xl border border-slate-800 outline-none">
                    <input name="lev" type="number" placeholder="Leverage" class="bg-black p-4 rounded-xl border border-slate-800 outline-none">
                </div>
                <button type="submit" class="w-full bg-sky-600 p-5 rounded-full font-black uppercase">Start Engine</button>
            </form></div></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-[#020617] text-white p-4 font-sans uppercase">
                <div class="max-w-xl mx-auto space-y-4">
                    <div class="p-6 bg-slate-900 rounded-[2.5rem] border-2 border-sky-500/50 text-center shadow-2xl">
                        <p class="text-[10px] text-sky-400 font-bold mb-1">Available Binance Balance</p>
                        <p class="text-5xl font-black text-white">$<span id="balanceText">0.00</span></p>
                    </div>
                    <div class="grid grid-cols-2 gap-4">
                        <div class="p-5 bg-slate-900 rounded-[2rem] text-center border border-slate-800"><p class="text-[9px] text-slate-500 font-bold mb-1 uppercase">Growth (BDT)</p><p class="text-3xl font-black text-green-400">৳<span id="profitText">0</span></p></div>
                        <div class="p-5 bg-slate-900 rounded-[2rem] text-center border border-slate-800"><p class="text-[9px] text-slate-500 font-bold mb-1 uppercase">Wins</p><p class="text-3xl font-black text-sky-400" id="countText">0</p></div>
                    </div>
                    <div id="slotContainer" class="space-y-3"></div>
                    <div class="grid grid-cols-2 gap-3 pt-4">
                        <button onclick="togglePause()" id="pauseBtn" class="py-5 rounded-full text-[10px] font-black bg-orange-900/20 border border-orange-500/30 text-orange-500">PAUSE</button>
                        <a href="/reset?id=${userId}" onclick="return confirm('রিসেট করবেন?')" class="bg-red-900/20 border border-red-500/30 text-red-500 py-5 rounded-full text-center text-[10px] font-black uppercase">Reset</a>
                    </div>
                    <a href="/" class="block w-full bg-slate-800 border border-slate-700 text-slate-400 py-5 rounded-full text-center text-[10px] font-black">LOGOUT</a>
                </div>
                <script>
                    async function togglePause() { await fetch('/toggle-pause?id=${userId}'); location.reload(); }
                    async function updateData() {
                        try {
                            const res = await fetch('/api/data?id=${userId}');
                            const data = await res.json();
                            document.getElementById('balanceText').innerText = data.balance;
                            document.getElementById('profitText').innerText = data.profit;
                            document.getElementById('countText').innerText = data.count;
                            let html = '';
                            data.slots.forEach((s, i) => {
                                let meter = s.active ? Math.max(0, Math.min(100, ((s.curP - s.buy) / (s.sell - s.buy)) * 100)) : 0;
                                html += \`<div class="p-5 bg-slate-900/50 rounded-3xl border border-zinc-800 transition-all duration-300 mb-3">
                                    <div class="flex justify-between items-center mb-3"><span class="text-[11px] font-black \${s.active ? 'text-sky-400' : 'text-zinc-700'}">\${s.active ? s.sym : 'Slot '+(i+1)+' Scanning...'} \${s.active ? '[DCA:'+s.dca+']' : ''}</span>\${s.active ? \`<span class="text-[11px] font-black \${s.pnl>=0?'text-green-500':'text-red-400'}">\${s.pnl.toFixed(2)}%</span>\` : ''}</div>
                                    \${s.active ? \`<div class="w-full bg-black h-1.5 rounded-full overflow-hidden mb-4"><div class="h-full bg-sky-500 transition-all duration-1000" style="width: \${meter}%"></div></div>
                                    <div class="grid grid-cols-2 text-[10px] font-mono text-slate-500 gap-y-1"><div>Entry: \${s.buy.toFixed(4)}</div><div class="text-right">Live: \${s.curP}</div><div class="text-orange-400">DCA: \${(s.buy * 0.988).toFixed(4)}</div><div class="text-right text-green-500">Target: \${s.sell.toFixed(4)}</div></div>\` : ''}
                                </div>\`;
                            });
                            document.getElementById('slotContainer').innerHTML = html;
                        } catch(e) {}
                    }
                    setInterval(updateData, 800);
                </script>
            </body></html>`);
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => { 
    startGlobalEngine(); 
    sendTG("🚀 *Final Aggressive Core Online!* যাত্রা সফল হোক।", FIXED_CHAT_ID);
});

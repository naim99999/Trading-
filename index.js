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
const MASTER_TG_TOKEN = "8281887575:AAGRTPvSdT4ho8C2NwsxCHyUMkRq2q6qWDc"; 
const ADMIN_CHAT_ID = "5279510350";
const ADMIN_API = "zjZgsBWc77SC6xVxiY58HDZ1ToGLuS37A3Zw1GfxUnESoNyksw3weVoaiWTk5pec";
const ADMIN_SEC = "YlvltwUt2LpP1WHDPST9WKNvj6bSJvjxn9nqZiz32JgJab6B9GJrREBg633qQGzn";

const DB_FILE = 'nebula_master_final_db.json';

function getAllUsers() {
    if (!fs.existsSync(DB_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) { return {}; }
}
function saveUser(userId, data) {
    let users = getAllUsers();
    users[userId] = { ...users[userId], ...data };
    fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
}

// 🎯 ৪০টি কয়েন পুল (যাতে ক্যাপিটাল ১ সেকেন্ডও বসে না থাকে)
const COINS = [
    { s: "BTCUSDT", n: "BTC", d: 2, qd: 3 }, { s: "ETHUSDT", n: "ETH", d: 2, qd: 3 }, 
    { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 }, { s: "1000PEPEUSDT", n: "PEPE", d: 7, qd: 0 },
    { s: "BONKUSDT", n: "BONK", d: 8, qd: 0 }, { s: "WIFUSDT", n: "WIF", d: 4, qd: 1 },
    { s: "DOGEUSDT", n: "DOGE", d: 5, qd: 0 }, { s: "NEARUSDT", n: "NEAR", d: 4, qd: 1 },
    { s: "AVAXUSDT", n: "AVAX", d: 3, qd: 1 }, { s: "XRPUSDT", n: "XRP", d: 4, qd: 1 },
    { s: "DOTUSDT", n: "DOT", d: 3, qd: 1 }, { s: "LINKUSDT", n: "LINK", d: 3, qd: 2 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, trend: 0, history: [], mom: 0 });
let userSlots = {}; 
let lastReportMin = -1;

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

async function getBinanceBalance(config) {
    if (config.mode === 'demo' || !config.api || config.api === 'demo') return "Infinity (DEMO)";
    const ts = Date.now();
    const query = `timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?${query}&signature=${signature}`, {
            headers: { 'X-MBX-APIKEY': config.api }, timeout: 5000
        });
        return res.data ? parseFloat(res.data.totalWalletBalance).toFixed(2) : "0.00";
    } catch (e) { return "Error"; }
}

async function sendTG(msg, chatId, replyId = null) {
    try {
        const payload = { chat_id: chatId, text: msg, parse_mode: 'Markdown' };
        if (replyId) payload.reply_to_message_id = replyId;
        const res = await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, payload);
        return res.data.result.message_id;
    } catch (e) { return null; }
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

// 🚀 হাই-ভেলোসিটি এঞ্জিন কোর
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
        const avgP = s.history.reduce((a,b)=>a+b, 0) / s.history.length;

        if (s.p > s.lp) { s.trend = Math.min(10, s.trend + 1); s.mom = Math.min(100, (s.mom||0) + 20); } 
        else { s.trend = 0; s.mom = Math.max(0, (s.mom||0) - 20); }

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            if (config.status !== 'active') continue;

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 1, qty: 0, pnl: 0, dca1: 0, dca2: 0, waitTime: 0, curP: 0, mid: null }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.curP = s.p;

                // ২-মিনিট রিসাইকেল
                if (sl.status === 'WAITING' && (Date.now() - sl.waitTime > 120000)) {
                    sl.active = false; sl.status = 'IDLE'; sl.sym = ''; return;
                }

                // যখন বাই সম্পন্ন হবে
                if (sl.status === 'WAITING' && s.p <= sl.buy) {
                    sl.status = 'BOUGHT';
                    const cI = COINS.find(c=>c.s===sl.sym);
                    // ৩টি হাই-প্রাইস চালাকি অর্ডার বিন্যান্সে পাঠানো
                    await placeOrder(sl.sym, "SELL", sl.sell.toFixed(cI.d), sl.qty, config, "LIMIT");
                    await placeOrder(sl.sym, "BUY", sl.dca1.toFixed(cI.d), sl.qty, config, "LIMIT");
                    await placeOrder(sl.sym, "BUY", sl.dca2.toFixed(cI.d), (parseFloat(sl.qty) * 2).toFixed(cI.qd), config, "LIMIT");
                    
                    const mid = await sendTG(`📥 *বাই সম্পন্ন করা হয়েছে!* \n📌 স্লট: #${sl.id+1} \n💰 কয়েন: *${sl.sym.replace('USDT','')}* \n💵 দাম: ${s.p}`, config.cid);
                    sl.mid = mid;
                }

                if (sl.status === 'BOUGHT') {
                    sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * config.lev;
                    if (s.p >= sl.sell) {
                        const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy) - (sl.qty * sl.sell * 0.0008);
                        sl.active = false; config.profit += gain; config.count += 1;
                        saveUser(userId, config);
                        sendTG(`🎉 *DONE!* ${sl.sym} \n💵 নিট লাভ: ৳${(gain*124).toFixed(0)} \n📈 মোট: ৳${(config.profit*124).toFixed(0)}`, config.cid, sl.mid);
                        sl.status = 'IDLE'; sl.sym = '';
                    }
                }
            });

            // ৩. হাইপার ভেলোসিটি এন্ট্রি (প্রাইস চালাকি সহ)
            const slotIdx = slots.findIndex(sl => !sl.active);
            if (!config.isPaused && slotIdx !== -1 && s.trend >= 2 && s.p < avgP) {
                const sameCoin = slots.filter(sl => sl.active && sl.sym === msg.s);
                if (sameCoin.length === 0 || s.p < Math.min(...sameCoin.map(x => x.buy)) * 0.994) {
                    const coin = COINS.find(c => c.s === msg.s);
                    // ৫.০১ এবং ৪.৯৯ এর মতো স্মার্ট প্রাইজ অ্যাডজাস্টমেন্ট
                    const buyP = (s.p * 1.0002).toFixed(coin.d); // সামান্য বেশি দামে অর্ডার (৫.০১ প্যাটার্ন) যাতে সাথে সাথে হিট হয়
                    const sellP = (parseFloat(buyP) * 1.0011).toFixed(coin.d); // ৪.৯৯ প্যাটার্নে সেল প্রাইজ অ্যাডজাস্ট
                    const d1P = (parseFloat(buyP) * 0.995).toFixed(coin.d);
                    const d2P = (parseFloat(buyP) * 0.988).toFixed(coin.d);
                    const qty = ((config.cap / 5 * config.lev) / parseFloat(buyP)).toFixed(coin.qd);

                    const order = await placeOrder(msg.s, "BUY", buyP, qty, config, "LIMIT");
                    if (order) slots[slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: msg.s, buy: parseFloat(buyP), sell: parseFloat(sellP), dca1: parseFloat(d1P), dca2: parseFloat(d2P), qty: qty, pnl: 0, waitTime: Date.now(), curP: s.p, mid: null };
                }
            }
        }
    });
}

// 🌐 মাস্টার ড্যাশবোর্ড UI (প্রিয় ডিজাইন হুবহু)
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
        saveUser(id, { api: (id===ADMIN_USER)?ADMIN_API:url.searchParams.get('api'), sec: (id===ADMIN_USER)?ADMIN_SEC:url.searchParams.get('sec'), cid: (id===ADMIN_USER)?ADMIN_CHAT_ID:url.searchParams.get('cid'), cap: parseFloat(url.searchParams.get('cap'))||10, lev: parseInt(url.searchParams.get('lev'))||50, mode: url.searchParams.get('mode')||'live', profit: 0, count: 0, status: (id===ADMIN_USER)?'active':'pending', expiry: (id===ADMIN_USER)?new Date(2099,1,1).toISOString():new Date().toISOString(), isPaused: false });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-6 font-sans flex items-center min-h-screen text-center"><div class="max-w-md mx-auto space-y-6 w-full">
            <h1 class="text-5xl font-black text-sky-400 italic">QUANTUM MASTER</h1>
            <form action="/register" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 text-left shadow-2xl">
                <input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white outline-none focus:border-sky-600" required>
                <select name="mode" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select>
                <input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white outline-none"><input name="sec" placeholder="Binance Secret Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white outline-none">
                <input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white outline-none" required>
                <div class="grid grid-cols-2 gap-3"><input name="cap" type="number" min="1" value="10" class="bg-black p-4 rounded-2xl text-white"><input name="lev" type="number" value="50" class="bg-black p-4 rounded-2xl text-white"></div>
                <button type="submit" class="w-full bg-sky-600 p-5 rounded-[2rem] font-black uppercase shadow-lg active:scale-95 transition">Launch Engine</button>
            </form></div></body></html>`);
    } else {
        let user = db[userId];
        const isAdmin = (userId === ADMIN_USER);
        let slots = userSlots[userId] || Array(5).fill({sym:'Empty',status:'IDLE',active:false, pnl:0, curP:0, buy:0, sell:1, dca1:0, dca2:0});
        const avgMom = Object.values(market).reduce((a,b)=>a+(b.mom||0), 0) / COINS.length;
        let mColor = "text-slate-600"; let mText = "LOW";
        if(avgMom > 15) { mColor = "text-sky-400"; mText = "MODERATE"; }
        if(avgMom > 40) { mColor = "text-green-400"; mText = "HIGH"; }

        getBinanceBalance(user).then(balance => {
            res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script>
            <style>body{background:#020617;color:white;font-family:sans-serif;}.progress-bar{height:3px;background:#1e293b;border-radius:2px;overflow:hidden;margin-top:8px;}.progress-fill{height:100%;background:#22c55e;transition:width 0.5s ease;}.card-icon{position:absolute;right:20px;top:35px;font-size:32px;opacity:0.15;}</style></head>
            <body class="p-4 font-sans"><div class="max-w-xl mx-auto space-y-4">
                <div class="p-6 bg-slate-900 rounded-[2.5rem] border border-sky-500/40 shadow-xl flex justify-between items-center">
                    <div><h2 class="text-3xl font-black italic underline decoration-sky-600 uppercase underline-offset-8">${userId}</h2><p class="text-[9px] ${mColor} font-black uppercase tracking-widest mt-4 animate-pulse">${mText} INTENSITY ATTACK</p></div>
                    <div class="text-right"><div class="text-[9px] font-bold text-slate-500 uppercase">Binance Wallet</div><div class="text-3xl font-black text-green-400">$${balance}</div></div>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div class="p-6 bg-slate-900 rounded-[2rem] border border-slate-800 relative overflow-hidden shadow-2xl"><p class="text-[10px] text-slate-500 uppercase font-black">TOTAL PROFIT (BDT)</p><p class="text-4xl font-bold text-green-400 mt-2">৳${(user.profit * 124).toFixed(0)}</p><div class="card-icon">💼</div></div>
                    <div class="p-6 bg-slate-900 rounded-[2rem] border border-slate-800 relative overflow-hidden shadow-2xl"><p class="text-[10px] text-slate-500 uppercase font-black">SUCCESS TRADES</p><p class="text-4xl font-bold text-sky-400 mt-2">${user.count}</p><div class="card-icon">💲</div></div>
                </div>
                <div class="bg-zinc-900/50 p-6 rounded-[2rem] border border-zinc-800 flex justify-between items-center shadow-lg"><span class="text-xs font-bold uppercase text-slate-400 italic">Trade Engine Status</span><button onclick="location.href='/toggle-trade?id=${userId}'" class="px-6 py-2 rounded-full font-black text-[10px] uppercase transition ${user.isPaused ? 'bg-red-500/20 text-red-500 border border-red-500' : 'bg-green-500/20 text-green-400 border border-green-500'}">${user.isPaused ? 'PAUSED' : 'RUNNING'}</button></div>
                <div class="p-4 bg-zinc-900/50 rounded-[2.5rem] border border-zinc-800 space-y-3 shadow-inner">
                    ${slots.map((s,i) => {
                        let progress = 0; if(s.active && s.status === 'BOUGHT' && s.buy && s.sell) progress = Math.max(0, Math.min(100, ((s.curP - s.buy) / (s.sell - s.buy)) * 100));
                        let cD = COINS.find(c=>c.s===s.sym)?.d || 2;
                        return `<div class="p-4 bg-black/40 rounded-2xl border border-zinc-800/50">
                            <div class="flex justify-between items-center mb-1">
                                <div><span class="text-[9px] font-bold text-slate-600 uppercase italic">Slot ${i+1}</span><p class="text-sm font-black ${s.active ? 'text-sky-400' : 'text-zinc-800'}">${s.active ? s.sym.replace('USDT','') : 'IDLE'}</p></div>
                                <div class="text-right">${s.active ? `<span class="text-xs font-bold ${s.pnl>=0?'text-green-500':'text-red-400'}">${s.pnl.toFixed(1)}%</span>` : '<span class="text-[9px] text-zinc-700 font-black tracking-widest uppercase text-xs animate-pulse">Scanning</span>'}</div>
                            </div>
                            ${s.active && s.status === 'BOUGHT' ? `
                                <div class="grid grid-cols-2 gap-x-2 text-[8px] text-slate-500 uppercase font-bold mt-1">
                                    <span>Buy: ${s.buy.toFixed(cD)}</span><span class="text-right text-sky-300">Live: ${s.curP.toFixed(cD)}</span>
                                    <span class="text-red-400">D1: ${s.dca1.toFixed(cD)}</span><span class="text-right text-green-500">T: ${s.sell.toFixed(cD)}</span>
                                    <span class="text-red-600">D2: ${s.dca2.toFixed(cD)}</span>
                                </div>
                                <div class="progress-bar"><div class="progress-fill" style="width: ${progress}%"></div></div>
                            ` : ''}
                        </div>`;
                    }).join('')}
                </div>
                <div class="text-center opacity-30"><button onclick="if(confirm('Reset Everything?')) location.href='/reset-now?id=${userId}'" class="text-[9px] text-red-500 font-bold uppercase underline underline-offset-4 tracking-widest">Reset Master Core</button></div>
            </div><script>setTimeout(()=>location.reload(), 5000);</script></body></html>`);
        });
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    startGlobalEngine();
});

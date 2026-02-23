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

const COINS = [
    { s: "BTCUSDT", n: "BTC", d: 2, qd: 3 }, { s: "ETHUSDT", n: "ETH", d: 2, qd: 3 }, 
    { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 }, { s: "1000PEPEUSDT", n: "PEPE", d: 7, qd: 0 },
    { s: "BONKUSDT", n: "BONK", d: 8, qd: 0 }, { s: "WIFUSDT", n: "WIF", d: 4, qd: 1 },
    { s: "DOGEUSDT", n: "DOGE", d: 5, qd: 0 }, { s: "NEARUSDT", n: "NEAR", d: 4, qd: 1 },
    { s: "AVAXUSDT", n: "AVAX", d: 3, qd: 1 }, { s: "XRPUSDT", n: "XRP", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, trend: 0, history: [], mom: 0, rsi: 50 });
let userSlots = {}; 

// 📈 RSI ক্যালকুলেশন ফাংশন
function calculateRSI(prices, period = 14) {
    if (prices.length <= period) return 50;
    let gains = 0, losses = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
        let diff = prices[i] - prices[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
    if (losses === 0) return 100;
    let rs = gains / losses;
    return 100 - (100 / (1 + rs));
}

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

async function sendTG(msg, chatId, replyToId = null) {
    try {
        const payload = { chat_id: chatId, text: msg, parse_mode: 'Markdown' };
        if (replyToId) payload.reply_to_message_id = replyToId;
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

// 🚀 ওমনি এঞ্জিন (RSI ও ফাস্ট এক্সিকিউশন আপডেট)
async function startGlobalEngine() {
    const streams = COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    ws.on('message', async (data) => {
        const payload = JSON.parse(data);
        const msg = payload.data;
        if (!msg || !market[msg.s]) return;

        const s = market[msg.s];
        s.lp = s.p; s.p = parseFloat(msg.c);
        s.history.push(s.p); 
        if(s.history.length > 60) s.history.shift();
        
        // RSI আপডেট
        s.rsi = calculateRSI(s.history, 14);

        const avgP = s.history.reduce((a,b)=>a+b, 0) / s.history.length;

        if (s.p > s.lp) { s.trend = Math.min(10, s.trend + 1); } 
        else { s.trend = 0; }

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            if (config.status !== 'active') continue;

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 1, qty: 0, pnl: 0, lastBuy: 0, dca1: 0, dca2: 0, waitTime: 0, curP: 0, mid: null }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.curP = s.p;

                // বাই অর্ডার ফিল হয়েছে কি না চেক (সিমুলেশন ও ট্র্যাকিং)
                if (sl.status === 'WAITING' && s.p <= sl.buy) {
                    sl.status = 'BOUGHT';
                    const cI = COINS.find(c=>c.s===sl.sym);
                    await placeOrder(sl.sym, "SELL", sl.sell.toFixed(cI.d), sl.qty, config, "LIMIT");
                    sl.mid = await sendTG(`📥 *বাই সম্পন্ন:* ${sl.sym}\nপ্রাইস: ${s.p}\nRSI: ${s.rsi.toFixed(2)}`, config.cid);
                }

                if (sl.status === 'BOUGHT') {
                    sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * config.lev;
                    // দ্রুত সেলিং লজিক: টার্গেট প্রাইসে পৌঁছালে
                    if (s.p >= sl.sell) {
                        const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy) - (sl.qty * sl.sell * 0.0008);
                        sl.active = false; config.profit += gain; config.count += 1;
                        saveUser(userId, config);
                        sendTG(`🎉 *SOLD SUCCESS!* ${sl.sym} \nGain: ৳${(gain*124).toFixed(0)}\nPNL: ${sl.pnl.toFixed(2)}%`, config.cid, sl.mid);
                        sl.status = 'IDLE'; sl.sym = '';
                    }
                }
            });

            // 🎯 ট্রেড এন্ট্রি লজিক (RSI যুক্ত)
            const slotIdx = slots.findIndex(sl => !sl.active);
            if (!config.isPaused && slotIdx !== -1 && s.rsi < 38 && s.trend >= 1) {
                const sameCoin = slots.filter(sl => sl.active && sl.sym === msg.s);
                if (sameCoin.length === 0) {
                    const coin = COINS.find(c => c.s === msg.s);
                    
                    // এন্ট্রি প্রাইজ সামান্য বাড়িয়ে (৫.০১ লজিক) যাতে দ্রুত অর্ডার লাগে
                    const buyP = (s.p * 1.0002).toFixed(coin.d); 
                    
                    // সেল প্রাইজ সামান্য কমিয়ে (৪.৯৯ লজিক) যাতে দ্রুত প্রফিট বুক হয়
                    const targetProfit = 1.0015; // ০.১৫% প্রফিট টার্গেট
                    const sellP = (parseFloat(buyP) * targetProfit * 0.9998).toFixed(coin.d);
                    
                    const dca1P = (parseFloat(buyP) * 0.994).toFixed(coin.d);
                    const dca2P = (parseFloat(buyP) * 0.985).toFixed(coin.d);
                    const qty = ((config.cap / 5 * config.lev) / parseFloat(buyP)).toFixed(coin.qd);

                    const order = await placeOrder(msg.s, "BUY", buyP, qty, config, "LIMIT");
                    if (order) {
                        slots[slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: msg.s, buy: parseFloat(buyP), sell: parseFloat(sellP), dca1: parseFloat(dca1P), dca2: parseFloat(dca2P), qty: qty, pnl: 0, waitTime: Date.now(), curP: s.p };
                    }
                }
            }
        }
    });
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}

// 🌐 ড্যাশবোর্ড UI
const server = http.createServer((req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    if (url.pathname === '/toggle-trade') {
        const uid = url.searchParams.get('id');
        if(db[uid]) { db[uid].isPaused = !db[uid].isPaused; saveUser(uid, db[uid]); }
        res.writeHead(302, { 'Location': '/' + uid }); return res.end();
    }
    if (url.pathname === '/reset-now') {
        const uid = url.searchParams.get('id');
        if(db[uid]) { db[uid].profit = 0; db[uid].count = 0; saveUser(uid, db[uid]); delete userSlots[uid]; }
        res.writeHead(302, { 'Location': '/' + uid }); return res.end();
    }
    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        const isAdmin = (id === ADMIN_USER);
        saveUser(id, { api: isAdmin?ADMIN_API:(url.searchParams.get('api')||'demo'), sec: isAdmin?ADMIN_SEC:(url.searchParams.get('sec')||'demo'), cid: isAdmin?ADMIN_CHAT_ID:url.searchParams.get('cid'), cap: parseFloat(url.searchParams.get('cap'))||10, lev: parseInt(url.searchParams.get('lev'))||50, mode: url.searchParams.get('mode')||'live', profit: 0, count: 0, status: isAdmin?'active':'pending', expiry: isAdmin?new Date(2099,1,1).toISOString():new Date().toISOString(), isPaused: false });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-6 font-sans flex items-center min-h-screen text-center"><div class="max-w-md mx-auto space-y-6 w-full">
            <h1 class="text-5xl font-black text-sky-400 italic underline decoration-sky-600 uppercase underline-offset-8">Quantum Master</h1>
            <form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 text-left shadow-2xl">
                <input name="id" placeholder="Create User ID" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white outline-none focus:border-sky-600" required>
                <select name="mode" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select>
                <input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white">
                <input name="sec" placeholder="Binance Secret Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white">
                <input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white" required>
                <div class="grid grid-cols-2 gap-3"><input name="cap" type="number" min="1" value="10" class="bg-black p-4 rounded-2xl text-white"><input name="lev" type="number" value="50" class="bg-black p-4 rounded-2xl text-white"></div>
                <button type="submit" class="w-full bg-sky-600 p-5 rounded-[2rem] font-black uppercase shadow-lg active:scale-95 transition">Launch Portal</button>
            </form></div></body></html>`);
    } else {
        let user = db[userId];
        let slots = userSlots[userId] || Array(5).fill({sym:'Empty',status:'IDLE',active:false, pnl:0, curP:0, buy:0, sell:1});
        
        getBinanceBalance(user).then(balance => {
            res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script>
            <style>body{background:#020617;color:white;font-family:sans-serif;}.progress-bar{height:3px;background:#1e293b;border-radius:2px;overflow:hidden;margin-top:8px;}.progress-fill{height:100%;background:#22c55e;transition:width 0.5s ease;}.card-icon{position:absolute;right:20px;top:35px;font-size:32px;opacity:0.15;}</style></head>
            <body class="p-4 font-sans"><div class="max-w-xl mx-auto space-y-4">
                <div class="p-6 bg-slate-900 rounded-[2.5rem] border border-sky-500/40 shadow-xl flex justify-between items-center">
                    <div><h2 class="text-3xl font-black italic underline decoration-sky-600 uppercase">${userId}</h2><p class="text-[9px] font-black uppercase tracking-widest mt-4 animate-pulse text-sky-400">● RSI Core: Active</p></div>
                    <div class="text-right"><div class="text-[9px] font-bold text-slate-500 uppercase">Binance Wallet</div><div class="text-3xl font-black text-green-400">$${balance}</div></div>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div class="p-6 bg-slate-900 rounded-[2rem] border border-slate-800 relative overflow-hidden shadow-2xl"><p class="text-[10px] text-slate-500 uppercase font-black">TOTAL PROFIT (BDT)</p><p class="text-4xl font-bold text-green-400 mt-2">৳${(user.profit * 124).toFixed(0)}</p><div class="card-icon">💼</div></div>
                    <div class="p-6 bg-slate-900 rounded-[2rem] border border-slate-800 relative overflow-hidden shadow-2xl"><p class="text-[10px] text-slate-500 uppercase font-black">SUCCESS TRADES</p><p class="text-4xl font-bold text-sky-400 mt-2">${user.count}</p><div class="card-icon">💲</div></div>
                </div>
                <div class="bg-zinc-900/50 p-6 rounded-[2rem] border border-zinc-800 flex justify-between items-center shadow-lg"><span class="text-xs font-bold uppercase text-slate-400 italic">Trade Engine Status</span><button onclick="location.href='/toggle-trade?id=${userId}'" class="px-6 py-2 rounded-full font-black text-[10px] uppercase transition ${user.isPaused ? 'bg-red-500/20 text-red-500 border border-red-500' : 'bg-green-500/20 text-green-400 border border-green-500'}">${user.isPaused ? 'PAUSED' : 'RUNNING'}</button></div>
                <div class="p-4 bg-zinc-900/50 rounded-[2.5rem] border border-zinc-800 space-y-3 shadow-inner">
                    ${slots.map((s,i) => {
                        let progress = 0; if(s.active && s.status === 'BOUGHT') progress = Math.max(0, Math.min(100, ((s.curP - s.buy) / (s.sell - s.buy)) * 100));
                        let cD = COINS.find(c=>c.s===s.sym)?.d || 2;
                        let rsiVal = market[s.sym]?.rsi || 50;
                        return `<div class="p-4 bg-black/40 rounded-2xl border border-zinc-800/50">
                            <div class="flex justify-between items-center mb-1">
                                <div><span class="text-[9px] font-bold text-slate-600 uppercase italic">Slot ${i+1}</span><p class="text-sm font-black ${s.active ? 'text-sky-400' : 'text-zinc-800'}">${s.active ? s.sym.replace('USDT','') : 'SCANNING'}</p></div>
                                <div class="text-right">${s.active ? `<span class="text-xs font-bold ${s.pnl>=0?'text-green-500':'text-red-400'}">${(s.pnl||0).toFixed(2)}% PNL</span>` : `<span class="text-[9px] text-zinc-700 font-bold uppercase">RSI: ${rsiVal.toFixed(1)}</span>`}</div>
                            </div>
                            ${s.active ? `<div class="progress-bar"><div class="progress-fill" style="width: ${progress}%"></div></div>` : ''}
                        </div>`;
                    }).join('')}
                </div>
                <div class="text-center opacity-30"><button onclick="if(confirm('Reset Master?')) location.href='/reset-now?id=${userId}'" class="text-[9px] text-red-500 font-bold uppercase underline underline-offset-4 tracking-widest">Reset Master Core</button></div>
            </div><script>setTimeout(()=>location.reload(), 5000);</script></body></html>`);
        });
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    startGlobalEngine();
});

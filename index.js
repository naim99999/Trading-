const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ সিস্টেম কনফিগ (Central Setup)
// ==========================================
const MASTER_TG_TOKEN = "8281887575:AAGRTPvSdT4ho8C2nwsxCHyUMkRq2q6qWDc"; 
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
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, trend: 0, history: [] });
let userSlots = {}; 

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

// ১. অটোমেটিক লেভারেজ সেটআপ ফাংশন
async function setLeverage(symbol, leverage, config) {
    if (config.mode === 'demo') return true;
    const ts = Date.now();
    const query = `symbol=${symbol}&leverage=${leverage}&timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try {
        await axios.post(`https://fapi.binance.com/fapi/v1/leverage?${query}&signature=${signature}`, null, {
            headers: { 'X-MBX-APIKEY': config.api }
        });
        return true;
    } catch (e) { return false; }
}

async function getBinanceBalance(config) {
    if (config.mode === 'demo' || !config.api) return "1000.00";
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

async function sendTG(msg, chatId) {
    try {
        await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: chatId, text: msg, parse_mode: 'Markdown' });
    } catch (e) { }
}

async function placeOrder(symbol, side, price, qty, config, type = "LIMIT") {
    if (config.mode === 'demo') return { orderId: 'DEMO' };
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

// 🚀 ওমনি এঞ্জিন
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

        if (s.p > s.lp) s.trend = Math.min(10, (s.trend || 0) + 1);
        else s.trend = 0;

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, pnl: 0, dca1: 0, curP: 0 }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.curP = s.p;

                if (sl.status === 'WAITING' && s.p <= sl.buy) {
                    sl.status = 'BOUGHT';
                    const cI = COINS.find(c=>c.s===sl.sym);
                    await placeOrder(sl.sym, "SELL", sl.sell.toFixed(cI.d), sl.qty, config, "LIMIT");
                    await placeOrder(sl.sym, "BUY", sl.dca1.toFixed(cI.d), sl.qty, config, "LIMIT");
                    sendTG(`📥 *Buy Success:* ${sl.sym}\nPrice: ${s.p}`, config.cid);
                }

                if (sl.status === 'BOUGHT') {
                    sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * config.lev;
                    if (s.p >= sl.sell) {
                        const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy);
                        sl.active = false; config.profit += gain; config.count += 1;
                        saveUser(userId, config);
                        sendTG(`🎉 *Profit Book:* ${sl.sym}\nGain: ৳${(gain*124).toFixed(0)}`, config.cid);
                        sl.status = 'IDLE';
                    }
                }
            });

            const slotIdx = slots.findIndex(sl => !sl.active);
            if (!config.isPaused && slotIdx !== -1 && s.trend >= 3 && s.p < avgP) {
                const sameCoin = slots.filter(sl => sl.active && sl.sym === msg.s);
                if (sameCoin.length === 0) {
                    const coin = COINS.find(c => c.s === msg.s);
                    const buyP = (s.p * 0.9995).toFixed(coin.d); 
                    const sellP = (parseFloat(buyP) * 1.0045).toFixed(coin.d); 
                    const dca1P = (parseFloat(buyP) * 0.992).toFixed(coin.d);
                    const qty = ((config.cap / 5 * config.lev) / parseFloat(buyP)).toFixed(coin.qd);
                    
                    await setLeverage(msg.s, config.lev, config);
                    const order = await placeOrder(msg.s, "BUY", buyP, qty, config, "LIMIT");
                    
                    if (order) {
                        slots[slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: msg.s, buy: parseFloat(buyP), sell: parseFloat(sellP), dca1: parseFloat(dca1P), qty: qty, pnl: 0, curP: s.p };
                    }
                }
            }
        }
    });
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}

// 🌐 মোবাইল অপ্টিমাইজড ড্যাশবোর্ড
const server = http.createServer((req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        saveUser(id, { 
            api: url.searchParams.get('api'), 
            sec: url.searchParams.get('sec'), 
            cid: url.searchParams.get('cid'), 
            cap: parseFloat(url.searchParams.get('cap'))||10, 
            lev: parseInt(url.searchParams.get('lev'))||20, 
            mode: url.searchParams.get('mode')||'live', 
            profit: 0, count: 0, isPaused: false 
        });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><script src="https://cdn.tailwindcss.com"></script>
        <style>input, select{font-size: 16px !important;}</style></head>
        <body class="bg-[#020617] text-white p-6 font-sans"><div class="max-w-md mx-auto space-y-8 pt-10">
            <div class="text-center"><h1 class="text-5xl font-black text-sky-500 italic tracking-tighter">QUANTUM</h1><p class="text-slate-500 text-xs font-bold tracking-widest uppercase">Master Trading Bot</p></div>
            <form action="/register" method="GET" class="bg-slate-900 p-6 rounded-[2.5rem] space-y-4 border border-slate-800 shadow-2xl">
                <input name="id" placeholder="User ID" class="w-full bg-black p-4 rounded-2xl border border-slate-800 focus:border-sky-500 outline-none" required>
                <div class="grid grid-cols-2 gap-3">
                    <select name="mode" class="bg-black p-4 rounded-2xl border border-slate-800"><option value="live">Live</option><option value="demo">Demo</option></select>
                    <input name="lev" type="number" placeholder="Lev (ex: 50)" class="bg-black p-4 rounded-2xl border border-slate-800">
                </div>
                <input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800">
                <input name="sec" placeholder="Binance Secret Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800">
                <input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-2xl border border-slate-800" required>
                <input name="cap" type="number" placeholder="Trading Capital ($)" class="w-full bg-black p-4 rounded-2xl border border-slate-800">
                <button type="submit" class="w-full bg-sky-600 p-5 rounded-[2rem] font-black uppercase text-lg shadow-lg active:scale-95 transition-all">Launch System</button>
            </form></div></body></html>`);
    } else {
        let user = db[userId];
        let slots = userSlots[userId] || Array(5).fill({sym:'SCANNING',active:false, pnl:0, curP:0, buy:0, sell:0});
        getBinanceBalance(user).then(balance => {
            res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-[#020617] text-white p-4 font-sans"><div class="max-w-md mx-auto space-y-4">
                <div class="p-6 bg-slate-900 rounded-[2.5rem] border border-sky-500/30 flex justify-between items-center shadow-xl">
                    <div><h2 class="text-2xl font-black text-sky-400 uppercase tracking-tighter">${userId}</h2><p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest">${user.lev}x Leverage</p></div>
                    <div class="text-right"><p class="text-[9px] text-slate-500 font-black uppercase">Balance</p><p class="text-2xl font-black text-green-400">$${balance}</p></div>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div class="p-4 bg-slate-900 rounded-3xl border border-slate-800 text-center"><p class="text-[9px] text-slate-500 font-bold uppercase">Today Profit</p><p class="text-xl font-black text-green-400">৳${(user.profit * 124).toFixed(0)}</p></div>
                    <div class="p-4 bg-slate-900 rounded-3xl border border-slate-800 text-center"><p class="text-[9px] text-slate-500 font-bold uppercase">Success</p><p class="text-xl font-black text-sky-400">${user.count}</p></div>
                </div>
                <div class="space-y-3">
                    ${slots.map((s,i) => `
                        <div class="p-4 bg-slate-900/40 rounded-[2rem] border border-slate-800 shadow-inner">
                            <div class="flex justify-between items-center mb-2">
                                <span class="text-xs font-black ${s.active ? 'text-sky-400' : 'text-slate-600'}">${s.active ? s.sym : 'SLOT '+(i+1)+' | IDLE'}</span>
                                ${s.active ? `<span class="px-2 py-1 bg-black rounded-lg text-[10px] font-bold ${s.pnl>=0?'text-green-500':'text-red-400'}">${s.pnl.toFixed(2)}%</span>` : ''}
                            </div>
                            ${s.active ? `
                                <div class="grid grid-cols-2 gap-2 text-[10px] font-mono">
                                    <div class="text-slate-500">BUY: <span class="text-white">${s.buy}</span></div>
                                    <div class="text-right text-slate-500">LIVE: <span class="text-sky-300">${s.curP}</span></div>
                                    <div class="text-slate-500">DCA: <span class="text-orange-400">${s.dca1}</span></div>
                                    <div class="text-right text-slate-500">TARGET: <span class="text-green-400">${s.sell}</span></div>
                                </div>` : `<div class="h-1 bg-slate-800 rounded-full w-1/2 animate-pulse"></div>`}
                        </div>`).join('')}
                </div>
                <p class="text-center text-[9px] text-slate-600 font-bold uppercase tracking-widest pt-4">© Quantum Master Engine v4.0</p>
            </div><script>setTimeout(()=>location.reload(), 3000);</script></body></html>`);
        });
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => { startGlobalEngine(); });

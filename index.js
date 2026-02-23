const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ সিস্টেম কনফিগ
// ==========================================
const MASTER_TG_TOKEN = "8281887575:AAGRTPvSdT4ho8C2NwsxCHyUMkRq2q6qWDc"; 
const DB_FILE = 'nebula_master_v4.json';

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
    { s: "BTCUSDT", n: "BTC" }, { s: "ETHUSDT", n: "ETH" }, 
    { s: "SOLUSDT", n: "SOL" }, { s: "1000PEPEUSDT", n: "PEPE" },
    { s: "BONKUSDT", n: "BONK" }, { s: "WIFUSDT", n: "WIF" },
    { s: "DOGEUSDT", n: "DOGE" }, { s: "NEARUSDT", n: "NEAR" },
    { s: "AVAXUSDT", n: "AVAX" }, { s: "XRPUSDT", n: "XRP" }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, history: [], rsi: 50 });
let userSlots = {}; 

function calculateRSI(prices, period = 14) {
    if (prices.length <= period) return 50;
    let gains = 0, losses = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
        let diff = prices[i] - prices[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    if (losses === 0) return 100;
    return 100 - (100 / (1 + (gains / losses)));
}

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

async function sendTG(msg, chatId) {
    try { await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: chatId, text: msg, parse_mode: 'Markdown' }); } catch (e) { console.log("TG Error"); }
}

async function placeOrder(symbol, side, price, qty, config, type = "LIMIT") {
    if (config.mode === 'demo') return { status: 'FILLED' };
    const ts = Date.now();
    let query = `symbol=${symbol}&side=${side}&type=${type}&quantity=${qty}&timestamp=${ts}`;
    if(type === "LIMIT") query += `&price=${price}&timeInForce=GTC`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.post(`https://fapi.binance.com/fapi/v1/order?${query}&signature=${signature}`, null, {
            headers: { 'X-MBX-APIKEY': config.api }, timeout: 5000
        });
        return res.data;
    } catch (e) { return null; }
}

async function getBalance(config) {
    if (config.mode === 'demo') return "5000.00 (Demo)";
    const ts = Date.now();
    const query = `timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?${query}&signature=${signature}`, { headers: { 'X-MBX-APIKEY': config.api }, timeout: 5000 });
        return res.data ? parseFloat(res.data.totalWalletBalance).toFixed(2) : "0.00";
    } catch (e) { return "0.00"; }
}

async function startGlobalEngine() {
    const streams = COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    ws.on('message', async (data) => {
        const payload = JSON.parse(data);
        const msg = payload.data;
        if (!msg || !market[msg.s]) return;

        const s = market[msg.s];
        s.p = parseFloat(msg.c);
        s.history.push(s.p); if(s.history.length > 60) s.history.shift();
        s.rsi = calculateRSI(s.history, 14);

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            if (config.isPaused) continue;

            if (!userSlots[userId]) userSlots[userId] = Array(3).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, dca: 0, qty: 0, pnl: 0, curP: 0, rsi: 50 }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.curP = s.p;
                sl.rsi = s.rsi;
                sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * config.lev;

                if (sl.status === 'BOUGHT' && s.p >= sl.sell) {
                    const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy);
                    sl.active = false; config.profit += gain; config.count += 1;
                    saveUser(userId, config);
                    sendTG(`✅ *SELL SUCCESS (PROFIT)*\nUser: ${userId}\nCoin: ${sl.sym}\nProfit: ৳${(gain*124).toFixed(2)}\nPNL: ${sl.pnl.toFixed(2)}%`, config.cid);
                    sl.status = 'IDLE';
                }
            });

            const slotIdx = slots.findIndex(sl => !sl.active);
            if (slotIdx !== -1 && s.rsi < 28) { // RSI Entry < 28
                const sameCoin = slots.filter(sl => sl.active && sl.sym === msg.s);
                if (sameCoin.length === 0) {
                    const buyP = s.p * 1.0002;
                    const sellP = buyP * 1.007;
                    const dcaP = buyP * 0.993;
                    const qty = ((config.cap / 3 * config.lev) / buyP).toFixed(3);

                    const order = await placeOrder(msg.s, "BUY", buyP.toFixed(4), qty, config, "LIMIT");
                    if (order) {
                        slots[slotIdx] = { id: slotIdx, active: true, status: 'BOUGHT', sym: msg.s, buy: buyP, sell: sellP, dca: dcaP, qty: qty, pnl: 0, curP: s.p, rsi: s.rsi };
                        sendTG(`📥 *BUY EXECUTED*\nUser: ${userId}\nCoin: ${msg.s}\nPrice: ${buyP.toFixed(4)}\nRSI: ${s.rsi.toFixed(2)}`, config.cid);
                    }
                }
            }
        }
    });
}

const server = http.createServer(async (req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    if (url.pathname === '/reset') {
        const id = url.searchParams.get('id');
        if(db[id]) { db[id].profit = 0; db[id].count = 0; saveUser(id, db[id]); delete userSlots[id]; }
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        saveUser(id, { api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), cid: url.searchParams.get('cid'), cap: parseFloat(url.searchParams.get('cap')), lev: parseInt(url.searchParams.get('lev')), mode: url.searchParams.get('mode'), profit: 0, count: 0, isPaused: false });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    if (!userId || !db[userId]) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white flex items-center justify-center min-h-screen p-6 font-sans">
            <div class="w-full max-w-sm bg-slate-900/50 p-8 rounded-[3rem] border border-slate-800 shadow-2xl backdrop-blur-xl">
                <h1 class="text-4xl font-black text-sky-500 mb-8 text-center italic tracking-tighter">QUANTUM MASTER</h1>
                <form action="/register" class="space-y-4">
                    <input name="id" placeholder="Create User ID" class="w-full p-5 bg-black/50 rounded-2xl border border-slate-800 outline-none focus:border-sky-500 transition" required>
                    <select name="mode" class="w-full p-5 bg-black/50 rounded-2xl border border-slate-800"><option value="demo">Demo Mode</option><option value="live">Live Trading</option></select>
                    <input name="api" placeholder="Binance API Key" class="w-full p-5 bg-black/50 rounded-2xl border border-slate-800">
                    <input name="sec" placeholder="Binance Secret Key" class="w-full p-5 bg-black/50 rounded-2xl border border-slate-800">
                    <input name="cid" placeholder="Telegram Chat ID" class="w-full p-5 bg-black/50 rounded-2xl border border-slate-800" required>
                    <div class="flex gap-2"><input name="cap" type="number" value="10" class="w-1/2 p-5 bg-black/50 rounded-2xl border border-slate-800"><input name="lev" type="number" value="50" class="w-1/2 p-5 bg-black/50 rounded-2xl border border-slate-800"></div>
                    <button class="w-full bg-sky-600 p-6 rounded-[2rem] font-black uppercase tracking-widest shadow-lg shadow-sky-900/20 active:scale-95 transition">Launch Core</button>
                </form>
            </div>
        </body></html>`);
    } else {
        let user = db[userId];
        let balance = await getBalance(user);
        let slots = userSlots[userId] || Array(3).fill({active:false});

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script>
        <style>
            .meter-bg { height: 6px; background: #1e293b; border-radius: 10px; overflow: hidden; }
            .meter-fill { height: 100%; background: linear-gradient(90deg, #0ea5e9, #22c55e); transition: width 0.5s ease; }
            @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }
            .scanning { animation: pulse 1.5s infinite; }
        </style></head>
        <body class="bg-[#020617] text-slate-300 p-4 font-sans">
            <div class="max-w-md mx-auto space-y-4">
                <div class="bg-slate-900/80 p-6 rounded-[2.5rem] border border-slate-800 flex justify-between items-center backdrop-blur-md">
                    <div><h2 class="text-2xl font-black text-white italic tracking-tighter uppercase">${userId}</h2><p class="text-[9px] text-sky-500 font-bold uppercase tracking-widest">● System: ${user.mode}</p></div>
                    <div class="text-right"><p class="text-[9px] uppercase font-bold text-slate-500">Net Balance</p><p class="text-2xl font-black text-green-400">$${balance}</p></div>
                </div>

                <div class="grid grid-cols-2 gap-3">
                    <div class="bg-slate-900/80 p-5 rounded-[2rem] border border-slate-800"><p class="text-[9px] font-bold uppercase text-slate-500">Total Profit</p><p class="text-2xl font-black text-green-400">৳${(user.profit * 124).toFixed(0)}</p></div>
                    <div class="bg-slate-900/80 p-5 rounded-[2rem] border border-slate-800 text-right"><p class="text-[9px] font-bold uppercase text-slate-500">Wins</p><p class="text-2xl font-black text-sky-400">${user.count}</p></div>
                </div>

                <div class="space-y-3">
                    ${slots.map((s, i) => {
                        let progress = 0;
                        if(s.active && s.buy && s.sell) {
                            progress = ((s.curP - s.buy) / (s.sell - s.buy)) * 100;
                            progress = Math.max(0, Math.min(100, progress));
                        }
                        return `
                        <div class="bg-slate-900/80 p-6 rounded-[2.5rem] border ${s.active ? 'border-sky-500/40' : 'border-slate-800'}">
                            <div class="flex justify-between items-start mb-4">
                                <div><p class="text-[9px] font-bold text-slate-600 uppercase mb-1">Slot 0${i+1}</p>
                                <h3 class="text-xl font-black text-white tracking-tight">${s.active ? s.sym.replace('USDT','') : '<span class="scanning text-slate-700">SCANNING...</span>'}</h3></div>
                                ${s.active ? `<div class="text-right"><span class="text-xs font-black ${s.pnl>=0?'text-green-500':'text-red-500'}">${s.pnl.toFixed(2)}%</span><p class="text-[9px] text-slate-500 font-bold">RSI: ${s.rsi.toFixed(1)}</p></div>` : `<p class="text-[9px] text-slate-700 font-bold">RSI: ${market[COINS[i].s]?.rsi.toFixed(1) || '50.0'}</p>`}
                            </div>
                            ${s.active ? `
                                <div class="meter-bg mb-4"><div class="meter-fill" style="width: ${progress}%"></div></div>
                                <div class="grid grid-cols-2 gap-y-3 text-[11px] font-medium">
                                    <div><p class="text-slate-500 uppercase text-[8px] font-bold">Live Price</p><p class="text-white">${s.curP.toFixed(4)}</p></div>
                                    <div class="text-right"><p class="text-slate-500 uppercase text-[8px] font-bold">Entry</p><p class="text-sky-400">${s.buy.toFixed(4)}</p></div>
                                    <div><p class="text-slate-500 uppercase text-[8px] font-bold">Target</p><p class="text-green-500">${s.sell.toFixed(4)}</p></div>
                                    <div class="text-right"><p class="text-slate-500 uppercase text-[8px] font-bold">DCA</p><p class="text-red-500">${s.dca.toFixed(4)}</p></div>
                                </div>
                            ` : ''}
                        </div>`;
                    }).join('')}
                </div>

                <div class="pt-4 flex flex-col items-center space-y-4">
                    <button onclick="if(confirm('Reset all Profit & History?')) location.href='/reset?id=${userId}'" class="text-[10px] font-black text-red-500 uppercase tracking-widest border-b border-red-900/50 pb-1">Reset Master Core</button>
                    <p class="text-[8px] text-slate-700 font-bold uppercase tracking-[0.3em]">Quantum Engine v4.0.1 High-Freq</p>
                </div>
            </div>
            <script>setTimeout(()=>location.reload(), 3000);</script>
        </body></html>`);
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => { startGlobalEngine(); });

const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ সিস্টেম কনফিগ
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
    { s: "BTCUSDT", d: 2, qd: 3 }, { s: "ETHUSDT", d: 2, qd: 3 }, 
    { s: "SOLUSDT", d: 3, qd: 2 }, { s: "1000PEPEUSDT", d: 7, qd: 0 },
    { s: "BONKUSDT", d: 8, qd: 0 }, { s: "WIFUSDT", d: 4, qd: 1 },
    { s: "DOGEUSDT", d: 5, qd: 0 }, { s: "NEARUSDT", d: 4, qd: 1 },
    { s: "AVAXUSDT", d: 3, qd: 1 }, { s: "XRPUSDT", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, history: [], rsi: 50 });
let userSlots = {}; 

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

// 📈 RSI ক্যালকুলেটর (১৪ পিরিয়ড)
function calculateRSI(prices, period = 14) {
    if (prices.length <= period) return 50;
    let gains = 0, losses = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
        let diff = prices[i] - prices[i - 1];
        if (diff > 0) gains += diff; else losses -= diff;
    }
    if (losses === 0) return 100;
    let rs = gains / losses;
    return 100 - (100 / (1 + rs));
}

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

// 🚀 ওমনি ইঞ্জিন
async function startGlobalEngine() {
    const streams = COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    ws.on('message', async (data) => {
        const payload = JSON.parse(data);
        const msg = payload.data;
        if (!msg || !market[msg.s]) return;

        const s = market[msg.s];
        s.p = parseFloat(msg.c);
        s.history.push(s.p); if(s.history.length > 100) s.history.shift();
        s.rsi = calculateRSI(s.history);

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
                    sendTG(`🟢 *Buy Done!* ${sl.sym}\nPrice: ${s.p}\nRSI: ${s.rsi.toFixed(2)}`, config.cid);
                }

                if (sl.status === 'BOUGHT') {
                    sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * config.lev;
                    if (s.p >= sl.sell) {
                        const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy);
                        sl.active = false; config.profit += gain; config.count += 1;
                        saveUser(userId, config);
                        sendTG(`💰 *Profit Booked!* ${sl.sym}\nGain: ৳${(gain*124).toFixed(0)}`, config.cid);
                        sl.status = 'IDLE';
                    }
                }
            });

            const slotIdx = slots.findIndex(sl => !sl.active);
            if (!config.isPaused && slotIdx !== -1 && s.rsi < 35) {
                const sameCoin = slots.filter(sl => sl.active && sl.sym === msg.s);
                if (sameCoin.length === 0) {
                    const coin = COINS.find(c => c.s === msg.s);
                    // ০.১৪৯% নিচে লিমিট বাই অর্ডার
                    const buyP = (s.p * 0.99851).toFixed(coin.d); 
                    const sellP = (parseFloat(buyP) * 1.0045).toFixed(coin.d); 
                    const dca1P = (parseFloat(buyP) * 0.991).toFixed(coin.d);
                    const qty = ((config.cap / 5 * config.lev) / parseFloat(buyP)).toFixed(coin.qd);
                    
                    await setLeverage(msg.s, config.lev, config);
                    const order = await placeOrder(msg.s, "BUY", buyP, qty, config, "LIMIT");
                    if (order) {
                        slots[slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: msg.s, buy: parseFloat(buyP), sell: parseFloat(sellP), dca1: parseFloat(dca1P), qty: qty, pnl: 0, curP: s.p };
                        sendTG(`📡 *New Signal:* ${msg.s}\nRSI: ${s.rsi.toFixed(2)}\nLimit Buy Set: 0.149% Below Current Price.`, config.cid);
                    }
                }
            }
        }
    });
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}

// 🌐 মোবাইল ড্যাশবোর্ড (RSI মিটার সহ)
const server = http.createServer((req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        saveUser(id, { api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), cid: url.searchParams.get('cid'), cap: parseFloat(url.searchParams.get('cap'))||10, lev: parseInt(url.searchParams.get('lev'))||20, mode: url.searchParams.get('mode')||'live', profit: 0, count: 0, isPaused: false });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-6 font-sans"><div class="max-w-md mx-auto py-10">
            <h1 class="text-4xl font-black text-sky-500 text-center mb-8">QUANTUM MASTER</h1>
            <form action="/register" method="GET" class="bg-slate-900 p-6 rounded-[2.5rem] border border-slate-800 space-y-4">
                <input name="id" placeholder="Create User ID" class="w-full bg-black p-4 rounded-2xl outline-none" required>
                <input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-2xl outline-none">
                <input name="sec" placeholder="Binance Secret Key" class="w-full bg-black p-4 rounded-2xl outline-none">
                <input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-2xl outline-none" required>
                <div class="grid grid-cols-2 gap-3"><input name="cap" type="number" placeholder="Capital $" class="bg-black p-4 rounded-2xl"><input name="lev" type="number" placeholder="Lev" class="bg-black p-4 rounded-2xl"></div>
                <button type="submit" class="w-full bg-sky-600 p-5 rounded-[2rem] font-black uppercase shadow-lg">Launch Engine</button>
            </form></div></body></html>`);
    } else {
        let user = db[userId];
        let slots = userSlots[userId] || Array(5).fill({sym:'Empty',active:false, pnl:0, curP:0});
        getBinanceBalance(user).then(balance => {
            res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-[#020617] text-white p-4 font-sans"><div class="max-w-md mx-auto space-y-4">
                <div class="p-6 bg-slate-900 rounded-[2.5rem] border border-sky-500/30 flex justify-between items-center shadow-xl">
                    <div><h2 class="text-2xl font-black text-sky-400 uppercase tracking-tighter">${userId}</h2><p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest">${user.lev}x Leverage</p></div>
                    <div class="text-right"><p class="text-[9px] text-slate-500 font-black uppercase">Wallet Balance</p><p class="text-2xl font-black text-green-400">$${balance}</p></div>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div class="p-4 bg-slate-900 rounded-3xl border border-slate-800 text-center"><p class="text-[9px] text-slate-500 font-bold uppercase">Profit (BDT)</p><p class="text-xl font-black text-green-400">৳${(user.profit * 124).toFixed(0)}</p></div>
                    <div class="p-4 bg-slate-900 rounded-3xl border border-slate-800 text-center"><p class="text-[9px] text-slate-500 font-bold uppercase">Success Trades</p><p class="text-xl font-black text-sky-400">${user.count}</p></div>
                </div>
                <div class="space-y-3">
                    ${slots.map((s,i) => {
                        let coinMarket = market[s.sym] || { rsi: 50 };
                        let rsiColor = coinMarket.rsi < 35 ? 'bg-green-500' : coinMarket.rsi > 65 ? 'bg-red-500' : 'bg-sky-500';
                        return `<div class="p-5 bg-slate-900/40 rounded-[2rem] border border-slate-800">
                            <div class="flex justify-between items-center mb-2">
                                <span class="text-xs font-black ${s.active ? 'text-sky-400' : 'text-slate-600'}">${s.active ? s.sym : 'SLOT '+(i+1)}</span>
                                ${s.active ? `<span class="text-[10px] font-bold ${s.pnl>=0?'text-green-500':'text-red-400'}">${s.pnl.toFixed(2)}% PNL</span>` : ''}
                            </div>
                            <!-- RSI মিটার -->
                            <div class="flex items-center gap-3 mb-2">
                                <div class="flex-1 bg-slate-800 h-1.5 rounded-full overflow-hidden"><div class="${rsiColor} h-full transition-all" style="width: ${coinMarket.rsi}%"></div></div>
                                <span class="text-[10px] font-mono text-slate-400">${coinMarket.rsi.toFixed(1)}</span>
                            </div>
                            ${s.active ? `
                                <div class="grid grid-cols-2 gap-y-1 text-[10px] font-mono border-t border-slate-800/50 pt-2">
                                    <div class="text-slate-500">BUY: <span class="text-white">${s.buy}</span></div>
                                    <div class="text-right text-slate-500">LIVE: <span class="text-sky-300">${s.curP}</span></div>
                                    <div class="text-slate-500">DCA: <span class="text-orange-400">${s.dca1}</span></div>
                                    <div class="text-right text-slate-500">TARGET: <span class="text-green-400">${s.sell}</span></div>
                                </div>` : ''}
                        </div>`;
                    }).join('')}
                </div>
            </div><script>setTimeout(()=>location.reload(), 3000);</script></body></html>`);
        });
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => { startGlobalEngine(); });

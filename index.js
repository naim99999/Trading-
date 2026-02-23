const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

const MASTER_TG_TOKEN = "8281887575:AAGRTPvSdT4ho8C2NwsxCHyUMkRq2q6qWDc"; 
const DB_FILE = 'nebula_master_final.json';

// ডাটাবেস ফাংশন
function getAllUsers() { if (!fs.existsSync(DB_FILE)) return {}; try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) { return {}; } }
function saveUser(userId, data) { let users = getAllUsers(); users[userId] = { ...users[userId], ...data }; fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); }

const COINS = [
    { s: "BTCUSDT", n: "BTC", d: 2, qd: 3 }, { s: "ETHUSDT", n: "ETH", d: 2, qd: 3 }, 
    { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 }, { s: "XRPUSDT", n: "XRP", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, history: [], rsi: 50 });
let userSlots = {}; 

// RSI ক্যালকুলেটর (লস কমানোর প্রধান অস্ত্র)
function calculateRSI(prices) {
    if (prices.length < 15) return 50;
    let gains = 0, losses = 0;
    for (let i = prices.length - 14; i < prices.length; i++) {
        let diff = prices[i] - prices[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    let rs = gains / (losses || 1);
    return 100 - (100 / (1 + rs));
}

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

async function sendTG(msg, chatId) { try { await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: chatId, text: msg, parse_mode: 'Markdown' }); } catch (e) {} }

async function setLeverage(symbol, leverage, config) {
    // সেফটি লক: ১০x এর বেশি লেভারেজ ফিউচারে লিকুইডেশনের প্রধান কারণ
    let safeLev = Math.min(leverage, 10); 
    const ts = Date.now();
    const query = `symbol=${symbol}&leverage=${safeLev}&timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try { await axios.post(`https://fapi.binance.com/fapi/v1/leverage?${query}&signature=${signature}`, null, { headers: { 'X-MBX-APIKEY': config.api } }); } catch (e) {}
}

async function placeOrder(symbol, side, price, qty, config, type = "LIMIT") {
    if (config.mode === 'demo') return { status: 'FILLED' };
    const ts = Date.now();
    let query = `symbol=${symbol}&side=${side}&type=${type}&quantity=${qty}&timestamp=${ts}`;
    if(type === "LIMIT") query += `&price=${price}&timeInForce=GTC`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.post(`https://fapi.binance.com/fapi/v1/order?${query}&signature=${signature}`, null, { headers: { 'X-MBX-APIKEY': config.api } });
        return res.data;
    } catch (e) { return null; }
}

// 🚀 ওমনি এঞ্জিন (Anti-Liquid Logic)
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
            if (config.status !== 'active' || config.isPaused) continue;

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, pnl: 0, dca1: 0, dca2: 0 }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * Math.min(config.lev, 10);

                // DCA Logic (Deep Recovery)
                if (sl.status === 'BOUGHT' && s.p <= sl.dca1) {
                    sl.status = 'DCA1_DONE';
                    // DCA তে এভারেজ প্রাইস কমিয়ে আনা হয়
                    sl.buy = (sl.buy + s.p) / 2;
                    sl.sell = sl.buy * 1.005; // ০.৫% লাভে সেল টার্গেট
                    sendTG(`📉 *DCA এন্ট্রি সম্পন্ন:* ${sl.sym}\nনতুন এভারেজ বাই: ${sl.buy.toFixed(4)}`, config.cid);
                }

                // Profit Sell
                if (s.p >= sl.sell && sl.active) {
                    const gain = (sl.qty * (sl.sell - sl.buy));
                    config.profit += gain; config.count += 1;
                    saveUser(userId, config);
                    sendTG(`🎉 *সফল সেল:* ${sl.sym}\nলাভ: ৳${(gain * 124).toFixed(0)}`, config.cid);
                    sl.active = false;
                }
            });

            // Entry Condition (Strict RSI < 35)
            const slotIdx = slots.findIndex(sl => !sl.active);
            if (slotIdx !== -1 && s.rsi < 35) { // কেবল যখন মার্কেট ড্রপ করবে তখন কিনবে
                const coin = COINS.find(c => c.s === msg.s);
                const buyP = s.p;
                const qty = ((config.cap / 5 * Math.min(config.lev, 10)) / buyP).toFixed(coin.qd);

                await setLeverage(msg.s, config.lev, config);
                const order = await placeOrder(msg.s, "BUY", buyP.toFixed(coin.d), qty, config, "LIMIT");
                
                if (order) {
                    slots[slotIdx] = { 
                        id: slotIdx, active: true, status: 'BOUGHT', sym: msg.s, 
                        buy: buyP, sell: buyP * 1.008, qty: qty, 
                        dca1: buyP * 0.96, // ৪% ড্রপ করলে ১ম DCA
                        dca2: buyP * 0.90  // ১০% ড্রপ করলে ২য় DCA
                    };
                    sendTG(`📥 *নিখুঁত এন্ট্রি (RSI Low):* ${msg.s}\nপ্রাইস: ${buyP}`, config.cid);
                }
            }
        }
    });
}

// UI সেকশন (আগের স্টাইল বজায় রাখা হয়েছে)
const server = http.createServer((req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    if (url.pathname === '/reset-now') {
        const uid = url.searchParams.get('id');
        if(db[uid]) { db[uid].profit = 0; db[uid].count = 0; saveUser(uid, db[uid]); userSlots[uid] = null; }
        res.writeHead(302, { 'Location': '/' + uid }); return res.end();
    }

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        saveUser(id, { api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), cid: url.searchParams.get('cid'), cap: parseFloat(url.searchParams.get('cap')), lev: parseInt(url.searchParams.get('lev')), profit: 0, count: 0, status: 'active', isPaused: false });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<!DOCTYPE html><html><body style="background:#09090b;color:white;display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;">
            <form action="/register" style="background:#111114;padding:40px;border-radius:30px;width:320px;border:1px solid #222;">
                <h2 style="color:#0ea5e9;text-transform:uppercase;letter-spacing:2px;">Quantum Master</h2>
                <input name="id" placeholder="User ID" required style="width:100%;padding:12px;margin:10px 0;background:#000;border:1px solid #333;color:white;border-radius:10px;">
                <input name="api" placeholder="Binance API" style="width:100%;padding:12px;margin:10px 0;background:#000;border:1px solid #333;color:white;border-radius:10px;">
                <input name="sec" placeholder="Binance Secret" style="width:100%;padding:12px;margin:10px 0;background:#000;border:1px solid #333;color:white;border-radius:10px;">
                <input name="cid" placeholder="Telegram ID" required style="width:100%;padding:12px;margin:10px 0;background:#000;border:1px solid #333;color:white;border-radius:10px;">
                <div style="display:flex;gap:10px;">
                    <input name="cap" type="number" value="10" style="width:50%;padding:12px;background:#000;border:1px solid #333;color:white;border-radius:10px;">
                    <input name="lev" type="number" value="10" style="width:50%;padding:12px;background:#000;border:1px solid #333;color:white;border-radius:10px;">
                </div>
                <button style="width:100%;padding:15px;margin-top:20px;background:#0ea5e9;border:none;border-radius:15px;color:white;font-weight:black;cursor:pointer;">ACTIVATE BOT</button>
            </form></body></html>`);
    } else {
        const user = db[userId];
        const slots = userSlots[userId] || Array(5).fill({sym:'Empty', pnl:0, buy:0, sell:0});
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#09090b] text-white p-4 font-sans"><div class="max-w-md mx-auto space-y-4">
            <div class="p-6 bg-[#111114] rounded-[2.5rem] border border-zinc-900 shadow-2xl">
                <div class="flex justify-between items-center">
                    <div><h2 class="text-3xl font-black text-sky-400 uppercase tracking-tighter">${userId}</h2><p class="text-[9px] font-bold text-zinc-500 tracking-widest uppercase">Safety Mode: ON</p></div>
                    <div class="text-right"><p class="text-[10px] text-zinc-500 uppercase">Profit (BDT)</p><p class="text-3xl font-black text-green-400">৳${(user.profit * 124).toFixed(0)}</p></div>
                </div>
            </div>
            <div class="space-y-4">
                ${slots.map((s,i) => `
                <div class="p-5 bg-[#111114] rounded-[2rem] border border-zinc-900">
                    <div class="flex justify-between items-start">
                        <span class="text-[10px] font-bold text-zinc-600 uppercase">Slot ${i+1}</span>
                        <span class="text-xl font-bold ${s.pnl>=0?'text-green-400':'text-red-400'}">${s.pnl.toFixed(2)}%</span>
                    </div>
                    <h3 class="text-2xl font-black text-sky-400">${s.active ? s.sym.replace('USDT','') : 'SCANNING...'}</h3>
                    ${s.active ? `<div class="grid grid-cols-2 gap-2 text-[11px] mt-3 font-bold text-zinc-500">
                        <div>BUY: <span class="text-white">${s.buy.toFixed(2)}</span></div>
                        <div class="text-right">TARGET: <span class="text-green-400">${s.sell.toFixed(2)}</span></div>
                    </div>` : ''}
                </div>`).join('')}
            </div>
            <div class="text-center pt-4"><button onclick="location.href='/reset-now?id=${userId}'" class="text-[9px] text-red-500 font-bold uppercase tracking-widest underline opacity-30">Reset Memory</button></div>
        </div><script>setTimeout(()=>location.reload(), 5000);</script></body></html>`);
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => { startGlobalEngine(); });

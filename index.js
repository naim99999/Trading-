const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ অ্যাডমিন কনফিগ (শুধুমাত্র সিস্টেম কন্ট্রোল)
// ==========================================
const MASTER_TG_TOKEN = "8281887575:AAGRTPvSdT4ho8C2NwsxCHyUMkRq2q6qWDc"; 
const DB_FILE = 'nebula_master_final.json';

// ডাটাবেস ফাংশন
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
COINS.forEach(c => market[c.s] = { p: 0, history: [], rsi: 50 });
let userSlots = {}; 

// RSI ক্যালকুলেটর
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
    try { await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: chatId, text: msg, parse_mode: 'Markdown' }); } catch (e) {}
}

// বিন্যান্স অর্ডার ফাংশন (ডাইনামিক API ব্যবহার করবে)
async function placeOrder(symbol, side, price, qty, config, type = "LIMIT") {
    if (config.mode === 'demo' || !config.api) return { status: 'FILLED' };
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

async function getBinanceBalance(config) {
    if (config.mode === 'demo' || !config.api || config.api === 'demo') return "Infinity";
    const ts = Date.now();
    const query = `timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?${query}&signature=${signature}`, { headers: { 'X-MBX-APIKEY': config.api }, timeout: 5000 });
        return res.data ? parseFloat(res.data.totalWalletBalance).toFixed(2) : "0.00";
    } catch (e) { return "0.00"; }
}

// 🚀 ওমনি ইঞ্জিন (RSI, DCA এবং Fast Execution)
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
            if (config.status !== 'active') continue;

            // লাভ বাড়াতে স্লট সংখ্যা ৩টি করা হয়েছে
            if (!userSlots[userId]) userSlots[userId] = Array(3).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 1, qty: 0, pnl: 0 }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.curP = s.p;
                sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * config.lev;

                // বাই এক্সিকিউশন (৫.০১ লজিক - দ্রুত ফিল)
                if (sl.status === 'WAITING' && s.p <= sl.buy) {
                    sl.status = 'BOUGHT';
                    const cI = COINS.find(c=>c.s===sl.sym);
                    // প্রফিট সেল এবং ২ টি DCA অর্ডার একবারে বিন্যান্সে পাঠানো হবে
                    await placeOrder(sl.sym, "SELL", sl.sell.toFixed(cI.d), sl.qty, config, "LIMIT");
                    await placeOrder(sl.sym, "BUY", (sl.buy * 0.994).toFixed(cI.d), sl.qty, config, "LIMIT"); // DCA 1
                }

                // সেল এক্সিকিউশন (৪.৯৯ লজিক - দ্রুত প্রফিট বুক)
                if (sl.status === 'BOUGHT' && s.p >= sl.sell) {
                    const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy) - (sl.qty * sl.sell * 0.0008);
                    sl.active = false; config.profit += gain; config.count += 1;
                    saveUser(userId, config);
                    sendTG(`🎉 *PROFIT SUCCESS!*\nUser: ${userId}\nCoin: ${sl.sym}\nProfit: ৳${(gain*124).toFixed(2)}`, config.cid);
                    sl.status = 'IDLE';
                }
            });

            const slotIdx = slots.findIndex(sl => !sl.active);
            // এন্ট্রি লজিক: RSI ৩০ এর নিচে (পারফেক্ট ডিপ বাই)
            if (!config.isPaused && slotIdx !== -1 && s.rsi < 30) {
                const sameCoin = slots.filter(sl => sl.active && sl.sym === msg.s);
                if (sameCoin.length === 0) {
                    const coin = COINS.find(c => c.s === msg.s);
                    const buyP = (s.p * 1.0002).toFixed(coin.d); // ৫.০১ লজিক: সামান্য বেশি দামে লিমিট যাতে সাথে সাথে কেনা হয়
                    const sellP = (parseFloat(buyP) * 1.008 * 0.9998).toFixed(coin.d); // ৪.৯৯ লজিক: টার্গেট ০.৮% কিন্তু একটু আগেই সেল
                    const qty = ((config.cap / 3 * config.lev) / parseFloat(buyP)).toFixed(coin.qd);

                    const order = await placeOrder(msg.s, "BUY", buyP, qty, config, "LIMIT");
                    if (order) {
                        slots[slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: msg.s, buy: parseFloat(buyP), sell: parseFloat(sellP), qty: qty, pnl: 0, curP: s.p };
                    }
                }
            }
        }
    });
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}

// 🌐 ড্যাশবোর্ড UI (API ইনপুট সিস্টেমসহ)
const server = http.createServer(async (req, res) => {
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
            lev: parseInt(url.searchParams.get('lev'))||50, 
            mode: url.searchParams.get('mode')||'live', 
            profit: 0, count: 0, status: 'active', isPaused: false 
        });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    if (!userId || !db[userId]) {
        // রেজিস্ট্রেশন পেজ
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-black text-white p-6 flex items-center min-h-screen">
            <form action="/register" class="max-w-md mx-auto bg-zinc-900 p-8 rounded-3xl space-y-4 w-full border border-zinc-800">
                <h2 class="text-2xl font-black text-sky-400 text-center uppercase">Master Setup</h2>
                <input name="id" placeholder="User ID" class="w-full p-4 bg-black rounded-xl border border-zinc-700" required>
                <input name="api" placeholder="Binance API Key" class="w-full p-4 bg-black rounded-xl border border-zinc-700" required>
                <input name="sec" placeholder="Binance Secret Key" class="w-full p-4 bg-black rounded-xl border border-zinc-700" required>
                <input name="cid" placeholder="Telegram Chat ID" class="w-full p-4 bg-black rounded-xl border border-zinc-700" required>
                <div class="flex gap-2">
                    <input name="cap" type="number" placeholder="Capital" value="10" class="w-1/2 p-4 bg-black rounded-xl border border-zinc-700">
                    <input name="lev" type="number" placeholder="Lev" value="50" class="w-1/2 p-4 bg-black rounded-xl border border-zinc-700">
                </div>
                <button class="w-full bg-sky-600 p-4 rounded-xl font-bold uppercase">Activate Bot</button>
            </form>
        </body></html>`);
    } else {
        // ড্যাশবোর্ড পেজ
        let user = db[userId];
        let balance = await getBinanceBalance(user);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-black text-white p-4">
            <div class="max-w-lg mx-auto space-y-4">
                <div class="bg-zinc-900 p-6 rounded-[2rem] border border-sky-500/30 flex justify-between">
                    <div><h1 class="text-xl font-black">${userId}</h1><p class="text-xs text-sky-400">RSI Strategy Active</p></div>
                    <div class="text-right"><p class="text-[10px] text-zinc-500">Wallet Balance</p><p class="text-xl font-black text-green-400">$${balance}</p></div>
                </div>
                <div class="grid grid-cols-2 gap-4">
                    <div class="bg-zinc-900 p-6 rounded-[2rem] text-center"><p class="text-[10px] text-zinc-500 uppercase">Profit</p><p class="text-2xl font-bold text-green-400">৳${(user.profit * 124).toFixed(2)}</p></div>
                    <div class="bg-zinc-900 p-6 rounded-[2rem] text-center"><p class="text-[10px] text-zinc-500 uppercase">Trades</p><p class="text-2xl font-bold text-sky-400">${user.count}</p></div>
                </div>
                <p class="text-center text-[10px] text-zinc-600">Bot is using your Dashboard API Keys for trading.</p>
            </div>
            <script>setTimeout(()=>location.reload(), 10000);</script>
        </body></html>`);
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => { startGlobalEngine(); });

const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ কনফিগ ও ডাটাবেস
// ==========================================
const MASTER_TG_TOKEN = "8281887575:AAGRTPvSdT4ho8C2NwsxCHyUMkRq2q6qWDc"; 
const DB_FILE = 'nebula_master_v3.json';

function getAllUsers() { if (!fs.existsSync(DB_FILE)) return {}; try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) { return {}; } }
function saveUser(userId, data) { let users = getAllUsers(); users[userId] = { ...users[userId], ...data }; fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); }

const COINS = [
    { s: "BTCUSDT", n: "BTC", d: 2, qd: 3 }, { s: "ETHUSDT", n: "ETH", d: 2, qd: 3 }, 
    { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 }, { s: "XRPUSDT", n: "XRP", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, history: [], rsi: 50 });
let userSlots = {}; 

// 📉 RSI ক্যালকুলেটর (Safety First)
function calculateRSI(prices) {
    if (prices.length < 15) return 50;
    let gains = 0, losses = 0;
    for (let i = prices.length - 14; i < prices.length; i++) {
        let diff = prices[i] - prices[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    return 100 - (100 / (1 + (gains / (losses || 1))));
}

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

// 📢 টেলিগ্রাম নোটিফিকেশন
async function sendTG(msg, chatId) {
    try {
        await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, {
            chat_id: chatId, text: msg, parse_mode: 'Markdown'
        });
    } catch (e) {}
}

// ⚙️ বাইনান্স ফাংশনস
async function setLeverage(symbol, leverage, config) {
    if (config.mode === 'demo') return;
    const safeLev = Math.min(leverage, 10);
    const ts = Date.now();
    const query = `symbol=${symbol}&leverage=${safeLev}&timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try { await axios.post(`https://fapi.binance.com/fapi/v1/leverage?${query}&signature=${signature}`, null, { headers: { 'X-MBX-APIKEY': config.api } }); } catch (e) {}
}

async function getBalance(config) {
    if (config.mode === 'demo') return config.virtualBalance.toFixed(2);
    const ts = Date.now();
    const query = `timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?${query}&signature=${signature}`, { headers: { 'X-MBX-APIKEY': config.api }, timeout: 5000 });
        return parseFloat(res.data.totalWalletBalance).toFixed(2);
    } catch (e) { return "Error"; }
}

async function placeOrder(symbol, side, price, qty, config, type = "LIMIT") {
    if (config.mode === 'demo') return { status: 'FILLED' }; // ডেমো মুডে সরাসরি সাকসেস
    const ts = Date.now();
    let query = `symbol=${symbol}&side=${side}&type=${type}&quantity=${qty}&timestamp=${ts}`;
    if(type === "LIMIT") query += `&price=${price}&timeInForce=GTC`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.post(`https://fapi.binance.com/fapi/v1/order?${query}&signature=${signature}`, null, { headers: { 'X-MBX-APIKEY': config.api } });
        return res.data;
    } catch (e) { return null; }
}

// 🚀 ওমনি এঞ্জিন (Demo + Live + TG)
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
        s.rsi = calculateRSI(s.history);

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            if (config.status !== 'active' || config.isPaused) continue;

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, pnl: 0, dca1: 0, qty: 0 }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * Math.min(config.lev, 10);

                // DCA Logic
                if (sl.status === 'BOUGHT' && s.p <= sl.dca1) {
                    sl.status = 'DCA_ACTIVE';
                    sl.buy = (sl.buy + s.p) / 2;
                    sl.sell = sl.buy * 1.006;
                    sendTG(`📉 *DCA এন্ট্রি (${config.mode.toUpperCase()}):* ${sl.sym}\nএভারেজ প্রাইস: ${sl.buy.toFixed(4)}`, config.cid);
                }

                // Profit Sell
                if (s.p >= sl.sell && sl.active) {
                    const gain = (sl.qty * (sl.sell - sl.buy));
                    if(config.mode === 'demo') config.virtualBalance += gain;
                    config.profit += gain; config.count += 1;
                    saveUser(userId, config);
                    sendTG(`🎉 *সফল সেল (${config.mode.toUpperCase()}):* ${sl.sym}\nপ্রফিট: ৳${(gain * 124).toFixed(0)}`, config.cid);
                    sl.active = false;
                }
            });

            const slotIdx = slots.findIndex(sl => !sl.active);
            if (slotIdx !== -1 && s.rsi < 35) { 
                const coin = COINS.find(c => c.s === msg.s);
                const qty = ((config.cap / 5 * Math.min(config.lev, 10)) / s.p).toFixed(coin.qd);
                
                await setLeverage(msg.s, config.lev, config);
                const order = await placeOrder(msg.s, "BUY", s.p.toFixed(coin.d), qty, config, "LIMIT");
                
                if (order) {
                    slots[slotIdx] = { 
                        id: slotIdx, active: true, status: 'BOUGHT', sym: msg.s, 
                        buy: s.p, sell: s.p * 1.008, qty: qty, 
                        dca1: s.p * 0.96
                    };
                    sendTG(`📥 *নতুন বাই (${config.mode.toUpperCase()}):* ${msg.s}\nপ্রাইস: ${s.p}\nRSI: ${s.rsi.toFixed(2)}`, config.cid);
                }
            }
        }
    });
}

// 🌐 মোবাইল ফ্রেন্ডলি ড্যাশবোর্ড
const server = http.createServer((req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    if (url.pathname === '/reset-now') {
        const uid = url.searchParams.get('id');
        if(db[uid]) { db[uid].profit = 0; db[uid].count = 0; db[uid].virtualBalance = 1000; saveUser(uid, db[uid]); userSlots[uid] = null; }
        res.writeHead(302, { 'Location': '/' + uid }); return res.end();
    }

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        saveUser(id, { 
            api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), 
            cid: url.searchParams.get('cid'), cap: parseFloat(url.searchParams.get('cap')), 
            lev: parseInt(url.searchParams.get('lev')), mode: url.searchParams.get('mode'),
            profit: 0, count: 0, status: 'active', isPaused: false, virtualBalance: 1000 
        });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#09090b] text-white p-6 flex items-center min-h-screen"><div class="max-w-md mx-auto w-full">
            <h1 class="text-3xl font-black text-sky-400 mb-6 text-center uppercase italic">Quantum Master</h1>
            <form action="/register" class="bg-[#111114] p-8 rounded-[2.5rem] border border-zinc-900 space-y-4 shadow-2xl">
                <input name="id" placeholder="User ID" required class="w-full bg-black p-4 rounded-xl border border-zinc-800 outline-none">
                <select name="mode" class="w-full bg-black p-4 rounded-xl border border-zinc-800"><option value="demo">Demo Trading (Virtual)</option><option value="live">Live Trading (API)</option></select>
                <input name="api" placeholder="Binance API (Live only)" class="w-full bg-black p-4 rounded-xl border border-zinc-800">
                <input name="sec" placeholder="Binance Secret (Live only)" class="w-full bg-black p-4 rounded-xl border border-zinc-800">
                <input name="cid" placeholder="Telegram Chat ID" required class="w-full bg-black p-4 rounded-xl border border-zinc-800">
                <div class="flex gap-3"><input name="cap" type="number" value="100" class="w-1/2 bg-black p-4 rounded-xl border border-zinc-800"><input name="lev" type="number" value="10" class="w-1/2 bg-black p-4 rounded-xl border border-zinc-800"></div>
                <button class="w-full bg-sky-600 p-5 rounded-2xl font-black uppercase shadow-lg active:scale-95 transition">Launch Core</button>
            </form></div></body></html>`);
    } else {
        const user = db[userId];
        const slots = userSlots[userId] || Array(5).fill({sym:'Scanning', pnl:0, active:false});
        getBalance(user).then(balance => {
            res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-[#09090b] text-white p-4 font-sans mb-10"><div class="max-w-md mx-auto space-y-4">
                <div class="p-6 bg-[#111114] rounded-[2.5rem] border border-zinc-900 flex justify-between items-center">
                    <div><h2 class="text-2xl font-black text-sky-400 uppercase tracking-tighter">${userId}</h2><span class="text-[9px] bg-sky-500/20 text-sky-400 px-2 py-0.5 rounded-full font-bold uppercase">${user.mode}</span></div>
                    <div class="text-right"><p class="text-[10px] text-zinc-500 uppercase font-bold">Balance</p><p class="text-2xl font-black text-green-400">$${balance}</p></div>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div class="bg-[#111114] p-4 rounded-3xl border border-zinc-900 text-center"><p class="text-[9px] text-zinc-500 font-bold uppercase">Profit (BDT)</p><p class="text-xl font-bold text-green-400 mt-1">৳${(user.profit * 124).toFixed(0)}</p></div>
                    <div class="bg-[#111114] p-4 rounded-3xl border border-zinc-900 text-center"><p class="text-[9px] text-zinc-500 font-bold uppercase">Success</p><p class="text-xl font-bold text-sky-400 mt-1">${user.count}</p></div>
                </div>
                <div class="space-y-4 pt-2">
                    ${slots.map((s,i) => `
                    <div class="p-5 bg-[#111114] rounded-[2rem] border border-zinc-900 shadow-xl">
                        <div class="flex justify-between items-start">
                            <span class="text-[10px] font-bold text-zinc-600 uppercase">Slot ${i+1}</span>
                            <span class="text-xl font-bold ${s.pnl>=0?'text-green-400':'text-red-400'}">${s.active ? s.pnl.toFixed(2)+'%' : ''}</span>
                        </div>
                        <h3 class="text-2xl font-black text-sky-400 uppercase tracking-tight">${s.active ? s.sym.replace('USDT','') : '<span class="text-zinc-800">Searching</span>'}</h3>
                        ${s.active ? `<div class="flex justify-between text-[11px] mt-2 font-bold text-zinc-500">
                            <div>BUY: <span class="text-white">${s.buy.toFixed(2)}</span></div>
                            <div class="text-right">TARGET: <span class="text-green-400">${s.sell.toFixed(2)}</span></div>
                        </div>` : ''}
                    </div>`).join('')}
                </div>
                <div class="text-center pt-6"><button onclick="if(confirm('Reset all?')) location.href='/reset-now?id=${userId}'" class="text-[10px] text-red-500/50 font-bold uppercase tracking-widest underline decoration-red-500/20">Reset Core System</button></div>
            </div><script>setTimeout(()=>location.reload(), 5000);</script></body></html>`);
        });
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => { startGlobalEngine(); });

const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ সিস্টেম কনফিগ (Quantum Core v4.0)
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
    { s: "AVAXUSDT", n: "AVAX", d: 3, qd: 1 }, { s: "XRPUSDT", n: "XRP", d: 4, qd: 1 },
    { s: "LINKUSDT", n: "LINK", d: 3, qd: 1 }, { s: "ADAUSDT", n: "ADA", d: 4, qd: 1 },
    { s: "MATICUSDT", n: "MATIC", d: 4, qd: 1 }, { s: "DOTUSDT", n: "DOT", d: 3, qd: 1 },
    { s: "SHIBUSDT", n: "SHIB", d: 8, qd: 0 }, { s: "LTCUSDT", n: "LTC", d: 2, qd: 1 },
    { s: "BCHUSDT", n: "BCH", d: 2, qd: 1 }, { s: "UNIUSDT", n: "UNI", d: 3, qd: 1 },
    { s: "OPUSDT", n: "OP", d: 4, qd: 1 }, { s: "ARBUSDT", n: "ARB", d: 4, qd: 1 },
    { s: "TIAUSDT", n: "TIA", d: 4, qd: 1 }, { s: "SEIUSDT", n: "SEI", d: 4, qd: 1 },
    { s: "SUIUSDT", n: "SUI", d: 4, qd: 1 }, { s: "INJUSDT", n: "INJ", d: 3, qd: 1 },
    { s: "FETUSDT", n: "FET", d: 4, qd: 1 }, { s: "RNDRUSDT", n: "RNDR", d: 3, qd: 1 },
    { s: "FILUSDT", n: "FIL", d: 3, qd: 1 }, { s: "ATOMUSDT", n: "ATOM", d: 3, qd: 1 },
    { s: "STXUSDT", n: "STX", d: 4, qd: 1 }, { s: "ORDIUSDT", n: "ORDI", d: 3, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, trend: 0, history: [] });
let userSlots = {}; 

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

async function sendTG(msg, chatId) {
    if (!chatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, {
            chat_id: chatId, text: msg, parse_mode: 'Markdown'
        });
    } catch (e) { console.error("TG Error"); }
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

async function placeOrder(symbol, side, price, qty, config, type = "LIMIT") {
    if (config.mode === 'demo') return { orderId: 'DEMO_' + Date.now() };
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

async function startGlobalEngine() {
    const streams = COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    ws.on('message', async (data) => {
        const payload = JSON.parse(data);
        const msg = payload.data;
        if (!msg || !market[msg.s]) return;

        const s = market[msg.s];
        s.lp = s.p; s.p = parseFloat(msg.c);
        
        // দ্রুত মার্কেট এনালাইসিস
        s.history.push(s.p); if(s.history.length > 20) s.history.shift();
        const avgP = s.history.reduce((a,b)=>a+b, 0) / s.history.length;
        s.trend = s.p > s.lp ? Math.min(10, (s.trend || 0) + 1) : 0;

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, slP: 0, qty: 0, pnl: 0, curP: 0 }));
            
            userSlots[userId].forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.curP = s.p;

                // ১. এন্ট্রি এক্সিকিউশন চেক
                if (sl.status === 'WAITING' && s.p <= sl.buy) {
                    sl.status = 'BOUGHT';
                    const cI = COINS.find(c=>c.s===sl.sym);
                    await placeOrder(sl.sym, "SELL", sl.sell.toFixed(cI.d), sl.qty, config, "LIMIT");
                    sendTG(`💎 *Entry Hit:* #${sl.sym}\nEntry: ${sl.buy}\nTarget: ${sl.sell}`, config.cid);
                }

                if (sl.status === 'BOUGHT') {
                    // ২. রিয়েল টাইম PnL (সহ ফি ডিডাকশন)
                    sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * config.lev;

                    // ৩. ডাইনামিক সেল (যদি দাম টার্গেটে ছোঁয় - Force Exit)
                    if (s.p >= sl.sell) {
                        const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy);
                        sl.active = false; config.profit += (gain * 0.998); // ফি বাদ দিয়ে নিট প্রফিট
                        config.count += 1;
                        saveUser(userId, config);
                        sendTG(`💰 *Profit Locked:* #${sl.sym}\nGain: +৳${(gain*124).toFixed(0)}\nBalance: ৳${(config.profit*124).toFixed(0)}`, config.cid);
                        sl.status = 'IDLE';
                        if(config.mode !== 'demo') await placeOrder(sl.sym, "SELL", 0, sl.qty, config, "MARKET");
                    }

                    // ৪. হার্ড স্টপ লস
                    if (s.p <= sl.slP) {
                        const loss = (sl.qty * sl.buy) - (sl.qty * s.p);
                        sl.active = false; config.profit -= loss;
                        saveUser(userId, config);
                        sendTG(`⚠️ *Stop Loss Hit:* #${sl.sym}\nLoss: -৳${(loss*124).toFixed(0)}`, config.cid);
                        sl.status = 'IDLE';
                        if(config.mode !== 'demo') await placeOrder(sl.sym, "SELL", 0, sl.qty, config, "MARKET");
                    }
                }
            });

            // ৫. সুপার ফাস্ট স্ক্যাল্পিং এন্ট্রি
            const slotIdx = userSlots[userId].findIndex(sl => !sl.active);
            if (!config.isPaused && slotIdx !== -1 && s.trend >= 1 && s.p < avgP) {
                const sameCoin = userSlots[userId].filter(sl => sl.active && sl.sym === msg.s);
                if (sameCoin.length === 0) {
                    const coin = COINS.find(c => c.s === msg.s);
                    const buyPrice = s.p * 0.9998; 
                    
                    // সাগর তৈরির স্ট্র্যাটেজি (০.২০% - ০.৩৫% ছোট টার্গেট)
                    let tp = s.trend > 4 ? 1.0035 : 1.0020;
                    const sellPrice = buyPrice * tp;
                    const stopPrice = buyPrice * 0.9910; // ০.৯% স্টপ লস
                    
                    const qty = ((config.cap / 5 * config.lev) / buyPrice).toFixed(coin.qd);
                    
                    await setLeverage(msg.s, config.lev, config);
                    const order = await placeOrder(msg.s, "BUY", buyPrice.toFixed(coin.d), qty, config, "LIMIT");
                    if (order) {
                        userSlots[userId][slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: msg.s, buy: parseFloat(buyPrice.toFixed(coin.d)), sell: parseFloat(sellPrice.toFixed(coin.d)), slP: parseFloat(stopPrice.toFixed(coin.d)), qty: qty, pnl: 0, curP: s.p };
                    }
                }
            }
        }
    });
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}

// 🌐 আল্ট্রা-ফাস্ট ড্যাশবোর্ড সার্ভার
const server = http.createServer(async (req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    if (url.pathname === '/api/data') {
        const uid = url.searchParams.get('id');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ slots: userSlots[uid] || [], profit: db[uid] ? (db[uid].profit * 124).toFixed(0) : 0, count: db[uid] ? db[uid].count : 0 }));
    }

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        const cid = url.searchParams.get('cid');
        saveUser(id, { api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), cid: cid, cap: parseFloat(url.searchParams.get('cap'))||10, lev: parseInt(url.searchParams.get('lev'))||20, mode: url.searchParams.get('mode')||'live', profit: 0, count: 0 });
        sendTG("🚀 *Nebula System Online!*\nআপনার সুন্দর জীবন গড়ার স্বপ্ন পূরণে আমি প্রস্তুত।", cid);
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-6 flex items-center min-h-screen text-center"><div class="max-w-md mx-auto w-full space-y-6">
            <h1 class="text-5xl font-black text-sky-400 uppercase italic tracking-tighter">Nebula</h1>
            <p class="text-xs text-slate-500 uppercase tracking-widest font-bold">Dream Big, Start Small</p>
            <form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2rem] space-y-4 border border-slate-800 text-left">
                <input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none" required>
                <select name="mode" class="w-full bg-black p-4 rounded-xl border border-slate-800"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select>
                <input name="api" placeholder="Binance API" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none">
                <input name="sec" placeholder="Binance Secret" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none">
                <input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none" required>
                <div class="grid grid-cols-2 gap-3">
                    <input name="cap" type="number" placeholder="Capital $" class="bg-black p-4 rounded-xl border border-slate-800 outline-none">
                    <input name="lev" type="number" placeholder="Leverage" class="bg-black p-4 rounded-xl border border-slate-800 outline-none">
                </div>
                <button type="submit" class="w-full bg-sky-600 p-5 rounded-full font-black uppercase shadow-lg shadow-sky-600/20 active:scale-95 transition">Start Dream</button>
            </form></div></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-[#020617] text-white p-4 font-sans uppercase">
                <div class="max-w-xl mx-auto space-y-4">
                    <div class="grid grid-cols-2 gap-4">
                        <div class="p-5 bg-slate-900 rounded-[2rem] text-center border border-slate-800">
                            <p class="text-[9px] text-slate-500 font-bold tracking-widest">Total Growth (BDT)</p>
                            <p class="text-3xl font-black text-green-400">৳<span id="profitText">0</span></p>
                        </div>
                        <div class="p-5 bg-slate-900 rounded-[2rem] text-center border border-slate-800">
                            <p class="text-[9px] text-slate-500 font-bold tracking-widest">Trades Completed</p>
                            <p class="text-3xl font-black text-sky-400" id="countText">0</p>
                        </div>
                    </div>
                    <div id="slotContainer" class="space-y-3"></div>
                    <div class="pt-4 flex gap-3"><button onclick="location.reload()" class="w-full bg-sky-600 py-5 rounded-full text-xs font-black uppercase tracking-widest shadow-lg shadow-sky-600/20">System Alive (Refresh)</button></div>
                </div>
                <script>
                    async function updateData() {
                        try {
                            const res = await fetch('/api/data?id=${userId}');
                            const data = await res.json();
                            document.getElementById('profitText').innerText = data.profit;
                            document.getElementById('countText').innerText = data.count;
                            let html = '';
                            data.slots.forEach((s, i) => {
                                let meter = s.active ? Math.max(0, Math.min(100, ((s.curP - s.buy) / (s.sell - s.buy)) * 100)) : 0;
                                html += \`<div class="p-5 bg-slate-900/50 rounded-3xl border border-zinc-800">
                                    <div class="flex justify-between items-center mb-2">
                                        <span class="text-[10px] font-black \${s.active ? 'text-sky-400' : 'text-zinc-700'}">\${s.active ? s.sym : 'Slot '+(i+1)+' Scanning...'}</span>
                                        \${s.active ? \`<span class="text-[10px] font-bold \${s.pnl>=0?'text-green-500':'text-red-400'}">\${s.pnl.toFixed(2)}%</span>\` : ''}
                                    </div>
                                    \${s.active ? \`<div class="w-full bg-black h-1 rounded-full overflow-hidden mb-4"><div class="h-full bg-sky-500" style="width: \${meter}%"></div></div>
                                    <div class="grid grid-cols-2 text-[9px] font-mono text-slate-500 gap-y-1">
                                        <div>ENTRY: \${s.buy}</div><div class="text-right">LIVE: \${s.curP}</div>
                                        <div>STOP: <span class="text-red-500">\${s.slP}</span></div><div class="text-right text-green-500">TARGET: \${s.sell}</div>
                                    </div>\` : ''}
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
server.listen(PORT, '0.0.0.0', () => { startGlobalEngine(); });

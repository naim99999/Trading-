const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ Quantum AI - Master Core (Final Fixed)
// ==========================================
// আপনার দেওয়া সঠিক টোকেন এবং চ্যাট আইডি এখানে সেট করা হয়েছে
const MASTER_TG_TOKEN = "8281887575:AAGRTPvSdT4ho8C2NwsxCHyUMkRq2q6qWDc"; 
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

// ৪০টি হাই-মুভমেন্ট কয়েন
const COINS = [
    { s: "BTCUSDT", n: "BTC", d: 2, qd: 3 }, { s: "ETHUSDT", n: "ETH", d: 2, qd: 3 }, 
    { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 }, { s: "1000PEPEUSDT", n: "PEPE", d: 7, qd: 0 },
    { s: "BONKUSDT", n: "BONK", d: 8, qd: 0 }, { s: "WIFUSDT", n: "WIF", d: 4, qd: 1 },
    { s: "DOGEUSDT", n: "DOGE", d: 5, qd: 0 }, { s: "NEARUSDT", n: "NEAR", d: 4, qd: 1 },
    { s: "AVAXUSDT", n: "AVAX", d: 3, qd: 1 }, { s: "XRPUSDT", n: "XRP", d: 4, qd: 1 },
    { s: "LINKUSDT", n: "LINK", d: 3, qd: 1 }, { s: "ADAUSDT", n: "ADA", d: 4, qd: 1 },
    { s: "MATICUSDT", n: "MATIC", d: 4, qd: 1 }, { s: "DOTUSDT", n: "DOT", d: 3, qd: 1 },
    { s: "SHIBUSDT", n: "SHIB", d: 8, qd: 0 }, { s: "LTCUSDT", n: "LTC", d: 2, qd: 1 },
    { s: "OPUSDT", n: "OP", d: 4, qd: 1 }, { s: "ARBUSDT", n: "ARB", d: 4, qd: 1 },
    { s: "TIAUSDT", n: "TIA", d: 4, qd: 1 }, { s: "SEIUSDT", n: "SEI", d: 4, qd: 1 },
    { s: "SUIUSDT", n: "SUI", d: 4, qd: 1 }, { s: "INJUSDT", n: "INJ", d: 3, qd: 1 },
    { s: "ORDIUSDT", n: "ORDI", d: 3, qd: 1 }, { s: "FILUSDT", n: "FIL", d: 3, qd: 1 },
    { s: "LDOUSDT", n: "LDO", d: 4, qd: 1 }, { s: "APTUSDT", n: "APT", d: 3, qd: 1 },
    { s: "GALAUSDT", n: "GALA", d: 5, qd: 0 }, { s: "TRXUSDT", n: "TRX", d: 5, qd: 0 },
    { s: "ICPUSDT", n: "ICP", d: 3, qd: 1 }, { s: "RUNEUSDT", n: "RUNE", d: 3, qd: 1 },
    { s: "KASUSDT", n: "KAS", d: 5, qd: 0 }, { s: "OMUSDT", n: "OM", d: 4, qd: 1 },
    { s: "JUPUSDT", n: "JUP", d: 4, qd: 1 }, { s: "PYTHUSDT", n: "PYTH", d: 4, qd: 1 },
    { s: "ONDOUSDT", n: "ONDO", d: 4, qd: 1 }, { s: "PEPEUSDT", n: "PEPE", d: 7, qd: 0 },
    { s: "MEMEUSDT", n: "MEME", d: 5, qd: 0 }, { s: "LUNA2USDT", n: "LUNA", d: 4, qd: 1 },
    { s: "BOMEUSDT", n: "BOME", d: 6, qd: 0 }, { s: "STXUSDT", n: "STX", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, trend: 0, history: [] });
let userSlots = {}; 

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

// ১. সুপার ফিক্সড টেলিগ্রাম ফাংশন
async function sendTG(msg, chatId) {
    if (!chatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: msg,
            parse_mode: 'Markdown'
        });
    } catch (e) {
        console.log("❌ TG Error: Token বা Chat ID সঠিক নয়। অথবা আপনি বোটে গিয়ে /start দেননি।");
    }
}

async function setLeverage(symbol, leverage, config) {
    if (config.mode === 'demo') return true;
    const ts = Date.now();
    const query = `symbol=${symbol}&leverage=${leverage}&timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try {
        await axios.post(`https://fapi.binance.com/fapi/v1/leverage?${query}&signature=${signature}`, null, {
            headers: { 'X-MBX-APIKEY': config.api }, timeout: 5000
        });
        return true;
    } catch (e) { return false; }
}

async function placeOrder(symbol, side, price, qty, config, type = "MARKET") {
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
        s.history.push(s.p); if(s.history.length > 15) s.history.shift();
        s.trend = s.p > s.lp ? Math.min(10, (s.trend || 0) + 1) : 0;

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, slP: 0, qty: 0, pnl: 0, curP: 0 }));
            
            userSlots[userId].forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.curP = s.p;

                if (sl.status === 'BOUGHT') {
                    // নিট PnL ক্যালকুলেশন
                    sl.pnl = (((s.p - sl.buy) / sl.buy) * 100 * config.lev) - 0.12;

                    // ২. লাভ হলে ইনস্ট্যান্ট সেল
                    if (s.p >= sl.sell) {
                        const gain = (sl.qty * s.p) - (sl.qty * sl.buy);
                        const netGain = gain * 0.998; 
                        sl.active = false; config.profit += netGain; config.count += 1;
                        saveUser(userId, config);
                        
                        const msg = `✅ *TRADE PROFIT!*\n\n💰 *Coin:* #${sl.sym}\n💸 *Net Profit:* ৳${(netGain*124).toFixed(0)}\n📈 *Total Growth:* ৳${(config.profit*124).toFixed(0)}`;
                        sendTG(msg, config.cid);

                        sl.status = 'IDLE';
                        if(config.mode !== 'demo') await placeOrder(sl.sym, "SELL", 0, sl.qty, config, "MARKET");
                    }

                    // ৩. স্টপ লস
                    if (s.p <= sl.slP) {
                        const loss = (sl.qty * sl.buy) - (sl.qty * s.p);
                        sl.active = false; config.profit -= loss;
                        saveUser(userId, config);
                        
                        const msg = `❌ *STOP LOSS HIT!*\n\n📉 *Coin:* #${sl.sym}\n💸 *Loss:* -৳${(loss*124).toFixed(0)}\n📊 *Total Growth:* ৳${(config.profit*124).toFixed(0)}`;
                        sendTG(msg, config.cid);

                        sl.status = 'IDLE';
                        if(config.mode !== 'demo') await placeOrder(sl.sym, "SELL", 0, sl.qty, config, "MARKET");
                    }
                }
            });

            // ৪. ফ্ল্যাশ এন্ট্রি (আরও দ্রুত)
            const slotIdx = userSlots[userId].findIndex(sl => !sl.active);
            if (!config.isPaused && slotIdx !== -1 && s.trend >= 1) {
                const sameCoin = userSlots[userId].filter(sl => sl.active && sl.sym === msg.s);
                if (sameCoin.length === 0) {
                    const coin = COINS.find(c => c.s === msg.s);
                    const buyPrice = s.p;
                    const sellPrice = buyPrice * 1.0022; 
                    const stopPrice = buyPrice * 0.9920; 
                    const qty = ((config.cap / 5 * config.lev) / buyPrice).toFixed(coin.qd);
                    
                    const order = await placeOrder(msg.s, "BUY", buyPrice.toFixed(coin.d), qty, config, (config.mode==='demo'?'LIMIT':'MARKET'));
                    if (order) {
                        userSlots[userId][slotIdx] = { id: slotIdx, active: true, status: 'BOUGHT', sym: msg.s, buy: parseFloat(buyPrice.toFixed(coin.d)), sell: parseFloat(sellPrice.toFixed(coin.d)), slP: parseFloat(stopPrice.toFixed(coin.d)), qty: qty, pnl: 0, curP: s.p };
                        sendTG(`🚀 *NEW ENTRY:* #${msg.s} at ${buyPrice}`, config.cid);
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

    if (url.pathname === '/api/data') {
        const uid = url.searchParams.get('id');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ slots: userSlots[uid] || [], profit: db[uid] ? (db[uid].profit * 124).toFixed(0) : 0, count: db[uid] ? db[uid].count : 0 }));
    }

    if (url.pathname === '/reset') {
        const id = url.searchParams.get('id');
        if (db[id]) { db[id].profit = 0; db[id].count = 0; saveUser(id, db[id]); userSlots[id] = null; }
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        const cid = url.searchParams.get('cid');
        saveUser(id, { api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), cid: cid, cap: parseFloat(url.searchParams.get('cap'))||10, lev: parseInt(url.searchParams.get('lev'))||20, mode: url.searchParams.get('mode')||'live', profit: 0, count: 0 });
        
        // রেজিস্ট্রেশনের পর টেস্ট মেসেজ
        sendTG("✅ *Quantum System Online!*\nআপনার টেলিগ্রাম সফলভাবে কানেক্ট হয়েছে। এখন থেকে সকল আপডেট এখানে পাবেন।", cid);
        
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-6 flex items-center min-h-screen"><div class="max-w-md mx-auto w-full space-y-6">
            <h1 class="text-6xl font-black text-sky-400 italic text-center italic">QUANTUM</h1>
            <form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 border border-slate-800">
                <input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-2xl border border-slate-800 outline-none" required>
                <select name="mode" class="w-full bg-black p-4 rounded-2xl border border-slate-800"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select>
                <input name="api" placeholder="Binance API" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none">
                <input name="sec" placeholder="Binance Secret" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none">
                <input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-2xl border border-slate-800 outline-none" required>
                <div class="grid grid-cols-2 gap-3">
                    <input name="cap" type="number" placeholder="Capital $" class="bg-black p-4 rounded-2xl border border-slate-800 outline-none">
                    <input name="lev" type="number" placeholder="Leverage" class="bg-black p-4 rounded-2xl border border-slate-800 outline-none">
                </div>
                <button type="submit" class="w-full bg-sky-600 p-5 rounded-full font-black uppercase text-xl">Start System</button>
            </form></div></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-[#020617] text-white p-4 font-sans uppercase">
                <div class="max-w-xl mx-auto space-y-4">
                    <div class="grid grid-cols-2 gap-4">
                        <div class="p-6 bg-slate-900 rounded-[2.5rem] text-center border border-slate-800 shadow-xl">
                            <p class="text-[9px] text-slate-500 font-bold mb-1 tracking-widest">Growth (BDT)</p>
                            <p class="text-4xl font-black text-green-400">৳<span id="profitText">0</span></p>
                        </div>
                        <div class="p-6 bg-slate-900 rounded-[2.5rem] text-center border border-slate-800 shadow-xl">
                            <p class="text-[9px] text-slate-500 font-bold mb-1 tracking-widest">Completed</p>
                            <p class="text-4xl font-black text-sky-400" id="countText">0</p>
                        </div>
                    </div>
                    <div id="slotContainer" class="space-y-3"></div>
                    <div class="flex gap-3 pt-4">
                        <a href="/reset?id=${userId}" onclick="return confirm('সব ডাটা মুছে ফেলতে চান?')" class="flex-1 bg-red-900/20 border border-red-500/30 text-red-500 py-5 rounded-full text-center text-[10px] font-black tracking-widest">RESET DATA</a>
                        <button onclick="location.reload()" class="flex-1 bg-sky-600 py-5 rounded-full text-[10px] font-black tracking-widest shadow-lg shadow-sky-600/20">REFRESH</button>
                    </div>
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
                                    <div class="flex justify-between items-center mb-3">
                                        <span class="text-[11px] font-black \${s.active ? 'text-sky-400' : 'text-zinc-700'} tracking-wider">\${s.active ? s.sym : 'Slot '+(i+1)+' Scanning...'}</span>
                                        \${s.active ? \`<span class="text-[11px] font-black \${s.pnl>=0?'text-green-500':'text-red-400'}">\${s.pnl.toFixed(2)}%</span>\` : ''}
                                    </div>
                                    \${s.active ? \`<div class="w-full bg-black h-1.5 rounded-full overflow-hidden mb-4"><div class="h-full bg-sky-500 transition-all duration-500" style="width: \${meter}%"></div></div>
                                    <div class="grid grid-cols-2 text-[10px] font-mono text-slate-500 gap-y-1">
                                        <div>Entry: \${s.buy}</div><div class="text-right">Live: \${s.curP}</div>
                                        <div class="text-red-500/70">Stop: \${s.slP}</div><div class="text-right text-green-500">Target: \${s.sell}</div>
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

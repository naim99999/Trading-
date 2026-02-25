const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ Quantum AI - Guardian v9.5 (Ultimate Fixed)
// ==========================================
const MASTER_TG_TOKEN = "8281887575:AAGRTPvSdT4ho8C2nwsxCHyUMkRq2q6qWDc"; 
const DB_FILE = 'nebula_master_final.json';
const FIXED_CHAT_ID = "5279510350"; 

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
    { s: "SUIUSDT", n: "SUI", d: 4, qd: 1 }, { s: "TIAUSDT", n: "TIA", d: 4, qd: 1 },
    { s: "FETUSDT", n: "FET", d: 4, qd: 1 }, { s: "RNDRUSDT", n: "RNDR", d: 3, qd: 1 },
    { s: "ORDIUSDT", n: "ORDI", d: 3, qd: 1 }, { s: "APTUSDT", n: "APT", d: 3, qd: 1 },
    { s: "GALAUSDT", n: "GALA", d: 5, qd: 0 }, { s: "TRXUSDT", n: "TRX", d: 5, qd: 0 },
    { s: "OMUSDT", n: "OM", d: 4, qd: 1 }, { s: "JUPUSDT", n: "JUP", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, trend: 0, history: [] });
let userSlots = {}; 

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

// ১. সুপার ফাস্ট টেলিগ্রাম (Error Catching সহ)
async function sendTG(msg, chatId) {
    const id = chatId || FIXED_CHAT_ID;
    try {
        await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, {
            chat_id: id, text: msg, parse_mode: 'Markdown'
        });
    } catch (e) {
        console.error("Telegram error: ", e.response ? e.response.data : e.message);
    }
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
        s.history.push(s.p); if(s.history.length > 20) s.history.shift();
        s.trend = s.p > s.lp ? Math.min(10, (s.trend || 0) + 1) : 0;

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, sym: '', buy: 0, sell: 0, slP: 0, qty: 0, pnl: 0, curP: 0, be: false, dca: 0 }));
            
            userSlots[userId].forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.curP = s.p;

                let rawPnL = ((s.p - sl.buy) / sl.buy) * 100 * config.lev;
                sl.pnl = rawPnL - 0.12; 

                // ফী-সহ ব্রেক ইভেন
                if (!sl.be && rawPnL >= 0.25) {
                    sl.slP = sl.buy * 1.0015; sl.be = true;
                    sendTG(`🛡️ *Safety Locked:* #${sl.sym} এর এসএল এন্ট্রি প্রাইসের উপরে সেট করা হয়েছে (ফী সহ)।`, config.cid);
                }

                // স্মার্ট DCA
                if (sl.dca < 1 && rawPnL <= -1.5 && s.trend >= 1) {
                    const dcaQty = sl.qty; 
                    const order = await placeOrder(sl.sym, "BUY", 0, dcaQty, config, "MARKET");
                    if (order) {
                        sl.buy = (sl.buy + s.p) / 2; sl.qty = sl.qty * 2; sl.dca += 1;
                        sl.sell = sl.buy * 1.0050; sl.slP = sl.buy * 0.9930;
                        sendTG(`🌀 *DCA Executed:* #${sl.sym} এভারেজ করা হয়েছে।`, config.cid);
                    }
                }

                // প্রফিট ক্লোজিং
                if (s.p >= sl.sell) {
                    const gain = (sl.qty * s.p) - (sl.qty * sl.buy);
                    const netGain = gain * 0.998;
                    sl.active = false; config.profit += netGain; config.count += 1;
                    saveUser(userId, config);
                    sendTG(`✅ *PROFIT:* +৳${(netGain*124).toFixed(0)} (#${sl.sym})\nসর্বমোট জমা: ৳${(config.profit*124).toFixed(0)}`, config.cid);
                    if(config.mode !== 'demo') await placeOrder(sl.sym, "SELL", 0, sl.qty, config, "MARKET");
                }

                // স্টপ লস ক্লোজিং
                if (s.p <= sl.slP) {
                    const loss = (sl.qty * sl.buy) - (sl.qty * s.p);
                    sl.active = false; config.profit -= loss; config.count += 1; // লস হলেও ট্রেড কাউন্ট হবে
                    saveUser(userId, config);
                    sendTG(`❌ *STOP LOSS:* -৳${(loss*124).toFixed(0)} (#${sl.sym})\nসর্বমোট জমা: ৳${(config.profit*124).toFixed(0)}`, config.cid);
                    if(config.mode !== 'demo') await placeOrder(sl.sym, "SELL", 0, sl.qty, config, "MARKET");
                }
            });

            // নতুন এন্ট্রি (Trend >= 3)
            const slotIdx = userSlots[userId].findIndex(sl => !sl.active);
            if (!config.isPaused && slotIdx !== -1 && s.trend >= 3) {
                const sameCoin = userSlots[userId].filter(sl => sl.active && sl.sym === msg.s);
                if (sameCoin.length === 0) {
                    const coin = COINS.find(c => c.s === msg.s);
                    const buyPrice = s.p;
                    const sellPrice = buyPrice * 1.0050; 
                    const stopPrice = buyPrice * 0.9930; 
                    const qty = ((config.cap / 5 * config.lev) / buyPrice).toFixed(coin.qd);
                    
                    const order = await placeOrder(msg.s, "BUY", 0, qty, config, (config.mode==='demo'?'LIMIT':'MARKET'));
                    if (order) {
                        userSlots[userId][slotIdx] = { id: slotIdx, active: true, sym: msg.s, buy: buyPrice, sell: sellPrice, slP: stopPrice, qty: qty, pnl: 0, curP: s.p, be: false, dca: 0 };
                        sendTG(`🚀 *NEW ENTRY:* #${msg.s} (Strong Trend শুরু)`, config.cid);
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
        let avgTrend = 0; COINS.forEach(c => avgTrend += market[c.s].trend);
        let sentiment = Math.min(100, (avgTrend / (COINS.length * 5)) * 100);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ sentiment, slots: userSlots[uid] || [], profit: db[uid] ? (db[uid].profit * 124).toFixed(0) : 0, count: db[uid] ? db[uid].count : 0 }));
    }

    if (url.pathname === '/reset') {
        const id = url.searchParams.get('id');
        if (db[id]) { db[id].profit = 0; db[id].count = 0; saveUser(id, db[id]); userSlots[id] = null; }
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        const cid = url.searchParams.get('cid') || FIXED_CHAT_ID;
        saveUser(id, { api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), cid: cid, cap: parseFloat(url.searchParams.get('cap'))||10, lev: parseInt(url.searchParams.get('lev'))||20, mode: url.searchParams.get('mode')||'live', profit: 0, count: 0 });
        sendTG("✅ *Connected!* ড্যাশবোর্ড এখন এই টেলিগ্রামের সাথে যুক্ত।", cid);
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-6 flex items-center min-h-screen"><div class="max-w-md mx-auto w-full space-y-6">
            <h1 class="text-6xl font-black text-sky-400 italic text-center tracking-tighter uppercase">Quantum</h1>
            <form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 border border-slate-800">
                <input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none" required>
                <select name="mode" class="w-full bg-black p-4 rounded-xl border border-slate-800"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select>
                <input name="api" placeholder="Binance API" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none">
                <input name="sec" placeholder="Binance Secret" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none">
                <input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none" value="${FIXED_CHAT_ID}" required>
                <div class="grid grid-cols-2 gap-3">
                    <input name="cap" type="number" placeholder="Capital $" class="bg-black p-4 rounded-xl border border-slate-800 outline-none">
                    <input name="lev" type="number" placeholder="Leverage" class="bg-black p-4 rounded-xl border border-slate-800 outline-none">
                </div>
                <button type="submit" class="w-full bg-sky-600 p-5 rounded-full font-black uppercase shadow-lg shadow-sky-600/30">Activate AI</button>
            </form></div></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script>
            <style>
                .gauge-container { position: relative; width: 180px; height: 90px; margin: 0 auto; overflow: hidden; }
                .gauge-bg { width: 180px; height: 180px; border-radius: 50%; background: conic-gradient(#22c55e 0% 30%, #facc15 30% 70%, #ef4444 70% 100%); mask: radial-gradient(circle, transparent 65%, black 66%); -webkit-mask: radial-gradient(circle, transparent 65%, black 66%); }
                #needle { position: absolute; bottom: 0; left: 50%; width: 3px; height: 70px; background: white; transform-origin: bottom center; transform: translateX(-50%) rotate(-90deg); transition: transform 0.8s ease-out; }
            </style></head>
            <body class="bg-[#020617] text-white p-4 font-sans uppercase">
                <div class="max-w-xl mx-auto space-y-4">
                    <div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 text-center">
                        <div class="gauge-container"><div class="gauge-bg"></div><div id="needle"></div></div>
                        <h3 class="text-xs font-black mt-2 text-slate-500 tracking-widest uppercase">Market Sentiment</h3>
                    </div>
                    <div class="grid grid-cols-2 gap-4">
                        <div class="p-6 bg-slate-900 rounded-[2.5rem] text-center border border-slate-800">
                            <p class="text-[9px] text-slate-500 font-bold mb-1 tracking-widest">Growth (BDT)</p>
                            <p class="text-4xl font-black text-green-400">৳<span id="profitText">0</span></p>
                        </div>
                        <div class="p-6 bg-slate-900 rounded-[2.5rem] text-center border border-slate-800">
                            <p class="text-[9px] text-slate-500 font-bold mb-1 tracking-widest">Completed</p>
                            <p class="text-4xl font-black text-sky-400" id="countText">0</p>
                        </div>
                    </div>
                    <div id="slotContainer" class="space-y-3"></div>
                    <div class="flex gap-3 pt-4">
                        <a href="/reset?id=${userId}" onclick="return confirm('সব ডাটা রিসেট করবেন?')" class="flex-1 bg-red-900/20 border border-red-500/30 text-red-500 py-5 rounded-full text-center text-xs font-black">RESET ALL</a>
                        <button onclick="location.reload()" class="flex-1 bg-sky-600 py-5 rounded-full text-xs font-black">REFRESH</button>
                    </div>
                </div>
                <script>
                    async function updateData() {
                        try {
                            const res = await fetch('/api/data?id=${userId}');
                            const data = await res.json();
                            const rotation = (data.sentiment * 1.8) - 90;
                            document.getElementById('needle').style.transform = 'translateX(-50%) rotate('+rotation+'deg)';
                            document.getElementById('profitText').innerText = data.profit;
                            document.getElementById('countText').innerText = data.count;
                            let html = '';
                            data.slots.forEach((s, i) => {
                                let meter = s.active ? Math.max(0, Math.min(100, ((s.curP - s.buy) / (s.sell - s.buy)) * 100)) : 0;
                                html += \`<div class="p-5 bg-slate-900/50 rounded-3xl border border-zinc-800">
                                    <div class="flex justify-between items-center mb-2">
                                        <span class="text-[11px] font-black \${s.active ? 'text-sky-400' : 'text-zinc-700'}">\${s.active ? s.sym : 'Slot '+(i+1)+' Scanning...'}</span>
                                        \${s.active ? \`<span class="text-[11px] font-black \${s.pnl>=0?'text-green-500':'text-red-400'}">\${s.pnl.toFixed(2)}%</span>\` : ''}
                                    </div>
                                    \${s.active ? \`<div class="w-full bg-black h-1.5 rounded-full overflow-hidden mb-4"><div class="h-full bg-sky-500 transition-all duration-500" style="width: \${meter}%"></div></div>
                                    <div class="grid grid-cols-2 text-[10px] font-mono text-slate-500 gap-y-1">
                                        <div>Entry: \${s.buy.toFixed(4)}</div><div class="text-right">Live: \${s.curP}</div>
                                        <div>Stop: <span class="text-red-500">\${s.slP.toFixed(4)}</span></div><div class="text-right text-green-400">Target: \${s.sell.toFixed(4)}</div>
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

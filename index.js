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
    try {
        await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: chatId, text: msg, parse_mode: 'Markdown' });
    } catch (e) { }
}

async function placeOrder(symbol, side, price, qty, config, type = "LIMIT") {
    if (config.mode === 'demo') return { orderId: 'DEMO_' + Date.now() };
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
        s.trend = s.p > s.lp ? Math.min(10, (s.trend || 0) + 1) : 0;

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, slP: 0, qty: 0, pnl: 0, curP: 0 }));
            
            userSlots[userId].forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.curP = s.p;

                // বাই কমপ্লিট হওয়া চেক
                if (sl.status === 'WAITING' && s.p <= sl.buy) {
                    sl.status = 'BOUGHT';
                    const cI = COINS.find(c=>c.s===sl.sym);
                    await placeOrder(sl.sym, "SELL", sl.sell.toFixed(cI.d), sl.qty, config, "LIMIT");
                    sendTG(`📥 *Buy Completed:* ${sl.sym}\nPrice: ${s.p}\nTarget: ${sl.sell}`, config.cid);
                }

                if (sl.status === 'BOUGHT') {
                    sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * config.lev;

                    // ১. লাভ (Take Profit) চেক
                    if (s.p >= sl.sell) {
                        const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy);
                        sl.active = false; config.profit += gain; config.count += 1;
                        saveUser(userId, config);
                        sendTG(`🎉 *Profit Realized:* ${sl.sym}\nGain: ৳${(gain*124).toFixed(0)}`, config.cid);
                        sl.status = 'IDLE';
                    }

                    // ২. স্টপ লস (Stop Loss) চেক
                    if (s.p <= sl.slP) {
                        const loss = (sl.qty * sl.buy) - (sl.qty * s.p);
                        sl.active = false; config.profit -= loss; // লাভ থেকে বাদ দেওয়া
                        saveUser(userId, config);
                        sendTG(`❌ *Stop Loss Hit:* ${sl.sym}\nLoss: ৳${(loss*124).toFixed(0)}`, config.cid);
                        sl.status = 'IDLE';
                        // বাইন্যান্সে থাকা ওপেন সেল অর্ডার ক্যান্সেল করার জন্য মার্কেট সেল দেওয়া ভালো (ডেমো মোডে দরকার নেই)
                        if(config.mode !== 'demo') await placeOrder(sl.sym, "SELL", 0, sl.qty, config, "MARKET");
                    }
                }
            });

            // নতুন ট্রেড এন্ট্রি
            const slotIdx = userSlots[userId].findIndex(sl => !sl.active);
            if (!config.isPaused && slotIdx !== -1 && s.trend >= 3 && s.p < avgP) {
                const sameCoin = userSlots[userId].filter(sl => sl.active && sl.sym === msg.s);
                if (sameCoin.length === 0) {
                    const coin = COINS.find(c => c.s === msg.s);
                    const buyP = (s.p * 0.9995); 
                    const sellP = (buyP * 1.0045);
                    const stopP = (buyP * 0.9850); // ১.৫% স্টপ লস
                    const qty = ((config.cap / 5 * config.lev) / buyP).toFixed(coin.qd);
                    
                    const order = await placeOrder(msg.s, "BUY", buyP.toFixed(coin.d), qty, config, "LIMIT");
                    if (order) {
                        userSlots[userId][slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: msg.s, buy: parseFloat(buyP.toFixed(coin.d)), sell: parseFloat(sellP.toFixed(coin.d)), slP: parseFloat(stopP.toFixed(coin.d)), qty: qty, pnl: 0, curP: s.p };
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

    // ড্যাশবোর্ড এবং বাকি অংশ একই থাকবে...
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`Registration form...`); // আপনার ফর্ম কোডটি এখানে থাকবে
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-4 font-sans">
            <div class="max-w-xl mx-auto space-y-4">
                <div class="grid grid-cols-2 gap-4">
                    <div class="p-4 bg-slate-900 rounded-3xl text-center border border-slate-800">
                        <p class="text-[9px] text-slate-500 uppercase font-bold tracking-widest">Net Profit (BDT)</p>
                        <p class="text-2xl font-black text-green-400">৳<span id="profitText">0</span></p>
                    </div>
                    <div class="p-4 bg-slate-900 rounded-3xl text-center border border-slate-800">
                        <p class="text-[9px] text-slate-500 uppercase font-bold tracking-widest">Total Trades</p>
                        <p class="text-2xl font-black text-sky-400" id="countText">0</p>
                    </div>
                </div>

                <div id="slotContainer" class="space-y-3"></div>
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
                            html += \`
                            <div class="p-4 bg-slate-900/50 rounded-3xl border border-zinc-800">
                                <div class="flex justify-between items-center mb-2">
                                    <span class="text-[10px] font-black \${s.active ? 'text-sky-400' : 'text-zinc-600'} uppercase">\${s.active ? s.sym : 'Slot '+(i+1)+' Scanning'}</span>
                                    \${s.active ? \`<span class="text-[10px] font-bold \${s.pnl>=0?'text-green-500':'text-red-400'}">\${s.pnl.toFixed(2)}%</span>\` : ''}
                                </div>
                                \${s.active ? \`
                                <div class="w-full bg-black h-1.5 rounded-full overflow-hidden mb-3"><div class="h-full bg-gradient-to-r from-red-500 via-orange-500 to-green-500" style="width: \${meter}%"></div></div>
                                <div class="grid grid-cols-2 gap-y-1 text-[9px] font-mono text-slate-500">
                                    <div>ENTRY: <span class="text-white">\${s.buy}</span></div>
                                    <div class="text-right">LIVE: <span class="text-sky-400">\${s.curP}</span></div>
                                    <div>STOP: <span class="text-red-500">\${s.slP}</span></div>
                                    <div class="text-right">TARGET: <span class="text-green-500">\${s.sell}</span></div>
                                </div>\` : ''}
                            </div>\`;
                        });
                        document.getElementById('slotContainer').innerHTML = html;
                    } catch(e) {}
                }
                setInterval(updateData, 1000);
            </script>
        </body></html>`);
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => { startGlobalEngine(); });

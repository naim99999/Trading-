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

// ২০টি শক্তিশালী কয়েন (বেশি মুভমেন্ট করে এমন)
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
    { s: "OPUSDT", n: "OP", d: 4, qd: 1 }, { s: "ARBUSDT", n: "ARB", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, trend: 0, history: [] });
let userSlots = {}; 

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

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
            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, pnl: 0, curP: 0 }));
            
            userSlots[userId].forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.curP = s.p;
                if (sl.status === 'BOUGHT') {
                    sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * config.lev;
                    if (s.p >= sl.sell) {
                        sl.active = false; config.profit += (sl.qty * sl.sell) - (sl.qty * sl.buy); 
                        config.count += 1; saveUser(userId, config); sl.status = 'IDLE';
                    }
                }
            });
        }
    });
}

// 🌐 API Server (Page + JSON Data API)
const server = http.createServer(async (req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    // ১. মিলি-সেকেন্ড ডাটা আপডেট API (এইটা ফ্রন্টএন্ড কল করবে)
    if (url.pathname === '/api/data') {
        const uid = url.searchParams.get('id');
        let avgTrend = 0; COINS.forEach(c => avgTrend += market[c.s].trend);
        let sentiment = Math.min(100, (avgTrend / (COINS.length * 5)) * 100);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            sentiment,
            slots: userSlots[uid] || [],
            profit: db[uid] ? (db[uid].profit * 124).toFixed(0) : 0,
            count: db[uid] ? db[uid].count : 0
        }));
    }

    // ২. মেইন ড্যাশবোর্ড HTML
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`Registration form goes here (Same as before)...`);
    } else {
        res.end(`<!DOCTYPE html><html><head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            .gauge-container { position: relative; width: 180px; height: 90px; margin: 0 auto; overflow: hidden; }
            .gauge-bg { width: 180px; height: 180px; border-radius: 50%; background: conic-gradient(#ef4444 0% 30%, #facc15 30% 70%, #22c55e 70% 100%); mask: radial-gradient(circle, transparent 65%, black 66%); -webkit-mask: radial-gradient(circle, transparent 65%, black 66%); }
            #needle { position: absolute; bottom: 0; left: 50%; width: 3px; height: 70px; background: white; transform-origin: bottom center; transform: translateX(-50%) rotate(-90deg); transition: transform 0.5s ease-out; }
        </style>
        </head>
        <body class="bg-[#020617] text-white p-4">
            <div class="max-w-xl mx-auto space-y-4">
                
                <!-- সেন্টিমেন্ট মিটার -->
                <div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 text-center">
                    <div class="gauge-container"><div class="gauge-bg"></div><div id="needle"></div></div>
                    <h3 id="statusText" class="text-lg font-black mt-2 uppercase text-yellow-400">Neutral Market</h3>
                    <p id="instruction" class="text-[10px] text-slate-400 leading-tight">স্ক্যানিং মার্কেট...</p>
                </div>

                <!-- স্ট্যাটাস কার্ড -->
                <div class="grid grid-cols-2 gap-4">
                    <div class="p-4 bg-slate-900 rounded-3xl text-center border border-slate-800">
                        <p class="text-[9px] text-slate-500 font-bold uppercase">Total Profit</p>
                        <p class="text-xl font-black text-green-400">৳<span id="profitText">0</span></p>
                    </div>
                    <div class="p-4 bg-slate-900 rounded-3xl text-center border border-slate-800">
                        <p class="text-[9px] text-slate-500 font-bold uppercase">Success Trades</p>
                        <p class="text-xl font-black text-sky-400" id="countText">0</p>
                    </div>
                </div>

                <!-- স্লট লিস্ট -->
                <div id="slotContainer" class="space-y-3"></div>

            </div>

            <script>
                async function updateData() {
                    try {
                        const res = await fetch('/api/data?id=${userId}');
                        const data = await res.json();
                        
                        // মিটার আপডেট
                        const rotation = (data.sentiment * 1.8) - 90;
                        document.getElementById('needle').style.transform = 'translateX(-50%) rotate('+rotation+'deg)';
                        
                        let inst = "মার্কেট স্থিতিশীল।";
                        if(data.sentiment < 35) inst = "মার্কেট অনেক নিচে। সাবধানে বাই অর্ডার দিন।";
                        else if(data.sentiment > 65) inst = "মার্কেট হাই বুলিশ! প্রফিট নেওয়ার সময়।";
                        document.getElementById('instruction').innerText = inst;

                        // টেক্সট আপডেট
                        document.getElementById('profitText').innerText = data.profit;
                        document.getElementById('countText').innerText = data.count;

                        // স্লট আপডেট
                        let html = '';
                        data.slots.forEach((s, i) => {
                            let meter = s.active ? Math.max(0, Math.min(100, ((s.curP - s.buy) / (s.sell - s.buy)) * 100)) : 0;
                            html += \`
                            <div class="p-4 bg-slate-900/50 rounded-3xl border border-zinc-800 transition-all">
                                <div class="flex justify-between items-center mb-1">
                                    <span class="text-[10px] font-black \${s.active ? 'text-sky-400' : 'text-zinc-600'}">\${s.active ? s.sym : 'SLOT '+(i+1)+' SCANNING...'}</span>
                                    \${s.active ? \`<span class="text-[10px] font-bold \${s.pnl>=0?'text-green-500':'text-red-400'}">\${s.pnl.toFixed(2)}%</span>\` : ''}
                                </div>
                                \${s.active ? \`
                                <div class="w-full bg-black h-1 rounded-full overflow-hidden mb-2"><div class="h-full bg-green-500" style="width: \${meter}%"></div></div>
                                <div class="grid grid-cols-2 text-[9px] font-mono text-slate-500">
                                    <div>BUY: \${s.buy}</div><div class="text-right text-sky-400">LIVE: \${s.curP}</div>
                                </div>\` : ''}
                            </div>\`;
                        });
                        document.getElementById('slotContainer').innerHTML = html;
                    } catch(e) {}
                }
                setInterval(updateData, 800); // ৮০০ মিলি-সেকেন্ড পর পর অটো আপডেট হবে
            </script>
        </body></html>`);
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => { startGlobalEngine(); });

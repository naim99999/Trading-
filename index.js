const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// ⚙️ CONFIGURATION & SAFETY CONSTANTS
// ==============================================
const MASTER_TG_TOKEN = "8281887575:AAG5OR86LCQO_90479FKkia2F1sEAJjCP60"; 
const FIXED_CHAT_ID = "5279510350"; 
const DB_FILE = 'nebula_apex_final_hub.json';

const HARD_STOP_LOSS = -12.0;   // ১২% লস হলে অটো সেল (সুরক্ষা)
const TRAILING_TRIGGER = 1.0;   // ১.০% লাভ হলে ট্রেইলিং গার্ড শুরু হবে
const TRAILING_CALLBACK = 0.3;  // সর্বোচ্চ লাভ থেকে ০.৩% দাম কমলে প্রফিট বুক হবে
const BTC_CRASH_LIMIT = -1.5;   // BTC ১.৫% ক্রাশ করলে নতুন এন্ট্রি অটো অফ

let cachedUsers = {}; 
const market = {};
const COINS = [
    { s: "BTCUSDT", d: 2, qd: 3 }, { s: "ETHUSDT", d: 2, qd: 3 }, { s: "SOLUSDT", d: 3, qd: 2 }, 
    { s: "SUIUSDT", d: 4, qd: 1 }, { s: "APTUSDT", d: 3, qd: 1 }, { s: "NEARUSDT", d: 4, qd: 1 }, 
    { s: "AVAXUSDT", d: 3, qd: 1 }, { s: "DOGEUSDT", d: 5, qd: 0 }, { s: "XRPUSDT", d: 4, qd: 1 }
];

COINS.forEach(c => market[c.s] = { p: 0, lp: 0, history: [], rsi: 50, btcTrend: 0 });

// --- 💾 DATABASE HELPERS ---
function loadDB() { try { if (fs.existsSync(DB_FILE)) cachedUsers = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { cachedUsers = {}; } }
function saveDB() { try { fs.writeFileSync(DB_FILE, JSON.stringify(cachedUsers, null, 2)); } catch(e) {} }
loadDB();

// --- 🧠 CALCULATIONS ---
function calculateRSI(prices) {
    if (prices.length <= 14) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= 14; i++) {
        let diff = prices[prices.length - i] - prices[prices.length - i - 1];
        diff >= 0 ? gains += diff : losses -= diff;
    }
    return 100 - (100 / (1 + (gains / (losses || 1))));
}

function sign(q, s) { return crypto.createHmac('sha256', s).update(q).digest('hex'); }
async function sendTG(m, id) { try { await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: id || FIXED_CHAT_ID, text: m, parse_mode: 'HTML' }); } catch(e) {} }

async function placeOrder(sym, side, qty, u) {
    if (u.mode === 'demo') return { orderId: 'DEMO_' + Date.now() };
    const ts = Date.now(); let q = `symbol=${sym}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${ts}`;
    try { return (await axios.post(`https://fapi.binance.com/fapi/v1/order?${q}&signature=${sign(q, u.sec)}`, null, { headers: { 'X-MBX-APIKEY': u.api } })).data; } catch (e) { return null; }
}

// --- 🚀 TRADING ENGINE ---
async function startGlobalEngine() {
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/')}`);
    ws.on('message', (data) => {
        const d = JSON.parse(data).data; if (!d || !market[d.s]) return;
        const s = market[d.s]; s.lp = s.p; s.p = parseFloat(d.c);
        s.history.push(s.p); if(s.history.length > 50) s.history.shift();
        s.rsi = calculateRSI(s.history);
        if (d.s === "BTCUSDT" && s.history.length > 10) s.btcTrend = ((s.p - s.history[0]) / s.history[0] * 100);
    });

    setInterval(async () => {
        for (let uid in cachedUsers) {
            let u = cachedUsers[uid]; 
            let btcT = market["BTCUSDT"]?.btcTrend || 0;

            // Panic Guard
            if (btcT <= BTC_CRASH_LIMIT && !u.isPaused) { u.isPaused = true; u.sysPaused = true; }
            else if (u.sysPaused && btcT > -0.2) { u.isPaused = false; u.sysPaused = false; }

            u.userSlots.forEach(async (sl) => {
                if (!sl.active || sl.isClosing) return;
                const ms = market[sl.sym]; if(!ms || ms.p === 0) return;
                
                sl.curP = ms.p; 
                let rawPnL = ((ms.p - sl.buy) / sl.buy) * 100 * u.lev; 
                sl.pnl = rawPnL - 0.1; // Estimated fees
                sl.netBDT = (sl.pnl / 100) * (sl.totalCost / u.lev) * 124;

                if (sl.pnl > (sl.maxPnl || 0)) sl.maxPnl = sl.pnl;

                // 🛑 SAFETY EXIT (Stop Loss & Trailing)
                let shouldSell = (sl.pnl <= HARD_STOP_LOSS) || (sl.maxPnl >= TRAILING_TRIGGER && sl.pnl <= (sl.maxPnl - TRAILING_CALLBACK));

                if (shouldSell) {
                    sl.isClosing = true;
                    if (await placeOrder(sl.sym, "SELL", sl.qty, u)) {
                        let gain = sl.netBDT / 124;
                        u.profit = (u.profit || 0) + gain;
                        if(u.mode === 'demo') u.cap = Number(u.cap) + gain;
                        sendTG(`<b>${gain >= 0 ? '✅ PROFIT' : '🆘 LOSS'}: #${sl.sym}</b>\n৳${sl.netBDT.toFixed(2)}`, u.cid);
                        Object.assign(sl, { active: false, maxPnl: 0, pnl: 0, netBDT: 0 });
                        saveDB();
                    } else sl.isClosing = false;
                }
            });

            // 🚀 SNIPER ENTRY
            if (!u.isPaused && u.userSlots.filter(s => s.active).length < u.slots && btcT > -0.15) {
                for (let sym of Object.keys(market)) {
                    const m = market[sym];
                    if (m.rsi < 30 && !u.userSlots.some(x => x.active && x.sym === sym)) {
                        let tV = (u.cap * u.lev) / u.slots / 5;
                        let qd = COINS.find(c => c.s === sym).qd;
                        let qty = (tV / m.p).toFixed(qd);
                        const sIdx = u.userSlots.findIndex(sl => !sl.active);
                        if (sIdx !== -1 && await placeOrder(sym, "BUY", qty, u)) {
                            u.userSlots[sIdx] = { id: sIdx, active: true, sym: sym, buy: m.p, qty: qty, pnl: 0, curP: m.p, totalCost: (qty * m.p), maxPnl: 0, isClosing: false };
                            saveDB(); sendTG(`🚀 <b>SNIPER ENTRY: #${sym}</b>`, u.cid);
                            break;
                        }
                    }
                }
            }
        }
    }, 1200);
}

// --- 🌐 WEB INTERFACE ---
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`); const userId = url.pathname.slice(1);
    
    if (url.pathname === '/api/data') {
        const u = cachedUsers[url.searchParams.get('id')] || {};
        let btc = market["BTCUSDT"] || { btcTrend: 0, p: 0 };
        return res.end(JSON.stringify({ ...u, btcPrice: btc.p.toFixed(2), btcTrend: btc.btcTrend.toFixed(2) }));
    }

    if (url.pathname === '/toggle-pause') { let u = cachedUsers[url.searchParams.get('id')]; if (u) { u.isPaused = !u.isPaused; saveDB(); } res.writeHead(200); return res.end("OK"); }

    if (url.pathname === '/register') { 
        let q = url.searchParams; let id = q.get('id'), cap = Number(q.get('cap')), slots = Number(q.get('slots'));
        cachedUsers[id] = { api: q.get('api'), sec: q.get('sec'), cid: q.get('cid'), cap: cap, lev: Number(q.get('lev')), slots: slots, targetBDT: Number(q.get('target')), mode: q.get('mode'), profit: 0, isPaused: false, userSlots: Array(slots).fill(null).map((_, i) => ({ id: i, active: false, sym: '', buy: 0, qty: 0, pnl: 0, curP: 0, totalCost: 0, maxPnl: 0, isClosing: false })) };
        saveDB(); res.writeHead(302, { 'Location': '/' + id }); return res.end(); 
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !cachedUsers[userId]) {
        res.end(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white flex items-center justify-center min-h-screen p-6 font-sans">
        <form action="/register" class="w-full max-w-sm bg-slate-900 p-8 rounded-[2.5rem] border border-slate-800 space-y-4 shadow-2xl">
            <h1 class="text-3xl font-black text-sky-500 italic text-center uppercase">Quantum AI</h1>
            <input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none" required>
            <div class="grid grid-cols-2 gap-2">
                <input name="cap" type="number" placeholder="Capital $" class="bg-black p-4 rounded-xl border border-slate-800 outline-none" required>
                <input name="target" type="number" placeholder="Target ৳" class="bg-black p-4 rounded-xl border border-slate-800 outline-none" required>
            </div>
            <div class="grid grid-cols-2 gap-2">
                <input name="lev" type="number" value="15" class="bg-black p-4 rounded-xl border border-slate-800 outline-none">
                <input name="slots" type="number" value="3" class="bg-black p-4 rounded-xl border border-slate-800 outline-none">
            </div>
            <select name="mode" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none">
                <option value="demo">Demo Mode (Paper Trading)</option>
                <option value="live">Live Trading (Real API)</option>
            </select>
            <input name="api" placeholder="API Key" class="w-full bg-black p-4 rounded-xl border border-slate-800">
            <input name="sec" placeholder="Secret Key" class="w-full bg-black p-4 rounded-xl border border-slate-800">
            <input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-xl border border-slate-800">
            <button class="w-full bg-sky-600 p-4 rounded-full font-bold text-lg mt-2 shadow-xl">START SYSTEM</button>
        </form></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#050505] text-white font-sans selection:bg-sky-500/30">
            <div class="max-w-md mx-auto p-4 space-y-4 pb-20">
                <!-- Live BTC Header -->
                <div class="flex justify-between items-center bg-slate-900/50 p-4 rounded-3xl border border-slate-800">
                    <div><p class="text-[10px] text-zinc-500 font-bold uppercase">Bitcoin Pulse</p><p id="btcBox" class="text-lg font-black tracking-tighter">$0.00</p></div>
                    <div class="text-right"><p class="text-[10px] text-zinc-500 font-bold uppercase">Trend</p><p id="btcTrend" class="text-sm font-bold text-sky-400">0.00%</p></div>
                </div>

                <!-- Main Balance -->
                <div class="bg-gradient-to-br from-slate-900 to-black p-8 rounded-[3rem] border border-slate-800 text-center shadow-2xl relative overflow-hidden">
                    <p class="text-xs text-sky-400 font-bold tracking-widest mb-1">AVAILABLE BALANCE</p>
                    <p class="text-5xl font-black tracking-tighter">$<span id="bal">0.00</span></p>
                    <div id="statusDot" class="absolute top-4 right-6 w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                </div>

                <!-- Stats Grid -->
                <div class="grid grid-cols-2 gap-3 text-center">
                    <div class="p-6 bg-slate-900 rounded-[2rem] border border-slate-800">
                        <p class="text-[9px] text-zinc-500 font-bold mb-1">GROWTH BDT</p>
                        <p class="text-2xl font-black text-green-400">৳<span id="prof">0</span></p>
                    </div>
                    <div class="p-6 bg-slate-900 rounded-[2rem] border border-slate-800">
                        <p class="text-[9px] text-zinc-500 font-bold mb-1">TARGET BDT</p>
                        <p class="text-2xl font-black text-sky-400">৳<span id="targ">0</span></p>
                    </div>
                </div>

                <!-- Slots List -->
                <div id="slotContainer" class="space-y-3"></div>

                <!-- Control Bar -->
                <div class="fixed bottom-4 left-4 right-4 max-w-md mx-auto grid grid-cols-2 gap-2">
                    <button onclick="togglePause()" id="pauseBtn" class="bg-zinc-900/80 backdrop-blur-md py-4 rounded-full border border-zinc-800 font-black text-[10px] tracking-widest text-orange-400">PAUSE SYSTEM</button>
                    <a href="/reset-logout?id=${userId}" class="bg-red-500/10 backdrop-blur-md py-4 rounded-full border border-red-500/30 font-black text-[10px] tracking-widest text-red-500 text-center">LOGOUT</a>
                </div>
            </div>

            <script>
                async function togglePause() { await fetch('/toggle-pause?id=${userId}'); }
                async function update() {
                    try {
                        const res = await fetch('/api/data?id=${userId}');
                        const d = await res.json();
                        
                        document.getElementById('btcBox').innerText = '$' + d.btcPrice;
                        document.getElementById('btcTrend').innerText = d.btcTrend + '%';
                        document.getElementById('bal').innerText = (d.mode==='demo' ? Number(d.cap).toFixed(2) : (d.balance || "0.00"));
                        document.getElementById('prof').innerText = (d.profit * 124).toFixed(2);
                        document.getElementById('targ').innerText = d.targetBDT;
                        document.getElementById('pauseBtn').innerText = d.isPaused ? "RESUME SYSTEM" : "PAUSE SYSTEM";

                        let h = '';
                        d.userSlots.forEach((s, i) => {
                            h += \`<div class="p-5 bg-slate-900/40 rounded-[2rem] border border-slate-800 backdrop-blur-sm">
                                <div class="flex justify-between items-center mb-2">
                                    <span class="text-[11px] font-black \${s.active?'text-sky-400':'text-zinc-600'}">\${s.active ? s.sym : 'SLOT '+(i+1)+' EMPTY'}</span>
                                    \${s.active ? \`<span class="text-[11px] font-black \${s.pnl>=0?'text-green-500':'text-red-400'}">\${s.pnl.toFixed(2)}% (৳\${s.netBDT.toFixed(2)})</span>\` : ''}
                                </div>
                                \${s.active ? \`<div class="w-full bg-black/50 h-1.5 rounded-full overflow-hidden mt-1"><div class="h-full bg-sky-500 transition-all duration-700" style="width: \${Math.max(5, Math.min(100, (s.pnl+10)*5))}%"></div></div>\` : ''}
                            </div>\`;
                        });
                        document.getElementById('slotContainer').innerHTML = h;
                    } catch(e) {}
                }
                setInterval(update, 1000);
            </script>
        </body></html>`);
    }
});

server.listen(process.env.PORT || 8080, '0.0.0.0', () => startGlobalEngine());

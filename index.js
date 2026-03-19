const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// 🛡️ QUANTUM AI - FULL DASHBOARD & SLOTS v2.3
// ==============================================
const MASTER_TG_TOKEN = "8281887575:AAG5OR86LCQO_90479FKkia2F1sEAJjCP60"; 
const FIXED_CHAT_ID = "5279510350"; 
const DB_FILE = 'nebula_apex_final_hub.json';

// --- ⚙️ SAFETY PARAMETERS ---
const HARD_STOP_LOSS = -12;      // ১২% লস হলে অটো ক্লোজ
const TRAILING_TRIGGER = 1.0;    // ১% লাভ হলে ট্রেইলিং শুরু
const TRAILING_DROP = 0.3;       // পিক প্রফিট থেকে ০.৩% কমলে সেল
const BTC_PANIC_LIMIT = -1.5;    // বিটকয়েন ক্রাশে নতুন এন্ট্রি অফ

let cachedUsers = {}; 
function loadDB() { try { if (fs.existsSync(DB_FILE)) cachedUsers = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { cachedUsers = {}; } }
function saveDB() { try { fs.writeFileSync(DB_FILE, JSON.stringify(cachedUsers, null, 2)); } catch(e) {} }
loadDB();

const COINS = [
    { s: "BTCUSDT", d: 2, qd: 3 }, { s: "ETHUSDT", d: 2, qd: 3 }, { s: "SOLUSDT", d: 3, qd: 2 }, 
    { s: "SUIUSDT", d: 4, qd: 1 }, { s: "APTUSDT", d: 3, qd: 1 }, { s: "NEARUSDT", d: 4, qd: 1 }, 
    { s: "AVAXUSDT", d: 3, qd: 1 }, { s: "DOGEUSDT", d: 5, qd: 0 }, { s: "XRPUSDT", d: 4, qd: 1 }, 
    { s: "ADAUSDT", d: 4, qd: 1 }, { s: "FETUSDT", d: 4, qd: 1 }, { s: "GALAUSDT", d: 5, qd: 0 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, history: [], rsi: 50, btcTrend: 0 });

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

async function getBalance(u) {
    if (u.mode === 'demo') return Number(u.cap).toFixed(2);
    if (!u.api || !u.sec) return "0.00";
    const ts = Date.now(); const sig = sign(`timestamp=${ts}`, u.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?timestamp=${ts}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': u.api }, timeout: 5000 });
        return res.data ? parseFloat(res.data.totalWalletBalance).toFixed(2) : "0.00";
    } catch (e) { return "0.00"; }
}

async function placeOrder(sym, side, qty, u) {
    if (u.mode === 'demo') return { orderId: 'DEMO_' + Date.now(), status: 'FILLED' };
    const ts = Date.now(); let q = `symbol=${sym}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${ts}`;
    try { 
        const res = await axios.post(`https://fapi.binance.com/fapi/v1/order?${q}&signature=${sign(q, u.sec)}`, null, { headers: { 'X-MBX-APIKEY': u.api } });
        return res.data;
    } catch (e) { return null; }
}

async function startGlobalEngine() {
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/')}`);
    ws.on('message', (data) => {
        const d = JSON.parse(data).data; if (!d || !market[d.s]) return;
        const s = market[d.s]; s.p = parseFloat(d.c);
        s.history.push(s.p); if(s.history.length > 50) s.history.shift();
        s.rsi = calculateRSI(s.history);
        if (d.s === "BTCUSDT" && s.history.length > 10) s.btcTrend = ((s.p - s.history[0]) / s.history[0] * 100);
    });

    setInterval(async () => {
        for (let uid in cachedUsers) {
            let u = cachedUsers[uid];
            let activeTrades = u.userSlots.filter(s => s.active).length;
            let btcT = market["BTCUSDT"]?.btcTrend || 0;
            let feeR = u.fMode === 'bnb' ? 0.00045 : 0.0005;

            // Target Check
            if ((Number(u.profit || 0) * 124) >= Number(u.targetBDT) && u.status !== 'COMPLETED') {
                u.isPaused = true; u.status = 'COMPLETED'; 
                sendTG(`🎯 <b>TARGET REACHED!</b>`, u.cid);
                saveDB();
            }

            // Panic Mode Logic
            if (btcT <= BTC_PANIC_LIMIT && !u.isPaused) { u.isPaused = true; u.sysPaused = true; }
            else if (u.sysPaused && btcT > -0.2) { u.isPaused = false; u.sysPaused = false; }

            u.userSlots.forEach(async (sl) => {
                if (!sl.active || sl.isClosing) return;
                const ms = market[sl.sym]; if(!ms || ms.p === 0) return;

                sl.curP = ms.p;
                let rawPnL = ((ms.p - sl.buy) / sl.buy) * 100 * u.lev;
                sl.pnl = rawPnL - (feeR * 200);
                sl.netBDT = (sl.pnl / 100) * (sl.totalCost / u.lev) * 124;

                if (sl.pnl > (sl.maxPnl || 0)) sl.maxPnl = sl.pnl;

                // Sell logic (Stop Loss or Trailing)
                let shouldSell = (sl.pnl <= HARD_STOP_LOSS) || (sl.maxPnl >= TRAILING_TRIGGER && sl.pnl <= (sl.maxPnl - TRAILING_DROP));

                if (shouldSell) {
                    sl.isClosing = true;
                    if (await placeOrder(sl.sym, "SELL", sl.qty, u)) {
                        let resUSD = (sl.netBDT / 124);
                        u.profit = (u.profit || 0) + resUSD;
                        if(u.mode === 'demo') u.cap = Number(u.cap) + resUSD;
                        sendTG(`<b>${resUSD >= 0 ? '✅ PROFIT' : '🆘 LOSS'}: #${sl.sym}</b>\n৳${sl.netBDT.toFixed(2)}`, u.cid);
                        Object.assign(sl, { active: false, status: 'IDLE', maxPnl: 0, pnl: 0, netBDT: 0 });
                        saveDB();
                    } else sl.isClosing = false;
                }
            });

            // Entry Logic
            if (!u.isPaused && activeTrades < u.slots && u.status !== 'COMPLETED' && btcT > -0.15) {
                for (let sym of Object.keys(market)) {
                    if (activeTrades >= u.slots) break;
                    const m = market[sym];
                    if (m.rsi < 30 && !u.userSlots.some(x => x.active && x.sym === sym)) {
                        let tV = (u.cap * u.lev) / u.slots / 5;
                        let qd = COINS.find(c => c.s === sym).qd;
                        let qty = (tV / m.p).toFixed(qd);
                        const sIdx = u.userSlots.findIndex(sl => !sl.active);
                        if (sIdx !== -1 && await placeOrder(sym, "BUY", qty, u)) {
                            u.userSlots[sIdx] = { id: sIdx, active: true, status: 'TRADING', sym: sym, buy: m.p, qty: qty, pnl: 0, curP: m.p, dca: 0, totalCost: (qty * m.p), netBDT: 0, maxPnl: 0, isClosing: false };
                            activeTrades++; saveDB(); sendTG(`🚀 <b>ENTRY: #${sym}</b>`, u.cid);
                        }
                    }
                }
            }
        }
    }, 1000);
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`); const userId = url.pathname.slice(1);
    
    if (url.pathname === '/api/data') {
        const u = cachedUsers[url.searchParams.get('id')]; 
        const bal = await getBalance(u || {});
        let btc = market["BTCUSDT"] || { btcTrend: 0, p: 0 };
        let pulse = btc.btcTrend > 0.05 ? "BULLISH" : (btc.btcTrend < -0.15 ? "BEARISH" : "NEUTRAL");
        return res.end(JSON.stringify({ ...u, balance: bal, btcPrice: btc.p.toFixed(2), btcTrend: btc.btcTrend.toFixed(2), pulse: pulse }));
    }

    if (url.pathname === '/toggle-pause') { let u = cachedUsers[url.searchParams.get('id')]; if (u) { u.isPaused = !u.isPaused; u.sysPaused = false; saveDB(); } res.writeHead(200); return res.end("OK"); }
    if (url.pathname === '/reset-logout') { if (cachedUsers[userId]) { delete cachedUsers[userId]; saveDB(); } res.writeHead(302, { 'Location': '/' }); return res.end(); }

    if (url.pathname === '/register') { 
        let q = url.searchParams; let id = q.get('id'), cap = Number(q.get('cap')), slots = Number(q.get('slots'));
        cachedUsers[id] = { api: q.get('api'), sec: q.get('sec'), cid: q.get('cid'), cap: cap, lev: Number(q.get('lev')), slots: slots, targetBDT: Number(q.get('target')), mode: q.get('mode'), fMode: q.get('fmode'), profit: 0, isPaused: false, sysPaused: false, status: 'ACTIVE', userSlots: Array(slots).fill(null).map((_, i) => ({ id: i, active: false, sym: '', buy: 0, qty: 0, pnl: 0, curP: 0, dca: 0, totalCost: 0, netBDT: 0, maxPnl: 0, isClosing: false })) };
        saveDB(); res.writeHead(302, { 'Location': '/' + id }); return res.end(); 
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !cachedUsers[userId]) {
        res.end(`<html><body style="background:#020617;color:white;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;text-align:center;">
        <form action="/register" style="background:#0f172a;padding:40px;border-radius:30px;display:grid;gap:10px;width:320px;border:1px solid #1e293b;">
        <h1 style="color:#38bdf8;font-weight:900;font-style:italic;font-size:30px;">QUANTUM AI</h1>
        <input name="id" placeholder="Username" required style="padding:12px;border-radius:10px;border:none;background:#000;color:#fff;">
        <select name="mode" style="padding:12px;border-radius:10px;background:#000;color:#fff;"><option value="demo">Demo Mode</option><option value="live">Live Trading</option></select>
        <input name="cap" type="number" placeholder="Capital $" style="padding:12px;border-radius:10px;border:none;background:#000;color:#fff;">
        <input name="target" type="number" placeholder="Target ৳" style="padding:12px;border-radius:10px;border:none;background:#000;color:#fff;">
        <input name="lev" type="number" placeholder="Leverage" value="15" style="padding:12px;border-radius:10px;border:none;background:#000;color:#fff;">
        <input name="slots" type="number" placeholder="Slots" value="2" style="padding:12px;border-radius:10px;border:none;background:#000;color:#fff;">
        <input name="api" placeholder="API Key" style="padding:12px;border-radius:10px;border:none;background:#000;color:#fff;">
        <input name="sec" placeholder="Secret Key" style="padding:12px;border-radius:10px;border:none;background:#000;color:#fff;">
        <input name="cid" placeholder="Telegram Chat ID" style="padding:12px;border-radius:10px;border:none;background:#000;color:#fff;">
        <button type="submit" style="background:#0284c7;color:white;padding:15px;border:none;border-radius:30px;font-weight:bold;cursor:pointer;margin-top:10px;">INITIALIZE MASTER</button>
        </form></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-4 font-sans uppercase">
        <div class="max-w-md mx-auto space-y-4">
            <div class="p-4 bg-slate-900/50 rounded-3xl border border-slate-800 relative overflow-hidden">
                <div id="pB" class="absolute top-0 left-0 h-1 transition-all duration-1000"></div>
                <div class="flex justify-between items-center">
                    <div><p class="text-[8px] text-slate-500 font-bold">Market Pulse</p><p class="text-[10px] font-black" id="pM">Syncing...</p></div>
                    <div class="px-3 py-1 bg-indigo-500/20 border border-indigo-500/50 rounded-lg text-[8px] font-black text-indigo-400">🛡️ APEX GUARD</div>
                </div>
            </div>
            <div class="p-8 bg-slate-900 rounded-[2.5rem] border-2 border-sky-500/50 text-center shadow-2xl">
                <p class="text-[10px] text-sky-400 font-bold italic">Available Balance</p><p class="text-5xl font-black">$<span id="bal">0.00</span></p>
            </div>
            <div class="grid grid-cols-2 gap-4 text-center">
                <div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800"><p class="text-[9px] text-slate-500">Growth (BDT)</p><p class="text-3xl font-black text-green-400">৳<span id="prof">0</span></p></div>
                <div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800"><p class="text-[9px] text-slate-500">Target (BDT)</p><p class="text-3xl font-black text-sky-400">৳<span id="targ">0</span></p></div>
            </div>
            <div id="slotContainer" class="space-y-3"></div>
            <div class="grid grid-cols-2 gap-3 pt-4">
                <button onclick="togglePause()" id="pBtn" class="py-5 rounded-full text-[10px] font-black bg-orange-900/20 border border-orange-500/30 text-orange-400">PAUSE</button>
                <a href="/reset-logout?id=${userId}" class="bg-slate-800 py-5 rounded-full text-center text-[10px] font-black text-slate-400">LOGOUT</a>
            </div>
        </div>
        <script>
            async function togglePause() { await fetch('/toggle-pause?id=${userId}'); }
            async function update() {
                try {
                    const r = await fetch('/api/data?id=${userId}'); const d = await r.json();
                    document.getElementById('bal').innerText = d.balance;
                    document.getElementById('prof').innerText = (d.profit * 124).toFixed(2);
                    document.getElementById('targ').innerText = d.targetBDT;
                    document.getElementById('pBtn').innerText = d.isPaused ? (d.sysPaused ? "AUTO-PAUSED" : "RESUME") : "PAUSE";
                    
                    const pM = document.getElementById('pM'); const pB = document.getElementById('pB');
                    if(d.pulse==="BULLISH") { pM.innerText="📈 BULLISH ("+d.btcTrend+"%)"; pM.className="text-[10px] font-black text-green-400"; pB.className="absolute top-0 left-0 h-1 bg-green-500 w-full shadow-[0_0_10px_#22c55e]"; }
                    else if(d.pulse==="BEARISH") { pM.innerText="⚠️ BEARISH ("+d.btcTrend+"%)"; pM.className="text-[10px] font-black text-red-500"; pB.className="absolute top-0 left-0 h-1 bg-red-500 w-full shadow-[0_0_10px_#ef4444]"; }
                    else { pM.innerText="⚖️ NEUTRAL ("+d.btcTrend+"%)"; pM.className="text-[10px] font-black text-sky-400"; pB.className="absolute top-0 left-0 h-1 bg-sky-500 w-full"; }

                    let h = '';
                    d.userSlots.forEach((s, i) => {
                        let prog = s.active ? Math.max(5, Math.min(100, (s.pnl + 10) * 5)) : 0;
                        h += \`<div class="p-5 bg-slate-900/40 backdrop-blur-sm rounded-3xl border border-zinc-800">
                            <div class="flex justify-between items-center mb-2">
                                <span class="text-[11px] font-black \${s.active?'text-sky-400':'text-zinc-700'} tracking-widest">\${s.active ? s.sym : 'SLOT '+(i+1)+' EMPTY'}</span>
                                \${s.active ? \`<span class="text-[11px] font-black \${s.pnl>=0?'text-green-500':'text-red-400'}">\${s.pnl.toFixed(2)}% (৳\${s.netBDT.toFixed(2)})</span>\` : ''}
                            </div>
                            \${s.active ? \`<div class="w-full bg-black h-1.5 rounded-full overflow-hidden mt-1"><div class="h-full bg-sky-500 transition-all duration-1000" style="width: \${prog}%"></div></div>\` : ''}
                        </div>\`;
                    });
                    document.getElementById('slotContainer').innerHTML = h;
                } catch(e) {}
            }
            setInterval(update, 1000);
        </script></body></html>`);
    }
});

server.listen(process.env.PORT || 8080, '0.0.0.0', () => startGlobalEngine());

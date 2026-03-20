const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// ⚙️ SETTINGS & SAFETY
// ==============================================
const MASTER_TG_TOKEN = "8281887575:AAG5OR86LCQO_90479FKkia2F1sEAJjCP60"; 
const FIXED_CHAT_ID = "5279510350"; 
const DB_FILE = 'nebula_apex_final_hub.json';

const HARD_STOP_LOSS = -12.0;   
const TRAILING_TRIGGER = 1.0;   
const TRAILING_DROP = 0.3;      
const BTC_CRASH_LIMIT = -1.5;   

let cachedUsers = {}; 
const market = {};
const COINS = [
    { s: "BTCUSDT", d: 2, qd: 3 }, { s: "ETHUSDT", d: 2, qd: 3 }, { s: "SOLUSDT", d: 3, qd: 2 }, 
    { s: "SUIUSDT", d: 4, qd: 1 }, { s: "APTUSDT", d: 3, qd: 1 }, { s: "NEARUSDT", d: 4, qd: 1 }, 
    { s: "AVAXUSDT", d: 3, qd: 1 }, { s: "DOGEUSDT", d: 5, qd: 0 }, { s: "XRPUSDT", d: 4, qd: 1 }
];

COINS.forEach(c => market[c.s] = { p: 0, lp: 0, history: [], rsi: 50, btcTrend: 0 });

function loadDB() { try { if (fs.existsSync(DB_FILE)) cachedUsers = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { cachedUsers = {}; } }
function saveDB() { try { fs.writeFileSync(DB_FILE, JSON.stringify(cachedUsers, null, 2)); } catch(e) {} }
loadDB();

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
    if (u.mode === 'demo') return { orderId: 'DEMO_' + Date.now(), status: 'FILLED' };
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

            u.userSlots.forEach(async (sl) => {
                if (!sl.active || sl.isClosing) return;
                const ms = market[sl.sym]; if(!ms || ms.p === 0) return;
                
                sl.curP = ms.p; 
                let rawPnL = ((ms.p - sl.buy) / sl.buy) * 100 * u.lev; 
                sl.pnl = rawPnL - 0.1;
                sl.netBDT = (sl.pnl / 100) * (sl.totalCost / u.lev) * 124;

                if (sl.pnl > (sl.maxPnl || 0)) sl.maxPnl = sl.pnl;

                // 🛑 SELL LOGIC (Trailing & Stop Loss)
                let shouldSell = (sl.pnl <= HARD_STOP_LOSS) || (sl.maxPnl >= TRAILING_TRIGGER && sl.pnl <= (sl.maxPnl - TRAILING_DROP));

                if (shouldSell) {
                    sl.isClosing = true;
                    if (await placeOrder(sl.sym, "SELL", sl.qty, u)) {
                        let profitUSD = (sl.netBDT / 124);
                        u.profit = (Number(u.profit) || 0) + profitUSD;
                        
                        // [Fix] ডেমো ব্যালেন্স আপডেট (মার্জিন + প্রফিট ফেরত দেওয়া)
                        if(u.mode === 'demo') u.cap = Number(u.cap) + (sl.totalCost / u.lev) + profitUSD;

                        sendTG(`<b>${profitUSD >= 0 ? '✅ PROFIT' : '🆘 LOSS'}: #${sl.sym}</b>\nNet: ৳${sl.netBDT.toFixed(2)}\nTotal Growth: ৳${(u.profit * 124).toFixed(2)}`, u.cid);
                        Object.assign(sl, { active: false, maxPnl: 0, pnl: 0, netBDT: 0 });
                        saveDB();
                    } else sl.isClosing = false;
                }
            });

            // 🚀 ENTRY LOGIC
            if (!u.isPaused && u.userSlots.filter(s => s.active).length < u.slots && btcT > -0.1) {
                for (let sym of Object.keys(market)) {
                    const m = market[sym];
                    if (m.rsi < 30 && !u.userSlots.some(x => x.active && x.sym === sym)) {
                        let targetUSD = (u.cap * u.lev) / u.slots / 5;
                        let qd = COINS.find(c => c.s === sym).qd;
                        let qty = (targetUSD / m.p).toFixed(qd);
                        let marginUsed = (qty * m.p) / u.lev;

                        const sIdx = u.userSlots.findIndex(sl => !sl.active);
                        if (sIdx !== -1 && await placeOrder(sym, "BUY", qty, u)) {
                            // [Fix] ব্যালেন্স থেকে মার্জিন কাটা
                            if(u.mode === 'demo') u.cap = Number(u.cap) - marginUsed;

                            u.userSlots[sIdx] = { id: sIdx, active: true, sym: sym, buy: m.p, qty: qty, pnl: 0, curP: m.p, totalCost: (qty * m.p), maxPnl: 0, isClosing: false };
                            saveDB(); sendTG(`🚀 <b>ENTRY: #${sym}</b>\nPrice: $${m.p}`, u.cid);
                            break; 
                        }
                    }
                }
            }
        }
    }, 1000);
}

// --- 🌐 SERVER & UI ---
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`); const userId = url.pathname.slice(1);
    
    if (url.pathname === '/api/data') {
        const u = cachedUsers[url.searchParams.get('id')] || {};
        let btc = market["BTCUSDT"] || { btcTrend: 0, p: 0 };
        return res.end(JSON.stringify({ ...u, btcPrice: btc.p.toFixed(1), btcTrend: btc.btcTrend.toFixed(2) }));
    }

    if (url.pathname === '/toggle-pause') { let u = cachedUsers[url.searchParams.get('id')]; if (u) { u.isPaused = !u.isPaused; saveDB(); } res.writeHead(200); return res.end("OK"); }

    if (url.pathname === '/register') { 
        let q = url.searchParams;
        cachedUsers[q.get('id')] = { api: q.get('api'), sec: q.get('sec'), cid: q.get('cid'), cap: Number(q.get('cap')), lev: Number(q.get('lev')), slots: Number(q.get('slots')), targetBDT: Number(q.get('target')), mode: q.get('mode'), profit: 0, isPaused: false, userSlots: Array(Number(q.get('slots'))).fill(null).map((_, i) => ({ id: i, active: false, sym: '', buy: 0, qty: 0, pnl: 0, curP: 0, totalCost: 0, maxPnl: 0, isClosing: false })) };
        saveDB(); res.writeHead(302, { 'Location': '/' + q.get('id') }); return res.end(); 
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !cachedUsers[userId]) {
        res.end(`<html><body style="background:#020617;color:white;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
        <form action="/register" style="background:#0f172a;padding:30px;border-radius:25px;display:grid;gap:10px;width:320px;border:1px solid #1e293b;">
            <h1 style="text-align:center;color:#38bdf8;font-style:italic;">QUANTUM AI v4</h1>
            <input name="id" placeholder="Username" required style="padding:12px;border-radius:10px;border:none;background:#000;color:#fff;">
            <input name="cap" type="number" placeholder="Capital $" style="padding:12px;border-radius:10px;border:none;background:#000;color:#fff;">
            <input name="target" type="number" placeholder="Target ৳" style="padding:12px;border-radius:10px;border:none;background:#000;color:#fff;">
            <input name="lev" type="number" value="15" style="padding:12px;border-radius:10px;border:none;background:#000;color:#fff;">
            <input name="slots" type="number" value="3" style="padding:12px;border-radius:10px;border:none;background:#000;color:#fff;">
            <select name="mode" style="padding:12px;border-radius:10px;background:#000;color:#fff;"><option value="demo">Demo Mode</option><option value="live">Live Trading</option></select>
            <input name="api" placeholder="API Key" style="padding:12px;border-radius:10px;border:none;background:#000;color:#fff;">
            <input name="sec" placeholder="Secret Key" style="padding:12px;border-radius:10px;border:none;background:#000;color:#fff;">
            <input name="cid" placeholder="Telegram Chat ID" style="padding:12px;border-radius:10px;border:none;background:#000;color:#fff;">
            <button type="submit" style="background:#0284c7;color:white;padding:15px;border:none;border-radius:10px;font-weight:bold;cursor:pointer;">START SYSTEM</button>
        </form></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#050505] text-white font-sans uppercase">
            <div class="max-w-md mx-auto p-4 space-y-4 pb-24">
                <div class="flex justify-between items-center bg-slate-900/50 p-4 rounded-3xl border border-slate-800">
                    <div><p class="text-[9px] text-zinc-500 font-black">BITCOIN LIVE</p><p id="btcBox" class="text-lg font-black tracking-tighter">$0.00</p></div>
                    <div class="text-right"><p class="text-[9px] text-zinc-500 font-black">TREND</p><p id="btcTrend" class="text-sm font-bold text-sky-400">0.00%</p></div>
                </div>

                <div class="bg-gradient-to-br from-slate-900 to-black p-8 rounded-[3rem] border border-slate-800 text-center shadow-2xl relative">
                    <p class="text-[10px] text-sky-400 font-black tracking-widest mb-1">CURRENT BALANCE</p>
                    <p class="text-5xl font-black tracking-tighter">$<span id="bal">0.00</span></p>
                </div>

                <div class="grid grid-cols-2 gap-3">
                    <div class="p-5 bg-slate-900/80 rounded-[2rem] border border-slate-800 text-center">
                        <p class="text-[8px] text-zinc-500 font-black">PROFIT BDT</p>
                        <p class="text-2xl font-black text-green-400">৳<span id="prof">0</span></p>
                    </div>
                    <div class="p-5 bg-slate-900/80 rounded-[2rem] border border-slate-800 text-center">
                        <p class="text-[8px] text-zinc-500 font-black">TARGET BDT</p>
                        <p class="text-2xl font-black text-sky-400">৳<span id="targ">0</span></p>
                    </div>
                </div>

                <div id="slotContainer" class="space-y-3"></div>

                <div class="fixed bottom-4 left-4 right-4 max-w-md mx-auto grid grid-cols-2 gap-2">
                    <button onclick="togglePause()" id="pauseBtn" class="bg-zinc-900 py-4 rounded-full border border-zinc-800 font-black text-[10px] text-orange-400">PAUSE</button>
                    <a href="/reset-logout?id=${userId}" class="bg-red-500/10 py-4 rounded-full border border-red-500/30 font-black text-[10px] text-red-500 text-center">LOGOUT</a>
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
                        document.getElementById('bal').innerText = Number(d.cap).toFixed(2);
                        document.getElementById('prof').innerText = (d.profit * 124).toFixed(2);
                        document.getElementById('targ').innerText = d.targetBDT;
                        document.getElementById('pauseBtn').innerText = d.isPaused ? "RESUME SYSTEM" : "PAUSE SYSTEM";

                        let h = '';
                        d.userSlots.forEach((s, i) => {
                            h += \`<div class="p-5 bg-slate-900/40 rounded-[2.2rem] border border-slate-800 backdrop-blur-md">
                                <div class="flex justify-between items-start mb-2">
                                    <div>
                                        <p class="text-[11px] font-black \${s.active?'text-sky-400':'text-zinc-700'} tracking-tighter">\${s.active ? s.sym : 'SLOT '+(i+1)+' EMPTY'}</p>
                                        \${s.active ? \`<p class="text-[9px] text-zinc-500 mt-0.5">ENTRY: \${s.buy.toFixed(4)} | LIVE: \${s.curP.toFixed(4)}</p>\` : ''}
                                    </div>
                                    \${s.active ? \`<div class="text-right"><p class="text-xs font-black \${s.pnl>=0?'text-green-500':'text-red-400'}">\${s.pnl.toFixed(2)}%</p><p class="text-[9px] text-zinc-400">৳\${s.netBDT.toFixed(2)}</p></div>\` : ''}
                                </div>
                                \${s.active ? \`<div class="w-full bg-black/50 h-1 rounded-full overflow-hidden"><div class="h-full bg-sky-500" style="width: \${Math.max(5, Math.min(100, (s.pnl+10)*5))}%"></div></div>\` : ''}
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

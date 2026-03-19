const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// 🛡️ Quantum AI Master v1000.6 - BUG FIXED & SECURE
// ==============================================
const MASTER_TG_TOKEN = "8281887575:AAG5OR86LCQO_90479FKkia2F1sEAJjCP60"; 
const FIXED_CHAT_ID = "5279510350"; 
const DB_FILE = 'nebula_apex_final_hub.json';

// --- ⚙️ SAFETY SETTINGS ---
const HARD_STOP_LOSS = -12; // ১২% লস হলে অটো ক্লোজ
const BTC_PANIC_DROP = -1.2; // BTC ১.২% এর বেশি পড়লে সব ট্রেড ক্লোজ

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
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, history: [], low: 0, trend: 0, rsi: 50, btcTrend: 0 });

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

async function sendTG(m, id) { 
    try { await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: id || FIXED_CHAT_ID, text: m, parse_mode: 'HTML' }); } catch(e) {} 
}

async function getBinanceBalance(c) {
    if (!c.api || c.mode === 'demo') return Number(c.cap || 0).toFixed(2);
    const ts = Date.now(); const sig = sign(`timestamp=${ts}`, c.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?timestamp=${ts}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': c.api }, timeout: 5000 });
        return res.data ? parseFloat(res.data.totalWalletBalance).toFixed(2) : "0.00";
    } catch (e) { return "0.00"; }
}

async function placeOrder(sym, side, qty, u) {
    if (u.mode === 'demo') return { orderId: 'DEMO_' + Date.now() };
    const ts = Date.now(); let q = `symbol=${sym}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${ts}`;
    try { 
        const res = await axios.post(`https://fapi.binance.com/fapi/v1/order?${q}&signature=${sign(q, u.sec)}`, null, { headers: { 'X-MBX-APIKEY': u.api } });
        return res.data;
    } catch (e) { 
        console.error("Order Error:", e.response?.data || e.message);
        return null; 
    }
}

async function startGlobalEngine() {
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/')}`);
    ws.on('message', (data) => {
        const d = JSON.parse(data).data; if (!d || !market[d.s]) return;
        const s = market[d.s]; s.lp = s.p; s.p = parseFloat(d.c);
        s.history.push(s.p); if(s.history.length > 50) s.history.shift();
        if (s.p < s.low || s.low === 0) s.low = s.p;
        s.rsi = calculateRSI(s.history);
        if (d.s === "BTCUSDT" && s.history.length > 10) s.btcTrend = ((s.p - s.history[0]) / s.history[0] * 100);
    });

    setInterval(async () => {
        for (let uid in cachedUsers) {
            let u = cachedUsers[uid]; 
            let activeTrades = u.userSlots.filter(s => s.active).length;
            if (u.status === 'COMPLETED' && activeTrades === 0) continue;

            let feeR = u.fMode === 'bnb' ? 0.00045 : 0.0005;
            let btcT = market["BTCUSDT"]?.btcTrend || 0;

            // Target Check
            let totalProfitBDT = (Number(u.profit || 0) * 124);
            if (totalProfitBDT >= Number(u.targetBDT) && u.status !== 'COMPLETED') {
                u.isPaused = true; u.status = 'COMPLETED'; 
                sendTG(`🎯 <b>TARGET REACHED!</b>\nProfit: ৳${totalProfitBDT.toFixed(2)}`, u.cid);
                saveDB();
            }

            u.userSlots.forEach(async (sl) => {
                if (!sl.active || sl.isClosing) return;
                const ms = market[sl.sym]; if(!ms || ms.p === 0) return;
                
                sl.curP = ms.p; 
                let rawPnL = ((ms.p - sl.buy) / sl.buy) * 100 * u.lev; 
                sl.pnl = rawPnL - (feeR * 200);
                sl.netBDT = ((parseFloat(sl.qty) * ms.p - sl.totalCost) - (sl.totalCost + parseFloat(sl.qty) * ms.p) * feeR) * 124;

                if (sl.netBDT > (sl.maxNetBDT || 0)) sl.maxNetBDT = sl.netBDT;

                // 🛑 SAFETY: Stop Loss or Panic Exit
                if (sl.pnl <= HARD_STOP_LOSS || btcT <= BTC_PANIC_DROP) {
                    sl.isClosing = true;
                    if (await placeOrder(sl.sym, "SELL", sl.qty, u)) {
                        u.profit = Number(u.profit || 0) + (sl.netBDT / 124);
                        sendTG(`🆘 <b>EMERGENCY EXIT: #${sl.sym}</b>\nPNL: ${sl.pnl.toFixed(2)}%`, u.cid);
                        Object.assign(sl, { active: false, status: 'IDLE', isClosing: false, pnl: 0, netBDT: 0 });
                        saveDB(); return;
                    } else { sl.isClosing = false; }
                }

                // ✅ Take Profit
                let minProfitBDT = u.isPaused ? 20 : 100; // ১০-১২ টাকা প্রফিট হলেই ক্লোজ করবে যদি বট পজ থাকে
                if (sl.netBDT >= minProfitBDT && sl.netBDT < (sl.maxNetBDT - 10)) {
                    sl.isClosing = true;
                    if (await placeOrder(sl.sym, "SELL", sl.qty, u)) {
                        u.profit = Number(u.profit || 0) + (sl.netBDT / 124);
                        sendTG(`✅ <b>PROFIT: #${sl.sym}</b>\nNet: ৳${sl.netBDT.toFixed(2)}`, u.cid);
                        Object.assign(sl, { active: false, status: 'IDLE', isClosing: false, pnl: 0, netBDT: 0 });
                        saveDB();
                    } else { sl.isClosing = false; }
                }

                // 🌀 Safe DCA
                if (rawPnL <= -3.5 && sl.dca < 3 && ms.rsi < 30) {
                    if (await placeOrder(sl.sym, "BUY", sl.qty, u)) {
                        sl.totalCost += (parseFloat(sl.qty) * ms.p); 
                        sl.qty = (parseFloat(sl.qty) * 2).toString();
                        sl.buy = sl.totalCost / parseFloat(sl.qty); 
                        sl.dca++; saveDB();
                        sendTG(`🌀 <b>DCA: #${sl.sym} (L${sl.dca})</b>`, u.cid);
                    }
                }
            });

            // 🚀 New Entry
            if (!u.isPaused && activeTrades < u.slots && u.status !== 'COMPLETED' && btcT > -0.1) {
                for (let sym of Object.keys(market)) {
                    if (activeTrades >= u.slots) break;
                    const m = market[sym]; 
                    if (m.p === 0 || m.history.length < 20) continue;
                    if (m.rsi < 32 && !u.userSlots.some(x => x.active && x.sym === sym)) {
                        let tV = Math.max(6, (u.cap * u.lev) / u.slots / 5);
                        let qd = COINS.find(c => c.s === sym).qd;
                        let qty = (tV / m.p).toFixed(qd);
                        const sIdx = u.userSlots.findIndex(sl => !sl.active);
                        if (sIdx !== -1 && await placeOrder(sym, "BUY", qty, u)) {
                            u.userSlots[sIdx] = { id: sIdx, active: true, status: 'TRADING', sym: sym, buy: m.p, qty: qty, pnl: 0, curP: m.p, dca: 0, totalCost: (parseFloat(qty) * m.p), netBDT: 0, maxNetBDT: 0, isClosing: false };
                            activeTrades++; saveDB(); sendTG(`🚀 <b>ENTRY: #${sym}</b>`, u.cid);
                        }
                    }
                }
            }
        }
    }, 1200);
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`); 
    const userId = url.pathname.slice(1);

    if (url.pathname === '/api/data') {
        const u = cachedUsers[url.searchParams.get('id')]; 
        const rawB = await getBinanceBalance(u || {});
        let btc = market["BTCUSDT"] || { btcTrend: 0, p: 0 };
        return res.end(JSON.stringify({ ...u, balance: rawB, btcPrice: btc.p, btcTrend: btc.btcTrend }));
    }
    
    if (url.pathname === '/toggle-pause') { 
        let u = cachedUsers[url.searchParams.get('id')]; 
        if (u) { u.isPaused = !u.isPaused; u.status = 'ACTIVE'; saveDB(); } 
        res.writeHead(200); return res.end("OK"); 
    }

    if (url.pathname === '/register') { 
        let q = url.searchParams;
        let id = q.get('id'), cap = Number(q.get('cap')), slots = Number(q.get('slots'));
        cachedUsers[id] = { 
            api: q.get('api'), sec: q.get('sec'), cid: q.get('cid'), cap: cap, 
            lev: Number(q.get('lev')), slots: slots, targetBDT: Number(q.get('target')), 
            mode: q.get('mode'), fMode: q.get('fmode'), profit: 0, isPaused: false, status: 'ACTIVE',
            userSlots: Array(slots).fill(null).map((_, i) => ({ id: i, active: false, sym: '', buy: 0, qty: 0, pnl: 0, curP: 0, dca: 0, totalCost: 0, netBDT: 0, maxNetBDT: 0 })) 
        };
        saveDB(); res.writeHead(302, { 'Location': '/' + id }); return res.end(); 
    }

    if (url.pathname === '/reset-logout') { if (cachedUsers[userId]) { delete cachedUsers[userId]; saveDB(); } res.writeHead(302, { 'Location': '/' }); return res.end(); }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !cachedUsers[userId]) {
        res.end(`<html><body style="background:#020617;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;">
        <form action="/register" style="background:#0f172a;padding:30px;border-radius:20px;width:300px;display:grid;gap:10px;">
        <h2 style="color:#38bdf8;text-align:center;">QUANTUM SETUP</h2>
        <input name="id" placeholder="Username" required style="padding:10px;border-radius:5px;border:none;">
        <input name="api" placeholder="Binance API Key" style="padding:10px;border-radius:5px;border:none;">
        <input name="sec" placeholder="Binance Secret" style="padding:10px;border-radius:5px;border:none;">
        <input name="cid" placeholder="Telegram Chat ID" style="padding:10px;border-radius:5px;border:none;">
        <input name="cap" type="number" placeholder="Capital $" style="padding:10px;border-radius:5px;border:none;">
        <input name="target" type="number" placeholder="Target ৳" style="padding:10px;border-radius:5px;border:none;">
        <input name="lev" type="number" placeholder="Leverage" style="padding:10px;border-radius:5px;border:none;">
        <input name="slots" type="number" placeholder="Slots" style="padding:10px;border-radius:5px;border:none;">
        <select name="mode" style="padding:10px;"><option value="live">Live</option><option value="demo">Demo</option></select>
        <select name="fmode" style="padding:10px;"><option value="usdt">Fee: USDT</option><option value="bnb">Fee: BNB</option></select>
        <button type="submit" style="background:#0284c7;color:white;padding:15px;border:none;border-radius:10px;cursor:pointer;">INITIALIZE BOT</button>
        </form></body></html>`);
    } else {
        // UI কোডে Template literals এস্কেপ করা হয়েছে (\${} ব্যবহার করে)
        res.end(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-4 uppercase">
            <div class="max-w-md mx-auto space-y-4">
                <div class="p-6 bg-slate-900 rounded-3xl border border-sky-500/30 text-center shadow-xl">
                    <p class="text-xs text-sky-400">Wallet Balance</p>
                    <p class="text-4xl font-black">$<span id="bal">0.00</span></p>
                </div>
                <div class="grid grid-cols-2 gap-3 text-center">
                    <div class="p-4 bg-slate-900 rounded-3xl border border-slate-800">
                        <p class="text-[10px] text-slate-500">Profit BDT</p>
                        <p class="text-2xl font-black text-green-400">৳<span id="prof">0</span></p>
                    </div>
                    <div class="p-4 bg-slate-900 rounded-3xl border border-slate-800">
                        <p class="text-[10px] text-slate-500">Target BDT</p>
                        <p class="text-2xl font-black text-sky-400">৳<span id="targ">0</span></p>
                    </div>
                </div>
                <div id="slots" class="space-y-2"></div>
                <button onclick="toggle()" id="pBtn" class="w-full py-4 bg-orange-600/20 text-orange-400 border border-orange-600/50 rounded-full font-bold">PAUSE</button>
                <a href="/reset-logout?id=${userId}" class="block text-center text-xs text-slate-600 mt-4">LOGOUT & RESET</a>
            </div>
            <script>
                async function toggle() { await fetch('/toggle-pause?id=${userId}'); }
                async function update() {
                    try {
                        const r = await fetch('/api/data?id=${userId}');
                        const d = await r.json();
                        document.getElementById('bal').innerText = d.balance;
                        document.getElementById('prof').innerText = (d.profit * 124).toFixed(2);
                        document.getElementById('targ').innerText = d.targetBDT;
                        document.getElementById('pBtn').innerText = d.isPaused ? "RESUME" : "PAUSE";
                        let h = '';
                        d.userSlots.forEach(s => {
                            h += \`<div class="p-4 bg-slate-900/50 rounded-2xl border border-slate-800 flex justify-between items-center">
                                <div><p class="text-xs font-bold \${s.active?'text-sky-400':'text-slate-600'}">\${s.active ? s.sym : 'EMPTY SLOT'}</p>
                                \${s.active ? \`<p class="text-[10px] text-slate-500">DCA: \${s.dca}</p>\` : ''}</div>
                                \${s.active ? \`<div class="text-right"><p class="font-black \${s.pnl>=0?'text-green-400':'text-red-400'}">\${s.pnl.toFixed(2)}%</p>
                                <p class="text-[10px]">৳\${s.netBDT.toFixed(2)}</p></div>\` : ''}
                            </div>\`;
                        });
                        document.getElementById('slots').innerHTML = h;
                    } catch(e) {}
                }
                setInterval(update, 1000);
            </script>
        </body></html>`);
    }
});

server.listen(process.env.PORT || 8080, '0.0.0.0', () => startGlobalEngine());

const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// 🛡️ QUANTUM AI - SMART DEMO & LIVE v2.2
// ==============================================
const MASTER_TG_TOKEN = "8281887575:AAG5OR86LCQO_90479FKkia2F1sEAJjCP60"; 
const FIXED_CHAT_ID = "5279510350"; 
const DB_FILE = 'nebula_apex_final_hub.json';

// --- ⚙️ SAFETY PARAMETERS ---
const HARD_STOP_LOSS = -10;      // ১০% লস হলে অটো ক্লোজ
const TRAILING_TRIGGER = 1.0;    // ১% লাভ হলে ট্রেইলিং শুরু
const TRAILING_DROP = 0.3;       // পিক প্রফিট থেকে ০.৩% কমলে সেল
const BTC_PANIC_LIMIT = -1.2;    // বিটকয়েন ক্রাশে নতুন এন্ট্রি অফ

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

// ব্যালেন্স চেক (ডেমোতে ভার্চুয়াল ব্যালেন্স দেখাবে)
async function getBalance(u) {
    if (u.mode === 'demo') return Number(u.cap).toFixed(2);
    if (!u.api || !u.sec) return "0.00";
    const ts = Date.now(); const sig = sign(`timestamp=${ts}`, u.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?timestamp=${ts}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': u.api }, timeout: 5000 });
        return res.data ? parseFloat(res.data.totalWalletBalance).toFixed(2) : "0.00";
    } catch (e) { return "0.00"; }
}

// অর্ডার প্লেসমেন্ট (ডেমোতে শুধু সিমুলেশন করবে)
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
            let totalProfitBDT = (Number(u.profit || 0) * 124);
            if (totalProfitBDT >= Number(u.targetBDT) && u.status !== 'COMPLETED') {
                u.isPaused = true; u.status = 'COMPLETED'; 
                sendTG(`🎯 <b>TARGET REACHED! (Demo)</b>\nProfit: ৳${totalProfitBDT.toFixed(2)}`, u.cid);
                saveDB();
            }

            u.userSlots.forEach(async (sl) => {
                if (!sl.active || sl.isClosing) return;
                const ms = market[sl.sym]; if(!ms || ms.p === 0) return;

                sl.curP = ms.p;
                let rawPnL = ((ms.p - sl.buy) / sl.buy) * 100 * u.lev;
                sl.pnl = rawPnL - (feeR * 200);
                sl.netBDT = (sl.pnl / 100) * (sl.totalCost / u.lev) * 124;

                if (sl.pnl > (sl.maxPnl || 0)) sl.maxPnl = sl.pnl;

                // 🛑 Stop Loss & Trailing Sell
                let shouldSell = (sl.pnl <= HARD_STOP_LOSS) || (sl.maxPnl >= TRAILING_TRIGGER && sl.pnl <= (sl.maxPnl - TRAILING_DROP));

                if (shouldSell) {
                    sl.isClosing = true;
                    if (await placeOrder(sl.sym, "SELL", sl.qty, u)) {
                        let resultInUSD = (sl.netBDT / 124);
                        u.profit = (u.profit || 0) + resultInUSD;
                        if(u.mode === 'demo') u.cap = Number(u.cap) + resultInUSD; // ডেমো ব্যালেন্স আপডেট
                        
                        sendTG(`<b>${resultInUSD >= 0 ? '✅ PROFIT' : '🆘 LOSS'}: #${sl.sym}</b>\nNet: ৳${sl.netBDT.toFixed(2)}`, u.cid);
                        Object.assign(sl, { active: false, status: 'IDLE', isClosing: false, maxPnl: 0 });
                        saveDB();
                    } else sl.isClosing = false;
                }
            });

            // 🚀 Entry Logic (Sniper RSI)
            if (!u.isPaused && activeTrades < u.slots && u.status !== 'COMPLETED' && btcT > -0.15) {
                for (let sym of Object.keys(market)) {
                    if (activeTrades >= u.slots) break;
                    const m = market[sym];
                    if (m.rsi < 30 && !u.userSlots.some(x => x.active && x.sym === sym)) {
                        let tV = (u.cap * u.lev) / u.slots / 5; // মোট মার্জিন থেকে অল্প ব্যবহার
                        let qd = COINS.find(c => c.s === sym).qd;
                        let qty = (tV / m.p).toFixed(qd);
                        const sIdx = u.userSlots.findIndex(sl => !sl.active);
                        if (sIdx !== -1 && await placeOrder(sym, "BUY", qty, u)) {
                            u.userSlots[sIdx] = { id: sIdx, active: true, status: 'TRADING', sym: sym, buy: m.p, qty: qty, pnl: 0, curP: m.p, dca: 0, totalCost: (qty * m.p), netBDT: 0, maxPnl: 0, isClosing: false };
                            activeTrades++; saveDB(); sendTG(`🚀 <b>DEMO ENTRY: #${sym}</b>`, u.cid);
                        }
                    }
                }
            }
        }
    }, 1200);
}

// HTTP Server
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`); 
    const userId = url.pathname.slice(1);

    if (url.pathname === '/api/data') {
        const u = cachedUsers[url.searchParams.get('id')]; 
        const bal = await getBalance(u || {});
        let btc = market["BTCUSDT"] || { btcTrend: 0, p: 0 };
        return res.end(JSON.stringify({ ...u, balance: bal, btcPrice: btc.p.toFixed(2), btcTrend: btc.btcTrend.toFixed(2) }));
    }

    if (url.pathname === '/register') { 
        let q = url.searchParams;
        let id = q.get('id'), cap = Number(q.get('cap')), slots = Number(q.get('slots'));
        cachedUsers[id] = { api: q.get('api'), sec: q.get('sec'), cid: q.get('cid'), cap: cap, lev: Number(q.get('lev')), slots: slots, targetBDT: Number(q.get('target')), mode: q.get('mode'), fMode: q.get('fmode'), profit: 0, isPaused: false, status: 'ACTIVE', userSlots: Array(slots).fill(null).map((_, i) => ({ id: i, active: false, sym: '', buy: 0, qty: 0, pnl: 0, curP: 0, dca: 0, totalCost: 0, netBDT: 0, maxPnl: 0, isClosing: false })) };
        saveDB(); res.writeHead(302, { 'Location': '/' + id }); return res.end(); 
    }

    // UI and Logout logic... (Same as previous, it will work with this new engine)
    res.end(`<html><body style="background:#020617;color:white;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
        <form action="/register" style="background:#0f172a;padding:40px;border-radius:30px;display:grid;gap:10px;width:320px;">
        <h1 style="text-align:center;color:#38bdf8;">QUANTUM AI</h1>
        <input name="id" placeholder="Username" required style="padding:12px;border-radius:10px;border:none;">
        <select name="mode" style="padding:12px;border-radius:10px;"><option value="demo">Demo Mode (Paper Trading)</option><option value="live">Live Trading (API Required)</option></select>
        <input name="api" placeholder="Binance API Key (Optional for Demo)" style="padding:12px;border-radius:10px;border:none;">
        <input name="sec" placeholder="Binance Secret (Optional for Demo)" style="padding:12px;border-radius:10px;border:none;">
        <input name="cid" placeholder="Telegram Chat ID" style="padding:12px;border-radius:10px;border:none;">
        <input name="cap" type="number" placeholder="Starting Capital $" style="padding:12px;border-radius:10px;border:none;">
        <input name="target" type="number" placeholder="Target ৳" style="padding:12px;border-radius:10px;border:none;">
        <input name="lev" type="number" placeholder="Leverage" value="15" style="padding:12px;border-radius:10px;border:none;">
        <input name="slots" type="number" placeholder="Slots" value="2" style="padding:12px;border-radius:10px;border:none;">
        <button type="submit" style="background:#0284c7;color:white;padding:15px;border:none;border-radius:10px;font-weight:bold;cursor:pointer;">START BOT</button>
        </form></body></html>`);
});

server.listen(process.env.PORT || 8080, '0.0.0.0', () => startGlobalEngine());

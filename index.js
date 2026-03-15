const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// 🛡️ GLOBAL SAFETY SETTINGS
// ==============================================
const MASTER_TG_TOKEN = "8281887575:AAG5OR86LCQO_90479FKkia2F1sEAJjCP60"; 
const FIXED_CHAT_ID = "5279510350"; 
const DB_FILE = 'nebula_master_final.json';

// রিস্ক প্যারামিটার (আপনি চাইলে এগুলো পরিবর্তন করতে পারেন)
const HARD_STOP_LOSS = -25; // স্লট লস -২৫% হলে অটো ক্লোজ (নিরাপত্তা)
const DCA_MULTIPLIER = 1.4; // আগের ২ গুণের বদলে ১.৪ গুণ (ব্যালেন্স বাঁচাবে)
const MAX_DCA_STEPS = 4;    // সর্বোচ্চ ৪ বার অ্যাভারেজ করবে

let cachedUsers = {}; 
try { if (fs.existsSync(DB_FILE)) cachedUsers = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) {}
function saveDB() { try { fs.writeFileSync(DB_FILE, JSON.stringify(cachedUsers, null, 2)); } catch(e) {} }

const COINS = [
    { s: "BTCUSDT", d: 2, qd: 3 }, { s: "ETHUSDT", d: 2, qd: 3 }, { s: "SOLUSDT", d: 3, qd: 2 }, 
    { s: "1000PEPEUSDT", d: 7, qd: 0 }, { s: "BONKUSDT", d: 8, qd: 0 }, { s: "WIFUSDT", d: 4, qd: 1 },
    { s: "DOGEUSDT", d: 5, qd: 0 }, { s: "NEARUSDT", d: 4, qd: 1 }, { s: "AVAXUSDT", d: 3, qd: 1 },
    { s: "BOMEUSDT", d: 6, qd: 0 }, { s: "TRXUSDT", d: 5, qd: 0 }, { s: "LINKUSDT", d: 3, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, history: [], btcTrend: 0 });

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

async function getBinanceBalance(c) {
    if (c.mode === 'demo' || !c.api) return parseFloat(c.cap || 0).toFixed(2);
    const ts = Date.now();
    const sig = sign(`timestamp=${ts}`, c.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?timestamp=${ts}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': c.api }, timeout: 5000 });
        return res.data ? parseFloat(res.data.totalWalletBalance).toFixed(2) : "0.00";
    } catch (e) { return "Error"; }
}

async function placeOrder(sym, side, qty, c) {
    if (c.mode === 'demo') return { orderId: 'DEMO_' + Date.now() };
    const ts = Date.now();
    let q = `symbol=${sym}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${ts}`;
    try { return (await axios.post(`https://fapi.binance.com/fapi/v1/order?${q}&signature=${sign(q, c.sec)}`, null, { headers: { 'X-MBX-APIKEY': c.api } })).data; } catch (e) { return null; }
}

async function startGlobalEngine() {
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/')}`);
    
    ws.on('message', (data) => {
        const payload = JSON.parse(data).data;
        if (!payload || !market[payload.s]) return;
        const s = market[payload.s];
        s.p = parseFloat(payload.c);
        s.history.push(s.p); if(s.history.length > 60) s.history.shift();
        if (payload.s === "BTCUSDT" && s.history.length > 10) s.btcTrend = ((s.p - s.history[0]) / s.history[0] * 100);
    });

    setInterval(async () => {
        for (let uid in cachedUsers) {
            let u = cachedUsers[uid];
            let feeR = 0.0005; 

            u.userSlots.forEach(async (sl) => {
                if (!sl.active || sl.status !== 'TRADING') return;
                const ms = market[sl.sym]; if(!ms || ms.p === 0) return;
                
                sl.curP = ms.p;
                let rawPnL = ((ms.p - sl.buy) / sl.buy) * 100 * u.lev;
                sl.pnl = rawPnL - (feeR * 200);

                // --- ১. ইমার্জেন্সি স্টপ লস (অ্যাকাউন্ট বাঁচানোর জন্য) ---
                if (sl.pnl <= HARD_STOP_LOSS) {
                    await placeOrder(sl.sym, "SELL", sl.qty, u);
                    if(u.mode === 'demo') u.cap = Number(u.cap) - (sl.totalCost / u.lev);
                    Object.assign(sl, { active: false, status: 'IDLE' });
                    sendTG(`🛑 <b>SAFETY SHIELD ACTIVATED: #${sl.sym}</b>\nলস ২০% এর বেশি হওয়ায় পজিশন ক্লোজ করা হয়েছে।`, u.cid);
                    saveDB(); return;
                }

                // --- ২. সেফটি DCA লজিক (১.৪ গুণ) ---
                let dcaT = sl.dca === 0 ? -4 : (sl.dca === 1 ? -8 : -15);
                if (rawPnL <= dcaT && sl.dca < MAX_DCA_STEPS) {
                    let dcaQty = (parseFloat(sl.qty) * (DCA_MULTIPLIER - 1)).toFixed(COINS.find(c=>c.s===sl.sym).qd);
                    if (await placeOrder(sl.sym, "BUY", dcaQty, u)) {
                        let totalValue = (parseFloat(sl.qty) * sl.buy) + (parseFloat(dcaQty) * ms.p);
                        sl.qty = (parseFloat(sl.qty) + parseFloat(dcaQty)).toString();
                        sl.buy = totalValue / parseFloat(sl.qty);
                        sl.totalCost = (parseFloat(sl.qty) * sl.buy);
                        sl.dca++;
                        saveDB();
                        sendTG(`🌀 <b>DCA EXECUTED: #${sl.sym}</b> (ধাপ: ${sl.dca})`, u.cid);
                    }
                }

                // --- ৩. প্রফিট টেকিং ---
                let netG = (parseFloat(sl.qty) * ms.p) - sl.totalCost;
                if (sl.pnl >= 0.5 && (netG * 124) >= 5) { // ০.৫% বা কমপক্ষে ৫ টাকা লাভ হলে ক্লোজ
                    u.profit = Number(u.profit || 0) + netG; u.count++;
                    if(u.mode === 'demo') u.cap = Number(u.cap) + netG + (sl.totalCost / u.lev);
                    await placeOrder(sl.sym, "SELL", sl.qty, u);
                    sl.status = 'COOLING';
                    sendTG(`✅ <b>PROFIT: #${sl.sym}</b>\n৳${(netG * 124).toFixed(2)} আয় হয়েছে।`, u.cid);
                    setTimeout(() => { Object.assign(sl, { active: false, status: 'IDLE' }); saveDB(); }, 2000);
                }
            });

            // --- ৪. স্মার্ট এন্ট্রি (BTC ট্রেন্ড ফিল্টার) ---
            const sIdx = u.userSlots.findIndex(sl => !sl.active);
            if (!u.isPaused && sIdx !== -1 && market["BTCUSDT"].btcTrend > -0.8) {
                for (let sym of Object.keys(market)) {
                    const ms = market[sym]; if (ms.p === 0 || ms.history.length < 20) continue;
                    if (calculateRSI(ms.history) < 35 && ms.p < (Math.max(...ms.history) * 0.995)) {
                        if (u.userSlots.filter(x => x.active && x.sym === sym).length === 0) {
                            let margin = (u.cap / u.slots) * 0.8; // ২০% ক্যাপিটাল হাতে রাখা
                            let qty = (margin * u.lev / ms.p).toFixed(COINS.find(c=>c.s===sym).qd);
                            if (await placeOrder(sym, "BUY", qty, u)) {
                                u.userSlots[sIdx] = { active: true, status: 'TRADING', sym: sym, buy: ms.p, qty: qty, dca: 0, totalCost: (parseFloat(qty) * ms.p), pnl: 0 };
                                saveDB();
                                sendTG(`🚀 <b>SAFE ENTRY: #${sym}</b>`, u.cid);
                                break;
                            }
                        }
                    }
                }
            }
        }
    }, 1500);
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}

// ==============================================
// 🌐 UI & SERVER LOGIC
// ==============================================
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);
    
    if (url.pathname === '/api/data') {
        const u = cachedUsers[url.searchParams.get('id')];
        const rawB = await getBinanceBalance(u || {});
        let btcT = market["BTCUSDT"]?.btcTrend || 0;
        return res.end(JSON.stringify({ slots: u?.userSlots || [], profit: u ? (u.profit * 124).toFixed(2) : 0, count: u ? u.count : 0, isPaused: u?.isPaused || false, balance: rawB, btcVal: btcT.toFixed(2) }));
    }

    if (url.pathname === '/register') { 
        let id = url.searchParams.get('id');
        cachedUsers[id] = { 
            api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), cid: url.searchParams.get('cid'), 
            cap: parseFloat(url.searchParams.get('cap')), lev: parseInt(url.searchParams.get('lev')), 
            slots: parseInt(url.searchParams.get('slots')), mode: url.searchParams.get('mode'), 
            profit: 0, count: 0, isPaused: false, userSlots: Array(parseInt(url.searchParams.get('slots'))).fill(null).map(() => ({ active: false, status: 'IDLE' }))
        }; 
        saveDB(); res.writeHead(302, { 'Location': '/' + id }); return res.end(); 
    }

    if (!userId || !cachedUsers[userId]) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="background:#020617;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh">
        <form action="/register" style="background:#0f172a;padding:40px;border-radius:20px;display:flex;flex-direction:column;gap:10px;width:300px">
            <h2 style="text-align:center">Quantum Register</h2>
            <input name="id" placeholder="Username" required>
            <select name="mode"><option value="demo">Demo</option><option value="live">Live</option></select>
            <input name="api" placeholder="API Key">
            <input name="sec" placeholder="Secret">
            <input name="cid" placeholder="Telegram Chat ID" value="${FIXED_CHAT_ID}">
            <input name="cap" type="number" placeholder="Capital $">
            <input name="lev" type="number" placeholder="Leverage (Max 5x Rec.)">
            <input name="slots" type="number" placeholder="Slots (e.g. 3)">
            <button type="submit" style="background:#0ea5e9;color:white;padding:10px;border:none;border-radius:10px;cursor:pointer">START ENGINE</button>
        </form></body></html>`);
    } else {
        // ... (Dashboard HTML - আপনি আগের ইন্টারফেসটি এখানে ব্যবহার করতে পারেন)
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-4 font-sans uppercase">
        <div class="max-w-xl mx-auto space-y-4">
            <div class="p-6 bg-slate-900 rounded-[2.5rem] border-2 border-sky-500/50 text-center shadow-2xl">
                <p class="text-[10px] text-sky-400 font-bold mb-1 italic">WALLET BALANCE (SAFE MODE)</p>
                <p class="text-5xl font-black text-white">$<span id="balanceText">0.00</span></p>
                <p class="text-[10px] text-slate-500 mt-2">BTC Trend: <span id="btcText">0</span>%</p>
            </div>
            <div class="grid grid-cols-2 gap-4">
                <div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 text-center">
                    <p class="text-[9px] text-slate-500 font-bold">Growth (BDT)</p>
                    <p class="text-3xl font-black text-green-400">৳<span id="profitText">0</span></p>
                </div>
                <div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 text-center">
                    <p class="text-[9px] text-slate-500 font-bold">Wins</p>
                    <p class="text-3xl font-black text-sky-400" id="countText">0</p>
                </div>
            </div>
            <div id="slotContainer"></div>
        </div>
        <script>
            async function updateData() {
                const res = await fetch('/api/data?id=${userId}'); const d = await res.json();
                document.getElementById('balanceText').innerText = d.balance;
                document.getElementById('profitText').innerText = d.profit;
                document.getElementById('countText').innerText = d.count;
                document.getElementById('btcText').innerText = d.btcVal;
                let h = ''; d.slots.forEach((s, i) => {
                    h += '<div class="p-5 bg-slate-900/50 rounded-3xl border border-zinc-800 mb-3 shadow-lg">' +
                         '<div class="flex justify-between font-black text-[11px] mb-2"><span>' + (s.active ? s.sym + ' [DCA:'+s.dca+']' : 'SLOT '+(i+1)+' SCANNING...') + '</span>' +
                         '<span class="' + (s.pnl >= 0 ? 'text-green-500' : 'text-red-500') + '">' + (s.active ? s.pnl.toFixed(2)+'%' : '') + '</span></div>' +
                         (s.active ? '<div class="w-full bg-black h-1.5 rounded-full overflow-hidden"><div class="h-full bg-sky-500" style="width:50%"></div></div>' : '') +
                         '</div>';
                }); document.getElementById('slotContainer').innerHTML = h;
            } setInterval(updateData, 1000);
        </script></body></html>`);
    }
});
server.listen(process.env.PORT || 8080, '0.0.0.0', () => startGlobalEngine());

const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// 🛡️ Quantum AI Master v1000.7 - THE ULTIMATE SHIELD
// ==============================================
const MASTER_TG_TOKEN = "8281887575:AAG5OR86LCQO_90479FKkia2F1sEAJjCP60"; 
const FIXED_CHAT_ID = "5279510350"; 
const DB_FILE = 'nebula_apex_final_hub.json';

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
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, history: [], low: 0, rsi: 50, btcTrend: 0, panic: false });

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
    if (!c.api || c.mode === 'demo') return Number(c.cap || 0).toFixed(2);
    const ts = Date.now(); const sig = sign(`timestamp=${ts}`, c.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?timestamp=${ts}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': c.api }, timeout: 5000 });
        return res.data ? parseFloat(res.data.totalWalletBalance).toFixed(2) : "0.00";
    } catch (e) { return "0.00"; }
}

async function placeOrder(sym, side, qty, c) {
    if (c.mode === 'demo') return { orderId: 'DEMO_' + Date.now() };
    const ts = Date.now(); let q = `symbol=${sym}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${ts}`;
    try { return (await axios.post(`https://fapi.binance.com/fapi/v1/order?${q}&signature=${sign(q, c.sec)}`, null, { headers: { 'X-MBX-APIKEY': c.api } })).data; } catch (e) { return null; }
}

async function startGlobalEngine() {
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/')}`);
    ws.on('message', (data) => {
        const d = JSON.parse(data).data; if (!d || !market[d.s]) return;
        const s = market[d.s]; s.lp = s.p; s.p = parseFloat(d.c);
        s.history.push(s.p); if(s.history.length > 50) s.history.shift();
        s.rsi = calculateRSI(s.history);
        
        if (d.s === "BTCUSDT") {
            s.btcTrend = ((s.p - s.history[0]) / s.history[0] * 100);
            // Panic Mode: যদি ১ মিনিটে ০.০৬% এর বেশি পড়ে যায়
            if (s.btcTrend < -0.06) { s.panic = true; setTimeout(() => s.panic = false, 180000); }
        }
    });

    setInterval(async () => {
        for (let uid in cachedUsers) {
            let u = cachedUsers[uid]; if (u.status === 'COMPLETED') continue;
            let btc = market["BTCUSDT"];
            let activeTrades = u.userSlots.filter(s => s.active).length;
            let targetReached = (Number(u.profit || 0) * 124) >= Number(u.targetBDT);

            u.userSlots.forEach(async (sl) => {
                if (!sl.active || sl.isClosing) return;
                const ms = market[sl.sym]; if(!ms || ms.p === 0) return;
                let feeR = u.fMode === 'bnb' ? 0.00045 : 0.0005;
                sl.curP = ms.p; let rawPnL = ((ms.p - sl.buy) / sl.buy) * 100 * u.lev; sl.pnl = rawPnL - (feeR * 200);
                sl.netBDT = ((parseFloat(sl.qty) * ms.p - sl.totalCost) - (sl.totalCost + parseFloat(sl.qty) * ms.p) * feeR) * 124;

                if (sl.netBDT > (sl.maxNetBDT || 0)) sl.maxNetBDT = sl.netBDT;
                
                // --- স্মার্ট এক্সিট প্রোটেকশন ---
                let minP = (sl.dca >= 3 || btc.panic) ? 0.15 : 0.60; 
                if (targetReached) minP = 0.01; 

                if (sl.netBDT >= minP && (sl.netBDT <= sl.maxNetBDT - 0.01 || btc.panic || targetReached)) {
                    sl.isClosing = true; let gain = sl.netBDT / 124;
                    u.profit = Number(u.profit || 0) + gain;
                    if(u.mode === 'demo') u.cap = Number(u.cap) + gain + (sl.totalCost / u.lev);
                    sendTG(`✅ <b>EXIT: #${sl.sym}</b> (৳${sl.netBDT.toFixed(2)})`, u.cid);
                    if(u.mode !== 'demo') await placeOrder(sl.sym, "SELL", sl.qty, u);
                    setTimeout(() => { Object.assign(sl, { active: false, status: 'IDLE', sym: '', isClosing: false, maxNetBDT: 0 }); saveDB(); }, 1200);
                }

                // --- রিবাউন্ড ডিসিএ (দাম বাড়তে শুরু করলে তবেই ডিসিএ) ---
                let dcaTrigger = sl.dca === 0 ? -1.8 : (sl.dca === 1 ? -4.0 : -8.5);
                if (rawPnL <= dcaTrigger && sl.dca < 4 && !btc.panic && ms.p > ms.lp) {
                    if (await placeOrder(sl.sym, "BUY", sl.qty, u)) {
                        let stM = (parseFloat(sl.qty) * ms.p) / u.lev;
                        if(u.mode === 'demo') u.cap = Number(u.cap) - stM;
                        sl.totalCost += (parseFloat(sl.qty) * ms.p); sl.qty = (parseFloat(sl.qty) * 2).toString();
                        sl.buy = sl.totalCost / parseFloat(sl.qty); sl.dca++; saveDB();
                        sendTG(`🌀 <b>DCA #${sl.dca}: ${sl.sym}</b>`, u.cid);
                    }
                }
            });

            // --- স্মার্ট হান্টার (ভুল সময়ে এন্ট্রি বন্ধ) ---
            if (!u.isPaused && !targetReached && activeTrades < u.slots && !btc.panic) {
                if (btc.btcTrend < -0.04) continue; 
                for (let sym of Object.keys(market)) {
                    if (activeTrades >= u.slots) break;
                    const m = market[sym]; if (m.p === 0 || m.history.length < 35) continue;
                    
                    if (m.rsi < 32 && m.p > m.lp && !u.userSlots.some(x => x.active && x.sym === sym)) {
                        let tV = Math.max(5.1, (u.cap * u.lev) / u.slots / 20), qty = (tV / m.p).toFixed(COINS.find(c => c.s === sym).qd);
                        const sIdx = u.userSlots.findIndex(sl => !sl.active);
                        if (sIdx !== -1 && await placeOrder(sym, "BUY", qty, u)) {
                            if(u.mode === 'demo') u.cap = Number(u.cap) - (tV / u.lev);
                            u.userSlots[sIdx] = { id: sIdx, active: true, status: 'TRADING', sym: sym, buy: m.p, qty: qty, pnl: 0, curP: m.p, dca: 0, totalCost: (parseFloat(qty) * m.p), netBDT: -0.05, isClosing: false, maxNetBDT: 0 };
                            activeTrades++; saveDB(); sendTG(`🚀 <b>AI ENTRY: #${sym}</b>`, u.cid);
                        }
                    }
                }
            }
        }
    }, 900);
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`); const userId = url.pathname.slice(1);
    if (url.pathname === '/api/data') {
        const u = cachedUsers[url.searchParams.get('id')]; const rawB = await getBinanceBalance(u || {});
        let btc = market["BTCUSDT"] || { btcTrend: 0, p: 0, panic: false };
        let status = btc.panic ? "PANIC" : (btc.btcTrend > 0.05 ? "BULLISH" : (btc.btcTrend < -0.08 ? "BEARISH" : "STABLE"));
        return res.end(JSON.stringify({ ...u, balance: rawB, btcPrice: btc.p.toLocaleString(), btcTrend: btc.btcTrend.toFixed(2), panic: btc.panic, marketStatus: status }));
    }
    if (url.pathname === '/toggle-pause') { let u = cachedUsers[url.searchParams.get('id')]; if (u) { u.isPaused = !u.isPaused; saveDB(); } res.writeHead(200); return res.end("OK"); }
    if (url.pathname === '/register') { 
        let q = url.searchParams; let id = q.get('id');
        cachedUsers[id] = { api: q.get('api'), sec: q.get('sec'), cid: q.get('cid'), cap: Number(q.get('cap')), lev: Number(q.get('lev')), slots: Number(q.get('slots')), targetBDT: Number(q.get('target')), mode: q.get('mode'), fMode: q.get('fmode'), profit: 0, isPaused: false, status: 'ACTIVE', userSlots: Array(Number(q.get('slots'))).fill(null).map((_, i) => ({ id: i, active: false, sym: '', buy: 0, qty: 0, pnl: 0, curP: 0, dca: 0, totalCost: 0, netBDT: 0, maxNetBDT: 0 })) };
        saveDB(); res.writeHead(302, { 'Location': '/' + id }); return res.end(); 
    }
    if (url.pathname === '/reset-logout') { if (cachedUsers[userId]) { delete cachedUsers[userId]; saveDB(); } res.writeHead(302, { 'Location': '/' }); return res.end(); }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !cachedUsers[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-6 flex items-center min-h-screen font-sans text-center"><div class="max-w-md mx-auto w-full space-y-6"><h1 class="text-7xl font-black text-sky-400 italic italic">QUANTUM</h1><p class="text-xs font-bold text-sky-500 uppercase tracking-widest">Elite Trading Hub v1000.7</p><form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 border border-slate-800 text-left shadow-2xl"><input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl outline-none border border-slate-800 focus:border-sky-500" required><div class="grid grid-cols-2 gap-2"><select name="mode" class="bg-black p-4 rounded-xl outline-none border border-slate-800"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select><select name="fmode" class="bg-black p-4 rounded-xl outline-none border border-slate-800"><option value="usdt">Fee: USDT</option><option value="bnb">Fee: BNB</option></select></div><input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-xl outline-none border border-slate-800"><input name="sec" placeholder="Binance Secret Key" class="w-full bg-black p-4 rounded-xl outline-none border border-slate-800"><input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-xl outline-none border border-slate-800"><div class="grid grid-cols-2 gap-2"><input name="cap" type="number" placeholder="Capital $" class="bg-black p-4 rounded-xl outline-none border border-slate-800"><input name="target" type="number" placeholder="Target ৳" class="bg-black p-4 rounded-xl outline-none border border-slate-800"></div><div class="grid grid-cols-2 gap-2"><input name="lev" type="number" placeholder="Leverage" class="bg-black p-4 rounded-xl outline-none border border-slate-800"><input name="slots" type="number" placeholder="Max Slots" class="bg-black p-4 rounded-xl outline-none border border-slate-800"></div><button type="submit" class="w-full bg-sky-600 hover:bg-sky-500 p-5 rounded-full font-black uppercase shadow-xl transition-all">Initialize Master Bot</button></form></div></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-4 font-sans uppercase">
        <div class="max-width-xl mx-auto space-y-4">
            <!-- BTC REALTIME CARD -->
            <div class="p-5 bg-slate-900 rounded-[2rem] border border-slate-800 shadow-xl relative overflow-hidden">
                <div id="pLine" class="absolute top-0 left-0 h-1 transition-all duration-1000"></div>
                <div class="flex justify-between items-center">
                    <div>
                        <p class="text-[9px] text-slate-500 font-bold mb-1">BTC/USDT PRICE</p>
                        <p class="text-3xl font-black text-white" id="btcVal">$0.00</p>
                    </div>
                    <div class="text-right">
                        <p id="mStat" class="text-[10px] font-black px-4 py-1.5 rounded-full bg-slate-800 mb-2 inline-block">STABLE</p>
                        <p class="text-[11px] font-bold text-slate-400" id="btcTrend">0.00%</p>
                    </div>
                </div>
            </div>

            <!-- WALLET CARD -->
            <div class="p-6 bg-slate-900 rounded-[2.5rem] border-2 border-sky-500/30 text-center shadow-2xl">
                <p class="text-[10px] text-sky-400 font-bold mb-1 italic">Net Wallet Balance</p>
                <p class="text-5xl font-black text-white">$<span id="balanceText">0.00</span></p>
            </div>

            <!-- PROGRESS CARDS -->
            <div class="grid grid-cols-2 gap-4 text-center">
                <div class="p-5 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl">
                    <p class="text-[9px] text-slate-500 font-bold mb-1 italic">Growth (BDT)</p>
                    <p class="text-3xl font-black text-green-400">৳<span id="profitText">0</span></p>
                </div>
                <div class="p-5 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl">
                    <p class="text-[9px] text-slate-500 font-bold mb-1 italic">Target BDT</p>
                    <p class="text-3xl font-black text-sky-400">৳<span id="targetText">0</span></p>
                </div>
            </div>

            <!-- SLOTS CONTAINER -->
            <div id="slotContainer" class="space-y-4"></div>

            <!-- CONTROL BUTTONS -->
            <div class="grid grid-cols-2 gap-3 pt-4">
                <button onclick="togglePause()" id="pauseBtn" class="py-5 rounded-full text-[12px] font-black bg-orange-900/20 border border-orange-500/30 text-orange-400">AI PAUSE</button>
                <a href="/reset-logout?id=${userId}" class="py-5 bg-slate-800 rounded-full text-[12px] font-black text-center text-slate-400">LOGOUT</a>
            </div>
        </div>

        <script>
            async function togglePause() { await fetch('/toggle-pause?id=${userId}'); location.reload(); }
            async function updateData() { try { const res = await fetch('/api/data?id=${userId}'); const d = await res.json(); 
                document.getElementById('balanceText').innerText = d.balance || "0.00"; 
                document.getElementById('profitText').innerText = (Number(d.profit || 0) * 124).toFixed(2);
                document.getElementById('targetText').innerText = d.targetBDT || "0"; 
                document.getElementById('pauseBtn').innerText = d.isPaused ? "RESUME HUB" : "PAUSE HUB";
                
                // BTC Header
                document.getElementById('btcVal').innerText = "$" + d.btcPrice;
                document.getElementById('btcTrend').innerText = d.btcTrend + "%";
                const mStat = document.getElementById('mStat');
                const pLine = document.getElementById('pLine');
                if(d.marketStatus === "PANIC") { mStat.innerText = "PANIC MODE"; mStat.className="text-[10px] font-black px-4 py-1.5 rounded-full bg-red-900/50 text-red-400"; pLine.className="absolute top-0 left-0 h-1 bg-red-500 w-full"; }
                else if(d.marketStatus === "BULLISH") { mStat.innerText = "BULLISH"; mStat.className="text-[10px] font-black px-4 py-1.5 rounded-full bg-green-900/50 text-green-400"; pLine.className="absolute top-0 left-0 h-1 bg-green-500 w-full shadow-[0_0_10px_#22c55e]"; }
                else if(d.marketStatus === "BEARISH") { mStat.innerText = "BEARISH"; mStat.className="text-[10px] font-black px-4 py-1.5 rounded-full bg-orange-900/40 text-orange-400"; pLine.className="absolute top-0 left-0 h-1 bg-orange-500 w-full"; }
                else { mStat.innerText = "STABLE"; mStat.className="text-[10px] font-black px-4 py-1.5 rounded-full bg-slate-800 text-sky-400"; pLine.className="absolute top-0 left-0 h-1 bg-sky-500 w-full shadow-[0_0_10px_#0ea5e9]"; }

                let h = ''; d.userSlots.forEach((s, i) => {
                    if(!s.active) {
                        h += \`<div class="p-6 bg-slate-900/40 border border-slate-800/50 rounded-[2rem] text-center"><p class="text-[10px] font-black text-slate-600">SLOT \${i+1} IDLE</p></div>\`;
                    } else {
                        const isLoss = s.pnl < 0;
                        h += \`<div class="p-6 bg-slate-900 rounded-[2.2rem] border border-slate-800 shadow-xl relative">
                            <div class="flex justify-between items-start mb-4">
                                <div>
                                    <p class="text-sky-400 text-xs font-black tracking-widest">\${s.sym} [DCA:\${s.dca}]</p>
                                    <p class="text-[10px] text-slate-500 font-bold mt-1 uppercase italic">Apex Shield Active</p>
                                </div>
                                <div class="text-right">
                                    <p class="\${isLoss ? 'text-red-500' : 'text-green-500'} text-sm font-black">\${s.pnl.toFixed(2)}% (৳\${s.netBDT.toFixed(2)})</p>
                                </div>
                            </div>
                            <div class="w-full bg-black/40 h-1 rounded-full overflow-hidden mb-4">
                                <div class="h-full bg-sky-500 transition-all duration-1000" style="width: 65%"></div>
                            </div>
                            <div class="grid grid-cols-2 gap-y-1 text-[10px] font-mono text-slate-500">
                                <div>BUY: \${s.buy.toFixed(4)}</div>
                                <div class="text-right">LIVE: \${s.curP.toFixed(4)}</div>
                            </div>
                        </div>\`;
                    }
                }); document.getElementById('slotContainer').innerHTML = h; } catch(e) {} } setInterval(updateData, 900);</script></body></html>`);
    }
});
server.listen(process.env.PORT || 8080, '0.0.0.0', () => startGlobalEngine());

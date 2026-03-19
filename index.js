const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// 🛡️ Quantum AI Master v1000.7 - THE IRON APEX (RESTORATION)
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
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, history: [], rsi: 50, btcTrend: 0 });

function calculateRSI(prices) {
    if (prices.length <= 10) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= 10; i++) {
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

async function placeOrder(sym, side, qty, u) {
    if (u.mode === 'demo') return { orderId: 'DEMO_' + Date.now() };
    const ts = Date.now(); let q = `symbol=${sym}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${ts}`;
    try { return (await axios.post(`https://fapi.binance.com/fapi/v1/order?${q}&signature=${sign(q, u.sec)}`, null, { headers: { 'X-MBX-APIKEY': u.api } })).data; } catch (e) { return null; }
}

async function startGlobalEngine() {
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/')}`);
    ws.on('message', (data) => {
        const d = JSON.parse(data).data; if (!d || !market[d.s]) return;
        const s = market[d.s]; s.lp = s.p; s.p = parseFloat(d.c);
        s.history.push(s.p); if(s.history.length > 40) s.history.shift();
        s.rsi = calculateRSI(s.history);
        if (d.s === "BTCUSDT" && s.history.length > 5) s.btcTrend = ((s.p - s.history[0]) / s.history[0] * 100);
    });

    setInterval(async () => {
        for (let uid in cachedUsers) {
            let u = cachedUsers[uid]; 
            let activeTrades = u.userSlots.filter(s => s.active).length;
            if (u.status === 'COMPLETED' && activeTrades === 0) continue;

            let feeR = u.fMode === 'bnb' ? 0.00045 : 0.0005;
            let btcT = market["BTCUSDT"]?.btcTrend || 0;

            // --- 🎯 TARGET CHECK ---
            let totalProfitBDT = (Number(u.profit || 0) * 124);
            if (totalProfitBDT >= Number(u.targetBDT) && u.status !== 'COMPLETED') {
                u.isPaused = true; u.status = 'COMPLETED'; saveDB();
                sendTG(`🎯 <b>TARGET ACHIEVED!</b>\nFinalizing active slots.`, u.cid);
            }

            // --- 🛡️ AUTO-PAUSE LOGIC (Like v1000.3) ---
            let highRiskTrade = u.userSlots.some(s => s.active && s.pnl < -4.5);
            if (btcT < -0.15 || highRiskTrade) {
                if(!u.isPaused) { u.isPaused = true; u.sysPaused = true; }
            } else if (u.sysPaused && btcT > -0.05 && !highRiskTrade && u.status !== 'COMPLETED') {
                u.isPaused = false; u.sysPaused = false; 
            }

            u.userSlots.forEach(async (sl) => {
                if (!sl.active || sl.isClosing) return;
                const ms = market[sl.sym]; if(!ms || ms.p === 0) return;
                sl.curP = ms.p; 
                let rawPnL = ((ms.p - sl.buy) / sl.buy) * 100 * u.lev; 
                sl.pnl = rawPnL - (feeR * 200);
                sl.netBDT = ((parseFloat(sl.qty) * ms.p - sl.totalCost) - (sl.totalCost + parseFloat(sl.qty) * ms.p) * feeR) * 124;

                if (sl.netBDT > (sl.maxNetBDT || 0)) sl.maxNetBDT = sl.netBDT;
                
                let minP = u.isPaused ? 0.20 : 1.20;
                let dropTrigger = sl.maxNetBDT - 0.01;

                // --- 📉 PROFIT EXIT ---
                if (sl.netBDT >= minP && (u.isPaused || (sl.maxNetBDT > 0 && sl.netBDT <= dropTrigger))) {
                    sl.isClosing = true; 
                    if (await placeOrder(sl.sym, "SELL", sl.qty, u)) {
                        let gain = sl.netBDT / 124;
                        u.profit = Number(u.profit || 0) + gain;
                        if(u.mode === 'demo') u.cap = Number(u.cap) + gain + (sl.totalCost / u.lev);
                        sendTG(`✅ <b>PROFIT: #${sl.sym}</b>\n৳${sl.netBDT.toFixed(2)}`, u.cid);
                        Object.assign(sl, { active: false, status: 'IDLE', sym: '', isClosing: false, maxNetBDT: 0 }); 
                        saveDB();
                    } else { sl.isClosing = false; }
                }

                // --- 🛡️ IRON SHIELD DCA (3%, 7%, 12%, 20%) ---
                let dcaTarget = sl.dca === 0 ? -3.0 : (sl.dca === 1 ? -7.5 : (sl.dca === 2 ? -13.0 : -20.0));
                if (rawPnL <= dcaTarget && sl.dca < 4 && (sl.totalCost/u.lev)*1.5 < u.cap*0.9) {
                    let dcaQty = (parseFloat(sl.qty) * 1.5).toFixed(COINS.find(c => c.s === sl.sym).qd);
                    if (await placeOrder(sl.sym, "BUY", dcaQty, u)) {
                        let stM = (parseFloat(dcaQty) * ms.p) / u.lev;
                        if(u.mode === 'demo') u.cap = Number(u.cap) - stM;
                        sl.totalCost += (parseFloat(dcaQty) * ms.p); 
                        sl.qty = (parseFloat(sl.qty) + parseFloat(dcaQty)).toString();
                        sl.buy = sl.totalCost / parseFloat(sl.qty); sl.dca++; sl.maxNetBDT = 0; saveDB();
                        sendTG(`🌀 <b>DCA L${sl.dca}: #${sl.sym}</b>`, u.cid);
                    }
                }
            });

            // --- 🚀 SNIPER ENTRY (Divider 15) ---
            if (!u.isPaused && activeTrades < u.slots && u.status !== 'COMPLETED') {
                let rLim = btcT > 0.05 ? 65 : 40;
                let dLim = btcT > 0.05 ? 0.9992 : 0.9920;
                for (let sym of Object.keys(market)) {
                    if (activeTrades >= u.slots) break;
                    const m = market[sym]; if (m.p === 0 || m.history.length < 30) continue;
                    if (m.rsi < rLim && m.p < (Math.max(...m.history) * dLim)) {
                        if (!u.userSlots.some(x => x.active && x.sym === sym)) {
                            let tV = Math.max(5.1, (u.cap * u.lev) / u.slots / 15), qty = (tV / m.p).toFixed(COINS.find(c => c.s === sym).qd), mE = tV / u.lev;
                            const sIdx = u.userSlots.findIndex(sl => !sl.active);
                            if (sIdx !== -1 && await placeOrder(sym, "BUY", qty, u)) {
                                if(u.mode === 'demo') u.cap = Number(u.cap) - mE;
                                u.userSlots[sIdx] = { id: sIdx, active: true, status: 'TRADING', sym: sym, buy: m.p, qty: qty, pnl: 0, curP: m.p, dca: 0, totalCost: (parseFloat(qty) * m.p), netBDT: -0.05, isClosing: false, maxNetBDT: 0 };
                                activeTrades++; saveDB(); sendTG(`🚀 <b>ENTRY: #${sym}</b>`, u.cid);
                            }
                        }
                    }
                }
            }
        }
    }, 850);
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`); const userId = url.pathname.slice(1);
    if (url.pathname === '/api/data') {
        const u = cachedUsers[url.searchParams.get('id')]; const rawB = await getBinanceBalance(u || {});
        let btc = market["BTCUSDT"] || { btcTrend: 0, p: 0 };
        let activeM = u?.userSlots?.reduce((a, s) => a + (s.active ? s.totalCost/u.lev : 0), 0) || 0;
        return res.end(JSON.stringify({ ...u, balance: (Number(rawB) - (u?.mode === 'demo' ? 0 : activeM)).toFixed(2), btcPrice: btc.p.toFixed(2), btcTrend: btc.btcTrend.toFixed(2), pulse: btc.btcTrend > 0.05 ? "BULLISH" : (btc.btcTrend < -0.1 ? "BEARISH" : "NEUTRAL") }));
    }
    if (url.pathname === '/toggle-pause') { let u = cachedUsers[url.searchParams.get('id')]; if (u) { u.isPaused = !u.isPaused; u.sysPaused = false; saveDB(); } res.writeHead(200); return res.end("OK"); }
    if (url.pathname === '/register') { 
        let q = url.searchParams; let id = q.get('id'), cap = Number(q.get('cap')), target = Number(q.get('target')), lev = Number(q.get('lev')), slots = Number(q.get('slots'));
        cachedUsers[id] = { api: q.get('api'), sec: q.get('sec'), cid: q.get('cid'), cap: cap, lev: lev, slots: slots, targetBDT: target, mode: q.get('mode'), fMode: q.get('fmode'), profit: 0, count: 0, isPaused: false, sysPaused: false, status: 'ACTIVE', userSlots: Array(slots).fill(null).map((_, i) => ({ id: i, active: false, sym: '', buy: 0, qty: 0, pnl: 0, curP: 0, dca: 0, totalCost: 0, netBDT: 0, maxNetBDT: 0 })) };
        saveDB(); res.writeHead(302, { 'Location': '/' + id }); return res.end(); 
    }
    if (url.pathname === '/reset-logout') { if (cachedUsers[userId]) { delete cachedUsers[userId]; saveDB(); } res.writeHead(302, { 'Location': '/' }); return res.end(); }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !cachedUsers[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-6 flex items-center min-h-screen font-sans text-center"><div class="max-w-md mx-auto w-full space-y-6"><h1 class="text-7xl font-black text-sky-400 italic">QUANTUM</h1><form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2.5rem] border border-slate-800 p-8 space-y-4 shadow-2xl"><input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl outline-none" required><div class="grid grid-cols-2 gap-2"><select name="mode" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select><select name="fmode" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><option value="usdt">Fee: USDT</option><option value="bnb">Fee: BNB</option></select></div><input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-xl outline-none"><input name="sec" placeholder="Binance Secret" class="w-full bg-black p-4 rounded-xl outline-none"><input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-xl outline-none"><div class="grid grid-cols-2 gap-2"><input name="cap" type="number" placeholder="Capital $" class="bg-black p-4 rounded-xl outline-none"><input name="target" type="number" placeholder="Target ৳" class="bg-black p-4 rounded-xl outline-none"></div><div class="grid grid-cols-2 gap-2"><input name="lev" type="number" placeholder="Leverage" class="bg-black p-4 rounded-xl outline-none"><input name="slots" type="number" placeholder="Slots" class="bg-black p-4 rounded-xl outline-none"></div><button type="submit" class="w-full bg-sky-600 p-5 rounded-full font-black uppercase shadow-xl">Start Master Hub</button></form></div></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-4 font-sans uppercase"><div class="max-width-xl mx-auto space-y-4">
        <div class="p-4 bg-slate-900/50 backdrop-blur-md rounded-[2rem] border border-slate-800 relative overflow-hidden"><div id="pB" class="absolute top-0 left-0 h-1 transition-all duration-1000"></div><div class="flex justify-between items-center mt-1"><div><p class="text-[8px] text-slate-500 font-bold">BTC Market Pulse</p><p class="text-[10px] font-black" id="pM">Syncing...</p><p class="text-[8px] text-slate-400" id="pP">BTC: $0.00</p></div><div class="px-3 py-2 bg-indigo-600/20 border border-indigo-500/50 rounded-lg text-[8px] font-black text-indigo-400">🛡️ APEX GUARD</div></div></div>
        <div class="p-6 bg-slate-900 rounded-[2.5rem] border-2 border-sky-500/50 text-center shadow-2xl"><p class="text-[10px] text-sky-400 font-bold mb-1 italic">Wallet Balance</p><p class="text-5xl font-black text-white">$<span id="balanceText">0.00</span></p></div>
        <div class="grid grid-cols-2 gap-4 text-center"><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold">Growth</p><p class="text-3xl font-black text-green-400">৳<span id="profitText">0</span></p></div><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold">Target</p><p class="text-3xl font-black text-sky-400">৳<span id="targetText">0</span></p></div></div>
        <div id="slotContainer" class="space-y-3"></div><div class="grid grid-cols-2 gap-3 pt-4"><button onclick="togglePause()" id="pauseBtn" class="py-5 rounded-full text-[10px] font-black bg-orange-900/20 border border-orange-500/30 text-orange-400">Pause All</button><a href="/reset-logout?id=${userId}" class="block bg-slate-800 border border-slate-700 text-slate-400 py-5 rounded-full text-center text-[10px] font-black">Logout</a></div></div><script>
            async function togglePause() { await fetch('/toggle-pause?id=${userId}'); location.reload(); }
            async function updateData() { try { const res = await fetch('/api/data?id=${userId}'); const d = await res.json(); 
                document.getElementById('balanceText').innerText = d.balance || "0.00"; document.getElementById('profitText').innerText = (Number(d.profit || 0) * 124).toFixed(2);
                document.getElementById('targetText').innerText = d.targetBDT || "0"; 
                document.getElementById('pauseBtn').innerText = d.isPaused ? (d.sysPaused ? "AUTO-PAUSED" : "RESUME") : "PAUSE";
                const pM = document.getElementById('pM'); const pB = document.getElementById('pB'); const pP = document.getElementById('pP');
                pP.innerText = "BTC: $" + (d.btcPrice || "0.00");
                if(d.pulse === "BULLISH") { pM.innerText = "📈 Bullish ("+d.btcTrend+"%)"; pM.className="text-[10px] font-black text-green-400"; pB.className="absolute top-0 left-0 h-1 bg-green-500 w-full shadow-[0_0_10px_#22c55e]"; }
                else if(d.pulse === "BEARISH") { pM.innerText = "⚠️ Bearish ("+d.btcTrend+"%)"; pM.className="text-[10px] font-black text-red-500"; pB.className="absolute top-0 left-0 h-1 bg-red-500 w-full shadow-[0_0_10px_#ef4444]"; }
                else { pM.innerText = "⚖️ Stable ("+d.btcTrend+"%)"; pM.className="text-[10px] font-black text-sky-400"; pB.className="absolute top-0 left-0 h-1 bg-sky-500 w-full shadow-[0_0_10px_#0ea5e9]"; }
                let h = ''; d.userSlots.forEach((s, i) => { let m = s.active ? Math.max(0, Math.min(100, ((s.curP - s.buy) / (s.buy * 0.005)) * 100)) : 0;
                    h += \`<div class="p-5 bg-slate-900/40 rounded-3xl border border-zinc-800 mb-3 shadow-lg uppercase"><div class="flex justify-between items-center mb-3"><span class="text-[11px] font-black \${s.active ? 'text-sky-400' : 'text-zinc-700'} tracking-wider">\${s.active ? s.sym + ' [DCA:'+s.dca+']' : 'Slot '+(i+1)+' Idle'}</span>\${s.active ? \`<span class="text-[11px] font-black \${s.pnl>=0?'text-green-500':'text-red-400'}">\${s.pnl.toFixed(2)}% (৳\${s.netBDT.toFixed(2)})</span>\` : ''}</div>\${s.active ? \`<div class="w-full bg-black h-1 rounded-full overflow-hidden mb-4"><div class="h-full bg-sky-500 transition-all duration-1000" style="width: \${m}%"></div></div><div class="grid grid-cols-2 text-[10px] font-mono text-slate-500 gap-y-1"><div>Buy: \${s.buy.toFixed(8)}</div><div class="text-right">Live: \${s.curP.toFixed(8)}</div><div class="text-indigo-400 italic text-center col-span-2 mt-1">Apex Shield Active</div></div>\` : ''}</div>\`;
                }); document.getElementById('slotContainer').innerHTML = h; } catch(e) {} } setInterval(updateData, 900);</script></body></html>`);
    }
});
server.listen(process.env.PORT || 8080, '0.0.0.0', () => startGlobalEngine());

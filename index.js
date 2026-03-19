const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// 🛡️ Quantum AI Master v1000.6 - IRON SHIELD & SLOT CONTROL
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

            let btcT = market["BTCUSDT"]?.btcTrend || 0;

            // --- TARGET CHECK ---
            let totalProfitBDT = (Number(u.profit || 0) * 124);
            if (totalProfitBDT >= Number(u.targetBDT) && u.status !== 'COMPLETED') {
                u.isPaused = true; u.status = 'COMPLETED'; saveDB();
                sendTG(`🎯 <b>TARGET REACHED!</b>\nFinalizing active slots.`, u.cid);
            }

            // --- BTC AUTO-PROTECTION ---
            if (btcT < -0.15) { 
                if(!u.isPaused) { u.isPaused = true; u.sysPaused = true; }
            } else if (u.sysPaused && btcT > -0.02 && u.status !== 'COMPLETED') {
                u.isPaused = false; u.sysPaused = false; 
            }

            u.userSlots.forEach(async (sl) => {
                if (!sl.active || sl.isClosing || sl.manualPaused) return; // স্লট পুস থাকলে স্কিপ করবে

                const ms = market[sl.sym]; if(!ms || ms.p === 0) return;
                sl.curP = ms.p; 
                let rawPnL = ((ms.p - sl.buy) / sl.buy) * 100 * u.lev; 
                sl.pnl = rawPnL - 0.1;
                sl.netBDT = ((parseFloat(sl.qty) * ms.p - sl.totalCost) - (sl.totalCost + parseFloat(sl.qty) * ms.p) * 0.0005) * 124;

                if (sl.netBDT > (sl.maxNetBDT || 0)) sl.maxNetBDT = sl.netBDT;
                
                let minP = u.isPaused ? 0.20 : 1.20;
                let dropTrigger = sl.maxNetBDT - 0.01;

                // --- PROFIT EXIT ---
                if (sl.netBDT >= minP && (u.isPaused || (sl.maxNetBDT > 0 && sl.netBDT <= dropTrigger))) {
                    sl.isClosing = true; 
                    if (await placeOrder(sl.sym, "SELL", sl.qty, u)) {
                        u.profit = Number(u.profit || 0) + (sl.netBDT / 124);
                        sendTG(`✅ <b>PROFIT: #${sl.sym}</b>\n৳${sl.netBDT.toFixed(2)}`, u.cid);
                        Object.assign(sl, { active: false, status: 'IDLE', sym: '', isClosing: false, maxNetBDT: 0 }); saveDB();
                    } else { sl.isClosing = false; }
                }

                // --- IRON SHIELD DCA (3%, 7%, 12%, 20%) ---
                let dcaTarget = sl.dca === 0 ? -3.0 : (sl.dca === 1 ? -7.0 : (sl.dca === 2 ? -12.0 : -20.0));
                if (rawPnL <= dcaTarget && sl.dca < 4 && (sl.totalCost/u.lev)*1.5 < u.cap*0.9) {
                    let dcaQty = (parseFloat(sl.qty) * 1.5).toFixed(COINS.find(c => c.s === sl.sym).qd);
                    if (await placeOrder(sl.sym, "BUY", dcaQty, u)) {
                        sl.totalCost += (parseFloat(dcaQty) * ms.p); 
                        sl.qty = (parseFloat(sl.qty) + parseFloat(dcaQty)).toString();
                        sl.buy = sl.totalCost / parseFloat(sl.qty); sl.dca++; sl.maxNetBDT = 0; saveDB();
                        sendTG(`🌀 <b>DCA L${sl.dca}: #${sl.sym}</b>`, u.cid);
                    }
                }
            });

            // --- SNIPER ENTRY (Divider 15) ---
            if (!u.isPaused && activeTrades < u.slots && u.status !== 'COMPLETED') {
                for (let sym of Object.keys(market)) {
                    if (activeTrades >= u.slots) break;
                    const m = market[sym]; if (m.p === 0 || m.history.length < 30) continue;
                    if (m.rsi < 35 && m.p < (Math.max(...m.history) * 0.990)) {
                        if (!u.userSlots.some(x => x.active && x.sym === sym)) {
                            let tV = Math.max(5.1, (u.cap * u.lev) / u.slots / 15); 
                            let qty = (tV / m.p).toFixed(COINS.find(c => c.s === sym).qd);
                            const sIdx = u.userSlots.findIndex(sl => !sl.active);
                            if (sIdx !== -1 && await placeOrder(sym, "BUY", qty, u)) {
                                u.userSlots[sIdx] = { id: sIdx, active: true, status: 'TRADING', sym: sym, buy: m.p, qty: qty, pnl: 0, curP: m.p, dca: 0, totalCost: (parseFloat(qty) * m.p), netBDT: -0.1, isClosing: false, maxNetBDT: 0, manualPaused: false };
                                activeTrades++; saveDB(); sendTG(`🚀 <b>ENTRY: #${sym}</b>`, u.cid);
                            }
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
        const u = cachedUsers[url.searchParams.get('id')]; const rawB = await getBinanceBalance(u || {});
        let btc = market["BTCUSDT"] || { btcTrend: 0, p: 0 };
        return res.end(JSON.stringify({ ...u, balance: rawB, btcPrice: btc.p, btcTrend: btc.btcTrend }));
    }
    
    // প্রতি স্লট পুস করার জন্য নতুন রুট
    if (url.pathname === '/toggle-slot') {
        let u = cachedUsers[url.searchParams.get('id')], sIdx = url.searchParams.get('slot');
        if (u && u.userSlots[sIdx]) { u.userSlots[sIdx].manualPaused = !u.userSlots[sIdx].manualPaused; saveDB(); }
        res.writeHead(200); return res.end("OK");
    }

    if (url.pathname === '/toggle-pause') { let u = cachedUsers[url.searchParams.get('id')]; if (u) { u.isPaused = !u.isPaused; u.sysPaused = false; saveDB(); } res.writeHead(200); return res.end("OK"); }
    
    if (url.pathname === '/register') { 
        let q = url.searchParams; 
        cachedUsers[q.get('id')] = { api: q.get('api'), sec: q.get('sec'), cid: q.get('cid'), cap: Number(q.get('cap')), lev: Number(q.get('lev')), slots: Number(q.get('slots')), targetBDT: Number(q.get('target')), mode: q.get('mode'), fMode: q.get('fmode'), profit: 0, isPaused: false, status: 'ACTIVE', userSlots: Array(Number(q.get('slots'))).fill(null).map((_, i) => ({ id: i, active: false, sym: '', buy: 0, qty: 0, pnl: 0, dca: 0, totalCost: 0, manualPaused: false })) };
        saveDB(); res.writeHead(302, { 'Location': '/' + q.get('id') }); return res.end(); 
    }
    
    if (url.pathname === '/reset-logout') { if (cachedUsers[userId]) { delete cachedUsers[userId]; saveDB(); } res.writeHead(302, { 'Location': '/' }); return res.end(); }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !cachedUsers[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-6 flex items-center min-h-screen font-sans"><div class="max-w-md mx-auto w-full"><h1 class="text-6xl font-black text-sky-400 italic mb-8">QUANTUM</h1><form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 border border-slate-800 shadow-2xl"><input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl outline-none" required><input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-xl outline-none"><input name="sec" placeholder="Binance Secret" class="w-full bg-black p-4 rounded-xl outline-none"><input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-xl outline-none"><div class="grid grid-cols-2 gap-2"><input name="cap" type="number" placeholder="Capital $" class="bg-black p-4 rounded-xl outline-none"><input name="target" type="number" placeholder="Target ৳" class="bg-black p-4 rounded-xl outline-none"></div><div class="grid grid-cols-2 gap-2"><input name="lev" type="number" placeholder="Leverage" class="bg-black p-4 rounded-xl outline-none"><input name="slots" type="number" placeholder="Slots" class="bg-black p-4 rounded-xl outline-none"></div><input type="hidden" name="mode" value="live"><input type="hidden" name="fmode" value="usdt"><button type="submit" class="w-full bg-sky-600 p-5 rounded-full font-black uppercase shadow-xl">Initialize Iron Shield</button></form></div></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-4 font-sans uppercase"><div class="max-width-xl mx-auto space-y-4">
        <div class="p-6 bg-slate-900 rounded-[2.5rem] border-2 border-sky-500/50 text-center shadow-2xl"><p class="text-[10px] text-sky-400 font-bold mb-1 italic">Balance</p><p class="text-5xl font-black text-white">$<span id="balanceText">0.00</span></p></div>
        <div class="grid grid-cols-2 gap-4 text-center"><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold">Growth</p><p class="text-3xl font-black text-green-400">৳<span id="profitText">0</span></p></div><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold">Target</p><p class="text-3xl font-black text-sky-400">৳<span id="targetText">0</span></p></div></div>
        <div id="slotContainer" class="space-y-3"></div><div class="grid grid-cols-2 gap-3 pt-4"><button onclick="togglePause()" id="pauseBtn" class="py-5 rounded-full text-[10px] font-black bg-orange-900/20 border border-orange-500/30 text-orange-400">Pause All</button><a href="/reset-logout?id=${userId}" class="block bg-slate-800 border border-slate-700 text-slate-400 py-5 rounded-full text-center text-[10px] font-black">Logout</a></div></div>
        <script>
            async function togglePause() { await fetch('/toggle-pause?id=${userId}'); location.reload(); }
            async function toggleSlot(idx) { await fetch('/toggle-slot?id=${userId}&slot='+idx); }
            async function updateData() { try { const res = await fetch('/api/data?id=${userId}'); const d = await res.json(); 
                document.getElementById('balanceText').innerText = d.balance || "0.00"; document.getElementById('profitText').innerText = (Number(d.profit || 0) * 124).toFixed(2);
                document.getElementById('targetText').innerText = d.targetBDT || "0"; 
                document.getElementById('pauseBtn').innerText = d.isPaused ? "RESUME ALL" : "PAUSE ALL";
                let h = ''; d.userSlots.forEach((s, i) => {
                    h += \`<div class="p-5 bg-slate-900/40 rounded-3xl border border-zinc-800 mb-3 shadow-lg"><div class="flex justify-between items-center mb-3"><span class="text-[11px] font-black \${s.active ? 'text-sky-400' : 'text-zinc-700'}">\${s.active ? s.sym + ' [DCA:'+s.dca+']' : 'Slot '+(i+1)+' Idle'}</span><button onclick="toggleSlot(\${i})" class="text-[9px] font-black px-3 py-1 rounded-full \${s.manualPaused ? 'bg-red-500 text-white' : 'bg-zinc-800 text-zinc-400'}">\${s.manualPaused ? 'PAUSED' : 'ACTIVE'}</button></div>\${s.active ? \`<div class="flex justify-between items-center mb-2"><span class="text-[12px] font-black \${s.pnl>=0?'text-green-500':'text-red-400'}">\${s.pnl.toFixed(2)}% (৳\${s.netBDT.toFixed(2)})</span></div><div class="grid grid-cols-2 text-[9px] font-mono text-slate-500"><div>Buy: \${s.buy.toFixed(8)}</div><div class="text-right">Live: \${s.curP.toFixed(8)}</div></div>\` : ''}</div>\`;
                }); document.getElementById('slotContainer').innerHTML = h; } catch(e) {} } setInterval(updateData, 1000);</script></body></html>`);
    }
});
server.listen(process.env.PORT || 8080, '0.0.0.0', () => startGlobalEngine());

const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// 👑 QUANTUM APEX AI v17.0 - AUTO-FLUSH ENGINE
// ==============================================
const MASTER_TG_TOKEN = "8281887575:AAG5OR86LCQO_90479FKkia2F1sEAJjCP60"; 
const FIXED_CHAT_ID = "5279510350"; 
const DB_FILE = 'quantum_apex_v17.json';

let cachedUsers = {}; 
function loadDB() { try { if (fs.existsSync(DB_FILE)) cachedUsers = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { cachedUsers = {}; } }
function saveDB() { try { fs.writeFileSync(DB_FILE, JSON.stringify(cachedUsers, null, 2)); } catch(e) {} }
loadDB();

const COINS = [
    { s: "BTCUSDT", d: 2, qd: 3 }, { s: "ETHUSDT", d: 2, qd: 3 }, { s: "SOLUSDT", d: 3, qd: 2 }, 
    { s: "BNBUSDT", d: 2, qd: 2 }, { s: "AVAXUSDT", d: 3, qd: 1 }, { s: "NEARUSDT", d: 4, qd: 1 }, 
    { s: "SUIUSDT", d: 4, qd: 1 }, { s: "APTUSDT", d: 3, qd: 1 }, { s: "FETUSDT", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, history: [], ema7: 0, ema25: 0, rsi: 50, btcTrend: 0 });

function calculateEMA(prices, period) {
    if (prices.length < period) return prices[prices.length - 1];
    let k = 2 / (period + 1); let ema = prices[0];
    for (let i = 1; i < prices.length; i++) { ema = prices[i] * k + ema * (1 - k); }
    return ema;
}

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
        s.history.push(s.p); if(s.history.length > 60) s.history.shift();
        s.ema7 = calculateEMA(s.history, 7); s.ema25 = calculateEMA(s.history, 25);
        s.rsi = calculateRSI(s.history);
        if (d.s === "BTCUSDT" && s.history.length > 10) s.btcTrend = ((s.p - s.history[0]) / s.history[0] * 100);
    });

    setInterval(async () => {
        for (let uid in cachedUsers) {
            let u = cachedUsers[uid]; 
            let walletBal = parseFloat(await getBinanceBalance(u));
            let activeSlots = u.userSlots.filter(s => s.active);

            // 🤖 AI DYNAMIC SLOTS (৫ ডলার থেকে ১০০০০ ডলার অ্যাডাপটিভ)
            let maxS = walletBal < 30 ? 2 : (walletBal < 150 ? 4 : (walletBal < 1000 ? 6 : 8));
            if (u.userSlots.length !== maxS) {
                u.userSlots = Array(maxS).fill(null).map((_, i) => u.userSlots[i] || { id: i, active: false, sym: '', buy: 0, qty: 0, pnl: 0, curP: 0, dca: 0, totalCost: 0, netBDT: 0, maxPnl: 0 });
                saveDB();
            }

            // 🎯 TARGET STATUS
            let growthBDT = (Number(u.profit || 0) * 124);
            let isTargetDone = growthBDT >= Number(u.targetBDT);
            if (isTargetDone && u.status !== 'COMPLETED') { u.status = 'COMPLETED'; saveDB(); }

            activeSlots.forEach(async (sl) => {
                if (sl.isClosing) return;
                const ms = market[sl.sym]; if(!ms || ms.p === 0) return;
                sl.curP = ms.p;
                sl.pnl = (((ms.p - sl.buy) / sl.buy) * 100 * u.lev);
                sl.netBDT = ((parseFloat(sl.qty) * ms.p - sl.totalCost) * 124);

                // 🚀 SMART PROFIT BOOKING (মাইনাসে সেল বন্ধ)
                if (sl.netBDT > 1) { 
                    if (!sl.maxPnl || sl.pnl > sl.maxPnl) sl.maxPnl = sl.pnl;
                    let dropLimit = isTargetDone ? 0.05 : 0.15; // টার্গেট শেষ হলে সামান্য লাভেও বের হয়ে যাবে
                    
                    if ((sl.maxPnl - sl.pnl) >= dropLimit || sl.pnl > 5.0) {
                        sl.isClosing = true;
                        if (await placeOrder(sl.sym, "SELL", sl.qty, u)) {
                            u.profit = (u.profit || 0) + (sl.netBDT / 124);
                            if(u.mode === 'demo') u.cap = Number(u.cap) + (sl.totalCost/u.lev) + (sl.netBDT/124);
                            sendTG(`🎯 <b>FLUSHED: #${sl.sym}</b>\nProfit: ৳${sl.netBDT.toFixed(2)}`, u.cid);
                            Object.assign(sl, { active: false, sym: '', isClosing: false, pnl: 0, maxPnl: 0, dca: 0, totalCost: 0 }); saveDB();
                        } else sl.isClosing = false;
                    }
                }

                // 🌀 AGGRESSIVE DCA ON TARGET COMPLETE (এক এক করে ট্রেড শেষ করা)
                let dcaGap = isTargetDone ? -1.5 : -2.5; // টার্গেট শেষ হলে আরও দ্রুত DCA করবে
                if (sl.pnl <= dcaGap && sl.dca < 8 && walletBal > (sl.totalCost/u.lev)*1.2) {
                    let dQty = (parseFloat(sl.qty) * 1.25).toFixed(COINS.find(c => c.s === sl.sym).qd);
                    if (await placeOrder(sl.sym, "BUY", dQty, u)) {
                        sl.totalCost += (parseFloat(dQty) * ms.p); 
                        sl.qty = (parseFloat(sl.qty) + parseFloat(dQty)).toString();
                        sl.buy = sl.totalCost / parseFloat(sl.qty); sl.dca++; sl.maxPnl = 0; saveDB();
                        sendTG(`🌀 <b>RECOVERY DCA: #${sl.sym}</b>\nLevel ${sl.dca} - Target Flush Mode`, u.cid);
                    }
                }
            });

            // 🚀 SNIPER ENTRY (TARGET DONE হলে নতুন এন্ট্রি বন্ধ)
            if (!u.isPaused && !isTargetDone && activeSlots.length < (maxS - 1)) {
                for (let sym of Object.keys(market)) {
                    const m = market[sym]; 
                    if (m.p === 0 || m.history.length < 50) continue;
                    if (m.rsi < 29 && m.p > m.ema7 && !u.userSlots.some(x => x.active && x.sym === sym)) {
                        let entryValue = (walletBal * u.lev) / maxS / 3.5;
                        let qty = (entryValue / m.p).toFixed(COINS.find(c => c.s === sym).qd);
                        const sIdx = u.userSlots.findIndex(sl => !sl.active);
                        if (sIdx !== -1 && await placeOrder(sym, "BUY", qty, u)) {
                            if(u.mode === 'demo') u.cap -= (entryValue/u.lev);
                            u.userSlots[sIdx] = { id: sIdx, active: true, sym: sym, buy: m.p, qty: qty, pnl: 0, curP: m.p, dca: 0, totalCost: (parseFloat(qty) * m.p), netBDT: 0, maxPnl: 0, marginCost: (entryValue/u.lev), isClosing: false };
                            saveDB(); sendTG(`🚀 <b>AI ENTRY: #${sym}</b>`, u.cid);
                        }
                    }
                }
            }
        }
    }, 1000);
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}

// SERVER & UI (ডিজাইন অপরিবর্তিত)
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`); const userId = url.pathname.slice(1);
    if (url.pathname === '/api/data') {
        const u = cachedUsers[url.searchParams.get('id')]; const rawB = await getBinanceBalance(u || {});
        let btc = market["BTCUSDT"] || { btcTrend: 0, p: 0 };
        return res.end(JSON.stringify({ ...u, balance: Number(rawB).toFixed(2), btcPrice: btc.p.toFixed(2), btcTrend: btc.btcTrend.toFixed(2), pulse: btc.btcTrend > 0.05 ? "BULLISH" : (btc.btcTrend < -0.1 ? "BEARISH" : "NEUTRAL") }));
    }
    if (url.pathname === '/toggle-pause') { let u = cachedUsers[url.searchParams.get('id')]; if (u) { u.isPaused = !u.isPaused; u.status = 'ACTIVE'; saveDB(); } res.writeHead(200); return res.end("OK"); }
    if (url.pathname === '/register') { 
        let q = url.searchParams; let id = q.get('id'), cap = Number(q.get('cap')), target = Number(q.get('target')), lev = Number(q.get('lev'));
        cachedUsers[id] = { api: q.get('api'), sec: q.get('sec'), cid: q.get('cid'), cap: cap, lev: lev, targetBDT: target, mode: q.get('mode'), fMode: q.get('fmode'), profit: 0, isPaused: false, status: 'ACTIVE', userSlots: [] };
        saveDB(); res.writeHead(302, { 'Location': '/' + id }); return res.end(); 
    }
    if (url.pathname === '/reset-logout') { if (cachedUsers[userId]) { delete cachedUsers[userId]; saveDB(); } res.writeHead(302, { 'Location': '/' }); return res.end(); }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !cachedUsers[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-6 flex items-center min-h-screen font-sans text-center"><div class="max-w-md mx-auto w-full space-y-6"><h1 class="text-7xl font-black text-sky-400 italic">QUANTUM</h1><form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 border border-slate-800 text-left shadow-2xl"><input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl outline-none" required><div class="grid grid-cols-2 gap-2"><select name="mode" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select><select name="fmode" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><option value="usdt">Fee: USDT</option><option value="bnb">Fee: BNB</option></select></div><input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-xl outline-none"><input name="sec" placeholder="Binance Secret" class="w-full bg-black p-4 rounded-xl outline-none"><input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-xl outline-none"><div class="grid grid-cols-2 gap-2"><input name="cap" type="number" placeholder="Capital $" class="bg-black p-4 rounded-xl outline-none"><input name="target" type="number" placeholder="Target ৳" class="bg-black p-4 rounded-xl outline-none"></div><input name="lev" type="number" placeholder="Leverage" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><button type="submit" class="w-full bg-sky-600 p-5 rounded-full font-black uppercase shadow-xl">Launch Apex v17</button></form></div></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-4 font-sans uppercase"><div class="max-width-xl mx-auto space-y-4">
        <div class="p-4 bg-slate-900/50 backdrop-blur-md rounded-[2rem] border border-slate-800 shadow-lg relative overflow-hidden"><div id="pB" class="absolute top-0 left-0 h-1 transition-all duration-1000"></div><div class="flex justify-between items-center mt-1"><div><p class="text-[8px] text-slate-500 font-bold">Quantum Engine Status</p><p class="text-[10px] font-black" id="pM">Syncing...</p><p class="text-[8px] text-slate-400" id="pP">BTC: $0.00</p></div><div class="px-3 py-2 bg-indigo-600/20 border border-indigo-500/50 rounded-lg text-[8px] font-black text-indigo-400">🛡️ APEX v17 ACTIVE</div></div></div>
        <div class="p-6 bg-slate-900 rounded-[2.5rem] border-2 border-sky-500/50 text-center shadow-2xl tracking-tighter"><p class="text-[10px] text-sky-400 font-bold mb-1 italic">Wallet Balance</p><p class="text-5xl font-black text-white">$<span id="balanceText">0.00</span></p></div>
        <div class="grid grid-cols-2 gap-4 text-center"><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1">Growth (BDT)</p><p class="text-4xl font-black text-green-400">৳<span id="profitText">0</span></p></div><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1 italic">Target BDT</p><p class="text-4xl font-black text-sky-400">৳<span id="targetText">0</span></p></div></div>
        <div id="slotContainer" class="space-y-3"></div><div class="grid grid-cols-2 gap-3 pt-4 uppercase"><button onclick="togglePause()" id="pauseBtn" class="py-5 rounded-full text-[10px] font-black bg-orange-900/20 border border-orange-500/30 text-orange-400">Pause</button><a href="/reset-logout?id=${userId}" class="block bg-slate-800 border border-slate-700 text-slate-400 py-5 rounded-full text-center text-[10px] font-black uppercase">Logout</a></div></div><script>
            async function togglePause() { await fetch('/toggle-pause?id=${userId}'); location.reload(); }
            async function updateData() { try { const res = await fetch('/api/data?id=${userId}'); const d = await res.json(); 
                document.getElementById('balanceText').innerText = d.balance || "0.00"; 
                document.getElementById('profitText').innerText = (Number(d.profit || 0) * 124).toFixed(2);
                document.getElementById('targetText').innerText = d.targetBDT || "0"; 
                document.getElementById('pauseBtn').innerText = d.isPaused ? "RESUME" : "PAUSE";
                const pM = document.getElementById('pM'); const pB = document.getElementById('pB'); const pP = document.getElementById('pP');
                pP.innerText = "BTC: $" + (d.btcPrice || "0.00");
                if(d.status === "COMPLETED") { pM.innerText = "🎯 TARGET DONE - FLUSHING"; pM.className="text-[10px] font-black text-orange-400"; }
                else if(d.pulse === "BULLISH") { pM.innerText = "📈 Bullish ("+d.btcTrend+"%)"; pM.className="text-[10px] font-black text-green-400"; }
                else if(d.pulse === "BEARISH") { pM.innerText = "⚠️ Bearish ("+d.btcTrend+"%)"; pM.className="text-[10px] font-black text-red-500"; }
                else { pM.innerText = "⚖️ Stable ("+d.btcTrend+"%)"; pM.className="text-[10px] font-black text-sky-400"; }
                let h = ''; d.userSlots.forEach((s, i) => { 
                    h += \`<div class="p-5 bg-slate-900/40 backdrop-blur-sm rounded-3xl border border-zinc-800 mb-3 shadow-lg uppercase"><div class="flex justify-between items-center mb-3"><span class="text-[11px] font-black \${s.active ? 'text-sky-400' : 'text-zinc-700'} tracking-wider">\${s.active ? s.sym + ' [DCA:'+s.dca+']' : 'Slot '+(i+1)+' Idle'}</span>\${s.active ? \`<span class="text-[11px] font-black \${s.pnl>=0?'text-green-500':'text-red-400'}">\${s.pnl.toFixed(2)}% (৳\${s.netBDT.toFixed(2)})</span>\` : ''}</div>\${s.active ? \`<div class="w-full bg-black h-1.5 rounded-full overflow-hidden mb-4"><div class="h-full bg-sky-500 transition-all duration-1000" style="width: \${Math.max(0, Math.min(100, ((s.curP - s.buy) / (s.buy * 0.01)) * 100))}%"></div></div><div class="grid grid-cols-2 text-[10px] font-mono text-slate-500 gap-y-1"><div>Avg Buy: \${s.buy.toFixed(4)}</div><div class="text-right text-indigo-400 font-bold">Peak: \${(s.maxPnl || 0).toFixed(2)}%</div><div>Live: \${s.curP.toFixed(4)}</div><div class="text-right italic">Quantum v17 Active</div></div>\` : ''}</div>\`;
                }); document.getElementById('slotContainer').innerHTML = h; } catch(e) {} } setInterval(updateData, 1000);</script></body></html>`);
    }
});
server.listen(process.env.PORT || 8080, '0.0.0.0', () => startGlobalEngine());

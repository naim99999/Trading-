const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// 🛡️ Quantum AI Master v75.0 - Ultimate Master
// ==============================================
const MASTER_TG_TOKEN = "8281887575:AAG5OR86LCQO_90479FKkia2F1sEAJjCP60"; 
const FIXED_CHAT_ID = "5279510350"; 
const DB_FILE = 'nebula_master_final.json';

let cachedUsers = {}; 
try { if (fs.existsSync(DB_FILE)) cachedUsers = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) {}

function saveDB() { try { fs.writeFileSync(DB_FILE, JSON.stringify(cachedUsers, null, 2)); } catch(e) {} }

const COINS = [
    { s: "BTCUSDT", d: 2, qd: 3 }, { s: "ETHUSDT", d: 2, qd: 3 }, { s: "SOLUSDT", d: 3, qd: 2 }, 
    { s: "1000PEPEUSDT", d: 7, qd: 0 }, { s: "WIFUSDT", d: 4, qd: 1 },
    { s: "DOGEUSDT", d: 5, qd: 0 }, { s: "NEARUSDT", d: 4, qd: 1 }, { s: "AVAXUSDT", d: 3, qd: 1 },
    { s: "XRPUSDT", d: 4, qd: 1 }, { s: "SUIUSDT", d: 4, qd: 1 }, { s: "TIAUSDT", d: 4, qd: 1 },
    { s: "FETUSDT", d: 4, qd: 1 }, { s: "RNDRUSDT", d: 3, qd: 1 }, { s: "MATICUSDT", d: 4, qd: 1 },
    { s: "DOTUSDT", d: 3, qd: 1 }, { s: "ORDIUSDT", d: 3, qd: 1 }, { s: "APTUSDT", d: 3, qd: 1 },
    { s: "LDOUSDT", d: 4, qd: 1 }, { s: "ARBUSDT", d: 4, qd: 1 }, { s: "SHIBUSDT", d: 8, qd: 0 },
    { s: "LINKUSDT", d: 3, qd: 1 }, { s: "ADAUSDT", d: 4, qd: 1 }, { s: "ICPUSDT", d: 3, qd: 1 },
    { s: "JUPUSDT", d: 4, qd: 1 }, { s: "STXUSDT", d: 4, qd: 1 }, { s: "FILUSDT", d: 3, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, history: [], low: 0, vol: 0, btcTrend: 0, trend: 0 });

function calculateRSI(prices) {
    if (prices.length <= 14) return 45;
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
        const d = JSON.parse(data).data; if (!d || !market[d.s]) return;
        const s = market[d.s]; s.lp = s.p; s.p = parseFloat(d.c);
        s.history.push(s.p); if(s.history.length > 60) s.history.shift();
        s.trend = s.p > s.lp ? Math.min(10, (s.trend || 0) + 1) : (s.p < s.lp ? 0 : s.trend);
        if (s.p < s.low || s.low === 0) s.low = s.p;
        s.vol = Math.abs((s.p - s.lp) / s.lp * 100);
        if (d.s === "BTCUSDT" && s.history.length > 10) s.btcTrend = ((s.p - s.history[0]) / s.history[0] * 100);
    });

    setInterval(async () => {
        for (let uid in cachedUsers) {
            let u = cachedUsers[uid];
            let maxSl = parseInt(u.slots) || 5, feeR = u.fMode === 'bnb' ? 0.00045 : 0.0005;
            if (!u.userSlots) u.userSlots = [];
            if (!u.cooldowns) u.cooldowns = {};

            let guardian = u.userSlots.some(s => s.active && s.dca >= 3);
            if (u.isAuto) {
                let btc = market["BTCUSDT"]?.btcTrend || 0;
                u.tSpeed = btc > 0.05 ? "fast" : (btc < -0.1 ? "safe" : "normal");
            }

            u.userSlots.forEach(async (sl) => {
                if (!sl.active || sl.status !== 'TRADING') return;
                const ms = market[sl.sym]; if(!ms) return;
                sl.curP = ms.p; 
                let rawPnL = ((ms.p - sl.buy) / sl.buy) * 100 * u.lev;
                sl.pnl = rawPnL - (feeR * 200);

                let currentVal = parseFloat(sl.qty) * ms.p;
                let totalFeeVal = (sl.totalCost + currentVal) * feeR;
                sl.netBDT = ((currentVal - sl.totalCost) - totalFeeVal) * 124;

                if (rawPnL >= 0.30) {
                    let lockGap = 0.01; if (ms.trend >= 7) lockGap = 0.05;
                    let lockPoint = rawPnL - lockGap;
                    if (!sl.be || lockPoint > sl.slP) { sl.slP = lockPoint; sl.be = true; }
                }

                let dcaT = sl.dca === 0 ? -1.8 : (sl.dca === 1 ? -4.5 : -9.5);
                if (rawPnL <= dcaT && sl.dca < 5) {
                    if (await placeOrder(sl.sym, "BUY", sl.qty, u)) {
                        let stMV = parseFloat(sl.qty) * ms.p, stM = stMV / u.lev;
                        if(u.mode === 'demo') u.cap = Number(u.cap) - stM;
                        sl.totalCost += stMV; sl.qty = (parseFloat(sl.qty) * 2).toString(); sl.buy = sl.totalCost / parseFloat(sl.qty);
                        sl.dca++; sl.sell = sl.buy * 1.0035; sl.be = false; saveDB();
                        sendTG(`🌀 <b>DCA EXECUTED: #${sl.sym}</b>\n----------------------------------\n📊 ধাপ: লেভেল ${sl.dca}\n💰 মার্জিন: $${stM.toFixed(4)}\n📉 মোট মার্জিন ইনভেস্ট: $${(sl.totalCost / u.lev).toFixed(4)}\n----------------------------------`, u.cid);
                    }
                }

                let minProfitFloor = (Number(u.cap) < 10) ? 0.5 : 1.0;
                if ((ms.p >= sl.sell || (sl.be && rawPnL <= sl.slP)) && sl.netBDT >= minProfitFloor) {
                    sl.status = 'COOLING'; u.profit = Number(u.profit || 0) + (sl.netBDT / 124); u.count++;
                    if(u.mode === 'demo') u.cap = Number(u.cap) + (sl.netBDT / 124) + (sl.totalCost / u.lev);
                    sendTG(`✅ <b>TRADE CLOSED: #${sl.sym}</b>\n----------------------------------\n✨ নিট লাভ: ৳${sl.netBDT.toFixed(2)}\n📈 মোট জমা: ৳${(u.profit * 124).toFixed(2)}\n----------------------------------`, u.cid);
                    if(u.mode !== 'demo') await placeOrder(sl.sym, "SELL", sl.qty, u);
                    u.cooldowns[sl.sym] = Date.now() + (Number(u.cdSec || 300) * 1000);
                    setTimeout(() => { Object.assign(sl, { active: false, status: 'IDLE' }); saveDB(); }, 1200);
                }
            });

            const sIdx = u.userSlots.findIndex(sl => !sl.active);
            if (!u.isPaused && sIdx !== -1 && !guardian) {
                let rLim = u.tSpeed === 'fast' ? 48 : (u.tSpeed === 'safe' ? 35 : 42);
                let dLim = u.tSpeed === 'fast' ? 0.9975 : (u.tSpeed === 'safe' ? 0.9945 : 0.9965);
                for (let sym of Object.keys(market)) {
                    const ms = market[sym]; 
                    if (ms.p === 0 || ms.history.length < 20) continue;
                    if (u.cooldowns[sym] && Date.now() < u.cooldowns[sym]) continue;
                    
                    if (ms.p < (Math.max(...ms.history) * dLim) && calculateRSI(ms.history) < rLim && ms.p > (ms.low * 1.0003)) {
                        if (u.userSlots.filter(x => x.active && x.sym === sym).length === 0) {
                            let tV = Math.max(5.1, (u.cap * u.lev) / maxSl / 20), qty = (tV / ms.p).toFixed(COINS.find(c => c.s === sym).qd), mE = tV / u.lev;
                            if (await placeOrder(sym, "BUY", qty, u)) {
                                if(u.mode === 'demo') u.cap = Number(u.cap) - mE;
                                u.userSlots[sIdx] = { id: sIdx, active: true, status: 'TRADING', sym: sym, buy: ms.p, sell: ms.p * 1.0035, slP: 0, qty: qty, pnl: 0, curP: ms.p, dca: 0, totalCost: (parseFloat(qty) * ms.p), be: false, netBDT: -0.10 };
                                ms.low = 0; saveDB();
                                sendTG(`🚀 <b>SAFE ENTRY: #${sym}</b>\n----------------------------------\n💰 মার্জিন এন্ট্রি: $${mE.toFixed(4)}\n⚙️ মোড: ${u.isAuto ? 'অটো' : 'ম্যানুয়াল'} [${u.tSpeed.toUpperCase()}]\n----------------------------------`, u.cid);
                            }
                            break;
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
        let pS = btc.btcTrend > 0.05 ? "BULLISH" : (btc.btcTrend < -0.1 ? "BEARISH" : "NEUTRAL");
        let activeM = u?.userSlots?.reduce((a, s) => a + (s.active ? s.totalCost/u.lev : 0), 0) || 0;
        return res.end(JSON.stringify({ slots: u?.userSlots || [], profit: u ? (u.profit * 124).toFixed(2) : 0, count: u ? u.count : 0, isPaused: u?.isPaused || false, balance: (Number(rawB) - (u?.mode === 'demo' ? 0 : activeM)).toFixed(2), lev: u?.lev || 0, tSpeed: u?.tSpeed || 'normal', pulse: pS, btcVal: btc.btcTrend.toFixed(2), btcPrice: btc.p.toFixed(2), isAuto: u?.isAuto || false, guardian: u?.userSlots?.some(s => s.active && s.dca >= 3), cdSec: u?.cdSec || 300 }));
    }
    if (url.pathname === '/set-config') { let u = cachedUsers[url.searchParams.get('id')]; if (u) { u.tSpeed = url.searchParams.get('speed') || u.tSpeed; u.isAuto = url.searchParams.get('auto') === 'true'; u.cdSec = parseInt(url.searchParams.get('cd')) || 300; saveDB(); } res.writeHead(200); return res.end(); }
    if (url.pathname === '/register') { let id = url.searchParams.get('id'), cid = url.searchParams.get('cid'); cachedUsers[id] = { api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), cid: cid, cap: parseFloat(url.searchParams.get('cap'))||10, lev: parseInt(url.searchParams.get('lev'))||20, slots: parseInt(url.searchParams.get('slots'))||5, mode: url.searchParams.get('mode')||'live', fMode: url.searchParams.get('fmode')||'usdt', tSpeed: 'normal', profit: 0, count: 0, isPaused: false, isAuto: true, cdSec: 300, userSlots: [], cooldowns: {} }; saveDB(); sendTG("🚀 <b>System Active!</b>", cid); res.writeHead(302, { 'Location': '/' + id }); return res.end(); }
    if (url.pathname === '/reset-logout') { if (cachedUsers[userId]) { delete cachedUsers[userId]; saveDB(); } res.writeHead(302, { 'Location': '/' }); return res.end(); }
    if (url.pathname === '/toggle-pause') { let u = cachedUsers[url.searchParams.get('id')]; if (u) { u.isPaused = !u.isPaused; saveDB(); } res.writeHead(200); return res.end(); }
    if (url.pathname === '/reset') { let u = cachedUsers[url.searchParams.get('id')]; if (u) { u.profit = 0; u.count = 0; u.userSlots = []; u.cooldowns = {}; saveDB(); } res.writeHead(302, { 'Location': '/' + url.searchParams.get('id') }); return res.end(); }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !cachedUsers[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-6 flex items-center min-h-screen text-center"><div class="max-w-md mx-auto w-full space-y-6 uppercase font-black tracking-tighter"><h1 class="text-7xl text-sky-400">Quantum</h1><form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 border border-slate-800 text-left font-sans shadow-2xl"><input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none" required><div class="grid grid-cols-2 gap-2"><select name="mode" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select><select name="fmode" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><option value="usdt">Fee: USDT</option><option value="bnb">Fee: BNB</option></select></div><input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none"><input name="sec" placeholder="Binance Secret" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none"><input name="cid" placeholder="Chat ID" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none" value="${FIXED_CHAT_ID}"><div class="grid grid-cols-3 gap-2"><input name="cap" type="number" placeholder="Cap $" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><input name="lev" type="number" placeholder="Lev" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><input name="slots" type="number" placeholder="Slots" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"></div><button type="submit" class="w-full bg-sky-600 p-5 rounded-full font-black text-xl text-white uppercase">Start Dream</button></form></div></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-4 font-sans uppercase"><div class="max-w-xl mx-auto space-y-4">
        <div class="p-4 bg-slate-900 rounded-[2rem] border border-slate-800 shadow-lg relative overflow-hidden"><div id="pB" class="absolute top-0 left-0 h-1 transition-all duration-1000"></div><div class="flex justify-between items-center mt-1"><div><p class="text-[8px] text-slate-500 font-bold" id="gMsg">BTC Market Pulse</p><p class="text-[10px] font-black" id="pM">Syncing...</p><p class="text-[8px] text-slate-400" id="pP">BTC: $0.00</p></div><div class="flex gap-1"><button onclick="setConfig('fast', false)" id="btn-fast" class="px-2 py-2 rounded-lg text-[8px] font-black border border-slate-800">⚡</button><button onclick="setConfig('normal', false)" id="btn-normal" class="px-2 py-2 rounded-lg text-[8px] font-black border border-slate-800">⚖️</button><button onclick="setConfig('safe', false)" id="btn-safe" class="px-2 py-2 rounded-lg text-[8px] font-black border border-slate-800">🛡️</button><button onclick="setConfig('', true)" id="btn-auto" class="px-2 py-2 rounded-lg text-[8px] font-black border border-slate-800">🤖 AUTO</button></div></div></div>
        <div class="p-6 bg-slate-900 rounded-[2.5rem] border-2 border-sky-500/50 text-center shadow-2xl tracking-tighter"><p class="text-[10px] text-sky-400 font-bold mb-1 uppercase tracking-widest italic">Wallet Balance</p><p class="text-5xl font-black text-white">$<span id="balanceText">0.00</span></p><div class="mt-2 text-[10px] text-slate-500 font-bold flex justify-between px-10"><span>Lev: <span id="levText">0</span>x</span> <span>CD: <input type="number" id="cdIn" class="bg-transparent border-b border-sky-500 w-10 text-center outline-none" onchange="updateCD()">s</span></div></div><div class="grid grid-cols-2 gap-4 text-center"><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1">Growth (BDT)</p><p class="text-4xl font-black text-green-400">৳<span id="profitText">0</span></p></div><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1 uppercase tracking-widest font-black">Wins</p><p class="text-4xl font-black text-sky-400" id="countText">0</p></div></div><div id="slotContainer" class="space-y-3"></div><div class="grid grid-cols-2 gap-3 pt-4 uppercase"><button onclick="togglePause()" id="pauseBtn" class="py-5 rounded-full text-[10px] font-black bg-orange-900/20 border border-orange-500/30 text-orange-400">Pause</button><a href="/reset?id=${userId}" class="bg-red-900/20 border border-red-500/30 text-red-500 py-5 rounded-full text-center text-[10px] font-black">Reset</a></div><a href="/reset-logout?id=${userId}" onclick="return confirm('লগ আউট করবেন?')" class="block w-full bg-slate-800 border border-slate-700 text-slate-400 py-5 rounded-full text-center text-[10px] font-black">Logout & Reset</a></div><script>
            let currentCD = 300; let currentSpeed = 'normal'; let currentAuto = true;
            async function setConfig(s, a) { currentSpeed = s || currentSpeed; currentAuto = a; await fetch(\`/set-config?id=${userId}&speed=\${currentSpeed}&auto=\${currentAuto}&cd=\${currentCD}\`); updateData(); }
            async function updateCD() { currentCD = document.getElementById('cdIn').value; await setConfig(currentSpeed, currentAuto); }
            async function togglePause() { await fetch('/toggle-pause?id=${userId}'); location.reload(); }
            async function updateData() { try { const res = await fetch('/api/data?id=${userId}'); const d = await res.json(); document.getElementById('balanceText').innerText = d.balance; document.getElementById('profitText').innerText = d.profit; document.getElementById('countText').innerText = d.count; document.getElementById('levText').innerText = d.lev; document.getElementById('cdIn').value = d.cdSec; currentCD = d.cdSec;
                const pM = document.getElementById('pM'); const pB = document.getElementById('pB'); const gM = document.getElementById('gMsg'); const pP = document.getElementById('pP');
                pP.innerText = "BTC: $" + d.btcPrice;
                if(d.guardian) { gM.innerText = "🛡️ GUARDIAN ACTIVE"; gM.className="text-[8px] font-bold text-red-500 animate-pulse"; } else { gM.innerText = "BTC Market Pulse"; gM.className="text-[8px] text-slate-500 font-bold"; }
                if(d.pulse === "BULLISH") { pM.innerText = "📈 Market Bullish ("+d.btcVal+"%)"; pM.className="text-[10px] font-black text-green-400"; pB.className="absolute top-0 left-0 h-1 bg-green-500 w-full shadow-[0_0_10px_#22c55e]"; }
                else if(d.pulse === "BEARISH") { pM.innerText = "⚠️ Market Bearish ("+d.btcVal+"%)"; pM.className="text-[10px] font-black text-red-500"; pB.className="absolute top-0 left-0 h-1 bg-red-500 w-full shadow-[0_0_10px_#ef4444]"; }
                else { pM.innerText = "⚖️ Market Stable ("+d.btcVal+"%)"; pM.className="text-[10px] font-black text-sky-400"; pB.className="absolute top-0 left-0 h-1 bg-sky-500 w-full shadow-[0_0_10px_#0ea5e9]"; }
                ['fast', 'normal', 'safe'].forEach(m => { const b = document.getElementById('btn-'+m); if(b) { 
                    let isCurrent = (d.tSpeed === m);
                    if(d.isAuto) { b.className = isCurrent ? "px-2 py-2 rounded-lg text-[8px] font-black border-2 border-yellow-500 text-white" : "px-2 py-2 rounded-lg text-[8px] font-black border border-slate-800 text-slate-500"; }
                    else { b.className = isCurrent ? "px-2 py-2 rounded-lg text-[8px] font-black bg-sky-600 text-white" : "px-2 py-2 rounded-lg text-[8px] font-black border border-slate-800 text-slate-500"; }
                }});
                document.getElementById('btn-auto').className = d.isAuto ? "px-2 py-2 rounded-lg text-[8px] font-black bg-indigo-600 text-white shadow-[0_0_10px_#6366f1]" : "px-2 py-2 rounded-lg text-[8px] font-black border border-slate-800 text-slate-500";
                const pBtn = document.getElementById('pauseBtn'); pBtn.innerText = d.isPaused ? "RESUME" : "PAUSE"; pBtn.className = d.isPaused ? "flex-1 bg-green-900/20 border border-green-500/30 text-green-400 py-5 rounded-full text-[10px] font-black" : "flex-1 bg-orange-900/20 border border-orange-500/30 text-orange-400 py-5 rounded-full text-[10px] font-black";
                let h = ''; d.slots.forEach((s, i) => { let m = s.active ? Math.max(0, Math.min(100, ((s.curP - s.buy) / (s.sell - s.buy)) * 100)) : 0;
                    h += \`<div class="p-5 bg-slate-900/50 rounded-3xl border border-zinc-800 mb-3 shadow-lg uppercase"><div class="flex justify-between items-center mb-3"><span class="text-[11px] font-black \${s.active ? 'text-sky-400' : 'text-zinc-700'} tracking-wider">\${s.active ? s.sym : 'Slot '+(i+1)+' Scanning...'} \${s.active ? '[DCA:'+s.dca+']' : ''}</span>\${s.active ? \`<span class="text-[11px] font-black \${s.netBDT>=0?'text-green-500':'text-red-400'}">\${s.pnl.toFixed(2)}% (৳\${s.netBDT.toFixed(2)})</span>\` : ''}</div>\${s.active ? \`<div class="w-full bg-black h-1.5 rounded-full overflow-hidden mb-4"><div class="h-full bg-sky-500 transition-all duration-1000" style="width: \${m}%"></div></div><div class="grid grid-cols-2 text-[10px] font-mono text-slate-500 gap-y-1"><div>Buy: \${s.buy.toFixed(4)}</div><div class="text-right">Live: \${s.curP}</div><div class="text-indigo-400">Quantum Shield</div><div class="text-right text-green-500 font-bold">Dynamic Target</div></div>\` : ''}</div>\`;
                }); document.getElementById('slotContainer').innerHTML = h; } catch(e) {} } setInterval(updateData, 800);</script></body></html>`);
    }
});
server.listen(process.env.PORT || 8080, '0.0.0.0', () => startGlobalEngine());

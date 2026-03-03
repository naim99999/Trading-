const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// 🛡️ Quantum AI Master v70.0 - Full Optimized
// ==============================================
const MASTER_TG_TOKEN = "8281887575:AAG5OR86LCQO_90479FKkia2F1sEAJjCP60"; 
const FIXED_CHAT_ID = "5279510350"; 
const DB_FILE = 'nebula_master_final.json';

function getAllUsers() { try { if (!fs.existsSync(DB_FILE)) return {}; return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { return {}; } }
function saveUser(userId, data) { try { let users = getAllUsers(); users[userId] = { ...users[userId], ...data }; fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); } catch(e) {} }

const COINS = [
    { s: "BTCUSDT", d: 2, qd: 3 }, { s: "ETHUSDT", d: 2, qd: 3 }, { s: "SOLUSDT", d: 3, qd: 2 }, 
    { s: "1000PEPEUSDT", d: 7, qd: 0 }, { s: "BONKUSDT", d: 8, qd: 0 }, { s: "WIFUSDT", d: 4, qd: 1 },
    { s: "DOGEUSDT", d: 5, qd: 0 }, { s: "NEARUSDT", d: 4, qd: 1 }, { s: "AVAXUSDT", d: 3, qd: 1 },
    { s: "XRPUSDT", d: 4, qd: 1 }, { s: "SUIUSDT", d: 4, qd: 1 }, { s: "TIAUSDT", d: 4, qd: 1 },
    { s: "FETUSDT", d: 4, qd: 1 }, { s: "RNDRUSDT", d: 3, qd: 1 }, { s: "MATICUSDT", d: 4, qd: 1 },
    { s: "DOTUSDT", d: 3, qd: 1 }, { s: "ORDIUSDT", d: 3, qd: 1 }, { s: "APTUSDT", d: 3, qd: 1 },
    { s: "TRXUSDT", d: 5, qd: 0 }, { s: "LDOUSDT", d: 4, qd: 1 }, { s: "ARBUSDT", d: 4, qd: 1 },
    { s: "SHIBUSDT", d: 8, qd: 0 }, { s: "LINKUSDT", d: 3, qd: 1 }, { s: "ADAUSDT", d: 4, qd: 1 },
    { s: "GALAUSDT", d: 5, qd: 0 }, { s: "ICPUSDT", d: 3, qd: 1 }, { s: "JUPUSDT", d: 4, qd: 1 },
    { s: "BOMEUSDT", d: 6, qd: 0 }, { s: "STXUSDT", d: 4, qd: 1 }, { s: "FILUSDT", d: 3, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, trend: 0, history: [], low: 0, vol: 0 });

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
    if (c.mode === 'demo' || !c.api) return parseFloat(c.cap).toFixed(2);
    const ts = Date.now();
    const sig = sign(`timestamp=${ts}`, c.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?timestamp=${ts}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': c.api }, timeout: 5000 });
        return res.data ? parseFloat(res.data.totalWalletBalance).toFixed(2) : "0.00";
    } catch (e) { return "Error"; }
}

async function placeOrder(sym, side, qty, c) {
    if (c.mode === 'demo') return { orderId: 'DEMO' };
    const ts = Date.now();
    let q = `symbol=${sym}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${ts}`;
    try { return (await axios.post(`https://fapi.binance.com/fapi/v1/order?${q}&signature=${sign(q, c.sec)}`, null, { headers: { 'X-MBX-APIKEY': c.api } })).data; } catch (e) { return null; }
}

async function startGlobalEngine() {
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/')}`);
    ws.on('message', async (data) => {
        const payload = JSON.parse(data).data;
        if (!payload || !market[payload.s]) return;
        const s = market[payload.s];
        s.lp = s.p; s.p = parseFloat(payload.c);
        s.history.push(s.p); if(s.history.length > 50) s.history.shift();
        if (s.p < s.low || s.low === 0) s.low = s.p;
        s.vol = Math.abs((s.p - s.lp) / s.lp * 100);

        let db = getAllUsers();
        for (let uid in db) {
            let u = db[uid];
            let maxSl = parseInt(u.slots) || 5;
            let feeR = u.fMode === 'bnb' ? 0.00045 : 0.0005;

            if (!u.userSlots || u.userSlots.length !== maxSl) { u.userSlots = Array(maxSl).fill(null).map((_, i) => ({ id: i, active: false, sym: '', buy: 0, sell: 0, slP: 0, qty: 0, pnl: 0, curP: 0, dca: 0, totalCost: 0, be: false, status: 'IDLE' })); saveUser(uid, { userSlots: u.userSlots }); }

            u.userSlots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== payload.s || sl.status !== 'TRADING') return;
                sl.curP = s.p;
                let rawPnL = ((s.p - sl.buy) / sl.buy) * 100 * u.lev;
                sl.pnl = rawPnL - (feeR * 200);

                if (rawPnL >= 0.35) {
                    let newShield = sl.buy * (1 + (rawPnL - 0.10) / (100 * u.lev));
                    if (!sl.be || newShield > sl.slP) { sl.slP = newShield; sl.be = true; }
                    if (rawPnL >= (((sl.sell - sl.buy) / sl.buy) * 100 * u.lev) * 0.9) sl.sell = sl.buy * (1 + (rawPnL + 0.12) / (100 * u.lev));
                }

                let dcaT = sl.dca === 0 ? -1.8 : (sl.dca === 1 ? -4.5 : -9.5);
                if (rawPnL <= dcaT && sl.dca < 5) {
                    if (await placeOrder(sl.sym, "BUY", sl.qty, u)) {
                        let stMV = sl.qty * s.p, stM = stMV / u.lev, stF = stMV * feeR;
                        if(u.mode === 'demo') u.cap = parseFloat(u.cap) - stM;
                        sl.totalCost += stMV; sl.qty = (parseFloat(sl.qty) * 2).toString(); sl.buy = sl.totalCost / parseFloat(sl.qty);
                        sl.dca++; sl.sell = sl.buy * 1.0035; sl.be = false; saveUser(uid, { cap: u.cap, userSlots: u.userSlots });
                        sendTG(`🌀 <b>DCA EXECUTED: #${sl.sym}</b>\n----------------------------------\n📊 ধাপ: লেভেল ${sl.dca}\n🎯 ট্রিগার: $${s.p}\n📉 নতুন গড়: $${sl.buy.toFixed(4)}\n💰 বর্তমান মার্জিন: $${stM.toFixed(4)}\n⛽ ফী: $${stF.toFixed(4)}\n📊 বর্তমান মোট: $${(stM + stF).toFixed(4)}\n📉 মোট মার্জিন ইনভেস্ট: $${(sl.totalCost / u.lev).toFixed(4)}\n----------------------------------`, u.cid);
                    }
                }

                let tV = sl.totalCost + (parseFloat(sl.qty) * s.p), exF = tV * feeR, gG = (parseFloat(sl.qty) * s.p) - sl.totalCost, nG = gG - exF;
                if ((s.p >= sl.sell || (sl.be && s.p <= sl.slP)) && (nG * 124) >= 1) {
                    sl.status = 'COOLING'; u.profit = (u.profit || 0) + nG; u.count = (u.count || 0) + 1;
                    if(u.mode === 'demo') u.cap = parseFloat(u.cap) + nG + (sl.totalCost / u.lev);
                    sendTG(`✅ <b>TRADE CLOSED: #${sl.sym}</b>\n----------------------------------\n💵 গ্রস প্রফিট: ৳${(gG * 124).toFixed(2)}\n⛽ মোট ফী: ৳${(exF * 124).toFixed(2)}\n✨ নিট লাভ: ৳${(nG * 124).toFixed(2)}\n📈 মোট জমা: ৳${(u.profit * 124).toFixed(2)}\n----------------------------------`, u.cid);
                    if(u.mode !== 'demo') await placeOrder(sl.sym, "SELL", sl.qty, u);
                    setTimeout(() => { sl.active = false; sl.status = 'IDLE'; saveUser(uid, { profit: u.profit, count: u.count, cap: u.cap, userSlots: u.userSlots }); }, 1000);
                }
            });

            // Auto-Pilot & Speed Selection
            let totalVol = 0; Object.values(market).forEach(m => totalVol += m.vol);
            let avgV = totalVol / COINS.length, sugg = avgV > 0.4 ? "safe" : (avgV < 0.15 ? "fast" : "normal");
            if (u.isAuto) u.tSpeed = sugg;

            let rLim = u.tSpeed === 'fast' ? 48 : (u.tSpeed === 'safe' ? 35 : 42);
            let dLim = u.tSpeed === 'fast' ? 0.9975 : (u.tSpeed === 'safe' ? 0.9945 : 0.9965);

            const sIdx = u.userSlots.findIndex(sl => !sl.active);
            if (!u.isPaused && sIdx !== -1 && s.p < (Math.max(...s.history) * dLim) && calculateRSI(s.history) < rLim && s.p > (s.low * 1.0003)) {
                if (u.userSlots.filter(sl => sl.active && sl.sym === payload.s).length === 0) {
                    let tV = Math.max(5, (u.cap * u.lev) / maxSl / 20), qty = (tV / s.p).toFixed(COINS.find(c => c.s === payload.s).qd), mE = tV / u.lev, eF = tV * feeR;
                    if (await placeOrder(payload.s, "BUY", qty, u)) {
                        if(u.mode === 'demo') u.cap = parseFloat(u.cap) - mE;
                        u.userSlots[sIdx] = { id: sIdx, active: true, status: 'TRADING', sym: payload.s, buy: s.p, sell: s.p * 1.0040, slP: 0, qty: qty, pnl: 0, curP: s.p, dca: 0, totalCost: (parseFloat(qty) * s.p), be: false };
                        s.low = 0; saveUser(uid, { cap: u.cap, userSlots: u.userSlots });
                        sendTG(`🚀 <b>SAFE ENTRY: #${payload.s}</b>\n----------------------------------\n💰 মার্জিন এন্ট্রি: $${mE.toFixed(4)}\n⛽ ফী: $${eF.toFixed(4)}\n📉 মোট খরচ: $${(mE + eF).toFixed(4)}\n----------------------------------`, u.cid);
                    }
                }
            }
        }
    });
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}

const server = http.createServer(async (req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    if (url.pathname === '/api/data') {
        const u = db[url.searchParams.get('id')];
        const rawB = await getBinanceBalance(u || {});
        let totalVol = 0; Object.values(market).forEach(m => totalVol += m.vol);
        let sugg = (totalVol / COINS.length) > 0.4 ? "SAFE" : ((totalVol / COINS.length) < 0.15 ? "FAST" : "NORMAL");
        let activeM = u?.userSlots?.reduce((a, s) => a + (s.active ? s.totalCost/u.lev : 0), 0) || 0;
        return res.end(JSON.stringify({ slots: u?.userSlots || [], profit: u ? (u.profit * 124).toFixed(2) : 0, count: u ? u.count : 0, isPaused: u?.isPaused || false, balance: (parseFloat(rawB) - (u?.mode === 'demo' ? 0 : activeM)).toFixed(2), lev: u?.lev || 0, tSpeed: u?.tSpeed || 'normal', sugg: sugg, isAuto: u?.isAuto || false }));
    }

    if (url.pathname === '/set-speed') { let u = db[url.searchParams.get('id')]; if (u) { u.tSpeed = url.searchParams.get('speed'); u.isAuto = url.searchParams.get('auto') === 'true'; saveUser(url.searchParams.get('id'), { tSpeed: u.tSpeed, isAuto: u.isAuto }); } res.writeHead(200); return res.end(); }
    if (url.pathname === '/register') { let id = url.searchParams.get('id'), cid = url.searchParams.get('cid'); saveUser(id, { api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), cid: cid, cap: parseFloat(url.searchParams.get('cap'))||10, lev: parseInt(url.searchParams.get('lev'))||20, slots: parseInt(url.searchParams.get('slots'))||5, mode: url.searchParams.get('mode')||'live', fMode: url.searchParams.get('fmode')||'usdt', tSpeed: 'normal', profit: 0, count: 0, isPaused: false, isAuto: false, userSlots: [] }); sendTG("🚀 <b>System Active!</b>", cid); res.writeHead(302, { 'Location': '/' + id }); return res.end(); }
    if (url.pathname === '/toggle-pause') { let u = db[url.searchParams.get('id')]; if (u) { u.isPaused = !u.isPaused; saveUser(url.searchParams.get('id'), {isPaused: u.isPaused}); } res.writeHead(200); return res.end(); }
    if (url.pathname === '/reset') { let u = db[url.searchParams.get('id')]; if (u) { u.profit = 0; u.count = 0; u.userSlots = []; saveUser(url.searchParams.get('id'), u); } res.writeHead(302, { 'Location': '/' + url.searchParams.get('id') }); return res.end(); }
    if (url.pathname === '/reset-logout') { if (db[userId]) { delete db[userId]; fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } res.writeHead(302, { 'Location': '/' }); return res.end(); }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-6 flex items-center min-h-screen text-center"><div class="max-w-md mx-auto w-full space-y-6 uppercase font-black tracking-tighter"><h1 class="text-7xl text-sky-400">Quantum</h1><form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 border border-slate-800 text-left font-sans not-italic tracking-normal shadow-2xl"><input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none" required><div class="grid grid-cols-2 gap-2"><select name="mode" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select><select name="fmode" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><option value="usdt">Fee: USDT</option><option value="bnb">Fee: BNB</option></select></div><input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none"><input name="sec" placeholder="Binance Secret" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none"><input name="cid" placeholder="Chat ID" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none" value="${FIXED_CHAT_ID}"><div class="grid grid-cols-3 gap-2"><input name="cap" type="number" placeholder="Cap $" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><input name="lev" type="number" placeholder="Lev" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><input name="slots" type="number" placeholder="Slots" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"></div><button type="submit" class="w-full bg-sky-600 p-5 rounded-full font-black text-xl text-white uppercase">Start Dream</button></form></div></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-4 font-sans uppercase"><div class="max-w-xl mx-auto space-y-4">
        <div class="p-5 bg-slate-900 rounded-[2rem] border border-slate-800 flex justify-between items-center shadow-lg">
            <div><p class="text-[9px] text-slate-500 font-bold mb-1">Market Intel</p><p class="text-[10px] font-black" id="intelMsg">Analysis...</p></div>
            <div class="flex gap-1">
                <button onclick="setSpeed('fast', false)" id="btn-fast" class="px-2 py-2 rounded-lg text-[8px] font-black border border-slate-800">Fast</button>
                <button onclick="setSpeed('normal', false)" id="btn-normal" class="px-2 py-2 rounded-lg text-[8px] font-black border border-slate-800">Norm</button>
                <button onclick="setSpeed('safe', false)" id="btn-safe" class="px-2 py-2 rounded-lg text-[8px] font-black border border-slate-800">Safe</button>
                <button onclick="setSpeed('', true)" id="btn-auto" class="px-2 py-2 rounded-lg text-[8px] font-black border border-slate-800">Auto</button>
            </div>
        </div>
        <div class="p-6 bg-slate-900 rounded-[2.5rem] border-2 border-sky-500/50 text-center shadow-2xl tracking-tighter"><p class="text-[10px] text-sky-400 font-bold mb-1 tracking-widest uppercase italic">Wallet Balance</p><p class="text-5xl font-black text-white">$<span id="balanceText">0.00</span></p><div class="mt-2 text-[10px] text-slate-500 font-bold">Leverage: <span id="levText">0</span>x</div></div><div class="grid grid-cols-2 gap-4 text-center"><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1">Growth (BDT)</p><p class="text-4xl font-black text-green-400">৳<span id="profitText">0</span></p></div><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1 uppercase tracking-widest font-black">Wins</p><p class="text-4xl font-black text-sky-400" id="countText">0</p></div></div><div id="slotContainer" class="space-y-3"></div><div class="grid grid-cols-2 gap-3 pt-4 uppercase"><button onclick="togglePause()" id="pauseBtn" class="py-5 rounded-full text-[10px] font-black bg-orange-900/20 border border-orange-500/30 text-orange-400 tracking-widest font-black">Pause</button><a href="/reset?id=${userId}" onclick="return confirm('রিসেট করবেন?')" class="bg-red-900/20 border border-red-500/30 text-red-500 py-5 rounded-full text-center text-[10px] font-black tracking-widest italic uppercase">Reset</a></div><a href="/reset-logout?id=${userId}" onclick="return confirm('লগ আউট করবেন?')" class="block w-full bg-slate-800 border border-slate-700 text-slate-400 py-5 rounded-full text-center text-[10px] font-black tracking-widest uppercase">Logout & Reset</a></div>
        <script>
            async function setSpeed(s, a) { await fetch('/set-speed?id=${userId}&speed='+s+'&auto='+a); updateData(); }
            async function togglePause() { await fetch('/toggle-pause?id=${userId}'); location.reload(); }
            async function updateData() { try {
                const res = await fetch('/api/data?id=${userId}'); const d = await res.json();
                document.getElementById('balanceText').innerText = d.balance; document.getElementById('profitText').innerText = d.profit;
                document.getElementById('countText').innerText = d.count; document.getElementById('levText').innerText = d.lev;
                const intel = document.getElementById('intelMsg');
                if(d.sugg === "SAFE") { intel.innerText = "⚠️ DANGER! SWITCH TO SAFE"; intel.className = "text-[10px] font-black text-red-500"; }
                else if(d.sugg === "FAST") { intel.innerText = "📈 STABLE. FAST RECOMMENDED"; intel.className = "text-[10px] font-black text-green-500"; }
                else { intel.innerText = "⚖️ NEUTRAL. NORMAL IS BEST"; intel.className = "text-[10px] font-black text-sky-400"; }
                ['fast', 'normal', 'safe'].forEach(m => { const b = document.getElementById('btn-'+m); b.className = (d.tSpeed === m && !d.isAuto) ? "px-2 py-2 rounded-lg text-[8px] font-black bg-sky-600 text-white" : "px-2 py-2 rounded-lg text-[8px] font-black border border-slate-800 text-slate-500"; });
                document.getElementById('btn-auto').className = d.isAuto ? "px-2 py-2 rounded-lg text-[8px] font-black bg-green-600 text-white" : "px-2 py-2 rounded-lg text-[8px] font-black border border-slate-800 text-slate-500";
                const pBtn = document.getElementById('pauseBtn'); pBtn.innerText = d.isPaused ? "RESUME" : "PAUSE"; pBtn.className = d.isPaused ? "flex-1 bg-green-900/20 border border-green-500/30 text-green-400 py-5 rounded-full text-[10px] font-black" : "flex-1 bg-orange-900/20 border border-orange-500/30 text-orange-400 py-5 rounded-full text-[10px] font-black";
                let h = ''; d.slots.forEach((s, i) => { let m = s.active ? Math.max(0, Math.min(100, ((s.curP - s.buy) / (s.sell - s.buy)) * 100)) : 0;
                    h += \`<div class="p-5 bg-slate-900/50 rounded-3xl border border-zinc-800 transition-all duration-300 mb-3 shadow-lg uppercase">
                        <div class="flex justify-between items-center mb-3"><span class="text-[11px] font-black \${s.active ? 'text-sky-400' : 'text-zinc-700'} tracking-wider">\${s.active ? s.sym : 'Slot '+(i+1)+' Scanning...'} \${s.active ? '[DCA:'+s.dca+']' : ''}</span>\${s.active ? \`<span class="text-[11px] font-black \${s.pnl>=0?'text-green-500':'text-red-400'}">\${s.pnl.toFixed(2)}%</span>\` : ''}</div>
                        \${s.active ? \`<div class="w-full bg-black h-1.5 rounded-full overflow-hidden mb-4"><div class="h-full bg-sky-500 transition-all duration-1000" style="width: \${m}%"></div></div>
                        <div class="grid grid-cols-2 text-[10px] font-mono text-slate-500 gap-y-1"><div>Buy: \${s.buy.toFixed(4)}</div><div class="text-right">Live: \${s.curP}</div><div class="text-orange-400">Quantum Shield</div><div class="text-right text-green-500 font-bold">Dynamic Target</div></div>\` : ''}
                    </div>\`;
                }); document.getElementById('slotContainer').innerHTML = h;
            } catch(e) {} } setInterval(updateData, 800);
        </script></body></html>`);
    }
});
server.listen(process.env.PORT || 8080, '0.0.0.0', () => startGlobalEngine());

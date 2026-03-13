const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// 🛡️ Quantum AI Master v101.0 - GALA Hunter (Special)
// ==============================================
const MASTER_TG_TOKEN = "8281887575:AAG5OR86LCQO_90479FKkia2F1sEAJjCP60"; 
const FIXED_CHAT_ID = "5279510350"; 
const DB_FILE = 'nebula_master_final.json';

let cachedUsers = {}; 
function loadDB() { try { if (fs.existsSync(DB_FILE)) cachedUsers = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { cachedUsers = {}; } }
function saveDB() { try { fs.writeFileSync(DB_FILE, JSON.stringify(cachedUsers, null, 2)); } catch(e) {} }
loadDB();

// শুধুমাত্র GALA কয়েন
const TARGET_COIN = { s: "GALAUSDT", d: 5, qd: 0 };

let market = { p: 0, lp: 0, history: [], low: 0, trend: 0 };

function sign(q, s) { return crypto.createHmac('sha256', s).update(q).digest('hex'); }
async function sendTG(m, id) { try { await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: id || FIXED_CHAT_ID, text: m, parse_mode: 'HTML' }); } catch(e) {} }

async function getBinanceBalance(c) {
    if (c.mode === 'demo' || !c.api) return parseFloat(c.cap || 0).toFixed(2);
    const ts = Date.now(); const sig = sign(`timestamp=${ts}`, c.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?timestamp=${ts}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': c.api }, timeout: 5000 });
        return res.data ? parseFloat(res.data.totalWalletBalance).toFixed(2) : "0.00";
    } catch (e) { return "0.00"; }
}

async function placeOrder(side, qty, c) {
    if (c.mode === 'demo') return { orderId: 'DEMO_' + Date.now() };
    const ts = Date.now(); let q = `symbol=${TARGET_COIN.s}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${ts}`;
    try { return (await axios.post(`https://fapi.binance.com/fapi/v1/order?${q}&signature=${sign(q, c.sec)}`, null, { headers: { 'X-MBX-APIKEY': c.api } })).data; } catch (e) { return null; }
}

async function startGlobalEngine() {
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${TARGET_COIN.s.toLowerCase()}@ticker`);
    ws.on('message', (data) => {
        const d = JSON.parse(data).data; if (!d) return;
        market.lp = market.p; market.p = parseFloat(d.c);
        market.history.push(market.p); if(market.history.length > 30) market.history.shift();
        market.trend = market.p > market.lp ? Math.min(10, (market.trend || 0) + 1) : (market.p < market.lp ? 0 : market.trend);
        if (market.p < market.low || market.low === 0) market.low = market.p;
    });

    setInterval(async () => {
        if (market.p === 0) return;
        for (let uid in cachedUsers) {
            let u = cachedUsers[uid]; let feeR = u.fMode === 'bnb' ? 0.00045 : 0.0005;
            if (!u.userSlots) { u.userSlots = [{ id: 0, active: false, sym: TARGET_COIN.s, buy: 0, sell: 0, slP: 0, qty: 0, pnl: 0, curP: 0, dca: 0, totalCost: 0, be: false, status: 'IDLE', netBDT: 0 }]; saveDB(); }
            let sl = u.userSlots[0];

            if (sl.active && sl.status === 'TRADING') {
                sl.curP = market.p;
                let rawPnL = ((market.p - sl.buy) / sl.buy) * 100 * u.lev;
                sl.pnl = rawPnL - (feeR * 200);
                let currentVal = parseFloat(sl.qty) * market.p;
                sl.netBDT = ((currentVal - sl.totalCost) - (sl.totalCost + currentVal) * feeR) * 124;

                // ট্রেইলিং লক: লাভ ১ টাকা ছাড়িয়ে গেলেই কাজ শুরু করবে
                if (sl.netBDT >= 1) {
                    let lockGap = (market.trend >= 7) ? 0.05 : 0.01;
                    let lockPoint = rawPnL - lockGap;
                    if (!sl.be || lockPoint > sl.slP) { sl.slP = lockPoint; sl.be = true; }
                }

                // স্মার্ট DCA: ৫ ডলার পুঁজি প্রটেকশন
                let dcaT = sl.dca === 0 ? -1.5 : -4.0;
                if (rawPnL <= dcaT && sl.dca < 3 && (sl.totalCost / u.lev) * 2 < (u.cap * 0.9)) {
                    if (await placeOrder("BUY", sl.qty, u)) {
                        let stM = (parseFloat(sl.qty) * market.p) / u.lev;
                        if(u.mode === 'demo') u.cap = Number(u.cap) - stM;
                        sl.totalCost += (parseFloat(sl.qty) * market.p); sl.qty = (parseFloat(sl.qty) * 2).toString();
                        sl.buy = sl.totalCost / parseFloat(sl.qty); sl.dca++; sl.sell = sl.buy * 1.0030; sl.be = false; saveDB();
                        sendTG(`🌀 <b>GALA DCA: L${sl.dca}</b>\n💰 খরচ: $${stM.toFixed(4)}\n📉 গড় মূল্য: $${sl.buy.toFixed(5)}`, u.cid);
                    }
                }

                // ক্লোজিং
                if ((market.p >= sl.sell || (sl.be && rawPnL <= sl.slP)) && sl.netBDT >= 1) {
                    sl.status = 'COOLING'; u.profit = Number(u.profit || 0) + (sl.netBDT / 124); u.count++;
                    if(u.mode === 'demo') u.cap = Number(u.cap) + (sl.netBDT / 124) + (sl.totalCost / u.lev);
                    sendTG(`✅ <b>GALA PROFIT</b>\n✨ নিট লাভ: ৳${sl.netBDT.toFixed(2)}\n📈 মোট জমা: ৳${(u.profit * 124).toFixed(0)}`, u.cid);
                    if(u.mode !== 'demo') await placeOrder("SELL", sl.qty, u);
                    u.lastTrade = Date.now();
                    setTimeout(() => { Object.assign(sl, { active: false, status: 'IDLE' }); saveDB(); }, 30000); // ৩০ সেকেন্ড কুলডাউন
                }
            } else if (!sl.active && !u.isPaused) {
                // এন্ট্রি লজিক: সামান্য ডিপ (০.০৫%) এবং রিভার্সাল দেখলেই বাই
                const localHigh = Math.max(...market.history);
                if (market.p < (localHigh * 0.9995) && market.p > (market.low * 1.0001)) {
                    if (!u.lastTrade || Date.now() > u.lastTrade + 30000) {
                        let tV = Math.max(5.1, (u.cap * u.lev) / 20), qty = (tV / market.p).toFixed(TARGET_COIN.qd);
                        if (await placeOrder("BUY", qty, u)) {
                            if(u.mode === 'demo') u.cap = Number(u.cap) - (tV/u.lev);
                            Object.assign(sl, { active: true, status: 'TRADING', sym: TARGET_COIN.s, buy: market.p, sell: market.p * 1.0035, slP: 0, qty: qty, pnl: 0, curP: market.p, dca: 0, totalCost: (parseFloat(qty) * market.p), be: false, netBDT: -0.05 });
                            market.low = 0; saveDB();
                            sendTG(`🚀 <b>GALA ENTRY</b>\n💰 মার্জিন: $${(tV/u.lev).toFixed(4)}`, u.cid);
                        }
                    }
                }
            }
        }
    }, 1000); // প্রতি ১ সেকেন্ডে চেকিং
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`); const userId = url.pathname.slice(1);
    if (url.pathname === '/api/data') {
        const u = cachedUsers[url.searchParams.get('id')]; const rawB = await getBinanceBalance(u || {});
        let activeM = u?.userSlots?.reduce((a, s) => a + (s.active ? s.totalCost/u.lev : 0), 0) || 0;
        return res.end(JSON.stringify({ slots: u?.userSlots || [], profit: u ? (u.profit * 124).toFixed(2) : 0, count: u ? u.count : 0, isPaused: u?.isPaused || false, balance: (Number(rawB) - (u?.mode === 'demo' ? 0 : activeM)).toFixed(2), lev: u?.lev || 0, btcPrice: market.p.toFixed(5) }));
    }
    if (url.pathname === '/register') { let id = url.searchParams.get('id'), cid = url.searchParams.get('cid'); cachedUsers[id] = { api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), cid: cid, cap: parseFloat(url.searchParams.get('cap'))||5, lev: parseInt(url.searchParams.get('lev'))||20, slots: 1, mode: url.searchParams.get('mode')||'live', fMode: url.searchParams.get('fmode')||'usdt', profit: 0, count: 0, isPaused: false, userSlots: [] }; saveDB(); sendTG("🚀 <b>GALA Hunter Ready!</b>", cid); res.writeHead(302, { 'Location': '/' + id }); return res.end(); }
    if (url.pathname === '/reset-logout') { if (cachedUsers[userId]) { delete cachedUsers[userId]; saveDB(); } res.writeHead(302, { 'Location': '/' }); return res.end(); }
    if (url.pathname === '/toggle-pause') { let u = cachedUsers[url.searchParams.get('id')]; if (u) { u.isPaused = !u.isPaused; saveDB(); } res.writeHead(200); return res.end(); }
    if (url.pathname === '/reset') { let u = cachedUsers[url.searchParams.get('id')]; if (u) { u.profit = 0; u.count = 0; u.userSlots = []; saveDB(); } res.writeHead(302, { 'Location': '/' + url.searchParams.get('id') }); return res.end(); }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !cachedUsers[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-6 flex items-center min-h-screen text-center"><div class="max-w-md mx-auto w-full space-y-6 uppercase font-black tracking-tighter"><h1 class="text-7xl text-sky-400">GALA</h1><form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 border border-slate-800 text-left font-sans shadow-2xl"><input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none" required><div class="grid grid-cols-2 gap-2"><select name="mode" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select><select name="fmode" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><option value="usdt">Fee: USDT</option><option value="bnb">Fee: BNB</option></select></div><input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none"><input name="sec" placeholder="Binance Secret" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none"><input name="cid" placeholder="Chat ID" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none" value="${FIXED_CHAT_ID}"><div class="grid grid-cols-2 gap-2"><input name="cap" type="number" placeholder="Cap $" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><input name="lev" type="number" placeholder="Lev" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"></div><button type="submit" class="w-full bg-sky-600 p-5 rounded-full font-black text-xl text-white uppercase">Hunt GALA</button></form></div></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-4 font-sans uppercase"><div class="max-width-xl mx-auto space-y-4">
        <div class="p-6 bg-slate-900 rounded-[2.5rem] border-2 border-sky-500/50 text-center shadow-2xl tracking-tighter">
            <p class="text-[10px] text-sky-400 font-bold mb-1 uppercase tracking-widest italic">GALA Live Price</p>
            <p class="text-4xl font-black text-white">$<span id="btcPrice">0.00000</span></p>
        </div>
        <div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl text-center">
            <p class="text-[10px] text-slate-500 font-bold mb-1">Wallet Balance</p>
            <p class="text-5xl font-black text-white">$<span id="balanceText">0.00</span></p>
        </div>
        <div class="grid grid-cols-2 gap-4 text-center">
            <div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1">Profit</p><p class="text-4xl font-black text-green-400">৳<span id="profitText">0</span></p></div>
            <div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1">Wins</p><p class="text-4xl font-black text-sky-400" id="countText">0</p></div>
        </div>
        <div id="slotContainer" class="space-y-3"></div>
        <div class="grid grid-cols-2 gap-3 pt-4 uppercase"><button onclick="togglePause()" id="pauseBtn" class="py-5 rounded-full text-[10px] font-black bg-orange-900/20 border border-orange-500/30 text-orange-400">Pause</button><a href="/reset?id=${userId}" class="bg-red-900/20 border border-red-500/30 text-red-500 py-5 rounded-full text-center text-[10px] font-black">Reset</a></div>
        <a href="/reset-logout?id=${userId}" class="block w-full bg-slate-800 border border-slate-700 text-slate-400 py-5 rounded-full text-center text-[10px] font-black uppercase shadow-xl">Logout & Reset</a></div><script>
            async function togglePause() { await fetch('/toggle-pause?id=${userId}'); location.reload(); }
            async function updateData() { try { const res = await fetch('/api/data?id=${userId}'); const d = await res.json(); 
                document.getElementById('balanceText').innerText = d.balance; document.getElementById('profitText').innerText = d.profit;
                document.getElementById('countText').innerText = d.count; document.getElementById('btcPrice').innerText = d.btcPrice;
                const pBtn = document.getElementById('pauseBtn'); pBtn.innerText = d.isPaused ? "RESUME" : "PAUSE";
                let h = ''; d.slots.forEach((s, i) => { let m = s.active ? Math.max(0, Math.min(100, ((s.curP - s.buy) / (s.sell - s.buy)) * 100)) : 0;
                    h += \`<div class="p-5 bg-slate-900/50 rounded-3xl border border-zinc-800 mb-3 shadow-lg uppercase"><div class="flex justify-between items-center mb-3"><span class="text-[11px] font-black \${s.active ? 'text-sky-400' : 'text-zinc-700'} tracking-wider">\${s.active ? 'GALA [DCA:'+s.dca+']' : 'HUNTING GALA...'}</span>\${s.active ? \`<span class="text-[11px] font-black \${s.netBDT>=0?'text-green-500':'text-red-400'}">\${s.pnl.toFixed(2)}% (৳\${s.netBDT.toFixed(2)})</span>\` : ''}</div>\${s.active ? \`<div class="w-full bg-black h-1.5 rounded-full overflow-hidden mb-4"><div class="h-full bg-sky-500 transition-all duration-1000" style="width: \${m}%"></div></div><div class="grid grid-cols-2 text-[10px] font-mono text-slate-500 gap-y-1"><div>Buy: \${s.buy.toFixed(5)}</div><div class="text-right">Live: \${s.curP}</div><div class="text-indigo-400">Hunter Mode</div><div class="text-right text-green-500 font-bold">Dynamic Target</div></div>\` : ''}</div>\`;
                }); document.getElementById('slotContainer').innerHTML = h; } catch(e) {} } setInterval(updateData, 800);</script></body></html>`);
    }
});
server.listen(process.env.PORT || 8080, '0.0.0.0', () => startGlobalEngine());

const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// 👑 QUANTUM AI MASTER v76.0 - BOTTOM SNIPER (LIMIT-ONLY)
// ==============================================
const MASTER_TG_TOKEN = "8281887575:AAG5OR86LCQO_90479FKkia2F1sEAJjCP60"; 
const FIXED_CHAT_ID = "5279510350"; 
const DB_FILE = 'quantum_ai_v76_master.json';

let cachedUsers = {}; 
function loadDB() { try { if (fs.existsSync(DB_FILE)) cachedUsers = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { cachedUsers = {}; } }
function saveDB() { try { fs.writeFileSync(DB_FILE, JSON.stringify(cachedUsers, null, 2)); } catch(e) {} }
loadDB();

const COINS = [
    { s: "BTCUSDT", d: 2, qd: 3 }, { s: "ETHUSDT", d: 2, qd: 3 }, { s: "SOLUSDT", d: 3, qd: 2 }, 
    { s: "BNBUSDT", d: 2, qd: 2 }, { s: "AVAXUSDT", d: 3, qd: 1 }, { s: "NEARUSDT", d: 4, qd: 1 }, 
    { s: "SUIUSDT", d: 4, qd: 1 }, { s: "APTUSDT", d: 3, qd: 1 }, { s: "GALAUSDT", d: 5, qd: 0 }, { s: "PEPEUSDT", d: 8, qd: 0 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, b: 0, a: 0, history: [], ema7: 0, rsi: 50, buyVol: 0, sellVol: 0 });

function calculateEMA(p, n) { if (p.length < n) return p[p.length-1]; let k = 2/(n+1), ema = p[0]; for(let i=1; i<p.length; i++) ema = p[i]*k + ema*(1-k); return ema; }
function calculateRSI(p) { if (p.length <= 14) return 50; let g=0, l=0; for(let i=1; i<=14; i++) { let d = p[p.length-i] - p[p.length-i-1]; d>=0 ? g+=d : l-=d; } return 100 - (100/(1+(g/(l||1)))); }
function sign(q, s) { return crypto.createHmac('sha256', s).update(q).digest('hex'); }
async function sendTG(m, id) { try { await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: id || FIXED_CHAT_ID, text: m, parse_mode: 'HTML' }); } catch(e) {} }

async function getBinanceBalance(u) {
    if (u.mode === 'demo') return { bal: Number(u.cap || 0).toFixed(2), status: "DEMO" };
    const ts = Date.now(); const sig = sign(`timestamp=${ts}`, u.sec);
    try { const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?timestamp=${ts}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': u.api }, timeout: 5000 }); return { bal: parseFloat(res.data.totalWalletBalance).toFixed(2), status: "CONNECTED" }; } 
    catch (e) { return { bal: "0.00", status: "AUTH_ERROR" }; }
}

async function placeOrder(sym, side, qty, u, price = null) {
    if (u.mode === 'demo') return { orderId: 'DEMO_' + Date.now(), status: 'FILLED' };
    const ts = Date.now();
    let type = price ? "LIMIT" : "MARKET";
    let q = `symbol=${sym}&side=${side}&type=${type}&quantity=${qty}&timestamp=${ts}`;
    if (price) q += `&price=${price}&timeInForce=GTC`;
    try { const res = await axios.post(`https://fapi.binance.com/fapi/v1/order?${q}&signature=${sign(q, u.sec)}`, null, { headers: { 'X-MBX-APIKEY': u.api } }); return res.data; } catch (e) { return null; }
}

async function cancelOrder(sym, orderId, u) {
    if (u.mode === 'demo' || !orderId) return true;
    const ts = Date.now(); let q = `symbol=${sym}&orderId=${orderId}&timestamp=${ts}`;
    try { await axios.delete(`https://fapi.binance.com/fapi/v1/order?${q}&signature=${sign(q, u.sec)}`, { headers: { 'X-MBX-APIKEY': u.api } }); return true; } catch (e) { return false; }
}

async function startGlobalEngine() {
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=!ticker@arr/!bookTicker`);
    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.stream === "!ticker@arr") {
            msg.data.forEach(d => {
                if (market[d.s]) {
                    const s = market[d.s]; s.p = parseFloat(d.c);
                    s.history.push(s.p); if(s.history.length > 100) s.history.shift();
                    s.ema7 = calculateEMA(s.history, 7); s.rsi = calculateRSI(s.history);
                }
            });
        } else {
            const d = msg.data;
            if (market[d.s]) {
                const s = market[d.s]; s.b = parseFloat(d.b); s.a = parseFloat(d.a);
                s.buyVol = parseFloat(d.B); s.sellVol = parseFloat(d.A);
            }
        }
    });

    setInterval(async () => {
        for (let uid in cachedUsers) {
            let u = cachedUsers[uid]; 
            let walletBal = parseFloat(u.cap || 0);
            let feeR = u.fMode === 'bnb' ? 0.00018 : 0.0002;

            let aiSlots = walletBal < 30 ? 1 : (walletBal < 150 ? 3 : 5);
            if (!u.userSlots || u.userSlots.length !== aiSlots) {
                u.userSlots = Array(aiSlots).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, qty: 0, totalCost: 0, marginUsed: 0, targetP: 0, curP: 0, dca: 0, entryTime: 0, buyOrderId: null, sellOrderId: null }));
                saveDB();
            }

            u.userSlots.forEach(async (sl) => {
                if (!sl.active) return;
                const ms = market[sl.sym]; if(!ms || ms.p === 0) return;
                sl.curP = ms.p;

                // ⏳ BUY_PENDING: যখন দাম আমাদের স্নাইপার লিমিট হিট করবে
                if (sl.status === 'BUY_PENDING') {
                    if (ms.p <= sl.buy || u.mode === 'demo') {
                        sl.status = 'ACTIVE'; sl.entryTime = Date.now();
                        // 🔥 টার্গেট প্রফিট: সকল ফি বাদ দিয়ে নিট ০.৪০% প্রফিট যোগ করে সেল লিমিট
                        let profitMove = 0.004; // ০.৪০%
                        sl.targetP = (sl.buy * (1 + profitMove + feeR)).toFixed(COINS.find(c => c.s === sl.sym).d);
                        
                        let sellOrder = await placeOrder(sl.sym, "SELL", sl.qty, u, sl.targetP);
                        if (sellOrder) {
                            sl.status = 'SELL_PENDING'; sl.sellOrderId = sellOrder.orderId;
                            sendTG(`🎯 <b>BUY FILLED: #${sl.sym}</b>\nPrice: ${sl.buy}\nAuto-Sell Limit: ${sl.targetP}`, u.cid);
                            saveDB();
                        }
                    } else if ((Date.now() - sl.entryTime)/1000 > 120) {
                        await cancelOrder(sl.sym, sl.buyOrderId, u);
                        if(u.mode === 'demo') u.cap = Number(u.cap) + Number(sl.marginUsed);
                        Object.assign(sl, { active: false, status: 'IDLE', sym: '', marginUsed: 0 }); saveDB();
                    }
                    return;
                }

                // 🏁 SELL_PENDING: বাইন্যান্সের লিমিট অর্ডার সেলের অপেক্ষা
                if (sl.status === 'SELL_PENDING') {
                    if (ms.p >= sl.targetP || u.mode === 'demo') {
                        let netUSD = (parseFloat(sl.qty) * sl.targetP) - sl.totalCost - (sl.totalCost * feeR * 2);
                        if(u.mode === 'demo') u.cap = Number(u.cap || 0) + Number(sl.marginUsed) + netUSD;
                        u.profit = (Number(u.profit || 0) + netUSD);
                        sendTG(`✅ <b>LIMIT PROFIT: #${sl.sym}</b>\nGain: <b>৳${(netUSD * 124).toFixed(2)}</b>`, u.cid);
                        Object.assign(sl, { active: false, status: 'IDLE', sym: '', marginUsed: 0, totalCost: 0, dca: 0 }); saveDB();
                    }
                }
            });

            // 🚀 SNIPER BOTTOM ENTRY (LIMIT ONLY)
            let activeCount = u.userSlots.filter(s => s.active).length;
            if (!u.isPaused && activeCount < aiSlots) {
                for (let coin of COINS) {
                    const m = market[coin.s]; if (m.p === 0 || m.history.length < 50) continue;
                    
                    let buyerPressure = m.buyVol / (m.buyVol + m.sellVol);
                    // কন্ডিশন: RSI অনেক নিচে এবং বায়াররা পজিশন নিতে শুরু করেছে
                    if (m.rsi < 28 && m.p > m.ema7 && buyerPressure > 0.55 && !u.userSlots.some(x => x.active && x.sym === coin.s)) {
                        let entryVal = (walletBal * u.lev) / aiSlots / 4;
                        // 🔥 স্নাইপার লিমিট প্রাইজ: বর্তমান দামের ০.০৫% নিচে বাই অর্ডার (The Dip Catcher)
                        let limitBuyPrice = (m.p * 0.9995).toFixed(coin.d);
                        let qty = (entryVal / parseFloat(limitBuyPrice)).toFixed(coin.qd);
                        
                        const sIdx = u.userSlots.findIndex(sl => !sl.active);
                        if (sIdx !== -1) {
                            let order = await placeOrder(coin.s, "BUY", qty, u, limitBuyPrice);
                            if (order) {
                                if(u.mode === 'demo') u.cap -= (entryVal/u.lev);
                                u.userSlots[sIdx] = { id: sIdx, active: true, status: 'BUY_PENDING', sym: coin.s, buy: parseFloat(limitBuyPrice), qty: qty, totalCost: (parseFloat(qty) * parseFloat(limitBuyPrice)), marginUsed: (entryVal/u.lev), entryTime: Date.now(), curP: m.p, dca: 0, buyOrderId: order.orderId };
                                saveDB();
                            }
                        }
                    }
                }
            }
        }
    }, 1000);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`); const userId = url.pathname.slice(1);
    if (url.pathname === '/api/data') {
        const u = cachedUsers[url.searchParams.get('id')];
        const apiData = await getBinanceBalance(u || {});
        let btc = market["BTCUSDT"] || { p: 0, btcTrend: 0 };
        if(u) u.userSlots.forEach(s => { if(s.active) s.curP = market[s.sym]?.p || s.buy; });
        return res.end(JSON.stringify({ ...u, balance: apiData.bal, apiStatus: apiData.status, btcPrice: btc.p.toFixed(2), btcTrend: btc.btcTrend.toFixed(2) }));
    }
    if (url.pathname === '/toggle-pause') { let u = cachedUsers[url.searchParams.get('id')]; if (u) { u.isPaused = !u.isPaused; saveDB(); } res.writeHead(200); return res.end("OK"); }
    if (url.pathname === '/register') { 
        let q = url.searchParams; let id = q.get('id');
        cachedUsers[id] = { api: q.get('api'), sec: q.get('sec'), cid: q.get('cid'), cap: Number(q.get('cap')), targetBDT: Number(q.get('target')), lev: Number(q.get('lev')), mode: q.get('mode'), fMode: q.get('fmode'), profit: 0, isPaused: false, status: 'ACTIVE', userSlots: [] };
        saveDB(); res.writeHead(302, { 'Location': '/' + id }); return res.end(); 
    }
    if (url.pathname === '/reset-logout') { if (cachedUsers[userId]) { delete cachedUsers[userId]; saveDB(); } res.writeHead(302, { 'Location': '/' }); return res.end(); }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !cachedUsers[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-6 flex items-center min-h-screen font-sans text-center"><div class="max-w-md mx-auto w-full space-y-6"><h1 class="text-7xl font-black text-sky-400 italic">QUANTUM</h1><form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 border border-slate-800 text-left shadow-2xl"><input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl outline-none" required><div class="grid grid-cols-2 gap-2"><select name="mode" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select><select name="fmode" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><option value="usdt">Fee: USDT</option><option value="bnb">Fee: BNB</option></select></div><input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-xl outline-none"><input name="sec" placeholder="Binance Secret" class="w-full bg-black p-4 rounded-xl outline-none"><input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-xl outline-none"><div class="grid grid-cols-2 gap-2"><input name="cap" type="number" placeholder="Capital $" class="bg-black p-4 rounded-xl outline-none"><input name="target" type="number" placeholder="Target ৳" class="bg-black p-4 rounded-xl outline-none"></div><input name="lev" type="number" placeholder="Leverage" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><button type="submit" class="w-full bg-sky-600 p-5 rounded-full font-black uppercase shadow-xl">Launch v76 PRO</button></form></div></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-4 font-sans uppercase"><div class="max-width-xl mx-auto space-y-4">
        <div class="p-4 bg-slate-900/50 backdrop-blur-md rounded-[2rem] border border-slate-800 shadow-lg relative overflow-hidden"><div id="pB" class="absolute top-0 left-0 h-1 transition-all duration-1000"></div><div class="flex justify-between items-center mb-3"><div><p class="text-[8px] text-slate-500 font-bold">AI Status Meter</p><p class="text-[10px] font-black" id="pM">Syncing...</p><p class="text-[8px] text-slate-400" id="pP">BTC: $0.00</p></div><div class="px-3 py-2 bg-indigo-600/20 border border-indigo-500/50 rounded-lg text-[8px] font-black text-indigo-400">🛡️ QUANTUM v76 PRO</div></div></div>
        <div class="p-6 bg-slate-900 rounded-[2.5rem] border-2 border-sky-500/50 text-center shadow-2xl tracking-tighter"><p class="text-[10px] text-sky-400 font-bold mb-1 italic">Wallet Balance</p><p class="text-5xl font-black text-white">$<span id="balanceText">0.00</span></p></div>
        <div class="grid grid-cols-2 gap-4 text-center"><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1">Growth (BDT)</p><p class="text-4xl font-black text-green-400">৳<span id="profitText">0</span></p></div><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1 italic">Target BDT</p><p class="text-4xl font-black text-sky-400">৳<span id="targetText">0</span></p></div></div>
        <div id="slotContainer" class="space-y-3"></div><div class="grid grid-cols-2 gap-3 pt-4 uppercase"><button onclick="togglePause()" id="pauseBtn" class="py-5 rounded-full text-[10px] font-black bg-orange-900/20 border border-orange-500/30 text-orange-400">Pause</button><a href="/reset-logout?id=\${userId}" class="block bg-slate-800 border border-slate-700 text-slate-400 py-5 rounded-full text-center text-[10px] font-black uppercase">Logout</a></div></div><script>
            async function togglePause() { await fetch('/toggle-pause?id=${userId}'); location.reload(); }
            async function updateData() { try { const res = await fetch('/api/data?id=${userId}'); const d = await res.json(); 
                document.getElementById('balanceText').innerText = d.balance || "0.00"; 
                document.getElementById('profitText').innerText = (Number(d.profit || 0) * 124).toFixed(2);
                document.getElementById('targetText').innerText = d.targetBDT || "0"; 
                document.getElementById('pauseBtn').innerText = d.isPaused ? "RESUME" : "PAUSE";
                const pM = document.getElementById('pM'); document.getElementById('pP').innerText = "BTC: $" + (d.btcPrice || "0.00");
                const btcTrend = parseFloat(d.btcTrend || 0);
                if(btcTrend > 0.05) { pM.innerText = "📈 Bullish ("+btcTrend+"%)"; pM.className="text-[10px] font-black text-green-400"; }
                else if(btcTrend < -0.1) { pM.innerText = "⚠️ Bearish ("+btcTrend+"%)"; pM.className="text-[10px] font-black text-red-500"; }
                else { pM.innerText = "⚖️ Stable ("+btcTrend+"%)"; pM.className="text-[10px] font-black text-sky-400"; }
                let h = ''; (d.userSlots || []).forEach((s, i) => { 
                    let statusColor = s.active ? (s.status.includes('PENDING') ? 'text-orange-400' : 'text-sky-400') : 'text-zinc-700';
                    let pnlColor = parseFloat(s.pnl) >= 0 ? 'text-green-400' : 'text-red-400';
                    h += \`<div class="p-5 bg-slate-900/40 backdrop-blur-sm rounded-3xl border border-zinc-800 mb-3 shadow-lg uppercase"><div class="flex justify-between items-center mb-3"><span class="text-[11px] font-black \${statusColor} tracking-wider">\${s.active ? s.sym + ' ['+s.status+']' : 'Slot '+(i+1)+' Idle'}</span><span class="text-[11px] font-black \${pnlColor}">\${s.active ? s.pnl + '%' : ''}</span></div>\${s.active ? \`<div class="grid grid-cols-2 text-[10px] font-mono text-slate-500 gap-y-1"><div>Buy: \${s.buy.toFixed(4)}</div><div class="text-right text-indigo-400 font-bold">Goal: \${(s.targetP || 0).toFixed(4)}</div><div class="text-green-400 font-black">Live: \${(s.curP || s.buy).toFixed(4)}</div><div class="text-right italic">Quantum v76</div></div>\` : ''}</div>\`;
                }); document.getElementById('slotContainer').innerHTML = h; } catch(e) {} } setInterval(updateData, 1000);
        </script></body></html>`);
    }
});
server.listen(process.env.PORT || 8080, '0.0.0.0', () => startGlobalEngine());

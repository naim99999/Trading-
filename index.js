const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// 👑 QUANTUM master engine v71.0 - ZERO-LOSS ELITE
// ==============================================
const MASTER_TG_TOKEN = "8281887575:AAG5OR86LCQO_90479FKkia2F1sEAJjCP60"; 
const FIXED_CHAT_ID = "5279510350"; 
const DB_FILE = 'quantum_ai_v71_final.json';

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
COINS.forEach(c => market[c.s] = { p: 0, history: [], ema7: 0, rsi: 50, btcTrend: 0 });

function calculateEMA(p, n) { if (p.length < n) return p[p.length-1]; let k = 2/(n+1), ema = p[0]; for(let i=1; i<p.length; i++) ema = p[i]*k + ema*(1-k); return ema; }
function calculateRSI(p) { if (p.length <= 14) return 50; let g=0, l=0; for(let i=1; i<=14; i++) { let d = p[p.length-i] - p[p.length-i-1]; d>=0 ? g+=d : l-=d; } return 100 - (100/(1+(g/(l||1)))); }
function sign(q, s) { return crypto.createHmac('sha256', s).update(q).digest('hex'); }
async function sendTG(m, id) { try { await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: id || FIXED_CHAT_ID, text: m, parse_mode: 'HTML' }); } catch(e) {} }

async function getBinanceBalance(u) {
    if (!u.api || u.mode === 'demo') return { bal: Number(u.cap || 0).toFixed(2), status: "DEMO" };
    const ts = Date.now(); const sig = sign(`timestamp=${ts}`, u.sec);
    try { const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?timestamp=${ts}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': u.api }, timeout: 5000 }); return { bal: parseFloat(res.data.totalWalletBalance).toFixed(2), status: "CONNECTED" }; } 
    catch (e) { return { bal: "0.00", status: "AUTH_ERROR" }; }
}

async function placeOrder(sym, side, qty, u) {
    if (u.mode === 'demo') return { orderId: 'DEMO_' + Date.now(), status: 'FILLED' };
    const ts = Date.now(); let q = `symbol=${sym}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${ts}`;
    try { const res = await axios.post(`https://fapi.binance.com/fapi/v1/order?${q}&signature=${sign(q, u.sec)}`, null, { headers: { 'X-MBX-APIKEY': u.api } }); return res.data; } catch (e) { return null; }
}

async function startGlobalEngine() {
    const ws = new WebSocket(`wss://fstream.binance.com/ws/!ticker@arr`);
    ws.on('message', (data) => {
        const raw = JSON.parse(data);
        raw.forEach(d => {
            if (market[d.s]) {
                const s = market[d.s]; s.p = parseFloat(d.c);
                s.history.push(s.p); if(s.history.length > 60) s.history.shift();
                s.ema7 = calculateEMA(s.history, 7); s.rsi = calculateRSI(s.history);
                if (d.s === "BTCUSDT" && s.history.length > 10) s.btcTrend = ((s.p - s.history[0]) / s.history[0] * 100);
            }
        });
    });

    setInterval(async () => {
        for (let uid in cachedUsers) {
            let u = cachedUsers[uid]; 
            let walletBal = parseFloat(u.cap || 0);
            let feeR = u.fMode === 'bnb' ? 0.0004 : 0.0005; // মার্কেট সেল ফি (Taker)

            let aiSlots = walletBal < 30 ? 2 : (walletBal < 150 ? 4 : 8);
            if (!u.userSlots || u.userSlots.length !== aiSlots) {
                let existing = (u.userSlots || []).filter(s => s.active);
                u.userSlots = Array(aiSlots).fill(null).map((_, i) => existing.find(x => x.id === i) || { id: i, active: false, status: 'IDLE', sym: '', buy: 0, qty: 0, totalCost: 0, marginUsed: 0, curP: 0, dca: 0, maxP: 0, totalFeePaid: 0 });
                saveDB();
            }

            u.userSlots.forEach(async (sl) => {
                if (!sl.active || sl.isClosing) return;
                const ms = market[sl.sym]; if(!ms || ms.p === 0) return;
                sl.curP = ms.p;
                
                // 🧮 টোটাল ফি ক্যালকুলেশন (এন্ট্রি + DCA + সম্ভাব্য মার্কেট সেল ফি)
                let tradeVal = parseFloat(sl.qty) * ms.p;
                let exitFee = tradeVal * feeR;
                let netProfitUSD = (tradeVal - sl.totalCost) - (sl.totalFeePaid + exitFee);
                sl.netBDT = (netProfitUSD * 124).toFixed(2);
                sl.pnl = (((ms.p - sl.buy) / sl.buy) * 100 * u.lev).toFixed(2);

                if (sl.status === 'ACTIVE') {
                    if (parseFloat(sl.netBDT) >= 0.50) {
                        if (ms.p > sl.maxP) sl.maxP = ms.p;
                        let dropFromPeak = ((sl.maxP - ms.p) / sl.maxP) * 100;
                        
                        if (dropFromPeak > 0.04) { // ০.০৪% টাইট ড্রপ লিমিট
                            sl.isClosing = true;
                            if (await placeOrder(sl.sym, "SELL", sl.qty, u)) {
                                if(u.mode === 'demo') u.cap = Number(u.cap || 0) + Number(sl.marginUsed) + netProfitUSD;
                                u.profit = (Number(u.profit || 0) + netProfitUSD);
                                sendTG(`✅ <b>PROFIT! #${sl.sym}</b>\nNet Gain: ৳${sl.netBDT}\nHub Total: ৳${(u.profit*124).toFixed(2)}`, u.cid);
                                Object.assign(sl, { active: false, status: 'IDLE', sym: '', marginUsed: 0, totalCost: 0, dca: 0, maxP: 0, totalFeePaid: 0, isClosing: false }); saveDB();
                            } else sl.isClosing = false;
                        }
                    }
                    else if (parseFloat(sl.pnl) < -4.0 && sl.dca < 6 && walletBal > (sl.marginUsed * 1.5)) {
                        if (ms.p > ms.ema7) {
                            let addQty = (parseFloat(sl.qty) * 1.3).toFixed(COINS.find(c => c.s === sl.sym).qd);
                            if (await placeOrder(sl.sym, "BUY", addQty, u)) {
                                let addCost = parseFloat(addQty) * ms.p;
                                let addM = addCost / u.lev;
                                if (u.mode === 'demo') u.cap -= addM;
                                sl.totalCost += addCost;
                                sl.totalFeePaid += (addCost * feeR); // DCA ফি যুক্ত হলো
                                sl.qty = (parseFloat(sl.qty) + parseFloat(addQty)).toString();
                                sl.buy = sl.totalCost / parseFloat(sl.qty);
                                sl.marginUsed += addM; sl.dca++; sl.maxP = ms.p; saveDB();
                                sendTG(`🌀 <b>DCA: #${sl.sym}</b>\nLevel ${sl.dca} - Avg Price Updated.`, u.cid);
                            }
                        }
                    }
                }
            });

            if (!u.isPaused && u.userSlots.filter(s => s.active).length < (aiSlots - 1)) {
                for (let coin of COINS) {
                    const m = market[coin.s]; if (m.p === 0 || m.history.length < 50) continue;
                    if (m.rsi < 28 && m.p > m.ema7 && !u.userSlots.some(x => x.active && x.sym === coin.s)) {
                        let entryVal = (walletBal * u.lev) / aiSlots / 4.5;
                        let qty = (entryVal / m.p).toFixed(coin.qd);
                        if (await placeOrder(coin.s, "BUY", qty, u)) {
                            let mUsed = entryVal / u.lev;
                            if(u.mode === 'demo') u.cap -= mUsed;
                            const sIdx = u.userSlots.findIndex(sl => !sl.active);
                            u.userSlots[sIdx] = { id: sIdx, active: true, status: 'ACTIVE', sym: coin.s, buy: m.p, qty: qty, totalCost: (parseFloat(qty) * m.p), marginUsed: mUsed, totalFeePaid: (entryVal * feeR), curP: m.p, dca: 0, pnl: 0, maxP: m.p, isClosing: false };
                            saveDB(); sendTG(`🚀 <b>AI ENTRY: #${coin.s}</b>\nPrice: ${m.p}`, u.cid);
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
        const u = cachedUsers[url.searchParams.get('id')];
        const apiData = await getBinanceBalance(u || {});
        if(u) u.userSlots.forEach(s => { if(s.active) s.curP = market[s.sym]?.p || s.buy; });
        return res.end(JSON.stringify({ ...u, balance: apiData.bal, btcPrice: market["BTCUSDT"]?.p.toFixed(2), btcTrend: market["BTCUSDT"]?.btcTrend.toFixed(2) }));
    }
    if (url.pathname === '/toggle-pause') { let u = cachedUsers[url.searchParams.get('id')]; if (u) { u.isPaused = !u.isPaused; saveDB(); } res.writeHead(200); return res.end("OK"); }
    if (url.pathname === '/register') { 
        let q = url.searchParams; 
        cachedUsers[q.get('id')] = { api: q.get('api'), sec: q.get('sec'), cid: q.get('cid'), cap: Number(q.get('cap')), targetBDT: Number(q.get('target')), lev: Number(q.get('lev')), mode: q.get('mode'), fMode: q.get('fmode'), profit: 0, isPaused: false, userSlots: [] };
        saveDB(); res.writeHead(302, { 'Location': '/' + q.get('id') }); return res.end(); 
    }
    if (url.pathname === '/reset-logout') { if (cachedUsers[userId]) { delete cachedUsers[userId]; saveDB(); } res.writeHead(302, { 'Location': '/' }); return res.end(); }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !cachedUsers[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-6 flex items-center min-h-screen font-sans text-center"><div class="max-w-md mx-auto w-full space-y-6"><h1 class="text-7xl font-black text-sky-400 italic">QUANTUM</h1><form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 border border-slate-800 text-left shadow-2xl"><input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl outline-none" required><div class="grid grid-cols-2 gap-2"><select name="mode" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select><select name="fmode" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><option value="usdt">Fee: USDT</option><option value="bnb">Fee: BNB</option></select></div><input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-xl outline-none"><input name="sec" placeholder="Binance Secret" class="w-full bg-black p-4 rounded-xl outline-none"><input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-xl outline-none"><div class="grid grid-cols-2 gap-2"><input name="cap" type="number" placeholder="Capital $" class="bg-black p-4 rounded-xl outline-none"><input name="target" type="number" placeholder="Target ৳" class="bg-black p-4 rounded-xl outline-none"></div><input name="lev" type="number" placeholder="Leverage" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><button type="submit" class="w-full bg-sky-600 p-5 rounded-full font-black uppercase shadow-xl">Launch Engine v71</button></form></div></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-4 font-sans uppercase"><div class="max-width-xl mx-auto space-y-4">
        <div class="p-4 bg-slate-900/50 backdrop-blur-md rounded-[2rem] border border-slate-800 shadow-lg relative overflow-hidden"><div id="pB" class="absolute top-0 left-0 h-1 transition-all duration-1000"></div><div class="flex justify-between items-center mb-3"><div><p class="text-[8px] text-slate-500 font-bold">AI Status Meter</p><p class="text-[10px] font-black" id="pM">Syncing...</p><p class="text-[8px] text-slate-400" id="pP">BTC: $0.00</p></div><div class="px-3 py-2 bg-indigo-600/20 border border-indigo-500/50 rounded-lg text-[8px] font-black text-indigo-400">🛡️ MASTER v71 PRO</div></div></div>
        <div class="p-6 bg-slate-900 rounded-[2.5rem] border-2 border-sky-500/50 text-center shadow-2xl tracking-tighter"><p class="text-[10px] text-sky-400 font-bold mb-1 italic">Wallet Balance</p><p class="text-5xl font-black text-white">$<span id="balanceText">0.00</span></p></div>
        <div class="grid grid-cols-2 gap-4 text-center"><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1">Growth (BDT)</p><p class="text-4xl font-black text-green-400">৳<span id="profitText">0</span></p></div><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1 italic">Target BDT</p><p class="text-4xl font-black text-sky-400">৳<span id="targetText">0</span></p></div></div>
        <div id="slotContainer" class="space-y-3"></div><div class="grid grid-cols-2 gap-3 pt-4 uppercase"><button onclick="togglePause()" id="pauseBtn" class="py-5 rounded-full text-[10px] font-black bg-orange-900/20 border border-orange-500/30 text-orange-400">Pause</button><a href="/reset-logout?id=${userId}" class="block bg-slate-800 border border-slate-700 text-slate-400 py-5 rounded-full text-center text-[10px] font-black uppercase">Logout</a></div></div><script>
            async function togglePause() { await fetch('/toggle-pause?id=${userId}'); location.reload(); }
            async function updateData() { try { const res = await fetch('/api/data?id=${userId}'); const d = await res.json(); 
                document.getElementById('balanceText').innerText = d.balance || "0.00"; 
                document.getElementById('profitText').innerText = (Number(d.profit || 0) * 124).toFixed(2);
                document.getElementById('targetText').innerText = d.targetBDT || "0"; 
                document.getElementById('pauseBtn').innerText = d.isPaused ? "RESUME" : "PAUSE";
                const pM = document.getElementById('pM'); document.getElementById('pP').innerText = "BTC: $" + (d.btcPrice || "0.00");
                if(d.btcTrend > 0.05) { pM.innerText = "📈 Bullish ("+d.btcTrend+"%)"; pM.className="text-[10px] font-black text-green-400"; }
                else if(d.btcTrend < -0.1) { pM.innerText = "⚠️ Bearish ("+d.btcTrend+"%)"; pM.className="text-[10px] font-black text-red-500"; }
                else { pM.innerText = "⚖️ Stable ("+d.btcTrend+"%)"; pM.className="text-[10px] font-black text-sky-400"; }
                let h = ''; (d.userSlots || []).forEach((s, i) => { 
                    let statusColor = s.active ? 'text-sky-400' : 'text-zinc-700';
                    let pnlColor = parseFloat(s.pnl) >= 0 ? 'text-green-400' : 'text-red-400';
                    h += \`<div class="p-5 bg-slate-900/40 backdrop-blur-sm rounded-3xl border border-zinc-800 mb-3 shadow-lg uppercase"><div class="flex justify-between items-center mb-3"><span class="text-[11px] font-black \${statusColor} tracking-wider">\${s.active ? s.sym + ' [DCA:'+s.dca+']' : 'Slot '+(i+1)+' Idle'}</span><span class="text-[11px] font-black \${pnlColor}">\${s.active ? s.pnl + '% (৳'+s.netBDT+')' : ''}</span></div>\${s.active ? \`<div class="grid grid-cols-2 text-[10px] font-mono text-slate-500 gap-y-1"><div>Buy: \${s.buy.toFixed(4)}</div><div class="text-right text-indigo-400 font-bold">Peak: \${s.maxP.toFixed(4)}</div><div class="text-green-400 font-black">Live: \${(s.curP || s.buy).toFixed(4)}</div><div class="text-right italic">Quantum v71</div></div>\` : ''}</div>\`;
                }); document.getElementById('slotContainer').innerHTML = h; } catch(e) {} } setInterval(updateData, 1000);
        </script></body></html>`);
    }
});
server.listen(process.env.PORT || 8080, '0.0.0.0', () => startGlobalEngine());

const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// 👑 QUANTUM APEX AI v46.0 - THE MASTER ENGINE
// ==============================================
const MASTER_TG_TOKEN = "8281887575:AAG5OR86LCQO_90479FKkia2F1sEAJjCP60"; 
const DB_FILE = 'quantum_ai_master_v46.json';

let cachedUsers = {}; 
function loadDB() { try { if (fs.existsSync(DB_FILE)) cachedUsers = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { cachedUsers = {}; } }
function saveDB() { try { fs.writeFileSync(DB_FILE, JSON.stringify(cachedUsers, null, 2)); } catch(e) {} }
loadDB();

const COINS = [
    { s: "BTCUSDT", d: 2, qd: 3 }, { s: "ETHUSDT", d: 2, qd: 3 }, 
    { s: "SOLUSDT", d: 3, qd: 2 }, { s: "BNBUSDT", d: 2, qd: 2 }, 
    { s: "AVAXUSDT", d: 3, qd: 1 }, { s: "NEARUSDT", d: 4, qd: 1 }, 
    { s: "SUIUSDT", d: 4, qd: 1 }, { s: "LINKUSDT", d: 3, qd: 2 },
    { s: "PEPEUSDT", d: 8, qd: 0 }, { s: "DOGEUSDT", d: 5, qd: 0 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, history: [], rsi: 50, btcTrend: 0 });

function calculateRSI(p) { if (p.length <= 14) return 50; let g=0, l=0; for(let i=1; i<=14; i++) { let d = p[p.length-i] - p[p.length-i-1]; d>=0 ? g+=d : l-=d; } return 100 - (100/(1+(g/(l||1)))); }
function sign(q, s) { return crypto.createHmac('sha256', s).update(q).digest('hex'); }
async function sendTG(m, id) { try { await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: id, text: m, parse_mode: 'HTML' }); } catch(e) {} }

async function getBinanceBalance(u) {
    if (u.mode === 'demo') return { bal: parseFloat(u.cap || 0).toFixed(2), status: "DEMO" };
    const ts = Date.now(); const q = `timestamp=${ts}`;
    try { const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?${q}&signature=${sign(q, u.sec)}`, { headers: { 'X-MBX-APIKEY': u.api }, timeout: 5000 }); return { bal: parseFloat(res.data.totalWalletBalance).toFixed(2), status: "CONNECTED" }; } 
    catch (e) { return { bal: "0.00", status: "AUTH_ERROR" }; }
}

async function placeOrder(sym, side, qty, u) {
    if (u.mode === 'demo') return { orderId: 'DEMO_' + Date.now() };
    const ts = Date.now(); let q = `symbol=${sym}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${ts}`;
    try { const res = await axios.post(`https://fapi.binance.com/fapi/v1/order?${q}&signature=${sign(q, u.sec)}`, null, { headers: { 'X-MBX-APIKEY': u.api } }); return res.data; } catch (e) { return null; }
}

async function startGlobalEngine() {
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/')}`);
    ws.on('message', (data) => {
        const d = JSON.parse(data).data; if (!d || !market[d.s]) return;
        const s = market[d.s]; s.p = parseFloat(d.c); s.history.push(s.p); if(s.history.length > 60) s.history.shift();
        s.rsi = calculateRSI(s.history);
        if (d.s === "BTCUSDT" && s.history.length > 10) s.btcTrend = ((s.p - s.history[0]) / s.history[0] * 100);
    });

    setInterval(async () => {
        for (let uid in cachedUsers) {
            let u = cachedUsers[uid]; 
            let walletData = await getBinanceBalance(u);
            let walletBal = parseFloat(walletData.bal);
            let growthBDT = (parseFloat(u.profit || 0) * 124);
            let isTargetDone = growthBDT >= parseFloat(u.targetBDT);

            if (isTargetDone && !u.isPaused) { u.isPaused = true; sendTG(`🎯 <b>TARGET REACHED!</b>\nProfit: ৳${growthBDT.toFixed(0)}`, u.cid); saveDB(); }

            if (!u.userSlots || u.userSlots.length === 0) {
                u.userSlots = [{ id: 0, active: false, status: 'IDLE', sym: '', buy: 0, qty: 0, totalCost: 0, dca: 0, targetP: 0, pnl: 0 }];
                saveDB();
            }

            for (let sl of u.userSlots) {
                if (u.isPaused) continue;
                const ms = market[sl.sym];

                if (sl.active && ms && ms.p > 0) {
                    sl.curP = ms.p;
                    sl.pnl = (((ms.p - sl.buy) / sl.buy) * 100 * u.lev).toFixed(2);

                    // --- DCA RECOVERY ---
                    if (parseFloat(sl.pnl) < -3.0 && sl.dca < 10) {
                        let coinCfg = COINS.find(c => c.s === sl.sym);
                        let nextQty = (parseFloat(sl.qty) * 1.5).toFixed(coinCfg.qd);
                        let marginNeeded = (nextQty * ms.p) / u.lev;
                        if (walletBal > marginNeeded) {
                            if (await placeOrder(sl.sym, "BUY", nextQty, u)) {
                                sl.totalCost += (parseFloat(nextQty) * ms.p);
                                sl.qty = (parseFloat(sl.qty) + parseFloat(nextQty)).toFixed(coinCfg.qd);
                                sl.buy = sl.totalCost / parseFloat(sl.qty);
                                sl.dca++;
                                sl.targetP = (sl.buy * (1 + (parseFloat(u.evenT)/100/u.lev) + 0.0004)).toFixed(coinCfg.d);
                                if(u.mode === 'demo') u.cap -= marginNeeded;
                                sendTG(`🌀 <b>DCA ${sl.dca}: #${sl.sym}</b>\nNew Target: ${sl.targetP}`, u.cid);
                                saveDB();
                            }
                        }
                    }

                    // --- TAKE PROFIT ---
                    if (ms.p >= sl.targetP) {
                        if (await placeOrder(sl.sym, "SELL", sl.qty, u)) {
                            let netUSD = (parseFloat(sl.qty) * ms.p) - sl.totalCost;
                            u.profit = (parseFloat(u.profit || 0) + netUSD).toFixed(4);
                            if(u.mode === 'demo') u.cap = (parseFloat(u.cap) + (sl.totalCost/u.lev) + netUSD);
                            sendTG(`✅ <b>PROFIT! #${sl.sym}</b>\nNet: $${netUSD.toFixed(2)}`, u.cid);
                            Object.assign(sl, { active: false, status: 'IDLE', sym: '', dca: 0 });
                            saveDB();
                        }
                    }
                }

                // --- NEW ENTRY ---
                if (!sl.active && !isTargetDone) {
                    for (let coin of COINS) {
                        const m = market[coin.s];
                        if (m.rsi < 28 && m.p > 0 && !u.userSlots.some(x => x.sym === coin.s)) {
                            let entryUSD = 6.5; // Supports $5 capital with 20x leverage
                            let qty = (entryUSD / m.p).toFixed(coin.qd);
                            if (walletBal > (entryUSD/u.lev)) {
                                if (await placeOrder(coin.s, "BUY", qty, u)) {
                                    Object.assign(sl, { active: true, status: 'TRADING', sym: coin.s, buy: m.p, qty: qty, totalCost: entryUSD, dca: 0 });
                                    sl.targetP = (sl.buy * (1 + (parseFloat(u.evenT)/100/u.lev) + 0.0004)).toFixed(coin.d);
                                    if(u.mode === 'demo') u.cap -= (entryUSD/u.lev);
                                    sendTG(`🚀 <b>AI ENTRY: #${coin.s}</b>\nTarget: ${sl.targetP}`, u.cid);
                                    saveDB(); break;
                                }
                            }
                        }
                    }
                }
            }
        }
    }, 4000);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`); const userId = url.pathname.slice(1);
    
    if (url.pathname === '/api/data') {
        const u = cachedUsers[url.searchParams.get('id')]; if(!u) return res.end("{}");
        const apiData = await getBinanceBalance(u);
        let btc = market["BTCUSDT"] || { p: 0, btcTrend: 0 };
        let pulse = btc.btcTrend > 0.05 ? "BULLISH" : (btc.btcTrend < -0.05 ? "BEARISH" : "STABLE");
        return res.end(JSON.stringify({ ...u, balance: apiData.bal, apiStatus: apiData.status, btcPrice: btc.p, btcTrend: btc.btcTrend, pulse }));
    }

    if (url.pathname === '/toggle') { let u = cachedUsers[url.searchParams.get('id')]; if(u) u.isPaused = !u.isPaused; saveDB(); return res.end("OK"); }
    if (url.pathname === '/logout') { delete cachedUsers[url.searchParams.get('id')]; saveDB(); res.writeHead(302, { 'Location': '/' }); return res.end(); }

    if (url.pathname === '/register') { 
        let q = url.searchParams; 
        cachedUsers[q.get('id')] = { api: q.get('api'), sec: q.get('sec'), cid: q.get('cid'), cap: Number(q.get('cap')), targetBDT: Number(q.get('target')), lev: Number(q.get('lev')), evenT: q.get('evenT'), mode: q.get('mode'), profit: 0, isPaused: false, userSlots: [] };
        saveDB(); res.writeHead(302, { 'Location': '/' + q.get('id') }); return res.end(); 
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !cachedUsers[userId]) {
        res.end(`<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body class="bg-[#020617] text-white flex items-center min-h-screen font-sans text-center"><div class="max-w-md mx-auto w-full p-6"><h1 class="text-7xl font-black text-sky-400 italic mb-6">QUANTUM</h1><form action="/register" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 border border-slate-800 text-left shadow-2xl"><input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl outline-none" required><select name="mode" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none"><option value="demo">Demo Mode</option><option value="live">Live Trading</option></select><input name="api" placeholder="API Key" class="w-full bg-black p-4 rounded-xl outline-none"><input name="sec" placeholder="API Secret" class="w-full bg-black p-4 rounded-xl outline-none"><input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-xl outline-none" required><div class="grid grid-cols-2 gap-2"><input name="cap" type="number" placeholder="Capital $" class="bg-black p-4 rounded-xl outline-none"><input name="target" type="number" placeholder="Target ৳" class="bg-black p-4 rounded-xl outline-none"></div><div class="grid grid-cols-2 gap-2"><input name="evenT" placeholder="Target %" class="bg-black p-4 rounded-xl outline-none" required><input name="lev" type="number" placeholder="Leverage" class="bg-black p-4 rounded-xl outline-none"></div><button type="submit" class="w-full bg-sky-600 p-5 rounded-full font-black uppercase shadow-xl">Start Quantum v46</button></form></div></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body class="bg-[#020617] text-white p-4 font-sans uppercase"><div class="max-w-xl mx-auto space-y-4">
        <div class="p-4 bg-slate-900/50 backdrop-blur-md rounded-[2rem] border border-slate-800 shadow-lg relative overflow-hidden"><div class="flex justify-between items-center"><div><p class="text-[8px] text-slate-500 font-bold">AI Status Meter</p><p class="text-[10px] font-black" id="pM">Syncing...</p><p class="text-[8px] text-slate-400" id="pP">BTC: $0.00</p></div><div class="px-3 py-2 bg-indigo-600/20 border border-indigo-500/50 rounded-lg text-[8px] font-black text-indigo-400">🛡️ QUANTUM v46 PRO</div></div></div>
        <div class="p-6 bg-slate-900 rounded-[2.5rem] border-2 border-sky-500/50 text-center shadow-2xl"><p class="text-[10px] text-sky-400 font-bold mb-1 italic">Simulation Wallet Balance</p><p class="text-5xl font-black text-white">$<span id="bal">0.00</span></p></div>
        <div class="grid grid-cols-2 gap-4 text-center"><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1 text-green-400">Growth (BDT)</p><p class="text-4xl font-black text-white">৳<span id="profit">0</span></p></div><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1 italic text-sky-400">Target BDT</p><p class="text-4xl font-black text-white">৳<span id="target">0</span></p></div></div>
        <div id="slots" class="space-y-3"></div><div class="grid grid-cols-2 gap-3"><button onclick="togglePause()" id="btnP" class="py-5 rounded-full bg-orange-900/20 border border-orange-500/30 text-orange-400 font-black text-[10px]">Pause</button><button onclick="logout()" class="py-5 rounded-full bg-slate-800 border border-slate-700 text-slate-400 font-black text-[10px]">Logout</button></div></div>
        <script>
            async function togglePause() { await fetch('/toggle?id=${userId}'); location.reload(); }
            async function logout() { if(confirm('LOGOUT?')) location.href='/logout?id=${userId}'; }
            async function update() { try { const r = await fetch('/api/data?id=${userId}'); const d = await r.json(); 
                document.getElementById('bal').innerText = d.balance; 
                document.getElementById('profit').innerText = (parseFloat(d.profit || 0)*124).toFixed(0);
                document.getElementById('target').innerText = d.targetBDT || 0;
                document.getElementById('btnP').innerText = d.isPaused ? "RESUME" : "PAUSE";
                const pM = document.getElementById('pM'); document.getElementById('pP').innerText = "BTC: $" + (d.btcPrice || 0).toFixed(2);
                if(d.pulse === "BULLISH") { pM.innerText = "📈 Bullish ("+d.btcTrend.toFixed(2)+"%)"; pM.className="text-[10px] font-black text-green-400"; }
                else if(d.pulse === "BEARISH") { pM.innerText = "⚠️ Bearish ("+d.btcTrend.toFixed(2)+"%)"; pM.className="text-[10px] font-black text-red-500"; }
                else { pM.innerText = "⚖️ Stable ("+d.btcTrend.toFixed(2)+"%)"; pM.className="text-[10px] font-black text-sky-400"; }
                let h = ''; (d.userSlots || []).forEach(s => { 
                    let c = parseFloat(s.pnl) >= 0 ? 'text-green-400' : 'text-red-400';
                    h += \`<div class="p-5 bg-slate-900/50 rounded-3xl border border-slate-800 shadow-lg uppercase"><div class="flex justify-between items-center mb-3"><span class="text-[11px] font-black text-sky-400">\${s.active ? s.sym+' [ACTIVE]' : 'Slot Idle'}</span><span class="text-[11px] font-black \${c}">\${s.active ? s.pnl+'%' : ''}</span></div>\${s.active ? \`<div class="grid grid-cols-2 text-[10px] font-mono text-slate-500 gap-y-1"><div>Buy: \${s.buy.toFixed(4)}</div><div class="text-right">Goal: \${s.targetP}</div><div class="text-sky-400">Live: \${s.curP.toFixed(4)}</div><div class="text-right italic">DCA: \${s.dca}</div></div>\` : ''}</div>\`;
                }); document.getElementById('slots').innerHTML = h; } catch(e){} } setInterval(update, 2000);
        </script></body></html>`);
    }
});
server.listen(process.env.PORT || 8080, '0.0.0.0', () => startGlobalEngine());

const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// 🛡️ Quantum AI Master v1000.9 - SHIELD & REBOUND
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
    { s: "AVAXUSDT", d: 3, qd: 1 }, { s: "XRPUSDT", d: 4, qd: 1 }, { s: "ADAUSDT", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, history: [], rsi: 50, btcTrend: 0, panic: false, ticks: [] });

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
        s.history.push(s.p); if(s.history.length > 60) s.history.shift();
        
        // Ticks for U-Turn Confirmation (১ হলে দাম বাড়ছে, ০ হলে কমছে)
        s.ticks.push(s.p > s.lp ? 1 : 0); if(s.ticks.length > 8) s.ticks.shift();
        s.rsi = calculateRSI(s.history);
        
        if (d.s === "BTCUSDT") {
            s.btcTrend = ((s.p - s.history[0]) / s.history[0] * 100);
            if (s.btcTrend < -0.06) { s.panic = true; setTimeout(() => s.panic = false, 180000); }
        }
    });

    setInterval(async () => {
        for (let uid in cachedUsers) {
            let u = cachedUsers[uid]; if (u.status === 'COMPLETED') continue;
            let btc = market["BTCUSDT"];
            let activeTrades = u.userSlots.filter(s => s.active);
            let deepLossCount = activeTrades.filter(s => s.pnl < -5.0).length;

            u.userSlots.forEach(async (sl) => {
                if (!sl.active || sl.isClosing) return;
                const ms = market[sl.sym]; if(!ms || ms.p === 0) return;
                let feeR = u.fMode === 'bnb' ? 0.00045 : 0.0005;
                sl.curP = ms.p; let rawPnL = ((ms.p - sl.buy) / sl.buy) * 100 * u.lev; sl.pnl = rawPnL - (feeR * 200);
                sl.netBDT = ((parseFloat(sl.qty) * ms.p - sl.totalCost) - (sl.totalCost + parseFloat(sl.qty) * ms.p) * feeR) * 124;

                if (sl.netBDT > (sl.maxNetBDT || 0)) sl.maxNetBDT = sl.netBDT;

                // --- ১. স্মার্ট এক্সিট লজিক ---
                // যদি ৩ বারের বেশি ডিসিএ হয়, তবে ১ টাকা লাভ পেলেই বের হবে (Safety Exit)
                let minP = (sl.dca >= 3 || btc.panic) ? 0.05 : 0.80; 

                if (sl.netBDT >= minP && (sl.netBDT <= sl.maxNetBDT - 0.02 || btc.panic)) {
                    sl.isClosing = true; u.profit = (u.profit || 0) + (sl.netBDT / 124);
                    sendTG(`✅ <b>EXIT: #${sl.sym}</b>\nProfit: ৳${sl.netBDT.toFixed(2)}`, u.cid);
                    if(u.mode !== 'demo') await placeOrder(sl.sym, "SELL", sl.qty, u);
                    setTimeout(() => { Object.assign(sl, { active: false, sym: '', isClosing: false, maxNetBDT: 0 }); saveDB(); }, 1200);
                }

                // --- ২. ইউ-টার্ন ডিসিএ (দাম কমা শেষ হয়ে বাড়তে শুরু করলে কেনা) ---
                let dcaTrigger = sl.dca === 0 ? -2.2 : (sl.dca === 1 ? -5.0 : -10.0);
                // কনফার্মেশন: শেষ ৫ টি টিকের মধ্যে ৪টি পজিটিভ (দাম বাড়ছে) হতে হবে
                let uTurnConfirmed = ms.ticks.filter(x => x === 1).length >= 5;

                if (rawPnL <= dcaTrigger && sl.dca < 4 && uTurnConfirmed && !btc.panic) {
                    if (await placeOrder(sl.sym, "BUY", sl.qty, u)) {
                        sl.totalCost += (parseFloat(sl.qty) * ms.p); sl.qty = (parseFloat(sl.qty) * 2).toString();
                        sl.buy = sl.totalCost / parseFloat(sl.qty); sl.dca++; saveDB();
                        sendTG(`🌀 <b>U-TURN DCA #${sl.dca}: ${sl.sym}</b>\nPrice confirmed rebound.`, u.cid);
                    }
                }
            });

            // --- ৩. শিল্ড মোড হান্টিং (বিপদ থাকলে নতুন এন্ট্রি হবে না) ---
            if (!u.isPaused && activeTrades.length < u.slots && deepLossCount < 2 && !btc.panic) {
                if (btc.btcTrend < -0.04) continue;
                for (let sym of Object.keys(market)) {
                    if (u.userSlots.filter(s => s.active).length >= u.slots) break;
                    const m = market[sym]; if (m.p === 0 || m.history.length < 40) continue;
                    
                    // এন্ট্রি শর্ত: RSI ২৭ এর নিচে (ওভারসোল্ড) এবং ইউ-টার্ন কনফার্মেশন
                    if (m.rsi < 28 && m.ticks.filter(x => x === 1).length >= 5) {
                        if (!u.userSlots.some(x => x.active && x.sym === sym)) {
                            let tV = (u.cap * u.lev) / u.slots / 15, qty = (tV / m.p).toFixed(COINS.find(c => c.s === sym).qd);
                            const sIdx = u.userSlots.findIndex(sl => !sl.active);
                            if (sIdx !== -1 && await placeOrder(sym, "BUY", qty, u)) {
                                u.userSlots[sIdx] = { id: sIdx, active: true, sym: sym, buy: m.p, qty: qty, pnl: 0, curP: m.p, dca: 0, totalCost: (parseFloat(qty) * m.p), netBDT: -0.05, maxNetBDT: 0 };
                                saveDB(); sendTG(`🚀 <b>SHIELD ENTRY: #${sym}</b>`, u.cid);
                            }
                        }
                    }
                }
            }
        }
    }, 900);
}

// UI UPDATE (PNL% First, Amount Second)
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`); const userId = url.pathname.slice(1);
    if (url.pathname === '/api/data') {
        const u = cachedUsers[url.searchParams.get('id')]; const rawB = await getBinanceBalance(u || {});
        let btc = market["BTCUSDT"] || { btcTrend: 0, p: 0, panic: false };
        let active = u?.userSlots?.filter(s => s.active) || [];
        let deepCount = active.filter(s => s.pnl < -5.0).length;
        return res.end(JSON.stringify({ ...u, balance: rawB, btcPrice: btc.p.toLocaleString(), btcTrend: btc.btcTrend.toFixed(2), panic: btc.panic, shield: deepCount >= 2 }));
    }
    
    // Registration Logic
    if (url.pathname === '/register') { 
        let q = url.searchParams; let id = q.get('id');
        cachedUsers[id] = { api: q.get('api'), sec: q.get('sec'), cid: q.get('cid'), cap: Number(q.get('cap')), lev: Number(q.get('lev')), slots: Number(q.get('slots')), targetBDT: Number(q.get('target')), mode: q.get('mode'), fMode: q.get('fmode'), profit: 0, isPaused: false, status: 'ACTIVE', userSlots: Array(Number(q.get('slots'))).fill(null).map((_, i) => ({ id: i, active: false, sym: '', buy: 0, qty: 0, pnl: 0, curP: 0, dca: 0, totalCost: 0, netBDT: 0, maxNetBDT: 0 })) };
        saveDB(); res.writeHead(302, { 'Location': '/' + id }); return res.end(); 
    }
    if (url.pathname === '/toggle-pause') { let u = cachedUsers[url.searchParams.get('id')]; if (u) { u.isPaused = !u.isPaused; saveDB(); } res.writeHead(200); return res.end("OK"); }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !cachedUsers[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-6 flex items-center min-h-screen font-sans text-center"><div class="max-w-md mx-auto w-full space-y-6"><h1 class="text-6xl font-black text-sky-400 italic">QUANTUM</h1><p class="text-[10px] text-sky-600 font-bold tracking-widest">SHIELD SYSTEM v1000.9</p><form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 border border-slate-800 text-left shadow-2xl"><input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl outline-none" required><div class="grid grid-cols-2 gap-2"><input name="cap" type="number" placeholder="Cap $" class="bg-black p-4 rounded-xl outline-none"><input name="target" type="number" placeholder="Target ৳" class="bg-black p-4 rounded-xl outline-none"></div><input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-xl outline-none"><input name="sec" placeholder="Binance Secret" class="w-full bg-black p-4 rounded-xl outline-none"><input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-xl outline-none"><div class="grid grid-cols-2 gap-2"><input name="lev" type="number" placeholder="Leverage" class="bg-black p-4 rounded-xl outline-none"><input name="slots" type="number" placeholder="Max Slots" class="bg-black p-4 rounded-xl outline-none"></div><div class="grid grid-cols-2 gap-2"><select name="mode" class="bg-black p-4 rounded-xl outline-none"><option value="live">Live</option><option value="demo">Demo</option></select><select name="fmode" class="bg-black p-4 rounded-xl outline-none"><option value="usdt">USDT</option><option value="bnb">BNB</option></select></div><button type="submit" class="w-full bg-sky-600 p-5 rounded-full font-black uppercase">Initialize Elite Hub</button></form></div></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-4 font-sans uppercase">
        <div class="max-width-xl mx-auto space-y-4">
            <div class="p-5 bg-slate-900 rounded-[2rem] border border-slate-800 flex justify-between items-center relative overflow-hidden">
                <div id="pLine" class="absolute top-0 left-0 h-1 transition-all duration-1000"></div>
                <div><p class="text-[8px] text-slate-500 font-bold mb-1 uppercase">BTC Live Price</p><p class="text-2xl font-black" id="btcVal">$0.00</p></div>
                <div class="text-right"><p id="mStat" class="text-[9px] font-black px-3 py-1 rounded-full bg-slate-800 inline-block">STABLE</p><p id="btcTrend" class="text-[10px] text-slate-400 mt-1">0.00%</p></div>
            </div>

            <div class="p-6 bg-slate-900 rounded-[2.5rem] border-2 border-sky-500/30 text-center"><p class="text-[10px] text-sky-400 font-bold mb-1">Growth (BDT)</p><p class="text-5xl font-black text-white">৳<span id="profitText">0</span></p></div>

            <div id="slotContainer" class="space-y-3"></div>
            <button onclick="togglePause()" id="pauseBtn" class="w-full py-5 rounded-full text-[12px] font-black bg-orange-900/20 border border-orange-500/30 text-orange-400">AI PAUSE</button>
        </div>
        <script>
            async function togglePause() { await fetch('/toggle-pause?id=${userId}'); location.reload(); }
            async function updateData() { try { const res = await fetch('/api/data?id=${userId}'); const d = await res.json(); 
                document.getElementById('profitText').innerText = (Number(d.profit || 0) * 124).toFixed(2);
                document.getElementById('btcVal').innerText = "$" + d.btcPrice;
                document.getElementById('btcTrend').innerText = d.btcTrend + "%";
                document.getElementById('pauseBtn').innerText = d.isPaused ? "RESUME" : "PAUSE";
                
                const mStat = document.getElementById('mStat');
                const pLine = document.getElementById('pLine');
                if(d.panic) { mStat.innerText = "PANIC MODE"; mStat.className="text-[9px] font-black px-3 py-1 rounded-full bg-red-900/50 text-red-400"; pLine.className="absolute top-0 left-0 h-1 bg-red-500 w-full"; }
                else if(d.shield) { mStat.innerText = "SHIELD ACTIVE"; mStat.className="text-[9px] font-black px-3 py-1 rounded-full bg-orange-900/50 text-orange-400"; pLine.className="absolute top-0 left-0 h-1 bg-orange-500 w-full"; }
                else { mStat.innerText = "STABLE"; mStat.className="text-[9px] font-black px-3 py-1 rounded-full bg-slate-800 text-sky-400"; pLine.className="absolute top-0 left-0 h-1 bg-sky-500 w-full shadow-[0_0_10px_#0ea5e9]"; }

                let h = ''; d.userSlots.forEach((s, i) => {
                    if(!s.active) h += \`<div class="p-4 bg-slate-900/40 border border-slate-800 rounded-3xl text-center text-slate-600 text-[9px] font-bold">SLOT \${i+1} IDLE</div>\`;
                    else {
                        const isLoss = s.pnl < 0;
                        h += \`<div class="p-5 bg-slate-900 rounded-[2.2rem] border border-slate-800 shadow-xl relative">
                            <div class="flex justify-between items-start mb-3">
                                <div><p class="text-sky-400 text-xs font-black uppercase">\${s.sym} [DCA:\${s.dca}]</p><p class="text-[9px] text-slate-500 font-bold mt-1 italic">Quantum Protection Active</p></div>
                                <div class="text-right"><p class="\${isLoss ? 'text-red-500' : 'text-green-500'} text-sm font-black tracking-tighter">\${s.pnl.toFixed(2)}% (৳\${s.netBDT.toFixed(2)})</p></div>
                            </div>
                            <div class="grid grid-cols-2 gap-y-1 text-[9px] font-mono text-slate-500 uppercase"><div>Buy: \${s.buy.toFixed(4)}</div><div class="text-right">Live: \${s.curP.toFixed(4)}</div></div>
                        </div>\`;
                    }
                }); document.getElementById('slotContainer').innerHTML = h; } catch(e) {} } setInterval(updateData, 900);</script></body></html>`);
    }
});
server.listen(process.env.PORT || 8080, '0.0.0.0', () => startGlobalEngine());

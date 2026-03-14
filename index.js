const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// 🛡️ Quantum Master v130.0 - SILENT GUARDIAN
// ==============================================
const MASTER_TG_TOKEN = "8281887575:AAG5OR86LCQO_90479FKkia2F1sEAJjCP60"; 
const DB_FILE = 'nebula_master_hub.json';

let cachedUsers = {}; 
function loadDB() { try { if (fs.existsSync(DB_FILE)) cachedUsers = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { cachedUsers = {}; } }
function saveDB() { try { fs.writeFileSync(DB_FILE, JSON.stringify(cachedUsers, null, 2)); } catch(e) {} }
loadDB();

const COINS = [
    { s: "BTCUSDT", d: 2, qd: 3 }, { s: "ETHUSDT", d: 2, qd: 3 }, { s: "SOLUSDT", d: 3, qd: 2 }, 
    { s: "SUIUSDT", d: 4, qd: 1 }, { s: "APTUSDT", d: 3, qd: 1 }, { s: "NEARUSDT", d: 4, qd: 1 }, 
    { s: "AVAXUSDT", d: 3, qd: 1 }, { s: "DOGEUSDT", d: 5, qd: 0 }, { s: "XRPUSDT", d: 4, qd: 1 }, 
    { s: "ADAUSDT", d: 4, qd: 1 }, { s: "ICPUSDT", d: 3, qd: 1 }, { s: "1000PEPEUSDT", d: 7, qd: 0 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, history: [], low: 0, trend: 0, rsi: 50 });

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
async function sendTG(m, id) { try { await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: id, text: m, parse_mode: 'HTML' }); } catch(e) {} }

async function getBinanceBalance(c) {
    if (c.mode === 'demo' || !c.api) return parseFloat(c.cap || 0).toFixed(2);
    const ts = Date.now(); const sig = sign(`timestamp=${ts}`, c.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?timestamp=${ts}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': c.api }, timeout: 5000 });
        return res.data ? parseFloat(res.data.totalWalletBalance).toFixed(2) : "0.00";
    } catch (e) { return "0.00"; }
}

async function placeOrder(sym, side, qty, c) {
    if (c.mode === 'demo') return { orderId: 'DEMO' };
    const ts = Date.now(); let q = `symbol=${sym}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${ts}`;
    try { return (await axios.post(`https://fapi.binance.com/fapi/v1/order?${q}&signature=${sign(q, c.sec)}`, null, { headers: { 'X-MBX-APIKEY': c.api } })).data; } catch (e) { return null; }
}

async function startGlobalEngine() {
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/')}`);
    ws.on('message', (data) => {
        const d = JSON.parse(data).data; if (!d || !market[d.s]) return;
        const s = market[d.s]; s.lp = s.p; s.p = parseFloat(d.c);
        s.history.push(s.p); if(s.history.length > 30) s.history.shift();
        s.trend = s.p > s.lp ? Math.min(10, (s.trend || 0) + 1) : (s.p < s.lp ? 0 : s.trend);
        if (s.p < s.low || s.low === 0) s.low = s.p;
        s.rsi = calculateRSI(s.history);
    });

    setInterval(async () => {
        for (let uid in cachedUsers) {
            let u = cachedUsers[uid]; if (u.status === 'COMPLETED') continue;
            let feeR = u.fMode === 'bnb' ? 0.00045 : 0.0005;
            let activeTrades = u.userSlots.filter(s => s.active).length;

            u.userSlots.forEach(async (sl) => {
                if (!sl.active) return;
                const ms = market[sl.sym]; if(!ms || ms.p === 0) return;
                sl.curP = ms.p; let rawPnL = ((ms.p - sl.buy) / sl.buy) * 100 * u.lev; sl.pnl = rawPnL - (feeR * 200);
                sl.netBDT = ((parseFloat(sl.qty) * ms.p - sl.totalCost) - (sl.totalCost + parseFloat(sl.qty) * ms.p) * feeR) * 124;

                if (rawPnL >= 0.35) {
                    let lock = rawPnL - 0.01; if (ms.trend >= 7) lock = rawPnL - 0.03;
                    if (!sl.be || lock > sl.slP) { sl.slP = lock; sl.be = true; }
                }

                // সাধ্যমতো DCA (আপনার বিশেষ রিকোয়েস্ট)
                let dcaT = sl.dca === 0 ? -1.5 : -4.5;
                let idleCount = u.userSlots.length - activeTrades;
                if (idleCount >= 1 && rawPnL <= -0.8 && sl.dca < 2) dcaT = -0.8; 

                if (rawPnL <= dcaT && sl.dca < (u.cap < 10 ? 2 : 4) && (sl.totalCost/u.lev)*2 < u.cap*0.9) {
                    if (await placeOrder(sl.sym, "BUY", sl.qty, u)) {
                        let stM = (parseFloat(sl.qty) * ms.p) / u.lev;
                        if(u.mode === 'demo') u.cap = Number(u.cap) - stM;
                        sl.totalCost += (parseFloat(sl.qty) * ms.p); sl.qty = (parseFloat(sl.qty) * 2).toString();
                        sl.buy = sl.totalCost / parseFloat(sl.qty); sl.dca++; sl.sell = sl.buy * 1.0030; sl.be = false; saveDB();
                    }
                }

                if ((ms.p >= sl.sell || (sl.be && rawPnL <= sl.slP)) && sl.netBDT >= 0.5) {
                    u.profit = Number(u.profit || 0) + (sl.netBDT / 124);
                    if(u.mode === 'demo') u.cap = Number(u.cap) + (sl.netBDT / 124) + (sl.totalCost / u.lev);
                    sendTG(`✅ <b>PROFIT: #${sl.sym}</b>\nUsername: ${uid}\n✨ লাভ: ৳${sl.netBDT.toFixed(2)}`, u.cid);
                    if(u.mode !== 'demo') await placeOrder(sl.sym, "SELL", sl.qty, u);
                    setTimeout(() => { Object.assign(sl, { active: false, status: 'IDLE' }); saveDB(); }, 1200);
                }
            });

            // টার্গেট চেক এবং নতুন এন্ট্রি
            if ((Number(u.profit) * 124) >= Number(u.targetBDT)) {
                u.status = 'FINISHED'; if(activeTrades === 0) u.status = 'COMPLETED';
                saveDB();
            } else if (!u.isPaused && u.userSlots.findIndex(sl => !sl.active) !== -1 && u.status === 'ACTIVE') {
                for (let sym of Object.keys(market)) {
                    const m = market[sym]; if (m.p === 0 || m.history.length < 15) continue;
                    if (m.rsi < 42 && m.p < (Math.max(...m.history) * 0.9990) && m.p > (m.low * 1.0001)) {
                        if (!u.userSlots.some(x => x.active && x.sym === sym)) {
                            let tV = Math.max(5.1, (u.cap * u.lev) / u.userSlots.length / 20), qty = (tV / m.p).toFixed(COINS.find(c => c.s === sym).qd);
                            const sIdx = u.userSlots.findIndex(sl => !sl.active);
                            if (await placeOrder(sym, "BUY", qty, u)) {
                                if(u.mode === 'demo') u.cap = Number(u.cap) - (tV/u.lev);
                                u.userSlots[sIdx] = { id: sIdx, active: true, status: 'TRADING', sym: sym, buy: m.p, sell: m.p * 1.0040, slP: 0, qty: qty, pnl: 0, curP: m.p, dca: 0, totalCost: (parseFloat(qty) * m.p), be: false, netBDT: -0.10 };
                                saveDB(); sendTG(`🚀 <b>ENTRY: #${sym}</b>\nUser: ${uid}`, u.cid);
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
        let activeM = u?.userSlots?.reduce((a, s) => a + (s.active ? s.totalCost/u.lev : 0), 0) || 0;
        return res.end(JSON.stringify({ ...u, balance: (Number(rawB) - (u?.mode === 'demo' ? 0 : activeM)).toFixed(2) }));
    }
    if (url.pathname === '/register') { 
        let id = url.searchParams.get('id'), cap = parseFloat(url.searchParams.get('cap')), target = parseFloat(url.searchParams.get('target'));
        let suggestedLev = cap < 10 ? 20 : 25, suggestedSlots = cap < 20 ? 1 : (cap < 100 ? 3 : 5);
        cachedUsers[id] = { api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), cid: url.searchParams.get('cid'), cap: cap, lev: suggestedLev, slots: suggestedSlots, targetBDT: target, mode: url.searchParams.get('mode'), fMode: 'usdt', profit: 0, count: 0, isPaused: false, status: 'ACTIVE', userSlots: Array(suggestedSlots).fill(null).map((_, i) => ({ id: i, active: false, sym: '', buy: 0, sell: 0, slP: 0, qty: 0, pnl: 0, curP: 0, dca: 0, totalCost: 0, be: false, status: 'IDLE', netBDT: 0 })) };
        saveDB(); res.writeHead(302, { 'Location': '/' + id }); return res.end(); 
    }
    if (url.pathname === '/reset-logout') { if (cachedUsers[userId]) { delete cachedUsers[userId]; saveDB(); } res.writeHead(302, { 'Location': '/' }); return res.end(); }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !cachedUsers[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-6 flex items-center min-h-screen"><div class="max-w-md mx-auto w-full space-y-6"><h1 class="text-5xl font-black text-sky-400 text-center uppercase italic mb-8">Master Hub</h1><form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 border border-slate-800 shadow-2xl"><input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl outline-none" required><select name="mode" class="w-full bg-black p-4 rounded-xl outline-none"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select><input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-xl outline-none"><input name="sec" placeholder="Binance Secret" class="w-full bg-black p-4 rounded-xl outline-none"><input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-xl outline-none"><div class="grid grid-cols-2 gap-2"><input name="cap" type="number" placeholder="Capital $" class="bg-black p-4 rounded-xl outline-none"><input name="target" type="number" placeholder="Target ৳" class="bg-black p-4 rounded-xl outline-none"></div><button type="submit" class="w-full bg-sky-600 p-5 rounded-full font-black text-white uppercase shadow-xl">Start Guardian Bot</button></form></div></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-4 uppercase"><div class="max-width-xl mx-auto space-y-4">
        <div class="p-6 bg-slate-900 rounded-[2.5rem] border-2 border-sky-500/50 text-center shadow-2xl"><p class="text-[10px] text-sky-400 font-bold mb-1 italic">Silent Wallet Control</p><p class="text-5xl font-black">$<span id="balanceText">0.00</span></p><p class="text-[9px] mt-2 text-slate-500" id="statusText">System: ONLINE</p></div>
        <div class="grid grid-cols-2 gap-4 text-center"><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1">Growth</p><p class="text-4xl font-black text-green-400">৳<span id="profitText">0</span></p></div><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1 italic">Target</p><p class="text-4xl font-black text-sky-400">৳<span id="targetText">0</span></p></div></div>
        <div id="slotContainer" class="space-y-3"></div><a href="/reset-logout?id=${userId}" onclick="return confirm('লগ আউট করবেন?')" class="block w-full bg-slate-800 border border-slate-700 text-slate-400 py-5 rounded-full text-center text-[10px] font-black uppercase">Close User Session</a></div><script>
            async function updateData() { try { const res = await fetch('/api/data?id=${userId}'); const d = await res.json(); 
                document.getElementById('balanceText').innerText = d.balance; document.getElementById('profitText').innerText = (d.profit * 124).toFixed(2);
                document.getElementById('targetText').innerText = d.targetBDT; document.getElementById('statusText').innerText = "Status: " + d.status;
                let h = ''; d.userSlots.forEach((s, i) => { let m = s.active ? Math.max(0, Math.min(100, ((s.curP - s.buy) / (s.sell - s.buy)) * 100)) : 0;
                    h += \`<div class="p-5 bg-slate-900/50 rounded-3xl border border-zinc-800 mb-3 shadow-lg uppercase"><div class="flex justify-between items-center mb-3"><span class="text-[11px] font-black \${s.active ? 'text-sky-400' : 'text-zinc-700'} tracking-wider">\${s.active ? s.sym + ' [DCA:'+s.dca+']' : 'Slot '+(i+1)+' Scanning...'}</span>\${s.active ? \`<span class="text-[11px] font-black \${s.netBDT>=0?'text-green-500':'text-red-400'}">\${s.pnl.toFixed(2)}% (৳\${s.netBDT.toFixed(2)})</span>\` : ''}</div>\${s.active ? \`<div class="w-full bg-black h-1.5 rounded-full overflow-hidden mb-4"><div class="h-full bg-sky-500 transition-all duration-1000" style="width: \${m}%"></div></div><div class="grid grid-cols-2 text-[10px] font-mono text-slate-500 gap-y-1"><div>Buy: \${s.buy.toFixed(4)}</div><div class="text-right text-indigo-400 italic">Beast Recovery On</div></div>\` : ''}</div>\`;
                }); document.getElementById('slotContainer').innerHTML = h; } catch(e) {} } setInterval(updateData, 1000);</script></body></html>`);
    }
});
server.listen(process.env.PORT || 8080, '0.0.0.0', () => startGlobalEngine());

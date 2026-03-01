const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ Quantum AI - Master Final Core v69.0
// ==========================================
const MASTER_TG_TOKEN = "8281887575:AAG5OR86LCQO_90479FKkia2F1sEAJjCP60"; 
const FIXED_CHAT_ID = "5279510350"; 
const DB_FILE = 'nebula_master_final.json';

function getAllUsers() {
    try { if (!fs.existsSync(DB_FILE)) return {}; return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveUser(userId, data) {
    try { let users = getAllUsers(); users[userId] = { ...users[userId], ...data }; fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); } catch(e) {}
}

const COINS = [
    { s: "BTCUSDT", n: "BTC", d: 2, qd: 3 }, { s: "ETHUSDT", n: "ETH", d: 2, qd: 3 }, 
    { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 }, { s: "1000PEPEUSDT", n: "PEPE", d: 7, qd: 0 },
    { s: "BONKUSDT", n: "BONK", d: 8, qd: 0 }, { s: "WIFUSDT", n: "WIF", d: 4, qd: 1 },
    { s: "DOGEUSDT", n: "DOGE", d: 5, qd: 0 }, { s: "NEARUSDT", n: "NEAR", d: 4, qd: 1 },
    { s: "AVAXUSDT", n: "AVAX", d: 3, qd: 1 }, { s: "XRPUSDT", n: "XRP", d: 4, qd: 1 },
    { s: "SUIUSDT", n: "SUI", d: 4, qd: 1 }, { s: "TIAUSDT", n: "TIA", d: 4, qd: 1 },
    { s: "FETUSDT", n: "FET", d: 4, qd: 1 }, { s: "RNDRUSDT", n: "RNDR", d: 3, qd: 1 },
    { s: "MATICUSDT", n: "MATIC", d: 4, qd: 1 }, { s: "DOTUSDT", n: "DOT", d: 3, qd: 1 },
    { s: "ORDIUSDT", n: "ORDI", d: 3, qd: 1 }, { s: "APTUSDT", n: "APT", d: 3, qd: 1 },
    { s: "TRXUSDT", n: "TRX", d: 5, qd: 0 }, { s: "LINKUSDT", n: "LINK", d: 3, qd: 1 },
    { s: "ADAUSDT", n: "ADA", d: 4, qd: 1 }, { s: "UNIUSDT", n: "UNI", d: 3, qd: 1 },
    { s: "LDOUSDT", n: "LDO", d: 4, qd: 1 }, { s: "FILUSDT", n: "FIL", d: 3, qd: 1 },
    { s: "GALAUSDT", n: "GALA", d: 5, qd: 0 }, { s: "ICPUSDT", n: "ICP", d: 3, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, trend: 0, history: [] });
let userSlots = {}; 

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

async function sendTG(msg, chatId) {
    const id = chatId || FIXED_CHAT_ID;
    try { await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: id, text: msg, parse_mode: 'HTML' }); return true; } catch (e) { return false; }
}

async function getBinanceBalance(config) {
    if (config.mode === 'demo' || !config.api) return config.cap.toFixed(2);
    const ts = Date.now();
    const sig = sign(`timestamp=${ts}`, config.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?timestamp=${ts}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': config.api }, timeout: 5000 });
        return res.data ? parseFloat(res.data.totalWalletBalance).toFixed(2) : "0.00";
    } catch (e) { return "Error"; }
}

async function placeOrder(symbol, side, qty, config, type = "MARKET", price = null) {
    if (config.mode === 'demo') return { orderId: 'DEMO_' + Date.now() };
    const ts = Date.now();
    let query = `symbol=${symbol}&side=${side}&type=${type}&quantity=${qty}&timestamp=${ts}`;
    if(type === "LIMIT") query += `&price=${price}&timeInForce=GTC`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.post(`https://fapi.binance.com/fapi/v1/order?${query}&signature=${signature}`, null, { headers: { 'X-MBX-APIKEY': config.api } });
        return res.data;
    } catch (e) { return null; }
}

async function startGlobalEngine() {
    const streams = COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    ws.on('message', async (data) => {
        const payload = JSON.parse(data);
        const msg = payload.data;
        if (!msg || !market[msg.s]) return;

        const s = market[msg.s];
        s.lp = s.p; s.p = parseFloat(msg.c);
        s.history.push(s.p); if(s.history.length > 25) s.history.shift();
        s.trend = s.p > s.lp ? Math.min(10, (s.trend || 0) + 1) : 0;

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            let maxSlots = parseInt(config.slots) || 5;
            if (!userSlots[userId]) userSlots[userId] = Array(maxSlots).fill(null).map((_, i) => ({ id: i, active: false, sym: '', buy: 0, sell: 0, slP: 0, qty: 0, pnl: 0, curP: 0, dca: 0, totalCost: 0, be: false, status: 'IDLE' }));
            
            userSlots[userId].forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.curP = s.p;

                // ১. লিমিট ফিলাপ চেক (Pullback Hunter)
                if (sl.status === 'WAITING_LIMIT') {
                    if (s.p <= sl.buy) { sl.status = 'TRADING'; sendTG(`🎯 <b>Limit Hit:</b> #${sl.sym} কেনা হয়েছে।`, config.cid); }
                    return;
                }

                if (sl.status !== 'TRADING') return;

                let rawPnL = ((s.p - sl.buy) / sl.buy) * 100 * config.lev;
                sl.pnl = rawPnL - 0.14; 
                let netGainBDT = (((sl.qty * s.p) - (sl.totalCost)) * 0.9988) * 124;

                // ২. ট্রেন্ড ৭ লজিক (দাম বাড়লে টার্গেট তাড়া করা)
                if (s.p >= sl.sell && s.trend > 7) {
                    sl.sell = s.p * 1.0015; // টার্গেট ০.১৫% বাড়িয়ে দেওয়া হলো (অপেক্ষা)
                    return;
                }

                // ৩. ডায়নামিক ট্রেলিং শিল্ড (লাভ সুরক্ষা)
                if (rawPnL >= 0.35) {
                    let newShield = sl.buy * (1 + (rawPnL - 0.12) / (100 * config.lev)); 
                    if (!sl.be || newShield > sl.slP) { sl.slP = newShield; sl.be = true; }
                }

                // ৪. লিকুইডেশন-রোধী DCA (গ্যাপ: ১.৫%, ৪%, ৮%)
                let dcaTrigger = sl.dca === 0 ? -2.0 : (sl.dca === 1 ? -4.5 : -9.0);
                if (rawPnL <= dcaTrigger && sl.dca < 5) {
                    const order = await placeOrder(sl.sym, "BUY", sl.qty, config, "MARKET");
                    if (order) {
                        sl.totalCost += (sl.qty * s.p); sl.qty = parseFloat(sl.qty) * 2; sl.buy = sl.totalCost / sl.qty; sl.dca += 1; sl.sell = sl.buy * 1.0035; sl.be = false;
                        sendTG(`🌀 <b>DCA Hit:</b> #${sl.sym} (Level ${sl.dca})`, config.cid);
                    }
                }

                // ৫. প্রফিট বা শিল্ড ক্লোজিং (মিনিমাম ১ টাকা শর্তসহ)
                if ((s.p >= sl.sell || (sl.be && s.p <= sl.slP)) && netGainBDT >= 1) {
                    sl.status = 'COOLING'; config.profit += (netGainBDT / 124); config.count += 1; saveUser(userId, config);
                    sendTG(`✅ <b>PROFIT!</b> #${sl.sym}\n💵 লাভ: ৳${netGainBDT.toFixed(0)}\n📈 মোট সাগর: ৳${(config.profit * 124).toFixed(0)}`, config.cid);
                    if(config.mode !== 'demo') await placeOrder(sl.sym, "SELL", sl.qty, config, "MARKET");
                    setTimeout(() => { sl.active = false; sl.status = 'IDLE'; }, 1500);
                }
            });

            // ৬. স্মার্ট এন্ট্রি (বিটিসি গার্ডিয়ান + ক্রাশ ফিল্টার + লিমিট এন্ট্রি)
            const slotIdx = userSlots[userId].findIndex(sl => !sl.active);
            if (!config.isPaused && slotIdx !== -1 && s.trend >= 1) {
                const btc = market["BTCUSDT"];
                const btcDrop = btc?.history.length > 0 ? ((btc.p - btc.history[0]) / btc.history[0]) * 100 : 0;
                const coinDrop = s.history.length > 0 ? ((s.p - s.history[0]) / s.history[0]) * 100 : 0;

                if (btcDrop > -0.5 && coinDrop > -1.5) {
                    const sameCoin = userSlots[userId].filter(sl => sl.active && sl.sym === msg.s);
                    if (sameCoin.length === 0) {
                        const coin = COINS.find(c => c.s === msg.s);
                        const limitPrice = (s.p * 0.9940).toFixed(coin.d); 
                        const qty = ((config.cap / (maxSlots * 5) * config.lev) / limitPrice).toFixed(coin.qd);
                        const order = await placeOrder(msg.s, "BUY", qty, config, "LIMIT", limitPrice);
                        if (order) {
                            userSlots[userId][slotIdx] = { id: slotIdx, active: true, status: 'WAITING_LIMIT', sym: msg.s, buy: parseFloat(limitPrice), sell: limitPrice * 1.0040, slP: 0, qty: qty, pnl: 0, curP: s.p, dca: 0, totalCost: (qty * limitPrice), be: false };
                        }
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
        const uid = url.searchParams.get('id');
        const user = db[uid];
        const balance = await getBinanceBalance(user || {});
        return res.end(JSON.stringify({ slots: userSlots[uid] || [], profit: user ? (user.profit * 124).toFixed(0) : 0, count: user ? user.count : 0, isPaused: user?.isPaused || false, balance: balance, lev: user?.lev || 0 }));
    }
    if (url.pathname === '/toggle-pause') { const uid = url.searchParams.get('id'); if (db[uid]) { db[uid].isPaused = !db[uid].isPaused; saveUser(uid, db[uid]); } res.writeHead(200); return res.end("OK"); }
    if (url.pathname === '/reset') { const id = url.searchParams.get('id'); if (db[id]) { db[id].profit = 0; db[id].count = 0; saveUser(id, db[id]); userSlots[id] = null; } res.writeHead(302, { 'Location': '/' + id }); return res.end(); }
    if (url.pathname === '/register') { const id = url.searchParams.get('id'); const cid = url.searchParams.get('cid') || FIXED_CHAT_ID; saveUser(id, { api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), cid: cid, cap: parseFloat(url.searchParams.get('cap'))||10, lev: parseInt(url.searchParams.get('lev'))||20, slots: parseInt(url.searchParams.get('slots'))||5, mode: url.searchParams.get('mode')||'live', profit: 0, count: 0, isPaused: false }); sendTG("🚀 <b>Quantum Final v69.0 Online!</b>", cid); res.writeHead(302, { 'Location': '/' + id }); return res.end(); }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-6 flex items-center min-h-screen text-center"><div class="max-w-md mx-auto w-full space-y-6 uppercase font-black italic tracking-tighter"><h1 class="text-7xl text-sky-400">Quantum</h1><form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 border border-slate-800 text-left font-sans not-italic tracking-normal uppercase shadow-2xl"><input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none" required><select name="mode" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select><input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none"><input name="sec" placeholder="Binance Secret" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none"><input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none" value="${FIXED_CHAT_ID}"><div class="grid grid-cols-3 gap-2"><input name="cap" type="number" placeholder="Cap $" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><input name="lev" type="number" placeholder="Lev" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><input name="slots" type="number" placeholder="Slots" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"></div><button type="submit" class="w-full bg-sky-600 p-5 rounded-full font-black text-xl text-white uppercase">Start System</button></form></div></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-4 font-sans uppercase"><div class="max-w-xl mx-auto space-y-4"><div class="p-6 bg-slate-900 rounded-[2.5rem] border-2 border-sky-500/50 text-center shadow-2xl tracking-tighter"><p class="text-[10px] text-sky-400 font-bold mb-1 tracking-widest uppercase italic">Live Binance Balance</p><p class="text-5xl font-black text-white">$<span id="balanceText">0.00</span></p><div class="mt-2 text-[10px] text-slate-500 font-bold tracking-widest">Leverage: <span id="levText">0</span>x</div></div><div class="grid grid-cols-2 gap-4 text-center"><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1 uppercase tracking-widest font-black">Net Growth (BDT)</p><p class="text-4xl font-black text-green-400">৳<span id="profitText">0</span></p></div><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1 uppercase tracking-widest font-black">Wins</p><p class="text-4xl font-black text-sky-400" id="countText">0</p></div></div><div id="activeSlotContainer" class="space-y-3"></div><div id="idleSlotContainer" class="space-y-3"></div><div class="grid grid-cols-2 gap-3 pt-4 uppercase"><button onclick="togglePause()" id="pauseBtn" class="py-5 rounded-full text-[10px] font-black bg-orange-900/20 border border-orange-500/30 text-orange-400 tracking-widest font-black">Pause</button><a href="/reset?id=${userId}" onclick="return confirm('রিসেট করবেন?')" class="bg-red-900/20 border border-red-500/30 text-red-500 py-5 rounded-full text-center text-[10px] font-black tracking-widest uppercase italic text-white">Reset</a></div><a href="/" class="block w-full bg-slate-800 border border-slate-700 text-slate-400 py-5 rounded-full text-center text-[10px] font-black tracking-widest italic uppercase">Logout</a></div><script>async function togglePause() { await fetch('/toggle-pause?id=${userId}'); location.reload(); }async function updateData() { try { const res = await fetch('/api/data?id=${userId}'); const data = await res.json(); document.getElementById('balanceText').innerText = data.balance; document.getElementById('profitText').innerText = data.profit; document.getElementById('countText').innerText = data.count; document.getElementById('levText').innerText = data.lev; const pBtn = document.getElementById('pauseBtn'); if(data.isPaused) { pBtn.innerText = "RESUME"; pBtn.className = "flex-1 bg-green-900/20 border border-green-500/30 text-green-400 py-5 rounded-full text-[10px] font-black"; } else { pBtn.innerText = "PAUSE"; pBtn.className = "flex-1 bg-orange-900/20 border border-orange-500/30 text-orange-400 py-5 rounded-full text-[10px] font-black"; } 
                        let activeHtml = ''; let idleHtml = '';
                        data.slots.forEach((s, i) => {
                            if(s.active) {
                                let meter = Math.max(0, Math.min(100, ((s.curP - s.buy) / (s.sell - s.buy)) * 100));
                                activeHtml += \`<div class="p-5 bg-slate-900/50 rounded-3xl border border-zinc-800 transition-all duration-1000 mb-3 shadow-lg uppercase"><div class="flex justify-between items-center mb-3"><span class="text-[11px] font-black text-sky-400 tracking-wider">\${s.sym} \${s.status==='WAITING_LIMIT'?'[Hunting]':'[DCA:'+s.dca+']'}</span><span class="text-[11px] font-black \${s.pnl>=0?'text-green-500':'text-red-400'}">\${s.pnl.toFixed(2)}%</span></div><div class="w-full bg-black h-1.5 rounded-full overflow-hidden mb-4"><div class="h-full bg-sky-500 transition-all duration-1000" style="width: \${meter}%"></div></div><div class="grid grid-cols-2 text-[10px] font-mono text-slate-500 gap-y-1"><div>Entry: \${s.buy.toFixed(4)}</div><div class="text-right">Live: \${s.curP}</div><div class="text-orange-400">\${s.status==='WAITING_LIMIT'?'LIMIT ACTIVE':'SAFE DCA'}</div><div class="text-right text-green-500 font-bold">Target: \${s.sell.toFixed(4)}</div></div></div>\`;
                            } else {
                                idleHtml += \`<div class="p-4 bg-slate-900/10 rounded-3xl border border-dashed border-slate-800 text-center mb-2"><span class="text-[9px] text-slate-700 font-black tracking-[0.5em]">SCANNING SLOT \${i+1}...</span></div>\`;
                            }
                        });
                        document.getElementById('activeSlotContainer').innerHTML = activeHtml;
                        document.getElementById('idleSlotContainer').innerHTML = idleHtml;
                    } catch(e) {} } setInterval(updateData, 800);</script></body></html>`);
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => { 
    startGlobalEngine(); 
});

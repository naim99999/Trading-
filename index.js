const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ Quantum AI - Safe Growth Master v60.0
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
    { s: "TRXUSDT", n: "TRX", d: 5, qd: 0 }, { s: "LDOUSDT", n: "LDO", d: 4, qd: 1 },
    { s: "ARBUSDT", n: "ARB", d: 4, qd: 1 }, { s: "SHIBUSDT", n: "SHIB", d: 8, qd: 0 },
    { s: "LINKUSDT", n: "LINK", d: 3, qd: 1 }, { s: "ADAUSDT", n: "ADA", d: 4, qd: 1 },
    { s: "GALAUSDT", n: "GALA", d: 5, qd: 0 }, { s: "ICPUSDT", n: "ICP", d: 3, qd: 1 },
    { s: "RUNEUSDT", n: "RUNE", d: 3, qd: 1 }, { s: "OPUSDT", n: "OP", d: 4, qd: 1 },
    { s: "SATSUSDT", n: "SATS", d: 7, qd: 0 }, { s: "TIAUSDT", n: "TIA", d: 4, qd: 1 }
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
    if (config.mode === 'demo' || !config.api) return "100.00 (Demo)";
    const ts = Date.now();
    const sig = sign(`timestamp=${ts}`, config.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?timestamp=${ts}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': config.api }, timeout: 5000 });
        return res.data ? parseFloat(res.data.totalWalletBalance).toFixed(2) : "0.00";
    } catch (e) { return "Error"; }
}

async function placeOrder(symbol, side, qty, config) {
    if (config.mode === 'demo') return { orderId: 'DEMO_' + Date.now() };
    const ts = Date.now();
    let query = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${ts}`;
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
        s.history.push(s.p); if(s.history.length > 50) s.history.shift();
        s.trend = s.p > s.lp ? Math.min(10, (s.trend || 0) + 1) : 0;

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            let maxSlots = parseInt(config.slots) || 5;
            if (!userSlots[userId]) userSlots[userId] = Array(maxSlots).fill(null).map((_, i) => ({ id: i, active: false, sym: '', buy: 0, sell: 0, slP: 0, qty: 0, pnl: 0, curP: 0, dca: 0, totalCost: 0, be: false, status: 'IDLE' }));
            
            userSlots[userId].forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s || sl.status !== 'TRADING') return;
                sl.curP = s.p;

                let rawPnL = ((s.p - sl.buy) / sl.buy) * 100 * config.lev;
                sl.pnl = rawPnL - 0.15; 

                // ট্রেলিং শিল্ড
                if (rawPnL >= 0.35) {
                    let newShield = sl.buy * (1 + (rawPnL - 0.12) / (100 * config.lev)); 
                    if (!sl.be || newShield > sl.slP) { sl.slP = newShield; sl.be = true; }
                    if (rawPnL >= ((sl.sell - sl.buy) / sl.buy) * 100 * config.lev * 0.9) {
                        sl.sell = sl.buy * (1 + (rawPnL + 0.08) / (100 * config.lev));
                    }
                }

                // স্মার্ট ডিএসিএ (২% ড্রপে এভারেজ)
                let dcaTrigger = sl.dca === 0 ? -2.0 : (sl.dca === 1 ? -4.5 : -9.0);
                if (rawPnL <= dcaTrigger && sl.dca < 3) {
                    const order = await placeOrder(sl.sym, "BUY", sl.qty, config);
                    if (order) {
                        sl.totalCost += (sl.qty * s.p);
                        sl.qty = parseFloat(sl.qty) * 2;
                        sl.buy = sl.totalCost / sl.qty;
                        sl.dca += 1;
                        sl.sell = sl.buy * 1.0035; sl.be = false;
                        sendTG(`🌀 <b>DCA Hit:</b> #${sl.sym} (Level ${sl.dca}) এভারেজ করা হয়েছে।`, config.cid);
                    }
                }

                // প্রফিট ক্লোজিং
                let netGainUSD = ((sl.qty * s.p) - (sl.totalCost)) * 0.9985;
                if ((s.p >= sl.sell || (sl.be && s.p <= sl.slP)) && (netGainUSD * 124) >= 1) {
                    sl.status = 'COOLING'; 
                    config.profit += netGainUSD; config.count += 1;
                    saveUser(userId, config);
                    sendTG(`✅ <b>TRADE CLOSED!</b>\n🔸 <b>Coin:</b> #${sl.sym}\n💵 <b>Profit:</b> ৳${(netGainUSD * 124).toFixed(0)}\n📈 <b>Total:</b> ৳${(config.profit * 124).toFixed(0)}`, config.cid);
                    if(config.mode !== 'demo') await placeOrder(sl.sym, "SELL", sl.qty, config);
                    setTimeout(() => { sl.active = false; sl.status = 'IDLE'; }, 1000);
                }
            });

            // ৪. "Safe Growth" এন্ট্রি লজিক (Dip Detection)
            const slotIdx = userSlots[userId].findIndex(sl => !sl.active);
            if (!config.isPaused && slotIdx !== -1 && s.trend >= 2) {
                const sma = s.history.reduce((a,b)=>a+b, 0)/s.history.length;
                const localHigh = Math.max(...s.history);
                const isDip = s.p < sma && s.p < (localHigh * 0.9980); // দাম গড়ের নিচে এবং সর্বোচ্চ চূড়া থেকে ০.২০% কম

                if (isDip) {
                    const sameCoin = userSlots[userId].filter(sl => sl.active && sl.sym === msg.s);
                    if (sameCoin.length === 0) {
                        const coin = COINS.find(c => c.s === msg.s);
                        const qty = ((config.cap / (maxSlots * 4) * config.lev) / s.p).toFixed(coin.qd);
                        const order = await placeOrder(msg.s, "BUY", qty, config);
                        if (order) {
                            userSlots[userId][slotIdx] = { id: slotIdx, active: true, status: 'TRADING', sym: msg.s, buy: s.p, sell: s.p * 1.0040, slP: 0, qty: qty, pnl: 0, curP: s.p, dca: 0, totalCost: (qty * s.p), be: false };
                            sendTG(`🚀 <b>SAFE ENTRY:</b> #${msg.s} (Bought in Dip)`, config.cid);
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
        return res.end(JSON.stringify({ slots: userSlots[uid] || [], profit: user ? (user.profit * 124).toFixed(0) : 0, count: user ? user.count : 0, isPaused: user?.isPaused || false, balance: balance }));
    }
    if (url.pathname === '/toggle-pause') { const uid = url.searchParams.get('id'); if (db[uid]) { db[uid].isPaused = !db[uid].isPaused; saveUser(uid, db[uid]); } res.writeHead(200); return res.end("OK"); }
    if (url.pathname === '/reset') { const id = url.searchParams.get('id'); if (db[id]) { db[id].profit = 0; db[id].count = 0; saveUser(id, db[id]); userSlots[id] = null; } res.writeHead(302, { 'Location': '/' + id }); return res.end(); }
    if (url.pathname === '/register') { const id = url.searchParams.get('id'); const cid = url.searchParams.get('cid') || FIXED_CHAT_ID; saveUser(id, { api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), cid: cid, cap: parseFloat(url.searchParams.get('cap'))||10, lev: parseInt(url.searchParams.get('lev'))||20, slots: parseInt(url.searchParams.get('slots'))||5, mode: url.searchParams.get('mode')||'live', profit: 0, count: 0, isPaused: false }); sendTG("🚀 <b>Safe Growth Core Online!</b> আপনার যাত্রা সফল হোক।", cid); res.writeHead(302, { 'Location': '/' + id }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-6 flex items-center min-h-screen text-center"><div class="max-w-md mx-auto w-full space-y-6 uppercase font-black italic tracking-tighter"><h1 class="text-7xl text-sky-400">Quantum</h1><form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 border border-slate-800 text-left font-sans not-italic tracking-normal uppercase shadow-2xl"><input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none" required><select name="mode" class="w-full bg-black p-4 rounded-xl border border-slate-800"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select><input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none"><input name="sec" placeholder="Binance Secret" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none"><input name="cid" placeholder="Chat ID" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none" value="${FIXED_CHAT_ID}"><div class="grid grid-cols-3 gap-2"><input name="cap" type="number" placeholder="Cap $" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><input name="lev" type="number" placeholder="Lev" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><input name="slots" type="number" placeholder="Slots" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"></div><button type="submit" class="w-full bg-sky-600 p-5 rounded-full font-black uppercase text-xl text-white">Start Dream</button></form></div></body></html>`);
    } else {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-4 font-sans uppercase"><div class="max-w-xl mx-auto space-y-4"><div class="p-6 bg-slate-900 rounded-[2.5rem] border-2 border-sky-500/50 text-center shadow-2xl tracking-tighter"><p class="text-[10px] text-sky-400 font-bold mb-1 tracking-widest uppercase italic">Binance Balance</p><p class="text-5xl font-black text-white">$<span id="balanceText">0.00</span></p></div><div class="grid grid-cols-2 gap-4 text-center"><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1 uppercase tracking-widest">Growth (BDT)</p><p class="text-4xl font-black text-green-400">৳<span id="profitText">0</span></p></div><div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1 italic uppercase tracking-tighter">Wins</p><p class="text-4xl font-black text-sky-400" id="countText">0</p></div></div><div id="slotContainer" class="space-y-3"></div><div class="grid grid-cols-2 gap-3 pt-4 uppercase"><button onclick="togglePause()" id="pauseBtn" class="py-5 rounded-full text-[10px] font-black bg-orange-900/20 border border-orange-500/30 text-orange-400 tracking-widest">Pause</button><a href="/reset?id=${userId}" onclick="return confirm('রিসেট করবেন?')" class="bg-red-900/20 border border-red-500/30 text-red-500 py-5 rounded-full text-center text-[10px] font-black tracking-widest uppercase italic">Reset</a></div><a href="/" class="block w-full bg-slate-800 border border-slate-700 text-slate-400 py-5 rounded-full text-center text-[10px] font-black tracking-widest">Logout System</a></div><script>async function togglePause() { await fetch('/toggle-pause?id=${userId}'); location.reload(); }async function updateData() { try { const res = await fetch('/api/data?id=${userId}'); const data = await res.json(); document.getElementById('balanceText').innerText = data.balance; document.getElementById('profitText').innerText = data.profit; document.getElementById('countText').innerText = data.count; const pBtn = document.getElementById('pauseBtn'); if(data.isPaused) { pBtn.innerText = "RESUME"; pBtn.className = "flex-1 bg-green-900/20 border border-green-500/30 text-green-400 py-5 rounded-full text-[10px] font-black"; } else { pBtn.innerText = "PAUSE"; pBtn.className = "flex-1 bg-orange-900/20 border border-orange-500/30 text-orange-400 py-5 rounded-full text-[10px] font-black"; } let html = ''; data.slots.forEach((s, i) => { let meter = s.active ? Math.max(0, Math.min(100, ((s.curP - s.buy) / (s.sell - s.buy)) * 100)) : 0; html += \`<div class="p-5 bg-slate-900/50 rounded-3xl border border-zinc-800 transition-all duration-1000 mb-3 shadow-lg uppercase"><div class="flex justify-between items-center mb-3"><span class="text-[11px] font-black \${s.active ? 'text-sky-400' : 'text-zinc-700'} tracking-wider">\${s.active ? s.sym : 'Slot '+(i+1)+' Scanning...'} \${s.active ? '[DCA:'+s.dca+']' : ''}</span>\${s.active ? \`<span class="text-[11px] font-black \${s.pnl>=0?'text-green-500':'text-red-400'}">\${s.pnl.toFixed(2)}%</span>\` : ''}</div>\${s.active ? \`<div class="w-full bg-black h-1.5 rounded-full overflow-hidden mb-4"><div class="h-full bg-sky-500 transition-all duration-1000" style="width: \${meter}%"></div></div><div class="grid grid-cols-2 text-[10px] font-mono text-slate-500 gap-y-1 uppercase"><div>Entry: \${s.buy.toFixed(4)}</div><div class="text-right">Live: \${s.curP}</div><div class="text-orange-400">Safe Growth Mode</div><div class="text-right text-green-500 font-bold italic tracking-tighter">Precision Target</div></div>\` : ''}</div>\`; }); document.getElementById('slotContainer').innerHTML = html; } catch(e) {} } setInterval(updateData, 800);</script></body></html>`);
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => { 
    startGlobalEngine(); 
});

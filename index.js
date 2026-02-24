const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ সিস্টেম কনফিগ (Central Setup)
// ==========================================
const MASTER_TG_TOKEN = "8281887575:AAGRTPvSdT4ho8C2nwsxCHyUMkRq2q6qWDc"; 
const DB_FILE = 'nebula_master_final.json';

function getAllUsers() {
    if (!fs.existsSync(DB_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) { return {}; }
}
function saveUser(userId, data) {
    let users = getAllUsers();
    users[userId] = { ...users[userId], ...data };
    fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
}

const COINS = [
    { s: "BTCUSDT", n: "BTC", d: 2, qd: 3 }, { s: "ETHUSDT", n: "ETH", d: 2, qd: 3 }, 
    { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 }, { s: "1000PEPEUSDT", n: "PEPE", d: 7, qd: 0 },
    { s: "BONKUSDT", n: "BONK", d: 8, qd: 0 }, { s: "WIFUSDT", n: "WIF", d: 4, qd: 1 },
    { s: "DOGEUSDT", n: "DOGE", d: 5, qd: 0 }, { s: "NEARUSDT", n: "NEAR", d: 4, qd: 1 },
    { s: "AVAXUSAX", n: "AVAX", d: 3, qd: 1 }, { s: "XRPUSDT", n: "XRP", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, trend: 0, history: [] });
let userSlots = {}; 

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

async function setLeverage(symbol, leverage, config) {
    if (config.mode === 'demo') return true;
    const ts = Date.now();
    const query = `symbol=${symbol}&leverage=${leverage}&timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try {
        await axios.post(`https://fapi.binance.com/fapi/v1/leverage?${query}&signature=${signature}`, null, {
            headers: { 'X-MBX-APIKEY': config.api }
        });
        return true;
    } catch (e) { return false; }
}

async function getBinanceBalance(config) {
    if (config.mode === 'demo' || !config.api) return "1000.00 (DEMO)";
    const ts = Date.now();
    const query = `timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?${query}&signature=${signature}`, {
            headers: { 'X-MBX-APIKEY': config.api }, timeout: 5000
        });
        return res.data ? parseFloat(res.data.totalWalletBalance).toFixed(2) : "0.00";
    } catch (e) { return "Connect API"; }
}

async function sendTG(msg, chatId) {
    try {
        await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: chatId, text: msg, parse_mode: 'Markdown' });
    } catch (e) { }
}

async function placeOrder(symbol, side, price, qty, config, type = "LIMIT") {
    if (config.mode === 'demo') return { orderId: 'DEMO_123' };
    const ts = Date.now();
    let query = `symbol=${symbol}&side=${side}&type=${type}&quantity=${qty}&timestamp=${ts}`;
    if(type === "LIMIT") query += `&price=${price}&timeInForce=GTC`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.post(`https://fapi.binance.com/fapi/v1/order?${query}&signature=${signature}`, null, {
            headers: { 'X-MBX-APIKEY': config.api }
        });
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
        const avgP = s.history.reduce((a,b)=>a+b, 0) / s.history.length;

        if (s.p > s.lp) { s.trend = Math.min(10, (s.trend || 0) + 1); } 
        else { s.trend = 0; }

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, pnl: 0, dca1: 0, dca2: 0, curP: 0 }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.curP = s.p;

                if (sl.status === 'WAITING' && s.p <= sl.buy) {
                    sl.status = 'BOUGHT';
                    const cI = COINS.find(c=>c.s===sl.sym);
                    await placeOrder(sl.sym, "SELL", sl.sell.toFixed(cI.d), sl.qty, config, "LIMIT");
                    await placeOrder(sl.sym, "BUY", sl.dca1.toFixed(cI.d), sl.qty, config, "LIMIT");
                    sendTG(`📥 *বাই সম্পন্ন:* ${sl.sym}\nপ্রাইস: ${s.p}\nটার্গেট: ${sl.sell}`, config.cid);
                }

                if (sl.status === 'BOUGHT') {
                    sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * config.lev;
                    if (s.p >= sl.sell) {
                        const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy);
                        sl.active = false; config.profit += gain; config.count += 1;
                        saveUser(userId, config);
                        sendTG(`🎉 *セル সম্পন্ন!* ${sl.sym}\nলাভ: ৳${(gain*124).toFixed(0)}`, config.cid);
                        sl.status = 'IDLE';
                    }
                }
            });

            const slotIdx = slots.findIndex(sl => !sl.active);
            if (!config.isPaused && slotIdx !== -1 && s.trend >= 3 && s.p < avgP) {
                const sameCoin = slots.filter(sl => sl.active && sl.sym === msg.s);
                if (sameCoin.length === 0) {
                    const coin = COINS.find(c => c.s === msg.s);
                    const buyP = (s.p * 0.9995).toFixed(coin.d); 
                    const sellP = (parseFloat(buyP) * 1.0045).toFixed(coin.d);
                    const dca1P = (parseFloat(buyP) * 0.992).toFixed(coin.d);
                    const dca2P = (parseFloat(buyP) * 0.985).toFixed(coin.d);
                    const qty = ((config.cap / 5 * config.lev) / parseFloat(buyP)).toFixed(coin.qd);
                    
                    await setLeverage(msg.s, config.lev, config);
                    const order = await placeOrder(msg.s, "BUY", buyP, qty, config, "LIMIT");
                    
                    if (order) {
                        slots[slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: msg.s, buy: parseFloat(buyP), sell: parseFloat(sellP), dca1: parseFloat(dca1P), dca2: parseFloat(dca2P), qty: qty, pnl: 0, curP: s.p };
                    }
                }
            }
        }
    });
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}

// 🌐 ড্যাশবোর্ড
const server = http.createServer((req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    if (url.pathname === '/reset') {
        const id = url.searchParams.get('id');
        if (db[id]) { db[id].profit = 0; db[id].count = 0; saveUser(id, db[id]); userSlots[id] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, pnl: 0, dca1: 0, dca2: 0, curP: 0 })); }
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        saveUser(id, { api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), cid: url.searchParams.get('cid'), cap: parseFloat(url.searchParams.get('cap'))||10, lev: parseInt(url.searchParams.get('lev'))||20, mode: url.searchParams.get('mode')||'live', profit: 0, count: 0, isPaused: false });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-6 flex items-center min-h-screen"><div class="max-w-md mx-auto w-full space-y-6"><h1 class="text-4xl font-black text-sky-400 text-center uppercase tracking-tighter">Quantum Setup</h1><form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 border border-slate-800"><input name="id" placeholder="User Name" class="w-full bg-black p-4 rounded-2xl border border-slate-800" required><select name="mode" class="w-full bg-black p-4 rounded-2xl border border-slate-800"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select><input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800"><input name="sec" placeholder="Binance Secret Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800"><input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-2xl border border-slate-800" required><div class="grid grid-cols-2 gap-3"><input name="cap" type="number" placeholder="Capital ($)" class="bg-black p-4 rounded-2xl border border-slate-800"><input name="lev" type="number" placeholder="Leverage" class="bg-black p-4 rounded-2xl border border-slate-800"></div><button type="submit" class="w-full bg-sky-600 p-5 rounded-[2rem] font-black uppercase shadow-lg">Start System</button></form></div></body></html>`);
    } else {
        let user = db[userId];
        let slots = userSlots[userId] || Array(5).fill({sym:'Empty',active:false, pnl:0, curP:0, buy:0, sell:0, dca1:0});
        let totalProfitBDT = (user.profit * 124);
        let globalProgress = Math.min(100, (totalProfitBDT / 1000) * 100);

        getBinanceBalance(user).then(balance => {
            res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-[#020617] text-white p-4 font-sans"><div class="max-w-xl mx-auto space-y-4">
                
                <div class="p-6 bg-slate-900 rounded-[2.5rem] border border-sky-500/30 flex justify-between items-center">
                    <div><h2 class="text-2xl font-black text-sky-400 uppercase">${userId}</h2><p class="text-[10px] text-slate-500">LEV: ${user.lev}x • CAP: $${user.cap}</p></div>
                    <div class="text-right text-green-400 font-black text-xl">$${balance}</div>
                </div>

                <!-- গ্লোবাল প্রফিট মিটার -->
                <div class="bg-slate-900 p-5 rounded-[2rem] border border-slate-800">
                    <div class="flex justify-between text-[10px] font-bold mb-2 text-slate-400"><span>DAILY TARGET PROGRESS</span> <span>${globalProgress.toFixed(1)}%</span></div>
                    <div class="w-full bg-black h-2 rounded-full border border-slate-800 overflow-hidden"><div class="h-full bg-sky-500" style="width:${globalProgress}%"></div></div>
                </div>

                <div class="grid grid-cols-2 gap-4">
                    <div class="p-5 bg-slate-900 rounded-[2rem] border border-slate-800 text-center"><p class="text-[10px] text-slate-500 font-bold uppercase">Profit (BDT)</p><p class="text-2xl font-black text-green-400">৳${totalProfitBDT.toFixed(0)}</p></div>
                    <div class="p-5 bg-slate-900 rounded-[2rem] border border-slate-800 text-center"><p class="text-[10px] text-slate-500 font-bold uppercase">Trades</p><p class="text-2xl font-black text-sky-400">${user.count}</p></div>
                </div>

                <div class="space-y-3">
                    ${slots.map((s,i) => {
                        // স্লট মিটার ক্যালকুলেশন: এন্ট্রি থেকে সেল প্রাইস পর্যন্ত কতটুকু গেলো
                        let slotMeter = 0;
                        if(s.active && s.status === 'BOUGHT') {
                            let totalDistance = s.sell - s.buy;
                            let currentDistance = s.curP - s.buy;
                            slotMeter = Math.max(0, Math.min(100, (currentDistance / totalDistance) * 100));
                        }
                        
                        return `
                        <div class="p-4 bg-slate-900/50 rounded-3xl border border-zinc-800">
                            <div class="flex justify-between items-center mb-2">
                                <span class="text-xs font-black ${s.active ? 'text-sky-400' : 'text-zinc-700'}">${s.active ? s.sym : 'SLOT '+(i+1)+' SCANNING'}</span>
                                ${s.active ? `<span class="text-xs font-bold ${s.pnl>=0?'text-green-500':'text-red-400'}">${s.pnl.toFixed(2)}%</span>` : ''}
                            </div>
                            
                            ${s.active ? `
                                <!-- স্লট মিটার (Target Distance) -->
                                <div class="mb-3">
                                    <div class="flex justify-between text-[8px] text-slate-500 mb-1 font-mono uppercase"><span>Target Path</span> <span>${slotMeter.toFixed(1)}%</span></div>
                                    <div class="w-full bg-black h-1.5 rounded-full overflow-hidden">
                                        <div class="h-full bg-gradient-to-r from-orange-500 to-green-500 transition-all duration-1000" style="width: ${slotMeter}%"></div>
                                    </div>
                                </div>

                                <div class="grid grid-cols-2 gap-y-1 text-[10px] font-mono">
                                    <div class="text-slate-500">BUY: <span class="text-white">${s.buy}</span></div>
                                    <div class="text-right text-slate-500">LIVE: <span class="text-sky-300">${s.curP}</span></div>
                                    <div class="text-slate-500">DCA: <span class="text-orange-400">${s.dca1}</span></div>
                                    <div class="text-right text-slate-500">SELL: <span class="text-green-400">${s.sell}</span></div>
                                </div>` : ''}
                        </div>`}).join('')}
                </div>

                <div class="pt-4 flex gap-3">
                    <a href="/reset?id=${userId}" onclick="return confirm('Reset Profit & Trades?')" class="flex-1 bg-red-900/20 border border-red-500/30 text-red-500 py-4 rounded-[2rem] text-center text-[10px] font-black uppercase">Reset</a>
                    <button onclick="location.reload()" class="flex-1 bg-sky-600 py-4 rounded-[2rem] text-[10px] font-black uppercase">Refresh</button>
                </div>
            </div><script>setTimeout(()=>location.reload(), 3000);</script></body></html>`);
        });
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => { startGlobalEngine(); });

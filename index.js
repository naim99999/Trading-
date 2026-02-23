const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ কনফিগ ও ডাটাবেস
// ==========================================
const MASTER_TG_TOKEN = "8281887575:AAGRTPvSdT4ho8C2NwsxCHyUMkRq2q6qWDc"; 
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
    { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 }, { s: "XRPUSDT", n: "XRP", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, history: [] });
let userSlots = {}; 

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

// ⚙️ বাইনান্সে লেভারেজ সেট করার ফাংশন
async function setLeverage(symbol, leverage, config) {
    if (config.mode === 'demo') return;
    const ts = Date.now();
    const query = `symbol=${symbol}&leverage=${leverage}&timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try {
        await axios.post(`https://fapi.binance.com/fapi/v1/leverage?${query}&signature=${signature}`, null, {
            headers: { 'X-MBX-APIKEY': config.api }
        });
    } catch (e) { console.log(`Leverage Error for ${symbol}`); }
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
        return parseFloat(res.data.totalWalletBalance).toFixed(2);
    } catch (e) { return "Error"; }
}

async function placeOrder(symbol, side, price, qty, config, type = "LIMIT") {
    if (config.mode === 'demo') return { status: 'FILLED' };
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

// 🚀 ওমনি এঞ্জিন
async function startGlobalEngine() {
    const streams = COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    ws.on('message', async (data) => {
        const payload = JSON.parse(data);
        const msg = payload.data;
        if (!msg || !market[msg.s]) return;

        const s = market[msg.s];
        s.p = parseFloat(msg.c);
        s.history.push(s.p); if(s.history.length > 50) s.history.shift();
        const avgP = s.history.reduce((a,b)=>a+b, 0) / s.history.length;

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            if (config.status !== 'active') continue;

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, pnl: 0, curP: 0 }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                sl.curP = s.p;
                if (sl.status === 'BOUGHT') {
                    // ড্যাশবোর্ড থেকে আসা কাস্টম লেভারেজ অনুযায়ী PNL হিসাব
                    sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * config.lev;
                    if (s.p >= sl.sell) {
                        sl.active = false; config.profit += (sl.qty * (sl.sell - sl.buy));
                        saveUser(userId, config);
                        sl.status = 'IDLE';
                    }
                }
                if (sl.status === 'WAITING' && s.p <= sl.buy) sl.status = 'BOUGHT';
            });

            // নতুন ট্রেড ওপেন করার সময় কাস্টম লেভারেজ সেট করা
            const slotIdx = slots.findIndex(sl => !sl.active);
            if (!config.isPaused && slotIdx !== -1 && s.p < avgP) {
                const coin = COINS.find(c => c.s === msg.s);
                const buyP = (s.p * 0.999).toFixed(coin.d);
                // ড্যাশবোর্ড থেকে সেট করা লেভারেজ অনুযায়ী Qty বের করা
                const qty = ((config.cap / 5 * config.lev) / parseFloat(buyP)).toFixed(coin.qd);

                await setLeverage(msg.s, config.lev, config); // বাইনান্স অ্যাকাউন্টে লেভারেজ সেট
                const order = await placeOrder(msg.s, "BUY", buyP, qty, config, "LIMIT");
                
                if (order) {
                    slots[slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: msg.s, buy: parseFloat(buyP), sell: parseFloat(buyP)*1.002, qty: qty, pnl: 0, curP: s.p, dca1: buyP*0.99, dca2: buyP*0.98 };
                }
            }
        }
    });
}

// 🌐 ড্যাশবোর্ড UI
const server = http.createServer((req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        saveUser(id, { 
            api: url.searchParams.get('api'), 
            sec: url.searchParams.get('sec'), 
            cid: url.searchParams.get('cid'), 
            cap: parseFloat(url.searchParams.get('cap'))||10, 
            lev: parseInt(url.searchParams.get('lev'))||10, // ড্যাশবোর্ডের লেভারেজ এখানে সেভ হচ্ছে
            mode: url.searchParams.get('mode'),
            profit: 0, count: 0, status: 'active', isPaused: false 
        });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#09090b] text-white flex items-center min-h-screen p-6"><div class="max-w-md mx-auto w-full">
            <h1 class="text-3xl font-black text-sky-400 mb-6 text-center uppercase">Setup Your Account</h1>
            <form action="/register" class="space-y-4 bg-[#111114] p-8 rounded-[2rem] border border-zinc-900 shadow-2xl">
                <input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl border border-zinc-800" required>
                <input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-xl border border-zinc-800">
                <input name="sec" placeholder="Binance Secret Key" class="w-full bg-black p-4 rounded-xl border border-zinc-800">
                <input name="cid" placeholder="Telegram ID" class="w-full bg-black p-4 rounded-xl border border-zinc-800" required>
                <div class="grid grid-cols-2 gap-3">
                    <div><label class="text-[10px] text-zinc-500 ml-2">CAPITAL ($)</label><input name="cap" type="number" value="10" class="w-full bg-black p-4 rounded-xl border border-zinc-800"></div>
                    <div><label class="text-[10px] text-zinc-500 ml-2">LEVERAGE (x)</label><input name="lev" type="number" value="10" class="w-full bg-black p-4 rounded-xl border border-zinc-800"></div>
                </div>
                <select name="mode" class="w-full bg-black p-4 rounded-xl border border-zinc-800"><option value="live">Live Account</option><option value="demo">Demo Mode</option></select>
                <button class="w-full bg-sky-600 p-5 rounded-2xl font-black uppercase">Start Trading</button>
            </form></div></body></html>`);
    } else {
        const user = db[userId];
        const slots = userSlots[userId] || Array(5).fill({sym:'Empty', pnl:0, curP:0, buy:0});
        getBinanceBalance(user).then(balance => {
            res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-[#09090b] text-white p-4 font-sans"><div class="max-w-md mx-auto space-y-4">
                <div class="p-5 bg-[#111114] rounded-3xl border border-zinc-900 flex justify-between items-center">
                    <div><h2 class="text-2xl font-black text-sky-400">${userId}</h2><p class="text-[10px] text-zinc-500">LEV: ${user.lev}x | CAP: $${user.cap}</p></div>
                    <div class="text-right"><p class="text-[10px] text-zinc-500">WALLET</p><p class="text-2xl font-black text-green-400">$${balance}</p></div>
                </div>
                <div class="space-y-3">
                ${slots.map((s,i) => `
                    <div class="p-5 bg-[#111114] rounded-3xl border border-zinc-900">
                        <div class="flex justify-between items-start">
                            <span class="text-[10px] font-bold text-zinc-600 uppercase">Slot ${i+1}</span>
                            <span class="text-lg font-bold ${s.pnl>=0?'text-green-400':'text-red-400'}">${s.pnl.toFixed(2)}% PNL</span>
                        </div>
                        <h3 class="text-2xl font-black text-sky-400">${s.sym.replace('USDT','')}</h3>
                        ${s.active ? `<div class="flex justify-between text-[11px] mt-2 text-zinc-400 font-bold">
                            <span>BUY: ${s.buy.toFixed(2)}</span><span>LIVE: ${s.curP.toFixed(2)}</span>
                        </div>` : '<p class="text-[10px] text-zinc-800 font-bold uppercase tracking-widest mt-2">Searching Market...</p>'}
                    </div>`).join('')}
                </div>
            </div><script>setTimeout(()=>location.reload(), 5000);</script></body></html>`);
        });
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => { startGlobalEngine(); });

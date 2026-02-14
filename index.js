const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ অ্যাডমিন কনফিগ
// ==========================================
const ADMIN_USER = "naim1155"; 
const ADMIN_PASS = "115510"; 
const ADMIN_TG_TOKEN = "8380847229:AAG57WcfWbTkYG53yqVXdFiIOp3gZrjF_Fs"; 

const DB_FILE = 'master_db_v25.json';
const SETTINGS_FILE = 'settings.json';

function getAllUsers() {
    if (!fs.existsSync(DB_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) { return {}; }
}
function saveUser(userId, data) {
    let users = getAllUsers();
    users[userId] = { ...users[userId], ...data };
    fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
}

// 🎯 কয়েন লিস্ট
const COINS = [
    { s: "BTCUSDT", n: "BTC", d: 2, qd: 3 }, { s: "ETHUSDT", n: "ETH", d: 2, qd: 3 }, 
    { s: "SOLUSDT", n: "SOL", d: 3, qd: 2 }, { s: "1000PEPEUSDT", n: "PEPE", d: 7, qd: 0 },
    { s: "BONKUSDT", n: "BONK", d: 8, qd: 0 }, { s: "WIFUSDT", n: "WIF", d: 4, qd: 1 },
    { s: "1000SHIBUSDT", n: "SHIB", d: 7, qd: 0 }, { s: "1000FLOKIUSDT", n: "FLOKI", d: 5, qd: 0 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, trend: 0, lastSellTime: 0 });
let userSlots = {}; 

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }
function getOrdinal(n) {
    const ords = ["", "১ম", "২য়", "৩য়", "৪র্থ", "৫ম", "৬ষ্ঠ", "৭ম", "৮ম", "৯ম", "১০ম"];
    return n <= 10 ? ords[n] : n + "-তম";
}

async function sendTG(msg, chatId) {
    try { await axios.post(`https://api.telegram.org/bot${ADMIN_TG_TOKEN}/sendMessage`, { chat_id: chatId, text: msg, parse_mode: 'Markdown' }); } catch (e) {}
}

async function placeOrder(symbol, side, price, qty, config) {
    if (config.mode === 'demo') return { status: 'FILLED' };
    const ts = Date.now();
    const query = `symbol=${symbol}&side=${side}&type=LIMIT&quantity=${qty}&price=${price}&timeInForce=GTC&timestamp=${ts}`;
    const signature = sign(query, config.sec);
    try {
        const res = await axios.post(`https://fapi.binance.com/fapi/v1/order?${query}&signature=${signature}`, null, {
            headers: { 'X-MBX-APIKEY': config.api }
        });
        return res.data;
    } catch (e) { return null; }
}

// 🚀 ওমনি ইঞ্জিন
async function startGlobalEngine() {
    const streams = COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    ws.on('message', async (data) => {
        const payload = JSON.parse(data);
        const msg = payload.data;
        if (!msg || !market[msg.s]) return;

        const s = market[msg.s];
        s.lp = s.p; s.p = parseFloat(msg.c);
        if (s.p > s.lp) s.trend = Math.min(10, s.trend + 1); else s.trend = 0;

        let allUsers = getAllUsers();
        for (let userId in allUsers) {
            let config = allUsers[userId];
            if (config.status !== 'active') continue;

            if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, pnl: 0, lastBuy: 0, dca: 0 }));
            let slots = userSlots[userId];

            slots.forEach(async (sl) => {
                if (!sl.active || sl.sym !== msg.s) return;
                if (sl.status === 'WAITING' && s.p <= sl.buy) sl.status = 'BOUGHT';
                
                // পিএনএল হিসাব (ইউজার লিভারেজ অনুযায়ী)
                if (sl.status === 'BOUGHT') {
                    sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * (config.lev || 20);
                }

                // সেল লজিক
                if (sl.status === 'BOUGHT' && s.p >= sl.sell) {
                    const gain = (sl.qty * sl.sell) - (sl.qty * sl.buy) - (sl.qty * sl.sell * 0.0008);
                    sl.active = false; config.profit += gain; config.count += 1;
                    s.lastSellTime = Date.now(); // কুল-ডাউন শুরু
                    saveUser(userId, config);
                    sendTG(`🎉 *${getOrdinal(config.count)} সেল সম্পন্ন!* \n💰 কয়েন: ${sl.sym.replace('USDT','')}\n💵 নিট লাভ: $${gain.toFixed(2)} (৳${(gain*124).toFixed(0)})`, config.cid);
                    sl.status = 'IDLE'; sl.sym = '';
                }
            });

            // এন্ট্রি লজিক (কুল-ডাউন এবং ট্রেন্ড চেক)
            const slotIdx = slots.findIndex(sl => !sl.active);
            const cooldownActive = (Date.now() - s.lastSellTime < 180000); // ৩ মিনিট কুল-ডাউন

            if (slotIdx !== -1 && s.trend >= 3 && !cooldownActive && !slots.some(sl => sl.active && sl.sym === msg.s)) {
                const coin = COINS.find(c => c.s === msg.s);
                const buyP = s.p.toFixed(coin.d);
                const sellP = (parseFloat(buyP) * 1.0015).toFixed(coin.d);
                const qty = ((config.cap / 5 * config.lev) / parseFloat(buyP)).toFixed(coin.qd);
                if (parseFloat(qty) > 0) {
                    const order = await placeOrder(msg.s, "BUY", buyP, qty, config);
                    if (order) {
                        slots[slotIdx] = { id: slotIdx, active: true, status: 'WAITING', sym: msg.s, buy: parseFloat(buyP), sell: parseFloat(sellP), qty: qty, pnl: 0, lastBuy: parseFloat(buyP), dca: 0 };
                    }
                }
            }
        }
    });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);
    let users = getAllUsers();

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        saveUser(id, {
            api: url.searchParams.get('api') || 'demo', sec: url.searchParams.get('sec') || 'demo',
            cid: url.searchParams.get('cid'), cap: parseFloat(url.searchParams.get('cap')),
            lev: parseInt(url.searchParams.get('lev')) || 20, mode: url.searchParams.get('mode'),
            profit: 0, count: 0, status: (id === ADMIN_USER) ? 'active' : 'pending',
            expiry: (id === ADMIN_USER) ? new Date(2099, 1, 1).toISOString() : new Date().toISOString()
        });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !users[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-6 font-sans flex items-center min-h-screen text-center"><div class="max-w-md mx-auto space-y-6 w-full">
            <h1 class="text-4xl font-black text-sky-400 italic">QUANTUM VALKYRIE</h1>
            <form action="/register" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 text-left shadow-2xl">
                <input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white" required>
                <select name="mode" class="w-full bg-black p-4 rounded-2xl border border-slate-800"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select>
                <input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white">
                <input name="sec" placeholder="Binance Secret Key" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white">
                <input name="cid" placeholder="Telegram Chat ID" class="w-full bg-black p-4 rounded-2xl border border-slate-800 text-white" required>
                <div class="grid grid-cols-2 gap-3"><input name="cap" type="number" value="10" class="bg-black p-4 rounded-2xl"><input name="lev" type="number" placeholder="Leverage (e.g. 50)" value="50" class="bg-black p-4 rounded-2xl"></div>
                <button class="w-full bg-sky-600 p-5 rounded-2xl font-black uppercase shadow-lg">Launch Engine</button>
            </form>
        </div></body></html>`);
    } else {
        let user = users[userId];
        let slots = userSlots[userId] || Array(5).fill({sym:'READY',status:'IDLE',active:false, pnl:0});
        const active = (userId === ADMIN_USER) || (user.status === 'active');
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white font-sans p-4"><div class="max-w-xl mx-auto space-y-4">
            <div class="p-6 bg-slate-900 rounded-[2rem] border ${active ? 'border-green-500/30' : 'border-red-500/30'} flex justify-between items-center shadow-xl">
                <div><h2 class="text-3xl font-black italic underline decoration-sky-600">${userId.toUpperCase()}</h2><p class="text-[10px] text-slate-500 uppercase mt-1">LEVERAGE: ${user.lev}x</p></div>
                <div class="text-right"><div class="text-[10px] font-bold text-slate-500">WALLET PROFIT</div><div class="text-3xl font-black text-green-400">৳${(user.profit * 124).toFixed(0)}</div></div>
            </div>

            <div class="grid grid-cols-2 gap-3">
                <div class="bg-[#161b22] p-5 rounded-3xl border border-zinc-800 text-center shadow-2xl">
                    <p class="text-[10px] text-slate-500 uppercase font-black">Net Gain (USD)</p><p class="text-2xl font-bold text-green-400 mt-1">$${user.profit.toFixed(2)}</p>
                </div>
                <div class="bg-[#161b22] p-5 rounded-3xl border border-zinc-800 text-center shadow-2xl">
                    <p class="text-[10px] text-slate-500 uppercase font-black">Success Trades</p><p class="text-2xl font-bold text-sky-400 mt-1">${user.count}</p>
                </div>
            </div>

            <div class="bg-[#161b22] p-6 rounded-[2rem] border border-slate-800 shadow-2xl space-y-2">
                <p class="text-[10px] text-slate-500 font-bold uppercase mb-4 tracking-widest text-center">● Live Trading Slots</p>
                ${slots.map((s,i) => `
                <div class="flex justify-between p-4 bg-black/40 rounded-2xl border border-zinc-800/50">
                    <div><span class="text-[9px] font-bold text-slate-600 uppercase">Slot ${i+1}</span><p class="text-sm font-black ${s.active ? 'text-sky-400' : 'text-zinc-800'}">${s.active ? s.sym.replace('USDT','') : 'IDLE'}</p></div>
                    <div class="text-right">${s.active ? `<span class="text-xs font-bold ${s.pnl>=0?'text-green-500':'text-red-400'}">${s.pnl.toFixed(2)}% PNL</span>` : '<span class="text-[10px] text-zinc-800 font-black">SEARCHING</span>'}</div>
                </div>`).join('')}
            </div>

            <div class="text-center"><button onclick="location.href='/'" class="text-[10px] text-slate-600 font-bold uppercase underline">Switch Terminal</button></div>
        </div><script>setTimeout(()=>location.reload(), 5000);</script></body></html>`);
    }
});

server.listen(process.env.PORT || 8080, () => {
    startGlobalEngine();
});

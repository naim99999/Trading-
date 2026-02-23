const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ গ্লোবাল এরর হ্যান্ডেলার (যাতে অ্যাপ কখনো ক্র্যাশ না করে)
// ==========================================
process.on('uncaughtException', (err) => console.error('Uncaught Error:', err));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection:', reason));

const MASTER_TG_TOKEN = "8281887575:AAGRTPvSdT4ho8C2NwsxCHyUMkRq2q6qWDc"; 
const DB_FILE = '/tmp/nebula_master.json'; // Render-এ /tmp ফোল্ডার ব্যবহার করা নিরাপদ

function getAllUsers() { 
    if (!fs.existsSync(DB_FILE)) return {}; 
    try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) { return {}; } 
}
function saveUser(userId, data) { 
    try {
        let users = getAllUsers(); 
        users[userId] = { ...users[userId], ...data }; 
        fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); 
    } catch(e) { console.error("DB Save Error"); }
}

const COINS = [
    { s: "BTCUSDT", d: 2, qd: 3 }, { s: "ETHUSDT", d: 2, qd: 3 }, 
    { s: "SOLUSDT", d: 3, qd: 2 }, { s: "XRPUSDT", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, history: [], rsi: 50 });
let userSlots = {}; 

function calculateRSI(prices) {
    if (prices.length < 15) return 50;
    let gains = 0, losses = 0;
    for (let i = prices.length - 14; i < prices.length; i++) {
        let diff = prices[i] - prices[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    return 100 - (100 / (1 + (gains / (losses || 1))));
}

async function sendTG(msg, chatId) {
    if(!chatId) return;
    try { await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: chatId, text: msg, parse_mode: 'Markdown' }); } catch (e) {}
}

function sign(q, secret) { return crypto.createHmac('sha256', secret).update(q).digest('hex'); }

// ⚙️ বাইনান্স API ফাংশন (সেফটি সহ)
async function callBinance(path, method, query, config) {
    if (config.mode === 'demo') return { status: 'OK' };
    const ts = Date.now();
    const fullQuery = `${query}&timestamp=${ts}`;
    const signature = sign(fullQuery, config.sec);
    try {
        const res = await axios({
            method: method,
            url: `https://fapi.binance.com${path}?${fullQuery}&signature=${signature}`,
            headers: { 'X-MBX-APIKEY': config.api },
            timeout: 5000
        });
        return res.data;
    } catch (e) { return null; }
}

// 🚀 ট্রেড ইঞ্জিন
async function startGlobalEngine() {
    const streams = COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    ws.on('message', async (data) => {
        try {
            const payload = JSON.parse(data);
            const msg = payload.data;
            if (!msg || !market[msg.s]) return;

            const s = market[msg.s];
            s.p = parseFloat(msg.c);
            s.history.push(s.p); if(s.history.length > 100) s.history.shift();
            s.rsi = calculateRSI(s.history);

            let allUsers = getAllUsers();
            for (let userId in allUsers) {
                let u = allUsers[userId];
                if (u.status !== 'active' || u.isPaused) continue;

                if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, pnl: 0, qty: 0 }));
                let slots = userSlots[userId];

                slots.forEach(async (sl) => {
                    if (!sl.active || sl.sym !== msg.s) return;
                    sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * Math.min(u.lev, 10);

                    // Sell Logic
                    if (s.p >= sl.sell) {
                        const gain = (sl.qty * (sl.sell - sl.buy));
                        if(u.mode === 'demo') u.virtualBalance = (u.virtualBalance || 1000) + gain;
                        u.profit += gain; u.count += 1;
                        saveUser(userId, u);
                        sendTG(`💰 *${sl.sym} SOLD!*\nGain: ৳${(gain * 124).toFixed(0)}`, u.cid);
                        sl.active = false;
                    }
                });

                // Buy Logic (RSI Under 32)
                const slotIdx = slots.findIndex(sl => !sl.active);
                if (slotIdx !== -1 && s.rsi < 32) {
                    const coin = COINS.find(c => c.s === msg.s);
                    const qty = ((u.cap / 5 * Math.min(u.lev, 10)) / s.p).toFixed(coin.qd);
                    const order = await callBinance('/fapi/v1/order', 'POST', `symbol=${msg.s}&side=BUY&type=LIMIT&quantity=${qty}&price=${s.p.toFixed(coin.d)}&timeInForce=GTC`, u);
                    
                    if (order) {
                        slots[slotIdx] = { active: true, sym: msg.s, buy: s.p, sell: s.p * 1.008, qty: qty, pnl: 0 };
                        sendTG(`📥 *${msg.s} BOUGHT*\nPrice: ${s.p}\nMode: ${u.mode.toUpperCase()}`, u.cid);
                    }
                }
            }
        } catch(e) {}
    });
    ws.on('error', () => setTimeout(startGlobalEngine, 5000));
    ws.on('close', () => setTimeout(startGlobalEngine, 5000));
}

// 🌐 আল্টিমেট ড্যাশবোর্ড (Mobile First)
const server = http.createServer(async (req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        saveUser(id, { 
            api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), cid: url.searchParams.get('cid'), 
            cap: parseFloat(url.searchParams.get('cap')), lev: parseInt(url.searchParams.get('lev')), 
            mode: url.searchParams.get('mode'), profit: 0, count: 0, status: 'active', virtualBalance: 1000 
        });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white flex items-center min-h-screen p-6 font-sans">
            <div class="max-w-md mx-auto w-full space-y-8">
                <div class="text-center"><h1 class="text-5xl font-black text-sky-500 italic uppercase">Quantum</h1><p class="text-slate-500 text-xs mt-2 uppercase tracking-widest">Master Trading Engine</p></div>
                <form action="/register" class="bg-slate-900/50 p-8 rounded-[2.5rem] border border-slate-800 space-y-4 shadow-2xl backdrop-blur-xl">
                    <input name="id" placeholder="Create User ID" required class="w-full bg-black/40 p-4 rounded-2xl border border-slate-800 outline-none focus:border-sky-500 transition-all">
                    <select name="mode" class="w-full bg-black/40 p-4 rounded-2xl border border-slate-800"><option value="demo">Demo Mode (Safe)</option><option value="live">Live Trading (API)</option></select>
                    <input name="api" placeholder="Binance API Key" class="w-full bg-black/40 p-4 rounded-2xl border border-slate-800"><input name="sec" placeholder="Binance Secret Key" class="w-full bg-black/40 p-4 rounded-2xl border border-slate-800">
                    <input name="cid" placeholder="Telegram Chat ID" required class="w-full bg-black/40 p-4 rounded-2xl border border-slate-800">
                    <div class="flex gap-4"><input name="cap" type="number" value="100" class="w-1/2 bg-black/40 p-4 rounded-2xl border border-slate-800"><input name="lev" type="number" value="10" class="w-1/2 bg-black/40 p-4 rounded-2xl border border-slate-800"></div>
                    <button class="w-full bg-sky-600 p-5 rounded-[2rem] font-black uppercase shadow-lg shadow-sky-900/20 active:scale-95 transition">Launch Portal</button>
                </form>
            </div></body></html>`);
    } else {
        const u = db[userId];
        const slots = userSlots[userId] || Array(5).fill({sym:'SCANNING', pnl:0, active:false});
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-4 font-sans pb-10"><div class="max-w-md mx-auto space-y-4">
            <div class="p-6 bg-slate-900/80 rounded-[2.5rem] border border-slate-800 shadow-xl flex justify-between items-center">
                <div><h2 class="text-3xl font-black text-sky-400 italic">${userId}</h2><span class="text-[9px] bg-sky-500/20 text-sky-400 px-3 py-1 rounded-full font-bold uppercase tracking-widest mt-2 block w-max">${u.mode}</span></div>
                <div class="text-right"><p class="text-[9px] text-slate-500 font-bold uppercase">Net Profit (BDT)</p><p class="text-3xl font-black text-green-400">৳${(u.profit * 124).toFixed(0)}</p></div>
            </div>
            <div class="grid grid-cols-2 gap-3">
                <div class="bg-slate-900/50 p-5 rounded-[2rem] border border-slate-800 text-center"><p class="text-[9px] text-slate-500 font-bold uppercase">Success</p><p class="text-2xl font-bold text-sky-400">${u.count}</p></div>
                <div class="bg-slate-900/50 p-5 rounded-[2rem] border border-slate-800 text-center"><p class="text-[9px] text-slate-500 font-bold uppercase">Leverage</p><p class="text-2xl font-bold text-orange-400">${u.lev}x</p></div>
            </div>
            <div class="space-y-4 pt-2">
                ${slots.map((s,i) => `
                <div class="p-5 bg-slate-900/40 rounded-[2rem] border border-slate-800/50 backdrop-blur-sm">
                    <div class="flex justify-between items-start"><span class="text-[10px] font-bold text-slate-600 uppercase italic">Slot ${i+1}</span><span class="text-xl font-bold ${s.pnl>=0?'text-green-500':'text-red-400'}">${s.active ? s.pnl.toFixed(2)+'%' : ''}</span></div>
                    <h3 class="text-2xl font-black text-sky-400 mt-1 uppercase tracking-tight">${s.active ? s.sym.replace('USDT','') : '<span class="text-slate-800">Searching</span>'}</h3>
                    ${s.active ? `<div class="flex justify-between text-[11px] mt-3 font-bold text-slate-500"><div>ENTRY: <span class="text-white">${s.buy.toFixed(2)}</span></div><div class="text-right">TARGET: <span class="text-green-400">${s.sell.toFixed(2)}</span></div></div>` : ''}
                </div>`).join('')}
            </div>
            <div class="text-center opacity-20 mt-8"><button onclick="if(confirm('Reset Engine?')) location.href='/reset-now?id=${userId}'" class="text-[9px] text-red-500 font-bold uppercase underline tracking-widest">Wipe System Memory</button></div>
        </div><script>setTimeout(()=>location.reload(), 5000);</script></body></html>`);
    }
});

// ⚡ Render-এর জন্য সঠিক পোরট সেটিংস
const PORT = process.env.PORT || 10000; 
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    startGlobalEngine();
});

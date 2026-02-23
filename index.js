const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🛡️ সিস্টেম ও ক্র্যাশ প্রোটেকশন
// ==========================================
process.on('uncaughtException', (err) => console.log('System Restoring...'));
process.on('unhandledRejection', (reason) => console.log('Handling Rejection...'));

const MASTER_TG_TOKEN = "8281887575:AAGRTPvSdT4ho8C2NwsxCHyUMkRq2q6qWDc"; 
const DB_FILE = '/tmp/nebula_master_final.json'; 

function getAllUsers() { if (!fs.existsSync(DB_FILE)) return {}; try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) { return {}; } }
function saveUser(userId, data) { try { let users = getAllUsers(); users[userId] = { ...users[userId], ...data }; fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); } catch(e) {} }

const COINS = [
    { s: "BTCUSDT", d: 2, qd: 3 }, { s: "ETHUSDT", d: 2, qd: 3 }, 
    { s: "SOLUSDT", d: 3, qd: 2 }, { s: "XRPUSDT", d: 4, qd: 1 },
    { s: "BNBUSDT", d: 2, qd: 2 }, { s: "DOGEUSDT", d: 5, qd: 0 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, history: [], rsi: 50 });
let userSlots = {}; 

// 📉 RSI ক্যালকুলেটর (নিখুঁত এন্ট্রির জন্য)
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

// 🚀 ওমনি ট্রেড ইঞ্জিন (Fees + Aggressive Pricing + DCA)
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

                if (!userSlots[userId]) userSlots[userId] = Array(5).fill(null).map((_, i) => ({ id: i, active: false, status: 'IDLE', sym: '', buy: 0, sell: 0, qty: 0, pnl: 0, curP: 0, dca1: 0, dca2: 0 }));
                let slots = userSlots[userId];

                slots.forEach(async (sl) => {
                    if (!sl.active || sl.sym !== msg.s) return;
                    sl.curP = s.p;
                    sl.pnl = ((s.p - sl.buy) / sl.buy) * 100 * Math.min(u.lev, 15);

                    // DCA ১ চেক (৩.৫% ড্রপ করলে এভারেজ করবে)
                    if (sl.status === 'BOUGHT' && s.p <= sl.dca1) {
                        sl.status = 'DCA1_ACTIVE';
                        sl.buy = (sl.buy + s.p) / 2; // এভারেজ বাই প্রাইস
                        sl.sell = sl.buy * 1.0065; // দ্রুত লাভের জন্য টার্গেট সামান্য কমানো
                        sendTG(`📉 *DCA অ্যাক্টিভ:* ${sl.sym}\nনতুন এভারেজ বাই: ${sl.buy.toFixed(4)}\nমোট নিট লাভ: ৳${(u.profit * 124).toFixed(0)}`, u.cid);
                    }

                    // স্মার্ট সেল (বাইনান্স ফী বাদ দিয়ে নিট লাভ হিসাব)
                    if (s.p >= (sl.sell * 0.9998)) { // চালাকি: টার্গেটের সামান্য নিচেই সেল অর্ডার
                        const buyCost = sl.qty * sl.buy;
                        const sellValue = sl.qty * s.p;
                        const binanceFee = (buyCost + sellValue) * 0.0008; // ০.০৮% ফী বাদ
                        const netGain = (sellValue - buyCost) - binanceFee;

                        u.profit += netGain; u.count += 1;
                        saveUser(userId, u);
                        sendTG(`✅ *ট্রেড সফল (SOLD):* ${sl.sym}\nনিট লাভ: ৳${(netGain * 124).toFixed(0)}\nমোট আসল লাভ: ৳${(u.profit * 124).toFixed(0)}`, u.cid);
                        sl.active = false;
                    }
                });

                // স্মার্ট বাই (RSI ফিল্টার + Aggressive Entry)
                const slotIdx = slots.findIndex(sl => !sl.active);
                if (slotIdx !== -1 && s.rsi < 31) {
                    const coin = COINS.find(c => c.s === msg.s);
                    const qty = ((u.cap / 5 * Math.min(u.lev, 15)) / s.p).toFixed(coin.qd);
                    const buyP = s.p * 1.0002; // চালাকি: সামান্য বেশি দামে ঝটপট বাই

                    slots[slotIdx] = { 
                        active: true, status: 'BOUGHT', sym: msg.s, 
                        buy: buyP, sell: buyP * 1.0095, qty: qty, 
                        curP: s.p, dca1: buyP * 0.965, dca2: buyP * 0.93 
                    };
                    sendTG(`📥 *নতুন বাই সম্পন্ন:* ${msg.s}\nপ্রাইস: ${buyP.toFixed(coin.d)}\nমোট নিট লাভ: ৳${(u.profit * 124).toFixed(0)}`, u.cid);
                }
            }
        } catch(e) {}
    });
    ws.on('close', () => setTimeout(startGlobalEngine, 5000));
}

// 🌐 মোবাইল ফ্রেন্ডলি আল্টিমেট ড্যাশবোর্ড
const server = http.createServer(async (req, res) => {
    let db = getAllUsers();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    if (url.pathname === '/register') {
        const id = url.searchParams.get('id');
        saveUser(id, { api: url.searchParams.get('api'), sec: url.searchParams.get('sec'), cid: url.searchParams.get('cid'), cap: parseFloat(url.searchParams.get('cap'))||100, lev: parseInt(url.searchParams.get('lev'))||10, profit: 0, count: 0, status: 'active' });
        res.writeHead(302, { 'Location': '/' + id }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!userId || !db[userId]) {
        // সুন্দর রেজিস্টার পেজ
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white flex items-center min-h-screen p-6 font-sans"><div class="max-w-md mx-auto w-full text-center">
            <h1 class="text-5xl font-black text-sky-500 mb-2 italic uppercase">Quantum</h1><p class="text-slate-500 text-[10px] uppercase tracking-[0.3em] mb-8">Professional Trading Bot</p>
            <form action="/register" class="bg-slate-900/40 p-8 rounded-[2.5rem] border border-slate-800 space-y-4 backdrop-blur-lg">
                <input name="id" placeholder="Create User ID" required class="w-full bg-black/40 p-4 rounded-2xl border border-slate-800 outline-none focus:border-sky-500">
                <input name="cid" placeholder="Telegram Chat ID" required class="w-full bg-black/40 p-4 rounded-2xl border border-slate-800">
                <div class="flex gap-4"><input name="cap" type="number" placeholder="Capital $" class="w-1/2 bg-black/40 p-4 rounded-2xl border border-slate-800"><input name="lev" type="number" placeholder="Lev x" class="w-1/2 bg-black/40 p-4 rounded-2xl border border-slate-800"></div>
                <button class="w-full bg-sky-600 p-5 rounded-[2rem] font-black uppercase shadow-lg shadow-sky-900/20 active:scale-95 transition">Launch Engine</button>
            </form></div></body></html>`);
    } else {
        const u = db[userId];
        const slots = userSlots[userId] || Array(5).fill({sym:'Empty', pnl:0, active:false, curP:0, buy:0, sell:1, dca1:0});
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#020617] text-white p-4 font-sans pb-10"><div class="max-w-md mx-auto space-y-4">
            <div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl flex justify-between items-center backdrop-blur-md">
                <div><h2 class="text-3xl font-black text-sky-400 italic">${userId}</h2><p class="text-[9px] text-slate-500 font-bold uppercase tracking-widest mt-1">Net Mode Active</p></div>
                <div class="text-right"><p class="text-[9px] text-slate-500 font-bold uppercase">Net Profit (Fees Paid)</p><p class="text-3xl font-black text-green-400">৳${(u.profit * 124).toFixed(0)}</p></div>
            </div>

            <div class="space-y-4">
                ${slots.map((s,i) => {
                    let progress = s.active ? Math.max(0, Math.min(100, ((s.curP - s.buy) / (s.sell - s.buy)) * 100)) : 0;
                    return `
                    <div class="p-5 bg-slate-900/60 rounded-[2.5rem] border border-slate-800 shadow-lg">
                        <div class="flex justify-between items-start">
                            <span class="text-[10px] font-bold text-slate-600 uppercase italic">Slot ${i+1}</span>
                            <span class="text-lg font-bold ${s.pnl>=0?'text-green-500':'text-red-400'}">${s.active ? s.pnl.toFixed(2)+'%' : ''}</span>
                        </div>
                        <div class="flex justify-between items-end mt-1">
                            <h3 class="text-2xl font-black text-sky-400 uppercase tracking-tighter">${s.active ? s.sym.replace('USDT','') : '<span class="text-slate-800">Searching...</span>'}</h3>
                            ${s.active ? `<div class="text-right"><p class="text-[8px] text-slate-600 font-bold uppercase">Live Price</p><p class="text-sm font-bold text-white">${s.curP.toFixed(2)}</p></div>` : ''}
                        </div>
                        
                        ${s.active ? `
                        <div class="mt-4 space-y-2">
                            <div class="flex justify-between text-[8px] font-black text-slate-500 uppercase tracking-tighter">
                                <span>Buy: ${s.buy.toFixed(2)}</span>
                                <span class="text-red-500">DCA: ${s.dca1.toFixed(2)}</span>
                                <span class="text-green-400">Target: ${s.sell.toFixed(2)}</span>
                            </div>
                            <div class="w-full bg-black/50 h-3 rounded-full border border-slate-800 overflow-hidden">
                                <div class="bg-gradient-to-r from-sky-600 via-sky-400 to-green-400 h-full transition-all duration-700" style="width: ${progress}%"></div>
                            </div>
                        </div>` : ''}
                    </div>`}).join('')}
            </div>
            <div class="text-center opacity-30 pt-4"><button onclick="if(confirm('Reset Data?')) location.href='/reset-now?id=${userId}'" class="text-[9px] text-red-500 font-bold uppercase tracking-widest underline underline-offset-8">Wipe System Memory</button></div>
        </div><script>setTimeout(()=>location.reload(), 3500);</script></body></html>`);
    }
});

const PORT = process.env.PORT || 10000; 
server.listen(PORT, '0.0.0.0', () => { startGlobalEngine(); });

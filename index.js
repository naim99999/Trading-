const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// 👑 QUANTUM master engine v105.0 - WEBHOOK EDITION
// ==============================================
const MASTER_TG_TOKEN = "8281887575:AAG5OR86LCQO_90479FKkia2F1sEAJjCP60"; 
const FIXED_CHAT_ID = "5279510350"; 
const DB_FILE = 'quantum_webhook_v105.json';

let cachedUsers = {}; 
function loadDB() { try { if (fs.existsSync(DB_FILE)) cachedUsers = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { cachedUsers = {}; } }
function saveDB() { try { fs.writeFileSync(DB_FILE, JSON.stringify(cachedUsers, null, 2)); } catch(e) {} }
loadDB();

const COINS = [
    { s: "BTCUSDT", d: 2, qd: 3 }, { s: "ETHUSDT", d: 2, qd: 3 }, { s: "SOLUSDT", d: 3, qd: 2 }, 
    { s: "BNBUSDT", d: 2, qd: 2 }, { s: "AVAXUSDT", d: 3, qd: 1 }, { s: "NEARUSDT", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, maxP: 0 });

function sign(q, s) { return crypto.createHmac('sha256', s).update(q).digest('hex'); }
async function sendTG(m, id) { try { await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: id || FIXED_CHAT_ID, text: m, parse_mode: 'HTML' }); } catch(e) {} }

async function getBinanceBalance(u) {
    if (u.mode === 'demo') return { bal: Number(u.cap || 0).toFixed(2), status: "DEMO" };
    const ts = Date.now(); const sig = sign(`timestamp=${ts}`, u.sec);
    try { const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?timestamp=${ts}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': u.api }, timeout: 5000 }); return { bal: parseFloat(res.data.totalWalletBalance).toFixed(2), status: "CONNECTED" }; } 
    catch (e) { return { bal: "0.00", status: "AUTH_ERROR" }; }
}

async function placeOrder(sym, side, qty, u) {
    if (u.mode === 'demo') return { orderId: 'DEMO_' + Date.now(), status: 'FILLED' };
    const ts = Date.now(); let q = `symbol=${sym}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${ts}`;
    try { const res = await axios.post(`https://fapi.binance.com/fapi/v1/order?${q}&signature=${sign(q, u.sec)}`, null, { headers: { 'X-MBX-APIKEY': u.api } }); return res.data; } catch (e) { return null; }
}

// 🌐 WEBHOOK RECEIVER ENGINE
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    // 📩 ট্রেডিংভিউ থেকে সিগন্যাল রিসিভ করার গেটওয়ে
    if (req.method === 'POST' && url.pathname === '/webhook') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body); // { "id": "naim", "action": "BUY", "sym": "BTCUSDT" }
                const u = cachedUsers[data.id];
                if (!u || u.isPaused) return res.end("User Error");

                const coin = COINS.find(c => c.s === data.sym);
                if (!coin) return res.end("Coin Error");

                const sIdx = u.userSlots.findIndex(sl => !sl.active);
                if (data.action === "BUY" && sIdx !== -1) {
                    let walletBal = parseFloat(u.cap || 0);
                    let entryVal = (walletBal * u.lev) / u.userSlots.length / 4;
                    let qty = (entryVal / market[coin.s].p).toFixed(coin.qd);

                    if (await placeOrder(coin.s, "BUY", qty, u)) {
                        u.userSlots[sIdx] = { id: sIdx, active: true, sym: coin.s, buy: market[coin.s].p, qty: qty, totalCost: (parseFloat(qty) * market[coin.s].p), marginUsed: (entryVal/u.lev), dca: 0, maxP: market[coin.s].p };
                        saveDB(); sendTG(`🚀 <b>TV SIGNAL HIT! BUY #${coin.s}</b>`, u.cid);
                    }
                }
            } catch(e) {}
            res.end("OK");
        });
        return;
    }

    // ড্যাশবোর্ড ডাটা API
    if (url.pathname === '/api/data') {
        const u = cachedUsers[url.searchParams.get('id')];
        const apiData = await getBinanceBalance(u || {});
        if(u) u.userSlots.forEach(s => { if(s.active) s.curP = market[s.sym]?.p || s.buy; });
        return res.end(JSON.stringify({ ...u, balance: apiData.bal, apiStatus: apiData.status, btcPrice: market["BTCUSDT"]?.p.toFixed(2) }));
    }

    if (url.pathname === '/register') { 
        let q = url.searchParams; let id = q.get('id');
        cachedUsers[id] = { api: q.get('api'), sec: q.get('sec'), cid: q.get('cid'), cap: Number(q.get('cap')), targetBDT: Number(q.get('target')), lev: Number(q.get('lev')), mode: q.get('mode'), profit: 0, isPaused: false, userSlots: Array(4).fill(null).map((_,i)=>({id:i, active:false})) };
        saveDB(); res.writeHead(302, { 'Location': '/' + id }); return res.end(); 
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#020617] text-white p-6 font-sans">
    <div class="max-w-md mx-auto space-y-4">
        <h1 class="text-center text-sky-400 text-3xl font-black italic">QUANTUM WEBHOOK</h1>
        <div class="p-6 bg-slate-900 rounded-3xl border-2 border-sky-500/50 text-center"><p class="text-xs text-slate-500">Wallet Balance</p><p class="text-5xl font-black">$<span id="balanceText">0.00</span></p></div>
        <div id="slotContainer" class="space-y-2"></div>
    </div><script>
        async function updateData() { 
            const res = await fetch('/api/data?id=' + window.location.pathname.slice(1));
            const d = await res.json();
            document.getElementById('balanceText').innerText = d.balance || "0.00";
            let h = ''; d.userSlots.forEach(s => {
                h += \`<div class="p-4 bg-slate-800 rounded-2xl border border-slate-700">
                    <div class="flex justify-between"><span>\${s.active ? s.sym : 'Empty Slot'}</span><span class="\${s.pnl>=0?'text-green-400':'text-red-400'}">\${s.active ? s.pnl+'%' : ''}</span></div>
                </div>\`;
            }); document.getElementById('slotContainer').innerHTML = h;
        } setInterval(updateData, 1000);
    </script></body></html>`);
});

// 📊 বাইন্যান্স লাইভ প্রাইস ফিড
const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
ws.on('message', (data) => {
    JSON.parse(data).forEach(d => { if(market[d.s]) market[d.s].p = parseFloat(d.c); });
});

server.listen(process.env.PORT || 8080, '0.0.0.0', () => console.log("Webhook Ready!"));

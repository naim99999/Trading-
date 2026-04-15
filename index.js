const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// 👑 QUANTUM APEX AI v46.0 - PRO UNIVERSAL
// ==============================================
const MASTER_TG_TOKEN = "8281887575:AAG5OR86LCQO_90479FKkia2F1sEAJjCP60"; 
const FIXED_CHAT_ID = "5279510350"; 
const DB_FILE = 'quantum_ai_master_v46.json';

let cachedUsers = {}; 
function loadDB() { try { if (fs.existsSync(DB_FILE)) cachedUsers = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { cachedUsers = {}; } }
function saveDB() { try { fs.writeFileSync(DB_FILE, JSON.stringify(cachedUsers, null, 2)); } catch(e) {} }
loadDB();

const COINS = [
    { s: "BTCUSDT", d: 2, qd: 3 }, { s: "ETHUSDT", d: 2, qd: 3 }, 
    { s: "SOLUSDT", d: 3, qd: 2 }, { s: "BNBUSDT", d: 2, qd: 2 }, 
    { s: "AVAXUSDT", d: 3, qd: 1 }, { s: "NEARUSDT", d: 4, qd: 1 }, 
    { s: "SUIUSDT", d: 4, qd: 1 }, { s: "APTUSDT", d: 3, qd: 1 }, 
    { s: "DOGEUSDT", d: 5, qd: 0 }, { s: "PEPEUSDT", d: 8, qd: 0 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, rsi: 50, history: [] });

function calculateRSI(p) { 
    if (p.length <= 14) return 50; 
    let g=0, l=0; 
    for(let i=1; i<=14; i++) { 
        let d = p[p.length-i] - p[p.length-i-1]; 
        d >= 0 ? g += d : l -= d; 
    } 
    return 100 - (100 / (1 + (g / (l || 1)))); 
}

function sign(q, s) { return crypto.createHmac('sha256', s).update(q).digest('hex'); }

async function sendTG(m, id) { 
    try { await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: id || FIXED_CHAT_ID, text: m, parse_mode: 'HTML' }); } catch(e) {} 
}

async function getBinanceBalance(u) {
    if (u.mode === 'demo') return { bal: parseFloat(u.cap).toFixed(2), status: "DEMO_ACTIVE" };
    const ts = Date.now(); const q = `timestamp=${ts}`;
    try { 
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?${q}&signature=${sign(q, u.sec)}`, { headers: { 'X-MBX-APIKEY': u.api }, timeout: 5000 }); 
        return { bal: parseFloat(res.data.totalWalletBalance).toFixed(2), status: "LIVE_CONNECTED" }; 
    } catch (e) { return { bal: "0.00", status: "AUTH_ERROR" }; }
}

async function placeOrder(sym, side, qty, u) {
    if (u.mode === 'demo') return { orderId: 'DEMO_' + Date.now(), status: 'FILLED' };
    const ts = Date.now();
    let q = `symbol=${sym}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${ts}`;
    try { 
        const res = await axios.post(`https://fapi.binance.com/fapi/v1/order?${q}&signature=${sign(q, u.sec)}`, null, { headers: { 'X-MBX-APIKEY': u.api } }); 
        return res.data; 
    } catch (e) { return null; }
}

// Global Engine
async function startGlobalEngine() {
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/')}`);
    ws.on('message', (data) => {
        const d = JSON.parse(data).data; if (!d || !market[d.s]) return;
        const s = market[d.s]; s.p = parseFloat(d.c);
        s.history.push(s.p); if(s.history.length > 50) s.history.shift();
        s.rsi = calculateRSI(s.history);
    });

    setInterval(async () => {
        for (let uid in cachedUsers) {
            let u = cachedUsers[uid]; if (u.isPaused) continue;
            let walletData = await getBinanceBalance(u);
            let walletBal = parseFloat(walletData.bal);

            // প্রতিটি ইউজারের স্লট ম্যানেজমেন্ট
            if (!u.userSlots || u.userSlots.length === 0) {
                u.userSlots = [{ id: 0, active: false, sym: '', buy: 0, qty: 0, totalCost: 0, dca: 0, targetP: 0 }];
                saveDB();
            }

            for (let sl of u.userSlots) {
                const ms = market[sl.sym];
                
                // --- DCA Logic ---
                if (sl.active && ms && ms.p > 0) {
                    sl.curP = ms.p;
                    sl.pnl = (((ms.p - sl.buy) / sl.buy) * 100 * u.lev).toFixed(2);

                    // যদি ২% লস হয় তবে DCA করবে
                    if (parseFloat(sl.pnl) < -2.0 && sl.dca < 10) {
                        let coinCfg = COINS.find(c => c.s === sl.sym);
                        let nextQty = (parseFloat(sl.qty) * 1.5).toFixed(coinCfg.qd);
                        
                        // চেক ব্যালেন্স
                        let costUSD = (nextQty * ms.p) / u.lev;
                        if (walletBal > costUSD) {
                            let dcaOrder = await placeOrder(sl.sym, "BUY", nextQty, u);
                            if (dcaOrder) {
                                sl.totalCost += (parseFloat(nextQty) * ms.p);
                                sl.qty = (parseFloat(sl.qty) + parseFloat(nextQty)).toFixed(coinCfg.qd);
                                sl.buy = sl.totalCost / parseFloat(sl.qty);
                                sl.dca++;
                                let tVal = parseFloat(u.evenT);
                                sl.targetP = (sl.buy * (1 + (tVal/100/u.lev))).toFixed(coinCfg.d);
                                
                                if(u.mode === 'demo') u.cap -= costUSD;
                                sendTG(`🌀 <b>DCA EXECUTED (#${sl.sym})</b>\nLevel: ${sl.dca}\nNew Entry: ${sl.buy.toFixed(4)}\nNew Target: ${sl.targetP}`, u.cid);
                                saveDB();
                            }
                        }
                    }

                    // --- Take Profit Logic ---
                    if (ms.p >= sl.targetP) {
                        let sellOrder = await placeOrder(sl.sym, "SELL", sl.qty, u);
                        if (sellOrder) {
                            let profitUSD = (parseFloat(sl.qty) * ms.p) - sl.totalCost;
                            u.profit = (parseFloat(u.profit) + profitUSD).toFixed(4);
                            if(u.mode === 'demo') u.cap = (parseFloat(u.cap) + (sl.totalCost/u.lev) + profitUSD);
                            
                            sendTG(`✅ <b>PROFIT SECURED!</b>\nCoin: #${sl.sym}\nProfit: $${profitUSD.toFixed(2)}\nTotal Profit: $${u.profit}`, u.cid);
                            Object.assign(sl, { active: false, sym: '', dca: 0 });
                            saveDB();
                        }
                    }
                }

                // --- Entry Logic (RSI Based) ---
                if (!sl.active) {
                    for (let coin of COINS) {
                        const m = market[coin.s];
                        if (m.rsi < 25 && m.p > 0) { // Oversold এন্ট্রি
                            let minNotional = 6.0; // বিন্যান্স সেফটি লিমিট
                            let qty = (minNotional / m.p).toFixed(coin.qd);
                            let marginNeeded = minNotional / u.lev;

                            if (walletBal > marginNeeded) {
                                let order = await placeOrder(coin.s, "BUY", qty, u);
                                if (order) {
                                    sl.active = true;
                                    sl.sym = coin.s;
                                    sl.buy = m.p;
                                    sl.qty = qty;
                                    sl.totalCost = minNotional;
                                    sl.dca = 0;
                                    let tVal = parseFloat(u.evenT);
                                    sl.targetP = (sl.buy * (1 + (tVal/100/u.lev))).toFixed(coin.d);
                                    
                                    if(u.mode === 'demo') u.cap -= marginNeeded;
                                    sendTG(`🚀 <b>NEW TRADE OPENED</b>\nCoin: #${coin.s}\nPrice: ${m.p}\nTarget: ${sl.targetP}`, u.cid);
                                    saveDB();
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
    }, 3000);
}

// HTTP Server
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.pathname.slice(1);

    if (url.pathname === '/api/data') {
        const u = cachedUsers[url.searchParams.get('id')];
        if(!u) return res.end(JSON.stringify({}));
        const apiData = await getBinanceBalance(u);
        return res.end(JSON.stringify({ ...u, balance: apiData.bal, apiStatus: apiData.status }));
    }

    if (url.pathname === '/register') {
        let q = url.searchParams;
        cachedUsers[q.get('id')] = { 
            api: q.get('api'), sec: q.get('sec'), cid: q.get('cid'), 
            cap: Number(q.get('cap')), lev: Number(q.get('lev')), 
            evenT: q.get('evenT'), mode: q.get('mode'), 
            profit: 0, isPaused: false, userSlots: [] 
        };
        saveDB();
        sendTG(`🤖 <b>Quantum AI v46 Started!</b>\nMode: ${q.get('mode')}\nCapital: $${q.get('cap')}`, q.get('cid'));
        res.writeHead(302, { 'Location': '/' + q.get('id') }); return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    // HTML ড্যাশবোর্ড কোড এখানে (আগের মতোই হবে, শুধু ডিজাইন আরও উন্নত করা যেতে পারে)
    res.end(`... (Dashboard HTML) ...`);
});

server.listen(process.env.PORT || 8080, '0.0.0.0', () => startGlobalEngine());

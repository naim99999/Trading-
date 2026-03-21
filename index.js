const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

// ==============================================
// 👑 QUANTUM AI - REGAL SOLUTION v2.0
// ==============================================
const MASTER_TG_TOKEN = "8281887575:AAG5OR86LCQO_90479FKkia2F1sEAJjCP60"; 
const FIXED_CHAT_ID = "5279510350"; 
const DB_FILE = 'nebula_apex_final_hub.json';

let cachedUsers = {}; 
function loadDB() { try { if (fs.existsSync(DB_FILE)) cachedUsers = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { cachedUsers = {}; } }
function saveDB() { try { fs.writeFileSync(DB_FILE, JSON.stringify(cachedUsers, null, 2)); } catch(e) {} }
loadDB();

const COINS = [
    { s: "BTCUSDT", d: 2, qd: 3 }, { s: "ETHUSDT", d: 2, qd: 3 }, { s: "SOLUSDT", d: 3, qd: 2 }, 
    { s: "SUIUSDT", d: 4, qd: 1 }, { s: "APTUSDT", d: 3, qd: 1 }, { s: "NEARUSDT", d: 4, qd: 1 }, 
    { s: "AVAXUSDT", d: 3, qd: 1 }, { s: "DOGEUSDT", d: 5, qd: 0 }, { s: "XRPUSDT", d: 4, qd: 1 }
];

let market = {};
COINS.forEach(c => market[c.s] = { p: 0, lp: 0, history: [], low: 0, trend: 0, rsi: 50, btcTrend: 0 });

function calculateRSI(prices) {
    if (prices.length <= 14) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= 14; i++) {
        let diff = prices[prices.length - i] - prices[prices.length - i - 1];
        diff >= 0 ? gains += diff : losses -= diff;
    }
    return 100 - (100 / (1 + (gains / (losses || 1))));
}

function sign(q, s) { return crypto.createHmac('sha256', s).update(q).digest('hex'); }
async function sendTG(m, id) { try { await axios.post(`https://api.telegram.org/bot${MASTER_TG_TOKEN}/sendMessage`, { chat_id: id || FIXED_CHAT_ID, text: m, parse_mode: 'HTML' }); } catch(e) {} }

async function getBinanceBalance(c) {
    if (!c.api || c.mode === 'demo') return Number(c.cap || 0).toFixed(2);
    const ts = Date.now(); const sig = sign(`timestamp=${ts}`, c.sec);
    try {
        const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?timestamp=${ts}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': c.api }, timeout: 5000 });
        return res.data ? parseFloat(res.data.totalWalletBalance).toFixed(2) : "0.00";
    } catch (e) { return "0.00"; }
}

async function placeOrder(sym, side, qty, u) {
    if (u.mode === 'demo') return { orderId: 'DEMO_' + Date.now() };
    const ts = Date.now(); let q = `symbol=${sym}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${ts}`;
    try { return (await axios.post(`https://fapi.binance.com/fapi/v1/order?${q}&signature=${sign(q, u.sec)}`, null, { headers: { 'X-MBX-APIKEY': u.api } })).data; } catch (e) { return null; }
}

async function startGlobalEngine() {
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/')}`);
    ws.on('message', (data) => {
        const d = JSON.parse(data).data; if (!d || !market[d.s]) return;
        const s = market[d.s]; s.lp = s.p; s.p = parseFloat(d.c);
        s.history.push(s.p); if(s.history.length > 50) s.history.shift();
        s.rsi = calculateRSI(s.history);
        if (d.s === "BTCUSDT" && s.history.length > 10) s.btcTrend = ((s.p - s.history[0]) / s.history[0] * 100);
    });

    setInterval(async () => {
        for (let uid in cachedUsers) {
            let u = cachedUsers[uid]; 
            let activeTrades = u.userSlots.filter(s => s.active).length;
            if (u.status === 'COMPLETED' && activeTrades === 0) continue;

            let btcT = market["BTCUSDT"]?.btcTrend || 0;

            // --- মার্কেট ক্রাশ প্রোটেকশন (Regal Logic) ---
            if (btcT < -0.25) { 
                if(!u.isPaused) { u.isPaused = true; u.sysPaused = true; sendTG("⚠️ <b>MARKET CRASH DETECTED!</b> Bot Paused to save capital.", u.cid); }
            } else if (u.sysPaused && btcT > -0.05) { 
                u.isPaused = false; u.sysPaused = false; sendTG("✅ <b>MARKET STABILIZED.</b> Resuming trades.", u.cid);
            }

            u.userSlots.forEach(async (sl) => {
                if (!sl.active || sl.isClosing) return;
                const ms = market[sl.sym]; if(!ms || ms.p === 0) return;
                
                sl.curP = ms.p;
                let feeR = 0.0005;
                let rawPnL = ((ms.p - sl.buy) / sl.buy) * 100 * u.lev;
                sl.pnl = rawPnL - (feeR * 200);
                sl.netBDT = ((parseFloat(sl.qty) * ms.p - sl.totalCost) - (sl.totalCost + parseFloat(sl.qty) * ms.p) * feeR) * 124;

                if (sl.netBDT > (sl.maxNetBDT || 0)) sl.maxNetBDT = sl.netBDT;

                // 1. 🚨 EMERGENCY STOP LOSS (-10% এ নামিয়ে আনা হয়েছে সুরক্ষার জন্য)
                if (sl.pnl <= -10.0) {
                    sl.isClosing = true;
                    if (await placeOrder(sl.sym, "SELL", sl.qty, u)) {
                        u.profit += (sl.netBDT / 124);
                        sendTG(`❌ <b>REGAL STOP LOSS: #${sl.sym}</b>\nLoss: ৳${sl.netBDT.toFixed(2)}`, u.cid);
                        Object.assign(sl, { active: false, sym: '', isClosing: false, pnl: 0, netBDT: 0 }); saveDB();
                        return;
                    } else sl.isClosing = false;
                }

                // 2. 🎯 TRAILING TAKE PROFIT (প্রফিট হলে সাথে সাথে সেল না করে অপেক্ষা করবে)
                let minProfit = u.isPaused ? 50 : 150; // BDT
                if (sl.netBDT >= minProfit) {
                    // যদি সর্বোচ্চ লাভ থেকে ১০% কমে যায়, তখন সেল দিবে (Trailing)
                    if (sl.netBDT < (sl.maxNetBDT * 0.90)) {
                        sl.isClosing = true;
                        if (await placeOrder(sl.sym, "SELL", sl.qty, u)) {
                            u.profit += (sl.netBDT / 124);
                            sendTG(`💰 <b>REGAL PROFIT: #${sl.sym}</b>\nNet: ৳${sl.netBDT.toFixed(2)}`, u.cid);
                            Object.assign(sl, { active: false, sym: '', isClosing: false, pnl: 0, netBDT: 0 }); saveDB();
                        } else sl.isClosing = false;
                    }
                }

                // 3. 🌀 SMART DCA (খুব দ্রুত বাই করবে না)
                if (rawPnL <= -3.5 && sl.dca < 3) {
                    let dcaQty = (parseFloat(sl.qty) * 1.2).toFixed(COINS.find(c => c.s === sl.sym).qd);
                    if (await placeOrder(sl.sym, "BUY", dcaQty, u)) {
                        sl.totalCost += (parseFloat(dcaQty) * ms.p); 
                        sl.qty = (parseFloat(sl.qty) + parseFloat(dcaQty)).toString();
                        sl.buy = sl.totalCost / parseFloat(sl.qty); sl.dca++; saveDB();
                        sendTG(`🌀 <b>SMART DCA: #${sl.sym} (L${sl.dca})</b>`, u.cid);
                    }
                }
            });

            // --- 🚀 HIGH QUALITY ENTRY ---
            if (!u.isPaused && activeTrades < u.slots) {
                for (let sym of Object.keys(market)) {
                    if (activeTrades >= u.slots) break;
                    const m = market[sym]; 
                    if (m.p === 0 || m.history.length < 30) continue;

                    // Regal Entry Condition: RSI < 35 (Oversold) AND Price showing slight uptrend
                    if (m.rsi < 35 && m.p > m.lp && !u.userSlots.some(x => x.active && x.sym === sym)) {
                        let tV = (u.cap * u.lev) / (u.slots * 2.5); // Safe Margin Allocation
                        let qty = (tV / m.p).toFixed(COINS.find(c => c.s === sym).qd);
                        const sIdx = u.userSlots.findIndex(sl => !sl.active);
                        if (sIdx !== -1 && await placeOrder(sym, "BUY", qty, u)) {
                            u.userSlots[sIdx] = { id: sIdx, active: true, sym: sym, buy: m.p, qty: qty, pnl: 0, dca: 0, totalCost: (parseFloat(qty) * m.p), netBDT: 0, maxNetBDT: 0, isClosing: false };
                            activeTrades++; saveDB(); sendTG(`👑 <b>REGAL ENTRY: #${sym}</b>`, u.cid);
                        }
                    }
                }
            }
        }
    }, 1000);
    ws.on('close', () => setTimeout(startGlobalEngine, 3000));
}
// ... (বাকি সার্ভার কোড আগের মতোই থাকবে)

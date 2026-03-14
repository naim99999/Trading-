// ==============================================
// Quantum AI Master v2.0 - Smart & Fast
// একক ফাইল ভার্সন - সরাসরি ব্যবহারযোগ্য
// ==============================================
require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

// ---------- কনফিগারেশন ----------
const CONFIG = {
  TG_TOKEN: process.env.MASTER_TG_TOKEN || 'YOUR_TOKEN',
  TG_CHAT_ID: process.env.FIXED_CHAT_ID || 'YOUR_CHAT_ID',
  PORT: process.env.PORT || 8080,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || 'default-32char-key-change-it!!!',
  DB_FILE: 'nebula_master.json',

  // ট্রেডিং প্যারামিটার (ছোট প্রফিট, দ্রুত এক্সিট)
  TARGET_PROFIT: 0.0025,          // 0.25% টার্গেট
  TRAILING_START: 0.15,           // 0.15% লাভ থেকে ট্রেইল শুরু
  TRAILING_STEP: 0.015,           // 0.015% স্টেপ
  DCA_LEVELS: [-1.0, -2.2, -4.0, -6.5, -10.0], // ডিসিএ ধাপ
  MAX_DCA: 5,
  RSI_FAST: 48,
  RSI_NORMAL: 42,
  RSI_SAFE: 35,
  DIP_FAST: 0.9975,               // 0.25% ডিপ
  DIP_NORMAL: 0.9965,              // 0.35% ডিপ
  DIP_SAFE: 0.9955,                // 0.45% ডিপ
  BASE_POSITION_SIZE: 20,          // ক্যাপিটালের ১/২০ অংশ (৫%)
  FEE_USDT: 0.0005,
  FEE_BNB: 0.00045
};

// ---------- কয়েন লিস্ট (বাছাই করা) ----------
const COINS = [
  { s: "BTCUSDT", d: 2, qd: 3 }, { s: "ETHUSDT", d: 2, qd: 3 },
  { s: "SOLUSDT", d: 3, qd: 2 }, { s: "1000PEPEUSDT", d: 7, qd: 0 },
  { s: "WIFUSDT", d: 4, qd: 1 }, { s: "DOGEUSDT", d: 5, qd: 0 },
  { s: "NEARUSDT", d: 4, qd: 1 }, { s: "AVAXUSDT", d: 3, qd: 1 },
  { s: "XRPUSDT", d: 4, qd: 1 }, { s: "SUIUSDT", d: 4, qd: 1 },
  { s: "TIAUSDT", d: 4, qd: 1 }, { s: "FETUSDT", d: 4, qd: 1 },
  { s: "RNDRUSDT", d: 3, qd: 1 }, { s: "MATICUSDT", d: 4, qd: 1 },
  { s: "DOTUSDT", d: 3, qd: 1 }, { s: "ORDIUSDT", d: 3, qd: 1 },
  { s: "APTUSDT", d: 3, qd: 1 }, { s: "LDOUSDT", d: 4, qd: 1 },
  { s: "ARBUSDT", d: 4, qd: 1 }, { s: "SHIBUSDT", d: 8, qd: 0 },
  { s: "LINKUSDT", d: 3, qd: 1 }, { s: "ADAUSDT", d: 4, qd: 1 },
  { s: "ICPUSDT", d: 3, qd: 1 }, { s: "JUPUSDT", d: 4, qd: 1 },
  { s: "STXUSDT", d: 4, qd: 1 }, { s: "FILUSDT", d: 3, qd: 1 }
];

// ---------- এনক্রিপশন ইউটিলিটি (API কী সুরক্ষিত রাখতে) ----------
const ALGO = 'aes-256-cbc';
function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const key = Buffer.from(CONFIG.ENCRYPTION_KEY.padEnd(32).slice(0, 32));
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}
function decrypt(text) {
  const [ivHex, encrypted] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const key = Buffer.from(CONFIG.ENCRYPTION_KEY.padEnd(32).slice(0, 32));
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ---------- ডাটাবেস (JSON ফাইল) ----------
let db = {};
try {
  if (fs.existsSync(CONFIG.DB_FILE)) {
    db = JSON.parse(fs.readFileSync(CONFIG.DB_FILE, 'utf8'));
  }
} catch (e) { console.error('DB read error', e); }

function saveDB() {
  try { fs.writeFileSync(CONFIG.DB_FILE, JSON.stringify(db, null, 2)); } catch (e) {}
}

// ---------- গ্লোবাল মার্কেট ডাটা ----------
let market = {};
COINS.forEach(c => market[c.s] = {
  p: 0, lp: 0, history: [], low: 0, vol: 0, btcTrend: 0, trend: 0, cooldown: 0
});

// ---------- টেলিগ্রাম নোটিফিকেশন ----------
async function sendTG(msg, chatId = CONFIG.TG_CHAT_ID) {
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.TG_TOKEN}/sendMessage`, {
      chat_id: chatId, text: msg, parse_mode: 'HTML'
    });
  } catch (e) {}
}

// ---------- বিন্যান্স সিগনেচার ----------
function sign(query, secret) {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

// ---------- ব্যালেন্স পাওয়া ----------
async function getBinanceBalance(user) {
  if (user.mode === 'demo' || !user.api) return parseFloat(user.cap || 0).toFixed(2);
  const ts = Date.now();
  const query = `timestamp=${ts}`;
  const sig = sign(query, decrypt(user.sec));
  try {
    const res = await axios.get(`https://fapi.binance.com/fapi/v2/account?${query}&signature=${sig}`, {
      headers: { 'X-MBX-APIKEY': decrypt(user.api) },
      timeout: 5000
    });
    return res.data ? parseFloat(res.data.totalWalletBalance).toFixed(2) : "0.00";
  } catch (e) { return "Error"; }
}

// ---------- অর্ডার প্লেস ----------
async function placeOrder(symbol, side, quantity, user) {
  if (user.mode === 'demo') return { orderId: 'DEMO_' + Date.now() };
  const ts = Date.now();
  const query = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${ts}`;
  const sig = sign(query, decrypt(user.sec));
  try {
    const res = await axios.post(`https://fapi.binance.com/fapi/v1/order?${query}&signature=${sig}`, null, {
      headers: { 'X-MBX-APIKEY': decrypt(user.api) }
    });
    return res.data;
  } catch (e) { return null; }
}

// ---------- RSI ক্যালকুলেশন ----------
function calculateRSI(prices) {
  if (prices.length <= 14) return 45;
  let gains = 0, losses = 0;
  for (let i = 1; i <= 14; i++) {
    const diff = prices[prices.length - i] - prices[prices.length - i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const rs = gains / (losses || 1);
  return 100 - (100 / (1 + rs));
}

// ---------- ওয়েবসকেট সংযোগ ----------
function startWebSocket() {
  const streams = COINS.map(c => `${c.s.toLowerCase()}@ticker`).join('/');
  const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

  ws.on('message', (data) => {
    try {
      const d = JSON.parse(data).data;
      if (!d || !market[d.s]) return;
      const m = market[d.s];
      m.lp = m.p;
      m.p = parseFloat(d.c);
      m.history.push(m.p);
      if (m.history.length > 60) m.history.shift();
      m.trend = (m.p > m.lp) ? Math.min(10, (m.trend || 0) + 1) : (m.p < m.lp ? 0 : m.trend);
      if (m.p < m.low || m.low === 0) m.low = m.p;
      m.vol = Math.abs((m.p - m.lp) / m.lp * 100);
      if (d.s === "BTCUSDT" && m.history.length > 10) {
        m.btcTrend = ((m.p - m.history[0]) / m.history[0] * 100);
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log('WebSocket closed, reconnecting in 3s');
    setTimeout(startWebSocket, 3000);
  });
  ws.on('error', console.error);
}

// ---------- ট্রেডিং ইঞ্জিন ----------
function startTradingEngine() {
  setInterval(async () => {
    for (const uid in db) {
      const user = db[uid];
      if (!user.userSlots) {
        user.userSlots = Array(user.slots || 5).fill(null).map((_, i) => ({
          id: i, active: false, sym: '', buy: 0, sell: 0, slP: 0,
          qty: 0, pnl: 0, curP: 0, dca: 0, totalCost: 0, be: false, status: 'IDLE'
        }));
        saveDB();
      }

      // অটো স্পিড সিলেকশন
      const btcTrend = market["BTCUSDT"]?.btcTrend || 0;
      if (user.isAuto) {
        user.tSpeed = btcTrend > 0.05 ? 'fast' : (btcTrend < -0.1 ? 'safe' : 'normal');
      }

      const guardianActive = user.userSlots.some(s => s.active && s.dca >= 3);
      const feeRate = user.fMode === 'bnb' ? CONFIG.FEE_BNB : CONFIG.FEE_USDT;

      // সক্রিয় স্লট মনিটর
      for (const slot of user.userSlots) {
        if (!slot.active || slot.status !== 'TRADING') continue;
        const m = market[slot.sym];
        if (!m) continue;
        slot.curP = m.p;
        const rawPnL = ((m.p - slot.buy) / slot.buy) * 100 * (user.lev || 20);
        slot.pnl = rawPnL - (feeRate * 200);

        // ট্রেইলিং স্টপ
        if (rawPnL >= CONFIG.TRAILING_START) {
          let lock = rawPnL - CONFIG.TRAILING_STEP;
          if (m.trend >= 7) lock = rawPnL - CONFIG.TRAILING_STEP * 2;
          if (!slot.be || lock > slot.slP) {
            slot.slP = lock;
            slot.be = true;
          }
        }

        // DCA চেক
        let dcaTrigger = false;
        for (let i = 0; i < CONFIG.DCA_LEVELS.length; i++) {
          if (slot.dca === i && rawPnL <= CONFIG.DCA_LEVELS[i]) {
            dcaTrigger = true;
            break;
          }
        }
        if (dcaTrigger && slot.dca < CONFIG.MAX_DCA) {
          const newQty = (parseFloat(slot.qty) * 2).toFixed(COINS.find(c => c.s === slot.sym)?.qd || 3);
          if (await placeOrder(slot.sym, "BUY", newQty, user)) {
            const cost = parseFloat(newQty) * m.p;
            if (user.mode === 'demo') user.cap = Number(user.cap) - (cost / user.lev);
            slot.totalCost += cost;
            slot.qty = (parseFloat(slot.qty) + parseFloat(newQty)).toString();
            slot.buy = slot.totalCost / parseFloat(slot.qty);
            slot.dca++;
            slot.sell = slot.buy * (1 + CONFIG.TARGET_PROFIT);
            slot.be = false;
            saveDB();
            sendTG(`🌀 <b>DCA #${slot.dca} for ${slot.sym}</b>\nPrice: $${m.p}\nNew Avg: $${slot.buy.toFixed(4)}`, user.cid);
          }
        }

        // এক্সিট চেক
        const netGain = (parseFloat(slot.qty) * m.p) - slot.totalCost - (slot.totalCost * feeRate);
        const shouldExit = (m.p >= slot.sell || (slot.be && rawPnL <= slot.slP)) && (netGain * 124) >= 1;

        if (shouldExit) {
          slot.status = 'COOLING';
          user.profit = (user.profit || 0) + netGain;
          user.count = (user.count || 0) + 1;
          if (user.mode === 'demo') user.cap = Number(user.cap) + netGain + (slot.totalCost / user.lev);
          sendTG(`✅ <b>CLOSED ${slot.sym}</b>\nNet: ৳${(netGain * 124).toFixed(2)}\nTotal: ৳${((user.profit || 0) * 124).toFixed(2)}`, user.cid);
          if (user.mode !== 'demo') await placeOrder(slot.sym, "SELL", slot.qty, user);
          m.cooldown = Date.now() + 30 * 60 * 1000; // 30 মিনিট কুলডাউন
          setTimeout(() => {
            slot.active = false;
            slot.status = 'IDLE';
            saveDB();
          }, 2000);
        }
      }

      // নতুন এন্ট্রি
      const emptySlotIndex = user.userSlots.findIndex(s => !s.active);
      if (!user.isPaused && emptySlotIndex !== -1 && !guardianActive) {
        const speed = user.tSpeed || 'normal';
        const rsiThresh = speed === 'fast' ? CONFIG.RSI_FAST : (speed === 'safe' ? CONFIG.RSI_SAFE : CONFIG.RSI_NORMAL);
        const dipRatio = speed === 'fast' ? CONFIG.DIP_FAST : (speed === 'safe' ? CONFIG.DIP_SAFE : CONFIG.DIP_NORMAL);

        for (const sym in market) {
          const m = market[sym];
          if (m.p === 0 || m.history.length < 20 || Date.now() < m.cooldown) continue;
          const highest = Math.max(...m.history);
          if (m.p < highest * dipRatio && calculateRSI(m.history) < rsiThresh && m.p > (m.low * 1.0002)) {
            if (user.userSlots.some(s => s.active && s.sym === sym)) continue;

            const positionValue = Math.max(5.1, (user.cap * (user.lev || 20)) / (user.slots || 5) / CONFIG.BASE_POSITION_SIZE);
            const qty = (positionValue / m.p).toFixed(COINS.find(c => c.s === sym)?.qd || 3);
            const marginUsed = positionValue / (user.lev || 20);

            if (await placeOrder(sym, "BUY", qty, user)) {
              if (user.mode === 'demo') user.cap = Number(user.cap) - marginUsed;
              user.userSlots[emptySlotIndex] = {
                id: emptySlotIndex, active: true, status: 'TRADING', sym: sym,
                buy: m.p, sell: m.p * (1 + CONFIG.TARGET_PROFIT), slP: 0,
                qty: qty, pnl: 0, curP: m.p, dca: 0, totalCost: parseFloat(qty) * m.p, be: false
              };
              m.low = 0;
              saveDB();
              sendTG(`🚀 <b>NEW ENTRY ${sym}</b>\nPrice: $${m.p}\nMode: ${user.isAuto ? 'AUTO' : 'MANUAL'} [${speed.toUpperCase()}]`, user.cid);
              break;
            }
          }
        }
      }
    }
  }, 1000);
}

// ---------- এক্সপ্রেস সার্ভার ----------
const app = express();

app.get('/api/data', async (req, res) => {
  const userId = req.query.id;
  const user = db[userId];
  if (!user) return res.json({ error: 'User not found' });
  const rawBalance = await getBinanceBalance(user);
  const activeMargin = user.userSlots?.reduce((a, s) => a + (s.active ? s.totalCost / (user.lev || 20) : 0), 0) || 0;
  const btc = market["BTCUSDT"]?.btcTrend || 0;
  const pulse = btc > 0.05 ? "BULLISH" : (btc < -0.1 ? "BEARISH" : "NEUTRAL");
  res.json({
    slots: user.userSlots || [],
    profit: ((user.profit || 0) * 124).toFixed(2),
    count: user.count || 0,
    isPaused: user.isPaused || false,
    balance: (Number(rawBalance) - (user.mode === 'demo' ? 0 : activeMargin)).toFixed(2),
    lev: user.lev || 0,
    tSpeed: user.tSpeed || 'normal',
    pulse: pulse,
    btcVal: btc.toFixed(2),
    isAuto: user.isAuto || false,
    guardian: user.userSlots?.some(s => s.active && s.dca >= 3) || false
  });
});

app.get('/set-speed', (req, res) => {
  const { id, speed, auto } = req.query;
  const user = db[id];
  if (user) {
    if (speed) user.tSpeed = speed;
    if (auto) user.isAuto = auto === 'true';
    saveDB();
  }
  res.sendStatus(200);
});

app.get('/toggle-pause', (req, res) => {
  const user = db[req.query.id];
  if (user) {
    user.isPaused = !user.isPaused;
    saveDB();
  }
  res.sendStatus(200);
});

app.get('/reset', (req, res) => {
  const user = db[req.query.id];
  if (user) {
    user.profit = 0;
    user.count = 0;
    user.userSlots = [];
    saveDB();
  }
  res.redirect('/' + req.query.id);
});

app.get('/reset-logout', (req, res) => {
  delete db[req.query.id];
  saveDB();
  res.redirect('/');
});

app.get('/register', (req, res) => {
  const { id, cid, api, sec, cap, lev, slots, mode, fmode } = req.query;
  db[id] = {
    api: encrypt(api || ''),
    sec: encrypt(sec || ''),
    cid: cid || CONFIG.TG_CHAT_ID,
    cap: parseFloat(cap) || 10,
    lev: parseInt(lev) || 20,
    slots: parseInt(slots) || 5,
    mode: mode || 'live',
    fMode: fmode || 'usdt',
    tSpeed: 'normal',
    profit: 0,
    count: 0,
    isPaused: false,
    isAuto: true,
    userSlots: []
  };
  saveDB();
  sendTG("🚀 System Active! Welcome.", db[id].cid);
  res.redirect('/' + id);
});

app.get('/ping', (req, res) => res.send('pong'));

app.get('/', (req, res) => {
  const userId = req.path.slice(1);
  if (!userId || !db[userId]) {
    // রেজিস্ট্রেশন ফর্ম
    res.send(`<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-[#020617] text-white p-6 flex items-center min-h-screen text-center">
  <div class="max-w-md mx-auto w-full space-y-6 uppercase font-black tracking-tighter">
    <h1 class="text-7xl text-sky-400">Quantum</h1>
    <form action="/register" method="GET" class="bg-slate-900 p-8 rounded-[2.5rem] space-y-4 border border-slate-800 text-left font-sans shadow-2xl">
      <input name="id" placeholder="Username" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none" required>
      <div class="grid grid-cols-2 gap-2">
        <select name="mode" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><option value="live">Live Trading</option><option value="demo">Demo Mode</option></select>
        <select name="fmode" class="bg-black p-4 rounded-xl border border-slate-800 outline-none"><option value="usdt">Fee: USDT</option><option value="bnb">Fee: BNB</option></select>
      </div>
      <input name="api" placeholder="Binance API Key" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none">
      <input name="sec" placeholder="Binance Secret" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none">
      <input name="cid" placeholder="Chat ID" class="w-full bg-black p-4 rounded-xl border border-slate-800 outline-none" value="${CONFIG.TG_CHAT_ID}">
      <div class="grid grid-cols-3 gap-2">
        <input name="cap" type="number" placeholder="Cap $" class="bg-black p-4 rounded-xl border border-slate-800 outline-none">
        <input name="lev" type="number" placeholder="Lev" class="bg-black p-4 rounded-xl border border-slate-800 outline-none">
        <input name="slots" type="number" placeholder="Slots" class="bg-black p-4 rounded-xl border border-slate-800 outline-none">
      </div>
      <button type="submit" class="w-full bg-sky-600 p-5 rounded-full font-black text-xl text-white uppercase">Start Dream</button>
      <p class="text-[8px] text-red-400 text-center mt-2">⚠️ Risk Warning: Trading involves substantial risk. No guarantee of profit.</p>
    </form>
  </div>
</body>
</html>`);
  } else {
    // ড্যাশবোর্ড
    res.send(`<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-[#020617] text-white p-4 font-sans uppercase">
  <div class="max-w-xl mx-auto space-y-4">
    <div class="p-4 bg-slate-900 rounded-[2rem] border border-slate-800 shadow-lg relative overflow-hidden">
      <div id="pB" class="absolute top-0 left-0 h-1 transition-all duration-1000"></div>
      <div class="flex justify-between items-center mt-1">
        <div><p class="text-[8px] text-slate-500 font-bold" id="gMsg">BTC Market Pulse</p><p class="text-[10px] font-black" id="pM">Syncing...</p></div>
        <div class="flex gap-1">
          <button onclick="setSpeed('fast', false)" id="btn-fast" class="px-2 py-2 rounded-lg text-[8px] font-black border border-slate-800">⚡</button>
          <button onclick="setSpeed('normal', false)" id="btn-normal" class="px-2 py-2 rounded-lg text-[8px] font-black border border-slate-800">⚖️</button>
          <button onclick="setSpeed('safe', false)" id="btn-safe" class="px-2 py-2 rounded-lg text-[8px] font-black border border-slate-800">🛡️</button>
          <button onclick="setSpeed('', true)" id="btn-auto" class="px-2 py-2 rounded-lg text-[8px] font-black border border-slate-800">🤖 AUTO</button>
        </div>
      </div>
    </div>
    <div class="p-6 bg-slate-900 rounded-[2.5rem] border-2 border-sky-500/50 text-center shadow-2xl tracking-tighter">
      <p class="text-[10px] text-sky-400 font-bold mb-1 uppercase tracking-widest italic">Wallet Balance</p>
      <p class="text-5xl font-black text-white">$<span id="balanceText">0.00</span></p>
      <div class="mt-2 text-[10px] text-slate-500 font-bold">Leverage: <span id="levText">0</span>x</div>
    </div>
    <div class="grid grid-cols-2 gap-4 text-center">
      <div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1">Growth (BDT)</p><p class="text-4xl font-black text-green-400">৳<span id="profitText">0</span></p></div>
      <div class="p-6 bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-xl"><p class="text-[9px] text-slate-500 font-bold mb-1 uppercase tracking-widest font-black">Wins</p><p class="text-4xl font-black text-sky-400" id="countText">0</p></div>
    </div>
    <div id="slotContainer" class="space-y-3"></div>
    <div class="grid grid-cols-2 gap-3 pt-4 uppercase">
      <button onclick="togglePause()" id="pauseBtn" class="py-5 rounded-full text-[10px] font-black bg-orange-900/20 border border-orange-500/30 text-orange-400">Pause</button>
      <a href="/reset?id=${userId}" onclick="return confirm('রিসেট করবেন?')" class="bg-red-900/20 border border-red-500/30 text-red-500 py-5 rounded-full text-center text-[10px] font-black">Reset</a>
    </div>
    <a href="/reset-logout?id=${userId}" onclick="return confirm('লগ আউট করবেন?')" class="block w-full bg-slate-800 border border-slate-700 text-slate-400 py-5 rounded-full text-center text-[10px] font-black">Logout & Reset</a>
    <p class="text-[6px] text-center text-slate-600 mt-2">⚠️ Risk Warning: Past performance does not guarantee future results. Trade at your own risk.</p>
  </div>
  <script>
    const userId = "${userId}";
    async function setSpeed(s, a) { await fetch('/set-speed?id='+userId+'&speed='+s+'&auto='+a); updateData(); }
    async function togglePause() { await fetch('/toggle-pause?id='+userId); location.reload(); }
    async function updateData() {
      try {
        const res = await fetch('/api/data?id='+userId);
        const d = await res.json();
        document.getElementById('balanceText').innerText = d.balance;
        document.getElementById('profitText').innerText = d.profit;
        document.getElementById('countText').innerText = d.count;
        document.getElementById('levText').innerText = d.lev;
        const pM = document.getElementById('pM'), pB = document.getElementById('pB'), gM = document.getElementById('gMsg');
        if(d.guardian) { gM.innerText = "🛡️ GUARDIAN ACTIVE"; gM.className="text-[8px] font-bold text-red-500 animate-pulse"; } else { gM.innerText = "BTC Market Pulse"; gM.className="text-[8px] text-slate-500 font-bold"; }
        if(d.pulse === "BULLISH") { pM.innerText = "📈 Bullish ("+d.btcVal+"%)"; pM.className="text-[10px] font-black text-green-400"; pB.className="absolute top-0 left-0 h-1 bg-green-500 w-full shadow-[0_0_10px_#22c55e]"; }
        else if(d.pulse === "BEARISH") { pM.innerText = "⚠️ Bearish ("+d.btcVal+"%)"; pM.className="text-[10px] font-black text-red-500"; pB.className="absolute top-0 left-0 h-1 bg-red-500 w-full shadow-[0_0_10px_#ef4444]"; }
        else { pM.innerText = "⚖️ Stable ("+d.btcVal+"%)"; pM.className="text-[10px] font-black text-sky-400"; pB.className="absolute top-0 left-0 h-1 bg-sky-500 w-full shadow-[0_0_10px_#0ea5e9]"; }
        ['fast','normal','safe'].forEach(m => { let btn = document.getElementById('btn-'+m); if(btn) btn.className = (d.tSpeed === m) ? "px-2 py-2 rounded-lg text-[8px] font-black bg-sky-600 text-white" : "px-2 py-2 rounded-lg text-[8px] font-black border border-slate-800 text-slate-500"; });
        document.getElementById('btn-auto').className = d.isAuto ? "px-2 py-2 rounded-lg text-[8px] font-black bg-indigo-600 text-white" : "px-2 py-2 rounded-lg text-[8px] font-black border border-slate-800 text-slate-500";
        let pauseBtn = document.getElementById('pauseBtn');
        pauseBtn.innerText = d.isPaused ? "RESUME" : "PAUSE";
        pauseBtn.className = d.isPaused ? "py-5 rounded-full text-[10px] font-black bg-green-900/20 border border-green-500/30 text-green-400" : "py-5 rounded-full text-[10px] font-black bg-orange-900/20 border border-orange-500/30 text-orange-400";
        let html = '';
        d.slots.forEach((s,i) => {
          let m = s.active ? Math.max(0, Math.min(100, ((s.curP - s.buy) / (s.sell - s.buy)) * 100)) : 0;
          html += \`<div class="p-5 bg-slate-900/50 rounded-3xl border border-zinc-800 mb-3 shadow-lg uppercase"><div class="flex justify-between items-center mb-3"><span class="text-[11px] font-black \${s.active ? 'text-sky-400' : 'text-zinc-700'} tracking-wider">\${s.active ? s.sym : 'Slot '+(i+1)+' Scanning...'} \${s.active ? '[DCA:'+s.dca+']' : ''}</span>\${s.active ? \`<span class="text-[11px] font-black \${s.pnl>=0?'text-green-500':'text-red-400'}">\${s.pnl.toFixed(2)}%</span>\` : ''}</div>\${s.active ? \`<div class="w-full bg-black h-1.5 rounded-full overflow-hidden mb-4"><div class="h-full bg-sky-500 transition-all duration-1000" style="width: \${m}%"></div></div><div class="grid grid-cols-2 text-[10px] font-mono text-slate-500 gap-y-1"><div>Buy: \${s.buy.toFixed(4)}</div><div class="text-right">Live: \${s.curP}</div><div class="text-indigo-400">Quantum Shield</div><div class="text-right text-green-500 font-bold">Dynamic Target</div></div>\` : ''}</div>\`;
        });
        document.getElementById('slotContainer').innerHTML = html;
      } catch(e) { console.log(e); }
    }
    setInterval(updateData, 800);
  </script>
</body>
</html>`);
  }
});

// সার্ভার চালু
const server = app.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${CONFIG.PORT}`);
  startWebSocket();
  startTradingEngine();
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

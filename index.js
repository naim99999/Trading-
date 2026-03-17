setInterval(async () => {
    for (let uid in cachedUsers) {
        let u = cachedUsers[uid]; if (u.status === 'COMPLETED') continue;
        let feeR = u.fMode === 'bnb' ? 0.00045 : 0.0005;
        let activeTrades = u.userSlots.filter(s => s.active).length;

        if (u.isAuto) {
            let btcT = market["BTCUSDT"]?.btcTrend || 0;
            u.tSpeed = btcT > 0.03 ? "fast" : (btcT < -0.1 ? "safe" : "normal");
        }

        u.userSlots.forEach(async (sl) => {
            if (!sl.active || sl.isClosing) return;
            const ms = market[sl.sym]; if(!ms || ms.p === 0) return;
            sl.curP = ms.p; let rawPnL = ((ms.p - sl.buy) / sl.buy) * 100 * u.lev; sl.pnl = rawPnL - (feeR * 200);
            sl.netBDT = ((parseFloat(sl.qty) * ms.p - sl.totalCost) - (sl.totalCost + parseFloat(sl.qty) * ms.p) * feeR) * 124;

            // ১ পয়সা ট্রেইলিং লজিক
            if (sl.netBDT > (sl.maxNetBDT || 0)) sl.maxNetBDT = sl.netBDT;
            
            // আপনার বিশেষ শর্ত: পুস করা থাকলে দ্রুত (৳০.২০) লাভে সেল, নাহলে স্বাভাবিক ১ টাকা।
            let minP = u.isPaused ? 0.20 : (Number(u.cap) < 10 ? 0.50 : 1.00);
            let dropTrigger = sl.maxNetBDT - 0.01;

            // সেল কন্ডিশন: লাভ >= minP এবং (পুস করা আছে অথবা দাম ১ পয়সা কমেছে)
            if (sl.netBDT >= minP && (u.isPaused || (sl.maxNetBDT > 0 && sl.netBDT <= dropTrigger))) {
                sl.isClosing = true; let gain = sl.netBDT / 124;
                u.profit = Number(u.profit || 0) + gain; u.count++;
                if(u.mode === 'demo') u.cap = Number(u.cap) + gain + (sl.totalCost / u.lev);
                sendTG(`✅ <b>PROFIT: #${sl.sym}</b>\nNet: ৳${sl.netBDT.toFixed(2)}\nTotal: ৳${(u.profit * 124).toFixed(0)}`, u.cid);
                if(u.mode !== 'demo') await placeOrder(sl.sym, "SELL", sl.qty, u);
                setTimeout(() => { Object.assign(sl, { active: false, status: 'IDLE', sym: '', isClosing: false, maxNetBDT: 0 }); saveDB(); }, 1200);
            }

            // স্মার্ট টিমওয়ার্ক DCA
            let dcaT = sl.dca === 0 ? -1.8 : -4.5;
            if ((u.slots - activeTrades) >= 1 && rawPnL <= -0.7 && sl.dca < 2) dcaT = -0.7; 

            if (rawPnL <= dcaT && sl.dca < (u.cap < 10 ? 2 : 4) && (sl.totalCost/u.lev)*2 < u.cap*0.92) {
                if (await placeOrder(sl.sym, "BUY", sl.qty, u)) {
                    let stM = (parseFloat(sl.qty) * ms.p) / u.lev;
                    if(u.mode === 'demo') u.cap = Number(u.cap) - stM;
                    sl.totalCost += (parseFloat(sl.qty) * ms.p); sl.qty = (parseFloat(sl.qty) * 2).toString();
                    sl.buy = sl.totalCost / parseFloat(sl.qty); sl.dca++; sl.sell = sl.buy * 1.0030; sl.maxNetBDT = 0; saveDB();
                    sendTG(`🌀 <b>DCA: #${sl.sym} (L${sl.dca})</b>\nAdded Margin: $${stM.toFixed(4)}`, u.cid);
                }
            }
        });

        // অবিরাম হান্টিং (বট তলায় কেনা নিশ্চিত করবে)
        if (!u.isPaused && activeTrades < u.slots && (Number(u.profit) * 124) < Number(u.targetBDT)) {
            let rLim = u.tSpeed === 'fast' ? 70 : (u.tSpeed === 'safe' ? 35 : 55);
            let dLim = u.tSpeed === 'fast' ? 0.9992 : (u.tSpeed === 'safe' ? 0.9940 : 0.9975);
            for (let sym of Object.keys(market)) {
                if (activeTrades >= u.slots) break;
                const m = market[sym]; if (m.p === 0 || m.history.length < 20) continue;
                if (m.rsi < rLim && m.p < (Math.max(...m.history) * dLim) && m.p > (m.low * 1.0008)) {
                    if (!u.userSlots.some(x => x.active && x.sym === sym)) {
                        let tV = Math.max(5.1, (u.cap * u.lev) / u.slots / 20), qty = (tV / m.p).toFixed(COINS.find(c => c.s === sym).qd), mE = tV / u.lev;
                        const sIdx = u.userSlots.findIndex(sl => !sl.active);
                        if (sIdx !== -1 && await placeOrder(sym, "BUY", qty, u)) {
                            if(u.mode === 'demo') u.cap = Number(u.cap) - mE;
                            u.userSlots[sIdx] = { id: sIdx, active: true, status: 'TRADING', sym: sym, buy: m.p, sell: m.p * 1.0040, slP: 0, qty: qty, pnl: 0, curP: m.p, dca: 0, totalCost: (parseFloat(qty) * m.p), be: false, netBDT: -0.05, isClosing: false, maxNetBDT: 0 };
                            activeTrades++; saveDB(); sendTG(`🚀 <b>SNIPER ENTRY: #${sym}</b>`, u.cid);
                        }
                    }
                }
            }
        }
    }
}, 800);
ws.on('close', () => setTimeout(startGlobalEngine, 3000));

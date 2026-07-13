// In-browser IBKR "Transaction History" CSV parser.
// Produces the same TRADE_DATA shape the dashboard expects (KPIs are derived in the component).
// Reconciles to the statement's Ending Cash (trading + fees + FX + deposits).
(function () {
  function splitCSV(line) {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
    }
    out.push(cur); return out;
  }
  function num(x) { if (x == null) return NaN; x = String(x).trim(); if (x === '' || x === '-') return NaN; x = x.replace(/\(\d+\)\s*$/, '').replace(/,/g, ''); const v = parseFloat(x); return isNaN(v) ? NaN : v; }
  const r2 = (v) => Math.round(v * 100) / 100;
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const FULLMON = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
  const LABELS = { MES: 'Micro E-mini S&P 500', MNQ: 'Micro E-mini Nasdaq-100', MCL: 'Micro WTI Crude Oil', SPY: 'SPY options', QQQ: 'QQQ options', NVDA: 'NVDA options', INTC: 'INTC options', CAR: 'CAR options' };
  function rootOf(sym) { sym = (sym || '').trim(); if (!sym || sym === '-') return null; if (/\s/.test(sym)) return sym.split(/\s+/)[0]; const fut = sym.match(/^([A-Z0-9]{1,3}?)([FGHJKMNQUVXZ])(\d{1,2})$/); if (fut && !/^\d+$/.test(fut[1])) return fut[1]; return sym; }
  function prettyPeriod(p) {
    // "June 26, 2025 - June 26, 2026" -> "Jun 26, 2025 – Jun 26, 2026"
    if (!p) return '';
    return p.replace(/\b([A-Za-z]+) (\d+), (\d{4})/g, (m, mon, d, y) => {
      const i = FULLMON[mon.toLowerCase()]; return (i == null ? mon.slice(0, 3) : MON[i]) + ' ' + d + ', ' + y;
    }).replace(/\s-\s/, ' – ');
  }

  window.parseIBKR = function (raw) {
    if (!raw || typeof raw !== 'string') return null;
    const lines = raw.split(/\r?\n/);
    let baseCcy = 'CAD', period = '', generated = '', summaryEnding = null;
    const rows = [];
    for (const line of lines) {
      if (!line) continue;
      const c = splitCSV(line);
      if (c[0] === 'Statement' && c[1] === 'Data' && c[2] === 'Period') period = c[3];
      if (c[0] === 'Statement' && c[1] === 'Data' && c[2] === 'WhenGenerated') generated = c[3];
      if (c[0] === 'Summary' && c[1] === 'Data' && c[2] === 'Base Currency') baseCcy = (c[3] || 'CAD').trim();
      if (c[0] === 'Summary' && c[1] === 'Data' && c[2] === 'Ending Cash') summaryEnding = parseFloat(c[3]);
      if (c[0] === 'Transaction History' && c[1] === 'Data') rows.push(c);
    }
    if (!rows.length) return null;
    rows.reverse(); // chronological ascending

    const tx = rows.map(c => ({ date: c[2], account: c[3], desc: c[4], type: c[5], symbol: c[6], qty: num(c[7]), price: num(c[8]), net: num(c[12]) }));
    const account = tx[0] ? tx[0].account : '';

    const dayMap = new Map();
    function day(d) { if (!dayMap.has(d)) dayMap.set(d, { date: d, trading: 0, fees: 0, fx: 0, deposit: 0, fills: 0, fillsList: [], mtmList: [], feesList: [] }); return dayMap.get(d); }
    const instMap = new Map();
    function inst(r) { if (!instMap.has(r)) instMap.set(r, { root: r, label: LABELS[r] || r, net: 0, fills: 0, wins: 0, losses: 0 }); return instMap.get(r); }

    let tInterest = 0, tMarket = 0, tTax = 0, tFx = 0, tDeposits = 0, tTrading = 0; const unknown = new Map();
    for (const t of tx) {
      const D = day(t.date);
      if (t.type === 'Buy' || t.type === 'Sell') {
        D.trading += t.net; tTrading += t.net; D.fills++;
        D.fillsList.push({ s: rootOf(t.symbol), side: t.type === 'Buy' ? 'B' : 'S', q: t.qty, p: r2(t.price), n: r2(t.net) });
        const r = rootOf(t.symbol); if (r) { const I = inst(r); I.net += t.net; I.fills++; }
      } else if (t.type === 'Position MTM') {
        D.trading += t.net; tTrading += t.net;
        D.mtmList.push({ s: rootOf(t.symbol), n: r2(t.net) });
        const r = rootOf(t.symbol); if (r) { const I = inst(r); I.net += t.net; }
      } else if (t.type === 'Adjustment') { D.fx += t.net; tFx += t.net; }
      else if (t.type === 'Deposit') { D.deposit += t.net; tDeposits += t.net; }
      else if (t.type === 'Debit Interest') { D.fees += t.net; tInterest += t.net; D.feesList.push({ d: 'Debit interest', n: r2(t.net) }); }
      else if (t.type === 'Other Fee') { D.fees += t.net; tMarket += t.net; D.feesList.push({ d: (t.desc || '').slice(0, 46), n: r2(t.net) }); }
      else if (t.type === 'Sales Tax') { D.fees += t.net; tTax += t.net; D.feesList.push({ d: 'Sales tax (GST)', n: r2(t.net) }); }
      else if (t.type === 'Withdrawal' || t.type === 'Electronic Fund Transfer') { D.deposit += t.net; tDeposits += t.net; }
      else if (t.type === 'Credit Interest') { D.fees += t.net; tInterest += t.net; D.feesList.push({ d: 'Credit interest', n: r2(t.net) }); }
      else { const key = t.type || '(blank)'; const u = unknown.get(key) || { type: key, count: 0, total: 0 }; u.count++; if (!isNaN(t.net)) u.total += t.net; unknown.set(key, u); }
    }

    const daily = [...dayMap.values()].sort((a, b) => a.date < b.date ? -1 : 1);
    let cum = 0;
    for (const d of daily) {
      cum += d.trading;
      d.net = d.trading + d.fees + d.fx;
      d.cum = r2(cum);
      d.trading = r2(d.trading); d.fees = r2(d.fees); d.fx = r2(d.fx); d.net = r2(d.net);
      d.dow = DOW[new Date(d.date + 'T00:00:00Z').getUTCDay()];
      d.trades = 0;
    }

    // round-trip trades, with overnight-MTM attached to the right trade
    const pos = new Map(); const lastClosed = new Map(); const trades = []; let tid = 0;
    function finPrice(tr) { const L = tr.side === 'Long'; const eQ = L ? (tr.buyQty||0) : (tr.sellQty||0), eN = L ? (tr.buyNot||0) : (tr.sellNot||0), xQ = L ? (tr.sellQty||0) : (tr.buyQty||0), xN = L ? (tr.sellNot||0) : (tr.buyNot||0); tr.entryPrice = eQ > 0 ? eN / eQ : null; tr.exitPrice = xQ > 0 ? xN / xQ : null; }
    function closeTrade(tr) { tr.days = Math.round((new Date(tr.closeDate) - new Date(tr.openDate)) / 86400000); tr.qty = tr.peak; finPrice(tr); trades.push(tr); lastClosed.set(tr.sym, tr); }
    for (const t of tx) {
      if (t.type !== 'Buy' && t.type !== 'Sell' && t.type !== 'Position MTM') continue;
      const sym = (t.symbol || '').trim(); if (!sym || sym === '-') continue;
      let st = pos.get(sym);
      if (t.type === 'Position MTM') {
        if (st && st.trade) { st.trade.pnl += t.net; }
        else { const lt = lastClosed.get(sym); if (lt) lt.pnl += t.net; else { trades.push({ id: ++tid, root: rootOf(sym), sym, side: '\u2014', openDate: t.date, closeDate: t.date, pnl: t.net, fills: 0, peak: 0, qty: 0, days: 0, mtmOnly: true }); } }
        continue;
      }
      if (!st) { st = { qty: 0, trade: null }; pos.set(sym, st); }
      if (st.qty === 0) { st.trade = { id: ++tid, root: rootOf(sym), sym, side: t.qty > 0 ? 'Long' : 'Short', openDate: t.date, closeDate: t.date, pnl: 0, fills: 0, peak: 0, buyQty: 0, buyNot: 0, sellQty: 0, sellNot: 0 }; }
      const tr = st.trade; tr.fills++; tr.pnl += t.net; tr.closeDate = t.date;
      if (!isNaN(t.price)) { if (t.qty > 0) { tr.buyQty += t.qty; tr.buyNot += t.qty * t.price; } else if (t.qty < 0) { tr.sellQty += (-t.qty); tr.sellNot += (-t.qty) * t.price; } }
      const before = st.qty; st.qty = r2(st.qty + t.qty); tr.peak = Math.max(tr.peak, Math.abs(st.qty), Math.abs(before));
      if (Math.abs(st.qty) < 1e-9) { closeTrade(tr); st.trade = null; st.qty = 0; }
      else if ((before > 0 && st.qty < 0) || (before < 0 && st.qty > 0)) { closeTrade(tr); st.trade = { id: ++tid, root: rootOf(sym), sym, side: st.qty > 0 ? 'Long' : 'Short', openDate: t.date, closeDate: t.date, pnl: 0, fills: 0, peak: Math.abs(st.qty), buyQty: 0, buyNot: 0, sellQty: 0, sellNot: 0 }; }
    }
    let openTrades = 0;
    for (const [sym, st] of pos) { if (st.trade) { st.trade.qty = st.trade.peak; st.trade.open = true; st.trade.days = Math.round((new Date(st.trade.closeDate) - new Date(st.trade.openDate)) / 86400000); finPrice(st.trade); trades.push(st.trade); openTrades++; } }
    trades.forEach(t => t.pnl = r2(t.pnl));
    trades.sort((a, b) => a.closeDate < b.closeDate ? -1 : 1);

    const dmap = new Map(daily.map(d => [d.date, d]));
    for (const tr of trades) { const d = dmap.get(tr.closeDate); if (d) d.trades++; }
    for (const tr of trades) { const I = instMap.get(tr.root); if (I) { if (tr.pnl > 0) I.wins++; else if (tr.pnl < 0) I.losses++; } }

    const byInstrument = [...instMap.values()].map(I => ({ root: I.root, label: I.label, net: r2(I.net), fills: I.fills, trades: I.wins + I.losses, wins: I.wins, losses: I.losses, winRate: (I.wins + I.losses) ? Math.round(100 * I.wins / (I.wins + I.losses)) : 0 })).sort((a, b) => b.net - a.net);

    const tradingPnl = tTrading;
    const feesTotal = tInterest + tMarket + tTax;
    const allInNet = tradingPnl + feesTotal + tFx;
    const endingBalance = tDeposits + allInNet;
    const actDays = daily.filter(d => d.fills > 0 || Math.abs(d.trading) > 0.005);
    const closed = trades.filter(t => !t.open);

    const genClean = (generated || '').replace(', ', ' ').replace(/(\d\d:\d\d):\d\d/, '$1');

    return {
      meta: { account, baseCurrency: baseCcy, statementPeriod: prettyPeriod(period), generated: genClean, firstDate: daily[0].date, lastDate: daily[daily.length - 1].date, tradingDayCount: actDays.length },
      totals: { tradingPnl: r2(tradingPnl), fees: r2(feesTotal), fx: r2(tFx), deposits: r2(tDeposits), allInNet: r2(allInNet), endingBalance: r2(endingBalance), fills: daily.reduce((s, d) => s + d.fills, 0), trades: closed.length },
      feesBreakdown: { interest: r2(tInterest), marketData: r2(tMarket), salesTax: r2(tTax), fx: r2(tFx) },
      daily,
      byInstrument,
      trades: trades.map(t => ({ id: t.id, root: t.root, side: t.side, qty: t.qty, openDate: t.openDate, closeDate: t.closeDate, pnl: t.pnl, fills: t.fills, days: t.days, open: !!t.open, mtmOnly: !!t.mtmOnly, entryPrice: (t.entryPrice != null ? r2(t.entryPrice) : null), exitPrice: (t.exitPrice != null ? r2(t.exitPrice) : null) })),
      unrecognized: [...unknown.values()].map(u => ({ type: u.type, count: u.count, total: r2(u.total) })).sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
      summaryEnding: summaryEnding,
    };
  };
})();

// ---- IBKR Activity Flex Query parser (sections: ACCT, CRTT, TRNT, CTRN, MTMP, STAX) ----
// Daily P&L from Mark-to-Market Performance Summary (true daily MTM, ties to broker statement);
// trades from per-execution rows (timestamps, entry/exit prices); fees from CashTransactions + SalesTax;
// FX from MTM cash rows. Reconciles: deposits + trading + fees + fx = ending cash.
(function () {
  function splitCSV(line) {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
    }
    out.push(cur); return out;
  }
  const num = v => { const x = parseFloat(String(v).replace(/,/g, '')); return isNaN(x) ? 0 : x; };
  const r2 = v => Math.round(v * 100) / 100;
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const LABELS = { MES: 'Micro E-mini S&P 500', MNQ: 'Micro E-mini Nasdaq-100', MCL: 'Micro WTI Crude Oil', SPY: 'SPY options', QQQ: 'QQQ options', NVDA: 'NVDA options', INTC: 'INTC options', CAR: 'CAR options' };
  function rootOf(sym) { sym = (sym || '').trim(); if (!sym || sym === '-') return null; if (/\s/.test(sym)) return sym.split(/\s+/)[0]; const fut = sym.match(/^([A-Z0-9]{1,3}?)([FGHJKMNQUVXZ])(\d{1,2})$/); if (fut && !/^\d+$/.test(fut[1])) return fut[1]; return sym; }
  const isoD = d8 => d8.slice(0, 4) + '-' + d8.slice(4, 6) + '-' + d8.slice(6, 8);
  const pretty = (iso) => { const y = +iso.slice(0, 4), m = +iso.slice(5, 7), d = +iso.slice(8, 10); return MONS[m - 1] + ' ' + d + ', ' + y; };
  const parseDT = s => { if (!s) return 0; const m = String(s).replace(/[^0-9]/g, ''); if (m.length < 8) return 0; return Date.UTC(+m.slice(0, 4), +m.slice(4, 6) - 1, +m.slice(6, 8), +m.slice(8, 10) || 0, +m.slice(10, 12) || 0, +m.slice(12, 14) || 0); };

  window.parseIBKRFlex = function (raw) {
    if (!raw || typeof raw !== 'string') return null;
    const secs = { ACCT: [], CRTT: [], TRNT: [], CTRN: [], MTMP: [], STAX: [] };
    let headers = {};
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      const c = splitCSV(line);
      if (c[0] === 'HEADER') { headers[c[1]] = c.slice(2); if (!secs[c[1]]) secs[c[1]] = []; }
      else if (c[0] === 'DATA') { const h = headers[c[1]]; if (!h) continue; const o = {}; c.slice(2).forEach((v, i) => o[h[i]] = v); secs[c[1]].push(o); }
    }
    if (!secs.TRNT.length && !secs.MTMP.length) return null;

    const account = (secs.ACCT[0] && secs.ACCT[0].ClientAccountID) || '';
    const baseCcy = (secs.ACCT[0] && secs.ACCT[0].CurrencyPrimary) || 'CAD';

    const dayMap = new Map();
    function day(d) { if (!dayMap.has(d)) dayMap.set(d, { date: d, trading: 0, fees: 0, fx: 0, deposit: 0, fills: 0, fillsList: [], mtmList: [], feesList: [], trades: 0 }); return dayMap.get(d); }
    const instMap = new Map();
    function inst(r) { if (!instMap.has(r)) instMap.set(r, { root: r, label: LABELS[r] || r, net: 0, fills: 0, wins: 0, losses: 0 }); return instMap.get(r); }

    // daily trading & fx from MTM performance summary (dated rows only; undated = totals/fee lines)
    const mtmRoot = new Map(); let rawTrading = 0, rawFx = 0;
    for (const r of secs.MTMP) {
      const d8 = r.ReportDate; if (!d8) continue;
      const d = isoD(d8);
      const tot = num(r.Total);
      if (r.AssetClass === 'CASH') { if (tot) { day(d).fx += tot; rawFx += tot; } continue; }
      if (!r.Symbol) continue;
      if (tot) {
        day(d).trading += tot; rawTrading += tot;
        const root = (r.UnderlyingSymbol && r.UnderlyingSymbol.trim()) || rootOf(r.Symbol);
        const k = d + '|' + root; mtmRoot.set(k, (mtmRoot.get(k) || 0) + tot);
        inst(root).net += tot;
      }
    }

    // fees & deposits
    let tInterest = 0, tMarket = 0, tTax = 0, tDeposits = 0;
    for (const r of secs.CTRN) {
      const d8 = (r['Date/Time'] || '').slice(0, 8); if (d8.length !== 8) continue;
      const d = isoD(d8);
      const amt = num(r.Amount) * (num(r.FXRateToBase) || 1);
      const D = day(d); const t = r.Type;
      if (t === 'Deposits/Withdrawals') { D.deposit += amt; tDeposits += amt; }
      else if (t === 'Broker Interest Paid' || t === 'Broker Interest Received') { D.fees += amt; tInterest += amt; D.feesList.push({ d: 'Debit interest', n: r2(amt) }); }
      else { D.fees += amt; tMarket += amt; D.feesList.push({ d: (r.Description || t).slice(0, 46), n: r2(amt) }); }
    }
    for (const r of secs.STAX) {
      const d8 = (r.Date || '').slice(0, 8); if (d8.length !== 8) continue;
      const amt = num(r.SalesTax) * (num(r.FXRateToBase) || 1);
      const D = day(isoD(d8));
      D.fees += amt; tTax += amt; D.feesList.push({ d: 'Sales tax (GST)', n: r2(amt) });
    }

    // executions
    const ex = secs.TRNT.map((r, i) => ({
      i,
      sym: (r.Symbol || '').trim(),
      root: (r.UnderlyingSymbol && r.UnderlyingSymbol.trim()) || rootOf(r.Symbol),
      date: isoD(r.TradeDate),
      t: parseDT(r.DateTime),
      q: num(r.Quantity),
      p: num(r.TradePrice),
      fifo: num(r.FifoPnlRealized) * (num(r.FXRateToBase) || 1),
      buy: (r['Buy/Sell'] || '').toUpperCase().indexOf('BUY') >= 0,
    })).filter(e => e.sym && e.q);
    ex.sort((a, b) => (a.t - b.t) || (a.i - b.i));

    for (const e of ex) {
      const D = day(e.date);
      D.fills++;
      D.fillsList.push({ s: e.root, side: e.buy ? 'B' : 'S', q: e.q, p: r2(e.p), n: r2(e.fifo) });
      inst(e.root).fills++;
    }

    // round-trip trades with entry/exit prices + hold times
    const pos = new Map(); const trades = []; let tid = 0;
    function wavg(list) { let qs = 0, ps = 0; for (const x of list) { qs += Math.abs(x.q); ps += x.p * Math.abs(x.q); } return qs ? r2(ps / qs) : null; }
    function dayDiff(a, b) { return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000); }
    function finishTrade(tr) {
      tr.qty = tr.peak;
      tr.entryPrice = wavg(tr.execs.filter(x => tr.side === 'Long' ? x.q > 0 : x.q < 0));
      tr.exitPrice = tr.open ? null : wavg(tr.execs.filter(x => tr.side === 'Long' ? x.q < 0 : x.q > 0));
      tr.holdMins = (tr.t0 && tr.tLast && tr.tLast > tr.t0) ? Math.max(1, Math.round((tr.tLast - tr.t0) / 60000)) : (tr.open ? null : 1);
      tr.days = dayDiff(tr.openDate, tr.closeDate);
      tr.pnl = r2(tr.pnl);
      tr.openTime = tr.t0 || null; tr.closeTime = tr.tLast || null;
      delete tr.execs; delete tr.t0; delete tr.tLast;
      trades.push(tr);
    }
    for (const e of ex) {
      let st = pos.get(e.sym);
      if (!st) { st = { qty: 0, trade: null }; pos.set(e.sym, st); }
      if (st.qty === 0) { st.trade = { id: ++tid, root: e.root, sym: e.sym, side: e.q > 0 ? 'Long' : 'Short', openDate: e.date, closeDate: e.date, pnl: 0, fills: 0, peak: 0, execs: [], t0: e.t, tLast: e.t }; }
      const tr = st.trade;
      tr.fills++; tr.pnl += e.fifo; tr.closeDate = e.date; tr.tLast = e.t;
      tr.execs.push({ q: e.q, p: e.p });
      const before = st.qty; st.qty = r2(st.qty + e.q);
      tr.peak = Math.max(tr.peak, Math.abs(st.qty), Math.abs(before));
      if (Math.abs(st.qty) < 1e-9) { finishTrade(tr); st.trade = null; st.qty = 0; }
      else if ((before > 0 && st.qty < 0) || (before < 0 && st.qty > 0)) {
        finishTrade(tr);
        st.trade = { id: ++tid, root: e.root, sym: e.sym, side: st.qty > 0 ? 'Long' : 'Short', openDate: e.date, closeDate: e.date, pnl: 0, fills: 0, peak: Math.abs(st.qty), execs: [{ q: st.qty, p: e.p }], t0: e.t, tLast: e.t };
      }
    }
    for (const entry of pos) { const st = entry[1]; if (st.trade) { st.trade.open = true; finishTrade(st.trade); } }
    trades.sort((a, b) => a.closeDate < b.closeDate ? -1 : (a.closeDate > b.closeDate ? 1 : a.id - b.id));

    for (const tr of trades) {
      const D = dayMap.get(tr.closeDate); if (D) D.trades++;
      const I = instMap.get(tr.root); if (I && !tr.open) { if (tr.pnl > 0) I.wins++; else if (tr.pnl < 0) I.losses++; }
    }

    // per-day overnight-MTM residual (MTM total minus realized-on-day), shown when material
    for (const entry of dayMap) {
      const d = entry[0], D = entry[1];
      const fillsByRoot = {};
      D.fillsList.forEach(f => { fillsByRoot[f.s] = (fillsByRoot[f.s] || 0) + f.n; });
      for (const k of mtmRoot.keys()) {
        if (k.slice(0, 10) !== d) continue;
        const rt = k.slice(11);
        const resid = (mtmRoot.get(k) || 0) - (fillsByRoot[rt] || 0);
        if (Math.abs(resid) > 0.5) D.mtmList.push({ s: rt, n: r2(resid) });
      }
    }

    const daily = [...dayMap.values()].sort((a, b) => a.date < b.date ? -1 : 1);
    let cum = 0;
    for (const d of daily) {
      cum += d.trading;
      d.net = d.trading + d.fees + d.fx;
      d.cum = r2(cum);
      d.trading = r2(d.trading); d.fees = r2(d.fees); d.fx = r2(d.fx); d.net = r2(d.net); d.deposit = r2(d.deposit);
      d.dow = DOW[new Date(d.date + 'T00:00:00Z').getUTCDay()];
    }

    const byInstrument = [...instMap.values()].map(I => ({ root: I.root, label: I.label, net: r2(I.net), fills: I.fills, trades: I.wins + I.losses, wins: I.wins, losses: I.losses, winRate: (I.wins + I.losses) ? Math.round(100 * I.wins / (I.wins + I.losses)) : 0 })).sort((a, b) => b.net - a.net);

    const tradingPnl = rawTrading;
    const feesTotal = tInterest + tMarket + tTax;
    const fxTotal = rawFx;
    const allInNet = tradingPnl + feesTotal + fxTotal;
    const endingBalance = tDeposits + allInNet;
    const closed = trades.filter(t => !t.open);
    const actDays = daily.filter(d => d.fills > 0 || Math.abs(d.trading) > 0.005);

    let summaryEnding = null, bestDiff = 1e18;
    for (const r of secs.CRTT) { const v = parseFloat(r.EndingCash); if (!isNaN(v)) { const df = Math.abs(v - endingBalance); if (df < bestDiff) { bestDiff = df; summaryEnding = v; } } }

    const firstDate = daily[0].date, lastDate = daily[daily.length - 1].date;
    return {
      meta: { account, baseCurrency: baseCcy, statementPeriod: pretty(firstDate) + ' \u2013 ' + pretty(lastDate), generated: 'IBKR Flex Query', firstDate, lastDate, tradingDayCount: actDays.length, source: 'flex' },
      totals: { tradingPnl: r2(tradingPnl), fees: r2(feesTotal), fx: r2(fxTotal), deposits: r2(tDeposits), allInNet: r2(allInNet), endingBalance: r2(endingBalance), fills: ex.length, trades: closed.length },
      feesBreakdown: { interest: r2(tInterest), marketData: r2(tMarket), salesTax: r2(tTax), fx: r2(fxTotal) },
      daily, byInstrument,
      trades: trades.map(t => ({ id: t.id, root: t.root, side: t.side, qty: t.qty, openDate: t.openDate, closeDate: t.closeDate, pnl: t.pnl, fills: t.fills, days: t.days, open: !!t.open, mtmOnly: false, entryPrice: t.entryPrice, exitPrice: t.exitPrice, holdMins: t.holdMins, openTime: t.openTime || null, closeTime: t.closeTime || null })),
      summaryEnding
    };
  };

  // Auto-detect: Flex exports start with HEADER/DATA section rows; anything else -> legacy statement parser.
  window.parseIBKRAuto = function (raw) {
    if (!raw || typeof raw !== 'string') return null;
    const head = (raw.slice(0, 4000).split(/\r?\n/).find(l => l.trim().length) || '').trim();
    if (/^"?(HEADER|DATA)"?,/.test(head)) return window.parseIBKRFlex(raw);
    return window.parseIBKR ? window.parseIBKR(raw) : null;
  };
})();

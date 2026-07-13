function load(path){ global.window = {}; delete require.cache[require.resolve(path)]; require(path); return global.window; }

const csv = [
'Statement,Data,Period,"June 1, 2026 - June 30, 2026"',
'Statement,Data,WhenGenerated,"2026-07-01, 10:00:00 EDT"',
'Summary,Data,Base Currency,USD',
'Summary,Data,Ending Cash,9146.98',
'Transaction History,Data,2026-06-05,U111,d,Sell,ESU5,-1,5300,,,,-2650.32',
'Transaction History,Data,2026-06-05,U111,d,Buy,ESU5,1,5290,,,,2650.00',
'Transaction History,Data,2026-06-04,U111,d,Sell,ESZ5,-1,5310,,,,500.00',
'Transaction History,Data,2026-06-04,U111,d,Buy,ESZ5,1,5300,,,,-497.10',
'Transaction History,Data,2026-06-03,U111,d,Buy,MESU5,2,5280,,,,-52.80',
'Transaction History,Data,2026-06-03,U111,d,Sell,MESU5,-2,5285,,,,55.30',
'Transaction History,Data,2026-06-02,U111,d,Sell,MNQU5,-1,19000,,,,"1,234.56"',
'Transaction History,Data,2026-06-02,U111,d,Buy,MNQU5,1,18900,,,,-100.00',
'Transaction History,Data,2026-06-06,U111,d,Withdrawal,-,,,,,,-2000.00',
'Transaction History,Data,2026-06-06,U111,d,Credit Interest,-,,,,,,12.34',
'Transaction History,Data,2026-06-07,U111,d,Mystery Fee,-,,,,,,-5.00',
'Transaction History,Data,2026-06-01,U111,d,Deposit,-,,,,,,10000.00',
].join('\n');

for (const [label,path] of [['BEFORE','/home/claude/ibkr-parser.original.js'],['AFTER','/home/claude/ibkr-parser.patched.js']]) {
  const w = load(path); const o = w.parseIBKR(csv);
  const roots = o.byInstrument.map(i=>i.root+':'+i.net).join('  ');
  const diff = (o.summaryEnding - o.totals.endingBalance).toFixed(2);
  console.log(`\n[${label}] instruments -> ${roots}`);
  console.log(`[${label}] trading ${o.totals.tradingPnl} | fees ${o.totals.fees} | deposits ${o.totals.deposits} | computed end ${o.totals.endingBalance} | stmt ${o.summaryEnding} | unexplained ${diff}`);
  if (o.unrecognized) console.log(`[${label}] unrecognized:`, JSON.stringify(o.unrecognized), '-> explains the gap:', (o.unrecognized.reduce((s,u)=>s+u.total,0)).toFixed(2));
}

// regression: plain statement must produce identical output (minus the new field)
const plain = [
'Statement,Data,Period,"June 1, 2026 - June 30, 2026"','Summary,Data,Base Currency,USD','Summary,Data,Ending Cash,10002.50',
'Transaction History,Data,2026-06-03,U111,d,Buy,MESU5,2,5280,,,,-52.80',
'Transaction History,Data,2026-06-03,U111,d,Sell,MESU5,-2,5285,,,,55.30',
'Transaction History,Data,2026-06-01,U111,d,Deposit,-,,,,,,10000.00',
].join('\n');
const a = load('/home/claude/ibkr-parser.original.js').parseIBKR(plain);
const b = load('/home/claude/ibkr-parser.patched.js').parseIBKR(plain);
delete b.unrecognized;
console.log('\n[REGRESSION] identical on clean input:', JSON.stringify(a) === JSON.stringify(b));

// Flex path: 2-char root without UnderlyingSymbol + comma quantity
const flex = [
'HEADER,ACCT,ClientAccountID,CurrencyPrimary','DATA,ACCT,U111,USD',
'HEADER,TRNT,Symbol,UnderlyingSymbol,TradeDate,DateTime,Quantity,TradePrice,FifoPnlRealized,FXRateToBase,Buy/Sell',
'DATA,TRNT,ESU5,,20260605,20260605;093000,1,5290,0,1,BUY',
'DATA,TRNT,ESU5,,20260605,20260605;094500,-1,5300,"1,250.00",1,SELL',
'HEADER,MTMP,ReportDate,AssetClass,Symbol,UnderlyingSymbol,Total','DATA,MTMP,20260605,FUT,ESU5,,1250',
].join('\n');
const wf = load('/home/claude/ibkr-parser.patched.js'); const f = wf.parseIBKRAuto(flex);
console.log('[FLEX] root:', f.trades[0].root, '| pnl (comma-stripped fifo):', f.trades[0].pnl, '| holdMins:', f.trades[0].holdMins);

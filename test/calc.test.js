import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overview, changeCost, overage, clashes, findSwap } from '../src/calc.js';
import { computeGst, stateFromGstin, tallyXml, billsCsv } from '../src/gst.js';

const P = { fixed_cost: 10_000_000, day_cost: 1_000_000, planned_days: 10 };
const days = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, n: i + 1, date: `2026-01-${String(i + 1).padStart(2, '0')}`, actual_cost: i < 4 ? 1_200_000 : null, cast: [] }));

test('forecast scales remaining days by the overrun ratio', () => {
  const o = overview(P, days, []);
  assert.equal(o.budget, 20_000_000);
  assert.equal(o.spent, 14_800_000);
  assert.equal(o.ratio, 1.2);
  assert.equal(o.forecast, 14_800_000 + 6 * 1_200_000);
  assert.equal(o.gap, 2_000_000);
});

test('approved changes add new days at the real day cost; pending ones do not', () => {
  const ch = [{ status: 'approved', new_days: 2, extra: 500_000 }, { status: 'pending', new_days: 5, extra: 9_000_000 }];
  const o = overview(P, days, ch);
  assert.equal(o.forecast, 14_800_000 + 6 * 1_200_000 + 2 * 1_200_000 + 500_000);
});

test('change cost splits footage lost from new spend', () => {
  assert.deepEqual(changeCost({ wasted_days: 3, new_days: 4, extra: 100 }, 1000, 1.5), { sunk: 3000, fresh: 6100, total: 9100 });
});

test('overage counts only perks beyond contract', () => {
  const a = { used_entourage: 12, terms_entourage: 8, used_vans: 3, terms_vans: 2 };
  assert.deepEqual(overage(a, 10, 6000, 45000), { perDay: 69000, worked: 10, sofar: 690000 });
  assert.equal(overage({ used_entourage: 2, terms_entourage: 4, used_vans: 1, terms_vans: 1 }, 5, 6000, 45000).sofar, 0);
});

test('clashes and a clean swap', () => {
  const d = [
    { id: 1, n: 1, date: '2026-02-01', actual_cost: null, cast: [7] },
    { id: 2, n: 2, date: '2026-02-02', actual_cost: null, cast: [8] },
    { id: 3, n: 3, date: '2026-02-03', actual_cost: null, cast: [7, 8] },
  ];
  const away = new Map([[7, new Set(['2026-02-03'])]]);
  const c = clashes(d, away, '2026-01-31');
  assert.deepEqual(c.map(x => x.n), [3]);
  assert.equal(findSwap(d.at(2), d, away, '2026-01-31').n, 2, 'day 2 is free for both casts');
  away.set(7, new Set(['2026-02-01']));
  assert.equal(findSwap(d.at(0), d, away, '2026-01-31').n, 2);
});

test('swap never suggests today', () => {
  const d = [{ id: 1, n: 1, date: '2026-02-01', actual_cost: null, cast: [] }, { id: 2, n: 2, date: '2026-02-02', actual_cost: null, cast: [1] }];
  assert.equal(findSwap(d.at(1), d, new Map([[1, new Set(['2026-02-02'])]]), '2026-02-01'), null);
});

test('GST: same state splits CGST and SGST, other state is IGST', () => {
  assert.deepEqual(computeGst(10_000_00, 18, '36', '36'), { cgst: 900_00, sgst: 900_00, igst: 0, total: 11_800_00, intra: true });
  assert.deepEqual(computeGst(10_000_00, 18, '33', '36'), { cgst: 0, sgst: 0, igst: 1_800_00, total: 11_800_00, intra: false });
  const odd = computeGst(101, 5, '36', '36');
  assert.equal(odd.cgst + odd.sgst, 5, 'rounding keeps the whole tax');
  assert.throws(() => computeGst(100, 7, '36', '36'));
});

test('GSTIN gives the state code', () => {
  assert.equal(stateFromGstin('36AABCU9603R1ZM'), '36');
  assert.equal(stateFromGstin('bad'), null);
});

test('Tally XML balances and escapes', () => {
  const bill = { date: '2026-11-20', invoice_no: 'A&B-1', vendor: 'Light <House>', vendor_gstin: '', ledger: 'Equipment Hire', taxable_paise: 1000_00, cgst_paise: 90_00, sgst_paise: 90_00, igst_paise: 0, total_paise: 1180_00, vendor_state: '36', rate: 18 };
  const x = tallyXml('Co & Sons', [bill]);
  assert.match(x, /<SVCURRENTCOMPANY>Co &amp; Sons<\/SVCURRENTCOMPANY>/);
  assert.match(x, /Light &lt;House&gt;/);
  const amounts = [...x.matchAll(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].map(m => Number(m[1]));
  assert.equal(amounts.reduce((s, a) => s + a, 0).toFixed(2), '0.00');
  assert.match(billsCsv([bill]), /"Light <House>"|Light <House>/);
});

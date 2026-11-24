import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { seed } from '../src/seed.js';

process.env.SLATE_TODAY = '2026-11-24';
let server, base, pid;

before(async () => {
  const db = openDb(':memory:');
  pid = seed(db, { start: '2026-11-05' });
  server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://localhost:${server.address().port}/api`;
});
after(() => server.close());

async function client(email, password = 'demo1234') {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() };
  };
  return { status: res.status, call };
}

test('wrong password is refused', async () => {
  assert.equal((await client('producer@demo.slate', 'nope-nope')).status, 401);
});

test('signed-out requests are refused', async () => {
  assert.equal((await fetch(`${base}/p/${pid}/overview`)).status, 401);
});

test('producer sees the overview with alerts', async () => {
  const { call } = await client('producer@demo.slate');
  const r = await call(`/p/${pid}/overview`);
  assert.equal(r.status, 200);
  assert.equal(r.body.shotDays, 19);
  assert.ok(r.body.alerts.some(a => a.type === 'clash'));
});

test('roles are enforced on the server', async () => {
  const writer = (await client('writer@demo.slate')).call;
  assert.equal((await writer(`/p/${pid}/overview`)).status, 403);
  assert.equal((await writer(`/p/${pid}/changes/1/decision`, { method: 'POST', body: { status: 'approved' } })).status, 403);
  assert.equal((await writer(`/p/${pid}/changes`, { method: 'POST', body: { title: 'Cut the dream song', newDays: 0 } })).status, 201);
  const fin = (await client('financier@demo.slate')).call;
  assert.equal((await fin(`/p/${pid}/bills`, { method: 'POST', body: {} })).status, 403);
  assert.equal((await fin(`/p/${pid}/bills/tally.xml`)).status, 200);
});

test('an actor manager can only change their own actor', async () => {
  const m = (await client('manager@demo.slate')).call;
  const s = await m(`/p/${pid}/schedule`);
  const own = s.body.actors.find(a => a.editable), other = s.body.actors.find(a => !a.editable);
  assert.equal((await m(`/p/${pid}/actors/${own.id}/away/2026-12-10`, { method: 'PUT', body: { away: true } })).status, 200);
  assert.equal((await m(`/p/${pid}/actors/${other.id}/away/2026-12-10`, { method: 'PUT', body: { away: true } })).status, 403);
});

test('approving a change moves the forecast; a decided change cannot be decided again', async () => {
  const { call } = await client('producer@demo.slate');
  const before = (await call(`/p/${pid}/overview`)).body.forecast;
  const ch = (await call(`/p/${pid}/changes`)).body.changes.find(c => c.status === 'pending');
  assert.equal((await call(`/p/${pid}/changes/${ch.id}/decision`, { method: 'POST', body: { status: 'approved' } })).status, 200);
  const afterF = (await call(`/p/${pid}/overview`)).body.forecast;
  assert.equal(afterF - before, ch.cost.fresh);
  assert.equal((await call(`/p/${pid}/changes/${ch.id}/decision`, { method: 'POST', body: { status: 'rejected' } })).status, 409);
});

test('swap moves cast between days and clears a clash', async () => {
  const { call } = await client('producer@demo.slate');
  const s = (await call(`/p/${pid}/schedule`)).body;
  const c = s.clashes.find(x => x.swapWith);
  assert.ok(c);
  assert.equal((await call(`/p/${pid}/days/swap`, { method: 'POST', body: { a: c.n, b: c.swapWith.n } })).status, 200);
  const s2 = (await call(`/p/${pid}/schedule`)).body;
  assert.ok(!s2.clashes.some(x => x.n === c.n && x.actorId === c.actorId));
});

test('offline attendance: newest mark wins, stale replays are ignored', async () => {
  const { call } = await client('lineprod@demo.slate');
  const crew = (await call(`/p/${pid}/crew?date=2026-11-24`)).body.crew;
  const id = crew[0].id;
  const send = (present, markedAt) => call(`/p/${pid}/attendance`, { method: 'POST', body: { marks: [{ crewId: id, date: '2026-11-24', present, markedAt }] } });
  assert.equal((await send(false, '2099-01-01T10:00:00Z')).body.applied, 1);
  assert.equal((await send(true, '2099-01-01T09:00:00Z')).body.applied, 0);
  const now = (await call(`/p/${pid}/crew?date=2026-11-24`)).body.crew.find(c => c.id === id);
  assert.equal(now.present, 0);
});

test('bills compute GST and refuse duplicates', async () => {
  const { call } = await client('lineprod@demo.slate');
  const body = { vendor: 'Test Vendor', vendorState: '29', invoiceNo: 'T-1', date: '2026-11-24', ledger: 'Transport', taxable: 1000, rate: 12 };
  const r = await call(`/p/${pid}/bills`, { method: 'POST', body });
  assert.equal(r.status, 201);
  assert.equal(r.body.igst, 12000);
  assert.equal((await call(`/p/${pid}/bills`, { method: 'POST', body })).status, 409);
  assert.equal((await call(`/p/${pid}/bills`, { method: 'POST', body: { ...body, invoiceNo: 'T-2', vendorGstin: 'XX' } })).status, 400);
});

test('invite codes add a member with the given role, once', async () => {
  const { call } = await client('producer@demo.slate');
  const { code } = (await call(`/p/${pid}/invites`, { method: 'POST', body: { role: 'financier' } })).body;
  const reg = await fetch(base + '/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'new.investor@example.com', name: 'Investor', password: 'long-enough-1' }) });
  const cookie = reg.headers.get('set-cookie').split(';')[0];
  const join = c => fetch(base + '/join', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ code: c }) });
  assert.equal((await join(code)).status, 200);
  assert.equal((await join(code)).status, 404);
});

test('script breakdown says clearly when Claude is not configured', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const { call } = await client('writer@demo.slate');
  const r = await call(`/p/${pid}/script/breakdown`, { method: 'POST', body: { text: 'సీన్ 1' } });
  assert.equal(r.status, 503);
});

test('non-JSON writes are refused', async () => {
  const r = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(r.status, 415);
});

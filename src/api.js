import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { requireUser, member } from './auth.js';
import { CAPS, ROLES, can, HttpError } from './permissions.js';
import { overview, changeCost, overage, clashes, findSwap } from './calc.js';
import { computeGst, stateFromGstin, tallyXml, billsCsv, RATES } from './gst.js';
import { breakdownScene } from './claude.js';
import { tx } from './db.js';

const INDUSTRIES = ['hi', 'te', 'ta', 'kn', 'ml'];
const LANGS = ['en', ...INDUSTRIES];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Today in India, or SLATE_TODAY for demos and tests. */
export function today() {
  if (process.env.SLATE_TODAY) return process.env.SLATE_TODAY;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

const int = (v, name, { min = 0, max = 1e12 } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be a number between ${min} and ${max}`);
  return Math.round(n);
};
const num = (v, name, { min = 0, max = 1000 } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  return n;
};
const text = (v, name, { max = 300, required = true } = {}) => {
  const s = String(v ?? '').trim();
  if (required && !s) throw new HttpError(400, `${name} is required`);
  if (s.length > max) throw new HttpError(400, `${name} is too long`);
  return s;
};
const date = (v, name = 'Date') => { if (!ISO.test(String(v))) throw new HttpError(400, `${name} must be YYYY-MM-DD`); return String(v); };
const addDays = (iso, k) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };

export function apiRouter(db) {
  const r = Router();
  r.use(requireUser(db));
  const audit = (req, action, detail = '') =>
    db.prepare('INSERT INTO audit (production_id, user_id, action, detail) VALUES (?, ?, ?, ?)').run(req.pid, req.user.id, action, detail);

  // ---- loading helpers
  const daysOf = pid => {
    const days = db.prepare('SELECT * FROM shoot_days WHERE production_id = ? ORDER BY n').all(pid);
    const cast = db.prepare('SELECT dc.day_id, dc.actor_id FROM day_cast dc JOIN shoot_days d ON d.id = dc.day_id WHERE d.production_id = ?').all(pid);
    const byDay = new Map(days.map(d => [d.id, []]));
    for (const c of cast) byDay.get(c.day_id)?.push(c.actor_id);
    return days.map(d => ({ ...d, cast: byDay.get(d.id).sort((a, b) => a - b) }));
  };
  const awayOf = pid => {
    const rows = db.prepare('SELECT u.actor_id, u.date FROM unavailability u JOIN actors a ON a.id = u.actor_id WHERE a.production_id = ?').all(pid);
    const m = new Map();
    for (const { actor_id, date } of rows) { if (!m.has(actor_id)) m.set(actor_id, new Set()); m.get(actor_id).add(date); }
    return m;
  };
  const actorsOf = pid => db.prepare('SELECT * FROM actors WHERE production_id = ? ORDER BY fee DESC, id').all(pid);
  const changesOf = pid => db.prepare(`SELECT c.*, u.name AS requested_by_name FROM change_requests c JOIN users u ON u.id = c.requested_by
    WHERE c.production_id = ? ORDER BY c.status = 'pending' DESC, c.created_at DESC, c.id DESC`).all(pid);

  // ---- productions and team
  r.get('/productions', (req, res) => {
    res.json(db.prepare(`SELECT p.id, p.title, p.industry, p.langs, m.role FROM productions p
      JOIN memberships m ON m.production_id = p.id WHERE m.user_id = ? ORDER BY p.created_at DESC`).all(req.user.id)
      .map(p => ({ ...p, langs: JSON.parse(p.langs) })));
  });

  r.post('/productions', (req, res) => {
    const b = req.body;
    const title = text(b.title, 'Title', { max: 120 });
    const industry = INDUSTRIES.includes(b.industry) ? b.industry : (() => { throw new HttpError(400, 'Pick an industry'); })();
    const langs = (Array.isArray(b.langs) ? b.langs : [industry]).filter(l => INDUSTRIES.includes(l));
    const plannedDays = int(b.plannedDays, 'Planned shoot days', { min: 1, max: 400 });
    const dayCost = int(b.dayCost, 'Day cost', { min: 1000 });
    const fixed = int(b.fixedCost ?? 0, 'Committed cost');
    const start = date(b.startDate, 'Start date');
    const gstin = String(b.gstin || '').trim().toUpperCase();
    const state = gstin ? stateFromGstin(gstin) : String(b.stateCode || '36');
    if (gstin && !state) throw new HttpError(400, 'GSTIN is not valid');
    const pid = tx(db, () => {
      const { lastInsertRowid: id } = db.prepare(`INSERT INTO productions (title, industry, langs, fixed_cost, day_cost, planned_days, company, gstin, state_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(title, industry, JSON.stringify(langs.length ? langs : [industry]), fixed, dayCost, plannedDays, text(b.company ?? title, 'Company', { required: false }) || title, gstin, state);
      db.prepare('INSERT INTO memberships (user_id, production_id, role) VALUES (?, ?, ?)').run(req.user.id, id, 'producer');
      const ins = db.prepare('INSERT INTO shoot_days (production_id, n, date) VALUES (?, ?, ?)');
      for (let i = 0; i < plannedDays; i++) ins.run(id, i + 1, addDays(start, i));
      return Number(id);
    });
    req.pid = pid; audit(req, 'production.create', title);
    res.status(201).json({ id: pid });
  });

  r.post('/join', (req, res) => {
    const code = text(req.body.code, 'Invite code', { max: 40 }).toUpperCase();
    const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
    if (!inv || inv.used_by) throw new HttpError(404, 'That invite code is not valid or was already used');
    tx(db, () => {
      db.prepare('INSERT OR REPLACE INTO memberships (user_id, production_id, role) VALUES (?, ?, ?)').run(req.user.id, inv.production_id, inv.role);
      db.prepare('UPDATE invites SET used_by = ? WHERE code = ?').run(req.user.id, code);
      if (inv.role === 'manager' && inv.actor_id) db.prepare('UPDATE actors SET manager_user_id = ? WHERE id = ? AND production_id = ?').run(req.user.id, inv.actor_id, inv.production_id);
    });
    req.pid = inv.production_id; audit(req, 'team.join', inv.role);
    res.json({ id: inv.production_id, role: inv.role });
  });

  r.get('/p/:pid', member(db), (req, res) => {
    const p = req.production;
    res.json({ ...p, langs: JSON.parse(p.langs), role: req.role, caps: CAPS[req.role], today: today() });
  });

  r.get('/p/:pid/team', member(db, 'manage:team'), (req, res) => {
    res.json({
      members: db.prepare('SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.production_id = ? ORDER BY u.name').all(req.pid),
      invites: db.prepare('SELECT code, role, actor_id, created_at FROM invites WHERE production_id = ? AND used_by IS NULL ORDER BY created_at DESC').all(req.pid),
    });
  });

  r.post('/p/:pid/invites', member(db, 'manage:team'), (req, res) => {
    const role = ROLES.includes(req.body.role) ? req.body.role : (() => { throw new HttpError(400, 'Pick a role'); })();
    let actorId = null;
    if (role === 'manager') {
      actorId = int(req.body.actorId, 'Actor', { min: 1 });
      if (!db.prepare('SELECT 1 FROM actors WHERE id = ? AND production_id = ?').get(actorId, req.pid)) throw new HttpError(400, 'Pick an actor in this production');
    }
    const code = randomBytes(5).toString('hex').toUpperCase();
    db.prepare('INSERT INTO invites (code, production_id, role, actor_id, created_by) VALUES (?, ?, ?, ?, ?)').run(code, req.pid, role, actorId, req.user.id);
    audit(req, 'team.invite', role);
    res.status(201).json({ code, role });
  });

  r.delete('/p/:pid/members/:uid', member(db, 'manage:team'), (req, res) => {
    const uid = Number(req.params.uid);
    if (uid === req.user.id) throw new HttpError(400, 'You cannot remove yourself');
    db.prepare('DELETE FROM memberships WHERE user_id = ? AND production_id = ?').run(uid, req.pid);
    db.prepare('UPDATE actors SET manager_user_id = NULL WHERE manager_user_id = ? AND production_id = ?').run(uid, req.pid);
    audit(req, 'team.remove', String(uid));
    res.json({ ok: true });
  });

  r.get('/p/:pid/audit', member(db, 'manage:team'), (req, res) => {
    res.json(db.prepare(`SELECT a.action, a.detail, a.at, u.name FROM audit a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.production_id = ? ORDER BY a.id DESC LIMIT 100`).all(req.pid));
  });

  // ---- overview
  r.get('/p/:pid/overview', member(db, 'view:overview'), (req, res) => {
    const p = req.production, days = daysOf(req.pid), changes = changesOf(req.pid), away = awayOf(req.pid), actors = actorsOf(req.pid);
    const o = overview(p, days, changes);
    const alerts = [];
    if (o.gap > 0) alerts.push({ type: 'over', amount: o.gap, ratio: o.ratio });
    const names = new Map(actors.map(a => [a.id, a.name]));
    for (const c of clashes(days, away, today())) alerts.push({ type: 'clash', actor: names.get(c.actorId), n: c.n, date: c.date, amount: o.dayLoss });
    for (const a of actors) {
      const worked = days.filter(d => d.actual_cost != null && d.cast.includes(a.id)).length;
      const ov = overage(a, worked, p.per_head, p.van_day);
      if (ov.sofar > 0) alerts.push({ type: 'overage', actor: a.name, entourage: [a.used_entourage, a.terms_entourage], vans: [a.used_vans, a.terms_vans], amount: ov.sofar });
    }
    for (const c of changes.filter(c => c.status === 'pending')) alerts.push({ type: 'pending', title: c.title, amount: changeCost(c, p.day_cost, o.ratio).fresh });
    const toWrap = days.find(d => d.actual_cost == null && d.date <= today());
    res.json({ ...o, fixed: p.fixed_cost, dayCost: p.day_cost, alerts, nextWrap: toWrap ? { n: toWrap.n, date: toWrap.date } : null });
  });

  // ---- schedule and star dates
  r.get('/p/:pid/schedule', member(db, 'view:schedule'), (req, res) => {
    const t = today(), days = daysOf(req.pid), away = awayOf(req.pid), actors = actorsOf(req.pid);
    const o = overview(req.production, days, changesOf(req.pid));
    const upcoming = days.filter(d => d.actual_cost == null && d.date >= t).slice(0, Number(req.query.window) || 14);
    const cl = clashes(upcoming, away, t).map(c => {
      const sw = findSwap(days.find(d => d.id === c.dayId), days, away, t);
      return { ...c, swapWith: sw ? { n: sw.n, date: sw.date } : null };
    });
    res.json({
      today: t, dayLoss: o.dayLoss,
      actors: actors.map(a => ({ id: a.id, name: a.name, part: a.part, away: [...(away.get(a.id) || [])].sort(),
        editable: can(req.role, 'edit:dates') && (req.role !== 'manager' || a.manager_user_id === req.user.id) })),
      days: upcoming.map(d => ({ n: d.n, date: d.date, location: d.location, cast: d.cast })),
      clashes: cl,
      canSwap: can(req.role, 'edit:schedule'),
    });
  });

  r.put('/p/:pid/actors/:aid/away/:date', member(db, 'edit:dates'), (req, res) => {
    const a = db.prepare('SELECT * FROM actors WHERE id = ? AND production_id = ?').get(Number(req.params.aid), req.pid);
    if (!a) throw new HttpError(404, 'Actor not found');
    if (req.role === 'manager' && a.manager_user_id !== req.user.id) throw new HttpError(403, 'You can only change dates for the actors you manage');
    const d = date(req.params.date);
    if (req.body.away) db.prepare('INSERT OR IGNORE INTO unavailability (actor_id, date) VALUES (?, ?)').run(a.id, d);
    else db.prepare('DELETE FROM unavailability WHERE actor_id = ? AND date = ?').run(a.id, d);
    audit(req, req.body.away ? 'dates.away' : 'dates.free', `${a.name} ${d}`);
    res.json({ ok: true });
  });

  r.post('/p/:pid/days/swap', member(db, 'edit:schedule'), (req, res) => {
    const A = db.prepare('SELECT * FROM shoot_days WHERE production_id = ? AND n = ?').get(req.pid, int(req.body.a, 'Day', { min: 1 }));
    const B = db.prepare('SELECT * FROM shoot_days WHERE production_id = ? AND n = ?').get(req.pid, int(req.body.b, 'Day', { min: 1 }));
    if (!A || !B || A.id === B.id) throw new HttpError(400, 'Pick two different shoot days');
    if (A.actual_cost != null || B.actual_cost != null) throw new HttpError(400, 'A day already shot cannot be moved');
    tx(db, () => {
      // Dates stay put; what is shot on them (location, cast, scenes) trades places.
      db.prepare('UPDATE shoot_days SET location = ? WHERE id = ?').run(B.location, A.id);
      db.prepare('UPDATE shoot_days SET location = ? WHERE id = ?').run(A.location, B.id);
      const castOf = id => db.prepare('SELECT actor_id FROM day_cast WHERE day_id = ?').all(id).map(r => r.actor_id);
      const scenesOf = id => db.prepare('SELECT id FROM scenes WHERE day_id = ?').all(id).map(r => r.id);
      const [cA, cB, sA, sB] = [castOf(A.id), castOf(B.id), scenesOf(A.id), scenesOf(B.id)];
      db.prepare('DELETE FROM day_cast WHERE day_id IN (?, ?)').run(A.id, B.id);
      const addCast = db.prepare('INSERT INTO day_cast (day_id, actor_id) VALUES (?, ?)');
      cB.forEach(a => addCast.run(A.id, a));
      cA.forEach(a => addCast.run(B.id, a));
      const moveScene = db.prepare('UPDATE scenes SET day_id = ? WHERE id = ?');
      sA.forEach(s => moveScene.run(B.id, s));
      sB.forEach(s => moveScene.run(A.id, s));
    });
    audit(req, 'schedule.swap', `${A.n} <> ${B.n}`);
    res.json({ ok: true });
  });

  r.put('/p/:pid/days/:n/actual', member(db, 'record:actual'), (req, res) => {
    const d = db.prepare('SELECT * FROM shoot_days WHERE production_id = ? AND n = ?').get(req.pid, Number(req.params.n));
    if (!d) throw new HttpError(404, 'Shoot day not found');
    const cost = int(req.body.cost, 'Actual cost', { min: 0 });
    db.prepare('UPDATE shoot_days SET actual_cost = ? WHERE id = ?').run(cost, d.id);
    db.prepare('UPDATE scenes SET shot = 1 WHERE day_id = ?').run(d.id);
    audit(req, 'day.wrap', `Day ${d.n}: ${cost}`);
    res.json({ ok: true });
  });

  // ---- contracts
  r.get('/p/:pid/contracts', member(db, 'view:contracts'), (req, res) => {
    const p = req.production, days = daysOf(req.pid);
    res.json({
      perHead: p.per_head, vanDay: p.van_day,
      actors: actorsOf(req.pid).map(a => {
        const worked = days.filter(d => d.actual_cost != null && d.cast.includes(a.id)).length;
        return { ...a, overage: overage(a, worked, p.per_head, p.van_day) };
      }),
    });
  });

  r.post('/p/:pid/actors', member(db, 'edit:contracts'), (req, res) => {
    const b = req.body;
    const { lastInsertRowid } = db.prepare(`INSERT INTO actors (production_id, name, part, fee, terms_vans, terms_entourage, per_diem, used_vans, used_entourage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.pid, text(b.name, 'Name', { max: 80 }), text(b.part, 'Part', { required: false, max: 60 }),
      int(b.fee ?? 0, 'Fee'), int(b.termsVans ?? 1, 'Vans', { max: 10 }), int(b.termsEntourage ?? 2, 'Entourage', { max: 50 }), int(b.perDiem ?? 0, 'Per diem'),
      int(b.termsVans ?? 1, 'Vans', { max: 10 }), int(b.termsEntourage ?? 2, 'Entourage', { max: 50 }));
    audit(req, 'actor.add', b.name);
    res.status(201).json({ id: Number(lastInsertRowid) });
  });

  r.patch('/p/:pid/actors/:aid/usage', member(db, 'edit:usage'), (req, res) => {
    const a = db.prepare('SELECT * FROM actors WHERE id = ? AND production_id = ?').get(Number(req.params.aid), req.pid);
    if (!a) throw new HttpError(404, 'Actor not found');
    const vans = req.body.vans != null ? int(req.body.vans, 'Vans', { max: 10 }) : a.used_vans;
    const ent = req.body.entourage != null ? int(req.body.entourage, 'Entourage', { max: 50 }) : a.used_entourage;
    db.prepare('UPDATE actors SET used_vans = ?, used_entourage = ? WHERE id = ?').run(vans, ent, a.id);
    audit(req, 'actor.usage', `${a.name}: vans ${vans}, entourage ${ent}`);
    res.json({ ok: true });
  });

  // ---- change requests
  r.get('/p/:pid/changes', member(db, 'view:changes'), (req, res) => {
    const p = req.production, o = overview(p, daysOf(req.pid), changesOf(req.pid));
    res.json({ dayLoss: o.dayLoss, ratio: o.ratio, canDecide: can(req.role, 'decide:change'), canRequest: can(req.role, 'request:change'),
      changes: changesOf(req.pid).map(c => ({ ...c, cost: changeCost(c, p.day_cost, o.ratio) })) });
  });

  r.post('/p/:pid/changes', member(db, 'request:change'), (req, res) => {
    const b = req.body;
    const { lastInsertRowid } = db.prepare(`INSERT INTO change_requests (production_id, title, scenes, note, requested_by, requested_role, wasted_days, new_days, extra)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.pid, text(b.title, 'What changes', { max: 160 }), text(b.scenes, 'Scenes', { required: false, max: 80 }),
      text(b.note, 'Note', { required: false, max: 400 }), req.user.id, req.role,
      num(b.wastedDays ?? 0, 'Shot days wasted', { max: 100 }), num(b.newDays ?? 0, 'New shoot days', { max: 100 }), int(b.extra ?? 0, 'Other cost'));
    audit(req, 'change.request', b.title);
    res.status(201).json({ id: Number(lastInsertRowid) });
  });

  r.post('/p/:pid/changes/:cid/decision', member(db, 'decide:change'), (req, res) => {
    const status = ['approved', 'rejected'].includes(req.body.status) ? req.body.status : (() => { throw new HttpError(400, 'Status must be approved or rejected'); })();
    const c = db.prepare('SELECT * FROM change_requests WHERE id = ? AND production_id = ?').get(Number(req.params.cid), req.pid);
    if (!c) throw new HttpError(404, 'Change request not found');
    if (c.status !== 'pending') throw new HttpError(409, 'This request was already decided');
    db.prepare("UPDATE change_requests SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?").run(status, req.user.id, c.id);
    audit(req, 'change.' + status, c.title);
    res.json({ ok: true });
  });

  // ---- crew, attendance and call sheet
  r.get('/p/:pid/crew', member(db, 'view:crew'), (req, res) => {
    const d = req.query.date ? date(req.query.date) : today();
    const crew = db.prepare(`SELECT c.*, a.present, a.paid, a.marked_at FROM crew c
      LEFT JOIN attendance a ON a.crew_id = c.id AND a.date = ? WHERE c.production_id = ? AND c.active = 1 ORDER BY c.dept, c.name`).all(d, req.pid);
    const day = db.prepare('SELECT n FROM shoot_days WHERE production_id = ? AND date = ?').get(req.pid, d);
    res.json({ date: d, dayN: day?.n ?? null, crew, payable: crew.filter(c => c.present).reduce((s, c) => s + c.wage, 0) });
  });

  r.post('/p/:pid/crew', member(db, 'edit:crew'), (req, res) => {
    const b = req.body;
    const upi = text(b.upi, 'UPI ID', { required: false, max: 80 });
    if (upi && !/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(upi)) throw new HttpError(400, 'UPI ID looks wrong (name@bank)');
    const { lastInsertRowid } = db.prepare('INSERT INTO crew (production_id, name, dept, wage, upi, phone, lang) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.pid, text(b.name, 'Name', { max: 80 }), text(b.dept, 'Department', { required: false, max: 40 }), int(b.wage, 'Daily wage', { min: 1, max: 1e6 }),
        upi, text(b.phone, 'Phone', { required: false, max: 20 }), LANGS.includes(b.lang) ? b.lang : 'en');
    audit(req, 'crew.add', b.name);
    res.status(201).json({ id: Number(lastInsertRowid) });
  });

  /** Batch of attendance marks, possibly queued offline. Newest mark per person per day wins. */
  r.post('/p/:pid/attendance', member(db, 'edit:crew'), (req, res) => {
    const marks = Array.isArray(req.body.marks) ? req.body.marks.slice(0, 500) : [];
    const ids = new Set(db.prepare('SELECT id FROM crew WHERE production_id = ?').all(req.pid).map(r => r.id));
    let applied = 0;
    tx(db, () => {
      const cur = db.prepare('SELECT marked_at FROM attendance WHERE crew_id = ? AND date = ?');
      const up = db.prepare(`INSERT INTO attendance (crew_id, date, present, marked_by, marked_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (crew_id, date) DO UPDATE SET present = excluded.present, marked_by = excluded.marked_by, marked_at = excluded.marked_at`);
      for (const m of marks) {
        const crewId = Number(m.crewId);
        if (!ids.has(crewId) || !ISO.test(String(m.date))) continue;
        const at = new Date(m.markedAt || Date.now()).toISOString();
        const prev = cur.get(crewId, m.date);
        if (prev && prev.marked_at >= at) continue;
        up.run(crewId, m.date, m.present ? 1 : 0, req.user.id, at);
        applied++;
      }
    });
    if (applied) audit(req, 'attendance', `${applied} marks`);
    res.json({ applied, received: marks.length });
  });

  r.post('/p/:pid/attendance/paid', member(db, 'edit:crew'), (req, res) => {
    db.prepare('UPDATE attendance SET paid = ? WHERE crew_id = ? AND date = ? AND crew_id IN (SELECT id FROM crew WHERE production_id = ?)')
      .run(req.body.paid ? 1 : 0, Number(req.body.crewId), date(req.body.date), req.pid);
    audit(req, 'pay.mark', `${req.body.crewId} ${req.body.date}`);
    res.json({ ok: true });
  });

  r.get('/p/:pid/callsheet', member(db, 'view:schedule'), (req, res) => {
    const t = today();
    const d = db.prepare('SELECT * FROM shoot_days WHERE production_id = ? AND date > ? AND actual_cost IS NULL ORDER BY date LIMIT 1').get(req.pid, t);
    if (!d) return res.json(null);
    res.json({ n: d.n, date: d.date, location: d.location,
      scenes: db.prepare('SELECT no, heading FROM scenes WHERE day_id = ? ORDER BY no').all(d.id),
      cast: db.prepare('SELECT a.name FROM day_cast dc JOIN actors a ON a.id = dc.actor_id WHERE dc.day_id = ? ORDER BY a.fee DESC').all(d.id).map(a => a.name) });
  });

  // ---- vendor bills, GST and Tally
  const billsOf = pid => db.prepare('SELECT * FROM bills WHERE production_id = ? ORDER BY date DESC, id DESC').all(pid);
  r.get('/p/:pid/bills', member(db, 'view:bills'), (req, res) => {
    const bills = billsOf(req.pid);
    const sum = k => bills.reduce((s, b) => s + b[k], 0);
    res.json({ stateCode: req.production.state_code, rates: RATES, canEdit: can(req.role, 'edit:bills'), bills,
      totals: { taxable: sum('taxable_paise'), cgst: sum('cgst_paise'), sgst: sum('sgst_paise'), igst: sum('igst_paise'), total: sum('total_paise') } });
  });

  r.post('/p/:pid/bills', member(db, 'edit:bills'), (req, res) => {
    const b = req.body;
    const gstin = String(b.vendorGstin || '').trim().toUpperCase();
    const vState = gstin ? stateFromGstin(gstin) : String(b.vendorState || '').padStart(2, '0');
    if (gstin && !vState) throw new HttpError(400, 'Vendor GSTIN is not valid');
    if (!/^\d{2}$/.test(vState || '')) throw new HttpError(400, 'Vendor state code is required (two digits) when there is no GSTIN');
    const taxable = int(Math.round(Number(b.taxable) * 100), 'Taxable amount', { min: 1 });
    let g;
    try { g = computeGst(taxable, Number(b.rate), vState, req.production.state_code); } catch (e) { throw new HttpError(400, e.message); }
    try {
      const { lastInsertRowid } = db.prepare(`INSERT INTO bills (production_id, vendor, vendor_gstin, vendor_state, invoice_no, date, ledger, taxable_paise, rate, cgst_paise, sgst_paise, igst_paise, total_paise, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.pid, text(b.vendor, 'Vendor', { max: 100 }), gstin, vState, text(b.invoiceNo, 'Invoice number', { max: 40 }),
        date(b.date, 'Invoice date'), text(b.ledger, 'Ledger', { max: 60 }), taxable, Number(b.rate), g.cgst, g.sgst, g.igst, g.total, req.user.id);
      audit(req, 'bill.add', `${b.vendor} ${b.invoiceNo}`);
      res.status(201).json({ id: Number(lastInsertRowid), ...g });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'This vendor invoice is already entered');
      throw e;
    }
  });

  r.get('/p/:pid/bills/tally.xml', member(db, 'view:bills'), (req, res) => {
    res.type('application/xml').attachment(`slate-${req.pid}-tally.xml`).send(tallyXml(req.production.company, billsOf(req.pid)));
  });
  r.get('/p/:pid/bills/bills.csv', member(db, 'view:bills'), (req, res) => {
    res.type('text/csv').attachment(`slate-${req.pid}-bills.csv`).send(billsCsv(billsOf(req.pid)));
  });

  // ---- script breakdown with Claude
  r.post('/p/:pid/script/breakdown', member(db, 'script'), async (req, res, next) => {
    try {
      const scenes = await breakdownScene(text(req.body.text, 'Scene text', { max: 20000 }));
      res.json({ scenes });
    } catch (e) { next(e); }
  });

  r.post('/p/:pid/scenes', member(db, 'script'), (req, res) => {
    const list = Array.isArray(req.body.scenes) ? req.body.scenes.slice(0, 50) : [];
    const langs = JSON.parse(req.production.langs);
    let no = db.prepare('SELECT COALESCE(MAX(no), 0) AS m FROM scenes WHERE production_id = ?').get(req.pid).m;
    tx(db, () => {
      const ins = db.prepare('INSERT INTO scenes (production_id, no, heading, bilingual, source_lang, breakdown) VALUES (?, ?, ?, ?, ?, ?)');
      for (const s of list) ins.run(req.pid, ++no, String(s.heading || '').slice(0, 120), langs.length > 1 ? 1 : 0, String(s.language || '').slice(0, 20), JSON.stringify(s).slice(0, 8000));
    });
    audit(req, 'scenes.add', `${list.length}`);
    res.status(201).json({ added: list.length, total: no });
  });

  r.get('/p/:pid/scenes', member(db, 'script'), (req, res) => {
    res.json(db.prepare('SELECT s.no, s.heading, s.shot, s.source_lang, d.n AS day FROM scenes s LEFT JOIN shoot_days d ON d.id = s.day_id WHERE s.production_id = ? ORDER BY s.no DESC LIMIT 200').all(req.pid));
  });

  return r;
}

// Creates a demo production mid-shoot, with one login per role. Password for all: demo1234
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from './db.js';
import { today } from './api.js';

const addDays = (iso, k) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };

export const DEMO_USERS = [
  ['producer@demo.slate', 'Padma (Producer)', 'producer', 'te'],
  ['director@demo.slate', 'Dev (Director)', 'director', 'ta'],
  ['writer@demo.slate', 'Wahida (Screenwriter)', 'writer', 'hi'],
  ['lineprod@demo.slate', 'Lokesh (Line producer)', 'lineprod', 'te'],
  ['manager@demo.slate', 'Manoj (Actor\'s manager)', 'manager', 'en'],
  ['financier@demo.slate', 'Farhan (Financier)', 'financier', 'en'],
];

export function seed(db, { start = addDays(today(), -19) } = {}) {
  let s = 7;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const hash = bcrypt.hashSync('demo1234', 10);

  return tx(db, () => {
    const uid = {};
    for (const [email, name, role, lang] of DEMO_USERS) {
      const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      uid[role] = u ? u.id : Number(db.prepare('INSERT INTO users (email, name, password_hash, lang) VALUES (?, ?, ?, ?)').run(email, name, hash, lang).lastInsertRowid);
    }
    const pid = Number(db.prepare(`INSERT INTO productions (title, industry, langs, fixed_cost, day_cost, planned_days, company, gstin, state_code)
      VALUES ('Vaaradhi', 'te', '["te","ta"]', 84000000, 7000000, 48, 'Vaaradhi Productions (sample)', '', '36')`).run().lastInsertRowid);
    for (const [, , role] of DEMO_USERS) db.prepare('INSERT INTO memberships (user_id, production_id, role) VALUES (?, ?, ?)').run(uid[role], pid, role);

    const actors = [
      ['Karthik Varma', 'Hero', 90000000, 2, 8, 25000, 3, 12, 0.8, [23, 24]],
      ['Nithya Raman', 'Heroine', 35000000, 1, 5, 15000, 1, 6, 0.6, [27]],
      ['Prakash Reddy', 'Villain', 15000000, 1, 4, 10000, 1, 4, 0.35, []],
      ['Lakshmi Devi', 'Mother', 6000000, 1, 2, 8000, 1, 2, 0.3, [21]],
    ].map(([name, part, fee, tv, te, pd, uv, ue, p, awayIdx], i) => {
      const id = Number(db.prepare(`INSERT INTO actors (production_id, name, part, fee, terms_vans, terms_entourage, per_diem, used_vans, used_entourage, manager_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(pid, name, part, fee, tv, te, pd, uv, ue, i === 0 ? uid.manager : null).lastInsertRowid);
      for (const k of awayIdx) db.prepare('INSERT INTO unavailability (actor_id, date) VALUES (?, ?)').run(id, addDays(start, k));
      return { id, p, awayIdx };
    });

    const locs = ['Ramoji Film City, Hyderabad', 'Annapurna Studios, Hyderabad', 'Old City, Hyderabad', 'Karaikudi village set', 'Vizag beach', 'Araku Valley'];
    const heads = ['INT. HOUSE - DAY', 'EXT. MARKET - DAY', 'EXT. HIGHWAY - NIGHT', 'INT. POLICE STATION - NIGHT', 'EXT. TEMPLE - DAY', 'EXT. BEACH - DAY'];
    let sceneNo = 1;
    for (let i = 0; i < 48; i++) {
      const shot = i < 19;
      const dayId = Number(db.prepare('INSERT INTO shoot_days (production_id, n, date, location, actual_cost) VALUES (?, ?, ?, ?, ?)')
        .run(pid, i + 1, addDays(start, i), pick(locs), shot ? Math.round(7000000 * (0.98 + rnd() * 0.34) / 10000) * 10000 : null).lastInsertRowid);
      const cast = actors.filter(a => rnd() < a.p || a.awayIdx.includes(i));
      if (!cast.length) cast.push(actors[0]);
      for (const a of cast) db.prepare('INSERT INTO day_cast (day_id, actor_id) VALUES (?, ?)').run(dayId, a.id);
      const k = rnd() < 0.5 ? 2 : 3;
      for (let j = 0; j < k; j++) db.prepare('INSERT INTO scenes (production_id, no, day_id, heading, bilingual, shot) VALUES (?, ?, ?, ?, ?, ?)')
        .run(pid, sceneNo++, dayId, pick(heads), rnd() < 0.6 ? 1 : 0, shot ? 1 : 0);
    }

    const ch = db.prepare(`INSERT INTO change_requests (production_id, title, scenes, note, requested_by, requested_role, wasted_days, new_days, extra, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    ch.run(pid, 'Rewrite interval fight as a rain sequence', '42, 43', 'Fight already shot dry on days 14 to 16.', uid.director, 'director', 3, 4, 12000000, 'pending');
    ch.run(pid, 'Move hero introduction song to a foreign location', '18', 'Choreographer and 40 dancers travel.', uid.producer, 'producer', 0, 6, 25000000, 'pending');
    ch.run(pid, 'Tamil dialogue polish, scenes 10 to 14', '10-14', 'Dubbing only, no reshoot.', uid.writer, 'writer', 0, 0, 600000, 'approved');

    const crew = [['Ravi Kumar', 'Lighting', 2200, 'te'], ['Suresh Babu', 'Lighting', 2200, 'te'], ['Anil Naidu', 'Camera', 3500, 'te'], ['Murugan S', 'Grip', 1800, 'ta'],
      ['Joseph Thomas', 'Art', 2500, 'ml'], ['Venkatesh P', 'Art', 1800, 'te'], ['Shabana Begum', 'Costume', 2000, 'hi'], ['Ganesh Rao', 'Makeup', 2400, 'kn'],
      ['Prabhu K', 'Driver', 1500, 'ta'], ['Salim Khan', 'Spot boy', 900, 'hi'], ['Kavya M', 'Production assistant', 1600, 'kn'], ['Raju Gowda', 'Carpenter', 2000, 'kn']];
    const t = addDays(start, 19);
    crew.forEach(([name, dept, wage, lang], i) => {
      const id = Number(db.prepare('INSERT INTO crew (production_id, name, dept, wage, upi, lang) VALUES (?, ?, ?, ?, ?, ?)')
        .run(pid, name, dept, wage, name.split(' ')[0].toLowerCase() + '.sample@upi', lang).lastInsertRowid);
      if (i !== 4 && i !== 9) db.prepare('INSERT INTO attendance (crew_id, date, present, marked_by, marked_at) VALUES (?, ?, 1, ?, ?)').run(id, t, uid.lineprod, new Date().toISOString());
    });

    const bill = db.prepare(`INSERT INTO bills (production_id, vendor, vendor_gstin, vendor_state, invoice_no, date, ledger, taxable_paise, rate, cgst_paise, sgst_paise, igst_paise, total_paise, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    bill.run(pid, 'Deccan Lights and Grips (sample)', '', '36', 'DLG-1182', addDays(start, 10), 'Equipment Hire', 48000000, 18, 4320000, 4320000, 0, 56640000, uid.lineprod);
    bill.run(pid, 'Chennai Camera House (sample)', '', '33', 'CCH-77', addDays(start, 12), 'Camera Rental', 120000000, 18, 0, 0, 21600000, 141600000, uid.lineprod);
    bill.run(pid, 'Araku Valley Caterers (sample)', '', '37', 'AVC-305', addDays(start, 15), 'Catering', 9500000, 5, 0, 0, 475000, 9975000, uid.lineprod);

    return pid;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = openDb();
  const pid = seed(db);
  console.log(`Seeded production ${pid}. Sign in with any of:`);
  for (const [email, , role] of DEMO_USERS) console.log(`  ${role.padEnd(10)} ${email}  /  demo1234`);
}

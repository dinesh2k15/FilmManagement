import { LANGS, INDUSTRY, tr } from './i18n.js';

// ---------- state and helpers
const S = { user: null, demo: false, prods: [], pid: null, prod: null, tab: null, lang: 'en', online: navigator.onLine, sheetLang: null, ai: null, aiBusy: false, invite: null };
const $ = sel => document.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const t = k => tr(S.lang, k);
const money = n => { const a = Math.abs(n), s = n < 0 ? '−' : ''; if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)} Cr`; if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(1)} L`; return `${s}₹${Math.round(a).toLocaleString('en-IN')}`; };
const paise = p => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortDate = iso => new Date(iso + 'T00:00:00').toLocaleDateString(S.lang === 'en' ? 'en-IN' : S.lang + '-IN', { day: 'numeric', month: 'short' });
const has = cap => !!S.prod?.caps?.includes(cap);
const store = { get(k, d) { try { const v = localStorage.getItem('slate.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('slate.' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } } };

function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2600); }

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  } catch { throw new ApiError(0, t('offline')); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth')) { S.user = null; renderAuth(); throw new ApiError(401, data.error || 'Sign in again'); }
  if (!res.ok) throw new ApiError(res.status, data.error || `Error ${res.status}`);
  return data;
}

// ---------- offline outbox for attendance
const outbox = () => store.get('outbox', []);
function queueMark(mark) {
  const box = outbox().filter(m => !(m.pid === mark.pid && m.crewId === mark.crewId && m.date === mark.date));
  box.push(mark); store.set('outbox', box); updateOffline();
}
async function flushOutbox() {
  const box = outbox(); if (!box.length || !navigator.onLine) return;
  const byPid = new Map();
  for (const m of box) { if (!byPid.has(m.pid)) byPid.set(m.pid, []); byPid.get(m.pid).push(m); }
  let left = [];
  for (const [pid, marks] of byPid) {
    try { await api(`/p/${pid}/attendance`, { method: 'POST', body: { marks } }); }
    catch (e) { if (e.status === 0) left = left.concat(marks); }
  }
  store.set('outbox', left); updateOffline();
  if (box.length !== left.length && S.tab === 'crew') show('crew');
}
function updateOffline() {
  const el = $('#offline'), n = outbox().length;
  el.hidden = S.online && !n;
  el.textContent = S.online ? `${n} ${t('queued')}` : `${t('offline')}${n ? ` · ${n} ${t('queued')}` : ''}`;
}
addEventListener('online', () => { S.online = true; updateOffline(); flushOutbox(); });
addEventListener('offline', () => { S.online = false; updateOffline(); });

// ---------- sign in
function renderAuth(mode = 'in') {
  $('#root').innerHTML = `
  <header class="slate"><div class="clap" aria-hidden="true"></div><div class="top"><div class="brand"><h1>Slate</h1><p>${esc(t('tagline'))}</p></div>
    <div class="pick"><label><span>${esc(t('language'))}</span><select id="lang">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}"${k === S.lang ? ' selected' : ''}>${v}</option>`).join('')}</select></label></div></div><div style="height:16px"></div></header>
  <main class="auth"><div class="card">
    <div class="seg" role="group"><button data-mode="in" aria-pressed="${mode === 'in'}">${esc(t('signIn'))}</button><button data-mode="up" aria-pressed="${mode === 'up'}">${esc(t('signUp'))}</button></div>
    <form class="stackform" id="authform" data-mode="${mode}">
      ${mode === 'up' ? `<label>${esc(t('name'))}<input id="a-name" autocomplete="name" required></label>` : ''}
      <label>${esc(t('email'))}<input id="a-email" type="email" autocomplete="email" required></label>
      <label>${esc(t('password'))}<input id="a-pass" type="password" autocomplete="${mode === 'up' ? 'new-password' : 'current-password'}" minlength="8" required></label>
      <p class="err" id="a-err"></p>
      <button class="btn red" type="submit">${esc(mode === 'up' ? t('signUp') : t('signIn'))}</button>
    </form>
    ${S.demo ? `<p class="note">Demo logins, password <b>demo1234</b>: producer@demo.slate, director@demo.slate, writer@demo.slate, lineprod@demo.slate, manager@demo.slate, financier@demo.slate</p>` : ''}
  </div></main>`;
}

// ---------- production picker
async function renderPicker() {
  S.pid = null; S.prod = null;
  $('#root').innerHTML = `${headerHtml()}<main><p class="loading">…</p></main>`;
  S.prods = await api('/productions');
  const today = new Date().toISOString().slice(0, 10);
  $('#root main').innerHTML = `
  <div class="two">
    <section><h2>${esc(t('productions'))}</h2>
      ${S.prods.length ? `<ul class="plist">${S.prods.map(p => `<li><button data-open="${p.id}"><span><b>${esc(p.title)}</b><br><span class="note">${esc(INDUSTRY[p.industry] || '')} · ${p.langs.map(l => LANGS[l]).join(' + ')}</span></span><span class="chip pending">${esc(t('r_' + p.role))}</span></button></li>`).join('')}</ul>` : `<p class="empty">No productions yet. Start one, or join with a code from your producer.</p>`}
      <h3 style="margin-top:28px">${esc(t('join'))}</h3>
      <form class="row" id="joinform"><input id="j-code" placeholder="${esc(t('inviteCode'))}" aria-label="${esc(t('inviteCode'))}" required style="flex:1"><button class="btn">${esc(t('join'))}</button></form>
    </section>
    <section class="panel"><h3>${esc(t('newProduction'))}</h3>
      <form class="f" id="prodform">
        <label class="wide">Title<input id="n-title" required maxlength="120"></label>
        <label>Industry<select id="n-ind">${Object.entries(INDUSTRY).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
        <label>Second shooting language<select id="n-lang2"><option value="">None</option>${Object.entries(INDUSTRY).map(([k]) => `<option value="${k}">${LANGS[k]}</option>`).join('')}</select></label>
        <label>First shoot day<input id="n-start" type="date" value="${today}" required></label>
        <label>Planned shoot days<input id="n-days" type="number" min="1" max="400" value="45" required></label>
        <label>Cost per shoot day (₹)<input id="n-daycost" type="number" min="1000" step="10000" value="5000000" required></label>
        <label>Committed fees and pre-production (₹)<input id="n-fixed" type="number" min="0" step="100000" value="0"></label>
        <label class="wide">Production GSTIN (optional, sets your GST state)<input id="n-gstin" maxlength="15"></label>
        <p class="err wide" id="n-err"></p>
        <button class="btn red wide" type="submit">${esc(t('newProduction'))}</button>
      </form>
    </section>
  </div>`;
}

// ---------- production shell
const TABS = [['overview', 'view:overview'], ['schedule', 'view:schedule'], ['contracts', 'view:contracts'], ['changes', 'view:changes'], ['crew', 'view:crew'], ['bills', 'view:bills'], ['script', 'script'], ['team', 'manage:team']];
const tabLabel = k => ({ bills: t('t_bills'), team: t('t_team') })[k] || t('t_' + k);

function headerHtml() {
  const p = S.prod;
  return `<header class="slate"><div class="clap" aria-hidden="true"></div>
  <div class="top">
    <div class="brand"><h1>${esc(p ? p.title : 'Slate')}</h1><p>${p ? `${esc(INDUSTRY[p.industry] || '')} · ${p.langs.map(l => LANGS[l]).join(' + ')} · <span class="chip role">${esc(t('r_' + p.role))}</span>` : esc(S.user?.name || '')}</p></div>
    <div class="hdr-actions">
      <label class="pick"><span class="note" style="color:#c9ccd6">${esc(t('language'))}</span><select id="lang">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}"${k === S.lang ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      ${p ? `<button class="btn ghost sm" id="toPicker">${esc(t('productions'))}</button>` : ''}
      <button class="btn ghost sm" id="signout">${esc(t('signOut'))}</button>
    </div>
  </div>
  ${p ? `<nav class="tabs" role="tablist">${TABS.filter(([, c]) => has(c)).map(([k]) => `<button role="tab" id="tab-${k}" data-tab="${k}" aria-selected="${k === S.tab}">${esc(tabLabel(k))}</button>`).join('')}</nav>` : '<div style="height:16px"></div>'}
  </header>`;
}

async function openProduction(pid) {
  S.pid = pid; S.ai = null; S.invite = null;
  S.prod = await api(`/p/${pid}`);
  store.set('pid', pid);
  const first = TABS.find(([, c]) => has(c))[0];
  const saved = store.get('tab.' + pid, first);
  await show(TABS.some(([k, c]) => k === saved && has(c)) ? saved : first);
}

let ro = null;
async function show(tab) {
  S.tab = tab; store.set('tab.' + S.pid, tab);
  $('#root').innerHTML = `${headerHtml()}<main><section id="view"><p class="loading">…</p></section></main>`;
  updateOffline();
  let html;
  try { html = await VIEWS[tab](); } catch (e) { html = `<p class="empty">${esc(e.message)}</p>`; }
  if (S.tab !== tab || !$('#view')) return;
  $('#view').innerHTML = html;
  if (ro) { ro.disconnect(); ro = null; }
  const b = $('#burn'); if (b) { ro = new ResizeObserver(() => drawBurn(b)); ro.observe(b); }
  AFTER[tab]?.();
}
const reload = () => show(S.tab);

// ---------- overview
let OV = null;
async function viewOverview() {
  const o = OV = await api(`/p/${S.pid}/overview`);
  const alerts = o.alerts.map(a => {
    if (a.type === 'over') return { tag: t('forecast'), text: `${money(a.amount)} ${t('over')} · ${Math.round((a.ratio - 1) * 100)}% / ${t('day')}`, amt: money(a.amount) };
    if (a.type === 'clash') return { tag: t('clash'), text: `${a.actor} · ${t('day')} ${a.n} · ${shortDate(a.date)}`, amt: money(a.amount) };
    if (a.type === 'overage') return { tag: t('overage'), text: `${a.actor}: ${t('entourage')} ${a.entourage[0]}/${a.entourage[1]}, ${t('vans')} ${a.vans[0]}/${a.vans[1]}`, amt: money(a.amount) };
    return { cls: 'p', tag: t('pending'), text: a.title, amt: money(a.amount) };
  });
  return `
  <div class="grid">
    <div>
      <h2>${o.gap > 0 ? `${money(o.gap)} ${esc(t('over'))} · ${money(o.budget)}` : `${money(-o.gap)} ${esc(t('under'))}`}</h2>
      <p class="lede">Cumulative spend by shoot day. Committed fees and pre-production (${money(o.fixed)}) sit at day 0; the dashed line runs to the forecast.</p>
      <div class="fig" id="burn" role="img" aria-label="Cumulative spend against plan and budget"></div>
    </div>
    <div class="kpis">
      <div class="kpi"><span>${esc(t('budget'))}</span><b>${money(o.budget)}</b></div>
      <div class="kpi"><span>${esc(t('spent'))}</span><b>${money(o.spent)}</b><small>${Math.round(o.spent / o.budget * 100)}% · ${esc(t('shot'))} ${o.shotDays}/${o.totalDays}</small></div>
      <div class="kpi"><span>${esc(t('forecast'))}</span><b class="${o.gap > 0 ? 'bad' : 'good'}">${money(o.forecast)}</b><small class="${o.gap > 0 ? 'bad' : 'good'}">${o.gap > 0 ? '+' : ''}${money(o.gap)}</small></div>
      <div class="kpi"><span>${esc(t('slipCost'))}</span><b>${money(o.dayLoss)}</b><small>${money(o.dayCost)} × ${o.ratio.toFixed(2)}</small></div>
      ${has('record:actual') && o.nextWrap ? `<form class="panel stackform" id="wrapform"><b>${esc(t('wrapDay'))}: ${esc(t('day'))} ${o.nextWrap.n} · ${esc(shortDate(o.nextWrap.date))}</b>
        <label>${esc(t('actualCost'))}<input id="w-cost" type="number" min="0" step="10000" required></label><button class="btn">${esc(t('save'))}</button></form>` : ''}
    </div>
  </div>
  <h3 style="margin-top:28px">${esc(t('alerts'))}</h3>
  ${alerts.length ? `<ul class="alerts">${alerts.map(a => `<li class="${a.cls || ''}"><span class="tag">${esc(a.tag)}</span><span>${esc(a.text)}</span><span class="amt">${esc(a.amt)}</span></li>`).join('')}</ul>` : `<p class="empty">${esc(t('noAlerts'))}</p>`}`;
}

function drawBurn(s) {
  const o = OV; if (!o) return;
  const W = s.clientWidth, H = s.clientHeight, narrow = W < 520;
  const m = { l: narrow ? 44 : 58, r: narrow ? 16 : 110, t: 16, b: 30 };
  const N = o.totalDays + o.approvedNewDays;
  const step = Math.max(1e7, Math.ceil(Math.max(o.budget, o.forecast) / 5 / 1e7) * 1e7);
  const ymax = Math.ceil(Math.max(o.budget, o.forecast) * 1.08 / step) * step;
  const X = i => m.l + i / N * (W - m.l - m.r), Y = v => H - m.b - v / ymax * (H - m.t - m.b);
  let g = '';
  for (let v = 0; v <= ymax; v += step) g += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${v / 1e7}${v ? ' Cr' : ''}</text>`;
  const xs = narrow ? Math.ceil(N / 3) : Math.ceil(N / 6);
  for (let i = xs; i <= N; i += xs) g += `<text x="${X(i)}" y="${H - 8}" text-anchor="middle">${narrow ? i : esc(t('day')) + ' ' + i}</text>`;
  g += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(o.budget)}" y2="${Y(o.budget)}" stroke="var(--ink)" stroke-width="1.5"/>`;
  g += narrow ? `<text x="${m.l + 4}" y="${Y(o.budget) - 6}" style="fill:var(--ink)">${esc(t('budget'))}</text>` : `<text x="${W - m.r + 6}" y="${Y(o.budget) + 4}" style="fill:var(--ink)">${esc(t('budget'))}</text>`;
  g += `<line x1="${X(0)}" y1="${Y(o.fixed)}" x2="${X(o.totalDays)}" y2="${Y(o.budget)}" stroke="var(--blue)" stroke-width="2" stroke-dasharray="2 4"/>`;
  let cum = o.fixed; const pts = [`${X(0)},${Y(cum)}`];
  o.burn.forEach((d, i) => { cum += d.actual; pts.push(`${X(i + 1)},${Y(cum)}`); });
  const lx = X(o.burn.length), ly = Y(cum);
  g += `<polygon fill="var(--red)" fill-opacity=".1" points="${X(0)},${Y(0)} ${pts.join(' ')} ${lx},${Y(0)}"/>`;
  g += `<polyline fill="none" stroke="var(--red)" stroke-width="3" stroke-linejoin="round" points="${pts.join(' ')}"/>`;
  g += `<line x1="${lx}" y1="${ly}" x2="${X(N)}" y2="${Y(o.forecast)}" stroke="var(--red)" stroke-width="2" stroke-dasharray="6 5"/>`;
  g += `<circle cx="${lx}" cy="${ly}" r="5" fill="var(--red)"/><circle cx="${X(N)}" cy="${Y(o.forecast)}" r="5" fill="none" stroke="var(--red)" stroke-width="2"/>`;
  g += narrow ? `<text x="${X(N) - 8}" y="${Y(o.forecast) - 10}" text-anchor="end" style="fill:var(--red);font-weight:700">${money(o.forecast)}</text>` : `<text x="${X(N) + 8}" y="${Y(o.forecast) - 6}" style="fill:var(--red);font-weight:700">${money(o.forecast)}</text>`;
  g += `<text x="${Math.max(lx - 8, m.l + 80)}" y="${ly - 12}" text-anchor="end" style="fill:var(--ink);font-weight:600">${money(o.spent)}</text>`;
  s.innerHTML = `<svg viewBox="0 0 ${W} ${H}">${g}</svg>`;
}

// ---------- schedule
async function viewSchedule() {
  const d = await api(`/p/${S.pid}/schedule`);
  const up = d.days.slice(0, 12), inView = new Set(up.map(x => x.n));
  const cl = d.clashes.filter(c => inView.has(c.n));
  const name = new Map(d.actors.map(a => [a.id, a.name]));
  return `
  <h2>${cl.length ? `${cl.length} × ${esc(t('clash'))} · ${money(cl.length * d.dayLoss)}` : 'No star-date clashes in the next 12 shoot days'}</h2>
  <p class="lede">${d.actors.some(a => a.editable) ? 'Tap a cell to mark an actor away or free on that date. ' : ''}${esc(t('slipCost'))}: <b>${money(d.dayLoss)}</b>.</p>
  <div class="scroll"><table class="sched">
    <thead><tr><th>${esc(t('cast'))}</th>${up.map(x => `<th>${esc(t('day'))} ${x.n}<br><span class="note">${esc(shortDate(x.date))}</span></th>`).join('')}</tr></thead>
    <tbody>${d.actors.map(a => `<tr><td><b>${esc(a.name)}</b><br><span class="note">${esc(a.part)}</span></td>${up.map(x => {
      const need = x.cast.includes(a.id), away = a.away.includes(x.date);
      const cls = need && away ? 'clash' : need ? 'need' : away ? 'away' : '';
      const lab = need && away ? t('clash') : need ? t('needed') : away ? t('away') : '·';
      return `<td><button class="cell ${cls}" data-away="${a.id}|${x.date}|${away ? 0 : 1}" ${a.editable ? '' : 'disabled'} aria-label="${esc(a.name)} ${x.date}">${esc(lab)}</button></td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>
  ${cl.length ? `<h3 style="margin-top:24px">Fix the clashes</h3><ul class="alerts">${cl.map(c => `<li><span class="tag">${esc(t('day'))} ${c.n}</span>
    <span>${esc(name.get(c.actorId))} · ${esc(t('away'))} · ${esc(shortDate(c.date))}. ${c.swapWith ? `Swap with ${esc(t('day'))} ${c.swapWith.n} (${esc(shortDate(c.swapWith.date))}): everyone on both days is free.` : 'No clean swap in the next 12 days.'}</span>
    ${c.swapWith && d.canSwap ? `<button class="btn sm" data-swap="${c.n}|${c.swapWith.n}">Swap days</button>` : '<span></span>'}</li>`).join('')}</ul>` : ''}`;
}

// ---------- contracts
async function viewContracts() {
  const d = await api(`/p/${S.pid}/contracts`), edit = has('edit:usage');
  const tot = d.actors.reduce((s, a) => s + a.overage.sofar, 0);
  return `
  <h2>${tot ? `${esc(t('overage'))}: ${money(tot)}` : 'Every actor is within contract terms'}</h2>
  <p class="lede">Extra entourage is costed at ${money(d.perHead)} a head a day, an extra vanity van at ${money(d.vanDay)} a day, over the days each actor has worked.</p>
  <div class="cards">${d.actors.map(a => `
    <article class="card">
      <div class="row" style="justify-content:space-between"><h3 style="margin:0">${esc(a.name)}</h3><span class="note">${esc(a.part)} · ${money(a.fee)}</span></div>
      ${[['entourage', a.used_entourage, a.terms_entourage], ['vans', a.used_vans, a.terms_vans]].map(([k, u, tm]) => { const mx = Math.max(u, tm, 1); return `
      <div class="meter"><span>${esc(t(k))}</span><span class="bar"><i class="${u > tm ? 'o' : ''}" style="width:${u / mx * 100}%"></i><u style="left:calc(${tm / mx * 100}% - 2px)"></u></span><span class="num">${u}/${tm}</span></div>`; }).join('')}
      ${edit ? `<div class="row"><label class="note">${esc(t('entourage'))} <input type="number" min="0" max="50" id="ent-${a.id}" value="${a.used_entourage}" data-use="${a.id}|entourage" style="width:5.5em"></label><label class="note">${esc(t('vans'))} <input type="number" min="0" max="10" id="van-${a.id}" value="${a.used_vans}" data-use="${a.id}|vans" style="width:5.5em"></label></div>` : ''}
      <div class="row" style="justify-content:space-between"><span class="note">${esc(t('overage'))} · ${a.overage.worked} × ${esc(t('day'))}</span><b class="num ${a.overage.sofar ? 'bad' : 'good'}">${money(a.overage.sofar)}</b></div>
      <span class="note">Per diem ${money(a.per_diem)} ${esc(t('perDay'))}</span>
    </article>`).join('')}</div>`;
}

// ---------- change requests
let CH = null;
async function viewChanges() {
  const d = CH = await api(`/p/${S.pid}/changes`);
  const pend = d.changes.filter(c => c.status === 'pending'), pendCost = pend.reduce((s, c) => s + c.cost.fresh, 0);
  return `
  <h2>${pend.length ? `${pend.length} × ${esc(t('pending'))} · +${money(pendCost)}` : 'No changes waiting for approval'}</h2>
  <p class="lede">Each change is priced before anyone says yes: new shoot days at today's real day cost (${money(d.dayLoss)}), other costs, and footage already shot that gets thrown away.</p>
  ${d.canRequest ? `<div class="panel" style="margin-bottom:20px"><form class="f" id="cform">
    <label class="wide">${esc(t('cTitle'))}<input id="c-title" required maxlength="160"></label>
    <label>${esc(t('cScenes'))}<input id="c-scenes" maxlength="80"></label>
    <label>${esc(t('wasted'))}<input id="c-wasted" type="number" min="0" step="0.5" value="0"></label>
    <label>${esc(t('newDays'))}<input id="c-new" type="number" min="0" step="0.5" value="1"></label>
    <label>${esc(t('extra'))}<input id="c-extra" type="number" min="0" step="10000" value="0"></label>
    <label class="wide">Why<input id="c-note" maxlength="400"></label>
    <div class="wide row" style="justify-content:space-between"><div><span class="note">${esc(t('total'))}</span><div class="big" id="c-total"></div><span class="note" id="c-split"></span></div><button class="btn red" type="submit">${esc(t('submit'))}</button></div>
  </form></div>` : ''}
  <div class="scroll"><table class="stack">
    <thead><tr><th>${esc(t('cTitle'))}</th><th>${esc(t('cScenes'))}</th><th>By</th><th class="n">${esc(t('newDays'))}</th><th class="n">Footage lost</th><th class="n">Adds to forecast</th><th>Status</th><th></th></tr></thead>
    <tbody>${d.changes.map(c => `<tr>
      <td data-l="${esc(t('cTitle'))}"><b>${esc(c.title)}</b>${c.note ? `<br><span class="note">${esc(c.note)}</span>` : ''}</td>
      <td data-l="${esc(t('cScenes'))}">${esc(c.scenes)}</td><td data-l="By">${esc(c.requested_by_name)}</td>
      <td class="n" data-l="${esc(t('newDays'))}">${esc(c.new_days)}</td><td class="n" data-l="Footage lost">${money(c.cost.sunk)}</td><td class="n" data-l="Adds to forecast"><b>${money(c.cost.fresh)}</b></td>
      <td data-l="Status"><span class="chip ${esc(c.status)}">${esc(t(c.status))}</span></td>
      <td>${d.canDecide && c.status === 'pending' ? `<div class="row"><button class="btn sm" data-decide="${c.id}|approved">${esc(t('approve'))}</button><button class="btn sm ghost" data-decide="${c.id}|rejected">${esc(t('reject'))}</button></div>` : ''}</td>
    </tr>`).join('')}</tbody></table></div>`;
}
function previewChange() {
  if (!$('#c-total')) return;
  const dayCost = CH.dayLoss / CH.ratio;
  const fresh = (+$('#c-new').value || 0) * CH.dayLoss + (+$('#c-extra').value || 0), sunk = (+$('#c-wasted').value || 0) * dayCost;
  $('#c-total').textContent = money(fresh + sunk);
  $('#c-split').textContent = `${money(fresh)} new spend + ${money(sunk)} footage lost`;
}

// ---------- crew, pay and call sheet
let CREW = null;
function callSheetText(cs, L) {
  if (!cs) return 'No more shoot days scheduled.';
  const T = k => tr(L, k);
  return `${S.prod.title} · ${T('callSheet')}\n${T('day')} ${cs.n} · ${cs.date}\n${T('callTime')}: 6:30\n${T('location')}: ${cs.location || '-'}\n${T('scenesL')}: ${cs.scenes.map(s => s.no).join(', ')}\n${T('cast')}: ${cs.cast.join(', ')}`;
}
async function viewCrew() {
  const [d, cs] = await Promise.all([api(`/p/${S.pid}/crew`), has('view:schedule') ? api(`/p/${S.pid}/callsheet`).catch(() => null) : null]);
  CREW = d;
  const queued = outbox().filter(m => m.pid === S.pid && m.date === d.date);
  for (const m of queued) { const c = d.crew.find(x => x.id === m.crewId); if (c) { c.present = m.present ? 1 : 0; c.queued = true; } }
  const edit = has('edit:crew'), pres = d.crew.filter(c => c.present), total = pres.reduce((s, c) => s + c.wage, 0);
  const L = S.sheetLang || S.lang, sheet = callSheetText(cs, L);
  return `
  <div class="grid">
    <div>
      <h2>${pres.length}/${d.crew.length} ${esc(t('present'))} · ${money(total)} ${esc(t('payToday'))}</h2>
      <p class="lede">${esc(shortDate(d.date))}${d.dayN ? ` · ${esc(t('day'))} ${d.dayN}` : ''}. Attendance works offline and syncs when the phone reconnects. Payments open in your own UPI app.</p>
      <div class="scroll"><table class="stack"><thead><tr><th>${esc(t('present'))}</th><th>Name</th><th class="n">${esc(t('wage'))}</th><th>Pay</th></tr></thead><tbody>
      ${d.crew.map(c => {
        const upi = c.upi ? `upi://pay?pa=${encodeURIComponent(c.upi)}&pn=${encodeURIComponent(c.name)}&am=${c.wage}&cu=INR&tn=${encodeURIComponent(`${S.prod.title} ${d.date}`)}` : '';
        const msg = `${c.name}: ${S.prod.title} · ${tr(c.lang, 'day')} ${d.dayN || ''} · ${tr(c.lang, 'wage')} ₹${c.wage.toLocaleString('en-IN')}`;
        return `<tr><td data-l="${esc(t('present'))}"><input type="checkbox" class="toggle" id="p-${c.id}" data-pres="${c.id}" ${c.present ? 'checked' : ''} ${edit ? '' : 'disabled'} aria-label="${esc(c.name)}">${c.queued ? ` <span class="note">${esc(t('queued'))}</span>` : ''}</td>
        <td data-l="Name"><b>${esc(c.name)}</b><br><span class="note">${esc(c.dept)} · ${LANGS[c.lang] || ''}</span><br><span class="mono">${esc(c.upi)}</span></td>
        <td class="n" data-l="${esc(t('wage'))}">${money(c.wage)}</td>
        <td data-l="Pay"><div class="row">${c.present && !c.queued ? `${upi ? `<a class="btn sm" href="${esc(upi)}">UPI</a><button class="btn sm ghost" data-copy="${esc(upi)}">${esc(t('copyUpi'))}</button>` : ''}
          <a class="btn sm ghost" href="https://wa.me/?text=${esc(encodeURIComponent(msg))}" target="_blank" rel="noopener">WhatsApp</a>
          ${edit ? `<button class="btn sm ${c.paid ? '' : 'ghost'}" data-paid="${c.id}|${c.paid ? 0 : 1}">${esc(c.paid ? t('paid') : t('markPaid'))}</button>` : ''}` : '<span class="note">—</span>'}</div></td></tr>`;
      }).join('')}
      </tbody></table></div>
      ${edit ? `<details style="margin-top:16px"><summary>Add crew member</summary><form class="f" id="crewform" style="margin-top:12px">
        <label>Name<input id="cr-name" required maxlength="80"></label><label>Department<input id="cr-dept" maxlength="40"></label>
        <label>${esc(t('wage'))} (₹)<input id="cr-wage" type="number" min="1" required></label><label>UPI ID<input id="cr-upi" placeholder="name@bank"></label>
        <label>${esc(t('language'))}<select id="cr-lang">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <button class="btn">${esc(t('save'))}</button></form></details>` : ''}
    </div>
    <div>
      <h3>${esc(t('callSheet'))}</h3>
      <div class="row" style="margin-bottom:8px"><label class="note" for="sheetlang">${esc(t('language'))}</label><select id="sheetlang">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}"${k === L ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
      <pre class="sheet">${esc(sheet)}</pre>
      <div class="row" style="margin-top:10px"><button class="btn sm" data-copy="${esc(sheet)}">Copy</button><a class="btn sm ghost" href="https://wa.me/?text=${esc(encodeURIComponent(sheet))}" target="_blank" rel="noopener">${esc(t('whatsapp'))}</a></div>
    </div>
  </div>`;
}

// ---------- bills and GST
let BILLS = null;
async function viewBills() {
  const d = BILLS = await api(`/p/${S.pid}/bills`);
  const today = new Date().toISOString().slice(0, 10);
  return `
  <h2>${d.bills.length} vendor bills · ${paise(d.totals.total)} with ${paise(d.totals.cgst + d.totals.sgst + d.totals.igst)} GST</h2>
  <p class="lede">Bills from vendors in your GST state (${esc(d.stateCode)}) get CGST + SGST; bills from other states get IGST. Export to Tally as Purchase vouchers; check ledger names with your accountant before importing.</p>
  <div class="row" style="margin-bottom:16px"><a class="btn" href="/api/p/${S.pid}/bills/tally.xml">Export to Tally (XML)</a><a class="btn ghost" href="/api/p/${S.pid}/bills/bills.csv">Download CSV</a></div>
  ${d.canEdit ? `<div class="panel" style="margin-bottom:20px"><form class="f" id="billform">
    <label>Vendor<input id="b-vendor" required maxlength="100"></label>
    <label>Vendor GSTIN<input id="b-gstin" maxlength="15" placeholder="optional"></label>
    <label>Vendor state code<input id="b-state" maxlength="2" inputmode="numeric" placeholder="e.g. 36"></label>
    <label>Invoice number<input id="b-inv" required maxlength="40"></label>
    <label>Invoice date<input id="b-date" type="date" value="${today}" required></label>
    <label>Ledger<input id="b-ledger" list="ledgers" required value="Equipment Hire"><datalist id="ledgers"><option>Equipment Hire</option><option>Camera Rental</option><option>Catering</option><option>Transport</option><option>Location Fees</option><option>Art and Sets</option><option>Costumes</option><option>Hotel and Stay</option></datalist></label>
    <label>Taxable amount (₹)<input id="b-taxable" type="number" min="1" step="0.01" required></label>
    <label>GST rate<select id="b-rate">${d.rates.map(r => `<option value="${r}"${r === 18 ? ' selected' : ''}>${r}%</option>`).join('')}</select></label>
    <div class="wide row" style="justify-content:space-between"><span class="note" id="b-preview"></span><button class="btn red">${esc(t('save'))}</button></div>
  </form></div>` : ''}
  <div class="scroll"><table class="stack"><thead><tr><th>Date</th><th>Vendor</th><th>Ledger</th><th class="n">Taxable</th><th class="n">CGST</th><th class="n">SGST</th><th class="n">IGST</th><th class="n">Total</th></tr></thead><tbody>
  ${d.bills.map(b => `<tr><td data-l="Date">${esc(b.date)}</td><td data-l="Vendor"><b>${esc(b.vendor)}</b><br><span class="note">${esc(b.invoice_no)}${b.vendor_gstin ? ' · ' + esc(b.vendor_gstin) : ''} · state ${esc(b.vendor_state)}</span></td><td data-l="Ledger">${esc(b.ledger)}</td>
    <td class="n" data-l="Taxable">${paise(b.taxable_paise)}</td><td class="n" data-l="CGST">${paise(b.cgst_paise)}</td><td class="n" data-l="SGST">${paise(b.sgst_paise)}</td><td class="n" data-l="IGST">${paise(b.igst_paise)}</td><td class="n" data-l="Total"><b>${paise(b.total_paise)}</b></td></tr>`).join('')}
  </tbody></table></div>`;
}
function previewBill() {
  const el = $('#b-preview'); if (!el) return;
  const gst = $('#b-gstin').value.trim().toUpperCase(), st = /^\d{2}/.test(gst) ? gst.slice(0, 2) : $('#b-state').value.padStart(2, '0');
  const tax = Math.round((+$('#b-taxable').value || 0) * 100), rate = +$('#b-rate').value, g = Math.round(tax * rate / 100);
  if (!tax) { el.textContent = ''; return; }
  el.textContent = st === BILLS.stateCode ? `CGST ${paise(Math.floor(g / 2))} + SGST ${paise(g - Math.floor(g / 2))} · total ${paise(tax + g)}` : `IGST ${paise(g)} · total ${paise(tax + g)}`;
}

// ---------- script breakdown
const EXAMPLE = 'సీన్ 44. బయట - రైల్వే స్టేషన్ - రాత్రి\nవర్షం పడుతోంది. రాజు (30) ప్లాట్‌ఫారమ్ మీద ఒంటరిగా నిలబడి ఉన్నాడు. చేతిలో పాత సూట్‌కేస్.\nమీరా (28) గొడుగుతో పరుగెత్తుకుంటూ వస్తుంది.\nమీరా: నువ్వు వెళ్ళిపోతున్నావా?\nరాజు: ఈ ఊరిలో నాకు ఇంకేమీ మిగల్లేదు.\nరైలు కూత వినిపిస్తుంది. రాజు రైలు ఎక్కుతాడు.';
async function viewScript() {
  const scenes = await api(`/p/${S.pid}/scenes`), r = S.ai;
  return `
  <div class="grid">
    <div>
      <h2>Break down a scene in any Indian language</h2>
      <p class="lede">Paste Telugu, Tamil, Hindi, Kannada, Malayalam or English. Claude returns the heading, cast, props, costumes and special needs, with an English summary for the whole unit.</p>
      <label class="note" for="scene">${esc(t('pasteScene'))}</label>
      <textarea id="scene">${esc(store.get('scene', EXAMPLE))}</textarea>
      <div class="row" style="margin-top:10px"><button class="btn red" id="runai" ${S.aiBusy ? 'disabled' : ''}>${esc(S.aiBusy ? 'Reading the scene…' : t('runAI'))}</button></div>
      <h3 style="margin-top:24px">${esc(t('scenesL'))} (${scenes.length})</h3>
      <div class="scroll"><table><tbody>${scenes.slice(0, 12).map(s => `<tr><td class="n">${s.no}</td><td>${esc(s.heading)}</td><td class="note">${s.day ? esc(t('day')) + ' ' + s.day : 'unscheduled'}${s.shot ? ' · shot' : ''}</td></tr>`).join('')}</tbody></table></div>
    </div>
    <div>
      <h3>Breakdown</h3>
      ${r ? r.map(s => `<div class="card" style="margin-bottom:12px">
        <b>${esc(s.heading)}</b><span class="note">${esc(s.intExt)} · ${esc(s.dayNight)} · ${esc(s.language)} · ${esc(s.pages)}</span>
        ${[['Cast', 'characters'], ['Props', 'props'], ['Costumes', 'costumes'], ['Special', 'special']].map(([lab, k]) => (s[k] && s[k].length) ? `<div><span class="note">${lab}</span><br>${esc([].concat(s[k]).join(', '))}</div>` : '').join('')}
        <div><span class="note">Summary</span><br>${esc(s.summary_en)}</div></div>`).join('') + `<button class="btn" id="addsc">${esc(t('addScenes'))}</button>` : '<p class="empty">The breakdown appears here.</p>'}
    </div>
  </div>`;
}

// ---------- team
async function viewTeam() {
  const [d, c, log] = await Promise.all([api(`/p/${S.pid}/team`), api(`/p/${S.pid}/contracts`), api(`/p/${S.pid}/audit`)]);
  return `
  <div class="two">
    <section>
      <h2>${d.members.length} people on this production</h2>
      <ul class="plist">${d.members.map(m => `<li class="card" style="grid-template-columns:minmax(0,1fr) auto;align-items:center"><span><b>${esc(m.name)}</b><br><span class="note">${esc(m.email)}</span></span><span class="row"><span class="chip pending">${esc(t('r_' + m.role))}</span>${m.id !== S.user.id ? `<button class="btn sm ghost" data-remove="${m.id}">Remove</button>` : ''}</span></li>`).join('')}</ul>
      <h3 style="margin-top:24px">Recent activity</h3>
      <div class="scroll"><table><tbody>${log.slice(0, 15).map(a => `<tr><td class="note">${esc(a.at)}</td><td>${esc(a.name || '')}</td><td>${esc(a.action)}</td><td class="note">${esc(a.detail)}</td></tr>`).join('')}</tbody></table></div>
    </section>
    <section class="panel">
      <h3>Invite someone</h3>
      <form class="stackform" id="inviteform">
        <label>Role<select id="i-role">${['director', 'writer', 'lineprod', 'manager', 'financier', 'producer'].map(r => `<option value="${r}">${esc(t('r_' + r))}</option>`).join('')}</select></label>
        <label id="i-actor-wrap" hidden>Actor they represent<select id="i-actor">${c.actors.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></label>
        <button class="btn red">Create invite code</button>
      </form>
      ${S.invite ? `<p>Share this code. It works once.</p><p class="code">${esc(S.invite.code)}</p><p class="note">${esc(t('r_' + S.invite.role))}</p>` : ''}
      ${d.invites.length ? `<h3 style="margin-top:16px">Unused codes</h3><ul>${d.invites.map(i => `<li><span class="code" style="font-size:16px">${esc(i.code)}</span> · ${esc(t('r_' + i.role))}</li>`).join('')}</ul>` : ''}
    </section>
  </div>`;
}

const VIEWS = { overview: viewOverview, schedule: viewSchedule, contracts: viewContracts, changes: viewChanges, crew: viewCrew, bills: viewBills, script: viewScript, team: viewTeam };
const AFTER = { changes: previewChange, bills: previewBill };

// ---------- events
const val = id => $(id).value;
async function act(fn, ok) {
  try { await fn(); if (ok) toast(ok); } catch (e) { toast(e.message); }
}

document.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'authform') {
    const up = f.dataset.mode === 'up';
    try {
      const { user } = await api(up ? '/auth/register' : '/auth/login', { method: 'POST', body: { email: val('#a-email'), password: val('#a-pass'), name: up ? val('#a-name') : undefined, lang: S.lang } });
      S.user = user; store.set('user', user); S.lang = user.lang || S.lang; await start();
    } catch (err) { $('#a-err').textContent = err.message; }
  } else if (f.id === 'prodform') {
    try {
      const ind = val('#n-ind'), l2 = val('#n-lang2');
      const { id } = await api('/productions', { method: 'POST', body: { title: val('#n-title'), industry: ind, langs: [ind, l2].filter((x, i, a) => x && a.indexOf(x) === i), startDate: val('#n-start'), plannedDays: +val('#n-days'), dayCost: +val('#n-daycost'), fixedCost: +val('#n-fixed'), gstin: val('#n-gstin') } });
      await openProduction(id);
    } catch (err) { $('#n-err').textContent = err.message; }
  } else if (f.id === 'joinform') {
    await act(async () => { const { id } = await api('/join', { method: 'POST', body: { code: val('#j-code') } }); await openProduction(id); });
  } else if (f.id === 'wrapform') {
    await act(async () => { await api(`/p/${S.pid}/days/${OV.nextWrap.n}/actual`, { method: 'PUT', body: { cost: +val('#w-cost') } }); await reload(); }, t('save'));
  } else if (f.id === 'cform') {
    await act(async () => { await api(`/p/${S.pid}/changes`, { method: 'POST', body: { title: val('#c-title'), scenes: val('#c-scenes'), note: val('#c-note'), wastedDays: +val('#c-wasted'), newDays: +val('#c-new'), extra: +val('#c-extra') } }); await reload(); }, t('pending'));
  } else if (f.id === 'crewform') {
    await act(async () => { await api(`/p/${S.pid}/crew`, { method: 'POST', body: { name: val('#cr-name'), dept: val('#cr-dept'), wage: +val('#cr-wage'), upi: val('#cr-upi'), lang: val('#cr-lang') } }); await reload(); }, t('save'));
  } else if (f.id === 'billform') {
    await act(async () => { await api(`/p/${S.pid}/bills`, { method: 'POST', body: { vendor: val('#b-vendor'), vendorGstin: val('#b-gstin'), vendorState: val('#b-state'), invoiceNo: val('#b-inv'), date: val('#b-date'), ledger: val('#b-ledger'), taxable: +val('#b-taxable'), rate: +val('#b-rate') } }); await reload(); }, t('save'));
  } else if (f.id === 'inviteform') {
    await act(async () => { S.invite = await api(`/p/${S.pid}/invites`, { method: 'POST', body: { role: val('#i-role'), actorId: val('#i-role') === 'manager' ? +val('#i-actor') : undefined } }); await reload(); });
  }
});

document.addEventListener('input', e => {
  if (e.target.closest('#cform')) previewChange();
  if (e.target.closest('#billform')) previewBill();
  if (e.target.id === 'i-role') $('#i-actor-wrap').hidden = e.target.value !== 'manager';
});

document.addEventListener('change', async e => {
  const el = e.target;
  if (el.id === 'lang') {
    S.lang = el.value; store.set('lang', S.lang); S.sheetLang = null;
    if (S.user) api('/auth/me', { method: 'PATCH', body: { lang: S.lang } }).catch(() => {});
    if (!S.user) renderAuth(); else if (S.pid) reload(); else renderPicker();
  } else if (el.id === 'sheetlang') { S.sheetLang = el.value; reload(); }
  else if (el.id === 'i-role') { $('#i-actor-wrap').hidden = el.value !== 'manager'; }
  else if (el.dataset.use) {
    const [id, k] = el.dataset.use.split('|');
    await act(async () => { await api(`/p/${S.pid}/actors/${id}/usage`, { method: 'PATCH', body: { [k]: +el.value } }); await reload(); });
  } else if (el.dataset.pres) {
    queueMark({ pid: S.pid, crewId: +el.dataset.pres, date: CREW.date, present: el.checked, markedAt: new Date().toISOString() });
    await flushOutbox(); if (outbox().length) reload();
  }
});

document.addEventListener('click', async e => {
  const el = e.target.closest('button'); if (!el) return;
  const d = el.dataset;
  if (d.mode) return renderAuth(d.mode);
  if (d.tab) return show(d.tab);
  if (d.open) return act(() => openProduction(+d.open));
  if (el.id === 'toPicker') { store.set('pid', null); return renderPicker(); }
  if (el.id === 'signout') { await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {}); S.user = null; store.set('pid', null); store.set('user', null); return renderAuth(); }
  if (d.away) { const [id, date, away] = d.away.split('|'); return act(async () => { await api(`/p/${S.pid}/actors/${id}/away/${date}`, { method: 'PUT', body: { away: away === '1' } }); await reload(); }); }
  if (d.swap) { const [a, b] = d.swap.split('|').map(Number); return act(async () => { await api(`/p/${S.pid}/days/swap`, { method: 'POST', body: { a, b } }); await reload(); }, `${t('day')} ${a} ↔ ${t('day')} ${b}`); }
  if (d.decide) { const [id, status] = d.decide.split('|'); return act(async () => { await api(`/p/${S.pid}/changes/${id}/decision`, { method: 'POST', body: { status } }); await reload(); }, t(status)); }
  if (d.paid) { const [id, v] = d.paid.split('|'); return act(async () => { await api(`/p/${S.pid}/attendance/paid`, { method: 'POST', body: { crewId: +id, date: CREW.date, paid: v === '1' } }); await reload(); }); }
  if (d.remove) return act(async () => { await api(`/p/${S.pid}/members/${d.remove}`, { method: 'DELETE', body: {} }); await reload(); });
  if (d.copy) { try { await navigator.clipboard.writeText(d.copy); toast('Copied'); } catch { toast('Copy blocked by the browser'); } return; }
  if (el.id === 'runai') {
    const text = val('#scene').trim(); if (!text) return;
    store.set('scene', text); S.aiBusy = true; await reload();
    try { S.ai = (await api(`/p/${S.pid}/script/breakdown`, { method: 'POST', body: { text } })).scenes; } catch (err) { toast(err.message); }
    S.aiBusy = false; return reload();
  }
  if (el.id === 'addsc' && S.ai) return act(async () => { const r = await api(`/p/${S.pid}/scenes`, { method: 'POST', body: { scenes: S.ai } }); S.ai = null; await reload(); toast(`+${r.added} ${t('scenesL')}`); });
});

document.addEventListener('keydown', e => {
  if (!e.target.matches?.('.tabs button') || !['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
  const list = TABS.filter(([, c]) => has(c)).map(([k]) => k), i = list.indexOf(S.tab);
  show(list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length]).then(() => $('#tab-' + S.tab)?.focus());
});

// ---------- boot
async function start() {
  const pid = store.get('pid', null);
  if (pid) { try { return await openProduction(pid); } catch { store.set('pid', null); } }
  await renderPicker();
}

(async () => {
  S.lang = store.get('lang', 'en');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try { S.demo = (await api('/health')).demo; } catch { /* offline */ }
  try { S.user = (await api('/auth/me')).user; store.set('user', S.user); }
  catch (e) { S.user = e.status === 0 ? store.get('user', null) : null; }
  updateOffline();
  if (!S.user) return renderAuth();
  if (!store.get('lang', null)) S.lang = S.user.lang;
  await start();
  flushOutbox();
})();

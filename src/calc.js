// Pure cost and schedule logic. No database access, so it is easy to test.

/**
 * @param {object} p production row
 * @param {Array<{n:number,date:string,actual_cost:number|null}>} days
 * @param {Array<{status:string,new_days:number,extra:number}>} changes
 */
export function overview(p, days, changes) {
  const shot = days.filter(d => d.actual_cost != null);
  const spentDays = shot.reduce((s, d) => s + d.actual_cost, 0);
  const ratio = shot.length ? spentDays / (shot.length * p.day_cost) : 1;
  const approved = changes.filter(c => c.status === 'approved');
  const approvedNewDays = approved.reduce((s, c) => s + c.new_days, 0);
  const approvedCost = approved.reduce((s, c) => s + changeCost(c, p.day_cost, ratio).fresh, 0);
  const remaining = days.length - shot.length;
  const budget = p.fixed_cost + p.planned_days * p.day_cost;
  const spent = p.fixed_cost + spentDays;
  const forecast = Math.round(spent + remaining * p.day_cost * ratio + approvedCost);
  return {
    budget, spent, forecast, gap: forecast - budget, ratio,
    shotDays: shot.length, totalDays: days.length, remaining,
    approvedNewDays, dayLoss: Math.round(p.day_cost * ratio),
    burn: shot.map(d => ({ n: d.n, actual: d.actual_cost })),
  };
}

/** sunk = footage already paid for and now thrown away; fresh = new money the change adds. */
export function changeCost(c, dayCost, ratio) {
  const sunk = Math.round((c.wasted_days || 0) * dayCost);
  const fresh = Math.round((c.new_days || 0) * dayCost * ratio + (c.extra || 0));
  return { sunk, fresh, total: sunk + fresh };
}

/** Daily overage from perks beyond contract, and the total so far over days worked. */
export function overage(actor, daysWorked, perHead, vanDay) {
  const perDay = Math.max(0, actor.used_entourage - actor.terms_entourage) * perHead
    + Math.max(0, actor.used_vans - actor.terms_vans) * vanDay;
  return { perDay, worked: daysWorked, sofar: perDay * daysWorked };
}

/**
 * Days still to shoot where a cast member is away.
 * @param {Array<{id:number,n:number,date:string,actual_cost:number|null,cast:number[]}>} days
 * @param {Map<number,Set<string>>} away actorId -> set of ISO dates
 */
export function clashes(days, away, today) {
  const out = [];
  for (const d of days) {
    if (d.actual_cost != null || d.date < today) continue;
    for (const a of d.cast) if (away.get(a)?.has(d.date)) out.push({ dayId: d.id, n: d.n, date: d.date, actorId: a });
  }
  return out;
}

const freeOn = (day, date, away) => day.cast.every(a => !away.get(a)?.has(date));

/** A day to swap with so that everyone on both days is free; looks at the next `window` unshot days. */
export function findSwap(day, days, away, today, window = 12) {
  const upcoming = days.filter(d => d.actual_cost == null && d.date > today).slice(0, window);
  return upcoming.find(o => o.id !== day.id && freeOn(day, o.date, away) && freeOn(o, day.date, away)) || null;
}

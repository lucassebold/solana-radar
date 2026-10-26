'use strict';

// Helius credit budgeting. Pure functions (no I/O) so they are easy to test.
// 1 webhook event = 1 credit, so the number of events/day we can afford is (credits left) / (days left).

const DAY = 24 * 3600 * 1000;

// Start of the current billing cycle (UTC). billingDay is 1..28.
function cycleStart(now, billingDay) {
  const d = new Date(now);
  let month = d.getUTCMonth();
  if (d.getUTCDate() < billingDay) month -= 1;
  return Date.UTC(d.getUTCFullYear(), month, billingDay);
}

function cycleEnd(now, billingDay) {
  const s = new Date(cycleStart(now, billingDay));
  return Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, billingDay);
}

function dayString(ts) { return new Date(ts).toISOString().slice(0, 10); }

// Events/day we can afford for the rest of the cycle.
//  planCredits: credits in the plan (1,000,000 on Helius free); budgetFraction: share we allow ourselves (0.9);
//  used: credits already spent in this cycle. Never more than 1.5x an even daily share (no binge early in the cycle).
function allowancePerDay(o) {
  const budget = o.planCredits * o.budgetFraction;
  const remaining = Math.max(0, budget - o.used);
  const cycleDays = (cycleEnd(o.now, o.billingDay) - cycleStart(o.now, o.billingDay)) / DAY;
  const daysLeft = Math.max(1 / 24, (cycleEnd(o.now, o.billingDay) - o.now) / DAY);
  return Math.min(remaining / daysLeft, (budget / cycleDays) * 1.5);
}

// Ratio between measured webhook events and what the leaderboard's trade counts predict (events are ~always more:
// transfers, tips, failed-then-retried swaps, trades the source does not count). Falls back to `def` without data.
function calibration(wallets, measured, leaderboardPerDay, def) {
  let m = 0, e = 0;
  wallets.forEach(w => {
    if (measured.has(w) && leaderboardPerDay.get(w) > 0) { m += measured.get(w); e += leaderboardPerDay.get(w); }
  });
  if (e < 5 || m <= 0) return def; // not enough evidence yet
  return Math.min(100, Math.max(1, m / e));
}

// Picks the wallets to watch. `candidates` are in priority order (best first).
// rateOf(candidate) -> expected events/day. A wallet is skipped when it alone would eat more than `maxShare` of the
// allowance (too noisy) or when it does not fit in the remaining room. At least `minTracked` are always kept.
function selectWallets(o) {
  const selected = [];
  const skippedNoisy = [];
  let total = 0;
  const room = o.allowance * o.fill;
  for (const c of o.candidates) {
    if (selected.length >= o.maxCount) break;
    const r = o.rateOf(c);
    if (r > o.allowance * o.maxShare) { skippedNoisy.push(c); continue; }
    if (total + r > room) continue; // does not fit; a smaller one further down the list still might
    selected.push(c);
    total += r;
  }
  if (selected.length < o.minTracked) {
    const chosen = new Set(selected);
    o.candidates
      .filter(c => !chosen.has(c))
      .sort((a, b) => o.rateOf(a) - o.rateOf(b))
      .slice(0, o.minTracked - selected.length)
      .forEach(c => { selected.push(c); total += o.rateOf(c); });
    selected.sort((a, b) => o.candidates.indexOf(a) - o.candidates.indexOf(b));
  }
  return { selected, totalPerDay: total, skippedNoisy };
}

// Should the webhook be edited (each edit costs 100 credits)? Only for a real change.
function shouldUpdateWebhook(current, next, over) {
  if (!current) return true;
  const cur = new Set(current);
  let diff = 0;
  next.forEach(w => { if (!cur.has(w)) diff++; });
  const nxt = new Set(next);
  current.forEach(w => { if (!nxt.has(w)) diff++; });
  if (over && diff > 0) return true; // over budget: act now
  return diff >= Math.max(4, Math.ceil(current.length * 0.2));
}

module.exports = { cycleStart, cycleEnd, dayString, allowancePerDay, calibration, selectWallets, shouldUpdateWebhook, DAY };

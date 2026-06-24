// Pure classification: (raw numbers + thresholds) -> labels. Imported by the Node
// generator (build.js) AND the browser (index.html). No node:* / DOM / globals.

export const DEFAULT_THRESHOLDS = {
  returnRate: 5.0, returnRateWarn: 4.0, refundSpike: 25,
  ratingBad: 3.5, ratingWarn: 4.0, ratingDrop: -0.2, ratingRise: 0.1
};

export function storeHealth(s, t) {
  if (s.returnRate >= t.returnRate || (s.reviewRating != null && s.reviewRating < t.ratingBad)) return "bad";
  if (s.returnRate >= t.returnRateWarn || s.reviewDelta <= t.ratingDrop || s.refundSpike > t.refundSpike) return "warn";
  return "good";
}

export function asinFlags(a, t) {
  const f = [];
  if (a.returnRate >= t.returnRate) f.push("return");
  if (a.refundSpike > t.refundSpike) f.push("refund");
  if (a.reviewDelta != null && a.reviewDelta <= t.ratingDrop) f.push("ratingDrop");
  return f;
}
export const isFlagged = (a, t) => asinFlags(a, t).length > 0;

export function rateClass(r, t) {
  if (r >= t.returnRate) return "bad";
  if (r >= t.returnRateWarn) return "warn";
  return "good";
}
export function ratingClass(r, t) {
  if (r == null) return "good";          // "no rating", not zero (§5.1)
  if (r < t.ratingBad) return "bad";
  if (r < t.ratingWarn) return "warn";
  return "good";
}
export const flaggedCount = (asins, t) => asins.reduce((n, a) => n + (isFlagged(a, t) ? 1 : 0), 0);

// Portfolio rating-trajectory verdict (spec §6). Pure: (aggregates + thresholds) -> label.
//   slipping  : trajectory at/below ratingDrop, OR >= 2 brands individually declining
//   improving : trajectory at/above ratingRise
//   stable    : otherwise (incl. ratingDelta === null)
export function portfolioVerdict(p, t) {
  if ((p.ratingDelta != null && p.ratingDelta <= t.ratingDrop) || p.decliningBrands >= 2) return "slipping";
  if (p.ratingDelta != null && p.ratingDelta >= t.ratingRise) return "improving";
  return "stable";
}

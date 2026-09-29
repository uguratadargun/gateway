const DAY_MS = 86_400_000;

/** "30d", "6 months", "2026-05-01" → a moment; null when it is not a time. A bare date is the start of that day where the command runs. */
export function parseSince(v: unknown, now = Date.now()): number | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim().toLowerCase();
  const rel = s.match(/^(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2][0];
    const days = unit === "d" ? n : unit === "w" ? n * 7 : unit === "m" ? n * 30 : n * 365;
    return now - days * DAY_MS;
  }
  const day = localDay(s);
  if (day != null) return day;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * The moment `--as-of` asks about. A bare date means that whole day — "what
 * did we believe on 2026-05-01" includes a decision recorded that afternoon —
 * so it is the day's last millisecond where the command runs, not its first.
 * Anything else reads as `parseSince` reads it.
 */
export function parseAsOf(v: unknown, now = Date.now()): number | null {
  if (typeof v === "string") {
    const day = localDay(v.trim());
    if (day != null) return day + DAY_MS - 1;
  }
  return parseSince(v, now);
}

/**
 * Local midnight of a bare `YYYY-MM-DD`, or null. `Date.parse` reads a bare
 * date as UTC midnight, which in Istanbul is three in the morning: a
 * decision recorded at one o'clock would fall on the wrong side of the day.
 */
function localDay(s: string): number | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(t) ? t : null;
}

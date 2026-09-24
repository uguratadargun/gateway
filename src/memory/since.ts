/** "30d", "6 months", "2026-05-01" → a moment; null when it is not a time. */
export function parseSince(v: unknown, now = Date.now()): number | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim().toLowerCase();
  const rel = s.match(/^(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2][0];
    const days = unit === "d" ? n : unit === "w" ? n * 7 : unit === "m" ? n * 30 : n * 365;
    return now - days * 86_400_000;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

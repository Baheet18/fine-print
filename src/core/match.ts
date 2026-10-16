// Fine Print outcome-matching backstop for same-event ladders (e.g. Fed "Hike >25bps" vs "50+ bps increase"),
// used when Agg's matcher returns no counterpart. Deterministic: direction + comparator + number.
export interface OutcomeKey { dir: string; op: "eq" | "gte" | "lte"; n: number | null }

const DIRS: [string, RegExp][] = [
  ["up", /\b(hike|hikes|increase|increases|raise|raises|rise|up|above|over|higher)\b/i],
  ["down", /\b(cut|cuts|decrease|decreases|lower|lowers|reduce|down|below|under)\b/i],
  ["hold", /\b(maintain|maintains|no change|unchanged|hold|holds|pause)\b/i],
];

export function parseOutcome(label: string): OutcomeKey | null {
  const s = label.replace(/\s+/g, " ").trim();
  const dir = DIRS.find(([, re]) => re.test(s))?.[0] ?? "";
  if (dir === "hold") return { dir, op: "eq", n: 0 };
  const m = s.match(/(>=|≥|>|<=|≤|<|at least|more than|greater than|less than|at most|or more|or less|\+)?\s*\$?(\d+(?:[.,]\d+)?)\s*(\+|or more|or higher|or above|or less|or lower)?/i);
  if (!m) return dir ? { dir, op: "eq", n: null } : null;
  const n = Number(m[2]!.replace(",", ""));
  const pre = (m[1] ?? "").toLowerCase(), post = (m[3] ?? "").toLowerCase();
  let op: OutcomeKey["op"] = "eq"; let strict = false;
  if (/^(>=|≥|at least)$/.test(pre) || /^(\+|or more|or higher|or above)$/.test(post)) op = "gte";
  else if (/^(>|more than|greater than)$/.test(pre)) { op = "gte"; strict = true; }
  else if (/^(<=|≤|at most)$/.test(pre) || /^(or less|or lower)$/.test(post)) op = "lte";
  else if (pre === "<" || pre === "less than") { op = "lte"; strict = true; }
  return { dir, op, n: strict ? -n : n }; // strict bounds resolved against the ladder step in normalize()
}

/** Ladder step = smallest positive gap between the numbers used across all sibling labels. */
export function ladderStep(labels: string[]): number | null {
  const ns = [...new Set(labels.map((l) => parseOutcome(l)?.n).filter((x): x is number => x !== null && x !== undefined).map(Math.abs))].sort((a, b) => a - b);
  let step: number | null = null;
  for (let i = 1; i < ns.length; i++) { const g = ns[i]! - ns[i - 1]!; if (g > 0 && (step === null || g < step)) step = g; }
  if (step === null && ns.length === 1 && ns[0]! > 0) step = ns[0]!;
  return step;
}

export function normalize(k: OutcomeKey | null, step: number | null): string | null {
  if (!k || k.n === null) return null;
  let { n, op } = k;
  if (n < 0) { if (step === null) return null; n = -n; n = op === "gte" ? n + step : n - step; } // ">25" on a 25 ladder == ">=50"
  return `${k.dir}|${op}|${n}`;
}

/** Find the sibling whose normalized outcome equals the anchor's. Returns its index or -1. */
export function matchOutcome(anchorLabel: string, anchorSiblings: string[], candidates: string[]): number {
  const stepA = ladderStep([anchorLabel, ...anchorSiblings]);
  const stepB = ladderStep(candidates);
  const key = normalize(parseOutcome(anchorLabel), stepA ?? stepB);
  if (!key) return -1;
  const hits = candidates.map((c, i) => (normalize(parseOutcome(c), stepB ?? stepA) === key ? i : -1)).filter((i) => i >= 0);
  return hits.length === 1 ? hits[0]! : -1; // ambiguous = no match
}

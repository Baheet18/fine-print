// Fine Print resolution-risk checklist. Deterministic; every flag quotes the sentence that triggered it.
import type { Flag, VenueMarket } from "./types.js";

export const WEIGHT = { high: 25, medium: 12, low: 5, info: 0 } as const;
const TZ = /\b(ET|EST|EDT|EET|EEST|CET|CEST|BST|UTC|GMT|PT|PST|PDT|CT|CST|CDT|JST|IST)\b|\b(eastern|central|pacific|european|greenwich|universal|local) (european )?time\b|coordinated universal/i;

export function sentences(t: string): string[] {
  return t.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z"“(])/).map((s) => s.trim()).filter((s) => s.length > 3);
}
const find = (ss: string[], re: RegExp) => ss.find((s) => re.test(s)) ?? null;
export const clip = (s: string | null, n = 280) => (s && s.length > n ? s.slice(0, n - 3) + "..." : s);

export function checkVenue(m: Pick<VenueMarket, "venue" | "rules" | "resolutionSource" | "closeTime">): Flag[] {
  const f: Flag[] = []; const ss = sentences(m.rules); const v = m.venue;
  const add = (check: string, severity: Flag["severity"], quote: string | null, explanation: string) =>
    f.push({ check, severity, venue: v, quote: clip(quote), explanation });
  if (ss.length === 0) { add("rules_present", "high", null, "No rules text is published for this market, so nothing tells you how it resolves."); return f; }

  // 1. Named, verifiable source
  const consensus = find(ss, /consensus of credible report|credible report|widely reported|major (news|media) outlets?|reputable (news|media|source)/i);
  const named = /https?:\/\/|\.gov\b|\.com\b|\.org\b|official (website|data|results|statement)|according to (the )?[A-Z]|as reported by|published by|source agenc|\b(FOMC|BLS|AP|Associated Press|NOAA|NWS|CoinGecko|Binance|Chainlink|ESPN|NBA|NFL|FIFA|UEFA|Bureau|Benchmarks|BRTI|NHC|National Hurricane Center|Premier League|EPL)\b/i;
  const fallback = consensus && /\b(primary|however|also|may|additionally|in addition)\b/i.test(consensus) && named.test(m.rules.replace(consensus, ""))
    || (consensus && /official (information|data|statements?|results?) from/i.test(consensus));
  if (consensus && fallback) add("verifiable_source", "medium", consensus, "An official source is named, but 'a consensus of credible reporting' is allowed as a fallback. If reports and the official record disagree, the outcome is a judgment call.");
  else if (consensus) add("verifiable_source", "high", consensus, "Resolves on 'credible reporting' instead of one checkable source. What counts as credible is a judgment call, and that's where disputes start.");
  else if (!m.resolutionSource && !named.test(m.rules)) add("verifiable_source", "medium", null, "No named resolution source, so you can't check the outcome yourself.");
  const resolverJudg = find(ss, /sole discretion|at (its|the) discretion|reserves the right|determined by (the )?(market )?(creator|operator|team)|in (its|our) judgment/i);
  if (resolverJudg) add("resolver_discretion", "high", resolverJudg, "The venue can settle by its own judgment rather than a fixed rule.");

  // 2. Deadline and time zone
  const dl = find(ss, /\b(by|before|on or before|prior to|until|no later than|deadline|end date)\b[^.]{0,60}\b(20\d\d|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}:\d{2})\b/i);
  if (!TZ.test(m.rules)) add("deadline_timezone", m.closeTime ? "low" : "medium", dl, "The rules give no time zone for the deadline. An event close to midnight could count on either side.");

  // 3. Ambiguous wording
  const formally = find(ss, /\b(formally|officially|legally|in accordance with the (laws|rules|procedures))\b/i);
  if (formally) add("ambiguous_wording", "medium", formally, "Hinges on when something 'formally' or 'officially' happens. If it's contested or still in progress at the deadline, people can disagree on whether it has happened.");
  const announce = find(ss, /\b(announce[sd]?|announcement|confirm(s|ed)?|declare[sd]?)\b/i);
  if (announce && !formally && !/FOMC|statement/i.test(announce)) add("ambiguous_wording", "low", announce, "Resolves on an announcement. Check what counts if it's leaked, walked back or delayed.");
  const fuzzy = find(ss, /\b(approximately|substantially|significant(ly)?|roughly|materially|in effect|de facto|effectively)\b/i);
  if (fuzzy) add("ambiguous_wording", "medium", fuzzy, "Approximate wording sits next to the condition, which leaves room to argue.");
  const intent = find(ss, /\b(intends? to|plans? to|expected to|likely)\b/i);
  if (intent) add("ambiguous_wording", "low", intent, "Mentions intent or expectation; make sure only the actual event counts.");

  // 4. Edge cases
  const edge = find(ss, /\b(cancel+ed|cancel+ation|postpone|delay|reschedul|not occur|no (statement|data|result)|tie\b|void|refund|50-50|suspen|abandon|rounded|violation|regardless|even if|does not (count|qualify)|do not qualify|will not (count|qualify))/i);
  if (edge) add("edge_cases", "info", edge, "Edge cases are spelled out. Good, but read them: they decide rare outcomes.");
  else add("edge_cases", "medium", null, "The rules don't say what happens if the event is delayed, cancelled or only partly happens.");
  const partial = find(ss, /\b(temporary|suspension|leave of absence|acting|interim|announcements? of a future)\b/i);
  if (partial) add("edge_cases", "low", partial, "Partial outcomes are excluded, so a dramatic headline can still resolve No.");
  const revision = find(ss, /\b(revis(ed|ion)|preliminary|initial (release|estimate)|subsequent)\b/i);
  if (revision) add("edge_cases", "low", revision, "Data can be revised. Check whether the first print or the revised number counts.");

  // 5. Dispute process
  if (v === "polymarket") add("dispute_process", (consensus && !fallback) || resolverJudg ? "medium" : "info", null, "Polymarket disputes go to an UMA token-holder vote. That works when the source is clear, less so when it rests on 'credible reporting'.");
  else if (v === "kalshi") add("dispute_process", "info", null, "Kalshi is CFTC-regulated and settles under its rulebook; disputes go to Kalshi, not a token vote.");
  else add("dispute_process", "low", null, `Check how ${v} settles disputes; it is not documented here.`);
  const mutable = find(ss, /\b(may (be )?(update|amend|clarif)|clarification|subject to change)\b/i);
  if (mutable) add("dispute_process", "medium", mutable, "Rules can be clarified after you trade.");
  return f;
}

const DIFF_SEV: Record<string, Flag["severity"]> = { resolution_source: "medium", threshold: "high", scope: "medium", end_date: "medium", start_date: "low", resolution_timing: "low", edge_cases: "medium", wording: "low" };
const DIFF_EXPL: Record<string, string> = {
  resolution_source: "Venues name different resolution sources, so the same event could be graded differently.",
  threshold: "Venues use different thresholds. These may not be the same bet.",
  scope: "Venues define the event's scope differently.",
  end_date: "Venues have different deadlines.",
  start_date: "Venues count from different start dates.",
  resolution_timing: "Venues settle at different times, so capital unlocks at different times.",
  edge_cases: "Venues handle an edge case differently; in that case one could pay and the other not.",
  wording: "Wording differs in a way that could matter at the margin.",
};
export function crossVenue(ms: VenueMarket[], diff: { type: string; title: string; venues: string[] }[] | null): Flag[] {
  const f: Flag[] = [];
  if (ms.length < 2) return f;
  if (diff) for (const d of diff) f.push({ check: "settlement_mismatch", severity: DIFF_SEV[d.type] ?? "low", venue: "cross-venue", quote: null,
    explanation: `${d.title}: ${DIFF_EXPL[d.type] ?? "Venues settle this differently."}${d.venues.length ? ` (spelled out on ${d.venues.join(", ")})` : ""}` });
  // own checks independent of Agg's diff
  const times = ms.map((m) => m.closeTime ? Date.parse(m.closeTime) : NaN).filter(Number.isFinite);
  if (times.length >= 2) { const hrs = (Math.max(...times) - Math.min(...times)) / 36e5;
    if (hrs > 24) f.push({ check: "settlement_mismatch", severity: hrs > 168 ? "high" : "medium", venue: "cross-venue", quote: null, explanation: `Close times differ by ${(hrs / 24).toFixed(1)} days across venues.` }); }
  const cancel = ms.map((m) => find(sentences(m.rules), /cancel|not occur|no statement|postpone/i));
  if (cancel.some(Boolean) && cancel.some((c) => !c)) {
    const has = ms.filter((_, i) => cancel[i]).map((m) => m.venue);
    f.push({ check: "settlement_mismatch", severity: "medium", venue: "cross-venue", quote: clip(cancel.find(Boolean)!),
      explanation: `Only ${has.join(", ")} says what happens if the event is cancelled or postponed.` });
  }
  return f;
}

export function score(flags: Flag[]): number {
  return Math.min(100, flags.reduce((s, x) => s + WEIGHT[x.severity], 0));
}
export const level = (s: number) => (s >= 60 ? "high" : s >= 30 ? "medium" : "low");
const ORDER = { high: 3, medium: 2, low: 1, info: 0 };
export const topFlag = (fs: Flag[]) => [...fs].sort((a, b) => ORDER[b.severity] - ORDER[a.severity] || (b.quote ? 1 : 0) - (a.quote ? 1 : 0))[0] ?? null;

import * as agg from "./agg.js";
import { getJson } from "./http.js";
import { kalshiVM, POLY, polymarketRaw, polyVM } from "./public.js";
import { checkVenue, clip, crossVenue, level, score, topFlag } from "./risk.js";
import type { Bundle, Flag, VenueMarket } from "./types.js";

export interface CheckInput { polymarket?: string; kalshi?: string; q?: string; fairValue?: number; maxRisk?: number; spend?: number }
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function parsePolymarket(s: string): { id?: string; slug?: string } {
  const t = s.trim();
  if (/^\d+$/.test(t)) return { id: t };
  if (!/^https?:/i.test(t)) return { slug: t };
  const parts = new URL(t).pathname.split("/").filter(Boolean);
  return { slug: parts[parts.length - 1] };
}
export function parseKalshi(s: string): string {
  const t = s.trim();
  if (!/^https?:/i.test(t)) return t.toUpperCase();
  const parts = new URL(t).pathname.split("/").filter(Boolean);
  return (parts[parts.length - 1] ?? t).toUpperCase();
}
async function polyRaw(p: { id?: string; slug?: string }) {
  if (p.id) { const d = await getJson(`${POLY}/markets/${p.id}`); return d; }
  try { return await polymarketRaw(p.slug!); }
  catch { // event slug: take the first open market of the event
    const d = await getJson(`${POLY}/events?slug=${encodeURIComponent(p.slug!)}`);
    const m = (d[0]?.markets ?? []).find((x: any) => !x.closed);
    if (!m) throw new Error(`Polymarket market or event not found: ${p.slug}`);
    return m;
  }
}

export function kalshiFee(p: number) { return Math.ceil(0.07 * p * (1 - p) * 100) / 100; }
export function feePerContract(m: VenueMarket, p: number) {
  if (m.venue === "kalshi") return kalshiFee(p);
  if (m.feeRate && m.feeRate > 0) return r3(m.feeRate * p * (1 - p));
  return 0;
}

async function loadAgg(appId: string, inp: CheckInput, spend: number): Promise<Bundle> {
  let anchor: any; let other: { venue: string; id: string } | null = null;
  let polyId: string | undefined;
  if (inp.polymarket) { const p = parsePolymarket(inp.polymarket); polyId = p.id ?? String((await polyRaw(p)).id); }
  if (inp.kalshi) { anchor = await agg.lookup(appId, "kalshi", parseKalshi(inp.kalshi)); if (polyId) other = { venue: "polymarket", id: polyId }; }
  else if (polyId) anchor = await agg.lookup(appId, "polymarket", polyId);
  else anchor = await agg.search(appId, inp.q!);
  const b = await agg.bundle(appId, anchor, spend);
  if (other && !b.markets.some((m) => m.venue === other!.venue && m.externalId === other!.id)) {
    try {
      const extra = await agg.lookup(appId, other.venue, other.id);
      const eb = await agg.bundle(appId, extra, spend);
      b.markets.push(eb.markets[0]!);
      b.warnings.push("Agg does not match these two markets as the same event. Compare them carefully: they may not be the same bet.");
    } catch (e: any) { b.warnings.push(`Could not load the second market: ${e.message}`); }
  }
  return b;
}
async function loadPublic(inp: CheckInput): Promise<Bundle> {
  const jobs: Promise<VenueMarket>[] = [];
  if (inp.polymarket) jobs.push(polyRaw(parsePolymarket(inp.polymarket)).then(polyVM));
  if (inp.kalshi) jobs.push(kalshiVM(parseKalshi(inp.kalshi)));
  const got = await Promise.allSettled(jobs); const warnings: string[] = [];
  const markets = got.flatMap((g) => (g.status === "fulfilled" ? [g.value] : (warnings.push(String(g.reason?.message)), [])));
  if (!markets.length) throw new Error(`No market could be loaded: ${warnings.join("; ")}`);
  return { source: "public", markets, anchorIndex: 0, settlementDiff: null, route: null, warnings };
}

export async function load(inp: CheckInput, appId: string | undefined): Promise<Bundle> {
  const spend = inp.spend ?? 20;
  if (appId) {
    try { return await loadAgg(appId, inp, spend); }
    catch (e: any) {
      if (!inp.polymarket && !inp.kalshi) throw e;
      const b = await loadPublic(inp); b.warnings.unshift(`Agg unavailable (${e.message}); used public venue APIs without cross-venue matching.`); return b;
    }
  }
  if (!inp.polymarket && !inp.kalshi) throw new Error("Free-text search needs the Agg data source; give a Polymarket or Kalshi market instead.");
  return loadPublic(inp);
}

export function analyze(b: Bundle, inp: CheckInput) {
  const maxRisk = inp.maxRisk ?? 60;
  const cross = crossVenue(b.markets, b.settlementDiff);
  const venues = b.markets.map((m, i) => {
    const flags = checkVenue(m);
    const ask = m.yesAsk;
    const isRouted = i === b.anchorIndex && b.route && b.route.venue === m.venue && b.route.shares > 0;
    const fee = ask !== null ? feePerContract(m, ask) : null;
    const allIn = isRouted ? r3(b.route!.totalCost / b.route!.shares) : ask !== null && fee !== null ? r3(ask + fee) : null;
    return { m, flags, risk: score(flags), allIn, fee, priced: isRouted ? "agg_route_quote" : ask !== null ? "top_of_book_estimate" : "none" };
  });
  const mids = venues.map((v) => v.m.mid).filter((x): x is number => x !== null);
  const consensus = mids.length ? r3(mids.reduce((a, c) => a + c, 0) / mids.length) : null;
  const lo = venues.map((v) => (v.m.mid ?? NaN) - (v.m.spread ?? 0) / 2).filter(Number.isFinite);
  const hi = venues.map((v) => (v.m.mid ?? NaN) + (v.m.spread ?? 0) / 2).filter(Number.isFinite);
  const range = lo.length ? [r3(Math.max(0, Math.min(...lo))), r3(Math.min(1, Math.max(...hi)))] as [number, number] : null;
  const notes: string[] = [...b.warnings];
  if (mids.length >= 2 && Math.max(...mids) - Math.min(...mids) >= 0.05) notes.push(`Venues disagree by ${Math.round((Math.max(...mids) - Math.min(...mids)) * 100)} points. Either one is mispriced or they are not the same bet; check the settlement differences.`);

  const eligible = venues.filter((v) => v.allIn !== null && v.risk < maxRisk).sort((a, b2) => a.allIn! - b2.allIn! || a.risk - b2.risk);
  const best = eligible[0] ?? null;
  const basis = inp.fairValue !== undefined ? "your_fair_value" : "cross_venue_consensus";
  const center = inp.fairValue ?? (range ? range[1] : consensus);
  const riskFor = best?.risk ?? Math.min(...venues.map((v) => v.risk));
  const haircut = Math.max(0, riskFor - 20) / 300; // risk above 20 shaves value: 50 risk = -10%
  // Consensus mode: you may pay up to the top of the cross-venue range plus the venue fee. Your-view mode: fees come out of your edge.
  const feeAllowance = basis === "cross_venue_consensus" && best?.fee ? best.fee : 0;
  const maxPrice = center !== null ? r3(Math.max(0, (center + feeAllowance) * (1 - haircut))) : null;
  let action: "trade" | "skip" = "skip"; let reason: string;
  if (!best) reason = venues.every((v) => v.risk >= maxRisk) ? `Skip: resolution risk is ${Math.min(...venues.map((v) => v.risk))}/100 on the safest venue, at or above your limit of ${maxRisk}.` : "Skip: no venue has a live YES price.";
  else if (maxPrice === null) reason = "Skip: no reference price.";
  else if (best.allIn! <= maxPrice) {
    action = "trade";
    reason = basis === "your_fair_value"
      ? `Trade: buy YES on ${best.m.venue} up to ${maxPrice}. All-in cost now is ${best.allIn}, against your fair value of ${inp.fairValue} after a risk haircut.`
      : `OK to enter: buy YES on ${best.m.venue} up to ${maxPrice}. The price is in line with the other venues and the rules are acceptable. This is not a claim of edge; pass fairValue to test your own view.`;
  } else reason = `Skip: best all-in cost ${best.allIn} on ${best.m.venue} is above the risk-adjusted max price of ${maxPrice}.`;

  const allFlags: Flag[] = [...venues.flatMap((v) => v.flags), ...cross];
  const bestRisk = best ? best.risk : Math.min(...venues.map((v) => v.risk));
  const top = topFlag(best ? [...best.flags, ...cross] : allFlags);
  return {
    product: "Fine Print",
    question: clip(venues[b.anchorIndex]!.m.title, 200),
    riskScore: bestRisk, riskLevel: level(bestRisk),
    crossVenueRisk: score(cross),
    topRisk: top,
    flags: allFlags.filter((f) => f.severity !== "info" || f.quote),
    venues: venues.map((v) => ({ venue: v.m.venue, marketId: v.m.externalId, url: v.m.url, closeTime: v.m.closeTime, midpoint: v.m.mid !== null ? r3(v.m.mid) : null,
      allInYesCost: v.allIn, feePerContract: v.fee, pricing: v.priced, riskScore: v.risk, riskLevel: level(v.risk) })),
    bestVenue: best?.m.venue ?? null,
    fairValue: { basis, estimate: inp.fairValue ?? consensus, range: inp.fairValue !== undefined ? null : range },
    decision: { action, side: "YES" as const, venue: best?.m.venue ?? null, maxPrice, maxRiskPolicy: maxRisk, reason },
    notes,
    dataSource: b.source === "agg" ? "Agg.market (matching, prices, settlement differences) + Fine Print analysis" : "Polymarket and Kalshi public APIs + Fine Print analysis",
  };
}
export type CheckResult = ReturnType<typeof analyze>;

export function preview(r: CheckResult) {
  return { product: r.product, question: r.question, riskScore: r.riskScore, riskLevel: r.riskLevel, topRisk: r.topRisk ? { check: r.topRisk.check, severity: r.topRisk.severity, venue: r.topRisk.venue, explanation: r.topRisk.explanation } : null,
    venues: r.venues.map((v) => v.venue), upgrade: "The paid check adds the quoted risky sentences, prices and fees on each venue, the best venue, a fair-value range and a trade-or-skip decision with a max price." };
}

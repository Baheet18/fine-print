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
      b.markets.push({ ...eb.markets[0]!, matchedBy: "caller" });
      b.warnings.push("Agg does not match these two markets as the same event. Compare them carefully: they may not be the same bet.");
    } catch (e: any) {
      b.markets.push({ venue: other.venue, aggId: null, yesOutcomeId: null, externalId: other.id, title: "", url: null, closeTime: null, rules: "", resolutionSource: null, mid: null, spread: null, yesAsk: null, feeRate: null,
        status: "unavailable", unavailableReason: e?.name === "AbortError" ? "timed out" : String(e?.message ?? e), matchedBy: "caller" });
    }
  }
  return b;
}
async function loadPublic(inp: CheckInput): Promise<Bundle> {
  const jobs: Promise<VenueMarket>[] = [];
  if (inp.polymarket) jobs.push(polyRaw(parsePolymarket(inp.polymarket)).then(polyVM));
  if (inp.kalshi) jobs.push(kalshiVM(parseKalshi(inp.kalshi)));
  const names = [inp.polymarket && "polymarket", inp.kalshi && "kalshi"].filter(Boolean) as string[];
  const ids = [inp.polymarket, inp.kalshi].filter(Boolean) as string[];
  const got = await Promise.allSettled(jobs); const warnings: string[] = [];
  const markets: VenueMarket[] = got.map((g, i) => g.status === "fulfilled" ? { ...g.value, status: g.value.mid === null ? "unavailable" : "ok", matchedBy: "caller" } as VenueMarket
    : { venue: names[i]!, aggId: null, yesOutcomeId: null, externalId: ids[i]!, title: "", url: null, closeTime: null, rules: "", resolutionSource: null, mid: null, spread: null, yesAsk: null, feeRate: null,
        status: "unavailable", unavailableReason: g.reason?.name === "AbortError" ? "timed out" : String(g.reason?.message ?? g.reason) } as VenueMarket);
  if (!markets.some((m) => m.status === "ok" || m.rules)) throw new Error(`No market could be loaded: ${markets.map((m) => `${m.venue}: ${m.unavailableReason}`).join("; ")}`);
  return { source: "public", markets, anchorIndex: Math.max(0, markets.findIndex((m) => !!m.rules)), settlementDiff: null, route: null, warnings };
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
  const live = b.markets.filter((m) => m.status !== "unavailable" || m.rules); // rules can still be scored without a price
  const cross = crossVenue(live.filter((m) => m.rules), b.settlementDiff);
  const crossRisk = score(cross);
  const venues = b.markets.map((m, i) => {
    const flags = m.rules ? checkVenue(m) : [];
    const ask = m.status === "unavailable" ? null : m.yesAsk;
    const isRouted = i === b.anchorIndex && b.route && b.route.venue === m.venue && b.route.shares > 0;
    const fee = ask !== null ? feePerContract(m, ask) : null;
    const allIn = isRouted ? r3(b.route!.totalCost / b.route!.shares) : ask !== null && fee !== null ? r3(ask + fee) : null;
    const venueRisk = m.rules ? score(flags) : null;
    // Effective risk = this venue's own rules risk + cross-venue settlement risk (capped at 100).
    const risk = venueRisk === null ? null : Math.min(100, venueRisk + crossRisk);
    return { m, flags, venueRisk, risk, allIn, fee, priced: allIn === null ? "none" : isRouted ? "agg_route_quote" : "top_of_book_estimate" };
  });
  const unavailable = venues.filter((v) => v.m.status === "unavailable");
  const priced = venues.filter((v) => v.allIn !== null && v.m.mid !== null);
  const mids = priced.map((v) => v.m.mid!);
  const consensusOk = priced.length >= 2;
  const consensus = mids.length ? r3(mids.reduce((a, c) => a + c, 0) / mids.length) : null;
  const range = consensusOk ? [r3(Math.min(...mids)), r3(Math.max(...mids))] as [number, number] : null;
  const notes: string[] = [...b.warnings];
  if (unavailable.length) notes.push(`Unavailable: ${unavailable.map((v) => `${v.m.venue} (${v.m.unavailableReason ?? "no price"})`).join(", ")}. The decision ignores these venues.`);
  if (consensusOk && Math.max(...mids) - Math.min(...mids) >= 0.05) notes.push(`Venues disagree by ${Math.round((Math.max(...mids) - Math.min(...mids)) * 100)} points. Either one is mispriced or they are not the same bet; check the settlement differences.`);

  const scored = venues.filter((v) => v.risk !== null);
  const safest = scored.length ? Math.min(...scored.map((v) => v.risk!)) : 100;
  const eligible = priced.filter((v) => v.risk !== null && v.risk < maxRisk).sort((a, c) => a.allIn! - c.allIn! || a.risk! - c.risk!);
  const best = eligible[0] ?? null;
  const basis = inp.fairValue !== undefined ? "your_fair_value" : consensusOk ? "cross_venue_consensus" : "none";
  const riskFor = best?.risk ?? safest;
  const haircut = Math.max(0, riskFor - 20) / 300; // risk above 20 shaves value: 50 risk = -10%
  // Reference price: your fair value, or the top of the cross-venue midpoint range plus the venue fee and 1c tolerance.
  const ref = inp.fairValue !== undefined ? inp.fairValue : range && best ? range[1] + (best.fee ?? 0) + 0.01 : null;
  const maxPrice = ref !== null ? r3(Math.max(0, ref * (1 - haircut))) : null;
  const headroom = maxPrice !== null && best ? r3(maxPrice - best.allIn!) : null;
  const unavail = unavailable.length ? ` (${unavailable.map((v) => v.m.venue).join(", ")} unavailable)` : "";
  let action: "trade" | "skip" = "skip"; let reason: string;
  if (!best) {
    reason = priced.length === 0 ? `Skip: no venue has a live YES price${unavail}.`
      : `Skip: effective resolution risk is ${safest}/100 on the safest venue (rules ${Math.min(...scored.map((v) => v.venueRisk!))} + cross-venue ${crossRisk}), at or above your limit of ${maxRisk}.`;
  } else if (basis === "none") {
    reason = `Skip: only one venue (${best.m.venue}) has a live price${unavail}, so Fine Print has no independent price to check it against. Pass fairValue to decide on your own view.`;
  } else if (best.allIn! > maxPrice!) {
    reason = basis === "your_fair_value"
      ? `Skip: no edge. Best all-in cost ${best.allIn} on ${best.m.venue} is above your fair value ${inp.fairValue} after a ${Math.round(haircut * 100)}% risk haircut (max ${maxPrice}).`
      : haircut > 0 && best.allIn! <= ref!
        ? `Skip: price ${best.allIn} on ${best.m.venue} is within the fair-value range ${range![0]}-${range![1]} from ${priced.length} venues plus fees, but effective risk ${riskFor}/100 cuts the max price by ${Math.round(haircut * 100)}% to ${maxPrice}. Not worth the settlement risk at this price${unavail}.`
        : `Skip: price ${best.allIn} on ${best.m.venue} is above the fair-value range ${range![0]}-${range![1]} from ${priced.length} venues plus fees (max ${maxPrice}). No edge${unavail}.`;
  } else {
    action = "trade";
    reason = basis === "your_fair_value"
      ? `Trade: buy YES on ${best.m.venue} up to ${maxPrice}. All-in cost now is ${best.allIn}, against your fair value of ${inp.fairValue} after a ${Math.round(haircut * 100)}% risk haircut${unavail}.`
      : `OK to enter: buy YES on ${best.m.venue} up to ${maxPrice}. Its all-in price ${best.allIn} is within the fair-value range on ${priced.length} venues (${range![0]}-${range![1]} plus fees) and effective risk is ${best.risk}/100. This is not a claim of edge; pass fairValue to test your own view${unavail}.`;
  }

  const allFlags: Flag[] = [...venues.flatMap((v) => v.flags), ...cross];
  const top = topFlag(best ? [...best.flags, ...cross] : allFlags);
  const anchor = venues[b.anchorIndex]!;
  return {
    product: "Fine Print",
    question: clip(anchor.m.title, 200),
    riskScore: riskFor, riskLevel: level(riskFor),
    venueRisk: best?.venueRisk ?? (scored.length ? Math.min(...scored.map((v) => v.venueRisk!)) : null),
    crossVenueRisk: crossRisk,
    topRisk: top,
    flags: allFlags.filter((f) => f.severity !== "info" || f.quote),
    venues: venues.map((v) => ({ venue: v.m.venue, marketId: v.m.externalId, status: v.m.status ?? "ok", unavailableReason: v.m.unavailableReason ?? null, matchedBy: v.m.matchedBy ?? null,
      url: v.m.url, closeTime: v.m.closeTime, midpoint: v.m.mid !== null ? r3(v.m.mid) : null,
      allInYesCost: v.allIn, feePerContract: v.fee, pricing: v.priced, riskScore: v.risk, riskLevel: v.risk === null ? null : level(v.risk) })),
    bestVenue: best?.m.venue ?? null,
    fairValue: { basis, estimate: inp.fairValue ?? (consensusOk ? consensus : null), range, pricedVenues: priced.length },
    decision: { action, side: "YES" as const, venue: best?.m.venue ?? null, maxPrice, headroom, maxRiskPolicy: maxRisk, reason },
    notes,
    dataSource: b.source === "agg" ? "Agg.market (matching, prices, settlement differences) + Fine Print analysis" : "Polymarket and Kalshi public APIs + Fine Print analysis",
  };
}
export type CheckResult = ReturnType<typeof analyze>;

export function preview(r: CheckResult) {
  return { product: r.product, question: r.question, riskScore: r.riskScore, riskLevel: r.riskLevel, topRisk: r.topRisk ? { check: r.topRisk.check, severity: r.topRisk.severity, venue: r.topRisk.venue, explanation: r.topRisk.explanation } : null,
    venues: r.venues.map((v) => v.venue), upgrade: "The paid check adds the quoted risky sentences, prices and fees on each venue, the best venue, a fair-value range and a trade-or-skip decision with a max price." };
}

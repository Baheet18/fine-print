// Agg.market adapter: matching, rules, midpoints, settlementDiff, smart-route preview quote.
import { getJson, num } from "./http.js";
import type { Bundle, VenueMarket } from "./types.js";

const BASE = "https://api.agg.market";
const h = (appId: string) => ({ "x-app-id": appId });

function joinRules(m: any) {
  return [m.rulesPrimary, m.rulesSecondary, m.description].filter((s) => s && String(s).trim()).filter((s, i, a) => a.indexOf(s) === i).join("\n");
}
function venueUrl(m: any): string | null {
  const ev = m.venueEvent ?? {};
  if (m.venue === "polymarket" && ev.slug) return `https://polymarket.com/event/${ev.slug}`;
  if (m.venue === "kalshi" && ev.externalIdentifier) return `https://kalshi.com/markets/${String(ev.series?.externalIdentifier ?? ev.externalIdentifier).toLowerCase()}`;
  return null;
}
function toVM(m: any): VenueMarket {
  const yes = (m.venueMarketOutcomes ?? []).find((o: any) => /^yes$/i.test(o.label ?? "")) ?? null;
  const title = [m.venueEvent?.title, m.question].filter(Boolean).join(" — ");
  return {
    venue: m.venue, aggId: m.id, yesOutcomeId: yes?.id ?? null, externalId: String(m.externalIdentifier ?? m.id),
    title, url: venueUrl(m), closeTime: m.endDate ?? m.venueEvent?.endDate ?? null, rules: joinRules(m), resolutionSource: null,
    mid: null, spread: null, yesAsk: null, feeRate: num(m.feeRate),
  };
}

export async function lookup(appId: string, venue: string, externalId: string) {
  const u = `${BASE}/venue-markets?venue=${encodeURIComponent(venue)}&externalIdentifier=${encodeURIComponent(externalId)}`;
  const d = await getJson(u, { headers: h(appId) });
  const m = (d.data ?? [])[0];
  if (!m) throw new Error(`Agg has no ${venue} market ${externalId}`);
  return m;
}
export async function search(appId: string, q: string) {
  const u = `${BASE}/search?type=markets&status=open&limit=5&q=${encodeURIComponent(q)}`;
  const d = await getJson(u, { headers: h(appId) });
  const m = (d.data ?? [])[0];
  if (!m) throw new Error(`Agg search found nothing for "${q}"`);
  return lookup(appId, m.venue, String(m.externalIdentifier));
}

export async function bundle(appId: string, anchor: any, spend: number): Promise<Bundle> {
  const warnings: string[] = [];
  const all = [anchor, ...(anchor.matchedVenueMarkets ?? [])];
  // matched markets carry rules but not always outcomes/fees: fill from their own nested data
  const markets = all.map((m: any) => toVM({ ...m, endDate: m.endDate ?? m.venueEvent?.endDate ?? anchor.endDate, venueEvent: m.venueEvent ?? anchor.venueEvent }));
  const ids = markets.map((m) => m.aggId).filter(Boolean).join(",");
  const anchorVM = markets[0]!;
  const [mids, ev, route] = await Promise.allSettled([
    getJson(`${BASE}/midpoints?venueMarketIds=${ids}`, { headers: h(appId), ms: 3000 }),
    getJson(`${BASE}/venue-events/${anchor.venueEventId}`, { headers: h(appId), ms: 3500 }),
    anchorVM.yesOutcomeId ? getJson(`${BASE}/orderbook/${anchorVM.yesOutcomeId}/route?side=buy&maxSpend=${spend}`, { headers: h(appId), ms: 3500 }) : Promise.reject(new Error("no YES outcome")),
  ]);
  if (mids.status === "fulfilled") {
    for (const row of mids.value.data ?? []) {
      const vm = markets.find((m) => m.aggId === row.venueMarketId);
      const yes = (row.outcomes ?? []).find((o: any) => /^yes$/i.test(o.label));
      if (vm) { vm.mid = num(yes?.midpoint ?? row.midpoint); vm.spread = num(row.spread); }
      for (const mm of row.matched ?? []) {
        const v2 = markets.find((m) => m.aggId === mm.venueMarketId);
        const y2 = (mm.outcomes ?? []).find((o: any) => /^yes$/i.test(o.label));
        if (v2 && v2.mid === null) v2.mid = num(y2?.midpoint ?? mm.midpoint);
        if (v2 && !v2.yesOutcomeId && y2) v2.yesOutcomeId = y2.venueMarketOutcomeId;
      }
    }
  } else warnings.push(`Agg midpoints unavailable: ${mids.reason?.message}`);
  for (const m of markets) if (m.mid !== null && m.spread !== null) m.yesAsk = Math.min(1, m.mid + m.spread / 2);
  let settlementDiff: Bundle["settlementDiff"] = null;
  if (ev.status === "fulfilled" && ev.value.settlementDiffStatus === "computed") {
    settlementDiff = (ev.value.settlementDiff?.differences ?? []).map((d: any) => ({ type: String(d.type), title: String(d.title), venues: Object.keys(d.perVenue ?? {}) }));
  } else if (ev.status === "rejected") warnings.push(`Agg event detail unavailable: ${ev.reason?.message}`);
  let r: Bundle["route"] = null;
  if (route.status === "fulfilled" && Array.isArray(route.value.fills) && route.value.fills.length) {
    const v = route.value; const fb = v.feeBreakdown ?? {};
    const venues = [...new Set(v.fills.map((f: any) => f.venue))].join("+");
    r = { venue: venues, avgPrice: num(v.slippage?.vwap) ?? num(v.fills[0].avgPrice) ?? 0, shares: num(v.totalFilled) ?? 0, totalCost: num(fb.totalCost) ?? spend, fees: num(fb.venueFees) ?? 0, spend };
  } else if (route.status === "rejected") warnings.push(`Agg route quote unavailable: ${route.reason?.message}`);
  return { source: "agg", markets, anchorIndex: 0, settlementDiff, route: r, warnings };
}

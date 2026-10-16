// Agg.market adapter: matching, rules, midpoints, settlementDiff, smart-route preview quote.
import { getJson, num } from "./http.js";
import { matchOutcome } from "./match.js";
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
export function toVM(m: any, matchedBy: VenueMarket["matchedBy"] = "agg"): VenueMarket {
  const yes = (m.venueMarketOutcomes ?? []).find((o: any) => /^yes$/i.test(o.label ?? "")) ?? null;
  const title = [m.venueEvent?.title, m.question].filter(Boolean).join(" — ");
  return {
    venue: m.venue, aggId: m.id, yesOutcomeId: yes?.id ?? null, externalId: String(m.externalIdentifier ?? m.id),
    title, url: venueUrl(m), closeTime: m.endDate ?? m.venueEvent?.endDate ?? null, rules: joinRules(m), resolutionSource: null,
    mid: null, spread: null, yesAsk: null, feeRate: num(m.feeRate), status: "ok", matchedBy,
  };
}

export async function lookup(appId: string, venue: string, externalId: string) {
  const u = `${BASE}/venue-markets?venue=${encodeURIComponent(venue)}&externalIdentifier=${encodeURIComponent(externalId)}&projection=full`;
  const d = await getJson(u, { headers: h(appId) });
  const m = (d.data ?? [])[0];
  if (!m) throw new Error(`Agg has no ${venue} market ${externalId}`);
  return m;
}
export async function search(appId: string, q: string) {
  const d = await getJson(`${BASE}/search?type=markets&status=open&limit=5&q=${encodeURIComponent(q)}`, { headers: h(appId) });
  const m = (d.data ?? [])[0];
  if (!m) throw new Error(`Agg search found nothing for "${q}"`);
  return lookup(appId, m.venue, String(m.externalIdentifier));
}
const eventMarkets = async (appId: string, eventId: string, ms = 3000) =>
  ((await getJson(`${BASE}/venue-markets?venueEventId=${encodeURIComponent(eventId)}&projection=full&limit=50`, { headers: h(appId), ms })).data ?? []) as any[];

/** Backstop: Agg matched the events but not this outcome. Parse outcome labels across the matched events' ladders. */
export async function backstopMatches(appId: string, anchor: any, matchedEvents: { id: string; venue: string }[], warnings: string[]) {
  const out: any[] = [];
  let siblings: string[] = [];
  try { siblings = (await eventMarkets(appId, anchor.venueEventId)).filter((m) => m.id !== anchor.id && m.venue === anchor.venue).map((m) => String(m.question ?? "")); } catch { /* ladder step can come from candidates */ }
  const others = matchedEvents.filter((e) => e.venue !== anchor.venue);
  const lists = await Promise.allSettled(others.map((e) => eventMarkets(appId, e.id)));
  lists.forEach((r, i) => {
    if (r.status !== "fulfilled") { warnings.push(`${others[i]!.venue}: could not list markets for outcome matching (${r.reason?.message}).`); return; }
    const open = r.value.filter((m) => m.venue === others[i]!.venue && m.id !== anchor.id && (m.status === "open" || m.status === "active" || !m.status));
    const idx = matchOutcome(String(anchor.question ?? ""), siblings, open.map((m) => String(m.question ?? "")));
    if (idx >= 0) out.push(open[idx]);
  });
  return out;
}

export async function bundle(appId: string, anchor: any, spend: number): Promise<Bundle> {
  const warnings: string[] = [];
  const anchorVM = toVM(anchor);
  const [ev, route] = await Promise.allSettled([
    getJson(`${BASE}/venue-events/${anchor.venueEventId}`, { headers: h(appId), ms: 3500 }),
    anchorVM.yesOutcomeId ? getJson(`${BASE}/orderbook/${anchorVM.yesOutcomeId}/route?side=buy&maxSpend=${spend}`, { headers: h(appId), ms: 3500 }) : Promise.reject(new Error("no YES outcome")),
  ]);
  let matched: any[] = anchor.matchedVenueMarkets ?? [];
  let matchedBy: VenueMarket["matchedBy"] = "agg";
  const matchedEvents = ev.status === "fulfilled" ? (ev.value.matchedVenueEvents ?? []) : [];
  if (!matched.length && matchedEvents.length) {
    matched = await backstopMatches(appId, anchor, matchedEvents, warnings);
    matchedBy = "fine_print_outcome_parser";
    if (matched.length) warnings.push(`Agg did not pair this outcome across venues; Fine Print matched it by parsing the outcome ladder (${matched.map((m) => `${m.venue}: "${m.question}"`).join(", ")}). Check the pairing.`);
  }
  const markets = [anchorVM, ...matched.map((m: any) => toVM({ ...m, endDate: m.endDate ?? m.venueEvent?.endDate ?? anchor.endDate, venueEvent: m.venueEvent ?? anchor.venueEvent }, matchedBy))];

  const ids = markets.map((m) => m.aggId).filter(Boolean).join(",");
  let midErr: string | null = null;
  try {
    const mids = await getJson(`${BASE}/midpoints?venueMarketIds=${ids}`, { headers: h(appId), ms: 3000 });
    for (const row of mids.data ?? []) {
      const vm = markets.find((m) => m.aggId === row.venueMarketId);
      const yes = (row.outcomes ?? []).find((o: any) => /^yes$/i.test(o.label));
      if (vm) { vm.mid = num(yes?.midpoint ?? row.midpoint); vm.spread = num(row.spread); if (!vm.yesOutcomeId && yes) vm.yesOutcomeId = yes.venueMarketOutcomeId; }
    }
  } catch (e: any) { midErr = e?.name === "AbortError" ? "timed out" : String(e?.message ?? e); }
  for (const m of markets) {
    if (m.mid !== null && m.spread !== null) m.yesAsk = Math.min(1, m.mid + m.spread / 2);
    if (m.mid === null) { m.status = "unavailable"; m.unavailableReason = midErr ? `price feed ${midErr}` : "no live price"; }
  }

  let settlementDiff: Bundle["settlementDiff"] = null;
  if (ev.status === "fulfilled" && ev.value.settlementDiffStatus === "computed") {
    settlementDiff = (ev.value.settlementDiff?.differences ?? []).map((d: any) => ({ type: String(d.type), title: String(d.title), summary: String(d.summary ?? ""), perVenue: d.perVenue ?? {} }));
  } else if (ev.status === "rejected") warnings.push(`Agg event detail unavailable (${ev.reason?.message}); settlement differences not checked.`);
  let r: Bundle["route"] = null;
  if (route.status === "fulfilled" && Array.isArray(route.value.fills) && route.value.fills.length) {
    const v = route.value; const fb = v.feeBreakdown ?? {};
    const venues = [...new Set(v.fills.map((f: any) => f.venue))].join("+");
    r = { venue: venues, avgPrice: num(v.slippage?.vwap) ?? num(v.fills[0].avgPrice) ?? 0, shares: num(v.totalFilled) ?? 0, totalCost: num(fb.totalCost) ?? spend, fees: num(fb.venueFees) ?? 0, spend };
  } else if (route.status === "rejected") warnings.push(`Agg route quote unavailable (${route.reason?.message}); anchor priced from top of book.`);
  return { source: "agg", markets, anchorIndex: 0, settlementDiff, route: r, warnings };
}

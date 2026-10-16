// Fallback when Agg is unavailable: Polymarket gamma + Kalshi public trade API. No matching: caller supplies both.
import { getJson, num, parseArr } from "./http.js";
import type { VenueMarket } from "./types.js";

export const POLY = "https://gamma-api.polymarket.com";
export const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";

export async function polymarketRaw(slug: string) {
  const d = await getJson(`${POLY}/markets?slug=${encodeURIComponent(slug)}`);
  const m = Array.isArray(d) ? d[0] : null;
  if (!m) throw new Error(`Polymarket market not found: ${slug}`);
  return m;
}
export function polyVM(m: any): VenueMarket {
  const bid = num(m.bestBid), ask = num(m.bestAsk); const prices = parseArr(m.outcomePrices).map(num);
  return {
    venue: "polymarket", aggId: null, yesOutcomeId: null, externalId: String(m.id), title: String(m.question ?? ""),
    url: `https://polymarket.com/market/${m.slug}`, closeTime: m.endDate ?? null,
    rules: String(m.description ?? ""), resolutionSource: m.resolutionSource || null,
    mid: bid !== null && ask !== null ? (bid + ask) / 2 : prices[0] ?? null, spread: bid !== null && ask !== null ? ask - bid : null,
    yesAsk: ask, feeRate: 0,
  };
}
export async function kalshiVM(ticker: string): Promise<VenueMarket> {
  const d = await getJson(`${KALSHI}/markets/${encodeURIComponent(ticker.toUpperCase())}`);
  const m = d.market; if (!m) throw new Error(`Kalshi market not found: ${ticker}`);
  const bid = num(m.yes_bid_dollars), ask = num(m.yes_ask_dollars);
  return {
    venue: "kalshi", aggId: null, yesOutcomeId: null, externalId: m.ticker, title: `${m.title}${m.yes_sub_title ? ` — ${m.yes_sub_title}` : ""}`,
    url: `https://kalshi.com/markets/${String(m.event_ticker).toLowerCase()}`, closeTime: m.close_time ?? null,
    rules: [m.rules_primary, m.rules_secondary].filter(Boolean).join("\n"), resolutionSource: null,
    mid: bid !== null && ask ? (bid + ask) / 2 : num(m.last_price_dollars), spread: bid !== null && ask ? ask - bid : null,
    yesAsk: ask && ask > 0 ? ask : null, feeRate: 0.07,
  };
}

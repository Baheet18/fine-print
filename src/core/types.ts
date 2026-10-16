export type Venue = string; // "polymarket" | "kalshi" | "predict" | "limitless" | ...
export interface VenueMarket {
  venue: Venue;
  aggId: string | null;          // Agg venueMarketId
  yesOutcomeId: string | null;   // Agg outcome id for YES
  externalId: string;            // venue's own id/ticker
  title: string;
  url: string | null;
  closeTime: string | null;
  rules: string;                 // rules text (used for analysis only; never returned in full)
  resolutionSource: string | null;
  mid: number | null;
  spread: number | null;
  yesAsk: number | null;
  feeRate: number | null;        // Agg feeRate (fraction) when known
}
export interface Severity { level: "high" | "medium" | "low" | "info" }
export interface Flag {
  check: string;
  severity: "high" | "medium" | "low" | "info";
  venue: string;
  quote: string | null;          // the single sentence that triggered it (<=280 chars)
  explanation: string;
}
export interface Bundle {
  source: "agg" | "public";
  markets: VenueMarket[];
  anchorIndex: number;
  settlementDiff: { type: string; title: string; venues: string[] }[] | null;
  route: { venue: string; avgPrice: number; shares: number; totalCost: number; fees: number; spend: number } | null;
  warnings: string[];
}

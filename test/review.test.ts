// Regression tests for the code review on 29778d0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyze } from "../src/core/analyze.js";
import { crossVenue } from "../src/core/risk.js";
import { ladderStep, matchOutcome, normalize, parseOutcome } from "../src/core/match.js";
import { resolveServiceUrl } from "../plugin/src/config.js";
import type { Bundle, VenueMarket } from "../src/core/types.js";

const CLEAN = "If the Federal Reserve hikes by 25bps on Dec 9, 2026, resolves Yes. Source: the FOMC statement at https://www.federalreserve.gov. If the meeting is cancelled, resolves No. Deadline 2:00 PM ET.";
const vm = (venue: string, mid: number | null, spread = 0.02, rules = CLEAN, extra: Partial<VenueMarket> = {}): VenueMarket => ({ venue, aggId: venue, yesOutcomeId: null, externalId: venue, title: "Q", url: null,
  closeTime: "2026-12-09T19:00:00Z", rules, resolutionSource: null, mid, spread, yesAsk: mid === null ? null : mid + spread / 2, feeRate: 0, status: mid === null ? "unavailable" : "ok", ...extra });
const B = (ms: VenueMarket[], settlementDiff: Bundle["settlementDiff"] = null): Bundle => ({ source: "agg", markets: ms, anchorIndex: 0, settlementDiff, route: null, warnings: [] });
const fed = JSON.parse(readFileSync("test/fixtures/fed_hike.json", "utf8")) as VenueMarket[];
const fedDiff: Bundle["settlementDiff"] = [
  { type: "edge_cases", title: "No Statement Fallback", summary: "Predict and Polymarket specify a fallback resolution to 'No change' if the FOMC statement is not released, a condition not mentioned by Kalshi.", perVenue: { polymarket: "Resolves to 'No change' if no statement by next meeting", predict: "Resolves to 'No change' if no statement by next meeting" } },
  { type: "resolution_source", title: "Resolution Source", summary: "Predict and Polymarket specify the FOMC statement and federalreserve.gov, whereas Kalshi does not.", perVenue: { polymarket: "FOMC statement & federalreserve.gov", predict: "FOMC statement & federalreserve.gov" } },
];

// 1) cross-venue risk is part of the effective risk
test("1: crossVenueRisk is folded into riskScore, maxRisk and the haircut", () => {
  const ms = fed.map((m, i) => ({ ...vm(m.venue, 0.76 + i * 0.005), rules: m.rules }));
  const r = analyze(B(ms, fedDiff), { maxRisk: 30 });
  assert.ok(r.crossVenueRisk > 0);
  assert.equal(r.riskScore, Math.min(100, r.venueRisk! + r.crossVenueRisk));
  if (r.riskScore >= 30) { assert.equal(r.decision.action, "skip"); assert.match(r.decision.reason, /cross-venue/); }
  const noCross = analyze(B([ms[0]!]), { fairValue: 0.9, maxRisk: 100 });
  const withCross = analyze(B(ms, fedDiff), { fairValue: 0.9, maxRisk: 100 });
  assert.ok(withCross.decision.maxPrice! <= noCross.decision.maxPrice!, "cross risk must not raise the max price");
});

// 2) never claim consensus with fewer than 2 priced venues; outcome-ladder backstop
test("2: one priced venue -> no consensus, no 'in line' claim", () => {
  const r = analyze(B([vm("kalshi", 0.05)]), {});
  assert.equal(r.fairValue.basis, "none"); assert.equal(r.fairValue.range, null);
  assert.equal(r.decision.action, "skip"); assert.doesNotMatch(r.decision.reason, /in line|within the fair-value range/);
  const r2 = analyze(B([vm("kalshi", 0.05), vm("polymarket", null)]), {});
  assert.equal(r2.fairValue.pricedVenues, 1); assert.equal(r2.fairValue.basis, "none");
});
test("2: outcome parser matches Fed ladders across venue wording", () => {
  const kalshi = ["Hike >25bps", "Hike 25bps", "Fed maintains rate", "Cut 25bps", "Cut >25bps"];
  const poly = ["50+ bps increase", "25 bps increase", "No change", "25 bps decrease", "50+ bps decrease"];
  kalshi.forEach((k, i) => assert.equal(matchOutcome(k, kalshi.filter((x) => x !== k), poly), i, k));
  assert.equal(normalize(parseOutcome("Hike >25bps"), 25), "up|gte|50");
  assert.equal(normalize(parseOutcome("50+ bps increase"), 25), "up|gte|50");
  assert.equal(ladderStep(["Hike 25bps", "Hike >25bps", "Cut 25bps"]), 25);
  assert.equal(normalize(parseOutcome("Fed maintains rate"), 25), normalize(parseOutcome("No change"), 25));
});
test("2: outcome parser refuses ambiguous or unparseable matches", () => {
  assert.equal(matchOutcome("Hike 25bps", [], ["25 bps increase", "25 bps increase (alt)"]), -1);
  assert.equal(matchOutcome("Brentford", [], ["Arsenal", "Brentford FC"]), -1);
  assert.equal(matchOutcome("Hike 25bps", [], ["25 bps decrease"]), -1);
});

// 3) Agg settlementDiff text is used, but corrected against full rules; our one-sided clause check adds what Agg misses
test("3: Agg's 'Kalshi doesn't cover no-statement' is corrected from Kalshi's full rules", () => {
  const f = crossVenue(fed, fedDiff);
  const ns = f.find((x) => x.explanation.startsWith("No Statement Fallback"))!;
  assert.match(ns.explanation, /Agg: Predict and Polymarket/); // Agg's own text
  assert.match(ns.explanation, /correction: kalshi/);
  assert.match(ns.quote ?? "", /canceled/);
  assert.equal(ns.severity, "low");
  assert.match(ns.explanation, /trigger and timing/);
});
test("3: Agg diffs not contradicted by the rules keep Agg's text and severity", () => {
  const f = crossVenue(fed, fedDiff);
  const src = f.find((x) => x.explanation.startsWith("Resolution Source"))!;
  assert.equal(src.severity, "medium"); assert.match(src.explanation, /federalreserve\.gov/);
});
test("3: one-sided rounding clause is flagged even though Agg misses it", () => {
  const f = crossVenue(fed, fedDiff);
  const r = f.find((x) => /rounded/.test(x.explanation))!;
  assert.ok(r); assert.match(r.explanation, /kalshi does not/); assert.match(r.quote ?? "", /rounded up to the nearest 25/);
});

// 4) consensus-mode price skip, unavailable venues, configurable service URL
test("4: consensus mode skips when the best price is above the fair-value range", () => {
  const ms = [vm("kalshi", 0.5, 0.2), vm("polymarket", 0.5, 0.2)]; // asks at 0.60 vs mids at 0.50
  const r = analyze(B(ms), {});
  assert.equal(r.decision.action, "skip"); assert.match(r.decision.reason, /above the fair-value range 0.5-0.5/);
});
test("4: consensus mode trades when the price is in the range", () => {
  const r = analyze(B([vm("kalshi", 0.5, 0.02), vm("polymarket", 0.5, 0.02)]), {});
  assert.equal(r.decision.action, "trade"); assert.ok(r.decision.headroom! >= 0);
});
test("4: unavailable venues are listed with a reason and mentioned in notes and reasoning", () => {
  const r = analyze(B([vm("kalshi", 0.5), vm("polymarket", 0.5), vm("predict", null, 0.02, CLEAN, { unavailableReason: "timed out" })]), {});
  const p = r.venues.find((v) => v.venue === "predict")!;
  assert.equal(p.status, "unavailable"); assert.equal(p.unavailableReason, "timed out"); assert.equal(p.allInYesCost, null);
  assert.ok(r.notes.some((n) => /predict \(timed out\)/.test(n)));
  assert.match(r.decision.reason, /predict unavailable/);
});
test("4: FINE_PRINT_URL is validated and normalized", () => {
  assert.equal(resolveServiceUrl(""), "https://fine-print.vercel.app");
  assert.equal(resolveServiceUrl("https://fp.example.com/"), "https://fp.example.com");
  assert.equal(resolveServiceUrl("https://fp.example.com/api/"), "https://fp.example.com/api");
  assert.equal(resolveServiceUrl("http://localhost:8787"), "http://localhost:8787");
  for (const bad of ["http://fp.example.com", "https://fp.example.com?x=1", "https://u:p@fp.example.com", "not a url", "https://fp.example.com:8443"])
    assert.throws(() => resolveServiceUrl(bad), bad);
});

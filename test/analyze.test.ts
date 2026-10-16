import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, kalshiFee, parseKalshi, parsePolymarket, preview } from "../src/core/analyze.js";
import type { Bundle, VenueMarket } from "../src/core/types.js";

const CLEAN = "If the Federal Reserve hikes by 25bps on Dec 9, 2026, resolves Yes. Source: the FOMC statement at https://www.federalreserve.gov. If the meeting is cancelled, resolves No. Deadline 2:00 PM ET.";
const VAGUE = "Resolves Yes if X officially happens. The resolution source will be a consensus of credible reporting. The market may be clarified.";
const vm = (venue: string, mid: number, spread: number, rules = CLEAN): VenueMarket => ({ venue, aggId: venue, yesOutcomeId: null, externalId: venue, title: "Q", url: null,
  closeTime: "2026-12-09T19:00:00Z", rules, resolutionSource: null, mid, spread, yesAsk: mid + spread / 2, feeRate: venue === "kalshi" ? 0.07 : 0 });
const bundle = (ms: VenueMarket[]): Bundle => ({ source: "agg", markets: ms, anchorIndex: 0, settlementDiff: null, route: null, warnings: [] });

test("clean market priced in line with other venues: OK to enter at the cheapest venue", () => {
  const r = analyze(bundle([vm("kalshi", 0.5, 0.02), vm("polymarket", 0.5, 0.02)]), {});
  assert.equal(r.decision.action, "trade"); assert.equal(r.bestVenue, "polymarket"); assert.equal(r.fairValue.basis, "cross_venue_consensus");
  assert.ok(r.riskScore < 30);
});
test("vague market is skipped by the max-risk policy", () => {
  const r = analyze(bundle([vm("polymarket", 0.3, 0.02, VAGUE)]), { maxRisk: 50 });
  assert.equal(r.decision.action, "skip"); assert.match(r.decision.reason, /limit of 50/);
});
test("caller fair value: trade only with edge after fees and risk haircut", () => {
  const ms = [vm("kalshi", 0.4, 0.02)];
  assert.equal(analyze(bundle(ms), { fairValue: 0.55 }).decision.action, "trade");
  assert.equal(analyze(bundle(ms), { fairValue: 0.42 }).decision.action, "skip");
});
test("risk haircut lowers the max price", () => {
  const clean = analyze(bundle([vm("polymarket", 0.5, 0.02)]), { fairValue: 0.6 });
  const vague = analyze(bundle([vm("polymarket", 0.5, 0.02, VAGUE)]), { fairValue: 0.6, maxRisk: 100 });
  assert.ok(vague.decision.maxPrice! < clean.decision.maxPrice!);
});
test("venues disagreeing by 5+ points adds a note", () => {
  const r = analyze(bundle([vm("kalshi", 0.4, 0.02), vm("polymarket", 0.5, 0.02)]), {});
  assert.ok(r.notes.some((n) => /disagree/.test(n)));
});
test("preview hides the decision and quotes", () => {
  const p = preview(analyze(bundle([vm("polymarket", 0.3, 0.02, VAGUE)]), {})) as any;
  assert.equal(p.decision, undefined); assert.equal(p.topRisk.quote, undefined);
});
test("paid output never contains the full rules text", () => {
  const long = VAGUE + " " + "Additional filler sentence about the market. ".repeat(40);
  const r = analyze(bundle([vm("polymarket", 0.3, 0.02, long)]), {});
  assert.ok(!JSON.stringify(r).includes(long.slice(0, 400)));
});
test("input parsing", () => {
  assert.deepEqual(parsePolymarket("https://polymarket.com/event/fed-x/will-the-fed-hike"), { slug: "will-the-fed-hike" });
  assert.deepEqual(parsePolymarket("3215008"), { id: "3215008" });
  assert.equal(parseKalshi("https://kalshi.com/markets/kxfeddecision/KXFEDDECISION-26DEC-H25"), "KXFEDDECISION-26DEC-H25");
  assert.equal(kalshiFee(0.5), 0.02);
});

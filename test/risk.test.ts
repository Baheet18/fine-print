import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { checkVenue, crossVenue, level, score, sentences } from "../src/core/risk.js";

// Rules text snapshots captured from live markets on 2026-10-16 (test/fixtures). Expected bands per venue.
const expected: Record<string, Record<string, [number, number]>> = {
  fed_hike: { kalshi: [0, 15], polymarket: [0, 15] },
  btc_eoy: { kalshi: [0, 20] },
  cpi_nov: { kalshi: [0, 15] },
  lisa_cook: { polymarket: [45, 70] },
  ceasefire: { polymarket: [60, 100] },
  musk_run: { polymarket: [35, 70] },
  taylor_tv: { kalshi: [25, 50] },
  uk_socialban: { polymarket: [20, 45] },
};
const fx = (n: string) => JSON.parse(readFileSync(`test/fixtures/${n}.json`, "utf8"));

for (const [name, bands] of Object.entries(expected)) {
  test(`risk band: ${name}`, () => {
    for (const m of fx(name)) {
      const b = bands[m.venue]; if (!b) continue;
      const s = score(checkVenue(m));
      assert.ok(s >= b[0] && s <= b[1], `${name}/${m.venue} scored ${s}, expected ${b[0]}-${b[1]}`);
    }
  });
}

test("every fixture produces flags with bounded quotes", () => {
  for (const f of readdirSync("test/fixtures")) for (const m of JSON.parse(readFileSync(`test/fixtures/${f}`, "utf8"))) {
    for (const fl of checkVenue(m)) { assert.ok(!fl.quote || fl.quote.length <= 280); assert.ok(fl.explanation.length > 10); }
  }
});

test("credible-reporting as sole source is high; as fallback is medium", () => {
  const sole = checkVenue({ venue: "polymarket", rules: "This market resolves Yes if X happens by Dec 31, 2026, 11:59 PM ET. The resolution source will be a consensus of credible reporting.", resolutionSource: null, closeTime: null });
  assert.equal(sole.find((f) => f.check === "verifiable_source")?.severity, "high");
  const fb = checkVenue({ venue: "polymarket", rules: "This market resolves Yes if X happens by Dec 31, 2026, 11:59 PM ET. The primary resolution source will be official information from the BLS, however a consensus of credible reporting may also be used.", resolutionSource: null, closeTime: null });
  assert.equal(fb.find((f) => f.check === "verifiable_source")?.severity, "medium");
});

test("empty rules is high risk", () => {
  const f = checkVenue({ venue: "kalshi", rules: "", resolutionSource: null, closeTime: null });
  assert.equal(f[0]!.check, "rules_present"); assert.equal(f[0]!.severity, "high");
});

test("timezone detection covers ET and Eastern European Time", () => {
  for (const tz of ["11:59 PM ET", "11:59 PM Eastern European Time", "23:59 UTC"]) {
    const f = checkVenue({ venue: "kalshi", rules: `Resolves Yes if it happens by Dec 31, 2026 ${tz}. Source: https://example.gov. If cancelled, resolves No.`, resolutionSource: null, closeTime: null });
    assert.ok(!f.some((x) => x.check === "deadline_timezone"), tz);
  }
});

test("cross-venue: cancellation covered on only one venue is flagged", () => {
  const a = { venue: "kalshi", rules: "If the meeting is cancelled, resolves No.", closeTime: "2026-12-09T19:00:00Z" } as any;
  const b = { venue: "polymarket", rules: "Resolves Yes on a hike.", closeTime: "2026-12-09T23:59:00Z" } as any;
  assert.ok(crossVenue([a, b], null).some((f) => /cancelled/.test(f.explanation)));
  assert.equal(crossVenue([a], null).length, 0);
});

test("sentences and levels", () => {
  assert.equal(sentences("One. Two! Three?").length, 3);
  assert.equal(level(10), "low"); assert.equal(level(30), "medium"); assert.equal(level(60), "high");
  assert.equal(score(Array(10).fill({ severity: "high" }) as any), 100);
});

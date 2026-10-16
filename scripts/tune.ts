import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { analyze, load } from "../src/core/analyze.js";
const appId = readFileSync(`${process.env.HOME}/.agg/app_id`, "utf8").trim();
const cases: Record<string, any> = JSON.parse(readFileSync("scripts/markets.json", "utf8"));
mkdirSync("test/fixtures", { recursive: true });
for (const [name, inp] of Object.entries(cases)) {
  const t0 = Date.now();
  try {
    const b = await load(inp, appId); const r = analyze(b, inp);
    if (process.env.SAVE) writeFileSync(`test/fixtures/${name}.json`, JSON.stringify(b.markets.map((m) => ({ venue: m.venue, rules: m.rules, resolutionSource: m.resolutionSource, closeTime: m.closeTime }))));
    console.log(`${name.padEnd(14)} ${String(Date.now() - t0).padStart(5)}ms risk=${String(r.riskScore).padStart(3)} x=${String(r.crossVenueRisk).padStart(3)} ${r.decision.action.padEnd(5)} best=${r.bestVenue} venues=${r.venues.map((v) => `${v.venue}:${v.riskScore}@${v.allInYesCost}`).join(",")}`);
    console.log(`   top: [${r.topRisk?.severity} ${r.topRisk?.check} ${r.topRisk?.venue}] ${r.topRisk?.quote?.slice(0, 140) ?? "-"}`);
    if (process.env.V) for (const f of r.flags) console.log(`     ${f.severity} ${f.check} ${f.venue}: ${f.quote?.slice(0, 100) ?? ""}`);
  } catch (e: any) { console.log(`${name} ERROR ${e.message}`); }
}

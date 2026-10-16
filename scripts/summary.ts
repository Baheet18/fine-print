import { readFileSync } from "node:fs";
import { analyze, load } from "../src/core/analyze.js";
const appId = readFileSync(`${process.env.HOME}/.agg/app_id`, "utf8").trim();
for (const a of process.argv.slice(2)) {
  const inp = JSON.parse(a); const t0 = Date.now();
  try {
    const r = analyze(await load(inp, appId), inp);
    console.log(`\n## ${a} | ${Date.now() - t0}ms\n${r.question}\nrisk ${r.riskScore} ${r.riskLevel} = venue ${r.venueRisk} + cross ${r.crossVenueRisk} | best ${r.bestVenue}`);
    for (const v of r.venues) console.log(`  ${v.venue} ${v.marketId} [${v.status}${v.matchedBy ? "/" + v.matchedBy : ""}] mid ${v.midpoint} allin ${v.allInYesCost} risk ${v.riskScore}`);
    console.log(`fair ${JSON.stringify(r.fairValue)}\n${r.decision.action.toUpperCase()} max ${r.decision.maxPrice} headroom ${r.decision.headroom}: ${r.decision.reason}`);
    console.log(`top: [${r.topRisk?.severity}] ${r.topRisk?.explanation}${r.topRisk?.quote ? ` | "${r.topRisk.quote.slice(0, 160)}"` : ""}`);
    for (const f of r.flags.filter((f) => f.venue === "cross-venue")) console.log(`  x ${f.severity}: ${f.explanation.slice(0, 260)}${f.quote ? ` | "${f.quote.slice(0, 120)}"` : ""}`);
    if (r.notes.length) console.log(`notes: ${r.notes.join(" / ")}`);
  } catch (e: any) { console.log(`\n## ${a} ERROR ${e.message}`); }
}

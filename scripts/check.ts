// CLI: tsx scripts/check.ts '{"kalshi":"KXFEDDECISION-26DEC-H25"}'
import { readFileSync } from "node:fs";
import { analyze, load } from "../src/core/analyze.js";
const appId = process.env.AGG_APP_ID ?? (() => { try { return readFileSync(`${process.env.HOME}/.agg/app_id`, "utf8").trim(); } catch { return undefined; } })();
const inp = JSON.parse(process.argv[2] ?? "{}"); const t0 = Date.now();
const r = analyze(await load(inp, process.env.NO_AGG ? undefined : appId), inp);
console.log(JSON.stringify({ ...r, latencyMs: Date.now() - t0 }, null, process.env.COMPACT ? 0 : 1));

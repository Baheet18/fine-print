// Fine Print PayBox plugin. Thin client for the Fine Print service:
//  - fine_print_check   -> x402 payment proposal for the paid check (PayBox asks the user, pays, returns the report)
//  - fine_print_preview -> free call: risk score + top risk only
// No secrets, no signing. Network host to allow: the Fine Print service host (FINE_PRINT_URL).
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { proposeX402, x402OutputSchema } from "./paybox.js";

const PROTOCOL_VERSION = "2026-07-28";
import { resolveServiceUrl } from "./config.js";
const serviceUrl = () => resolveServiceUrl();
const MAX_ATOMIC = process.env.FINE_PRINT_MAX_ATOMIC_USDC || "100000"; // 0.10 USDC ceiling; service charges 0.05

const marketInput = {
  polymarket: z.string().min(1).max(400).optional().describe("Polymarket market slug, URL or numeric id"),
  kalshi: z.string().min(1).max(200).optional().describe("Kalshi market ticker or URL, e.g. KXFEDDECISION-26DEC-H25"),
  question: z.string().min(3).max(300).optional().describe("Plain-language question when you have no id; matched via Agg search"),
};
const policyInput = {
  fairValue: z.number().min(0).max(1).optional().describe("Your own probability for YES (0-1). Without it Fine Print uses the cross-venue consensus and claims no edge."),
  maxRisk: z.number().int().min(0).max(100).optional().describe("User policy: skip any market whose resolution risk is at or above this (default 60)"),
  spend: z.number().min(1).max(10000).optional().describe("Intended spend in USD, used for the route quote (default 20)"),
};
type Args = { polymarket?: string; kalshi?: string; question?: string; fairValue?: number; maxRisk?: number; spend?: number };

function query(a: Args) {
  const p = new URLSearchParams();
  if (a.polymarket) p.set("polymarket", a.polymarket);
  if (a.kalshi) p.set("kalshi", a.kalshi);
  if (a.question) p.set("q", a.question);
  if (a.fairValue !== undefined) p.set("fairValue", String(a.fairValue));
  if (a.maxRisk !== undefined) p.set("maxRisk", String(a.maxRisk));
  if (a.spend !== undefined) p.set("spend", String(a.spend));
  return p.toString();
}
const needMarket = (a: Args) => !a.polymarket && !a.kalshi && !a.question;
const err = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

function createServer() {
  const server = new McpServer({ name: "fine-print", version: "1.0.0" }, { supportedProtocolVersions: [PROTOCOL_VERSION] });

  server.registerTool("fine_print_check", {
    title: "Fine Print: paid pre-trade check",
    description: "Run this before buying a prediction market. It proposes a paid x402 request (0.05 USDC on Base) to the Fine Print service. After the user approves, PayBox returns: a resolution-risk score from 0 to 100 with the exact risky sentence quoted and explained, YES prices and fees on each venue (Polymarket, Kalshi and others via Agg), the best venue, a fair-value range, and trade or skip with a risk-adjusted max price. Give a Polymarket and/or Kalshi market, or a question.",
    inputSchema: z.object({ ...marketInput, ...policyInput }).strict(),
    outputSchema: x402OutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (a) => {
    if (needMarket(a)) return err("Give polymarket, kalshi or question.");
    let base: string; try { base = serviceUrl(); } catch (e: any) { return err(e.message); }
    const r = proposeX402({ chain: "eip155:8453", url: `${base}/v1/check?${query(a)}`, maxAmount: MAX_ATOMIC });
    r.content = [{ type: "text", text: "Proposed a Fine Print check (up to 0.10 USDC; the service charges 0.05). After you approve, PayBox pays and returns the risk report and the trade-or-skip decision. Nothing has been paid yet." }];
    return r;
  });

  server.registerTool("fine_print_preview", {
    title: "Fine Print: free risk preview",
    description: "Free quick look: the resolution-risk score (0-100) and the main risk for a prediction market, without prices or a decision. Use fine_print_check for the full paid report.",
    inputSchema: z.object(marketInput).strict(),
    outputSchema: z.object({
      question: z.string().nullable(), riskScore: z.number(), riskLevel: z.string(),
      topRisk: z.object({ check: z.string(), severity: z.string(), venue: z.string(), explanation: z.string() }).nullable(),
      venues: z.array(z.string()),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => {
    if (needMarket(a)) return err("Give polymarket, kalshi or question.");
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(`${resolveServiceUrl()}/v1/preview?${query(a)}`, { headers: { accept: "application/json" }, signal: ctl.signal });
      const d: any = await res.json().catch(() => ({}));
      if (!res.ok) return err(`Fine Print: ${d.error ?? `HTTP ${res.status}`}`);
      const out = { question: d.question ?? null, riskScore: Number(d.riskScore), riskLevel: String(d.riskLevel), topRisk: d.topRisk ?? null, venues: Array.isArray(d.venues) ? d.venues.map(String) : [] };
      return { content: [{ type: "text", text: `Resolution risk ${out.riskScore}/100 (${out.riskLevel}).${out.topRisk ? ` ${out.topRisk.explanation}` : ""} Run fine_print_check for prices, the best venue and trade or skip.` }], structuredContent: out };
    } catch (e: any) { return err(`Fine Print unreachable: ${e?.name === "AbortError" ? "timed out" : e?.message}`); }
    finally { clearTimeout(t); }
  });
  return server;
}

serveStdio(createServer, { legacy: "reject" });

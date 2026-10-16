import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { analyze, load, preview, type CheckInput } from "./core/analyze.js";
import { config, paidMode } from "./config.js";

function input(q: Record<string, string>): CheckInput | string {
  const n = (k: string) => (q[k] !== undefined && q[k] !== "" ? Number(q[k]) : undefined);
  const inp: CheckInput = { polymarket: q.polymarket || undefined, kalshi: q.kalshi || undefined, q: q.q || undefined, fairValue: n("fairValue"), maxRisk: n("maxRisk"), spend: n("spend") };
  if (!inp.polymarket && !inp.kalshi && !inp.q) return "Give polymarket (slug, URL or id), kalshi (ticker or URL) or q (question text).";
  for (const [k, lo, hi] of [["fairValue", 0, 1], ["maxRisk", 0, 100], ["spend", 1, 10000]] as const) {
    const v = inp[k]; if (v !== undefined && (!Number.isFinite(v) || v < lo || v > hi)) return `${k} must be between ${lo} and ${hi}.`;
  }
  for (const k of ["polymarket", "kalshi", "q"] as const) if ((inp[k]?.length ?? 0) > 400) return `${k} is too long.`;
  return inp;
}

export function createApp() {
  const app = new Hono();
  app.get("/", (c) => c.json({
    product: "Fine Print", tagline: "A price is not a probability until it has been tested.",
    what: "Pre-trade check for prediction-market agents: resolution-risk score, best venue after fees, and trade or skip with a risk-adjusted max price.",
    endpoints: { "GET /v1/check": `paid (${config.price} USDC via x402${paidMode() ? "" : ", currently in unpaid dev mode"})`, "GET /v1/preview": "free: risk score and top risk only", "GET /health": "status" },
    params: { polymarket: "slug, URL or numeric id", kalshi: "market ticker or URL", q: "free-text question (Agg search)", fairValue: "0-1, your own probability", maxRisk: "0-100, skip above this (default 60)", spend: "USD for the route quote (default 20)" },
    data: "Market data from Agg.market (agg.market) with Polymarket/Kalshi public API fallback.",
  }));
  app.get("/health", (c) => c.json({ ok: true, paid: paidMode(), network: config.network, price: config.price, agg: !!config.aggAppId }));

  if (paidMode()) {
    const fc = config.facilitatorUrl ? new HTTPFacilitatorClient({ url: config.facilitatorUrl }) : new HTTPFacilitatorClient(createFacilitatorConfig(config.cdpKeyId, config.cdpKeySecret));
    const rs = new x402ResourceServer(fc).register(config.network, new ExactEvmScheme());
    app.use(paymentMiddleware({ "GET /v1/check": { accepts: [{ scheme: "exact", price: config.price, network: config.network, payTo: config.payTo, maxTimeoutSeconds: 120 }],
      description: "Fine Print pre-trade check: resolution risk, best venue, trade or skip", mimeType: "application/json" } }, rs));
  }

  const run = async (q: Record<string, string>) => {
    const inp = input(q); if (typeof inp === "string") return { status: 400 as const, body: { error: inp } };
    const t0 = Date.now();
    try { const r = analyze(await load(inp, config.aggAppId), inp); return { status: 200 as const, body: { ...r, latencyMs: Date.now() - t0 } }; }
    catch (e: any) { return { status: 502 as const, body: { error: String(e?.message ?? e) } }; }
  };
  app.get("/v1/check", async (c) => { const r = await run(c.req.query()); if (!paidMode()) c.header("x-fine-print-mode", "unpaid-dev"); return c.json(r.body, r.status); });
  app.get("/v1/preview", async (c) => { const r = await run(c.req.query()); return c.json(r.status === 200 ? preview(r.body as any) : r.body, r.status); });
  return app;
}

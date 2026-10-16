// node harness/call.mjs <tool> '<json args>'  — one fresh plugin process per call, like the PayBox sandbox
import { spawn } from "node:child_process";
const [tool, args] = [process.argv[2], JSON.parse(process.argv[3] ?? "{}")];
const t0 = Date.now(); const c = spawn(process.execPath, ["dist/plugin.mjs"], { env: process.env }); let buf = "";
const res = await new Promise((ok) => { c.stdout.on("data", (d) => { buf += d; const l = buf.split("\n").find((x) => x.includes('"id":2')); if (l) ok(JSON.parse(l)); });
  c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "h", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) + "\n"); });
c.kill(); console.log(`${tool} wall ${Date.now() - t0}ms`); console.log(JSON.stringify(res.result, null, 1));

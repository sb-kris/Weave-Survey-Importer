/**
 * Netlify Function: catch-all for /api/*.
 *
 * Builds its own minimal Express app instead of importing src/app.ts. The
 * full app pulls in pino-http + pino + pino-pretty, and pino's worker-thread
 * model doesn't survive being bundled into a Lambda artifact reliably — it
 * surfaces as 502 Bad Gateway with "No log" in Netlify's observability.
 *
 * Local `pnpm dev` continues to use src/app.ts and gets pino logging as
 * before. Netlify already provides per-request observability for functions,
 * so we don't need pino-http here.
 *
 * Routing in netlify.toml proxies /api/*  ->  /.netlify/functions/api/api/:splat
 * with status 200 + force = true. The leading /api/ is preserved so the
 * router below matches without any path rewriting.
 */
import express from "express";
import cors from "cors";
import serverless from "serverless-http";
import surveysparrowRouter from "../../src/routes/surveysparrow.js";
import llmRouter from "../../src/routes/llm.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api", surveysparrowRouter);
// Optional LLM formatter route (BYO key, see src/routes/llm.ts).
app.use("/api", llmRouter);

// serverless-http returns a Lambda-compatible handler. Netlify Functions use
// the same interface, so this drops in directly.
export const handler = serverless(app);

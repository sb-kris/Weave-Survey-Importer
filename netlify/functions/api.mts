/**
 * Netlify Function: catch-all for /api/*.
 *
 * Weave ships as a static frontend + an Express backend. On Netlify the
 * backend can't run as a long-lived process, so we wrap the existing
 * Express app with serverless-http and serve every /api/* request through
 * a single Lambda-style function. Local `pnpm dev` is unaffected — the
 * tsx-watched Express server still runs as before.
 *
 * Routing is set up in netlify.toml:
 *   /api/*  →  /.netlify/functions/api/api/:splat   (status 200, proxy)
 * That preserves the leading /api so Express's app.use("/api", router)
 * matches without any path rewriting here.
 */
import serverless from "serverless-http";
import app from "../../src/app.js";

// serverless-http returns a Lambda-compatible handler. Netlify Functions
// expose the same interface as AWS Lambda v1, so this drops in directly.
export const handler = serverless(app);

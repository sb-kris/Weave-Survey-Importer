import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./lib/logger.js";
import surveysparrowRouter from "./routes/surveysparrow.js";
import llmRouter from "./routes/llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// public/ sits next to src/ at the project root, and index.html lives at the
// project root one level above src/.
const projectRoot = path.resolve(__dirname, "..");
const publicDir = path.resolve(projectRoot, "public");
const indexHtmlPath = path.resolve(projectRoot, "index.html");

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Health
app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// SurveySparrow routes
app.use("/api", surveysparrowRouter);

// Optional LLM formatter route (BYO key). Independent of the SurveySparrow
// router so the import flow never depends on LLM availability.
app.use("/api", llmRouter);

// Static assets — images, sounds, etc. live under public/.
app.use(express.static(publicDir));

// The UI HTML lives at the project root (one level above src/, not inside
// public/) so it sits next to the README and is easy to spot. Serve it
// directly for "/" rather than relying on express.static to discover it.
app.get("/", (_req, res) => {
  res.sendFile(indexHtmlPath);
});

export default app;

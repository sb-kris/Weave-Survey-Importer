import pino from "pino";

// pino-pretty runs in a Worker thread, which doesn't initialize reliably
// inside bundled serverless functions (Netlify Functions, AWS Lambda). A
// failure there can crash the request middleware before Express even sees
// the route — surfacing as empty/garbled responses to the browser. Detect
// the serverless context and skip pretty-printing there.
const isServerless = !!(
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.NETLIFY ||
  process.env.LAMBDA_TASK_ROOT
);
const usePretty = !isServerless && process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(usePretty
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l" },
        },
      }
    : {}),
});

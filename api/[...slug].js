// Vercel catch-all for /api/* requests. Delegates to the same handler used by
// the local dev server (server.mjs) so logic isn't duplicated.
import { handleRequest } from "../server.mjs";

export const config = {
  // Body parsing must be off — handleRequest reads the request stream itself.
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  try {
    await handleRequest(req, res);
  } catch (error) {
    // Surface the error in Vercel's function logs so we can diagnose.
    console.error("Catch-all handler crashed:", error?.stack || error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: error?.message || "Internal server error" }));
    }
  }
}

// Vercel catch-all for /api/* requests. Imports the shared handler from a
// local sibling file (./_handler.js) — keeps the import path simple and
// avoids any cross-folder bundling quirks.
import { handleRequest } from "./_handler.js";

export default async function handler(req, res) {
  try {
    await handleRequest(req, res);
  } catch (error) {
    console.error("Catch-all handler crashed:", error?.stack || error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: error?.message || "Internal server error" }));
    }
  }
}

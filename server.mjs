// Local dev server. Loads .env, then delegates every request to the same
// handler that Vercel uses (api/_handler.js). Run with `npm start`.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

try {
  const envFile = readFileSync(join(root, ".env"), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, "");
  }
} catch {
  // .env is optional; production hosts set env vars directly.
}

const { handleRequest } = await import("./api/_handler.js");

const port = Number(process.env.PORT || 5173);
createServer(handleRequest).listen(port, () => {
  console.log(`Bike Route Maker running at http://localhost:${port}`);
});

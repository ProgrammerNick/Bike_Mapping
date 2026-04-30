import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = dirname(fileURLToPath(import.meta.url));
const scrypt = promisify(scryptCallback);
let sqlPromise;

try {
  const envFile = readFileSync(join(root, ".env"), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, "");
  }
} catch {
  // .env is optional; production hosts usually set environment variables directly.
}

const port = Number(process.env.PORT || 5173);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

async function getSql() {
  if (!process.env.DATABASE_URL) return null;
  if (!sqlPromise) {
    sqlPromise = import("@neondatabase/serverless").then(({ neon }) => neon(process.env.DATABASE_URL));
  }
  return sqlPromise;
}

async function migrate() {
  const sql = await getSql();
  if (!sql) return;
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      start_point JSONB NOT NULL,
      end_point JSONB NOT NULL,
      route_geojson JSONB NOT NULL,
      distance_meters DOUBLE PRECISION,
      duration_seconds DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [salt, key] = stored.split(":");
  const derived = await scrypt(password, salt, 64);
  const storedBuffer = Buffer.from(key, "hex");
  return storedBuffer.length === derived.length && timingSafeEqual(storedBuffer, derived);
}

function publicUser(user) {
  return { id: user.id, email: user.email, createdAt: user.created_at };
}

async function requireUser(request, response) {
  const sql = await getSql();
  if (!sql) {
    sendJson(response, 503, { error: "Database is not configured. Set DATABASE_URL to your Neon connection string." });
    return null;
  }
  const auth = request.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) {
    sendJson(response, 401, { error: "Sign in required." });
    return null;
  }
  const rows = await sql`
    SELECT users.id, users.email, users.created_at
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ${hashToken(token)}
      AND sessions.expires_at > now()
    LIMIT 1
  `;
  if (!rows.length) {
    sendJson(response, 401, { error: "Session expired. Please sign in again." });
    return null;
  }
  return rows[0];
}

async function handleApi(request, response, url) {
  const sql = await getSql();
  if (url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, databaseConfigured: Boolean(sql) });
    return true;
  }

  if (!sql) {
    sendJson(response, 503, { error: "Database is not configured. Set DATABASE_URL to your Neon connection string." });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/signup") {
    const { email, password } = await readJson(request);
    if (!email || !password || password.length < 8) {
      sendJson(response, 400, { error: "Email and an 8+ character password are required." });
      return true;
    }
    try {
      const id = randomUUID();
      const rows = await sql`
        INSERT INTO users (id, email, password_hash)
        VALUES (${id}, ${email.toLowerCase().trim()}, ${await hashPassword(password)})
        RETURNING id, email, created_at
      `;
      const token = await createSession(sql, id);
      sendJson(response, 201, { user: publicUser(rows[0]), token });
    } catch (error) {
      sendJson(response, 409, { error: "That email is already registered." });
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const { email, password } = await readJson(request);
    const rows = await sql`SELECT * FROM users WHERE email = ${String(email || "").toLowerCase().trim()} LIMIT 1`;
    if (!rows.length || !(await verifyPassword(password || "", rows[0].password_hash))) {
      sendJson(response, 401, { error: "Invalid email or password." });
      return true;
    }
    const token = await createSession(sql, rows[0].id);
    sendJson(response, 200, { user: publicUser(rows[0]), token });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const auth = request.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token) await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/me") {
    const user = await requireUser(request, response);
    if (user) sendJson(response, 200, { user: publicUser(user) });
    return true;
  }

  if (url.pathname === "/api/trips" && request.method === "GET") {
    const user = await requireUser(request, response);
    if (!user) return true;
    const rows = await sql`
      SELECT id, name, provider, start_point, end_point, distance_meters, duration_seconds, created_at, updated_at
      FROM trips
      WHERE user_id = ${user.id}
      ORDER BY updated_at DESC
    `;
    sendJson(response, 200, { trips: rows.map(formatTripSummary) });
    return true;
  }

  if (url.pathname === "/api/trips" && request.method === "POST") {
    const user = await requireUser(request, response);
    if (!user) return true;
    const body = await readJson(request);
    if (!body.routeGeojson || !body.start || !body.end) {
      sendJson(response, 400, { error: "Route, start, and destination are required." });
      return true;
    }
    const id = randomUUID();
    const rows = await sql`
      INSERT INTO trips (id, user_id, name, provider, start_point, end_point, route_geojson, distance_meters, duration_seconds)
      VALUES (
        ${id},
        ${user.id},
        ${String(body.name || "Untitled ride").slice(0, 120)},
        ${String(body.provider || "unknown").slice(0, 80)},
        ${JSON.stringify(body.start)}::jsonb,
        ${JSON.stringify(body.end)}::jsonb,
        ${JSON.stringify(body.routeGeojson)}::jsonb,
        ${Number(body.distanceMeters || 0)},
        ${Number(body.durationSeconds || 0)}
      )
      RETURNING *
    `;
    sendJson(response, 201, { trip: formatTrip(rows[0]) });
    return true;
  }

  const tripMatch = url.pathname.match(/^\/api\/trips\/([^/]+)$/);
  if (tripMatch && request.method === "GET") {
    const user = await requireUser(request, response);
    if (!user) return true;
    const rows = await sql`SELECT * FROM trips WHERE id = ${tripMatch[1]} AND user_id = ${user.id} LIMIT 1`;
    if (!rows.length) sendJson(response, 404, { error: "Trip not found." });
    else sendJson(response, 200, { trip: formatTrip(rows[0]) });
    return true;
  }

  if (tripMatch && request.method === "DELETE") {
    const user = await requireUser(request, response);
    if (!user) return true;
    await sql`DELETE FROM trips WHERE id = ${tripMatch[1]} AND user_id = ${user.id}`;
    sendJson(response, 200, { ok: true });
    return true;
  }

  sendJson(response, 404, { error: "API route not found." });
  return true;
}

async function createSession(sql, userId) {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  await sql`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (${hashToken(token)}, ${userId}, ${expires})
  `;
  return token;
}

function formatTripSummary(trip) {
  return {
    id: trip.id,
    name: trip.name,
    provider: trip.provider,
    start: trip.start_point,
    end: trip.end_point,
    distanceMeters: trip.distance_meters,
    durationSeconds: trip.duration_seconds,
    createdAt: trip.created_at,
    updatedAt: trip.updated_at,
  };
}

function formatTrip(trip) {
  return {
    ...formatTripSummary(trip),
    routeGeojson: trip.route_geojson,
  };
}

createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    try {
      if (await handleApi(request, response, url)) return;
    } catch (error) {
      sendJson(response, 500, { error: error.message || "Unexpected server error." });
      return;
    }
  }

  const safePath = normalize(url.pathname === "/" ? "index.html" : url.pathname.replace(/^[/\\]/, "")).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, safePath);

  try {
    const body = await readFile(filePath);
    response.writeHead(200, { "Content-Type": types[extname(filePath)] || "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(port, async () => {
  try {
    await migrate();
  } catch (error) {
    console.warn(`Database migration skipped/failed: ${error.message}`);
  }
  console.log(`Bike Route Maker running at http://localhost:${port}`);
});

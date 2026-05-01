// Shared request handler used by both the local dev server (server.mjs)
// and the Vercel serverless function (api/[...slug].js). The leading
// underscore in the filename tells Vercel not to expose this as a route.

import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Static files live in /public/ (Vercel's idiomatic convention; also keeps
// browser code out of the function bundle). api/ → ../public/
const publicRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const scrypt = promisify(scryptCallback);
let sqlPromise;

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
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
      stops JSONB,
      route_geojson JSONB NOT NULL,
      distance_meters DOUBLE PRECISION,
      duration_seconds DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`ALTER TABLE trips ADD COLUMN IF NOT EXISTS stops JSONB`;
  await sql`
    CREATE TABLE IF NOT EXISTS favorites (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      label TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      window_start TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_GUEST = 30;
const RATE_LIMIT_USER = 200;

function clientIp(request) {
  const fwd = request.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return request.socket?.remoteAddress || "unknown";
}

// In local dev there's no proxy, every request is from 127.0.0.1, and per-IP
// rate limiting is meaningless. Detect prod (Vercel etc.) by checking for an
// X-Forwarded-For header — present in production, absent locally.
function shouldRateLimit(request) {
  return Boolean(request.headers["x-forwarded-for"]);
}

async function checkRateLimit(sql, key, limit) {
  const rows = await sql`SELECT count, window_start FROM rate_limits WHERE key = ${key}`;
  const now = new Date();
  if (!rows.length) {
    await sql`INSERT INTO rate_limits (key, count, window_start) VALUES (${key}, 1, ${now.toISOString()})`;
    return { ok: true, remaining: limit - 1 };
  }
  const row = rows[0];
  const windowStart = new Date(row.window_start);
  const windowEnd = new Date(windowStart.getTime() + RATE_WINDOW_MS);
  if (now > windowEnd) {
    await sql`UPDATE rate_limits SET count = 1, window_start = ${now.toISOString()} WHERE key = ${key}`;
    return { ok: true, remaining: limit - 1 };
  }
  if (row.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((windowEnd.getTime() - now.getTime()) / 1000));
    return { ok: false, retryAfter: retryAfterSeconds };
  }
  await sql`UPDATE rate_limits SET count = count + 1 WHERE key = ${key}`;
  return { ok: true, remaining: limit - row.count - 1 };
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
    sendJson(response, 200, {
      ok: true,
      databaseConfigured: Boolean(sql),
      routingConfigured: Boolean(process.env.ORS_API_KEY),
      mapboxConfigured: Boolean(process.env.MAPBOX_TOKEN),
    });
    return true;
  }

  if (url.pathname === "/api/config" && request.method === "GET") {
    // Public tokens only — never expose secret keys here. Mapbox public tokens
    // are designed to live in browser code with URL restrictions.
    sendJson(response, 200, {
      mapboxToken: process.env.MAPBOX_TOKEN || null,
    });
    return true;
  }

  if (url.pathname === "/api/route" && request.method === "POST") {
    const orsKey = process.env.ORS_API_KEY;
    if (!orsKey) {
      sendJson(response, 503, { error: "Routing is not configured on the server." });
      return true;
    }
    const body = await readJson(request);
    if (!Array.isArray(body.coordinates) || body.coordinates.length < 2) {
      sendJson(response, 400, { error: "Need at least 2 coordinates." });
      return true;
    }

    // Rate limit: signed-in users get a higher cap, guests are limited per IP.
    // Only apply in production (Vercel), where X-Forwarded-For gives us the
    // real client IP. In local dev all requests look like 127.0.0.1 so the
    // limit would just block your own browser after a few requests.
    if (sql && shouldRateLimit(request)) {
      const auth = request.headers.authorization || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      let user = null;
      if (token) {
        const userRows = await sql`
          SELECT users.id FROM sessions JOIN users ON users.id = sessions.user_id
          WHERE sessions.token_hash = ${hashToken(token)} AND sessions.expires_at > now() LIMIT 1
        `;
        user = userRows[0] || null;
      }
      const key = user ? `user:${user.id}` : `ip:${clientIp(request)}`;
      const limit = user ? RATE_LIMIT_USER : RATE_LIMIT_GUEST;
      const result = await checkRateLimit(sql, key, limit);
      if (!result.ok) {
        response.writeHead(429, {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(result.retryAfter),
        });
        response.end(JSON.stringify({
          error: user
            ? `Rate limit reached (${RATE_LIMIT_USER} routes/hour). Try again in ${Math.ceil(result.retryAfter / 60)} minute(s).`
            : `Guest rate limit reached (${RATE_LIMIT_GUEST} routes/hour). Sign in for ${RATE_LIMIT_USER}/hour, or try again in ${Math.ceil(result.retryAfter / 60)} minute(s).`,
        }));
        return true;
      }
    }

    const allowedProfiles = new Set(["cycling-regular", "cycling-road", "cycling-electric", "cycling-mountain"]);
    const profile = allowedProfiles.has(body.profile) ? body.profile : "cycling-regular";
    const allowedPrefs = new Set(["recommended", "shortest", "fastest"]);
    const preference = allowedPrefs.has(body.preference) ? body.preference : "recommended";
    try {
      const orsResponse = await fetch(`https://api.openrouteservice.org/v2/directions/${profile}/geojson`, {
        method: "POST",
        headers: {
          Accept: "application/json, application/geo+json",
          "Content-Type": "application/json",
          Authorization: orsKey,
        },
        body: JSON.stringify({
          coordinates: body.coordinates,
          preference,
          elevation: true,
          instructions: true,
          units: "mi",
        }),
      });
      if (!orsResponse.ok) {
        const detail = await orsResponse.text();
        sendJson(response, orsResponse.status, { error: `Routing failed: ${detail.slice(0, 240)}` });
        return true;
      }
      const geojson = await orsResponse.json();
      response.writeHead(200, { "Content-Type": "application/geo+json" });
      response.end(JSON.stringify(geojson));
    } catch (error) {
      sendJson(response, 502, { error: `Could not reach routing service: ${error.message}` });
    }
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
      SELECT id, name, provider, start_point, end_point, stops, distance_meters, duration_seconds, created_at, updated_at
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
    const stops = Array.isArray(body.stops) && body.stops.length >= 2 ? body.stops : [body.start, body.end];
    const id = randomUUID();
    const rows = await sql`
      INSERT INTO trips (id, user_id, name, provider, start_point, end_point, stops, route_geojson, distance_meters, duration_seconds)
      VALUES (
        ${id},
        ${user.id},
        ${String(body.name || "Untitled ride").slice(0, 120)},
        ${String(body.provider || "unknown").slice(0, 80)},
        ${JSON.stringify(body.start)}::jsonb,
        ${JSON.stringify(body.end)}::jsonb,
        ${JSON.stringify(stops)}::jsonb,
        ${JSON.stringify(body.routeGeojson)}::jsonb,
        ${Number(body.distanceMeters || 0)},
        ${Number(body.durationSeconds || 0)}
      )
      RETURNING *
    `;
    sendJson(response, 201, { trip: formatTrip(rows[0]) });
    return true;
  }

  if (url.pathname === "/api/favorites" && request.method === "GET") {
    const user = await requireUser(request, response);
    if (!user) return true;
    const rows = await sql`
      SELECT id, name, lat, lng, label, created_at
      FROM favorites
      WHERE user_id = ${user.id}
      ORDER BY name ASC
    `;
    sendJson(response, 200, { favorites: rows.map(formatFavorite) });
    return true;
  }

  if (url.pathname === "/api/favorites" && request.method === "POST") {
    const user = await requireUser(request, response);
    if (!user) return true;
    const body = await readJson(request);
    const name = String(body.name || "").trim().slice(0, 80);
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      sendJson(response, 400, { error: "Favorite needs a name and valid coordinates." });
      return true;
    }
    const id = randomUUID();
    const rows = await sql`
      INSERT INTO favorites (id, user_id, name, lat, lng, label)
      VALUES (${id}, ${user.id}, ${name}, ${lat}, ${lng}, ${String(body.label || "").slice(0, 240) || null})
      RETURNING id, name, lat, lng, label, created_at
    `;
    sendJson(response, 201, { favorite: formatFavorite(rows[0]) });
    return true;
  }

  const favoriteMatch = url.pathname.match(/^\/api\/favorites\/([^/]+)$/);
  if (favoriteMatch && request.method === "DELETE") {
    const user = await requireUser(request, response);
    if (!user) return true;
    await sql`DELETE FROM favorites WHERE id = ${favoriteMatch[1]} AND user_id = ${user.id}`;
    sendJson(response, 200, { ok: true });
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
    stops: trip.stops || [trip.start_point, trip.end_point],
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

function formatFavorite(row) {
  return {
    id: row.id,
    name: row.name,
    lat: row.lat,
    lng: row.lng,
    label: row.label,
    createdAt: row.created_at,
  };
}

// On Vercel, multiple invocations share the same Node instance until cold
// reload. Migrations are idempotent (CREATE TABLE IF NOT EXISTS) but we only
// run them once per instance to avoid wasted Postgres calls.
let migratePromise = null;
async function ensureMigrated() {
  if (!migratePromise) migratePromise = migrate().catch((err) => {
    console.warn("Migration failed:", err.message);
    migratePromise = null; // allow retry on next request
  });
  return migratePromise;
}

export async function handleRequest(request, response) {
  await ensureMigrated();
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    try {
      if (await handleApi(request, response, url)) return;
    } catch (error) {
      console.error("Handler error:", error);
      sendJson(response, 500, { error: error.message || "Unexpected server error." });
      return;
    }
    return;
  }

  // Static file serving — only used in local dev. On Vercel, /api/[[...slug]]
  // never receives non-API paths because static files are CDN-served directly.
  const safePath = normalize(url.pathname === "/" ? "index.html" : url.pathname.replace(/^[/\\]/, "")).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicRoot, safePath);

  try {
    const body = await readFile(filePath);
    const ext = extname(filePath);
    const headers = { "Content-Type": types[ext] || "application/octet-stream" };
    if (ext === ".html" || ext === ".js" || ext === ".css") {
      headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";
      headers.Pragma = "no-cache";
      headers.Expires = "0";
    }
    response.writeHead(200, headers);
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}


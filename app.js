/* ---------- Map init ---------- */

if (typeof L === "undefined") {
  document.body.insertAdjacentHTML(
    "afterbegin",
    '<div style="position:fixed;top:0;left:0;right:0;z-index:99999;padding:12px 16px;background:#fae8e3;color:#8a2f25;font:600 14px system-ui">Map library failed to load. Refresh the page; if it persists, check your network.</div>'
  );
}

const map = (typeof L !== "undefined")
  ? L.map("map", { zoomControl: false }).setView([40.73061, -73.935242], 12)
  : null;
if (map) L.control.zoom({ position: "bottomright" }).addTo(map);

/* ---------- Tile layers ---------- */

const OSM_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const CARTO_ATTR = `${OSM_ATTR} &copy; <a href="https://carto.com/attributions">CARTO</a>`;
const MAPBOX_ATTR = '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> ' + OSM_ATTR;

const tileSources = {
  positron: () =>
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19, subdomains: "abcd", attribution: CARTO_ATTR,
    }),
  voyager: () =>
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      maxZoom: 19, subdomains: "abcd", attribution: CARTO_ATTR,
    }),
  dark: () =>
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19, subdomains: "abcd", attribution: CARTO_ATTR,
    }),
  osm: () =>
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: OSM_ATTR,
    }),
  "mapbox-outdoors": (token) =>
    L.tileLayer(
      `https://api.mapbox.com/styles/v1/mapbox/outdoors-v12/tiles/256/{z}/{x}/{y}@2x?access_token=${encodeURIComponent(token)}`,
      { maxZoom: 20, attribution: MAPBOX_ATTR }
    ),
  "mapbox-streets": (token) =>
    L.tileLayer(
      `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/256/{z}/{x}/{y}@2x?access_token=${encodeURIComponent(token)}`,
      { maxZoom: 20, attribution: MAPBOX_ATTR }
    ),
};

const tileStyleSelect = document.querySelector("#tileStyleSelect");

let activeTileLayer = null;
let activeTileKey = null;
let mapboxToken = ""; // populated from /api/config on init

function applyTileStyle(key) {
  if (!map) return;
  let resolvedKey = key;
  if (resolvedKey.startsWith("mapbox-") && !mapboxToken) resolvedKey = "positron";
  const factory = tileSources[resolvedKey] || tileSources.positron;
  const layer = factory(mapboxToken);
  if (activeTileLayer) map.removeLayer(activeTileLayer);
  layer.addTo(map);
  activeTileLayer = layer;
  activeTileKey = resolvedKey;
  localStorage.setItem("bikeRouteTileStyle", resolvedKey);
  if (tileStyleSelect && tileStyleSelect.value !== resolvedKey) tileStyleSelect.value = resolvedKey;

  let errors = 0;
  layer.on("tileerror", () => {
    errors += 1;
    if (errors > 4 && activeTileLayer === layer && resolvedKey !== "osm") applyTileStyle("osm");
  });
}

function refreshMapboxOptions() {
  if (!tileStyleSelect) return;
  for (const opt of tileStyleSelect.options) {
    if (opt.value.startsWith("mapbox-")) opt.hidden = !mapboxToken;
  }
}

// Load the server-provided Mapbox token on startup. If set, the Mapbox
// styles auto-appear in the picker and the user can switch to them.
fetch("/api/config")
  .then((r) => r.json())
  .then((cfg) => {
    mapboxToken = cfg.mapboxToken || "";
    refreshMapboxOptions();
    // If user previously chose a Mapbox style and the token just became
    // available, switch back to it.
    const saved = localStorage.getItem("bikeRouteTileStyle") || "positron";
    if (saved.startsWith("mapbox-") && mapboxToken && activeTileKey !== saved) {
      applyTileStyle(saved);
    }
  })
  .catch(() => {
    /* config fetch failure is non-fatal — non-Mapbox styles still work */
  });

try {
  refreshMapboxOptions();
  applyTileStyle(localStorage.getItem("bikeRouteTileStyle") || "positron");
} catch (error) {
  console.error("Tile init failed:", error);
}

if (tileStyleSelect) {
  tileStyleSelect.addEventListener("change", () => applyTileStyle(tileStyleSelect.value));
}

/* ---------- DOM refs ---------- */

const stopsListEl = document.querySelector("#stopsList");
const addStopBtn = document.querySelector("#addStopBtn");
const profileSelect = document.querySelector("#profileSelect");
const preferenceSelect = document.querySelector("#preferenceSelect");
const message = document.querySelector("#message");
const distanceStat = document.querySelector("#distanceStat");
const timeStat = document.querySelector("#timeStat");
const climbStat = document.querySelector("#climbStat");
const stepsList = document.querySelector("#stepsList");
const elevationFigure = document.querySelector("#elevationFigure");
const elevationChart = document.querySelector("#elevationChart");
const elevationRange = document.querySelector("#elevationRange");
const downloadGeojsonBtn = document.querySelector("#downloadGeojsonBtn");
const downloadGpxBtn = document.querySelector("#downloadGpxBtn");
const saveTripBtn = document.querySelector("#saveTripBtn");
const tripNameInput = document.querySelector("#tripNameInput");
const tripsList = document.querySelector("#tripsList");
const favoritesList = document.querySelector("#favoritesList");
const tripsSection = document.querySelector("#tripsSection");
const accountSection = document.querySelector("#accountSection");
const accountStatus = document.querySelector("#accountStatus");
const accountHeading = document.querySelector("#accountHeading");
const authForm = document.querySelector("#authForm");
const emailInput = document.querySelector("#emailInput");
const passwordInput = document.querySelector("#passwordInput");
const signupBtn = document.querySelector("#signupBtn");
const logoutBtn = document.querySelector("#logoutBtn");

/* ---------- State ---------- */

const state = {
  stops: [emptyStop(), emptyStop()],
  routeGeojson: null,
  trips: loadFromStorage("bikeRouteTrips", []),
  favorites: loadFromStorage("bikeRouteFavorites", []),
};

const stopMarkers = [];
let routeLayer = null;
let previewLayer = null;
let authToken = localStorage.getItem("bikeRouteToken") || "";
let currentUser = null;


/* ---------- Helpers ---------- */

function emptyStop() {
  return { lat: null, lng: null, label: "" };
}

function isStopFilled(stop) {
  return stop && Number.isFinite(stop.lat) && Number.isFinite(stop.lng);
}

function loadFromStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function saveToStorage(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function uid() {
  return Math.random().toString(36).slice(2, 11);
}

function setMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

function formatDistance(meters) {
  const miles = meters / 1609.344;
  return `${miles.toFixed(miles >= 10 ? 0 : 1)} mi`;
}

function formatDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}h ${rest}m` : `${rest}m`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char];
  });
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char];
  });
}

function stopRoleLabel(index) {
  if (index === 0) return "A";
  if (index === state.stops.length - 1) return "B";
  return String(index);
}

function stopRoleName(index) {
  if (index === 0) return "Start";
  if (index === state.stops.length - 1) return "Destination";
  return `Stop ${index}`;
}

/* ---------- Stops UI ---------- */

function favoriteIdForStop(stop) {
  if (!isStopFilled(stop)) return null;
  return state.favorites.find((f) => Math.abs(f.lat - stop.lat) < 1e-5 && Math.abs(f.lng - stop.lng) < 1e-5)?.id || null;
}

function renderStops() {
  stopsListEl.innerHTML = state.stops
    .map((stop, index) => {
      const role = index === 0 ? "start" : index === state.stops.length - 1 ? "end" : "via";
      const removable = state.stops.length > 2;
      const isSaved = Boolean(favoriteIdForStop(stop));
      return `
        <div class="stop-row" data-kind="${role}" data-index="${index}">
          <span class="stop-label" aria-hidden="true">${stopRoleLabel(index)}</span>
          <input
            type="text"
            value="${escapeHtml(stop.label || "")}"
            placeholder="${stopRoleName(index)} address, place, or click map"
            aria-label="${stopRoleName(index)}"
            data-stop-input="${index}"
            autocomplete="off"
          />
          <button type="button" class="stop-fav ${isSaved ? "is-saved" : ""}" data-stop-fav="${index}" title="${isSaved ? "Saved as favorite" : "Save as favorite"}" aria-label="Save ${stopRoleName(index)} as favorite">★</button>
          <button type="button" class="stop-remove" data-stop-remove="${index}" title="Remove this stop" aria-label="Remove ${stopRoleName(index)}" ${removable ? "" : "disabled"}>×</button>
          <div class="stop-suggestions" data-stop-suggestions="${index}" hidden></div>
        </div>
      `;
    })
    .join("");
}

function ensureMarkers() {
  if (!map) return;
  while (stopMarkers.length < state.stops.length) {
    const marker = L.marker([0, 0], { draggable: true });
    marker.on("dragend", (event) => {
      const pos = event.target.getLatLng();
      const i = stopMarkers.indexOf(marker);
      if (i < 0) return;
      state.stops[i] = { lat: pos.lat, lng: pos.lng, label: `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}` };
      state.routeGeojson = null;
      const input = stopsListEl.querySelector(`[data-stop-input="${i}"]`);
      if (input) input.value = state.stops[i].label;
      drawPreview();
    });
    stopMarkers.push(marker);
  }
  while (stopMarkers.length > state.stops.length) {
    stopMarkers.pop().remove();
  }
  state.stops.forEach((stop, i) => {
    const marker = stopMarkers[i];
    if (isStopFilled(stop)) {
      marker.setLatLng([stop.lat, stop.lng]).addTo(map).bindPopup(stopRoleName(i));
    } else {
      marker.remove();
    }
  });
}

function refreshStopsUi() {
  renderStops();
  ensureMarkers();
  drawPreview();
}

function setStop(index, point) {
  if (index < 0 || index >= state.stops.length) return;
  state.stops[index] = { lat: point.lat, lng: point.lng, label: point.label || `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}` };
  state.routeGeojson = null;
  refreshStopsUi();
}

function addStop() {
  const insertAt = state.stops.length >= 2 ? state.stops.length - 1 : state.stops.length;
  state.stops.splice(insertAt, 0, emptyStop());
  refreshStopsUi();
  setMessage("Added a stop. Type an address or click the map to fill it.");
}

function removeStop(index) {
  if (state.stops.length <= 2) return;
  state.stops.splice(index, 1);
  state.routeGeojson = null;
  refreshStopsUi();
}

function nextEmptyStopIndex() {
  for (let i = 0; i < state.stops.length; i++) {
    if (!isStopFilled(state.stops[i])) return i;
  }
  return -1;
}

function drawPreview() {
  if (!map) return;
  if (previewLayer) {
    previewLayer.remove();
    previewLayer = null;
  }
  if (state.routeGeojson) return;
  const filled = state.stops.filter(isStopFilled);
  if (filled.length < 2) return;
  previewLayer = L.polyline(
    filled.map((s) => [s.lat, s.lng]),
    { color: "#6d7a76", dashArray: "6 8", weight: 4 }
  ).addTo(map);
  map.fitBounds(previewLayer.getBounds(), { padding: [40, 40] });
}

/* ---------- Photon autocomplete ---------- */

const photonCache = new Map();
let suggestionAbortController = null;
let suggestionDebounce = null;

async function fetchPhoton(query) {
  if (photonCache.has(query)) return photonCache.get(query);
  if (suggestionAbortController) suggestionAbortController.abort();
  suggestionAbortController = new AbortController();
  const center = map ? map.getCenter() : { lat: 40.7, lng: -73.9 };
  const params = new URLSearchParams({
    q: query,
    limit: "6",
    lat: center.lat.toFixed(4),
    lon: center.lng.toFixed(4),
  });
  const response = await fetch(`https://photon.komoot.io/api/?${params.toString()}`, {
    signal: suggestionAbortController.signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Autocomplete failed (${response.status})`);
  const data = await response.json();
  photonCache.set(query, data.features || []);
  return data.features || [];
}

function describeFeature(feature) {
  const p = feature.properties || {};
  const primary = p.name || p.street || "Unnamed place";
  const parts = [
    p.housenumber && p.street ? `${p.housenumber} ${p.street}` : null,
    p.city || p.town || p.village,
    p.state,
    p.country,
  ].filter(Boolean);
  return { primary, secondary: parts.join(" · ") };
}

function showSuggestions(stopIndex, items) {
  const panel = stopsListEl.querySelector(`[data-stop-suggestions="${stopIndex}"]`);
  if (!panel) return;
  if (!items.length) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.innerHTML = items
    .map((item, idx) => {
      const cls = item.kind === "fav" ? "suggestion-item fav" : "suggestion-item";
      return `<button type="button" class="${cls}" data-suggestion-index="${idx}">
        <strong>${escapeHtml(item.primary)}</strong>
        <span>${escapeHtml(item.secondary || "")}</span>
      </button>`;
    })
    .join("");
  panel.hidden = false;
  panel.dataset.items = JSON.stringify(
    items.map((item) => ({ lat: item.lat, lng: item.lng, label: item.label, primary: item.primary }))
  );
}

function hideSuggestions(stopIndex) {
  const panel = stopsListEl.querySelector(`[data-stop-suggestions="${stopIndex}"]`);
  if (panel) {
    panel.hidden = true;
    panel.innerHTML = "";
    delete panel.dataset.items;
  }
}

function favoriteSuggestions(query) {
  const q = query.toLowerCase();
  return state.favorites
    .filter((f) => f.name.toLowerCase().includes(q) || (f.label || "").toLowerCase().includes(q))
    .slice(0, 3)
    .map((f) => ({
      kind: "fav",
      primary: f.name,
      secondary: f.label || `${f.lat.toFixed(4)}, ${f.lng.toFixed(4)}`,
      lat: f.lat,
      lng: f.lng,
      label: f.label || f.name,
    }));
}

async function refreshSuggestions(stopIndex, query) {
  if (!query || query.length < 2) {
    hideSuggestions(stopIndex);
    return;
  }
  const favItems = favoriteSuggestions(query);
  try {
    const features = await fetchPhoton(query);
    const photonItems = features.slice(0, 6 - favItems.length).map((feature) => {
      const { primary, secondary } = describeFeature(feature);
      const [lng, lat] = feature.geometry.coordinates;
      return {
        kind: "photon",
        primary,
        secondary,
        lat,
        lng,
        label: secondary ? `${primary}, ${secondary}` : primary,
      };
    });
    showSuggestions(stopIndex, [...favItems, ...photonItems]);
  } catch (error) {
    if (error.name === "AbortError") return;
    if (favItems.length) showSuggestions(stopIndex, favItems);
  }
}

/* ---------- Geocoding ---------- */

async function geocode(query) {
  if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(query)) {
    const [lat, lng] = query.split(",").map((part) => Number(part.trim()));
    return { lat, lng, label: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
  }
  const features = await fetchPhoton(query);
  if (!features.length) throw new Error(`No location found for "${query}".`);
  const { primary, secondary } = describeFeature(features[0]);
  const [lng, lat] = features[0].geometry.coordinates;
  return { lat, lng, label: secondary ? `${primary}, ${secondary}` : primary };
}

async function resolveAllStops() {
  for (let i = 0; i < state.stops.length; i++) {
    const stop = state.stops[i];
    if (isStopFilled(stop)) continue;
    const input = stopsListEl.querySelector(`[data-stop-input="${i}"]`);
    const text = (input?.value || "").trim();
    if (!text) throw new Error(`Enter a place for ${stopRoleName(i)}.`);
    const fav = state.favorites.find((f) => f.name.toLowerCase() === text.toLowerCase());
    if (fav) {
      state.stops[i] = { lat: fav.lat, lng: fav.lng, label: fav.label || fav.name };
    } else {
      state.stops[i] = await geocode(text);
    }
  }
  refreshStopsUi();
}

/* ---------- Routing ---------- */

async function makeRoute() {
  await resolveAllStops();
  const filled = state.stops.filter(isStopFilled);
  if (filled.length < 2) throw new Error("Need at least a start and a destination.");

  const response = await fetch("/api/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      coordinates: state.stops.map((s) => [s.lng, s.lat]),
      profile: profileSelect.value,
      preference: preferenceSelect.value,
    }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Routing failed (${response.status}).`);
  }
  const geojson = await response.json();
  state.lastProvider = profileSelect.value;
  renderRoute(geojson, { ascentInMeters: true });
  setMessage(`Route ready · ${profileSelect.options[profileSelect.selectedIndex].text}`);
}

function renderRoute(geojson, options = {}) {
  if (!map) return;
  if (!geojson || !geojson.features || !geojson.features.length || !geojson.features[0]?.geometry) {
    setMessage("This trip has no route geometry to display.", true);
    return;
  }
  state.routeGeojson = geojson;
  if (routeLayer) routeLayer.remove();
  if (previewLayer) {
    previewLayer.remove();
    previewLayer = null;
  }
  const routeColor = getComputedStyle(document.documentElement).getPropertyValue("--route").trim() || "#e2552f";
  routeLayer = L.layerGroup([
    L.geoJSON(geojson, { style: { color: "#fff", weight: 10, opacity: 0.9 } }),
    L.geoJSON(geojson, { style: { color: routeColor, weight: 6, opacity: 0.95 } }),
  ]).addTo(map);
  try {
    const bounds = L.geoJSON(geojson).getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
  } catch {
    // ignore
  }

  const feature = geojson.features[0];
  const summary = feature.properties?.summary || {};
  const distanceMiles = summary.distance > 500 ? summary.distance / 1609.344 : summary.distance;
  distanceStat.textContent = `${distanceMiles.toFixed(distanceMiles >= 10 ? 0 : 1)} mi`;
  timeStat.textContent = formatDuration(summary.duration || 0);
  const ascent = feature.properties?.ascent;
  climbStat.textContent = ascent ? `${Math.round(options.ascentInMeters ? ascent * 3.28084 : ascent)} ft` : "--";

  const segments = feature.properties?.segments || [];
  stepsList.innerHTML = segments
    .flatMap((segment) => segment.steps || [])
    .map((step) => {
      const stepMiles = step.distance > 50 ? step.distance / 1609.344 : step.distance;
      return `<li>${escapeHtml(step.instruction)}<span>${stepMiles.toFixed(1)} mi · ${formatDuration(step.duration)}</span></li>`;
    })
    .join("");

  renderElevationProfile(feature.geometry || {});
  downloadGeojsonBtn.disabled = false;
  downloadGpxBtn.disabled = false;
  saveTripBtn.disabled = false;
}

/* ---------- Elevation chart ---------- */

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function renderElevationProfile(geometry) {
  const coords = geometry?.coordinates || [];
  const flat = geometry?.type === "MultiLineString" ? coords.flat() : coords;
  const withEle = flat.filter((c) => Number.isFinite(c[2]));
  if (withEle.length < 2) {
    elevationFigure.hidden = true;
    return;
  }
  const elevations = withEle.map((c) => c[2]);
  const minEle = Math.min(...elevations);
  const maxEle = Math.max(...elevations);
  const range = Math.max(maxEle - minEle, 1);

  let cum = 0;
  const points = withEle.map((c, i) => {
    if (i > 0) cum += haversineMeters(withEle[i - 1], c);
    return { d: cum, e: c[2] };
  });
  const totalDist = Math.max(cum, 1);

  const W = 600;
  const H = 100;
  const PAD_TOP = 6;
  const path = points
    .map((p, i) => {
      const x = (p.d / totalDist) * W;
      const y = PAD_TOP + (1 - (p.e - minEle) / range) * (H - PAD_TOP);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const area = `${path} L${W},${H} L0,${H} Z`;

  elevationChart.innerHTML = `<path class="area" d="${area}"></path><path class="line" d="${path}"></path>`;
  const minFt = Math.round(minEle * 3.28084);
  const maxFt = Math.round(maxEle * 3.28084);
  elevationRange.textContent = `${minFt} ft – ${maxFt} ft`;
  elevationFigure.hidden = false;
}

/* ---------- GPX export ---------- */

function buildGpx() {
  const geometry = state.routeGeojson?.features?.[0]?.geometry;
  if (!geometry) return null;
  const flat = geometry.type === "MultiLineString" ? geometry.coordinates.flat() : geometry.coordinates;
  const tripName = (tripNameInput.value || "Bike Route").trim() || "Bike Route";
  const now = new Date().toISOString();
  const wpts = state.stops
    .filter(isStopFilled)
    .map((s, i) => `  <wpt lat="${s.lat}" lon="${s.lng}"><name>${escapeXml(stopRoleName(i))}</name></wpt>`)
    .join("\n");
  const trkpts = flat
    .map((c) => {
      const ele = Number.isFinite(c[2]) ? `<ele>${c[2]}</ele>` : "";
      return `      <trkpt lat="${c[1]}" lon="${c[0]}">${ele}</trkpt>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Bike Route Maker" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${escapeXml(tripName)}</name><time>${now}</time></metadata>
${wpts}
  <trk>
    <name>${escapeXml(tripName)}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/* ---------- Trips (localStorage) ---------- */

async function saveTrip() {
  if (!state.routeGeojson) {
    setMessage("Make a route before saving.", true);
    return;
  }
  const filled = state.stops.filter(isStopFilled);
  if (filled.length < 2) return;
  const summary = state.routeGeojson.features[0].properties?.summary || {};
  const start = filled[0];
  const end = filled[filled.length - 1];
  const tripName = tripNameInput.value.trim() || `${(start.label || "Start").split(",")[0]} to ${(end.label || "Destination").split(",")[0]}`;
  const distanceMeters = summary.distance > 500 ? summary.distance : (summary.distance || 0) * 1609.344;
  const durationSeconds = summary.duration || 0;

  if (isSignedIn()) {
    await api("/api/trips", {
      method: "POST",
      body: JSON.stringify({
        name: tripName,
        provider: state.lastProvider || "ors",
        start, end, stops: filled,
        routeGeojson: state.routeGeojson,
        distanceMeters, durationSeconds,
      }),
    });
    await loadTripsFromApi();
  } else {
    state.trips.unshift({
      id: uid(),
      name: tripName,
      provider: state.lastProvider || "ors",
      stops: filled,
      routeGeojson: state.routeGeojson,
      distanceMeters, durationSeconds,
      createdAt: new Date().toISOString(),
    });
    saveToStorage("bikeRouteTrips", state.trips);
    renderTrips();
  }
  tripNameInput.value = "";
  setMessage(`Saved "${tripName}".`);
}

async function loadTripsFromApi() {
  try {
    const { trips } = await api("/api/trips");
    state.trips = trips;
    renderTrips();
  } catch (error) {
    console.error("loadTripsFromApi failed:", error);
  }
}

async function loadFavoritesFromApi() {
  try {
    const { favorites } = await api("/api/favorites");
    state.favorites = favorites;
    renderFavorites();
    refreshStopsUi();
  } catch (error) {
    console.error("loadFavoritesFromApi failed:", error);
  }
}

function renderTrips() {
  if (!state.trips.length) {
    tripsList.innerHTML = `<div class="account-status">No saved trips yet. Make a route and click Save Trip.</div>`;
    return;
  }
  tripsList.innerHTML = state.trips
    .map((trip) => {
      const distance = trip.distanceMeters ? formatDistance(trip.distanceMeters) : "--";
      const stopsCount = (trip.stops || []).length;
      const stopsLabel = stopsCount > 2 ? ` · ${stopsCount} stops` : "";
      return `<div class="trip-item">
        <div><strong>${escapeHtml(trip.name)}</strong><span>${escapeHtml(trip.provider)} · ${distance}${stopsLabel}</span></div>
        <button type="button" data-load-trip="${trip.id}">Load</button>
        <button type="button" data-delete-trip="${trip.id}">Delete</button>
      </div>`;
    })
    .join("");
}

async function loadTrip(id) {
  if (isSignedIn()) {
    const { trip } = await api(`/api/trips/${id}`);
    state.stops = (trip.stops || [trip.start, trip.end]).map((s) => ({ lat: s.lat, lng: s.lng, label: s.label || `${s.lat?.toFixed?.(5)}, ${s.lng?.toFixed?.(5)}` }));
    refreshStopsUi();
    renderRoute(trip.routeGeojson);
    setMessage(`Loaded "${trip.name}".`);
    return;
  }
  const trip = state.trips.find((t) => t.id === id);
  if (!trip) return;
  state.stops = (trip.stops || []).map((s) => ({ lat: s.lat, lng: s.lng, label: s.label || `${s.lat?.toFixed?.(5)}, ${s.lng?.toFixed?.(5)}` }));
  refreshStopsUi();
  renderRoute(trip.routeGeojson);
  setMessage(`Loaded "${trip.name}".`);
}

async function deleteTrip(id) {
  if (isSignedIn()) {
    await api(`/api/trips/${id}`, { method: "DELETE" });
    await loadTripsFromApi();
    return;
  }
  state.trips = state.trips.filter((t) => t.id !== id);
  saveToStorage("bikeRouteTrips", state.trips);
  renderTrips();
}

/* ---------- Favorites (localStorage) ---------- */

function renderFavorites() {
  if (!state.favorites.length) {
    favoritesList.innerHTML = `<div class="account-status">No favorites yet. Tap ★ next to a stop to save it.</div>`;
    return;
  }
  favoritesList.innerHTML = state.favorites
    .map((f) => `
      <div class="favorite-item">
        <div><strong>${escapeHtml(f.name)}</strong><span>${escapeHtml((f.label || `${f.lat.toFixed(4)}, ${f.lng.toFixed(4)}`).slice(0, 80))}</span></div>
        <button type="button" data-fav-use="${f.id}">Add as stop</button>
        <button type="button" data-fav-delete="${f.id}">×</button>
      </div>
    `)
    .join("");
}

async function saveFavorite(stopIndex) {
  const stop = state.stops[stopIndex];
  if (!isStopFilled(stop)) {
    setMessage("Fill that stop with a place first, then save it.", true);
    return;
  }
  const existingId = favoriteIdForStop(stop);
  if (existingId) {
    if (isSignedIn()) {
      await api(`/api/favorites/${existingId}`, { method: "DELETE" });
      await loadFavoritesFromApi();
    } else {
      state.favorites = state.favorites.filter((f) => f.id !== existingId);
      saveToStorage("bikeRouteFavorites", state.favorites);
      renderFavorites();
      refreshStopsUi();
    }
    setMessage("Removed from favorites.");
    return;
  }
  const defaultName = (stop.label || "").split(",")[0].trim().slice(0, 40) || "Favorite";
  const name = (window.prompt("Name this favorite:", defaultName) || "").trim();
  if (!name) return;
  if (isSignedIn()) {
    await api("/api/favorites", {
      method: "POST",
      body: JSON.stringify({ name, lat: stop.lat, lng: stop.lng, label: stop.label }),
    });
    await loadFavoritesFromApi();
  } else {
    state.favorites.push({ id: uid(), name, lat: stop.lat, lng: stop.lng, label: stop.label, createdAt: new Date().toISOString() });
    saveToStorage("bikeRouteFavorites", state.favorites);
    renderFavorites();
    refreshStopsUi();
  }
  setMessage(`Saved "${name}" to favorites.`);
}

async function deleteFavorite(id) {
  if (isSignedIn()) {
    await api(`/api/favorites/${id}`, { method: "DELETE" });
    await loadFavoritesFromApi();
    return;
  }
  state.favorites = state.favorites.filter((f) => f.id !== id);
  saveToStorage("bikeRouteFavorites", state.favorites);
  renderFavorites();
  refreshStopsUi();
}

function useFavoriteAsStop(id) {
  const fav = state.favorites.find((f) => f.id === id);
  if (!fav) return;
  const empty = nextEmptyStopIndex();
  const point = { lat: fav.lat, lng: fav.lng, label: fav.label || fav.name };
  if (empty >= 0) {
    setStop(empty, point);
  } else {
    state.stops.splice(state.stops.length - 1, 0, { ...point });
    refreshStopsUi();
  }
  setMessage(`Added "${fav.name}" as a stop.`);
}

/* ---------- Auth ---------- */

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function setAccountStatus(text) {
  if (accountStatus) accountStatus.textContent = text;
}

function isSignedIn() {
  return Boolean(authToken && currentUser);
}

function renderAuthState() {
  if (isSignedIn()) {
    accountHeading.textContent = "Account";
    setAccountStatus(`Signed in as ${currentUser.email}`);
    authForm.hidden = true;
    logoutBtn.hidden = false;
    tripsSection.hidden = false;
  } else {
    accountHeading.textContent = "Account";
    setAccountStatus("Sign in to save trips and unlock higher rate limits — or keep using the app as a guest.");
    authForm.hidden = false;
    logoutBtn.hidden = true;
    tripsSection.hidden = true;
  }
  saveTripBtn.disabled = !state.routeGeojson;
}

async function refreshMe() {
  if (!authToken) {
    currentUser = null;
    renderAuthState();
    renderTrips();
    renderFavorites();
    return;
  }
  try {
    const { user } = await api("/api/me");
    currentUser = user;
    renderAuthState();
    await loadTripsFromApi();
    await loadFavoritesFromApi();
  } catch {
    authToken = "";
    currentUser = null;
    localStorage.removeItem("bikeRouteToken");
    renderAuthState();
    renderTrips();
    renderFavorites();
  }
}

async function signIn(mode) {
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (!email || password.length < 8) {
    setAccountStatus("Email and an 8+ character password are required.");
    return;
  }
  const endpoint = mode === "signup" ? "/api/auth/signup" : "/api/auth/login";
  try {
    const { token, user } = await api(endpoint, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    authToken = token;
    currentUser = user;
    localStorage.setItem("bikeRouteToken", token);
    passwordInput.value = "";
    renderAuthState();
    await loadTripsFromApi();
    await loadFavoritesFromApi();
    setAccountStatus(`Signed in as ${user.email}`);
  } catch (error) {
    if (error.status === 401 && mode === "login") {
      setAccountStatus("Wrong email or password. New here? Click Create Account.");
    } else if (error.status === 409 && mode === "signup") {
      setAccountStatus("That email is already registered. Try Sign In instead.");
    } else {
      setAccountStatus(error.message);
    }
  }
}

async function logout() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  authToken = "";
  currentUser = null;
  localStorage.removeItem("bikeRouteToken");
  renderAuthState();
  renderTrips();
  renderFavorites();
}

/* ---------- Map clicks ---------- */

if (map) {
  map.on("click", (event) => {
    const point = {
      lat: event.latlng.lat,
      lng: event.latlng.lng,
      label: `${event.latlng.lat.toFixed(5)}, ${event.latlng.lng.toFixed(5)}`,
    };
    const empty = nextEmptyStopIndex();
    if (empty >= 0) setStop(empty, point);
    else setStop(state.stops.length - 1, point);
  });
}

/* ---------- Event handlers ---------- */

stopsListEl.addEventListener("click", (event) => {
  const removeIdx = event.target.dataset.stopRemove;
  const favIdx = event.target.dataset.stopFav;
  if (removeIdx !== undefined) removeStop(Number(removeIdx));
  if (favIdx !== undefined) {
    try { saveFavorite(Number(favIdx)); } catch (e) { setMessage(e.message, true); }
  }

  const suggestionBtn = event.target.closest(".suggestion-item");
  if (suggestionBtn) {
    const panel = suggestionBtn.parentElement;
    const stopIndex = Number(panel.dataset.stopSuggestions);
    const idx = Number(suggestionBtn.dataset.suggestionIndex);
    const items = panel.dataset.items ? JSON.parse(panel.dataset.items) : [];
    const picked = items[idx];
    if (picked) setStop(stopIndex, picked);
    hideSuggestions(stopIndex);
  }
});

stopsListEl.addEventListener("input", (event) => {
  const idxAttr = event.target.dataset.stopInput;
  if (idxAttr === undefined) return;
  const i = Number(idxAttr);
  const text = event.target.value.trim();
  if (suggestionDebounce) clearTimeout(suggestionDebounce);
  if (!text) {
    hideSuggestions(i);
    return;
  }
  suggestionDebounce = setTimeout(() => refreshSuggestions(i, text), 220);
});

stopsListEl.addEventListener("focusout", (event) => {
  const idxAttr = event.target.dataset?.stopInput;
  if (idxAttr === undefined) return;
  const i = Number(idxAttr);
  setTimeout(() => hideSuggestions(i), 150);
});

stopsListEl.addEventListener("change", (event) => {
  const idxAttr = event.target.dataset.stopInput;
  if (idxAttr === undefined) return;
  const i = Number(idxAttr);
  const text = event.target.value.trim();
  if (!text) {
    state.stops[i] = emptyStop();
    state.routeGeojson = null;
    refreshStopsUi();
    return;
  }
  const fav = state.favorites.find((f) => f.name.toLowerCase() === text.toLowerCase());
  if (fav) setStop(i, { lat: fav.lat, lng: fav.lng, label: fav.label || fav.name });
});

addStopBtn.addEventListener("click", addStop);

document.querySelector("#routeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage("Finding the route...");
  try {
    await makeRoute();
  } catch (error) {
    setMessage(error.message, true);
  }
});

document.querySelector("#reverseBtn").addEventListener("click", () => {
  state.stops.reverse();
  state.routeGeojson = null;
  refreshStopsUi();
});

document.querySelector("#clearBtn").addEventListener("click", () => {
  state.stops = [emptyStop(), emptyStop()];
  state.routeGeojson = null;
  stopMarkers.forEach((m) => m.remove());
  stopMarkers.length = 0;
  if (routeLayer) routeLayer.remove();
  if (previewLayer) previewLayer.remove();
  routeLayer = null;
  previewLayer = null;
  distanceStat.textContent = "--";
  timeStat.textContent = "--";
  climbStat.textContent = "--";
  stepsList.innerHTML = "";
  elevationFigure.hidden = true;
  downloadGeojsonBtn.disabled = true;
  downloadGpxBtn.disabled = true;
  saveTripBtn.disabled = true;
  refreshStopsUi();
  setMessage("Cleared. Click points on the map or start typing a place to plan a new ride.");
});

saveTripBtn.addEventListener("click", async () => {
  try { await saveTrip(); } catch (e) { setMessage(e.message, true); }
});

tripsList.addEventListener("click", async (event) => {
  const loadId = event.target.dataset.loadTrip;
  const deleteId = event.target.dataset.deleteTrip;
  try {
    if (loadId) await loadTrip(loadId);
    if (deleteId) await deleteTrip(deleteId);
  } catch (e) { setMessage(e.message, true); }
});

favoritesList.addEventListener("click", async (event) => {
  const useId = event.target.dataset.favUse;
  const deleteId = event.target.dataset.favDelete;
  try {
    if (useId) useFavoriteAsStop(useId);
    if (deleteId) await deleteFavorite(deleteId);
  } catch (e) { setMessage(e.message, true); }
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await signIn("login");
});

signupBtn.addEventListener("click", async () => {
  await signIn("signup");
});

logoutBtn.addEventListener("click", logout);

document.querySelector("#locateBtn").addEventListener("click", () => {
  if (!navigator.geolocation) {
    setMessage("Your browser does not expose location services.", true);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const point = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        label: "Current location",
      };
      setStop(0, point);
      if (map) map.setView([point.lat, point.lng], 14);
    },
    () => setMessage("Location permission was not granted.", true),
    { enableHighAccuracy: true, timeout: 9000 }
  );
});

downloadGeojsonBtn.addEventListener("click", () => {
  if (!state.routeGeojson) return;
  downloadBlob(JSON.stringify(state.routeGeojson, null, 2), "bike-route.geojson", "application/geo+json");
});

downloadGpxBtn.addEventListener("click", () => {
  const gpx = buildGpx();
  if (!gpx) return;
  downloadBlob(gpx, "bike-route.gpx", "application/gpx+xml");
});

/* ---------- Init ---------- */

window.addEventListener("error", (event) => {
  console.error("Uncaught error:", event.error || event.message);
});

try {
  refreshStopsUi();
  renderTrips();
  renderFavorites();
  renderAuthState();
  refreshMe();
} catch (error) {
  console.error("Init failed:", error);
}

window.addEventListener("resize", () => {
  if (map) map.invalidateSize();
});

if (map && typeof ResizeObserver !== "undefined") {
  const mapEl = document.querySelector("#map");
  if (mapEl) new ResizeObserver(() => map.invalidateSize()).observe(mapEl);
}

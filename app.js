const map = L.map("map", { zoomControl: false }).setView([40.73061, -73.935242], 12);
L.control.zoom({ position: "bottomright" }).addTo(map);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const state = {
  start: null,
  end: null,
  routeGeojson: null,
  clickTarget: "start",
};

const startInput = document.querySelector("#startInput");
const endInput = document.querySelector("#endInput");
const providerSelect = document.querySelector("#providerSelect");
const profileSelect = document.querySelector("#profileSelect");
const preferenceSelect = document.querySelector("#preferenceSelect");
const apiKeyInput = document.querySelector("#apiKeyInput");
const message = document.querySelector("#message");
const distanceStat = document.querySelector("#distanceStat");
const timeStat = document.querySelector("#timeStat");
const climbStat = document.querySelector("#climbStat");
const stepsList = document.querySelector("#stepsList");
const downloadGeojsonBtn = document.querySelector("#downloadGeojsonBtn");
const authForm = document.querySelector("#authForm");
const emailInput = document.querySelector("#emailInput");
const passwordInput = document.querySelector("#passwordInput");
const signupBtn = document.querySelector("#signupBtn");
const logoutBtn = document.querySelector("#logoutBtn");
const accountStatus = document.querySelector("#accountStatus");
const saveTripBtn = document.querySelector("#saveTripBtn");
const tripNameInput = document.querySelector("#tripNameInput");
const tripsList = document.querySelector("#tripsList");

const markers = {
  start: L.marker([0, 0], { draggable: true }),
  end: L.marker([0, 0], { draggable: true }),
};

let routeLayer = null;
let previewLayer = null;
let sidewalkLayer = null;
let authToken = localStorage.getItem("bikeRouteToken") || "";
let currentUser = null;

function setMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

function setAccountStatus(text) {
  accountStatus.textContent = text;
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

async function geocode(query) {
  if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(query)) {
    const [lat, lng] = query.split(",").map((part) => Number(part.trim()));
    return { lat, lng, label: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
  }

  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "1",
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Geocoding failed.");
  const results = await response.json();
  if (!results.length) throw new Error(`No location found for "${query}".`);
  return {
    lat: Number(results[0].lat),
    lng: Number(results[0].lon),
    label: results[0].display_name,
  };
}

function setPoint(kind, point) {
  state[kind] = point;
  const marker = markers[kind];
  marker.setLatLng([point.lat, point.lng]).addTo(map).bindPopup(kind === "start" ? "Start" : "Destination");
  if (kind === "start") {
    startInput.value = point.label || `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
    state.clickTarget = "end";
  } else {
    endInput.value = point.label || `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
    state.clickTarget = "start";
  }
  drawPreview();
}

function drawPreview() {
  if (previewLayer) previewLayer.remove();
  if (!state.start || !state.end || state.routeGeojson) return;
  previewLayer = L.polyline(
    [
      [state.start.lat, state.start.lng],
      [state.end.lat, state.end.lng],
    ],
    { color: "#6d7a76", dashArray: "6 8", weight: 4 }
  ).addTo(map);
  map.fitBounds(previewLayer.getBounds(), { padding: [40, 40] });
}

async function makeRoute() {
  const key = apiKeyInput.value.trim();
  if (!state.start) state.start = await geocode(startInput.value.trim());
  if (!state.end) state.end = await geocode(endInput.value.trim());
  setPoint("start", state.start);
  setPoint("end", state.end);

  if (providerSelect.value === "osrm-bike" || providerSelect.value === "osrm-foot") {
    const mode = providerSelect.value === "osrm-bike" ? "bike" : "foot";
    const route = await routeWithOsrm(mode);
    renderRoute(route, { ascentInMeters: false });
    setMessage(mode === "bike" ? "Free OSM bike route ready. Public demo routing is best for prototypes and light use." : "Free OSM foot route ready. Use the sidewalk layer to inspect nearby pedestrian infrastructure.");
    return;
  }

  if (!key) {
    throw new Error("OpenRouteService needs an API key. Choose Free OSM bike or Free sidewalks/foot for no-key routing.");
  }

  const profile = profileSelect.value;
  const body = {
    coordinates: [
      [state.start.lng, state.start.lat],
      [state.end.lng, state.end.lat],
    ],
    preference: preferenceSelect.value,
    elevation: true,
    instructions: true,
    units: "mi",
  };

  const response = await fetch(`https://api.openrouteservice.org/v2/directions/${profile}/geojson`, {
    method: "POST",
    headers: {
      Accept: "application/json, application/geo+json",
      "Content-Type": "application/json",
      Authorization: key,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Routing failed (${response.status}). ${detail.slice(0, 140)}`);
  }

  const geojson = await response.json();
  renderRoute(geojson, { ascentInMeters: true });
}

async function routeWithOsrm(mode) {
  const routedPath = mode === "bike" ? "routed-bike" : "routed-foot";
  const profile = mode === "bike" ? "bike" : "foot";
  const coordinates = `${state.start.lng},${state.start.lat};${state.end.lng},${state.end.lat}`;
  const params = new URLSearchParams({
    overview: "full",
    geometries: "geojson",
    steps: "true",
    alternatives: "false",
  });
  const url = `https://routing.openstreetmap.de/${routedPath}/route/v1/${profile}/${coordinates}?${params.toString()}`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Free OSM routing failed (${response.status}).`);
  const data = await response.json();
  if (data.code !== "Ok" || !data.routes?.length) throw new Error(data.message || "No route found.");
  const route = data.routes[0];
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: route.geometry,
        properties: {
          provider: `OSRM ${mode}`,
          summary: {
            distance: route.distance,
            duration: route.duration,
          },
          segments: route.legs.map((leg) => ({
            steps: leg.steps.map((step) => ({
              instruction: osrmInstruction(step),
              distance: step.distance,
              duration: step.duration,
            })),
          })),
        },
      },
    ],
  };
}

function osrmInstruction(step) {
  const road = step.name ? ` onto ${step.name}` : "";
  const type = step.maneuver?.type || "continue";
  const modifier = step.maneuver?.modifier ? ` ${step.maneuver.modifier}` : "";
  if (type === "depart") return `Start${road}`;
  if (type === "arrive") return "Arrive at destination";
  return `${type.replace(/-/g, " ")}${modifier}${road}`.replace(/\b\w/g, (char) => char.toUpperCase());
}

function renderRoute(geojson, options = {}) {
  state.routeGeojson = geojson;
  if (routeLayer) routeLayer.remove();
  if (previewLayer) previewLayer.remove();

  routeLayer = L.geoJSON(geojson, {
    style: { color: getComputedStyle(document.documentElement).getPropertyValue("--route").trim(), weight: 6, opacity: 0.92 },
  }).addTo(map);
  map.fitBounds(routeLayer.getBounds(), { padding: [36, 36] });

  const feature = geojson.features[0];
  const summary = feature.properties.summary;
  const distanceMiles = summary.distance > 500 ? summary.distance / 1609.344 : summary.distance;
  distanceStat.textContent = `${distanceMiles.toFixed(distanceMiles >= 10 ? 0 : 1)} mi`;
  timeStat.textContent = formatDuration(summary.duration);
  const ascent = feature.properties.ascent;
  climbStat.textContent = ascent ? `${Math.round(options.ascentInMeters ? ascent * 3.28084 : ascent)} ft` : "--";
  stepsList.innerHTML = feature.properties.segments
    .flatMap((segment) => segment.steps)
    .map((step) => {
      const stepMiles = step.distance > 50 ? step.distance / 1609.344 : step.distance;
      return `<li>${escapeHtml(step.instruction)}<span>${stepMiles.toFixed(1)} mi - ${formatDuration(step.duration)}</span></li>`;
    })
    .join("");
  downloadGeojsonBtn.disabled = false;
  saveTripBtn.disabled = !authToken;
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

async function refreshMe() {
  try {
    const health = await api("/api/health", { headers: {} });
    if (!health.databaseConfigured) {
      setAccountStatus("Database is not connected yet. Add DATABASE_URL from Neon and restart the server.");
      saveTripBtn.disabled = true;
      return;
    }
    if (!authToken) {
      currentUser = null;
      setAccountStatus("Sign in to save and reload trips.");
      logoutBtn.hidden = true;
      saveTripBtn.disabled = true;
      tripsList.innerHTML = "";
      return;
    }
    const { user } = await api("/api/me");
    currentUser = user;
    setAccountStatus(`Signed in as ${user.email}`);
    logoutBtn.hidden = false;
    saveTripBtn.disabled = !state.routeGeojson;
    await loadTrips();
  } catch (error) {
    authToken = "";
    localStorage.removeItem("bikeRouteToken");
    currentUser = null;
    setAccountStatus(error.message);
    logoutBtn.hidden = true;
    saveTripBtn.disabled = true;
  }
}

async function signIn(mode) {
  const payload = {
    email: emailInput.value.trim(),
    password: passwordInput.value,
  };
  const endpoint = mode === "signup" ? "/api/auth/signup" : "/api/auth/login";
  const { token, user } = await api(endpoint, { method: "POST", body: JSON.stringify(payload) });
  authToken = token;
  currentUser = user;
  localStorage.setItem("bikeRouteToken", token);
  passwordInput.value = "";
  setAccountStatus(`Signed in as ${user.email}`);
  logoutBtn.hidden = false;
  saveTripBtn.disabled = !state.routeGeojson;
  await loadTrips();
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // The local token is cleared either way.
  }
  authToken = "";
  currentUser = null;
  localStorage.removeItem("bikeRouteToken");
  setAccountStatus("Signed out.");
  logoutBtn.hidden = true;
  saveTripBtn.disabled = true;
  tripsList.innerHTML = "";
}

async function saveTrip() {
  if (!state.routeGeojson || !state.start || !state.end) {
    setAccountStatus("Make a route before saving.");
    return;
  }
  const summary = state.routeGeojson.features[0].properties.summary;
  const tripName = tripNameInput.value.trim() || `${startInput.value.split(",")[0]} to ${endInput.value.split(",")[0]}`;
  await api("/api/trips", {
    method: "POST",
    body: JSON.stringify({
      name: tripName,
      provider: providerSelect.value,
      start: state.start,
      end: state.end,
      routeGeojson: state.routeGeojson,
      distanceMeters: summary.distance > 500 ? summary.distance : summary.distance * 1609.344,
      durationSeconds: summary.duration,
    }),
  });
  tripNameInput.value = "";
  setAccountStatus("Trip saved.");
  await loadTrips();
}

async function loadTrips() {
  const { trips } = await api("/api/trips");
  tripsList.innerHTML = trips
    .map((trip) => {
      const distance = trip.distanceMeters ? formatDistance(trip.distanceMeters) : "--";
      return `<div class="trip-item">
        <div><strong>${escapeHtml(trip.name)}</strong><span>${escapeHtml(trip.provider)} · ${distance}</span></div>
        <button type="button" data-load-trip="${trip.id}">Load</button>
        <button type="button" data-delete-trip="${trip.id}">Delete</button>
      </div>`;
    })
    .join("");
}

async function loadTrip(id) {
  const { trip } = await api(`/api/trips/${id}`);
  state.start = trip.start;
  state.end = trip.end;
  startInput.value = trip.start.label || "Saved start";
  endInput.value = trip.end.label || "Saved destination";
  setPoint("start", state.start);
  setPoint("end", state.end);
  renderRoute(trip.routeGeojson);
  setAccountStatus(`Loaded "${trip.name}".`);
}

async function deleteTrip(id) {
  await api(`/api/trips/${id}`, { method: "DELETE" });
  setAccountStatus("Trip deleted.");
  await loadTrips();
}

async function toggleSidewalks() {
  if (sidewalkLayer) {
    sidewalkLayer.remove();
    sidewalkLayer = null;
    document.querySelector("#sidewalkBtn").textContent = "Show Sidewalks";
    setMessage("Sidewalk layer hidden.");
    return;
  }

  setMessage("Loading sidewalk and pedestrian ways in the current map view...");
  const bounds = map.getBounds();
  const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
  const query = `
    [out:json][timeout:25];
    (
      way["footway"="sidewalk"](${bbox});
      way["sidewalk"](${bbox});
      way["highway"~"^(footway|pedestrian|path|steps)$"](${bbox});
    );
    out geom 400;
  `;
  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: query,
  });
  if (!response.ok) throw new Error(`Overpass sidewalk lookup failed (${response.status}).`);
  const data = await response.json();
  sidewalkLayer = L.layerGroup(
    data.elements
      .filter((element) => element.geometry?.length)
      .map((element) => {
        const latLngs = element.geometry.map((point) => [point.lat, point.lon]);
        const isSidewalk = element.tags?.footway === "sidewalk" || Boolean(element.tags?.sidewalk);
        return L.polyline(latLngs, {
          color: isSidewalk ? "#2563eb" : "#7c3aed",
          weight: isSidewalk ? 4 : 3,
          opacity: 0.75,
        }).bindPopup(escapeHtml(element.tags?.name || element.tags?.highway || "Pedestrian way"));
      })
  ).addTo(map);
  document.querySelector("#sidewalkBtn").textContent = "Hide Sidewalks";
  setMessage(`Loaded ${data.elements.length} sidewalk/pedestrian OSM ways for this view.`);
}

markers.start.on("dragend", (event) => {
  const pos = event.target.getLatLng();
  state.start = { lat: pos.lat, lng: pos.lng, label: `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}` };
  startInput.value = state.start.label;
  state.routeGeojson = null;
  drawPreview();
});

markers.end.on("dragend", (event) => {
  const pos = event.target.getLatLng();
  state.end = { lat: pos.lat, lng: pos.lng, label: `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}` };
  endInput.value = state.end.label;
  state.routeGeojson = null;
  drawPreview();
});

map.on("click", (event) => {
  const point = {
    lat: event.latlng.lat,
    lng: event.latlng.lng,
    label: `${event.latlng.lat.toFixed(5)}, ${event.latlng.lng.toFixed(5)}`,
  };
  setPoint(state.clickTarget, point);
});

document.querySelector("#routeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage("Finding the route...");
  try {
    await makeRoute();
  } catch (error) {
    setMessage(error.message, true);
  }
});

document.querySelector("#swapBtn").addEventListener("click", () => {
  const oldStart = state.start;
  state.start = state.end;
  state.end = oldStart;
  const oldInput = startInput.value;
  startInput.value = endInput.value;
  endInput.value = oldInput;
  if (state.start) setPoint("start", state.start);
  if (state.end) setPoint("end", state.end);
});

document.querySelector("#clearBtn").addEventListener("click", () => {
  state.start = null;
  state.end = null;
  state.routeGeojson = null;
  startInput.value = "";
  endInput.value = "";
  Object.values(markers).forEach((marker) => marker.remove());
  if (routeLayer) routeLayer.remove();
  if (previewLayer) previewLayer.remove();
  distanceStat.textContent = "--";
  timeStat.textContent = "--";
  climbStat.textContent = "--";
  stepsList.innerHTML = "";
  downloadGeojsonBtn.disabled = true;
  saveTripBtn.disabled = true;
  setMessage("Cleared. Enter places or click the map to set a new start and destination.");
});

document.querySelector("#sidewalkBtn").addEventListener("click", async () => {
  try {
    await toggleSidewalks();
  } catch (error) {
    setMessage(error.message, true);
  }
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await signIn("login");
  } catch (error) {
    setAccountStatus(error.message);
  }
});

signupBtn.addEventListener("click", async () => {
  try {
    await signIn("signup");
  } catch (error) {
    setAccountStatus(error.message);
  }
});

logoutBtn.addEventListener("click", logout);

saveTripBtn.addEventListener("click", async () => {
  try {
    await saveTrip();
  } catch (error) {
    setAccountStatus(error.message);
  }
});

tripsList.addEventListener("click", async (event) => {
  const loadId = event.target.dataset.loadTrip;
  const deleteId = event.target.dataset.deleteTrip;
  try {
    if (loadId) await loadTrip(loadId);
    if (deleteId) await deleteTrip(deleteId);
  } catch (error) {
    setAccountStatus(error.message);
  }
});

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
      setPoint("start", point);
      map.setView([point.lat, point.lng], 14);
    },
    () => setMessage("Location permission was not granted.", true),
    { enableHighAccuracy: true, timeout: 9000 }
  );
});

downloadGeojsonBtn.addEventListener("click", () => {
  if (!state.routeGeojson) return;
  const blob = new Blob([JSON.stringify(state.routeGeojson, null, 2)], { type: "application/geo+json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "bike-route.geojson";
  link.click();
  URL.revokeObjectURL(url);
});

document.querySelector("#copyApiBtn").addEventListener("click", async () => {
  const example = `Free bike route:
GET https://routing.openstreetmap.de/routed-bike/route/v1/bike/-73.98513,40.75890;-73.96828,40.78509?overview=full&geometries=geojson&steps=true

Free sidewalk/pedestrian data:
POST https://overpass-api.de/api/interpreter
[out:json][timeout:25];
(
  way["footway"="sidewalk"](south,west,north,east);
  way["sidewalk"](south,west,north,east);
  way["highway"~"^(footway|pedestrian|path|steps)$"](south,west,north,east);
);
out geom;`;
  await navigator.clipboard.writeText(example);
  setMessage("Copied a bike-route API request example.");
});

refreshMe();

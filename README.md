# Bike Route Maker

A small static web app for planning bicycle routes.

## Run it

Install dependencies and start the app:

```powershell
npm install
npm start
```

Then visit `http://localhost:5173`.

The current development server in this workspace is also running at `http://localhost:5174`.

## Neon database setup

1. Create a Neon project.
2. Click **Connect** in the Neon dashboard.
3. Copy the pooled Postgres connection string. Neon documents this as a normal Postgres URL and recommends storing it in `DATABASE_URL`.
4. Create a local `.env` file from `.env.example`, or set the variable in your host:

```powershell
$env:DATABASE_URL="postgresql://user:password@ep-example-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require"
npm start
```

The server creates these tables automatically on startup:

- `users`
- `sessions`
- `trips`

You can also paste `schema.sql` into Neon's SQL editor if you want to create the tables manually.

## Backend API

- `GET /api/health`
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `GET /api/trips`
- `POST /api/trips`
- `GET /api/trips/:id`
- `DELETE /api/trips/:id`

Auth uses bearer tokens stored in browser `localStorage`; the database stores only SHA-256 token hashes. Passwords are salted and hashed with Node's `scrypt`.

## How route data works

The app uses:

- Leaflet for the map.
- OpenStreetMap map tiles.
- Nominatim for address/place geocoding.
- FOSSGIS/OpenStreetMap OSRM demo routing for no-key bike and foot routes.
- Overpass API for sidewalk and pedestrian-way overlays.
- OpenRouteService Directions as an optional richer bicycle routing provider.

The default route source is free/no-key OSM bike routing. Public demo servers are best for prototypes and light use. For production, self-host OSRM/Valhalla/OpenTripPlanner or use a paid/free-tier routing provider with a service agreement.

## Good APIs for bike-route apps

- OpenRouteService: good default for bicycle routing, has `cycling-regular`, `cycling-road`, `cycling-mountain`, and `cycling-electric` profiles.
- Mapbox Directions API: polished commercial option with a `mapbox/cycling` profile and good SDK support.
- Valhalla: open-source routing engine with a `bicycle` costing model. Best if you want to run your own routing service.
- OSRM via routing.openstreetmap.de: free public demo bike/foot routing, with light-use limits.
- OpenTripPlanner: open-source multimodal routing that can use OSM sidewalk/pedestrian data plus GTFS transit.
- GraphHopper: commercial/open-source-friendly routing with bike profiles.
- Overpass API: not a router; use it to find nearby bike lanes, paths, racks, water fountains, and OSM tags around a route.
- Nominatim, Pelias, or Mapbox Geocoding: convert typed places into coordinates before routing.

## Apple Maps

Apple Maps can be used on the web through MapKit JS, but it requires an Apple Maps token from an Apple Developer account. It is mainly a map/search/display SDK; you should check Apple's current terms before using Apple Maps data with non-Apple routing geometry. If you want Apple-style map rendering, MapKit JS is possible. If you want fully open/free routing and sidewalk overlays, OpenStreetMap-based routing is the better foundation.

## Where AI/web search fits

AI search is useful for discovering context, not for final routing geometry. Use it to answer questions like:

- Which local agency publishes bike-lane closures?
- Are there current trail detours or bridge restrictions?
- What city open-data portal has protected-bike-lane datasets?

For turn-by-turn route geometry, use a routing API. For raw cycling infrastructure, query OSM/Overpass or a city GIS/open-data API.

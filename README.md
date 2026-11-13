# North County

A session tool for the coast from Oceanside Harbor to Torrey Pines. The map is NOAA shoreline and coastal elevation in one gold on black. Pick a break and scrub the next 48 hours.

Nearshore heights are model significant wave height in feet, not a face height. Buoy numbers are observed. The tide curve is the La Jolla prediction.

```bash
npm start
```

Open http://127.0.0.1:4173

The page calls Open-Meteo directly. Wind and air come from `api.open-meteo.com`; if that host does not answer, the same request goes to `previous-runs-api.open-meteo.com`. NOAA, NDBC, and CDIP go through the same-origin proxy in `server/proxy.js`, which allowlists those three hosts and nothing else.

`npm test` checks the projection, the wind words, and the forecast labeling.

import assert from "node:assert/strict";
import test from "node:test";
import { buildHour, decorate } from "../public/js/series.js";
import {
  M_PER_DEG_LON,
  biasRatio,
  compass16,
  haversineM,
  pacificEpoch,
  pacificParts,
  projectMeters,
  rankWord,
  windWord,
} from "../public/js/spots.js";
import spots from "../public/data/spots.json" with { type: "json" };

test("local projection uses cos 33.08° and keeps a mile between Swami's and Moonlight", () => {
  assert.ok(Math.abs(M_PER_DEG_LON - 111320 * Math.cos((33.08 * Math.PI) / 180)) < 1e-6);
  const swamis = spots.breaks.find((spot) => spot.id === "swamis");
  const moonlight = spots.breaks.find((spot) => spot.id === "moonlight");
  const a = projectMeters(swamis.lon, swamis.lat);
  const b = projectMeters(moonlight.lon, moonlight.lat);
  const meters = Math.hypot(a.x - b.x, a.y - b.y);
  assert.ok(meters > 1400 && meters < 1700, meters);
  const harbor = spots.buoys[0];
  const torrey = spots.buoys[1];
  assert.ok(harbor.lon < -117.5 === false);
  assert.ok(harbor.lon < -117.45 && torrey.lat < 32.95);
});

test("wind words follow each break's shore-normal", () => {
  const swamis = spots.breaks.find((spot) => spot.id === "swamis");
  assert.equal(windWord(swamis.shoreNormal, swamis.shoreNormal + 180, 8), "offshore");
  assert.equal(windWord(swamis.shoreNormal, swamis.shoreNormal, 8), "onshore");
  assert.equal(windWord(swamis.shoreNormal, swamis.shoreNormal + 90, 8), "cross");
  assert.equal(windWord(swamis.shoreNormal, 0, 3), "calm");
  const harbor = spots.breaks.find((spot) => spot.id === "harbor");
  assert.notEqual(harbor.shoreNormal, swamis.shoreNormal);
});

test("bias ratio stays inside 0.5 to 1.5 and needs a real buoy", () => {
  const ok = biasRatio(1, 1.25);
  assert.equal(ok.apply, true);
  assert.ok(Math.abs(ok.ratio - 0.8) < 0.001);
  assert.equal(biasRatio(1, 0.2).apply, false);
  assert.equal(biasRatio(2, 1).reason, "range");
  assert.equal(biasRatio(2, 1).apply, false);
});

test("a long-period onshore blow is skip because of the wind", () => {
  assert.equal(rankWord({
    hsFt: 4,
    period: 16,
    wind: "onshore",
    windMph: 18,
    band: "mid",
    rising: true,
    pref: spots.breaks.find((spot) => spot.id === "swamis").tidePref,
    sizeFt: [2, 6],
  }), "skip");
});

test("Pacific wall time round-trips", () => {
  const ms = pacificEpoch("2026-11-13T12:00");
  const parts = pacificParts(ms);
  assert.equal(parts.hour, 12);
  assert.equal(parts.day, 13);
  assert.equal(compass16(247.5), "WSW");
});

test("MOP forecast is the strip height and the ratio stays retired", () => {
  const spot = spots.breaks.find((item) => item.id === "swamis");
  const time = pacificEpoch("2026-11-13T15:00");
  const bundle = fakeBundle(spot, time, { forecast: [{ time, hsM: 1.1, period: 14, direction: 250 }] });
  const hour = decorate(buildHour(bundle, spot, time), bundle);
  assert.equal(hour.source, "MOP forecast");
  assert.equal(hour.kind, "model");
  assert.ok(Math.abs(hour.hsFt - 1.1 * 3.280839895) < 0.02);
  assert.equal(hour.correction, null);
});

test("ECMWF fallback is bias-corrected and labeled when MOP forecast is absent", () => {
  const spot = spots.breaks.find((item) => item.id === "swamis");
  const time = pacificEpoch("2026-11-13T15:00");
  const bundle = fakeBundle(spot, time, { forecast: [] });
  bundle.marine["46225"] = {
    times: [time],
    columns: {
      wave_height: [2],
      swell_wave_period: [13],
      swell_wave_direction: [260],
    },
  };
  bundle.breaks.swamis.ratio = { ratio: 0.8, apply: true, reason: "ok", buoyName: "Torrey" };
  const hour = decorate(buildHour(bundle, spot, time), bundle);
  assert.equal(hour.source, "ECMWF WAM");
  assert.equal(hour.kind, "model");
  assert.ok(Math.abs(hour.hsFt - 2 * 0.8 * 3.280839895) < 0.02);
  assert.match(hour.correction, /×0\.8 vs Torrey/);
});

test("ten breaks, both buoys, and no Oceanside tide offset", () => {
  assert.equal(spots.breaks.length, 10);
  assert.equal(spots.buoys.length, 2);
  assert.equal(spots.oceansideTide.result, "no Oceanside predictions");
  assert.equal(spots.mopForecast.found, true);
  const miles = haversineM(33.178, -117.472, 32.933, -117.391) / 1609.344;
  assert.ok(miles > 15 && miles < 22, miles);
});

function fakeBundle(spot, time, mop) {
  return {
    spots,
    buoys: {
      46225: { hsM: 1.4, hsFt: 4.6, period: 14, direction: 255, time, ageMs: 600000, wtmpF: 63 },
    },
    tide: {
      predictions: [
        { time: time - 3600000, ft: 2 },
        { time, ft: 2.4 },
        { time: time + 3600000, ft: 2.8 },
      ],
      extremes: [{ time: time + 40 * 60000, ft: 4.1, type: "high" }],
    },
    weather: {
      times: [time],
      columns: {
        temperature_2m: [61],
        weather_code: [0],
        wind_speed_10m: [6],
        wind_direction_10m: [50],
        wind_gusts_10m: [9],
        precipitation_probability: [0],
        visibility: [20000],
      },
    },
    offshoreWind: { times: [time], columns: { wind_speed_10m: [7], wind_direction_10m: [40] } },
    sunrise: ["2026-11-13T06:20"],
    sunset: ["2026-11-13T16:50"],
    marine: {},
    breaks: {
      [spot.id]: {
        nowcast: { hsM: 1, hsFt: 3.28, period: 15, direction: 250, time, ageMs: 1200000 },
        forecast: mop.forecast,
        ratio: { ratio: null, apply: false, reason: "buoy", buoyName: "Torrey" },
      },
    },
    water: { f: 63, kind: "observed" },
    residual: null,
    stale: { buoy: false, tide: false, mop: false, weather: false },
  };
}

/** Buoys, MOP, ECMWF, La Jolla tide, and the coastal wind. */

import {
  M_TO_FT,
  agePhrase,
  biasRatio,
  cToF,
  closerBuoy,
  compass16,
  floorHourPacific,
  formatHour,
  lerp,
  lerpAngle,
  nearshorePhrase,
  pacificEpoch,
  pacificParts,
  rankWord,
  skyWord,
  tideBand,
  windWord,
} from "./spots.js";

const CDIP = "https://thredds.cdip.ucsd.edu/thredds/dodsC/cdip/model/MOP_alongshore";
const NOAA = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
const NDBC = "https://www.ndbc.noaa.gov/data/realtime2";

const TTL = {
  buoy: 10 * 60 * 1000,
  water: 10 * 60 * 1000,
  mop: 30 * 60 * 1000,
  meteo: 30 * 60 * 1000,
  tide: 12 * 60 * 60 * 1000,
};

function proxied(url) {
  return `/proxy?url=${encodeURIComponent(url)}`;
}

async function getText(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${url.split("?")[0]}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, timeoutMs = 20000) {
  return JSON.parse(await getText(url, timeoutMs));
}

function pacificDateString(ms = Date.now()) {
  const p = pacificParts(ms);
  return `${p.year}${String(p.month).padStart(2, "0")}${String(p.day).padStart(2, "0")}`;
}

function parseDods(text) {
  const body = text.split("---------------------------------------------")[1] || text;
  const out = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]\s*([^]*?)(?=\n[A-Za-z_][A-Za-z0-9_]*\[\d+\]|$)/g;
  let match;
  while ((match = re.exec(body))) {
    const nums = match[3]
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
    out[match[1]] = nums;
  }
  return out;
}

function goodWave(flag, hs) {
  if (flag === 4 || flag === 9) return false;
  if (!Number.isFinite(hs) || hs < 0 || hs > 25) return false;
  return true;
}

function rowsFromDods(parsed) {
  const n = (parsed.waveTime || []).length;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const flag = parsed.waveFlagPrimary?.[i];
    const hs = parsed.waveHs?.[i];
    if (!goodWave(flag, hs)) continue;
    const tp = parsed.waveTp?.[i];
    const dp = parsed.waveDp?.[i];
    rows.push({
      time: parsed.waveTime[i] * 1000,
      hsM: hs,
      period: Number.isFinite(tp) && tp > 0 && tp < 40 ? tp : null,
      direction: Number.isFinite(dp) && dp >= 0 && dp <= 360 ? dp : null,
    });
  }
  rows.sort((a, b) => a.time - b.time);
  return rows;
}

async function fetchMop(id, kind) {
  const base = `${CDIP}/${id}_${kind}.nc`;
  const dds = await getText(proxied(`${base}.dds`));
  const dim = Number((dds.match(/waveTime = (\d+)/) || [])[1]);
  if (!dim) throw new Error(`no waveTime in ${id} ${kind}`);
  const start = kind === "forecast" ? 0 : Math.max(0, dim - 36);
  const end = dim - 1;
  const query = ["waveTime", "waveHs", "waveTp", "waveDp", "waveFlagPrimary"]
    .map((name) => `${name}[${start}:1:${end}]`)
    .join(",");
  const ascii = await getText(proxied(`${base}.ascii?${query}`), 30000);
  return rowsFromDods(parseDods(ascii));
}

function parseNdbc(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const p = line.trim().split(/\s+/);
    if (p.length < 15) continue;
    const num = (value) => (value === "MM" || value === undefined ? null : Number(value));
    const year = Number(p[0]);
    const time = Date.UTC(year < 100 ? 2000 + year : year, Number(p[1]) - 1, Number(p[2]), Number(p[3]), Number(p[4]));
    const hs = num(p[8]);
    const period = num(p[9]);
    const direction = num(p[11]);
    const wtmp = num(p[14]);
    if (!Number.isFinite(time)) continue;
    rows.push({
      time,
      hsM: hs != null && hs < 90 ? hs : null,
      period: period != null && period < 90 ? period : null,
      direction: direction != null && direction <= 360 ? direction : null,
      wtmpC: wtmp != null && wtmp > -5 && wtmp < 45 ? wtmp : null,
    });
  }
  rows.sort((a, b) => b.time - a.time);
  return rows;
}

function latestBuoy(rows) {
  const row = rows.find((r) => r.hsM != null) || rows[0];
  if (!row) return null;
  return {
    ...row,
    hsFt: row.hsM == null ? null : row.hsM * M_TO_FT,
    wtmpF: row.wtmpC == null ? null : cToF(row.wtmpC),
    ageMs: Date.now() - row.time,
  };
}

function noaaUrl(params) {
  const q = new URLSearchParams({
    station: "9410230",
    datum: "MLLW",
    units: "english",
    time_zone: "lst_ldt",
    format: "json",
    begin_date: pacificDateString(),
    ...params,
  });
  return proxied(`${NOAA}?${q}`);
}

function parseNoaaTime(stamp) {
  return pacificEpoch(stamp.replace(" ", "T"));
}

async function fetchTide() {
  const [pred, hilo, water] = await Promise.all([
    getJson(noaaUrl({ product: "predictions", interval: "6", range: "96" })),
    getJson(noaaUrl({ product: "predictions", interval: "hilo", range: "96" })),
    getJson(noaaUrl({ product: "water_level", range: "24" })).catch(() => null),
  ]);
  const predictions = (pred.predictions || []).map((row) => ({
    time: parseNoaaTime(row.t),
    ft: Number(row.v),
  })).filter((row) => Number.isFinite(row.ft));
  const extremes = (hilo.predictions || []).map((row) => ({
    time: parseNoaaTime(row.t),
    ft: Number(row.v),
    type: row.type === "H" ? "high" : "low",
  })).filter((row) => Number.isFinite(row.ft));
  let residual = null;
  const levels = water?.data || [];
  if (levels.length && predictions.length) {
    const last = levels[levels.length - 1];
    const obsFt = Number(last.v);
    const obsTime = parseNoaaTime(last.t);
    const predFt = valueAt(predictions, obsTime);
    if (Number.isFinite(obsFt) && Number.isFinite(predFt)) {
      const ft = obsFt - predFt;
      residual = {
        ft,
        time: obsTime,
        ageMs: Date.now() - obsTime,
        show: Math.abs(ft) >= 0.3,
      };
    }
  }
  return { predictions, extremes, residual };
}

function marineUrl(lat, lon) {
  const q = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: [
      "wave_height",
      "wave_direction",
      "wave_period",
      "wave_peak_period",
      "swell_wave_height",
      "swell_wave_direction",
      "swell_wave_period",
      "swell_wave_peak_period",
      "secondary_swell_wave_height",
      "secondary_swell_wave_direction",
      "secondary_swell_wave_period",
      "wind_wave_height",
      "wind_wave_direction",
      "wind_wave_period",
      "sea_surface_temperature",
    ].join(","),
    models: "ecmwf_wam",
    cell_selection: "sea",
    timezone: "America/Los_Angeles",
    forecast_days: "7",
  });
  return `https://marine-api.open-meteo.com/v1/marine?${q}`;
}

const WEATHER_HOSTS = [
  "https://api.open-meteo.com/v1/forecast",
  "https://previous-runs-api.open-meteo.com/v1/forecast",
];

function weatherQuery(lat, lon) {
  return new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: [
      "temperature_2m",
      "weather_code",
      "wind_speed_10m",
      "wind_direction_10m",
      "wind_gusts_10m",
      "precipitation_probability",
      "cloud_cover",
      "visibility",
    ].join(","),
    daily: "sunrise,sunset",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    timezone: "America/Los_Angeles",
    forecast_days: "7",
  });
}

async function fetchWeather(lat, lon) {
  const q = weatherQuery(lat, lon);
  let last;
  for (let i = 0; i < WEATHER_HOSTS.length; i++) {
    try {
      return await getJson(`${WEATHER_HOSTS[i]}?${q}`, i === 0 ? 8000 : 20000);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

function seriesFromHourly(hourly, fields) {
  const times = (hourly.time || []).map((stamp) => pacificEpoch(stamp));
  const columns = {};
  for (const field of fields) columns[field] = hourly[field] || [];
  return { times, columns };
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function valueAt(rows, time) {
  if (!rows?.length) return null;
  if (time <= rows[0].time) return rows[0].ft ?? rows[0].value;
  if (time >= rows[rows.length - 1].time) return rows[rows.length - 1].ft ?? rows[rows.length - 1].value;
  let lo = 0;
  let hi = rows.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].time <= time) lo = mid;
    else hi = mid;
  }
  const span = rows[hi].time - rows[lo].time;
  const t = span > 0 ? (time - rows[lo].time) / span : 0;
  const a = rows[lo].ft ?? rows[lo].value;
  const b = rows[hi].ft ?? rows[hi].value;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.isFinite(a) ? a : b;
  return lerp(a, b, t);
}

function columnAt(series, field, time) {
  if (!series) return null;
  const times = series.times;
  const values = series.columns[field];
  if (!times?.length || !values) return null;
  if (time <= times[0]) return values[0];
  if (time >= times[times.length - 1]) return values[values.length - 1];
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  const t = span > 0 ? (time - times[lo]) / span : 0;
  const a = values[lo];
  const b = values[hi];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.isFinite(a) ? a : Number.isFinite(b) ? b : null;
  if (field.includes("direction")) return lerpAngle(a, b, t);
  return lerp(a, b, t);
}

function waveAt(rows, time) {
  if (!rows?.length) return null;
  const slack = 3 * 3600 * 1000;
  if (time < rows[0].time - slack || time > rows[rows.length - 1].time + slack) return null;
  if (time <= rows[0].time) return rows[0];
  if (time >= rows[rows.length - 1].time) return rows[rows.length - 1];
  let lo = 0;
  let hi = rows.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].time <= time) lo = mid;
    else hi = mid;
  }
  const span = rows[hi].time - rows[lo].time;
  const t = span > 0 ? (time - rows[lo].time) / span : 0;
  return {
    time,
    hsM: lerp(rows[lo].hsM, rows[hi].hsM, t),
    period: lerp(rows[lo].period ?? rows[hi].period, rows[hi].period ?? rows[lo].period, t),
    direction: lerpAngle(rows[lo].direction, rows[hi].direction, t),
  };
}

function ecmwfWave(marine, time) {
  // Combined significant height matches buoy Hs and MOP waveHs. Period and
  // direction come from the primary swell when the model has one.
  const hsM = columnAt(marine, "wave_height", time);
  const period = firstNumber([
    columnAt(marine, "swell_wave_peak_period", time),
    columnAt(marine, "swell_wave_period", time),
    columnAt(marine, "wave_peak_period", time),
    columnAt(marine, "wave_period", time),
  ], (value) => value > 0 && value < 40);
  const direction = firstNumber([
    columnAt(marine, "swell_wave_direction", time),
    columnAt(marine, "wave_direction", time),
  ], (value) => value >= 0 && value <= 360);
  return {
    hsM,
    period,
    direction,
    secondaryH: columnAt(marine, "secondary_swell_wave_height", time),
    secondaryDir: columnAt(marine, "secondary_swell_wave_direction", time),
    secondaryP: columnAt(marine, "secondary_swell_wave_period", time),
  };
}

function firstNumber(values, ok) {
  return values.find((value) => Number.isFinite(value) && ok(value)) ?? null;
}

function latestNowcast(rows) {
  if (!rows?.length) return null;
  const now = Date.now();
  const fresh = rows.filter((row) => row.time <= now + 45 * 60 * 1000);
  const row = fresh[fresh.length - 1] || rows[rows.length - 1];
  return { ...row, hsFt: row.hsM * M_TO_FT, ageMs: now - row.time };
}

function dayRange(predictions, time) {
  const p = pacificParts(time);
  const start = pacificEpoch(`${p.year}-${pad(p.month)}-${pad(p.day)}T00:00`);
  const end = start + 24 * 3600 * 1000;
  let lo = Infinity;
  let hi = -Infinity;
  for (const row of predictions) {
    if (row.time < start || row.time >= end) continue;
    if (row.ft < lo) lo = row.ft;
    if (row.ft > hi) hi = row.ft;
  }
  if (!Number.isFinite(lo)) return { lo: null, hi: null };
  return { lo, hi };
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function nextExtreme(extremes, time, falling) {
  const want = falling ? "low" : "high";
  return extremes.find((row) => row.time >= time - 5 * 60 * 1000 && row.type === want) || null;
}

function isDark(time, sunrise, sunset) {
  if (!sunrise?.length || !sunset?.length) return false;
  const p = pacificParts(time);
  const key = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const rise = sunrise.find((stamp) => stamp.startsWith(key));
  const set = sunset.find((stamp) => stamp.startsWith(key));
  if (!rise || !set) return false;
  const t = time;
  return t < pacificEpoch(rise) || t > pacificEpoch(set);
}

export function buildHour(bundle, spot, time) {
  const breakData = bundle.breaks[spot.id] || {};
  const buoyMeta = closerBuoy(spot, bundle.spots.buoys);
  const buoy = bundle.buoys[buoyMeta.id];
  const marine = bundle.marine[buoyMeta.id];
  let hsM = null;
  let period = null;
  let direction = null;
  let source = null;
  let correction = null;
  let correctionSkipped = false;
  const secondary = marine ? ecmwfWave(marine, time) : null;

  const forecast = waveAt(breakData.forecast, time);
  if (forecast && Number.isFinite(forecast.hsM)) {
    hsM = forecast.hsM;
    period = forecast.period;
    direction = forecast.direction;
    source = "MOP forecast";
  } else if (secondary && Number.isFinite(secondary.hsM)) {
    const ratio = breakData.ratio;
    if (ratio?.apply) {
      hsM = secondary.hsM * ratio.ratio;
      correction = `\u00d7${ratio.ratio.toFixed(1)} vs ${buoyMeta.short}`;
    } else {
      hsM = secondary.hsM;
      correctionSkipped = ratio?.reason === "range";
    }
    period = secondary.period;
    direction = secondary.direction;
    source = "ECMWF WAM";
  }

  const tideFt = valueAt(bundle.tide?.predictions, time);
  const ahead = valueAt(bundle.tide?.predictions, time + 18 * 60 * 1000);
  const behind = valueAt(bundle.tide?.predictions, time - 18 * 60 * 1000);
  const slope = Number.isFinite(ahead) && Number.isFinite(behind) ? (ahead - behind) / 0.6 : 0;
  const rising = slope >= 0;
  const range = dayRange(bundle.tide?.predictions || [], time);
  const band = tideBand(tideFt, range.lo, range.hi);
  const extreme = nextExtreme(bundle.tide?.extremes || [], time, !rising);

  const windMph = columnAt(bundle.weather, "wind_speed_10m", time);
  const windFrom = columnAt(bundle.weather, "wind_direction_10m", time);
  const gust = columnAt(bundle.weather, "wind_gusts_10m", time);
  const offshoreMph = columnAt(bundle.offshoreWind, "wind_speed_10m", time);
  const word = windWord(spot.shoreNormal, windFrom, windMph);
  const temp = columnAt(bundle.weather, "temperature_2m", time);
  const code = columnAt(bundle.weather, "weather_code", time);
  const pop = columnAt(bundle.weather, "precipitation_probability", time);
  const vis = columnAt(bundle.weather, "visibility", time);
  let sky = skyWord(code);
  if (code === 45 || code === 48 || (Number.isFinite(vis) && vis < 1609)) sky = "fog";

  const hsFt = Number.isFinite(hsM) ? hsM * M_TO_FT : null;
  return {
    time,
    hsFt,
    hsM,
    period: Number.isFinite(period) ? period : null,
    direction: Number.isFinite(direction) ? direction : null,
    source,
    correction,
    correctionSkipped,
    secondaryH: secondary?.secondaryH ?? null,
    secondaryDir: secondary?.secondaryDir ?? null,
    secondaryP: secondary?.secondaryP ?? null,
    tideFt,
    rising,
    band,
    extreme,
    windMph,
    windFrom,
    gust,
    wind: word,
    offshoreMph: Number.isFinite(offshoreMph) && Number.isFinite(windMph) && Math.abs(offshoreMph - windMph) > 8 ? offshoreMph : null,
    temp,
    sky,
    pop: Number.isFinite(pop) && pop >= 30 ? pop : null,
    night: isDark(time, bundle.sunrise, bundle.sunset),
    spot,
    buoy,
    hsFtRank: hsFt,
  };
}

function withNowcast(hour, bundle, spot) {
  const near = Math.abs(hour.time - Date.now()) < 45 * 60 * 1000;
  const nowcast = bundle.breaks[spot.id]?.nowcast;
  if (near && nowcast) {
    return {
      ...hour,
      hsFt: nowcast.hsFt,
      hsM: nowcast.hsM,
      period: nowcast.period ?? hour.period,
      direction: nowcast.direction ?? hour.direction,
      source: "MOP nowcast",
      hsFtRank: nowcast.hsFt,
    };
  }
  if (near && !nowcast && hour.buoy?.hsFt != null && hour.source == null) {
    return {
      ...hour,
      hsFt: hour.buoy.hsFt,
      period: hour.buoy.period,
      direction: hour.buoy.direction,
      source: "offshore buoy, no nearshore model",
      kindOverride: "observed",
      hsFtRank: hour.buoy.hsFt,
    };
  }
  if (!hour.source && hour.buoy?.hsFt != null && near) {
    return {
      ...hour,
      hsFt: hour.buoy.hsFt,
      period: hour.buoy.period,
      direction: hour.buoy.direction,
      source: "offshore buoy, no nearshore model",
      kindOverride: "observed",
      hsFtRank: hour.buoy.hsFt,
    };
  }
  return hour;
}

export function decorate(hour, bundle) {
  const sample = withNowcast(hour, bundle, hour.spot);
  const kind = sample.kindOverride || "model";
  const rank = rankWord({
    hsFt: sample.hsFt,
    period: sample.period,
    wind: sample.wind,
    windMph: sample.windMph,
    band: sample.band,
    rising: sample.rising,
    pref: sample.spot.tidePref,
    sizeFt: sample.spot.sizeFt,
  });
  return { ...sample, kind, rank };
}

export function hours48(bundle, spot, start) {
  const hours = [];
  for (let i = 0; i < 48; i++) hours.push(decorate(buildHour(bundle, spot, start + i * 3600 * 1000), bundle));
  return hours;
}

function daytimeSamples(bundle, spot, year, month, day) {
  const samples = [];
  for (let hour = 7; hour <= 17; hour++) {
    const time = pacificEpoch(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:00`);
    samples.push(decorate(buildHour(bundle, spot, time), bundle));
  }
  return samples;
}

export function outlook(bundle, spot, now = Date.now()) {
  const today = pacificParts(now);
  const parts = [];
  for (let add = 3; add <= 7; add++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + add));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const samples = daytimeSamples(bundle, spot, year, month, day);
    const heights = samples.map((s) => s.hsFt).filter((v) => Number.isFinite(v));
    if (heights.length < 3) continue;
    const lo = Math.round(Math.min(...heights));
    const hi = Math.round(Math.max(...heights));
    const height = lo === hi ? `${lo} ft` : `${lo}\u2013${hi} ft`;
    const noon = samples.find((s) => pacificParts(s.time).hour === 12) || samples[4];
    const morning = samples.filter((s) => pacificParts(s.time).hour < 12);
    const midday = samples.filter((s) => {
      const h = pacificParts(s.time).hour;
      return h >= 11 && h <= 15;
    });
    let windBit = noon?.wind || "";
    const compass = compass16(noon?.windFrom);
    if (midday.some((s) => s.wind === "onshore") && morning.some((s) => s.wind && s.wind !== "onshore")) {
      windBit = `${compass} wind onshore by noon`.trim();
    } else if (windBit) {
      windBit = `${compass} wind ${windBit}`.trim();
    }
    const dow = pacificParts(pacificEpoch(`${year}-${pad(month)}-${pad(day)}T12:00`)).weekday;
    parts.push(windBit ? `${dow} ${height}, ${windBit}` : `${dow} ${height}`);
  }
  return parts.join("  \u00b7  ");
}

export function chooseTime(bundle, spot, now = Date.now()) {
  const start = floorHourPacific(now);
  let from = start;
  const p = pacificParts(now);
  const key = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const riseStamp = (bundle.sunrise || []).find((stamp) => stamp.startsWith(key));
  const setStamp = (bundle.sunset || []).find((stamp) => stamp.startsWith(key));
  const dark = (riseStamp && now < pacificEpoch(riseStamp)) || (setStamp && now > pacificEpoch(setStamp));
  const nextRise = (bundle.sunrise || []).map((stamp) => pacificEpoch(stamp)).find((t) => t > now);
  if (dark && nextRise) from = floorHourPacific(nextRise);
  const end = from + 18 * 3600 * 1000;
  let best = null;
  for (let time = from; time <= end; time += 3600 * 1000) {
    const hour = decorate(buildHour(bundle, spot, time), bundle);
    const score = scoreHour(hour);
    if (!best || score > best.score) best = { time, score };
  }
  return best?.time ?? from;
}

function scoreHour(hour) {
  const rank = { go: 300, maybe: 200, skip: 100 }[hour.rank] || 0;
  const period = hour.period || 0;
  const wind = hour.wind === "offshore" ? 8 : hour.wind === "calm" ? 5 : 0;
  const size = Number.isFinite(hour.hsFt) ? -Math.abs(hour.hsFt - 4) : -10;
  return rank + period + wind + size;
}

export function sentence(hour) {
  if (!Number.isFinite(hour.hsFt)) return "No nearshore height for this hour.";
  const bits = [nearshorePhrase(hour.hsFt)];
  if (hour.period) bits.push(`${Math.round(hour.period)} s from the ${compass16(hour.direction)}`.replace(/ from the $/, ""));
  if (hour.wind === "calm") bits.push("calm");
  else if (hour.wind) {
    const light = hour.windMph < 10 ? "light " : "";
    bits.push(`${light}${hour.wind}`);
  }
  if (hour.band) bits.push(`${hour.band} and ${hour.rising ? "rising" : "dropping"}`);
  return `${bits.join(", ")}.`;
}

export function liveText(hour, bundle) {
  if (!hour) return "Loading the coast.";
  const lines = [hour.spot.name];
  if (Number.isFinite(hour.hsFt)) {
    const label = hour.kind === "observed" ? "observed Hs" : "model Hs";
    lines.push(`${hour.hsFt.toFixed(1)} ft nearshore ${label}`);
  } else lines.push(hour.source || "no nearshore model");
  if (hour.period) lines.push(`${Math.round(hour.period)} seconds from the ${compass16(hour.direction)}`);
  if (hour.correction) lines.push(hour.correction);
  if (hour.correctionSkipped) lines.push("correction skipped");
  if (hour.wind) lines.push(`${hour.wind} ${compass16(hour.windFrom)} ${Math.round(hour.windMph)} mph`);
  if (Number.isFinite(hour.tideFt)) lines.push(`tide ${hour.tideFt.toFixed(1)} ft ${hour.rising ? "rising" : "falling"} prediction`);
  if (bundle.residual?.show) {
    const dir = bundle.residual.ft >= 0 ? "above" : "below";
    lines.push(`La Jolla running ${Math.abs(bundle.residual.ft).toFixed(1)} ft ${dir} the prediction observed`);
  }
  if (bundle.water) lines.push(`water ${Math.round(bundle.water.f)} ${bundle.water.kind}`);
  lines.push(hour.rank || "");
  lines.push(sentence(hour));
  lines.push(ageLine(bundle, hour));
  return lines.filter(Boolean).join(". ");
}

export function ageLine(bundle, hour) {
  const bits = [];
  const buoy = hour?.buoy;
  if (buoy) bits.push(`buoy ${agePhrase(buoy.ageMs)} · observed${bundle.stale.buoy ? " · stale" : ""}`);
  const nowcast = bundle.breaks[hour.spot.id]?.nowcast;
  if (nowcast) bits.push(`MOP ${agePhrase(nowcast.ageMs)} · model${bundle.stale.mop ? " · stale" : ""}`);
  else if (hour.source) bits.push(`${hour.source} · ${hour.kind}${bundle.stale.mop ? " · stale" : ""}`);
  bits.push(`tide · prediction${bundle.stale.tide ? " · stale" : ""}`);
  if (bundle.residual) bits.push(`La Jolla gauge ${agePhrase(bundle.residual.ageMs)} · observed`);
  return bits.join("  ·  ");
}

function waterTemp(bundle) {
  const rows = Object.values(bundle.buoys || {}).filter((b) => b?.wtmpF != null);
  rows.sort((a, b) => b.time - a.time);
  if (rows.length) return { f: rows[0].wtmpF, kind: "observed", time: rows[0].time };
  const marine = Object.values(bundle.marine || [])[0];
  const c = marine ? columnAt(marine, "sea_surface_temperature", Date.now()) : null;
  if (Number.isFinite(c)) return { f: cToF(c), kind: "model SST", time: null };
  return null;
}

async function keep(previous, key, fn) {
  try {
    const value = await fn();
    return { ok: true, value, stale: false };
  } catch (err) {
    const prior = previous?.[key];
    if (prior) return { ok: false, value: prior, stale: true, error: String(err.message || err) };
    return { ok: false, value: null, stale: true, error: String(err.message || err) };
  }
}

export async function loadSeries(spots, previous = null) {
  const cache = previous?._cache || null;
  const buoyJob = keep(cache, "buoyRows", async () => {
    const entries = await Promise.all(spots.buoys.map(async (buoy) => {
      const text = await getText(proxied(`${NDBC}/${buoy.id}.txt`));
      const latest = latestBuoy(parseNdbc(text));
      return [buoy.id, latest];
    }));
    return Object.fromEntries(entries);
  });

  const tideJob = keep(cache, "tide", () => fetchTide());

  const weatherJob = keep(cache, "weatherPack", async () => {
    const [coast, offshore] = await Promise.all([
      fetchWeather(spots.weatherPoint.lat, spots.weatherPoint.lon),
      fetchWeather(spots.buoys[0].lat, spots.buoys[0].lon),
    ]);
    return { coast, offshore };
  });

  const marineJob = keep(cache, "marine", async () => {
    const entries = await Promise.all(spots.buoys.map(async (buoy) => {
      const json = await getJson(marineUrl(buoy.lat, buoy.lon));
      return [buoy.id, seriesFromHourly(json.hourly || {}, Object.keys(json.hourly || {}).filter((k) => k !== "time"))];
    }));
    return Object.fromEntries(entries);
  });

  const mopJob = keep(cache, "mop", async () => {
    const rows = await pool(spots.breaks, 4, async (spot) => {
      const [nowcastRows, forecastRows] = await Promise.all([
        fetchMop(spot.mop, "nowcast").catch(() => null),
        fetchMop(spot.mop, "forecast").catch(() => null),
      ]);
      return [spot.id, { nowcastRows, forecastRows }];
    });
    return Object.fromEntries(rows);
  });

  const [buoyRows, tide, weatherPack, marine, mop] = await Promise.all([
    buoyJob, tideJob, weatherJob, marineJob, mopJob,
  ]);

  const bundle = {
    spots,
    buoys: buoyRows.value || {},
    tide: tide.value,
    weather: null,
    offshoreWind: null,
    sunrise: weatherPack.value?.coast?.daily?.sunrise || [],
    sunset: weatherPack.value?.coast?.daily?.sunset || [],
    marine: marine.value || {},
    breaks: {},
    stale: {
      buoy: buoyRows.stale,
      tide: tide.stale,
      weather: weatherPack.stale,
      marine: marine.stale,
      mop: mop.stale,
    },
    errors: [buoyRows, tide, weatherPack, marine, mop].map((j) => j.error).filter(Boolean),
    fetchedAt: Date.now(),
  };

  if (weatherPack.value?.coast?.hourly) {
    bundle.weather = seriesFromHourly(weatherPack.value.coast.hourly, [
      "temperature_2m", "weather_code", "wind_speed_10m", "wind_direction_10m",
      "wind_gusts_10m", "precipitation_probability", "cloud_cover", "visibility",
    ]);
  }
  if (weatherPack.value?.offshore?.hourly) {
    bundle.offshoreWind = seriesFromHourly(weatherPack.value.offshore.hourly, [
      "wind_speed_10m", "wind_direction_10m",
    ]);
  }

  for (const spot of spots.breaks) {
    const mopRows = mop.value?.[spot.id] || {};
    const nowcast = latestNowcast(mopRows.nowcastRows);
    const buoyMeta = closerBuoy(spot, spots.buoys);
    const buoy = bundle.buoys[buoyMeta.id];
    const ratio = biasRatio(nowcast?.hsM, buoy?.hsM);
    bundle.breaks[spot.id] = {
      nowcast,
      forecast: mopRows.forecastRows || [],
      ratio: { ...ratio, buoyId: buoyMeta.id, buoyName: buoyMeta.short },
    };
  }

  bundle.water = waterTemp(bundle);
  bundle.residual = tide.value?.residual || null;
  bundle._cache = { buoyRows: buoyRows.value, tide: tide.value, weatherPack: weatherPack.value, marine: marine.value, mop: mop.value };
  return bundle;
}

export function needsRefresh(bundle, now = Date.now()) {
  if (!bundle?.fetchedAt) return true;
  return now - bundle.fetchedAt > TTL.buoy;
}

export { TTL, formatHour, agePhrase };

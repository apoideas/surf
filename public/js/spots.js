/** Breaks, projection, and the pure session words. No network. */

export const LAT0 = 33.08;
export const LON0 = -117.32;
export const M_PER_DEG_LAT = 111320;
export const M_PER_DEG_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
export const PITCH = (55 * Math.PI) / 180;
export const YAW_LIMIT = (20 * Math.PI) / 180;
export const M_TO_FT = 3.280839895;

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

export function projectMeters(lon, lat) {
  return {
    x: (lon - LON0) * M_PER_DEG_LON,
    y: (lat - LAT0) * M_PER_DEG_LAT,
  };
}

export function wrap360(deg) {
  return ((deg % 360) + 360) % 360;
}

/** Signed smallest difference a - b, in (-180, 180]. */
export function angDiff(a, b) {
  return wrap360(a - b + 180) - 180;
}

export function compass16(deg) {
  if (!Number.isFinite(deg)) return "";
  return COMPASS[Math.round(wrap360(deg) / 22.5) % 16];
}

export function cToF(c) {
  return c * 9 / 5 + 32;
}

export function haversineM(lat1, lon1, lat2, lon2) {
  const r = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function closerBuoy(spot, buoys) {
  let best = buoys[0];
  let bestD = Infinity;
  for (const buoy of buoys) {
    const d = haversineM(spot.lat, spot.lon, buoy.lat, buoy.lon);
    if (d < bestD) {
      best = buoy;
      bestD = d;
    }
  }
  return best;
}

/**
 * Wind-from relative to the shore-normal (the direction the break faces, toward the sea).
 * Under 5 mph is calm. Within 60° of the landward opposite is offshore. 60–120° is cross.
 */
export function windWord(shoreNormal, windFrom, windMph) {
  if (!Number.isFinite(windMph)) return null;
  if (windMph < 5) return "calm";
  if (!Number.isFinite(windFrom) || !Number.isFinite(shoreNormal)) return null;
  const offshoreFrom = wrap360(shoreNormal + 180);
  const off = Math.abs(angDiff(windFrom, offshoreFrom));
  if (off <= 60) return "offshore";
  if (off <= 120) return "cross";
  return "onshore";
}

/**
 * Latest MOP Hs / buoy Hs. Apply only when the buoy is at least 0.3 m and the
 * ratio sits inside 0.5–1.5. Otherwise the caller shows both and skips the correction.
 */
export function biasRatio(mopHsM, buoyHsM) {
  if (!(buoyHsM >= 0.3) || !(mopHsM > 0)) {
    return { ratio: null, apply: false, reason: "buoy" };
  }
  const ratio = mopHsM / buoyHsM;
  if (ratio < 0.5 || ratio > 1.5) return { ratio, apply: false, reason: "range" };
  return { ratio, apply: true, reason: "ok" };
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function lerpAngle(a, b, t) {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  return wrap360(a + angDiff(b, a) * t);
}

export function tideBand(ft, lo, hi) {
  if (!Number.isFinite(ft) || !(hi > lo)) return null;
  const t = (ft - lo) / (hi - lo);
  if (t < 0.33) return "low";
  if (t < 0.66) return "mid";
  return "high";
}

export function tideMatches(pref, band, rising, period) {
  if (!pref || !band) return true;
  if (pref.band === "low-mid" && band === "high" && !(pref.longPeriodOkHigh && period >= 14)) return false;
  if (pref.phase === "incoming" && !rising && band === "high" && !(pref.longPeriodOkHigh && period >= 14)) return false;
  return true;
}

/** go / maybe / skip. The number behind it is not shown. */
export function rankWord({ hsFt, period, wind, windMph, band, rising, pref, sizeFt }) {
  const [lo, hi] = sizeFt || [2, 6];
  const sizeOk = hsFt >= lo && hsFt <= hi;
  const periodOk = period >= 10;
  const windOk = wind === "calm" || wind === "offshore" || (wind === "cross" && windMph < 12);
  const tideOk = tideMatches(pref, band, rising, period);
  if (wind === "onshore" && windMph >= 12) return "skip";
  if (!(hsFt >= 1.5)) return "skip";
  if (sizeOk && periodOk && windOk && tideOk) return "go";
  if (wind === "onshore" && windMph >= 10 && period < 12) return "skip";
  if (hsFt < lo && period < 10) return "skip";
  return "maybe";
}

export function nearshorePhrase(ft) {
  if (!Number.isFinite(ft)) return "no nearshore height";
  const rounded = Math.round(ft);
  if (Math.abs(ft - rounded) < 0.05) return `${rounded} ft nearshore`;
  const lo = Math.floor(ft);
  return `${lo}\u2013${lo + 1} ft nearshore`;
}

export function skyWord(code) {
  if (code == null || !Number.isFinite(code)) return "";
  if (code === 0) return "clear";
  if (code === 1) return "mainly clear";
  if (code === 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "showers";
  if (code >= 95) return "thunder";
  return "";
}

const pacificFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

export function pacificParts(ms) {
  const bag = {};
  for (const part of pacificFormat.formatToParts(new Date(ms))) bag[part.type] = part.value;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour),
    minute: Number(bag.minute),
    weekday: bag.weekday,
  };
}

/** Wall time in America/Los_Angeles, "YYYY-MM-DDTHH:MM", to epoch ms. */
export function pacificEpoch(localIso) {
  const [date, time] = localIso.split(/[T ]/);
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  let utc = Date.UTC(year, month - 1, day, hour + 8, minute || 0);
  const got = pacificParts(utc);
  const gotUtc = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute);
  const want = Date.UTC(year, month - 1, day, hour, minute || 0);
  return utc + (want - gotUtc);
}

export function floorHourPacific(ms) {
  const p = pacificParts(ms);
  const mo = String(p.month).padStart(2, "0");
  const d = String(p.day).padStart(2, "0");
  const h = String(p.hour).padStart(2, "0");
  return pacificEpoch(`${p.year}-${mo}-${d}T${h}:00`);
}

export function formatHour(ms) {
  const p = pacificParts(ms);
  const h = p.hour % 12 || 12;
  const min = String(p.minute).padStart(2, "0");
  const ap = p.hour < 12 ? "am" : "pm";
  return `${p.weekday} ${h}:${min}${ap}`;
}

export function formatClock(ms) {
  const p = pacificParts(ms);
  const h = p.hour % 12 || 12;
  const min = String(p.minute).padStart(2, "0");
  const ap = p.hour < 12 ? "am" : "pm";
  return `${h}:${min}${ap}`;
}

export function agePhrase(ms) {
  if (!Number.isFinite(ms)) return "";
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return "just now";
  if (min < 90) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h === 1 ? "1 h ago" : `${h} h ago`;
}

export function addDays(year, month, day, n) {
  const t = new Date(Date.UTC(year, month - 1, day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

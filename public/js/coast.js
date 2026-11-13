/** Canvas coast: equirectangular meters, 55° pitch, gold contours, stem, 48-hour strip. */

import {
  PITCH,
  YAW_LIMIT,
  compass16,
  formatClock,
  formatHour,
  pacificEpoch,
  projectMeters,
} from "./spots.js";
import { ageLine, sentence } from "./series.js";

export const GOLD = [244, 220, 106];
const INK = "#1b1408";
const FONT = 'Inter, "Segoe UI", Helvetica, Arial, sans-serif';

export function gold(alpha) {
  return `rgba(${GOLD[0]}, ${GOLD[1]}, ${GOLD[2]}, ${alpha})`;
}

export function prepareCoast(collection) {
  const features = collection.features.map((feature) => {
    const kind = feature.properties.kind;
    const z = kind === "land" ? feature.properties.elevM : kind === "depth" ? -feature.properties.depthM : 0;
    const xy = feature.geometry.coordinates.map(([lon, lat]) => {
      const point = projectMeters(lon, lat);
      return [point.x, point.y, z];
    });
    return { ...feature.properties, xy };
  });
  const shoreWest = new Map();
  for (const feature of features) {
    if (feature.kind !== "shore") continue;
    for (const [x, y] of feature.xy) {
      const key = Math.round(y / 40);
      const prev = shoreWest.get(key);
      if (prev == null || x < prev) shoreWest.set(key, x);
    }
  }
  return { features, shoreWest, meta: collection.properties || {} };
}

export function layoutOf(width, height) {
  const days = width < 720 ? 36 : 22;
  const strip = Math.max(64, Math.min(86, height * 0.1));
  return {
    strip: { x: 14, y: height - days - strip - 10, w: Math.max(10, width - 28), h: strip },
    daysY: height - 8,
    mapBottom: height - days - strip - 16,
  };
}

export function fitCamera(width, height) {
  const corners = [
    [-117.52, 32.90],
    [-117.52, 33.23],
    [-117.20, 32.90],
    [-117.20, 33.23],
  ].map(([lon, lat]) => projectMeters(lon, lat));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const originX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const originY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const halfW = (Math.max(...xs) - Math.min(...xs)) / 2;
  const halfH = ((Math.max(...ys) - Math.min(...ys)) / 2) * Math.sin(PITCH);
  const layout = layoutOf(width, height);
  const viewW = Math.max(40, width - 28);
  const viewH = Math.max(40, layout.mapBottom - 16);
  const scale = Math.min(viewW / (halfW * 2), viewH / (halfH * 2)) * 0.94;
  return {
    yaw: 0,
    panX: 0,
    panY: 0,
    scale,
    baseScale: scale,
    originX,
    originY,
    cx: width / 2,
    cy: layout.mapBottom / 2,
  };
}

export function project(x, y, z, cam) {
  const dx = x - cam.originX;
  const dy = y - cam.originY;
  const cy = Math.cos(cam.yaw);
  const syaw = Math.sin(cam.yaw);
  const xr = dx * cy - dy * syaw;
  const yr = dx * syaw + dy * cy;
  const screenY = yr * Math.sin(PITCH) + (z || 0) * Math.cos(PITCH);
  return {
    x: cam.cx + cam.panX + xr * cam.scale,
    y: cam.cy + cam.panY - screenY * cam.scale,
  };
}

export function screenToWorld(sx, sy, cam) {
  const px = (sx - cam.cx - cam.panX) / cam.scale;
  const py = (cam.cy + cam.panY - sy) / cam.scale;
  const yr = py / Math.sin(PITCH);
  const xr = px;
  const cy = Math.cos(cam.yaw);
  const syaw = Math.sin(cam.yaw);
  return {
    x: cam.originX + xr * cy + yr * syaw,
    y: cam.originY - xr * syaw + yr * cy,
  };
}

function font(size) {
  return `600 ${size}px ${FONT}`;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function isWater(x, y, bins) {
  const key = Math.round(y / 40);
  let shore = null;
  for (let k = key - 3; k <= key + 3; k++) {
    const value = bins.get(k);
    if (value == null) continue;
    if (shore == null || value < shore) shore = value;
  }
  if (shore == null) return false;
  return x < shore - 30;
}

function styleFor(feature) {
  if (feature.kind === "shore") return { width: 1.05, alpha: 0.72 };
  if (feature.kind === "land") return { width: 1.05, alpha: 0.5 };
  const depth = feature.depthM || 100;
  return { width: 1.05, alpha: depth >= 50 ? 0.28 : 0.42 };
}

function buildPaths(ctx, view) {
  const { coast, cam, selected } = view;
  const paths = [];
  const highlight = [];
  const breakXY = selected ? projectMeters(selected.lon, selected.lat) : null;
  for (const feature of coast.features) {
    const style = styleFor(feature);
    const path = new Path2D();
    let open = false;
    feature.xy.forEach(([x, y, z], index) => {
      const p = project(x, y, z, cam);
      if (!open) {
        path.moveTo(p.x, p.y);
        open = true;
      } else path.lineTo(p.x, p.y);
      if (breakXY && index > 0) {
        const prev = feature.xy[index - 1];
        const midX = (x + prev[0]) / 2;
        const midY = (y + prev[1]) / 2;
        const near = (midX - breakXY.x) ** 2 + (midY - breakXY.y) ** 2;
        const shoreHit = feature.kind === "shore" && near < 450 ** 2;
        const ringHit = feature.kind === "depth" && feature.depthM === 10 && near < 900 ** 2;
        if (shoreHit || ringHit) {
          const a = project(prev[0], prev[1], prev[2], cam);
          const b = project(x, y, z, cam);
          highlight.push([a, b]);
        }
      }
    });
    paths.push({ path, ...style });
  }
  return { paths, highlight };
}

function drawCrests(ctx, view) {
  const hour = view.hour;
  if (!hour?.period || !Number.isFinite(hour.direction)) return;
  const families = [{
    direction: hour.direction,
    period: hour.period,
    alpha: hour.kind === "observed" ? 0.7 : 1,
  }];
  if (hour.source === "ECMWF WAM" && hour.secondaryH > 0 && hour.hsM > 0 && hour.secondaryH >= hour.hsM * 0.45 && Number.isFinite(hour.secondaryDir)) {
    families.push({ direction: hour.secondaryDir, period: hour.secondaryP || hour.period, alpha: 0.45 });
  }
  const layout = view.layout;
  const mid = screenToWorld(view.width / 2, layout.mapBottom * 0.55, view.cam);
  const span = view.width / view.cam.scale;
  ctx.lineWidth = 1.05;
  for (const family of families) {
    const toward = ((family.direction + 180) * Math.PI) / 180;
    const dx = Math.sin(toward);
    const dy = Math.cos(toward);
    const px = -dy;
    const py = dx;
    const wavelength = Math.min(6000, Math.max(60, 1.561 * family.period * family.period));
    const spacing = Math.max(wavelength, span / 8);
    const phase = ((view.crestPhase % 1) + 1) % 1;
    const length = Math.min(9000, span * 0.55);
    ctx.strokeStyle = gold(family.alpha);
    for (let k = -6; k <= 6; k++) {
      const along = (k + phase) * spacing;
      const ox = mid.x - 2500 * Math.cos(view.cam.yaw) + dx * along;
      const oy = mid.y + dy * along;
      const runs = clipRun(ox - px * length / 2, oy - py * length / 2, ox + px * length / 2, oy + py * length / 2, view.coast.shoreWest);
      for (const run of runs) {
        ctx.beginPath();
        run.forEach(([x, y], i) => {
          const p = project(x, y, 0, view.cam);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();
      }
    }
  }
}

function clipRun(x0, y0, x1, y1, bins) {
  const steps = 14;
  const runs = [];
  let run = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    if (isWater(x, y, bins)) run.push([x, y]);
    else if (run.length > 1) {
      runs.push(run);
      run = [];
    } else run = [];
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

function drawPlaces(ctx, view) {
  const size = Math.max(12, Math.min(15, view.width * 0.013));
  ctx.font = font(size);
  ctx.textBaseline = "middle";
  const placed = [];
  for (const buoy of view.spots.buoys) {
    const xy = projectMeters(buoy.lon, buoy.lat);
    const p = project(xy.x, xy.y, 0, view.cam);
    ctx.strokeStyle = gold(0.7);
    ctx.lineWidth = 1.05;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = gold(0.62);
    ctx.textAlign = "right";
    ctx.fillText(buoy.short, p.x - 8, p.y);
    placed.push(p);
  }
  ctx.textAlign = "left";
  const labels = view.spots.breaks
    .filter((spot) => !view.selected || spot.id !== view.selected.id)
    .map((spot) => {
      const xy = projectMeters(spot.lon, spot.lat);
      const p = project(xy.x, xy.y, 0, view.cam);
      return { spot, ...p };
    })
    .sort((a, b) => a.y - b.y);
  let lastY = -999;
  for (const label of labels) {
    ctx.fillStyle = gold(0.45);
    ctx.beginPath();
    ctx.arc(label.x, label.y, 2.6, 0, Math.PI * 2);
    ctx.fill();
    let y = label.y;
    if (y - lastY < 13) y = lastY + 13;
    lastY = y;
    if (y > view.layout.mapBottom - 4 || y < 12) continue;
    ctx.fillStyle = gold(0.45);
    ctx.fillText(label.spot.name, label.x + 8, y);
  }
  if (view.selected) {
    const xy = projectMeters(view.selected.lon, view.selected.lat);
    const p = project(xy.x, xy.y, 0, view.cam);
    ctx.fillStyle = gold(1);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function tokenise(text) {
  const parts = text.split(/(\d+(?:\.\d+)?)/);
  return parts.filter((part) => part !== "").map((part) => ({ text: part, num: /^\d/.test(part) }));
}

function drawTokens(ctx, x, y, text, hover, size) {
  ctx.font = font(size);
  ctx.textBaseline = "alphabetic";
  const tokens = tokenise(text);
  let cursor = x;
  const boxes = [];
  for (const token of tokens) {
    const w = ctx.measureText(token.text).width;
    if (hover && token.num) {
      ctx.fillStyle = gold(1);
      roundRect(ctx, cursor - 5, y - size + 2, w + 10, size + 6, 12);
      ctx.fill();
      ctx.fillStyle = INK;
    } else ctx.fillStyle = gold(0.96);
    ctx.fillText(token.text, cursor, y);
    boxes.push({ x: cursor, y: y - size, w, h: size + 8 });
    cursor += w;
  }
  return { width: cursor - x, boxes };
}

function wrapText(ctx, text, max, size) {
  ctx.font = font(size);
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(next).width > max) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function drawStem(ctx, view) {
  const spot = view.selected;
  const hour = view.hour;
  if (!spot) return null;
  const xy = projectMeters(spot.lon, spot.lat);
  const anchor = project(xy.x, xy.y, 0, view.cam);
  const nameSize = Math.max(16, Math.min(22, view.width * 0.02));
  const body = Math.max(13, nameSize * 0.68);
  const small = Math.max(11, body * 0.86);
  const seawardRoom = anchor.x - 36;
  const maxW = Math.min(340, view.width - 24, Math.max(128, seawardRoom));
  const lines = stemLines(hour, view.bundle, body, small, ctx, maxW);
  const gap = 7;
  const blockH = lines.reduce((sum, line) => sum + line.size + gap, 0);
  const textW = Math.max(40, ...lines.map((line) => {
    ctx.font = font(line.size);
    return Math.min(maxW, ctx.measureText(line.text).width);
  }));
  const blockW = textW;
  let x = anchor.x - blockW - 28;
  let seaward = x >= 10;
  if (!seaward) x = Math.min(view.width - blockW - 12, anchor.x + 22);
  let top = anchor.y < view.layout.mapBottom * 0.42 ? anchor.y + 20 : anchor.y - blockH * 0.4;
  if (top < 12) top = 12;
  if (top + blockH > view.layout.mapBottom - 6) top = Math.max(12, view.layout.mapBottom - blockH - 6);
  const tipX = seaward ? x + blockW + 6 : x - 6;
  ctx.strokeStyle = gold(1);
  ctx.lineWidth = 1.15;
  ctx.beginPath();
  ctx.moveTo(anchor.x, anchor.y);
  ctx.lineTo(tipX, top + lines[0].size * 0.72);
  ctx.stroke();
  ctx.fillStyle = "#000";
  ctx.fillRect(x - 6, top - 4, blockW + 12, blockH + 6);
  ctx.fillStyle = gold(1);
  ctx.beginPath();
  ctx.arc(anchor.x, anchor.y, 3.1, 0, Math.PI * 2);
  ctx.fill();
  let y = top + lines[0].size;
  lines.forEach((line) => {
    if (line.plain) {
      ctx.font = font(line.size);
      ctx.fillStyle = gold(line.alpha);
      ctx.textAlign = "left";
      ctx.fillText(line.text, x, y);
    } else {
      drawTokens(ctx, x, y, line.text, view.hoverStem, line.size);
    }
    y += line.size + gap;
  });
  return { x: x - 8, y: top - 6, w: blockW + 16, h: blockH + 12, anchor };
}

function pushLine(lines, ctx, text, size, maxW, extra) {
  for (const piece of wrapText(ctx, text, maxW, size)) {
    lines.push({ text: piece, size, ...extra });
  }
}

function stemLines(hour, bundle, body, small, ctx, maxW) {
  if (!hour) {
    return [{ text: "Loading swell, tide, and wind", size: body, alpha: 0.8, plain: true }];
  }
  const lines = [];
  pushLine(lines, ctx, hour.spot.name, body + 4, maxW, { alpha: 1, plain: true });
  if (Number.isFinite(hour.hsFt)) {
    const kind = hour.kind === "observed" ? "observed Hs" : "model Hs";
    const period = hour.period ? ` · ${Math.round(hour.period)} s · ${compass16(hour.direction)}` : "";
    pushLine(lines, ctx, `${hour.hsFt.toFixed(1)} ft nearshore ${kind}${period}`, body, maxW, { plain: false });
  } else {
    pushLine(lines, ctx, hour.source || "no nearshore model", body, maxW, { alpha: 0.85, plain: true });
  }
  if (hour.correction) pushLine(lines, ctx, hour.correction, small, maxW, { alpha: 0.9, plain: true });
  if (hour.correctionSkipped && hour.buoy?.hsFt != null && hour.spot) {
    const nowcast = bundle.breaks[hour.spot.id]?.nowcast;
    const mop = nowcast ? `MOP ${nowcast.hsFt.toFixed(1)} ft` : "MOP";
    pushLine(lines, ctx, `${mop} · buoy ${hour.buoy.hsFt.toFixed(1)} ft · correction skipped`, small, maxW, { alpha: 0.9, plain: false });
  }
  if (hour.wind) {
    const gust = Number.isFinite(hour.gust) ? `, gust ${Math.round(hour.gust)}` : "";
    const speed = Number.isFinite(hour.windMph) ? `${Math.round(hour.windMph)} mph` : "";
    const from = hour.wind === "calm" ? "calm" : `${hour.wind} · ${compass16(hour.windFrom)} ${speed}`;
    pushLine(lines, ctx, `${from}${hour.wind === "calm" ? "" : gust}`, body, maxW, { plain: false });
  }
  if (hour.offshoreMph != null) {
    pushLine(lines, ctx, `offshore wind ${Math.round(hour.offshoreMph)} mph`, small, maxW, { alpha: 0.85, plain: false });
  }
  if (Number.isFinite(hour.tideFt)) {
    const arrow = hour.rising ? "\u2191" : "\u2193";
    let extra = "";
    if (hour.extreme) {
      const mins = Math.round((hour.extreme.time - hour.time) / 60000);
      if (mins >= 0 && mins < 18 * 60) {
        extra = mins < 60 ? ` · ${hour.extreme.type} in ${mins} min` : ` · ${hour.extreme.type} ${formatClock(hour.extreme.time)}`;
      }
    }
    pushLine(lines, ctx, `tide ${hour.tideFt.toFixed(1)} ft ${arrow}${extra} · prediction`, body, maxW, { plain: false });
  }
  const water = bundle?.water;
  const air = Number.isFinite(hour.temp) ? `${Math.round(hour.temp)}°` : "";
  const waterBit = water ? `${Math.round(water.f)}° ${water.kind}` : "";
  const sky = hour.sky || "";
  const pop = hour.pop != null ? ` · rain ${Math.round(hour.pop)}%` : "";
  if (waterBit || air || sky) {
    pushLine(lines, ctx, [`water ${waterBit}`, air ? `air ${air}` : "", sky].filter(Boolean).join(" · ") + pop, body, maxW, { plain: false });
  }
  if (bundle?.residual?.show) {
    const dir = bundle.residual.ft >= 0 ? "above" : "below";
    pushLine(lines, ctx, `La Jolla running ${Math.abs(bundle.residual.ft).toFixed(1)} ft ${dir} the prediction`, small, maxW, { alpha: 0.9, plain: false });
  }
  const note = Math.max(10, small - 1);
  for (const text of wrapText(ctx, sentence(hour), maxW, small)) {
    lines.push({ text, size: small, alpha: 0.78, plain: true });
  }
  if (hour.rank) lines.push({ text: hour.rank, size: body, alpha: 1, plain: true });
  for (const text of wrapText(ctx, ageLine(bundle, hour), maxW, note)) {
    lines.push({ text, size: note, alpha: 0.62, plain: true });
  }
  if (hour.spot?.tideNote) {
    for (const text of wrapText(ctx, hour.spot.tideNote, maxW, note)) {
      lines.push({ text, size: note, alpha: 0.45, plain: true });
    }
  }
  return lines;
}

function drawScale(ctx, view) {
  const cam = view.cam;
  const a = project(0, 0, 0, cam);
  const b = project(1000, 0, 0, cam);
  const pxPerKm = Math.hypot(b.x - a.x, b.y - a.y);
  if (!Number.isFinite(pxPerKm) || pxPerKm < 4) return;
  const choices = [0.5, 1, 2, 5, 10];
  let km = 1;
  for (const choice of choices) {
    if (choice * pxPerKm < Math.min(180, view.width * 0.28)) km = choice;
  }
  const x = 16;
  const y = view.layout.mapBottom - 18;
  const w = km * pxPerKm;
  ctx.strokeStyle = gold(0.85);
  ctx.lineWidth = 1.05;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.moveTo(x, y - 4);
  ctx.lineTo(x, y + 4);
  ctx.moveTo(x + w, y - 4);
  ctx.lineTo(x + w, y + 4);
  ctx.stroke();
  ctx.font = font(12);
  ctx.fillStyle = gold(0.8);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(`${km} km`, x, y - 8);
}

function drawStrip(ctx, view) {
  const strip = view.layout.strip;
  const hours = view.hours;
  if (!hours?.length) return;
  const tides = hours.map((hour) => hour.tideFt).filter((v) => Number.isFinite(v));
  const tLo = tides.length ? Math.min(...tides) : 0;
  const tHi = tides.length ? Math.max(...tides) : 6;
  const span = Math.max(0.5, tHi - tLo);
  const base = strip.y + strip.h - 18;
  const top = strip.y + 16;
  const xAt = (index) => strip.x + ((index + 0.5) / hours.length) * strip.w;
  const yTide = (ft) => base - ((ft - tLo) / span) * (base - top);

  ctx.lineWidth = 1.05;
  ctx.beginPath();
  let started = false;
  hours.forEach((hour, index) => {
    if (!Number.isFinite(hour.tideFt)) return;
    const x = xAt(index);
    const y = yTide(hour.tideFt);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = gold(0.9);
  ctx.stroke();

  hours.forEach((hour, index) => {
    if (!Number.isFinite(hour.hsFt)) return;
    const x = xAt(index);
    const h = Math.max(2, Math.min(base - top, (hour.hsFt / 8) * (base - top) * 0.45));
    ctx.strokeStyle = gold(hour.night ? 0.28 : 0.55);
    ctx.lineWidth = 1.05;
    ctx.beginPath();
    ctx.moveTo(x, base);
    ctx.lineTo(x, base - h);
    ctx.stroke();
    if (Number.isFinite(hour.windFrom) && Number.isFinite(hour.windMph)) {
      const toward = ((hour.windFrom + 180) * Math.PI) / 180;
      const len = Math.max(3, Math.min(12, hour.windMph * 0.55));
      ctx.strokeStyle = gold(hour.night ? 0.25 : 0.45);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, strip.y + strip.h - 8);
      ctx.lineTo(x + Math.sin(toward) * len, strip.y + strip.h - 8 - Math.cos(toward) * len);
      ctx.stroke();
    }
  });

  const extremes = view.bundle?.tide?.extremes || [];
  const t0 = hours[0].time;
  const t1 = hours[hours.length - 1].time + 3600 * 1000;
  ctx.font = font(11);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  for (const extreme of extremes) {
    if (extreme.time < t0 || extreme.time > t1) continue;
    const index = (extreme.time - t0) / (3600 * 1000);
    const x = strip.x + ((index + 0.5) / hours.length) * strip.w;
    const y = yTide(extreme.ft);
    ctx.fillStyle = gold(0.9);
    ctx.beginPath();
    ctx.arc(x, y, 2.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = gold(0.7);
    ctx.fillText(`${extreme.type === "high" ? "H" : "L"} ${formatClock(extreme.time)}`, x, y - 6);
  }

  (view.bundle?.sunrise || []).forEach((stamp) => markSun(ctx, view, stamp, t0, t1, strip, "rise"));
  (view.bundle?.sunset || []).forEach((stamp) => markSun(ctx, view, stamp, t0, t1, strip, "set"));

  const selectedIndex = view.hourIndex ?? 0;
  const sx = xAt(selectedIndex);
  ctx.strokeStyle = gold(1);
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(sx, strip.y);
  ctx.lineTo(sx, strip.y + strip.h);
  ctx.stroke();
  ctx.font = font(12);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const label = formatHour(hours[selectedIndex].time);
  const lw = ctx.measureText(label).width;
  if (view.hoverStrip) {
    ctx.fillStyle = gold(1);
    roundRect(ctx, sx - lw / 2 - 6, strip.y - 18, lw + 12, 16, 8);
    ctx.fill();
    ctx.fillStyle = INK;
  } else ctx.fillStyle = gold(0.95);
  ctx.fillText(label, sx, strip.y - 6);

  ctx.font = font(11);
  ctx.textAlign = "right";
  ctx.fillStyle = gold(0.45);
  ctx.fillText("La Jolla", strip.x + strip.w, top + 4);

  const outlook = view.outlook || "";
  if (outlook) {
    let size = view.width < 720 ? 11 : 13;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.font = font(size);
    while (size > 9 && ctx.measureText(outlook).width > view.width - 28) {
      size -= 0.5;
      ctx.font = font(size);
    }
    ctx.fillStyle = gold(0.55);
    ctx.fillText(outlook, 14, view.layout.daysY);
  }
}

function markSun(ctx, view, stamp, t0, t1, strip, kind) {
  const time = pacificEpoch(stamp);
  if (time < t0 || time > t1) return;
  const index = (time - t0) / (3600 * 1000);
  const x = strip.x + ((index + 0.5) / view.hours.length) * strip.w;
  ctx.strokeStyle = gold(0.7);
  ctx.lineWidth = 1.05;
  ctx.beginPath();
  ctx.moveTo(x, strip.y + 2);
  ctx.lineTo(x, strip.y + (kind === "rise" ? 10 : 7));
  ctx.stroke();
}

export function draw(ctx, view) {
  const width = view.width;
  const height = view.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const key = [
    width, height, view.cam.yaw, view.cam.panX, view.cam.panY, view.cam.scale,
    view.selected?.id || "", view.dpr,
  ].join("|");
  if (!view.cache || view.cache.key !== key) {
    view.cache = { key, ...buildPaths(ctx, view) };
  }
  for (const item of view.cache.paths) {
    ctx.lineWidth = item.width;
    ctx.strokeStyle = gold(item.alpha);
    ctx.stroke(item.path);
  }
  if (view.cache.highlight.length) {
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = gold(1);
    ctx.beginPath();
    for (const [a, b] of view.cache.highlight) {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }
  drawCrests(ctx, view);
  drawPlaces(ctx, view);
  const stem = drawStem(ctx, view);
  drawScale(ctx, view);
  drawStrip(ctx, view);
  view.stemBox = stem;
}

export function hitBreak(view, x, y) {
  let best = null;
  let bestD = 18 ** 2;
  for (const spot of view.spots.breaks) {
    const xy = projectMeters(spot.lon, spot.lat);
    const p = project(xy.x, xy.y, 0, view.cam);
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bestD) {
      best = spot;
      bestD = d;
    }
  }
  return best;
}

export function zoomAt(cam, sx, sy, factor, width, height) {
  const next = Math.min(cam.baseScale * 16, Math.max(cam.baseScale * 0.85, cam.scale * factor));
  const wx = (sx - cam.cx - cam.panX) / cam.scale;
  const wy = (cam.cy + cam.panY - sy) / cam.scale;
  cam.scale = next;
  cam.panX = sx - cam.cx - wx * cam.scale;
  cam.panY = sy - cam.cy + wy * cam.scale;
  clampPan(cam, width, height);
}

export function clampPan(cam, width, height) {
  const layout = layoutOf(width, height);
  const sx = cam.cx + cam.panX;
  const sy = cam.cy + cam.panY;
  const nx = Math.min(width - 36, Math.max(36, sx));
  const ny = Math.min(layout.mapBottom - 20, Math.max(28, sy));
  cam.panX += nx - sx;
  cam.panY += ny - sy;
}

export function yawBy(cam, delta) {
  cam.yaw = Math.max(-YAW_LIMIT, Math.min(YAW_LIMIT, cam.yaw + delta));
}

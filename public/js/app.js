/** Pointer, time, and the redraw loop. */

import {
  clampPan,
  draw,
  fitCamera,
  hitBreak,
  layoutOf,
  prepareCoast,
  project,
  yawBy,
  zoomAt,
} from "./coast.js";
import { chooseTime, hours48, liveText, loadSeries, needsRefresh, outlook } from "./series.js";
import { floorHourPacific, projectMeters } from "./spots.js";

const canvas = document.getElementById("c");
const live = document.getElementById("live");
const ctx = canvas.getContext("2d");

const view = {
  width: 1,
  height: 1,
  dpr: 1,
  spots: null,
  coast: null,
  cam: null,
  bundle: null,
  selected: null,
  hours: null,
  hour: null,
  hourIndex: 0,
  outlook: "",
  hoverStem: false,
  hoverStrip: false,
  pointerDown: false,
  crestPhase: 0,
  cache: null,
  stemBox: null,
};

let stripDrag = false;
let panDrag = null;
let moved = false;

function resize() {
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.width = window.innerWidth;
  view.height = window.innerHeight;
  canvas.width = Math.round(view.width * view.dpr);
  canvas.height = Math.round(view.height * view.dpr);
  canvas.style.width = `${view.width}px`;
  canvas.style.height = `${view.height}px`;
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  view.cam = fitCamera(view.width, view.height);
  view.cache = null;
}

function selectSpot(spot, keepHour = true) {
  view.selected = spot;
  try {
    localStorage.setItem("surf:break", spot.id);
  } catch {
    /* private mode */
  }
  if (!view.bundle) return;
  const start = view.hours?.[0]?.time;
  if (!keepHour || start == null) {
    const time = chooseTime(view.bundle, spot);
    view.hours = hours48(view.bundle, spot, floorToStrip(time));
    view.hourIndex = Math.max(0, view.hours.findIndex((hour) => hour.time >= time));
  } else {
    const index = view.hourIndex;
    const time = view.hours[index]?.time;
    view.hours = hours48(view.bundle, spot, start);
    view.hourIndex = clampIndex(index);
    if (time) {
      const found = view.hours.findIndex((hour) => hour.time === time);
      if (found >= 0) view.hourIndex = found;
    }
  }
  view.hour = view.hours[view.hourIndex];
  view.outlook = outlook(view.bundle, spot);
  view.cache = null;
  publish();
}

function floorToStrip(time) {
  const now = Date.now();
  const start = new Date(now);
  start.setMinutes(0, 0, 0);
  // floorHour is applied inside hours48's caller via the series helper. The
  // strip always opens on the current Pacific hour, even when the selection is dawn.
  return view.bundle ? stripStart(now) : time;
}

function stripStart(now) {
  return floorHourPacific(now);
}

function clampIndex(index) {
  return Math.max(0, Math.min((view.hours?.length || 1) - 1, index));
}

function publish() {
  live.textContent = view.hour && view.bundle ? liveText(view.hour, view.bundle) : "Loading the North County coast.";
}

function localPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function inStrip(y) {
  const strip = layoutOf(view.width, view.height).strip;
  return y >= strip.y - 16 && y <= strip.y + strip.h + 8;
}

function scrubAt(x) {
  if (!view.hours?.length) return;
  const strip = layoutOf(view.width, view.height).strip;
  const t = (x - strip.x) / strip.w;
  view.hourIndex = clampIndex(Math.floor(t * view.hours.length));
  view.hour = view.hours[view.hourIndex];
  publish();
}

canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);
  const point = localPoint(event);
  view.pointerDown = true;
  moved = false;
  if (inStrip(point.y) && view.hours) {
    stripDrag = true;
    scrubAt(point.x);
    return;
  }
  panDrag = { x: point.x, y: point.y, panX: view.cam.panX, panY: view.cam.panY, yaw: view.cam.yaw, alt: event.altKey || event.button === 2 };
});

canvas.addEventListener("pointermove", (event) => {
  const point = localPoint(event);
  view.hoverStrip = inStrip(point.y);
  view.hoverStem = Boolean(view.stemBox) && point.x >= view.stemBox.x && point.x <= view.stemBox.x + view.stemBox.w && point.y >= view.stemBox.y && point.y <= view.stemBox.y + view.stemBox.h;
  if (stripDrag) {
    scrubAt(point.x);
    return;
  }
  if (!panDrag) return;
  const dx = point.x - panDrag.x;
  const dy = point.y - panDrag.y;
  if (dx * dx + dy * dy > 16) moved = true;
  if (panDrag.alt) {
    view.cam.yaw = panDrag.yaw;
    yawBy(view.cam, dx * 0.004);
    view.cache = null;
    return;
  }
  view.cam.panX = panDrag.panX + dx;
  view.cam.panY = panDrag.panY + dy;
  clampPan(view.cam, view.width, view.height);
  view.cache = null;
});

canvas.addEventListener("pointerup", (event) => {
  const point = localPoint(event);
  if (!stripDrag && !moved && view.spots) {
    const spot = hitBreak(view, point.x, point.y);
    if (spot) selectSpot(spot, true);
  }
  stripDrag = false;
  panDrag = null;
  view.pointerDown = false;
});

canvas.addEventListener("pointercancel", () => {
  stripDrag = false;
  panDrag = null;
  view.pointerDown = false;
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const point = localPoint(event);
  const factor = Math.exp(-event.deltaY * 0.0011);
  zoomAt(view.cam, point.x, point.y, factor, view.width, view.height);
  view.cache = null;
}, { passive: false });

canvas.addEventListener("contextmenu", (event) => event.preventDefault());

window.addEventListener("keydown", (event) => {
  if (!view.hours) return;
  if (event.key === "ArrowRight") {
    view.hourIndex = clampIndex(view.hourIndex + 1);
  } else if (event.key === "ArrowLeft") {
    view.hourIndex = clampIndex(view.hourIndex - 1);
  } else return;
  view.hour = view.hours[view.hourIndex];
  publish();
});

window.addEventListener("resize", resize);

function frame(now) {
  if (!view.pointerDown) view.crestPhase = (now / 1000) / 26;
  if (view.coast && view.cam) {
    view.layout = layoutOf(view.width, view.height);
    draw(ctx, view);
  }
  if (view.pointerDown) requestAnimationFrame(frame);
  else setTimeout(() => requestAnimationFrame(frame), 90);
}

async function boot() {
  resize();
  const [spots, coast] = await Promise.all([
    fetch("/data/spots.json").then((res) => res.json()),
    fetch("/data/coast.json").then((res) => res.json()),
  ]);
  view.spots = spots;
  view.coast = prepareCoast(coast);
  const stored = (() => {
    try { return localStorage.getItem("surf:break"); } catch { return null; }
  })();
  view.selected = spots.breaks.find((spot) => spot.id === stored) || spots.breaks.find((spot) => spot.id === "swamis");
  expose();
  publish();
  requestAnimationFrame(frame);
  view.bundle = await loadSeries(spots);
  const time = chooseTime(view.bundle, view.selected);
  const start = stripStart(Date.now());
  view.hours = hours48(view.bundle, view.selected, start);
  const index = view.hours.findIndex((hour) => hour.time >= time);
  view.hourIndex = index >= 0 ? index : 0;
  view.hour = view.hours[view.hourIndex];
  view.outlook = outlook(view.bundle, view.selected);
  if (view.bundle.errors.length) console.warn(view.bundle.errors);
  publish();
  expose();
}

async function refresh() {
  if (!view.bundle || !needsRefresh(view.bundle)) return;
  const selectedTime = view.hour?.time;
  view.bundle = await loadSeries(view.spots, view.bundle);
  if (!view.selected) return;
  const start = view.hours?.[0]?.time || stripStart(Date.now());
  view.hours = hours48(view.bundle, view.selected, start);
  if (selectedTime) {
    const found = view.hours.findIndex((hour) => hour.time === selectedTime);
    if (found >= 0) view.hourIndex = found;
  }
  view.hour = view.hours[view.hourIndex];
  view.outlook = outlook(view.bundle, view.selected);
  publish();
}

window.addEventListener("focus", () => { refresh().catch((err) => console.error(err)); });
setInterval(() => { refresh().catch((err) => console.error(err)); }, 10 * 60 * 1000);

function expose() {
  window.__surf = {
    points() {
      return view.spots.breaks.map((spot) => {
        const xy = projectMeters(spot.lon, spot.lat);
        const p = project(xy.x, xy.y, 0, view.cam);
        return { id: spot.id, name: spot.name, x: p.x, y: p.y };
      });
    },
    snapshot() {
      return {
        live: live.textContent,
        selected: view.selected?.id || null,
        hour: view.hour?.time || null,
        hs: view.hour?.hsFt ?? null,
        kind: view.hour?.kind || null,
        source: view.hour?.source || null,
        wind: view.hour?.wind || null,
        tide: view.hour?.tideFt ?? null,
        rank: view.hour?.rank || null,
        outlook: view.outlook,
        correction: view.hour?.correction || null,
        features: view.coast?.features.length || 0,
        yaw: view.cam?.yaw || 0,
        pitchDeg: 55,
        strip: view.layout ? view.layout.strip : null,
        errors: view.bundle?.errors || [],
      };
    },
  };
}

boot().catch((err) => {
  console.error(err);
  live.textContent = "The coast did not load.";
});

/** Static files plus one allowlist in front of NOAA, NDBC, and CDIP. */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const PORT = Number(process.env.PORT) || 4173;
const MAX_BYTES = 8_000_000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

const cache = new Map();

function allowed(url) {
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.pathname.includes("..")) return false;
  if (url.host === "api.tidesandcurrents.noaa.gov") {
    return url.pathname === "/api/prod/datagetter";
  }
  if (url.host === "www.ndbc.noaa.gov") {
    return /^\/data\/realtime2\/4622[45]\.txt$/.test(url.pathname);
  }
  if (url.host === "thredds.cdip.ucsd.edu") {
    return /\/thredds\/dodsC\/cdip\/model\/MOP_alongshore\/D\d{4}_(nowcast|forecast)\.nc(\.(ascii|dds|das))?$/.test(url.pathname);
  }
  return false;
}

function ttlFor(url) {
  if (url.host === "www.ndbc.noaa.gov") return 10 * 60 * 1000;
  if (url.host === "api.tidesandcurrents.noaa.gov") {
    return url.searchParams.get("product") === "water_level" ? 10 * 60 * 1000 : 12 * 60 * 60 * 1000;
  }
  return 30 * 60 * 1000;
}

async function upstream(target, redirects = 0) {
  const res = await fetch(target, {
    headers: { "User-Agent": "north-county-surf/phase1", Accept: "*/*" },
    redirect: "manual",
  });
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    if (redirects >= 2) throw new Error("redirect");
    const next = new URL(res.headers.get("location") || "", target);
    if (!allowed(next)) throw new Error("redirect off allowlist");
    return upstream(next, redirects + 1);
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_BYTES) throw new Error("upstream too large");
  return {
    status: res.status,
    type: res.headers.get("content-type") || "application/octet-stream",
    body,
  };
}

async function proxy(url, res) {
  let target;
  try {
    target = new URL(url);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("bad url");
    return;
  }
  if (!allowed(target)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("host not allowlisted");
    return;
  }
  const key = target.toString();
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    res.writeHead(200, {
      "Content-Type": hit.type,
      "Cache-Control": "no-store",
      "X-Proxy-Cache": "hit",
    });
    res.end(hit.body);
    return;
  }
  try {
    const got = await upstream(target);
    if (got.status === 200) {
      cache.set(key, { ...got, expires: Date.now() + ttlFor(target) });
    }
    res.writeHead(got.status, {
      "Content-Type": got.type,
      "Cache-Control": "no-store",
    });
    res.end(got.body);
  } catch (err) {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("upstream failed");
    console.error("proxy", target.host, err.message);
  }
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(err.code === "ENOENT" ? "not found" : "read failed");
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/proxy") {
    proxy(url.searchParams.get("url") || "", res);
    return;
  }
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }
  const rel = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(ROOT + path.sep) && full !== ROOT) {
    res.writeHead(403).end("no");
    return;
  }
  sendFile(res, full);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`north county session http://127.0.0.1:${PORT}`);
});

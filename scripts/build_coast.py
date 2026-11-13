#!/usr/bin/env python3
"""Build the committed North County contour GeoJSON.

Shoreline: NOAA CUSP, from the NGS Shoreline Data Explorer vector tiles
(https://nsde.ngs.noaa.gov/cusp/tiles/{z}/{x}/{y}.pbf), clipped to the
Oceanside Harbor–Torrey Pines box and simplified to about 15 m.

Bathymetry and bluffs: NOAA NCEI San Diego coastal DEM, 1/3 arc-second,
NAVD88 (2012), shifted onto MLLW with the La Jolla 9410230 datum offset.
Published CUDEM 1/9 and 1/3 topobathy tiles do not include this longitude
(the California ninth-arc-second set starts near 36.5N; no w117 tile is in
the CUDEM URL lists). This regional coastal DEM is the NOAA integrated
bathymetry-and-topography grid that covers the strip. Contours are
5/10/20/30/50/100 m below MLLW and 20/40/60 m on land within about 2 km
of the shoreline.

Requires numpy, shapely, mapbox-vector-tile, and netCDF4. Not an app dependency.
"""

from __future__ import annotations

import gzip
import json
import math
import os
import sys
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import mapbox_vector_tile
import numpy as np
from shapely.geometry import LineString, box

LAT0 = 33.08
LON0 = -117.32
M_PER_DEG_LAT = 111320.0
M_PER_DEG_LON = 111320.0 * math.cos(math.radians(LAT0))

# View box: jetties through Torrey Pines, both buoys, ~3 km inland.
WEST, EAST = -117.56, -117.18
SOUTH, NORTH = 32.86, 33.25

# La Jolla station datum: NAVD88 1.389 m, MLLW 1.331 m. NAVD88 zero sits
# 0.058 m above MLLW, so meters above MLLW = NAVD88 + 0.058.
NAVD88_ABOVE_MLLW_M = 1.389 - 1.331

DEPTH_M = (5, 10, 20, 30, 50, 100)
LAND_M = (20, 40, 60)
CUSP_ZOOM = 15
SHORE_TOL_M = 15.0
CONTOUR_TOL_M = 25.0
LAND_BUFFER_M = 2000.0

DEM_URL = "https://www.ngdc.noaa.gov/thredds/dodsC/regional/san_diego_13_navd88_2012.nc"
CUSP_TILE = "https://nsde.ngs.noaa.gov/cusp/tiles/{z}/{x}/{y}.pbf"
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "data", "coast.json")


def to_xy(lon, lat):
    return ((lon - LON0) * M_PER_DEG_LON, (lat - LAT0) * M_PER_DEG_LAT)


def to_ll(x, y):
    return (LON0 + x / M_PER_DEG_LON, LAT0 + y / M_PER_DEG_LAT)


def tile_range(z):
    n = 2**z

    def xy(lat, lon):
        x = int((lon + 180.0) / 360.0 * n)
        lat_rad = math.radians(lat)
        y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
        return x, y

    x0, y_north = xy(NORTH, WEST)
    x1, y_south = xy(SOUTH, EAST)
    return range(x0, x1 + 1), range(y_north, y_south + 1)


def fetch(url, timeout=40):
    req = urllib.request.Request(url, headers={"User-Agent": "north-county-surf/phase1"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def decode_tile(blob):
    if blob[:2] == b"\x1f\x8b":
        blob = gzip.decompress(blob)
    return mapbox_vector_tile.decode(blob)


def pixel_to_ll(z, tx, ty, px, py, extent):
    n = 2**z
    lon = (tx + px / extent) / n * 360.0 - 180.0
    merc = (ty + py / extent) / n
    lat = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * merc))))
    return lon, lat


def lines_from_geometry(geom):
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if gtype == "LineString":
        return [coords]
    if gtype == "MultiLineString":
        return list(coords)
    if gtype == "Polygon":
        return list(coords)
    if gtype == "MultiPolygon":
        return [ring for poly in coords for ring in poly]
    return []


def load_cusp():
    xs, ys = tile_range(CUSP_ZOOM)
    tiles = [(CUSP_ZOOM, x, y) for x in xs for y in ys]
    print(f"CUSP tiles {len(tiles)} at z{CUSP_ZOOM}", flush=True)
    raw_lines = []
    attrs = defaultdict(int)

    def one(item):
        z, x, y = item
        url = CUSP_TILE.format(z=z, x=x, y=y)
        try:
            blob = fetch(url, timeout=30)
        except Exception:
            return []
        try:
            decoded = decode_tile(blob)
        except Exception as exc:
            print("tile decode failed", x, y, exc, flush=True)
            return []
        out = []
        layer = decoded.get("tiles") or next(iter(decoded.values()), None)
        if not layer:
            return []
        extent = layer.get("extent") or 4096
        clip = box(0, 0, extent, extent)
        for feat in layer["features"]:
            props = feat.get("properties") or {}
            attr = props.get("ATTRIBUTE") or ""
            for line in lines_from_geometry(feat["geometry"]):
                if len(line) < 2:
                    continue
                clipped = LineString(line).intersection(clip)
                parts = [clipped] if clipped.geom_type == "LineString" else list(getattr(clipped, "geoms", []))
                for part in parts:
                    if part.is_empty or len(part.coords) < 2:
                        continue
                    ll = [pixel_to_ll(z, x, y, px, py, extent) for px, py in part.coords]
                    out.append((attr, ll))
        return out

    done = 0
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = [pool.submit(one, item) for item in tiles]
        for fut in as_completed(futures):
            for attr, ll in fut.result():
                attrs[attr] += 1
                raw_lines.append(ll)
            done += 1
            if done % 200 == 0:
                print(f"  tiles {done}/{len(tiles)} lines {len(raw_lines)}", flush=True)
    print("CUSP attributes", dict(attrs), flush=True)
    return simplify_lines(raw_lines, SHORE_TOL_M)


def simplify_lines(lines_ll, tol_m):
    clip = box(
        *to_xy(WEST, SOUTH),
        *to_xy(EAST, NORTH),
    )
    # box(minx, miny, maxx, maxy) — northing of SOUTH is less than NORTH.
    south_xy = to_xy(WEST, SOUTH)
    north_xy = to_xy(EAST, NORTH)
    clip = box(
        min(south_xy[0], north_xy[0]),
        min(south_xy[1], north_xy[1]),
        max(south_xy[0], north_xy[0]),
        max(south_xy[1], north_xy[1]),
    )
    kept = []
    for ll in lines_ll:
        xy = [to_xy(lon, lat) for lon, lat in ll]
        if len(xy) < 2:
            continue
        geom = LineString(xy)
        if geom.length < 8:
            continue
        part = geom.intersection(clip)
        geoms = [part] if part.geom_type == "LineString" else list(getattr(part, "geoms", []))
        for g in geoms:
            if g.is_empty or g.length < 20:
                continue
            simple = g.simplify(tol_m, preserve_topology=False)
            coords = list(simple.coords)
            if len(coords) < 2:
                continue
            kept.append([to_ll(x, y) for x, y in coords])
    return kept


def marching_squares(z, xs, ys, level):
    """Contour z on a rectilinear grid. xs[col], ys[row]. Returns xy polylines."""
    z00 = z[:-1, :-1]
    z10 = z[:-1, 1:]
    z11 = z[1:, 1:]
    z01 = z[1:, :-1]
    finite = np.isfinite(z00) & np.isfinite(z10) & np.isfinite(z11) & np.isfinite(z01)
    b00 = (z00 >= level) & finite
    b10 = (z10 >= level) & finite
    b11 = (z11 >= level) & finite
    b01 = (z01 >= level) & finite
    case = (
        b00.astype(np.uint8)
        | (b10.astype(np.uint8) << 1)
        | (b11.astype(np.uint8) << 2)
        | (b01.astype(np.uint8) << 3)
    )
    ny, nx = case.shape
    rows = np.arange(ny)[:, None]
    cols = np.arange(nx)[None, :]

    def interp(va, vb, ax, ay, bx, by):
        denom = vb - va
        t = np.divide(level - va, denom, out=np.full(va.shape, 0.5), where=np.abs(denom) > 1e-9)
        t = np.clip(t, 0.0, 1.0)
        return ax + t * (bx - ax), ay + t * (by - ay)

    x0 = xs[cols]
    x1 = xs[cols + 1]
    y0 = ys[rows]
    y1 = ys[rows + 1]
    top = interp(z00, z10, x0, y0, x1, y0)
    right = interp(z10, z11, x1, y0, x1, y1)
    bottom = interp(z01, z11, x0, y1, x1, y1)
    left = interp(z00, z01, x0, y0, x0, y1)
    edges = (top, right, bottom, left)
    # Non-crossing pairings. Saddle cases are filled in below.
    table = {
        1: ((3, 0),),
        2: ((0, 1),),
        3: ((3, 1),),
        4: ((1, 2),),
        6: ((0, 2),),
        7: ((3, 2),),
        8: ((2, 3),),
        9: ((0, 2),),
        11: ((1, 2),),
        12: ((3, 1),),
        13: ((0, 1),),
        14: ((3, 0),),
    }
    center = (z00 + z10 + z11 + z01) / 4.0
    segments = []

    def add(mask, pairs):
        if not np.any(mask):
            return
        for e0, e1 in pairs:
            x_a, y_a = edges[e0]
            x_b, y_b = edges[e1]
            xa = x_a[mask]
            ya = y_a[mask]
            xb = x_b[mask]
            yb = y_b[mask]
            segments.append(np.stack([xa, ya, xb, yb], axis=1))

    for cid, pairs in table.items():
        add(case == cid, pairs)
    saddle_hi = center >= level
    add((case == 5) & saddle_hi, ((0, 1), (3, 2)))
    add((case == 5) & ~saddle_hi, ((3, 0), (1, 2)))
    add((case == 10) & saddle_hi, ((0, 3), (1, 2)))
    add((case == 10) & ~saddle_hi, ((0, 1), (2, 3)))
    if not segments:
        return []
    seg = np.concatenate(segments, axis=0)
    return chain_segments(seg)


def chain_segments(seg):
    def key(x, y):
        return (round(float(x), 1), round(float(y), 1))

    adj = defaultdict(list)
    pts = {}
    for xa, ya, xb, yb in seg:
        ka = key(xa, ya)
        kb = key(xb, yb)
        if ka == kb:
            continue
        pts[ka] = (float(xa), float(ya))
        pts[kb] = (float(xb), float(yb))
        adj[ka].append(kb)
        adj[kb].append(ka)

    def ek(a, b):
        return (a, b) if a <= b else (b, a)

    used = set()
    lines = []
    nodes = sorted(adj, key=lambda n: (len(adj[n]) == 2, n))
    for start in nodes:
        for nb in adj[start]:
            e = ek(start, nb)
            if e in used:
                continue
            path = [start, nb]
            used.add(e)
            cur = nb
            while True:
                nxts = [n for n in adj[cur] if ek(cur, n) not in used]
                if not nxts:
                    break
                nxt = nxts[0]
                used.add(ek(cur, nxt))
                path.append(nxt)
                cur = nxt
                if cur == start:
                    break
            if len(path) >= 2:
                lines.append(np.array([pts[p] for p in path], dtype=np.float64))
    return lines


def self_test():
    xs = np.linspace(0, 4, 9)
    ys = np.linspace(0, 4, 9)
    xg, yg = np.meshgrid(xs, ys)
    vertical = marching_squares(xg, xs, ys, 2.0)
    assert vertical, "vertical contour missing"
    xsamp = np.concatenate([ln[:, 0] for ln in vertical])
    assert abs(xsamp.mean() - 2.0) < 0.05, xsamp.mean()
    circle = marching_squares(xg**2 + yg**2, xs, ys, 1.0)
    assert circle, "circle contour missing"
    rad = []
    for ln in circle:
        rad.append(np.hypot(ln[:, 0], ln[:, 1]))
    rad = np.concatenate(rad)
    assert abs(rad.mean() - 1.0) < 0.08, rad.mean()
    print("contour self-test ok", flush=True)


def load_dem():
    import netCDF4 as nc

    print("opening San Diego coastal DEM", flush=True)
    ds = nc.Dataset(DEM_URL)
    lat = ds.variables["lat"]
    lon = ds.variables["lon"]
    band = ds.variables["Band1"]
    lat_vals = lat[:]
    lon_vals = lon[:]
    # Row 0 is the north edge.
    row0 = int(np.searchsorted(-lat_vals, -NORTH))
    row1 = int(np.searchsorted(-lat_vals, -SOUTH))
    col0 = int(np.searchsorted(lon_vals, WEST))
    col1 = int(np.searchsorted(lon_vals, EAST))
    row0 = max(0, row0 - 1)
    row1 = min(len(lat_vals) - 1, row1 + 1)
    col0 = max(0, col0 - 1)
    col1 = min(len(lon_vals) - 1, col1 + 1)
    stride = 2
    print(f"DEM window rows {row0}:{row1} cols {col0}:{col1} stride {stride}", flush=True)
    pieces = []
    step = stride * 120
    for r in range(row0, row1, step):
        r1 = min(row1, r + step)
        slab = np.array(band[r:r1:stride, col0:col1:stride], dtype=np.float32)
        pieces.append(slab)
        print(f"  read rows {r}:{r1} -> {slab.shape}", flush=True)
    z = np.vstack(pieces)
    lat_s = np.array(lat[row0:row1:stride], dtype=np.float64)
    lon_s = np.array(lon[col0:col1:stride], dtype=np.float64)
    ds.close()
    z[z <= -9000] = np.nan
    z[z > 4000] = np.nan
    z = z + np.float32(NAVD88_ABOVE_MLLW_M)
    print(f"DEM {z.shape} elev {np.nanmin(z):.1f} .. {np.nanmax(z):.1f} m MLLW", flush=True)
    return z, lat_s, lon_s


def xy_grid(lat_s, lon_s):
    xs = (lon_s - LON0) * M_PER_DEG_LON
    ys = (lat_s - LAT0) * M_PER_DEG_LAT
    return xs, ys


def land_mask(shore_ll, lat_s, lon_s):
    """True where a DEM cell is within LAND_BUFFER_M of the shoreline."""
    cell = 80.0
    shore_xy = []
    for line in shore_ll:
        for lon, lat in line[::2]:
            shore_xy.append(to_xy(lon, lat))
    if not shore_xy:
        raise SystemExit("no shoreline to buffer")
    shore_xy = np.array(shore_xy)
    minx, miny = shore_xy.min(axis=0) - LAND_BUFFER_M
    maxx, maxy = shore_xy.max(axis=0) + LAND_BUFFER_M
    nx = int((maxx - minx) / cell) + 3
    ny = int((maxy - miny) / cell) + 3
    mask = np.zeros((ny, nx), dtype=bool)
    ix = np.clip(((shore_xy[:, 0] - minx) / cell).astype(int), 0, nx - 1)
    iy = np.clip(((shore_xy[:, 1] - miny) / cell).astype(int), 0, ny - 1)
    mask[iy, ix] = True
    radius = int(math.ceil(LAND_BUFFER_M / cell))
    # Square dilation. 80 m cells, 2 km, about 25 steps.
    for _ in range(radius):
        padded = np.pad(mask, 1, constant_values=False)
        mask = (
            padded[1:-1, 1:-1]
            | padded[:-2, 1:-1]
            | padded[2:, 1:-1]
            | padded[1:-1, :-2]
            | padded[1:-1, 2:]
        )
    xs, ys = xy_grid(lat_s, lon_s)

    def contains_ll(lon, lat):
        x, y = to_xy(lon, lat)
        c = int((x - minx) / cell)
        r = int((y - miny) / cell)
        if c < 0 or r < 0 or c >= nx or r >= ny:
            return False
        return bool(mask[r, c])

    return contains_ll


def contours_as_lines(z, lat_s, lon_s, level):
    xs, ys = xy_grid(lat_s, lon_s)
    raw = marching_squares(z, xs, ys, level)
    lines = []
    for xy in raw:
        if len(xy) < 2:
            continue
        geom = LineString(xy)
        if geom.length < 40:
            continue
        simple = geom.simplify(CONTOUR_TOL_M, preserve_topology=False)
        coords = [to_ll(x, y) for x, y in simple.coords]
        if len(coords) >= 2:
            lines.append(coords)
    return lines


def split_inside(line, inside):
    parts = []
    cur = []
    for lon, lat in line:
        if inside(lon, lat):
            cur.append((lon, lat))
        elif len(cur) >= 2:
            parts.append(cur)
            cur = []
        else:
            cur = []
    if len(cur) >= 2:
        parts.append(cur)
    return parts


def feature(kind, coords, **props):
    return {
        "type": "Feature",
        "properties": {"kind": kind, **props},
        "geometry": {"type": "LineString", "coordinates": [[round(lon, 6), round(lat, 6)] for lon, lat in coords]},
    }


def sanity(shore):
    west_jetty = None
    for line in shore:
        for lon, lat in line:
            if 33.18 <= lat <= 33.22 and lon < -117.40:
                if west_jetty is None or lon < west_jetty[0]:
                    west_jetty = (lon, lat)
    if west_jetty is None:
        raise SystemExit("CUSP extract has no Oceanside jetty west of -117.40")
    print(f"jetty tip {west_jetty[1]:.5f}N {west_jetty[0]:.5f}W", flush=True)

    def shore_lon(lat):
        best = None
        for line in shore:
            for lon, y in line:
                if abs(y - lat) < 0.002:
                    if best is None or lon < best:
                        best = lon
        return best

    swamis = shore_lon(33.034)
    moonlight = shore_lon(33.046)
    print(f"shore lon Swami's {swamis} Moonlight {moonlight}", flush=True)
    return {"jettyTip": [west_jetty[0], west_jetty[1]], "swamisShoreLon": swamis, "moonlightShoreLon": moonlight}


def main():
    self_test()
    shore = load_cusp()
    print(f"shore lines {len(shore)}", flush=True)
    checks = sanity(shore)
    z, lat_s, lon_s = load_dem()
    inside = land_mask(shore, lat_s, lon_s)
    features = []
    for line in shore:
        features.append(feature("shore", line, source="NOAA CUSP"))
    for depth in DEPTH_M:
        lines = contours_as_lines(z, lat_s, lon_s, -depth)
        print(f"depth {depth} m -> {len(lines)} lines", flush=True)
        for line in lines:
            features.append(feature("depth", line, depthM=depth, source="NOAA NCEI San Diego coastal DEM"))
    for elev in LAND_M:
        lines = contours_as_lines(z, lat_s, lon_s, elev)
        kept = []
        for line in lines:
            kept.extend(split_inside(line, inside))
        print(f"land {elev} m -> {len(kept)} lines inside 2 km", flush=True)
        for line in kept:
            features.append(feature("land", line, elevM=elev, source="NOAA NCEI San Diego coastal DEM"))
    collection = {
        "type": "FeatureCollection",
        "properties": {
            "shoreline": "NOAA CUSP, NGS Shoreline Data Explorer tiles, simplified to 15 m",
            "dem": "NOAA NCEI San Diego, California Coastal Digital Elevation Model, 1/3 arc-second NAVD88 (2012)",
            "cudem": "Published CUDEM 1/9 and 1/3 topobathy tiles have no coverage at 117W (California ninth-arc-second tiles begin near 36.5N). Contours are from the NOAA integrated coastal DEM that covers this strip, shifted from NAVD88 onto MLLW.",
            "vertical": "meters relative to MLLW",
            "navd88AboveMllwMeters": round(NAVD88_ABOVE_MLLW_M, 3),
            "datumSource": "NOAA CO-OPS station 9410230 datums, NAVD88 1.389 m and MLLW 1.331 m on the station datum, epoch 1983-2001",
            "depthM": list(DEPTH_M),
            "landM": list(LAND_M),
            "landBufferM": LAND_BUFFER_M,
            "checks": checks,
        },
        "features": features,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(collection, fh, separators=(",", ":"))
    size = os.path.getsize(OUT)
    print(f"wrote {OUT} features {len(features)} bytes {size}", flush=True)


if __name__ == "__main__":
    main()

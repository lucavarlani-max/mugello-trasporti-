#!/usr/bin/env python3
"""Rebuild data/*.json from the official GTFS feeds (Regione Toscana open data, CC-BY).

  python tools/build_data.py                          # download both feeds into a fresh work dir
  python tools/build_data.py --bus-gtfs D1 --train-gtfs D2   # reuse already extracted feeds

The bus feed is a rolling ~3 week window: rerun this script every couple of weeks.
"""
import argparse, csv, datetime, json, math, os, re, shutil, sys, urllib.request, zipfile
from collections import defaultdict

BUS_FEED_URL = "https://regionetoscana.smartregion.toscana.it/mobility/artifacts/gtfs"
TRAIN_FEED_URL = ("https://dati.toscana.it/dataset/8bb8f8fe-fe7d-41d0-90dc-49f2456180d1/resource/"
                  "4f85393b-357d-443d-8378-65de4198505f/download/trenitalia.gtfs")
GTFS_FILES = {"agency.txt", "calendar.txt", "calendar_dates.txt", "routes.txt", "shapes.txt",
              "stop_times.txt", "stops.txt", "trips.txt"}

BUS_AGENCY = "EXFI"
WANTED_LINES = {"301", "302", "303", "304", "305", "307", "319", "322", "325", "330", "331", "333",
                "336", "338", "343", "345", "345BIS", "900"}
LINE_COLORS = {
    "301": "#1B6FA8", "302": "#2E86AB", "303": "#1C7C54", "304": "#5B8C5A", "305": "#E07A5F",
    "307": "#B23A48", "319": "#8E44AD", "322": "#D68C45", "325": "#4E6E58", "330": "#3D5A80",
    "331": "#6D6875", "333": "#748CAB", "336": "#A26769", "338": "#588157", "343": "#7D8597",
    "345": "#457B9D", "345BIS": "#5C80BC", "900": "#9A8C98",
}
ROUTE_NAME_RE = re.compile(r"^(\d{3}(?:BIS)?)\s*([A-Z]?)$")
SCHOOL_RE = re.compile(r"scuol|istitut|liceo|\bmedie\b|elementar|\basilo\b|caiani|pellico", re.I)
SMALL_WORDS = {"di", "del", "della", "dei", "degli", "delle", "da", "a", "al", "in", "sul", "sulla", "e"}

COMUNI = {
    "Barberino di Mugello": (44.0000, 11.2167), "Scarperia": (43.9967, 11.3547),
    "San Piero a Sieve": (43.9608, 11.3228), "Borgo San Lorenzo": (43.9547, 11.3868),
    "Vicchio": (43.9217, 11.4547), "Dicomano": (43.8878, 11.5156), "Londa": (43.8667, 11.5500),
    "San Godenzo": (43.8900, 11.6100), "Rufina": (43.8236, 11.4747), "Pontassieve": (43.7673, 11.4375),
    "Pelago": (43.7978, 11.4936), "Vaglia": (43.9000, 11.2800), "Firenzuola": (44.1214, 11.3750),
    "Marradi": (44.0736, 11.6122), "Palazzuolo sul Senio": (44.1136, 11.5578), "Fiesole": (43.8057, 11.2927),
    "Firenze": (43.7696, 11.2558), "Sesto Fiorentino": (43.8333, 11.2000), "Prato": (43.8777, 11.1022),
    "Bagno a Ripoli": (43.7500, 11.3167),
}


def log(*a):
    print(*a, flush=True)


def haversine(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * 6371000 * math.asin(math.sqrt(a))


def pretty_name(text):
    """Title-case ALL CAPS names, keeping short Italian connectors lowercase."""
    text = text.strip()
    if not text.isupper():
        return text
    words = text.lower().split()
    res = []
    for i, w in enumerate(words):
        if re.fullmatch(r"(?:[a-z]\.)+", w):
            res.append(w.upper())
        else:
            res.append(w if (i and w in SMALL_WORDS) else re.sub(r"(^|[\s'(/-])([a-zàèéìòù])", lambda m: m.group(1) + m.group(2).upper(), w))
    return " ".join(res)


def pretty_long_name(text):
    parts = [p.strip() for p in re.split(r"\s*-\s*", text.strip()) if p.strip()]
    return " - ".join(pretty_name(p) if p.isupper() else p for p in parts)


# ---------- feed download / csv helpers ----------

def fetch_feed(url, dest):
    os.makedirs(dest, exist_ok=False)
    zip_path = os.path.join(dest, "feed.zip")
    log("downloading", url)
    req = urllib.request.Request(url, headers={"User-Agent": "mugello-in-movimento-build/1.0"})
    with urllib.request.urlopen(req, timeout=600) as r, open(zip_path, "wb") as f:
        shutil.copyfileobj(r, f)
    out = os.path.join(dest, "gtfs")
    os.makedirs(out)
    with zipfile.ZipFile(zip_path) as zf:
        for name in zf.namelist():
            base = os.path.basename(name)
            if base in GTFS_FILES:
                with zf.open(name) as src, open(os.path.join(out, base), "wb") as dst:
                    shutil.copyfileobj(src, dst)
    return out


def open_csv(path):
    f = open(path, encoding="utf-8-sig", newline="")
    r = csv.reader(f)
    idx = {h: i for i, h in enumerate(next(r))}
    return f, idx, r


def read_dicts(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        yield from csv.DictReader(f)


def load_service_dates(gtfs):
    dates = defaultdict(set)
    cal = os.path.join(gtfs, "calendar.txt")
    if os.path.exists(cal):
        flags = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
        for r in read_dicts(cal):
            on = [i for i, k in enumerate(flags) if r[k] == "1"]
            if not on:
                continue
            d = datetime.datetime.strptime(r["start_date"], "%Y%m%d").date()
            end = datetime.datetime.strptime(r["end_date"], "%Y%m%d").date()
            while d <= end:
                if d.weekday() in on:
                    dates[r["service_id"]].add(d.strftime("%Y%m%d"))
                d += datetime.timedelta(days=1)
    for r in read_dicts(os.path.join(gtfs, "calendar_dates.txt")):
        (dates[r["service_id"]].add if r["exception_type"] == "1" else dates[r["service_id"]].discard)(r["date"])
    return dates


def weekdays_of(dates):
    return {datetime.datetime.strptime(d, "%Y%m%d").date().weekday() for d in dates}


def day_label(wds):
    names = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"]
    table = {frozenset(range(5)): "Feriale (Lun-Ven)", frozenset(range(6)): "Feriale + Sabato (Lun-Sab)",
             frozenset({5}): "Sabato", frozenset({6}): "Domenica e festivi",
             frozenset({5, 6}): "Sabato, Domenica e festivi", frozenset(range(7)): "Tutti i giorni"}
    if not wds:
        return "N/D"
    return table.get(frozenset(wds)) or "+".join(names[d] for d in sorted(wds))


# ---------- geometry ----------

def project_on_polyline(lat, lon, poly):
    best, best_cum, cum = None, 0.0, 0.0
    for i in range(len(poly) - 1):
        (ax, ay), (bx, by) = poly[i], poly[i + 1]
        seg = haversine(ax, ay, bx, by)
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((lat - ax) * dx + (lon - ay) * dy) / L2))
        d = haversine(lat, lon, ax + t * dx, ay + t * dy)
        if best is None or d < best:
            best, best_cum = d, cum + seg * t
        cum += seg
    return best_cum


def simplify(points, max_pts):
    if len(points) <= max_pts:
        return points
    step = len(points) / max_pts
    out, i = [points[0]], step
    while i < len(points) - 1:
        out.append(points[int(i)])
        i += step
    out.append(points[-1])
    return out


# ---------- extraction ----------

def extract(gtfs, selected, prefix, max_shape_pts, keep_short_name):
    """selected: {gtfs_route_id: meta}. Returns (routes list, stops dict) with prefixed stop ids."""
    service_dates = load_service_dates(gtfs)

    trips, trip_route = {}, {}
    f, ix, rows = open_csv(os.path.join(gtfs, "trips.txt"))
    with f:
        for row in rows:
            rid = row[ix["route_id"]]
            if rid in selected:
                tid = row[ix["trip_id"]]
                trips[tid] = {
                    "route": rid, "service": row[ix["service_id"]], "headsign": row[ix["trip_headsign"]],
                    "direction": row[ix["direction_id"]] if "direction_id" in ix else "0",
                    "shape": row[ix["shape_id"]] if "shape_id" in ix else "",
                    "short_name": row[ix["trip_short_name"]] if "trip_short_name" in ix else "",
                }
    log(f"  trips: {len(trips)}")

    stop_times = defaultdict(list)
    f, ix, rows = open_csv(os.path.join(gtfs, "stop_times.txt"))
    with f:
        for row in rows:
            tid = row[ix["trip_id"]]
            if tid in trips:
                stop_times[tid].append((int(row[ix["stop_sequence"]]), row[ix["stop_id"]],
                                        row[ix["arrival_time"]], row[ix["departure_time"]]))
    used_stops = {s[1] for v in stop_times.values() for s in v}

    stops = {}
    for r in read_dicts(os.path.join(gtfs, "stops.txt")):
        if r["stop_id"] in used_stops:
            key = prefix + r["stop_id"]
            stops[key] = {"id": key, "name": r["stop_name"], "lat": float(r["stop_lat"]),
                          "lon": float(r["stop_lon"]), "modes": [], "routes": []}

    shape_ids = {t["shape"] for t in trips.values() if t["shape"]}
    shapes = defaultdict(list)
    f, ix, rows = open_csv(os.path.join(gtfs, "shapes.txt"))
    with f:
        for row in rows:
            sid = row[ix["shape_id"]]
            if sid in shape_ids:
                shapes[sid].append((int(row[ix["shape_pt_sequence"]]), float(row[ix["shape_pt_lat"]]),
                                    float(row[ix["shape_pt_lon"]])))
    for pts in shapes.values():
        pts.sort()

    routes = []
    all_dates = set()
    for rid, meta in selected.items():
        out_trips, seen, cand = [], set(), defaultdict(list)
        for tid, t in trips.items():
            if t["route"] != rid or tid not in stop_times:
                continue
            seq = sorted(stop_times[tid])
            dates = service_dates.get(t["service"], set())
            all_dates |= dates
            wds = weekdays_of(dates)
            seen.update(s[1] for s in seq)
            if t["shape"]:
                cand[t["direction"]].append((len(shapes.get(t["shape"], [])), t["shape"]))
            trip = {"trip_id": tid, "headsign": t["headsign"], "direction_id": t["direction"],
                    "day_type": day_label(wds), "n_dates": len(dates),
                    "stops": [[prefix + s[1], s[2], s[3]] for s in seq], "_wds": wds}
            if keep_short_name:
                trip["short_name"] = t["short_name"]
            out_trips.append(trip)
        if not out_trips:
            log("  WARNING: no trips for route", rid, meta["short_name"])
            continue
        dir_shapes = {}
        for d, c in cand.items():
            best = max(c)[1]
            dir_shapes[d] = [[a, b] for _, a, b in simplify(shapes[best], max_shape_pts)]
        ref = max(dir_shapes.values(), key=len) if dir_shapes else []
        ids = [prefix + s for s in seen]
        if ref:
            ids.sort(key=lambda k: project_on_polyline(stops[k]["lat"], stops[k]["lon"], ref))
        for k in ids:
            stops[k]["routes"].append(meta["id"])
        routes.append({**meta, "shapes": dir_shapes, "stop_order": ids, "trips": out_trips})
    window = [min(all_dates), max(all_dates)] if all_dates else None
    return routes, stops, window


def select_bus_routes(gtfs):
    selected = {}
    for r in read_dicts(os.path.join(gtfs, "routes.txt")):
        if r["agency_id"] != BUS_AGENCY:
            continue
        m = ROUTE_NAME_RE.match(r["route_short_name"].strip())
        if not m or m.group(1) not in WANTED_LINES:
            continue
        line, variant = m.group(1), m.group(2) or "A"
        selected[r["route_id"]] = {
            "id": f"bus-{line}-{variant}", "mode": "autobus", "agency": "Autolinee Toscane",
            "line_group": line, "variant": variant, "short_name": f"{line}{variant}",
            "long_name": pretty_long_name(r["route_long_name"]), "color": LINE_COLORS[line],
        }
    return selected


def select_train_routes(gtfs):
    selected = {}
    for r in read_dicts(os.path.join(gtfs, "routes.txt")):
        name = r["route_long_name"]
        if not re.search(r"borgo sl", name, re.I):
            continue
        if re.search(r"pontassieve", name, re.I):
            meta = {"id": "treno-pontassieve", "short_name": "Faentina (via Pontassieve)",
                    "long_name": "Firenze - Pontassieve - Rufina - Dicomano - Borgo San Lorenzo", "color": "#8E44AD"}
        else:
            meta = {"id": "treno-faenza", "short_name": "Faentina",
                    "long_name": "Firenze - Borgo San Lorenzo - Marradi - Faenza", "color": "#C0392B"}
        selected[r["route_id"]] = {**meta, "mode": "treno", "agency": "Trenitalia", "line_group": meta["short_name"]}
    return selected


# ---------- schools ----------

def nearest_comune(lat, lon):
    return min(COMUNI, key=lambda c: haversine(lat, lon, *COMUNI[c]))


def build_schools(bus_routes, stops):
    """Group school-named stops into sites and list every trip that calls at them."""
    used = {k for r in bus_routes for k in r["stop_order"]}
    school_stops = sorted((stops[k] for k in used if SCHOOL_RE.search(stops[k]["name"])), key=lambda x: x["id"])

    generic = {"scuole", "scuola", "istituto", "liceo", "viale", "piazza", "medie", "elementari", "borgo",
               "prato", "firenze", "barberino", "pontassieve"}
    tokens = [{w for w in re.findall(r"[a-zàèéìòù]{5,}", s["name"].lower())} - generic for s in school_stops]

    parent = list(range(len(school_stops)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, a in enumerate(school_stops):
        for j in range(i + 1, len(school_stops)):
            b = school_stops[j]
            d = haversine(a["lat"], a["lon"], b["lat"], b["lon"])
            if d <= 300 or (d <= 1500 and tokens[i] & tokens[j]):
                parent[find(i)] = find(j)
    groups = defaultdict(list)
    for i, s in enumerate(school_stops):
        groups[find(i)].append(s)
    clusters = list(groups.values())
    schools = []
    for c in clusters:
        ids = {s["id"] for s in c}
        names = [s["name"] for s in c]
        keyword = [n for n in names if re.search(r"scuol|istitut|liceo", n, re.I)]
        name = pretty_name(min(keyword or names, key=len))
        lat = sum(s["lat"] for s in c) / len(c)
        lon = sum(s["lon"] for s in c) / len(c)
        runs = {}
        for r in bus_routes:
            for t in r["trips"]:
                pos = next((i for i, s in enumerate(t["stops"]) if s[0] in ids), None)
                if pos is None:
                    continue
                at = t["stops"][pos]
                key = (r["id"], at[1][:5], at[2][:5], t["stops"][0][0], t["stops"][-1][0])
                run = runs.setdefault(key, {"days": set(), "headsign": t["headsign"]})
                run["days"] |= t["_wds"]
        trips = [[k[0], "".join(map(str, sorted(v["days"]))), k[1], k[2], k[3], k[4], v["headsign"]]
                 for k, v in runs.items()]
        trips.sort(key=lambda x: (x[2], x[0]))
        schools.append({"id": f"school-{len(schools) + 1}", "name": name, "town": nearest_comune(lat, lon),
                        "lat": round(lat, 6), "lon": round(lon, 6), "stop_ids": sorted(ids),
                        "routes": sorted({t[0] for t in trips}), "trips": trips})
    schools = [s for s in schools if s["trips"]]
    priority = ["Barberino di Mugello", "Scarperia", "San Piero a Sieve", "Borgo San Lorenzo", "Vicchio",
                "Dicomano", "Londa", "San Godenzo", "Vaglia", "Firenzuola", "Marradi", "Palazzuolo sul Senio",
                "Pontassieve", "Rufina", "Pelago"]
    rank = {c: i for i, c in enumerate(priority + sorted(set(COMUNI) - set(priority)))}
    schools.sort(key=lambda s: (rank[s["town"]], s["name"]))
    for i, s in enumerate(schools, 1):
        s["id"] = f"school-{i}"
    return schools


# ---------- main ----------

def dump(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def iso(d):
    return f"{d[:4]}-{d[4:6]}-{d[6:]}"


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bus-gtfs", help="already extracted Autolinee Toscane GTFS directory")
    ap.add_argument("--train-gtfs", help="already extracted Trenitalia GTFS directory")
    ap.add_argument("--work", help="NEW directory for downloaded feeds (default: tools/work-<timestamp>)")
    ap.add_argument("--out", default=os.path.join(here, "..", "data"))
    args = ap.parse_args()

    work = args.work or os.path.join(here, "work-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
    bus_dir = args.bus_gtfs or fetch_feed(BUS_FEED_URL, os.path.join(work, "bus"))
    train_dir = args.train_gtfs or fetch_feed(TRAIN_FEED_URL, os.path.join(work, "train"))

    log("train feed")
    t_routes, t_stops, t_window = extract(train_dir, select_train_routes(train_dir), "T-", 600, True)
    log("bus feed")
    b_routes, b_stops, b_window = extract(bus_dir, select_bus_routes(bus_dir), "B-", 350, False)

    out = os.path.abspath(args.out)
    tt_dir = os.path.join(out, "timetables")
    os.makedirs(tt_dir, exist_ok=True)
    for name in os.listdir(tt_dir):
        if name.endswith(".json"):
            os.remove(os.path.join(tt_dir, name))

    schools = build_schools(b_routes, b_stops)

    stops = {}
    for mode, group in (("treno", t_stops), ("autobus", b_stops)):
        for k, s in group.items():
            if s["routes"]:
                s["modes"] = [mode]
                stops[k] = s
    index = []
    for r in t_routes + b_routes:
        dump(os.path.join(tt_dir, r["id"] + ".json"),
             {"trips": [{k: v for k, v in t.items() if not k.startswith("_")} for t in r["trips"]]})
        meta = {k: v for k, v in r.items() if k not in ("trips",)}
        meta["n_trips"] = len(r["trips"])
        index.append(meta)

    dump(os.path.join(out, "routes_index.json"), index)
    dump(os.path.join(out, "stops.json"), stops)
    dump(os.path.join(out, "schools.json"), {"schools": schools})
    dump(os.path.join(out, "meta.json"), {
        "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bus": [iso(b_window[0]), iso(b_window[1])] if b_window else None,
        "train": [iso(t_window[0]), iso(t_window[1])] if t_window else None,
    })
    log(f"done: {len(index)} routes, {len(stops)} stops, {len(schools)} schools -> {out}")
    log(f"bus timetable window: {b_window}, train: {t_window}")


if __name__ == "__main__":
    sys.exit(main())

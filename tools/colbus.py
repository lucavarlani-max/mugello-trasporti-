#!/usr/bin/env python3
"""ColBus lines (Alto Mugello) read from the operator's own printable timetables.

ColBus does not publish a feed, and these lines are not in the Regione Toscana GTFS, so build_data.py
asks this module for extra bus routes in the same shape as the GTFS ones.

  - timetables:  https://www.colbus.it/stampa-orari.php?routeUid=<id>   (fetched on every build; the copy in
                 colbus_cache/ is the fallback when the site is unreachable)
  - stop places: OpenStreetMap, where ColBus stops are mapped under the same names the timetables use
                 (colbus_cache/overpass_raw.json, refreshed with --refresh-osm)
  - road shape:  OSRM between the stops, cached in colbus_cache/shapes.json so builds need no routing service

  python tools/colbus.py              # parse the lines and print a summary
  python tools/colbus.py --refresh-osm  # download the stop positions again
"""
import datetime, hashlib, html, json, math, os, re, sys, urllib.parse, urllib.request
from collections import OrderedDict, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "colbus_cache")
PAGE_URL = "https://www.colbus.it/stampa-orari.php?routeUid={}"
USER_AGENT = "mugellotrasporti-build/1.0 (+https://www.mugellotrasporti.it)"
OSM_BBOX = (43.82, 11.10, 44.26, 11.92)   # south, west, north, east: Vaglia to Casola Valsenio, Barberino to Modigliana

# routeUid -> how the line is shown. Add a line here to publish it.
LINES = {
    13619: {"short_name": "Marradi-Casaglia", "color": "#71428A"},
    13634: {"short_name": "Marradi-Palazzuolo", "color": "#0F8B8D"},
    13639: {"short_name": "Marradi-Fognano", "color": "#C2562D"},
    13630: {"short_name": "Barberino-Futa", "color": "#2F6690"},
    13626: {"short_name": "Bivigliano-Pratolino", "color": "#B8860B"},
    13648: {"short_name": "Vaglia-Pratolino", "color": "#6A994E"},
    13638: {"short_name": "Lutirano-Modigliana", "color": "#9D4EDD"},
    13632: {"short_name": "Palazzuolo-Casola", "color": "#D1495B"},
}
# not published: 13651 Borgo San Lorenzo-Ronta and 13633 Palazzuolo-Frazioni have no times on the ColBus site
DUPLICATE_RADIUS = 250      # m: a ColBus stop and a feed stop this close are the same place
DUPLICATE_MINUTES = 2       # ... and the same trip when the passing times differ by no more than this

# names written differently in the timetable and on OpenStreetMap
ALIASES = {
    "marradi uff.turistico": "marradi ufficio turistico",
    "palazzolo sul senio": "palazzuolo sul senio",
    "marradi stazione": "marradi stazione fs",
}
# stops missing from OpenStreetMap: the nearest mapped ColBus stop, used until someone maps them
APPROXIMATE = {
    "quadalto 1": "quadalto 3",
    "marradi teatro a": "marradi teatro p",
}
# stops not on OpenStreetMap: placed at the Trenitalia station of the same place (Regione Toscana GTFS)
MANUAL = {
    "fognano fs": (44.203291, 11.727695),   # Fognano station
    "san martino": (44.113221, 11.667151),  # San Martino in Gattara (station), next to Rugginara
}
# how a stop is written on the site (both sides of the road are one stop there)
DISPLAY = {
    "marradi uff.turistico": "Marradi Ufficio Turistico",
    "palazzolo sul senio": "Palazzuolo sul Senio",
    "marradi teatro p": "Marradi Teatro",
    "marradi teatro a": "Marradi Teatro",
    "marradi stazione": "Marradi Stazione FS",
    "ss 306 ginestreto": "SS 306 Ginestreto",
    "fognano fs": "Fognano FS",
    "sp306 km 36+iii": "SP 306 km 36",
    "sp306 di fronte nc.19": "SP 306 (civico 19)",
    "pratolino ataf (p.za gerini)": "Pratolino ATAF (P.za Gerini)",
    "marradi stazione fs": "Marradi Stazione FS",
}
DAY_LABELS = {"LUNEDÌ-VENERDÌ": "Feriale (Lun-Ven)", "SABATO": "Sabato", "FESTIVO": "Domenica e festivi",
              "DOMENICA": "Domenica e festivi", "TUTTI I GIORNI": "Tutti i giorni",
              "LUNEDÌ-SABATO": "Feriale + Sabato (Lun-Sab)"}
WEEKDAYS = {"Feriale (Lun-Ven)": {0, 1, 2, 3, 4}, "Sabato": {5}, "Domenica e festivi": {6},
            "Tutti i giorni": set(range(7)), "Feriale + Sabato (Lun-Sab)": {0, 1, 2, 3, 4, 5}}
NOTE_DAYS = (("luned", 0, "Lun"), ("marted", 1, "Mar"), ("mercoled", 2, "Mer"), ("gioved", 3, "Gio"),
             ("venerd", 4, "Ven"))   # stems: the site writes "mercoledì'" and "venerdi'"
LOOKAHEAD_DAYS = 42  # seasonal trips ("Dal 11/06 al 14/09") are listed only when they run in this window


def log(*a):
    print(*a, flush=True)


def norm(name):
    return re.sub(r"\s+", " ", name.replace("*", " ")).strip().lower()


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name).strip("-")


def base_name(name):
    """'Casaglia_V *' -> 'casaglia' (the _V suffix marks the pole on the other side of the road)."""
    key = norm(name)
    return key[:-2].strip() if key.endswith("_v") else key


def pretty_stop(name):
    base = base_name(name)
    if base in DISPLAY:
        return DISPLAY[base]
    return pretty_title(base)


def pretty_title(text):
    small = {"di", "del", "della", "sul", "sulla", "e", "a"}
    words = [w if (i and w in small) else re.sub(r"(^|['/])([a-zàèéìòù])", lambda m: m.group(1) + m.group(2).upper(), w)
             for i, w in enumerate(text.lower().split())]
    return re.sub(r"\bFs\b", "FS", " ".join(words))


# ---------- download ----------

def http_get(url, data=None, timeout=60):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def timetable_page(uid):
    path = os.path.join(CACHE, f"{uid}.html")
    try:
        body = http_get(PAGE_URL.format(uid), timeout=30)
        if b"orari" not in body.lower() or b"<table" not in body:
            raise ValueError("unexpected page")
        with open(path, "wb") as f:
            f.write(body)
    except Exception as e:  # network down, site changed: use the last good copy
        log(f"  ColBus {uid}: download failed ({e}); using the saved copy")
        if not os.path.exists(path):
            return None
    with open(path, "rb") as f:
        return f.read().decode("utf-8", errors="replace")


def refresh_osm():
    s, w, n, e = OSM_BBOX
    query = (f'[out:json][timeout:90];(node["highway"="bus_stop"]["operator"~"ColBus",i]({s},{w},{n},{e});'
             f'node["public_transport"="platform"]["operator"~"ColBus",i]({s},{w},{n},{e}););out body;')
    body = http_get("https://overpass-api.de/api/interpreter", urllib.parse.urlencode({"data": query}).encode(), 120)
    json.loads(body)
    with open(os.path.join(CACHE, "overpass_raw.json"), "wb") as f:
        f.write(body)
    log("saved", len(body), "bytes")


def osm_stops():
    with open(os.path.join(CACHE, "overpass_raw.json"), encoding="utf-8") as f:
        data = json.load(f)
    out = {}
    for el in data["elements"]:
        tags = el.get("tags", {})
        if tags.get("operator", "").lower() == "colbus" and tags.get("name"):
            out.setdefault(norm(tags["name"]), (el["lat"], el["lon"]))
    # stops OpenStreetMap does not have yet: places_extra.json (feed stop of the same place, or the locality)
    with open(os.path.join(CACHE, "places_extra.json"), encoding="utf-8") as f:
        for name, (lat, lon, _) in json.load(f)["places"].items():
            out.setdefault(name, (lat, lon))
    return out


def locate(name, places):
    """Middle of the poles OpenStreetMap has for this stop (one or both sides of the road)."""
    base = base_name(name)
    for cand in (ALIASES.get(base, base), APPROXIMATE.get(base)):
        pts = [places[k] for k in (cand, f"{cand}_v") if cand and k in places]
        if pts:
            return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
    return MANUAL.get(base)


# ---------- parsing ----------

def cell_text(c):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", c))).strip()


MONTHS = {"gen": 1, "feb": 2, "mar": 3, "apr": 4, "mag": 5, "giu": 6, "lug": 7, "ago": 8, "set": 9, "ott": 10,
          "nov": 11, "dic": 12}


def note_range(text, today):
    """'Dal 11/06 al 14/09' or 'dal 15 set. al 10 giu.' -> True/False: does that period overlap the coming weeks?
    None when the note has no period."""
    m = re.search(r"dal\s+(\d{1,2})/(\d{1,2})\s+al\s+(\d{1,2})/(\d{1,2})", text, re.I)
    if m:
        d1, m1, d2, m2 = map(int, m.groups())
    else:
        m = re.search(r"dal\s+(\d{1,2})\s+([a-z]{3})\w*\.?\s+al\s+(\d{1,2})\s+([a-z]{3})", text, re.I)
        if not m or m.group(2).lower() not in MONTHS or m.group(4).lower() not in MONTHS:
            return None
        d1, m1, d2, m2 = int(m.group(1)), MONTHS[m.group(2).lower()], int(m.group(3)), MONTHS[m.group(4).lower()]
    end = today + datetime.timedelta(days=LOOKAHEAD_DAYS)
    for year in (today.year - 1, today.year, today.year + 1):
        try:
            a = datetime.date(year, m1, d1)
            b = datetime.date(year + (1 if (m2, d2) < (m1, d1) else 0), m2, d2)
        except ValueError:
            continue
        if a <= end and b >= today:
            return True
    return False


def runs_in_window(text, today):
    """False when a note says the trip is out of service (or only runs in another season) in the coming weeks."""
    inside = note_range(text, today)
    if inside is None:
        return True
    return not inside if re.search(r"sospes", text, re.I) else inside


def spans(tr):
    """[(text, colspan)] of the cells of a table row."""
    out = []
    for attrs, body in re.findall(r"<td([^>]*)>(.*?)</td>", tr, re.S):
        span = re.search(r'colspan="(\d+)"', attrs)
        out.append((cell_text(body), int(span.group(1)) if span else 1))
    return out


def day_of(text):
    up = text.upper()
    return next((k for k in sorted(DAY_LABELS, key=len, reverse=True) if k in up), None)


def parse_page(page, today):
    """Return (long_name, blocks); a block is one table (one direction) with its trip columns."""
    title = re.search(r'<h1[^>]*class="routelongname"[^>]*>(.*?)</h1>', page, re.S)
    long_name = pretty_title(cell_text(title.group(1))) if title else ""
    blocks = []
    for m in re.finditer(r"<table.*?</table>(\s*<div class=\"tripnotes-table\".*?</div>)?", page, re.S):
        table, notes_html = m.group(0), m.group(1) or ""
        head = re.search(r"<h2[^>]*>(.*?)</h2>", table, re.S)
        if not head:
            continue
        heading = cell_text(head.group(1))
        direction = heading
        for k in sorted(DAY_LABELS, key=len, reverse=True):
            direction = re.sub(k, "", direction, flags=re.I)
        direction = re.sub(r"\s+(ESTATE|ESTIVO|INVERNO|INVERNALE)\b", "", direction, flags=re.I).strip()
        notes = {n: t.strip() for n, t in re.findall(r"(\d+):\s*([^:]*?)(?=\s+\d+:|$)", cell_text(notes_html))}
        trs = re.findall(r"<tr.*?</tr>", table, re.S)
        if len(trs) < 3:
            continue
        # the day of every column: the second row (cells can span several columns), else the heading
        days = []
        for text, span in spans(trs[1])[1:]:
            days += [day_of(text)] * span
        heading_day = day_of(heading)
        rows = [[text for text, _ in spans(tr)] for tr in trs[2:]]
        rows = [r for r in rows if r]
        note_row = rows[-1] if rows and not rows[-1][0] else None   # last row: the note numbers of every column
        stops = [r for r in rows if r[0]]
        ncols = max((len(r) - 1 for r in stops), default=0)
        trips = []
        for col in range(1, ncols + 1):
            day_key = (days[col - 1] if col - 1 < len(days) else None) or heading_day
            times = [(r[0], r[col]) for r in stops if col < len(r) and re.fullmatch(r"\d{1,2}:\d{2}", r[col])]
            if len(times) < 2 or not day_key:
                continue
            nums = re.findall(r"\d+", note_row[col]) if note_row and col < len(note_row) else []
            texts = [notes[n] for n in nums if n in notes]
            if not all(runs_in_window(x, today) for x in texts):
                continue   # seasonal or suspended in the coming weeks
            trips.append({"times": times, "note": " · ".join(texts), "day": DAY_LABELS[day_key]})
        blocks.append({"heading": heading, "direction": direction, "trips": trips})
    return long_name, blocks


# ---------- shapes ----------

def road_shape(points):
    """Follow the road through the stops (OSRM); straight segments if the service is unreachable."""
    key = hashlib.sha1(json.dumps(points).encode()).hexdigest()
    path = os.path.join(CACHE, "shapes.json")
    cache = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    if key in cache:
        return cache[key]
    coords = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in points)
    try:
        body = http_get(f"https://router.project-osrm.org/route/v1/driving/{coords}?overview=full&geometries=geojson", timeout=60)
        line = json.loads(body)["routes"][0]["geometry"]["coordinates"]
        shape = [[round(lat, 5), round(lon, 5)] for lon, lat in line]
    except Exception as e:
        log(f"  road shape unavailable ({e}); straight segments")
        return [[lat, lon] for lat, lon in points]
    cache[key] = shape
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cache, f, separators=(",", ":"))
    return shape


# ---------- duplicates of the Regione feed ----------

def to_minutes(stamp):
    h, m = stamp.split(":")[:2]
    return int(h) * 60 + int(m)


def feed_index(feed_routes, feed_stops):
    """{minute: [(trip_index, stop_id, lat, lon)]} for every stop passage of the feed's trips."""
    index, trips = defaultdict(list), []
    for route in feed_routes:
        for trip in route["trips"]:
            n = len(trips)
            trips.append(trip["_wds"])
            for sid, _, dep in trip["stops"]:
                s = feed_stops.get(sid)
                if s:
                    index[to_minutes(dep)].append((n, sid, s["lat"], s["lon"]))
    index["trips"] = trips
    return index


def is_duplicate(index, trip, stops):
    """True when one feed trip passes the same places (two or more) at the same times, on some common day."""
    votes = defaultdict(set)
    for k, (sid, _, dep) in enumerate(trip["stops"]):
        s, minute = stops[sid], to_minutes(dep)
        for d in range(-DUPLICATE_MINUTES, DUPLICATE_MINUTES + 1):
            for n, feed_stop, lat, lon in index.get(minute + d, ()):
                if haversine(s["lat"], s["lon"], lat, lon) <= DUPLICATE_RADIUS:
                    votes[n].add((k, feed_stop))
    need = min(2, len(trip["stops"]))
    # two different ColBus stops must match two different feed stops, or one stop could count twice
    return any(len({k for k, _ in v}) >= need and len({f for _, f in v}) >= need and index["trips"][n] & trip["_wds"]
               for n, v in votes.items())


def haversine(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(a))


# ---------- build ----------

def build_routes(project_on_polyline, today=None, feed_routes=(), feed_stops=None):
    """Return (routes, stops) like build_data.extract() does for GTFS lines (stop ids start with B-CB-).

    feed_routes/feed_stops are the Regione Toscana bus routes already loaded: a ColBus trip that the feed
    already has (same places, same times, same days) is left out, so the feed's timetable stays the only one."""
    today = today or datetime.date.today()
    places = osm_stops()
    index = feed_index(feed_routes, feed_stops or {})
    routes, stops = [], {}
    for uid, info in LINES.items():
        page = timetable_page(uid)
        if not page:
            log(f"  ColBus {uid}: no timetable, line skipped")
            continue
        long_name, blocks = parse_page(page, today)
        directions = OrderedDict()
        out_trips, seen_at, duplicates = [], {}, 0
        for bi, b in enumerate(blocks):
            ends = [p.strip().lower() for p in b["direction"].split("->")]
            did = str(directions.setdefault((ends[0], ends[-1]), len(directions)))   # same ends = same direction
            for ci, t in enumerate(b["trips"]):
                located = [(n, tm, locate(n, places)) for n, tm in t["times"]]
                for n, _, pos in located:
                    if not pos:
                        log(f"  ColBus {uid}: stop '{n}' not on the map, left out")
                located = [x for x in located if x[2]]
                if len(located) < 2:
                    continue
                solo = re.search(r"\bsolo\b(.*)", t["note"], re.I)
                only = [(d, ab) for stem, d, ab in NOTE_DAYS if solo and stem in solo.group(1).lower()]
                if solo and re.search(r"\bsabato\b", solo.group(1), re.I):
                    only.append((5, "Sab"))
                only.sort()
                wds = {d for d, _ in only} or WEEKDAYS[t["day"]]
                day = "+".join(ab for _, ab in only) or t["day"]       # "Solo mercoledì e venerdì" -> "Mer+Ven"
                text = re.sub(r"\s*-?\s*solo\b.*$", "", t["note"].split(" - ")[0], flags=re.I).strip()
                label = day + (f" · {text[:1].lower() + text[1:]}" if text else "")
                trip_stops = []
                for n, tm, pos in located:
                    sid = "B-CB-" + slug(norm(pretty_stop(n)))
                    stops.setdefault(sid, {"id": sid, "name": pretty_stop(n), "lat": round(pos[0], 6),
                                           "lon": round(pos[1], 6), "modes": [], "routes": []})
                    hh, mm = tm.split(":")
                    stamp = f"{int(hh):02d}:{mm}:00"
                    if trip_stops and trip_stops[-1][0] == sid:   # both poles of one stop: arrive on the first, leave on the last
                        trip_stops[-1][2] = stamp
                    else:
                        trip_stops.append([sid, stamp, stamp])
                if len(trip_stops) < 2:
                    continue
                trip = {"trip_id": f"cb{uid}-{bi}-{ci}", "headsign": pretty_stop(b["direction"].split("->")[-1].strip()),
                        "direction_id": did, "day_type": label, "n_dates": 0, "stops": trip_stops,
                        "_wds": wds}
                if is_duplicate(index, trip, stops):
                    duplicates += 1
                    continue
                out_trips.append(trip)
                if len(trip_stops) > len(seen_at.get(did, [])):
                    seen_at[did] = [s[0] for s in trip_stops]
        if duplicates:
            log(f"  ColBus {uid}: {duplicates} trips already in the Regione feed, left out")
        if not out_trips:
            log(f"  ColBus {uid}: nothing to add, line skipped")
            continue
        shapes = {}
        for did, ids in seen_at.items():
            pts, last = [], None
            for sid in ids:
                p = (stops[sid]["lat"], stops[sid]["lon"])
                if p != last:
                    pts.append(p)
                last = p
            shapes[did] = road_shape(pts)
        ref = shapes.get("0") or max(shapes.values(), key=len)
        order = sorted({s[0] for t in out_trips for s in t["stops"]},
                       key=lambda k: project_on_polyline(stops[k]["lat"], stops[k]["lon"], ref))
        rid = f"bus-colbus-{uid}"
        for k in order:
            stops[k]["routes"].append(rid)
        routes.append({"id": rid, "mode": "autobus", "agency": "ColBus", "line_group": info["short_name"],
                       "short_name": info["short_name"], "long_name": long_name, "color": info["color"],
                       "chip": "CB", "title": info["short_name"].replace("-", " – "), "shapes": shapes,
                       "stop_order": order, "trips": out_trips})
        log(f"  ColBus {uid}: {len(out_trips)} trips, {len(order)} stops")
    return routes, stops


if __name__ == "__main__":
    if "--refresh-osm" in sys.argv:
        refresh_osm()
        sys.exit(0)
    sys.path.insert(0, HERE)
    from build_data import project_on_polyline
    rs, ss = build_routes(project_on_polyline)
    for r in rs:
        print(r["id"], r["long_name"], len(r["trips"]), "trips;", " > ".join(ss[k]["name"] for k in r["stop_order"]))
        print("  day types:", sorted({t["day_type"] for t in r["trips"]}), "directions:", sorted(r["shapes"]))

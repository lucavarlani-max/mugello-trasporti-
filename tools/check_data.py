#!/usr/bin/env python3
"""Fail (exit 1) if the generated data/ looks wrong, so a bad build never replaces the live site."""
import datetime, json, os, sys

data = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
problems = []


def load(name):
    try:
        with open(os.path.join(data, name), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        problems.append(f"{name}: {e}")


routes, stops, schools, meta = (load(n) for n in ("routes_index.json", "stops.json", "schools.json", "meta.json"))

if routes is not None:
    if len(routes) < 30:
        problems.append(f"only {len(routes)} routes (expected about 33)")
    missing = [r["id"] for r in routes if not os.path.exists(os.path.join(data, "timetables", r["id"] + ".json"))]
    if missing:
        problems.append(f"missing timetables: {missing[:5]}")
if stops is not None and len(stops) < 1000:
    problems.append(f"only {len(stops)} stops (expected about 1700)")
if schools is not None and not schools.get("schools"):
    problems.append("no schools found")
if meta is not None:
    today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    for mode in ("bus", "train"):
        window = meta.get(mode)
        if not window or window[1] < today:
            problems.append(f"{mode} timetable window ends {window and window[1]}, before today ({today})")

if problems:
    print("Data check FAILED:\n  " + "\n  ".join(problems))
    sys.exit(1)
print(f"Data check OK: {len(routes)} routes, {len(stops)} stops, {len(schools['schools'])} schools, bus until {meta['bus'][1]}")

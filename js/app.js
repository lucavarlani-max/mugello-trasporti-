(() => {
  "use strict";

  // Opening view: from Barberino and Firenzuola in the north-west to Dicomano and Marradi in the east,
  // fitted to the screen so the Mugello is centred on phones and desktops alike.
  const MUGELLO_BOUNDS = L.latLngBounds([43.84, 11.2], [44.14, 11.64]);

  const map = L.map("map", { zoomControl: true }).fitBounds(MUGELLO_BOUNDS);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  const state = {
    routes: [],
    routesById: {},
    stops: {},
    routeLayers: {},   // routeId -> [polyline,...]
    stopMarkers: {},   // stopId -> marker
    clusterGroup: null,
    activeRouteId: null,
    activeRouteIds: [],
    timetableCache: {},
    mode: "planner",
    nearbyCrossMode: {}, // stopId -> [{id, dist}] of the nearest stops of the OTHER mode (for walking transfers)
    stopClusters: {},    // stopId -> Set of stop ids representing "the same place" (e.g. the two directional poles of one stop)
  };

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    const dphi = (lat2 - lat1) * Math.PI / 180;
    const dl = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dphi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  const WALK_RADIUS_M = 500;

  function buildProximityIndex() {
    const trainStops = Object.values(state.stops).filter(s => s.modes.includes("treno"));
    const busStops = Object.values(state.stops).filter(s => s.modes.includes("autobus"));
    const idx = {};
    trainStops.forEach(t => {
      busStops.forEach(b => {
        const d = haversineMeters(t.lat, t.lon, b.lat, b.lon);
        if (d <= WALK_RADIUS_M) {
          (idx[t.id] = idx[t.id] || []).push({ id: b.id, dist: d });
          (idx[b.id] = idx[b.id] || []).push({ id: t.id, dist: d });
        }
      });
    });
    return idx;
  }

  // Many stops in this data have separate poles per direction just a short walk apart
  // (e.g. "Razzuolo" / "Razzuolo 1"). Cluster same-mode stops within CLUSTER_RADIUS_M so a
  // journey search from/to "a place" considers whichever pole a given trip actually serves.
  const CLUSTER_RADIUS_M = 250;

  function buildClusterIndex() {
    const stopsList = Object.values(state.stops);
    const cellSize = 0.004; // ~350-400m, coarser than the radius so neighbors land in adjacent cells
    const cellKey = (lat, lon) => Math.round(lat / cellSize) + "_" + Math.round(lon / cellSize);
    const buckets = {};
    stopsList.forEach(s => {
      const k = cellKey(s.lat, s.lon);
      (buckets[k] = buckets[k] || []).push(s);
    });
    const clusters = {};
    stopsList.forEach(s => {
      const cluster = new Set([s.id]);
      const cx = Math.round(s.lat / cellSize), cy = Math.round(s.lon / cellSize);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = buckets[(cx + dx) + "_" + (cy + dy)];
          if (!bucket) continue;
          bucket.forEach(o => {
            if (o.id === s.id) return;
            if (!o.modes.some(m => s.modes.includes(m))) return; // same mode only
            if (haversineMeters(s.lat, s.lon, o.lat, o.lon) <= CLUSTER_RADIUS_M) cluster.add(o.id);
          });
        }
      }
      clusters[s.id] = cluster;
    });
    return clusters;
  }

  state.lineFilter = "all"; // all | treno | autobus (inside the "Linee" pane)

  const linesListEl = document.getElementById("lines-list");
  const plannerEl = document.getElementById("planner");
  const schoolsPaneEl = document.getElementById("tab-schools");
  const delaysPaneEl = document.getElementById("tab-delays");
  const panelEl = document.getElementById("panel");
  const panelContentEl = document.getElementById("panel-content");
  const searchInput = document.getElementById("search-input");
  const searchResultsEl = document.getElementById("search-results");
  const sidebarEl = document.getElementById("sidebar");

  function modeLabel(mode) {
    return mode === "treno" ? "Treno" : "Autobus";
  }

  function stopDisplayName(stopId) {
    const s = state.stops[stopId];
    return s ? s.name : stopId;
  }

  function fmtTime(t) {
    if (!t) return "--:--";
    const parts = t.split(":");
    let h = parseInt(parts[0], 10);
    const m = parts[1];
    if (h >= 24) h -= 24; // GTFS allows >24h for after-midnight trips
    return String(h).padStart(2, "0") + ":" + m;
  }

  function timeToMinutes(t) {
    if (!t) return 999999;
    const parts = t.split(":");
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }

  const MODE_ICONS = {
    autobus: {
      label: "Autobus",
      path: "M4 1.5h8A1.5 1.5 0 0 1 13.5 3v8.5H12V13a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1.5H6V13a.5.5 0 0 1-.5.5h-1A.5.5 0 0 1 4 13v-1.5H2.5V3A1.5 1.5 0 0 1 4 1.5ZM4 3.25v3h8v-3H4ZM5 8.25a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm6 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z",
    },
    treno: {
      label: "Treno",
      path: "M4.5 1.5h7a2 2 0 0 1 2 2v6.25a2.25 2.25 0 0 1-1.6 2.15L13 14h-1.3l-.8-1.5H5.1L4.3 14H3l1.1-2.1a2.25 2.25 0 0 1-1.6-2.15V3.5a2 2 0 0 1 2-2ZM4 3.5v3h8v-3H4ZM5.25 8a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm5.5 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z",
    },
  };

  function modeIcon(mode) {
    const m = MODE_ICONS[mode];
    if (!m) return "";
    return `<span class="mode-icon mode-${mode}" title="${m.label}" role="img" aria-label="${m.label}">` +
      `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="${m.path}"/></svg></span>`;
  }

  // ---------- Data loading ----------

  const readyCallbacks = [];
  let isReady = false;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmtDate(iso) {
    return iso ? iso.slice(8) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : "";
  }

  function renderValidity() {
    const el = document.getElementById("validity");
    const meta = state.meta;
    if (!el || !meta || !meta.bus) return;
    const today = new Date().toISOString().slice(0, 10);
    const expired = today > meta.bus[1];
    el.className = "validity" + (expired ? " expired" : "");
    const toggle = document.getElementById("footer-toggle");
    if (toggle) toggle.classList.toggle("warn", expired);
    el.textContent = expired
      ? `Attenzione: gli orari bus sono scaduti il ${fmtDate(meta.bus[1])}. Aggiornare i dati (tools/build_data.py).`
      : `Orari bus validi dal ${fmtDate(meta.bus[0])} al ${fmtDate(meta.bus[1])}; treni fino al ${fmtDate(meta.train && meta.train[1])}.`;
  }

  Promise.all([
    fetch("data/routes_index.json").then(r => r.json()),
    fetch("data/stops.json").then(r => r.json()),
    fetch("data/meta.json").then(r => r.json()).catch(() => null),
  ]).then(([routes, stops, meta]) => {
    state.routes = routes;
    state.stops = stops;
    state.meta = meta;
    routes.forEach(r => state.routesById[r.id] = r);
    state.nearbyCrossMode = buildProximityIndex();
    state.stopClusters = buildClusterIndex();
    drawAllRoutes();
    drawAllStops();
    buildSidebar();
    renderPlanner();
    renderValidity();
    isReady = true;
    readyCallbacks.splice(0).forEach(fn => fn());
  }).catch(err => {
    linesListEl.innerHTML = `<div class="empty-note">Errore nel caricamento dei dati: ${err}</div>`;
    console.error(err);
  });

  // ---------- Map drawing ----------

  function drawAllRoutes() {
    state.routes.forEach(route => {
      const layers = [];
      Object.values(route.shapes || {}).forEach(shapePts => {
        if (!shapePts || shapePts.length < 2) return;
        const poly = L.polyline(shapePts, {
          color: route.color,
          weight: 3,
          opacity: 0.55,
        });
        poly.on("click", () => selectRoute(route.id, { fly: false }));
        poly.addTo(map);
        layers.push(poly);
      });
      state.routeLayers[route.id] = layers;
    });
  }

  function drawAllStops() {
    state.clusterGroup = L.markerClusterGroup({
      maxClusterRadius: 40,
      disableClusteringAtZoom: 14,
    });
    Object.values(state.stops).forEach(stop => {
      const isTrain = stop.modes.includes("treno");
      const icon = L.divIcon({
        className: "",
        html: `<div style="width:${isTrain ? 12 : 8}px;height:${isTrain ? 12 : 8}px;border-radius:50%;background:${isTrain ? "#b23a48" : "#1b6fa8"};border:2px solid #fff;box-shadow:0 0 2px rgba(0,0,0,0.5);"></div>`,
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      });
      const marker = L.marker([stop.lat, stop.lon], { icon });
      marker.on("click", () => openStopPopup(stop, marker));
      state.stopMarkers[stop.id] = marker;
      state.clusterGroup.addLayer(marker);
    });
    map.addLayer(state.clusterGroup);
  }

  function openStopPopup(stop, marker) {
    const linesHtml = stop.routes.map(rid => {
      const r = state.routesById[rid];
      if (!r) return "";
      return `<button class="stop-popup-line-btn" data-route-id="${rid}">
                <strong style="color:${r.color}">${r.short_name}</strong> — ${r.long_name}
              </button>`;
    }).join("");
    const html = `<div style="max-width:240px;">
        <div style="font-weight:700;margin-bottom:6px;">${stop.name}</div>
        <div style="font-size:0.75rem;color:#6b6f76;margin-bottom:6px;">Linee che servono questa fermata:</div>
        ${linesHtml || '<div class="empty-note">Nessuna linea trovata</div>'}
      </div>`;
    marker.bindPopup(html).openPopup();
    setTimeout(() => {
      document.querySelectorAll(".stop-popup-line-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          selectRoute(btn.dataset.routeId, { fly: true, focusStop: stop.id });
        });
      });
    }, 0);
  }

  // ---------- Sidebar ----------

  const features = {}; // pane name -> { onShow, onHide }

  function showPane(name) {
    const previous = state.mode;
    if (previous !== name && features[previous] && features[previous].onHide) features[previous].onHide();
    state.mode = name;
    if (name !== "planner" && state.networkHidden) clearFocus();
    plannerEl.classList.toggle("hidden", name !== "planner");
    linesListEl.classList.toggle("hidden", name !== "lines");
    schoolsPaneEl.classList.toggle("hidden", name !== "schools");
    delaysPaneEl.classList.toggle("hidden", name !== "delays");
    if (features[name] && features[name].onShow) features[name].onShow();
  }

  function buildSidebar() {
    linesListEl.innerHTML = "";

    const filterBar = document.createElement("div");
    filterBar.className = "daytype-chips lines-filter";
    [["all", "Tutte"], ["treno", "Treno"], ["autobus", "Autobus"]].forEach(([key, label]) => {
      const b = document.createElement("button");
      b.className = "chip" + (state.lineFilter === key ? " active" : "");
      b.textContent = label;
      b.addEventListener("click", () => { state.lineFilter = key; buildSidebar(); });
      filterBar.appendChild(b);
    });
    linesListEl.appendChild(filterBar);

    const trainRoutes = state.routes.filter(r => r.mode === "treno");
    const busRoutes = state.routes.filter(r => r.mode === "autobus");

    if (state.lineFilter === "all" || state.lineFilter === "treno") {
      trainRoutes.forEach(r => linesListEl.appendChild(renderSingleLineCard(r)));
    }

    if (state.lineFilter === "all" || state.lineFilter === "autobus") {
      const groups = {};
      busRoutes.forEach(r => {
        if (!groups[r.line_group]) groups[r.line_group] = [];
        groups[r.line_group].push(r);
      });
      Object.keys(groups).sort((a, b) => {
        const na = parseInt(a, 10), nb = parseInt(b, 10);
        if (isNaN(na) || isNaN(nb)) return isNaN(na) - isNaN(nb) || a.localeCompare(b);
        return na - nb;
      }).forEach(lg => {
        linesListEl.appendChild(renderGroupedLineCard(lg, groups[lg]));
      });
    }
  }

  function renderSingleLineCard(route) {
    const card = document.createElement("div");
    card.className = "line-group";
    card.innerHTML = `
      <div class="line-group-header" data-route-id="${route.id}">
        <span class="line-chip" style="background:${route.color}">TR</span>
        <div>
          <div class="line-group-title">${route.short_name}</div>
          <div class="line-group-sub">${route.long_name}</div>
        </div>
      </div>`;
    card.querySelector(".line-group-header").addEventListener("click", () => {
      selectRoute(route.id, { fly: true });
    });
    return card;
  }

  function renderGroupedLineCard(lineGroup, variants) {
    const card = document.createElement("div");
    card.className = "line-group";
    const first = variants[0];
    const header = document.createElement("div");
    header.className = "line-group-header";
    header.innerHTML = `
      <span class="line-chip" style="background:${first.color}">${first.chip || lineGroup}</span>
      <div>
        <div class="line-group-title">${first.title || "Linea " + lineGroup}</div>
        <div class="line-group-sub">${first.long_name}</div>
      </div>`;
    const variantsWrap = document.createElement("div");
    variantsWrap.className = "line-variants";
    variants.sort((a, b) => (a.variant || "").localeCompare(b.variant || "")).forEach(v => {
      const btn = document.createElement("button");
      btn.className = "variant-btn";
      btn.textContent = v.variant ? `Corsa ${v.variant} — ${v.n_trips} corse programmate` : `${v.n_trips} corse programmate`;
      btn.dataset.routeId = v.id;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        variantsWrap.querySelectorAll(".variant-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        selectRoute(v.id, { fly: true });
      });
      variantsWrap.appendChild(btn);
    });
    header.addEventListener("click", () => {
      variantsWrap.classList.toggle("open");
      if (variantsWrap.classList.contains("open") && !state.activeRouteId) {
        selectRoute(first.id, { fly: true });
      }
    });
    card.appendChild(header);
    card.appendChild(variantsWrap);
    return card;
  }

  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      showPane(btn.dataset.mode);
    });
  });

  document.getElementById("menu-toggle").addEventListener("click", () => {
    sidebarEl.classList.toggle("open");
  });
  document.getElementById("drawer-backdrop").addEventListener("click", () => sidebarEl.classList.remove("open"));

  // Page footer: sources and notes open as a sheet above the footer bar
  const footerToggle = document.getElementById("footer-toggle");
  const footerDetails = document.getElementById("footer-details");
  function setFooterOpen(open) {
    footerDetails.classList.toggle("open", open);
    footerToggle.setAttribute("aria-expanded", String(open));
    footerToggle.textContent = open ? "Chiudi" : "Fonti e note";
  }
  footerToggle.addEventListener("click", () => setFooterOpen(!footerDetails.classList.contains("open")));
  document.addEventListener("keydown", e => { if (e.key === "Escape") setFooterOpen(false); });
  document.addEventListener("click", e => {
    if (footerDetails.classList.contains("open") && !e.target.closest("#site-footer")) setFooterOpen(false);
  });

  // Below 1000px the sidebar is a drawer and the details panel a bottom sheet over the map
  const compactQuery = window.matchMedia("(max-width: 1000px)");
  const isCompact = () => compactQuery.matches;
  const closeDrawer = () => { if (isCompact()) sidebarEl.classList.remove("open"); };

  // ---------- Route selection & highlighting ----------

  function dimAllRoutes() {
    Object.values(state.routeLayers).forEach(layers => {
      layers.forEach(l => l.setStyle({ weight: 3, opacity: 0.5 }));
    });
  }

  function highlightRoute(routeId) {
    highlightRoutes([routeId]);
  }

  function highlightRoutes(routeIds) {
    dimAllRoutes();
    clearFocus();
    state.activeRouteIds = routeIds;
    routeIds.forEach(routeId => {
      const layers = state.routeLayers[routeId];
      if (!layers) return;
      layers.forEach(l => {
        l.setStyle({ weight: 6, opacity: 0.95 });
        l.bringToFront();
      });
    });
  }

  function fitRouteBounds(routeId) {
    fitRoutesBounds([routeId]);
  }

  function fitRoutesBounds(routeIds) {
    const allLayers = [];
    routeIds.forEach(routeId => {
      const layers = state.routeLayers[routeId];
      if (layers) allLayers.push(...layers);
    });
    if (!allLayers.length) return;
    const group = L.featureGroup(allLayers);
    fitMapTo(group.getBounds().pad(0.1));
  }

  // The map is partly covered by the bottom sheet on compact screens: keep the target in the visible part.
  function fitMapTo(bounds) {
    map.invalidateSize({ pan: false }); // the side panel may have just changed the map width
    // On compact screens the panel overlays the map (a bottom sheet, or a right column when held sideways)
    let coverBottom = 0, coverRight = 0;
    if (isCompact() && !panelEl.classList.contains("hidden")) {
      const p = panelEl.getBoundingClientRect(), m = document.getElementById("map").getBoundingClientRect();
      if (p.width >= m.width * 0.9) coverBottom = p.height; else coverRight = p.width;
    }
    map.fitBounds(bounds, { paddingTopLeft: [24, 24], paddingBottomRight: [coverRight + 24, coverBottom + 24], maxZoom: 16 });
  }

  function clearFocus() {
    if (state.focusLayer) {
      map.removeLayer(state.focusLayer);
      state.focusLayer = null;
    }
    showNetwork();
  }

  // While a journey is shown the rest of the network (lines and stops) is taken off the map.
  function hideNetwork() {
    if (state.networkHidden) return;
    state.networkHidden = true;
    if (state.clusterGroup) map.removeLayer(state.clusterGroup);
    Object.values(state.routeLayers).forEach(layers => layers.forEach(l => map.removeLayer(l)));
    if (!state.showAllControl) {
      state.showAllControl = L.control({ position: "topright" });
      state.showAllControl.onAdd = () => {
        const btn = L.DomUtil.create("button", "map-show-all");
        btn.type = "button";
        btn.textContent = "Mostra tutte le linee";
        L.DomEvent.disableClickPropagation(btn);
        btn.addEventListener("click", () => {
          document.querySelectorAll(".journey-detail.open").forEach(d => d.classList.remove("open"));
          clearFocus();
        });
        return btn;
      };
    }
    state.showAllControl.addTo(map);
  }

  function showNetwork() {
    if (!state.networkHidden) return;
    state.networkHidden = false;
    Object.values(state.routeLayers).forEach(layers => layers.forEach(l => l.addTo(map)));
    if (state.clusterGroup) map.addLayer(state.clusterGroup);
    if (state.showAllControl) state.showAllControl.remove();
  }

  // The part of a line's shape between two of its stops (straight segments between the stops if
  // the shape cannot be followed).
  function legPath(leg) {
    const route = state.routesById[leg.routeId] || {};
    const trip = ((state.timetableCache[leg.routeId] || {}).trips || []).find(t => t.trip_id === leg.tripId);
    const ids = trip ? trip.stops.map(s => s[0]) : [leg.fromStop, leg.toStop];
    const a = ids.indexOf(leg.fromStop), b = ids.indexOf(leg.toStop);
    const onLeg = a !== -1 && b >= a ? (trip ? trip.stops.slice(a, b + 1) : []) : [];
    const A = state.stops[leg.fromStop], B = state.stops[leg.toStop];
    const straight = (onLeg.length ? onLeg.map(s => state.stops[s[0]]).filter(Boolean) : [A, B].filter(Boolean)).map(s => [s.lat, s.lon]);
    const shapes = route.shapes || {};
    const shape = shapes[trip ? trip.direction_id : ""] || Object.values(shapes).sort((x, y) => y.length - x.length)[0];
    if (!shape || shape.length < 2 || !A || !B) return { line: straight, onLeg };
    const near = (p, from) => {
      let best = -1, bd = Infinity;
      for (let i = from; i < shape.length; i++) {
        const d = (shape[i][0] - p.lat) ** 2 + ((shape[i][1] - p.lon) * 0.72) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    };
    const i = near(A, 0), j = i === -1 ? -1 : near(B, i);
    if (i === -1 || j <= i || haversineMeters(shape[j][0], shape[j][1], B.lat, B.lon) > 300) return { line: straight, onLeg };
    return { line: [[A.lat, A.lon], ...shape.slice(i, j + 1), [B.lat, B.lon]], onLeg };
  }

  // Show only one journey: the stretch of every line used, its stops, and the walks between them.
  function showJourneyOnMap(opt) {
    clearFocus();
    hideNetwork();
    const group = L.layerGroup();
    const bounds = [];
    const coord = id => {
      if (id === "__origin__") id = plannerState.originId;
      if (id === "__dest__") id = plannerState.destId;
      const p = plannerState.points[id] || state.stops[id];
      return p ? [p.lat, p.lon] : null;
    };
    const walk = (from, to) => {
      const a = coord(from), b = coord(to);
      if (!a || !b) return;
      L.polyline([a, b], { color: "#555", weight: 3, opacity: 0.9, dashArray: "2 8", lineCap: "round" }).addTo(group);
      bounds.push(a, b);
    };
    if (opt.initialWalk) walk(opt.initialWalk.from, opt.initialWalk.to);
    opt.legs.forEach((leg, n) => {
      const route = routeOfSafe(leg.routeId);
      const { line, onLeg } = legPath(leg);
      L.polyline(line, { color: "#fff", weight: 10, opacity: 0.9, lineCap: "round" }).addTo(group);
      L.polyline(line, { color: route.color, weight: 6, opacity: 1, lineCap: "round" }).addTo(group);
      bounds.push(...line);
      const stops = onLeg.length ? onLeg : [[leg.fromStop, leg.arrTime, leg.depTime], [leg.toStop, leg.arrTime, leg.arrTime]];
      stops.forEach((s, i) => {
        const stop = state.stops[s[0]];
        if (!stop) return;
        const first = i === 0, last = i === stops.length - 1;
        const time = first ? leg.depTime : (last ? leg.arrTime : s[2]);
        L.circleMarker([stop.lat, stop.lon], {
          radius: first || last ? 8 : 4, color: "#fff", weight: 2, fillOpacity: 1,
          fillColor: first ? "#1c7c54" : last ? "#b23a48" : route.color,
        }).bindTooltip(`${first ? "Sali: " : last ? "Scendi: " : ""}${stop.name} (${fmtTime(time)})`, { direction: "top", permanent: first || last }).addTo(group);
      });
      if (n < opt.legs.length - 1 && leg.toStop !== opt.legs[n + 1].fromStop) walk(leg.toStop, opt.legs[n + 1].fromStop);
    });
    if (opt.finalWalk) walk(opt.finalWalk.from, opt.finalWalk.to);
    ["origin", "dest"].forEach(role => {
      const p = plannerState.points[role === "origin" ? plannerState.originId : plannerState.destId];
      if (p) bounds.push([p.lat, p.lon]);
    });
    group.addTo(map);
    state.focusLayer = group;
    if (bounds.length) fitMapTo(L.latLngBounds(bounds).pad(0.12));
  }

  // Centre and zoom the map on the stretch covered by a trip or journey, marking its stops.
  function focusStops(stopIds, color) {
    clearFocus();
    const stops = stopIds.map(id => state.stops[id]).filter(Boolean);
    if (!stops.length) return;
    const group = L.layerGroup();
    stops.forEach((s, i) => {
      const first = i === 0, last = i === stops.length - 1 && stops.length > 1;
      L.circleMarker([s.lat, s.lon], {
        radius: first || last ? 7 : 4, color: "#fff", weight: 2, fillOpacity: 1,
        fillColor: first ? "#1c7c54" : last ? "#b23a48" : (color || "#d68c45"),
      }).bindTooltip(s.name, { direction: "top" }).addTo(group);
    });
    group.addTo(map);
    state.focusLayer = group;
    fitMapTo(L.latLngBounds(stops.map(s => [s.lat, s.lon])).pad(0.15));
  }

  function selectRoute(routeId, opts) {
    opts = opts || {};
    state.activeRouteId = routeId;
    highlightRoute(routeId);
    openSchedulePanel(routeId, opts.focusStop || null);
    if (opts.fly !== false) fitRouteBounds(routeId);
    closeDrawer();
  }

  // ---------- Schedule panel ----------

  function fetchTimetable(routeId) {
    if (state.timetableCache[routeId]) {
      return Promise.resolve(state.timetableCache[routeId]);
    }
    return fetch(`data/timetables/${routeId}.json`).then(r => r.json()).then(data => {
      state.timetableCache[routeId] = data;
      return data;
    });
  }

  function directionLabel(route, trips, directionId) {
    const withHeadsign = trips.filter(t => t.direction_id === directionId && t.headsign);
    if (withHeadsign.length) {
      const counts = {};
      withHeadsign.forEach(t => counts[t.headsign] = (counts[t.headsign] || 0) + 1);
      const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      return best;
    }
    // fall back to first/last stop of route order
    if (route.stop_order && route.stop_order.length) {
      return directionId === "0"
        ? `${stopDisplayName(route.stop_order[0])} → ${stopDisplayName(route.stop_order[route.stop_order.length - 1])}`
        : `${stopDisplayName(route.stop_order[route.stop_order.length - 1])} → ${stopDisplayName(route.stop_order[0])}`;
    }
    return `Direzione ${directionId}`;
  }

  function openSchedulePanel(routeId, focusStopId) {
    const route = state.routesById[routeId];
    if (!route) return;
    panelEl.classList.remove("hidden");
    panelContentEl.innerHTML = `<div class="empty-note">Caricamento orari…</div>`;

    fetchTimetable(routeId).then(data => {
      const trips = data.trips || [];
      const directions = Array.from(new Set(trips.map(t => t.direction_id))).sort();
      const uiState = {
        direction: directions[0] || "0",
        dayType: "__all__",
        stopFilter: focusStopId || "__all__",
      };

      function render() {
        const dirTrips = trips.filter(t => t.direction_id === uiState.direction);
        const dayTypes = Array.from(new Set(dirTrips.map(t => t.day_type)));

        let visibleTrips = dirTrips.filter(t => uiState.dayType === "__all__" || t.day_type === uiState.dayType);
        if (uiState.stopFilter !== "__all__") {
          visibleTrips = visibleTrips.filter(t => t.stops.some(s => s[0] === uiState.stopFilter));
        }

        visibleTrips = visibleTrips.slice().sort((a, b) => {
          const ta = uiState.stopFilter !== "__all__"
            ? timeToMinutes((a.stops.find(s => s[0] === uiState.stopFilter) || [,,a.stops[0][2]])[2])
            : timeToMinutes(a.stops[0][2]);
          const tb = uiState.stopFilter !== "__all__"
            ? timeToMinutes((b.stops.find(s => s[0] === uiState.stopFilter) || [,,b.stops[0][2]])[2])
            : timeToMinutes(b.stops[0][2]);
          return ta - tb;
        });

        const stopOptions = route.stop_order.map(sid =>
          `<option value="${sid}" ${uiState.stopFilter === sid ? "selected" : ""}>${stopDisplayName(sid)}</option>`
        ).join("");

        const dayChips = [`<button class="chip ${uiState.dayType === "__all__" ? "active" : ""}" data-daytype="__all__">Tutti (nessun filtro)</button>`]
          .concat(dayTypes.filter(dt => dt !== "Tutti i giorni").map(dt => `<button class="chip ${uiState.dayType === dt ? "active" : ""}" data-daytype="${dt}">${dt}</button>`))
          .join("");

        const dirButtons = directions.map(d =>
          `<button class="chip ${uiState.direction === d ? "active" : ""}" data-direction="${d}">${directionLabel(route, trips, d)}</button>`
        ).join("");

        const tripsHtml = visibleTrips.length ? visibleTrips.map(t => {
          const depStop = t.stops[0];
          const arrStop = t.stops[t.stops.length - 1];
          const focusEntry = uiState.stopFilter !== "__all__" ? t.stops.find(s => s[0] === uiState.stopFilter) : null;
          const mainTime = focusEntry ? focusEntry[2] : depStop[2];
          return `
            <div class="trip-row">
              <div class="trip-row-head" data-trip-id="${t.trip_id}">
                <div>
                  <span class="trip-time">${modeIcon(route.mode)}${fmtTime(mainTime)}</span>
                  <div class="trip-headsign">${t.headsign || (stopDisplayName(depStop[0]) + " → " + stopDisplayName(arrStop[0]))}</div>
                </div>
                <span class="trip-daytype">${t.day_type}</span>
              </div>
              <div class="trip-stops" id="stops-${t.trip_id}">
                ${t.stops.map(s => `<div class="trip-stop-line ${s[0] === uiState.stopFilter ? "is-selected" : ""}">
                    <span>${stopDisplayName(s[0])}</span><span>${fmtTime(s[2])}</span>
                  </div>`).join("")}
              </div>
            </div>`;
        }).join("") : `<div class="empty-note">Nessuna corsa trovata per questa combinazione di filtri.</div>`;

        panelContentEl.innerHTML = `
          <div class="panel-title">${route.short_name}${route.variant ? " " + route.variant : ""}</div>
          <div class="panel-sub">${route.agency} &middot; ${route.long_name}</div>

          <div class="panel-section-label">Direzione</div>
          <div class="daytype-chips">${dirButtons}</div>

          <div class="panel-section-label">Ferma a</div>
          <select id="stop-filter">
            <option value="__all__">Tutte le fermate (orario da capolinea)</option>
            ${stopOptions}
          </select>

          <div class="panel-section-label">Giorno</div>
          <div class="daytype-chips">${dayChips}</div>

          <div class="panel-section-label">Corse (${visibleTrips.length})</div>
          ${tripsHtml}
        `;

        panelContentEl.querySelectorAll("[data-direction]").forEach(b => {
          b.addEventListener("click", () => { uiState.direction = b.dataset.direction; render(); });
        });
        panelContentEl.querySelectorAll("[data-daytype]").forEach(b => {
          b.addEventListener("click", () => { uiState.dayType = b.dataset.daytype; render(); });
        });
        const sel = panelContentEl.querySelector("#stop-filter");
        sel.addEventListener("change", () => { uiState.stopFilter = sel.value; render(); });
        panelContentEl.querySelectorAll("[data-trip-id]").forEach(head => {
          head.addEventListener("click", () => {
            const detail = document.getElementById(`stops-${head.dataset.tripId}`);
            detail.classList.toggle("open");
            if (detail.classList.contains("open")) {
              const trip = trips.find(t => t.trip_id === head.dataset.tripId);
              if (trip) focusStops(trip.stops.map(s => s[0]), route.color);
            } else {
              clearFocus();
            }
          });
        });
      }

      render();
    });
  }

  document.getElementById("panel-close").addEventListener("click", () => {
    panelEl.classList.add("hidden");
    state.activeRouteId = null;
    state.activeRouteIds = [];
    clearFocus();
    dimAllRoutes();
  });

  // ---------- Journey planner (Da / A) ----------

  const plannerState = {
    originId: null,
    destId: null,
    dayFilter: "__any__", // __any__ | feriale | sabato | festivo
    modeFilter: "all",    // all | bus | treno | mixed (bus + treno nello stesso viaggio)
    hasSearched: false,
    points: {},    // id -> {lat, lon, name}: places picked as an address or as the current position
    markers: {},   // role -> map pin of such a place
  };

  function modeFilterMatches(opt) {
    const modes = new Set(opt.legs.map(l => routeOfSafe(l.routeId).mode));
    switch (plannerState.modeFilter) {
      case "bus": return modes.size === 1 && modes.has("autobus");
      case "treno": return modes.size === 1 && modes.has("treno");
      case "mixed": return modes.size === 2;
      default: return true;
    }
  }

  const WEEKDAY_ABBR = { Lun: 0, Mar: 1, Mer: 2, Gio: 3, Ven: 4, Sab: 5, Dom: 6 };

  function parseDayTypeToWeekdays(label) {
    const days = new Set();
    if (!label) return days;
    if (label.includes("Tutti i giorni")) return new Set([0, 1, 2, 3, 4, 5, 6]);
    if (label.includes("Feriale")) [0, 1, 2, 3, 4].forEach(d => days.add(d));
    if (label.includes("Sabato")) days.add(5);
    if (label.includes("Domenica")) days.add(6);
    (label.match(/\b(?:Lun|Mar|Mer|Gio|Ven|Sab|Dom)\b/g) || []).forEach(tok => days.add(WEEKDAY_ABBR[tok]));
    return days;
  }

  function dayFilterMatches(dayFilter, weekdaySet) {
    if (dayFilter === "__any__") return true;
    if (!weekdaySet.size) return true; // unknown pattern: don't exclude
    const want = { feriale: [0, 1, 2, 3, 4], sabato: [5], festivo: [6] }[dayFilter];
    return want.some(d => weekdaySet.has(d));
  }

  function fmtDuration(mins) {
    if (mins < 0) return "--";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h <= 0) return `${m} min`;
    return `${h}h ${String(m).padStart(2, "0")}min`;
  }

  function renderPlanner() {
    plannerEl.innerHTML = `
      <div class="planner-field">
        <label>Da dove parti</label>
        <div class="planner-input-row">
          <input type="text" id="planner-from" placeholder="Fermata, via, località o comune" autocomplete="off">
          <button type="button" class="planner-locate" id="planner-locate" title="Usa la mia posizione" aria-label="Usa la mia posizione">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="planner-autocomplete hidden" id="planner-from-ac"></div>
      </div>
      <button class="planner-swap" id="planner-swap" title="Inverti partenza/arrivo">&#8645;</button>
      <div class="planner-field">
        <label>Dove vuoi andare</label>
        <input type="text" id="planner-to" placeholder="Fermata, via, località o comune" autocomplete="off">
        <div class="planner-autocomplete hidden" id="planner-to-ac"></div>
      </div>

      <div class="planner-hint" id="planner-hint"></div>

      <div class="panel-section-label" style="margin-top:10px;">Giorno del viaggio</div>
      <div class="daytype-chips" id="planner-day-chips">
        <button class="chip active" data-day="__any__">Qualsiasi</button>
        <button class="chip" data-day="feriale">Feriale (Lun-Ven)</button>
        <button class="chip" data-day="sabato">Sabato</button>
        <button class="chip" data-day="festivo">Domenica e festivi</button>
      </div>

      <div class="panel-section-label" style="margin-top:6px;">Mezzi</div>
      <div class="daytype-chips" id="planner-mode-chips">
        <button class="chip active" data-mode-filter="all">Tutti</button>
        <button class="chip" data-mode-filter="bus">${modeIcon("autobus")}Solo bus</button>
        <button class="chip" data-mode-filter="treno">${modeIcon("treno")}Solo treno</button>
        <button class="chip" data-mode-filter="mixed">${modeIcon("autobus")}${modeIcon("treno")}Bus + treno</button>
      </div>

      <button class="planner-search-btn" id="planner-search-btn" disabled>Cerca percorso</button>
      <div class="planner-note">
        Calcola le combinazioni dirette e con uno o più cambi tra le fermate di treno e autobus della zona,
        ordinate per durata (include brevi cambi a piedi tra una fermata bus e una stazione vicine).
        Puoi partire o arrivare anche da una via, una località, un comune o dalla tua posizione: il percorso comprende
        la camminata fino alla fermata (stima in linea d'aria; senza numero civico si usa il centro della via, e il
        segnaposto si può trascinare sul punto esatto). Le vie sono cercate con OpenStreetMap: il testo scritto viene
        inviato a quel servizio, la posizione GPS no.
      </div>
      <div id="planner-results"></div>
    `;

    setupPlannerAutocomplete("planner-from", "planner-from-ac", place => setPlannerPlace("origin", place), { locate: useMyPosition });
    setupPlannerAutocomplete("planner-to", "planner-to-ac", place => setPlannerPlace("dest", place));
    document.getElementById("planner-locate").addEventListener("click", useMyPosition);

    document.getElementById("planner-swap").addEventListener("click", () => {
      const fromInput = document.getElementById("planner-from");
      const toInput = document.getElementById("planner-to");
      const tmpVal = fromInput.value; fromInput.value = toInput.value; toInput.value = tmpVal;
      const tmpId = plannerState.originId; plannerState.originId = plannerState.destId; plannerState.destId = tmpId;
      refreshPointMarkers();
      checkPlannerReady();
    });

    plannerEl.querySelectorAll("#planner-day-chips [data-day]").forEach(btn => {
      btn.addEventListener("click", () => {
        plannerEl.querySelectorAll("#planner-day-chips .chip").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        plannerState.dayFilter = btn.dataset.day;
        if (plannerState.hasSearched) runPlannerSearch();
      });
    });

    plannerEl.querySelectorAll("#planner-mode-chips [data-mode-filter]").forEach(btn => {
      btn.addEventListener("click", () => {
        plannerEl.querySelectorAll("#planner-mode-chips .chip").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        plannerState.modeFilter = btn.dataset.modeFilter;
        if (plannerState.hasSearched) runPlannerSearch();
      });
    });

    document.getElementById("planner-search-btn").addEventListener("click", runPlannerSearch);
  }

  function checkPlannerReady() {
    const btn = document.getElementById("planner-search-btn");
    if (!btn) return;
    btn.disabled = !(plannerState.originId && plannerState.destId && plannerState.originId !== plannerState.destId);
  }

  // ---------- Places: stops, addresses, current position ----------

  // Address search: Photon (OpenStreetMap data), which is meant for suggestions while typing.
  // Only the text typed in the field is sent, never the GPS position.
  const PHOTON_URL = "https://photon.komoot.io/api/";
  const GEO_BBOX = "10.9,43.7,12.0,44.4";            // Mugello, Val di Sieve, Firenze, Faenza
  const GEO_BIAS = { lat: 43.97, lon: 11.38 };
  const GEO_SKIP_KEYS = new Set(["waterway", "boundary", "natural", "landuse", "route", "aeroway"]);
  const geoCache = new Map();

  function describeAddress(p) {
    const street = p.street ? p.street + (p.housenumber ? " " + p.housenumber : "") : "";
    const town = p.city || p.town || p.village || p.county || "";
    const place = [p.district && p.district !== town ? p.district : "", town].filter(Boolean).join(", ");
    const name = p.name || street;
    const detail = [p.name && street ? street : "", place].filter(Boolean).join(" · ");
    return { name, detail };
  }

  async function searchAddresses(q, signal) {
    const key = q.toLowerCase();
    if (geoCache.has(key)) return geoCache.get(key);
    // "loc. Cardetole, 38, Borgo San Lorenzo" -> "Cardetole 38 Borgo San Lorenzo", then without the number
    const cleaned = q.replace(/\b(?:loc|loc\.|località|localita|frazione|fraz|fraz\.)\s+/gi, "").replace(/[,;]+/g, " ").replace(/\s+/g, " ").trim();
    const variants = Array.from(new Set([cleaned, cleaned.replace(/\b\d+\s?[a-z]?\b/gi, "").replace(/\s+/g, " ").trim()])).filter(v => v.length >= 3);
    let features = [];
    for (const v of variants) {
      const url = `${PHOTON_URL}?q=${encodeURIComponent(v)}&limit=8&bbox=${GEO_BBOX}&lat=${GEO_BIAS.lat}&lon=${GEO_BIAS.lon}`;
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      features = ((await res.json()).features || []).filter(f => !GEO_SKIP_KEYS.has((f.properties || {}).osm_key));
      if (features.length) break;
    }
    const seen = new Set();
    const list = [];
    features.forEach(f => {
      const p = f.properties || {};
      if (GEO_SKIP_KEYS.has(p.osm_key) || !f.geometry || !f.geometry.coordinates) return;
      const { name, detail } = describeAddress(p);
      if (!name) return;
      const [lon, lat] = f.geometry.coordinates;
      const id = `${name}|${detail}`;
      if (seen.has(id)) return;
      seen.add(id);
      list.push({ name: detail ? `${name}, ${detail.split(" · ").pop()}` : name, shortName: name, detail, lat, lon });
    });
    geoCache.set(key, list.slice(0, 5));
    return geoCache.get(key);
  }

  function setupPlannerAutocomplete(inputId, acId, onSelect, opts = {}) {
    const input = document.getElementById(inputId);
    const ac = document.getElementById(acId);
    let timer = null, controller = null, token = 0;

    function render(q, addresses, searching) {
      const ql = q.toLowerCase();
      const stops = q.length >= 2 ? Object.values(state.stops).filter(s => s.name.toLowerCase().includes(ql)).slice(0, 8) : [];
      const rows = [];
      if (opts.locate && q.length < 2) {
        rows.push(`<div class="planner-ac-item planner-ac-locate" data-locate="1"><div>&#9673; La mia posizione</div><div class="sr-meta">Usa il GPS del dispositivo</div></div>`);
      }
      stops.forEach(s => rows.push(`
        <div class="planner-ac-item" data-stop-id="${s.id}">
          <div>${escapeHtml(s.name)}</div>
          <div class="sr-meta">${s.modes.includes("treno") ? "Stazione" : "Fermata bus"}</div>
        </div>`));
      (addresses || []).forEach((a, i) => rows.push(`
        <div class="planner-ac-item" data-address="${i}">
          <div>${escapeHtml(a.shortName)}</div>
          <div class="sr-meta">Indirizzo o località${a.detail ? " · " + escapeHtml(a.detail) : ""}</div>
        </div>`));
      if (searching) rows.push(`<div class="planner-ac-item planner-ac-note">Cerco vie e località…</div>`);
      if (!rows.length) {
        if (q.length < 2) { ac.classList.add("hidden"); ac.innerHTML = ""; return; }
        rows.push(`<div class="planner-ac-item planner-ac-note">Nessun risultato</div>`);
      }
      ac.innerHTML = rows.join("");
      ac.classList.remove("hidden");
      ac.querySelectorAll("[data-stop-id]").forEach(el => el.addEventListener("click", () => {
        const stop = state.stops[el.dataset.stopId];
        input.value = stop.name;
        ac.classList.add("hidden");
        onSelect({ type: "stop", stop });
      }));
      ac.querySelectorAll("[data-address]").forEach(el => el.addEventListener("click", () => {
        const a = addresses[Number(el.dataset.address)];
        input.value = a.name;
        ac.classList.add("hidden");
        onSelect({ type: "point", point: { lat: a.lat, lon: a.lon, name: a.name } });
      }));
      ac.querySelectorAll("[data-locate]").forEach(el => el.addEventListener("click", () => {
        ac.classList.add("hidden");
        opts.locate();
      }));
    }

    input.addEventListener("focus", () => { if (opts.locate && input.value.trim().length < 2) render("", [], false); });
    input.addEventListener("input", () => {
      clearTimeout(timer);
      if (controller) controller.abort();
      const q = input.value.trim();
      const mine = ++token;
      render(q, [], q.length >= 3);
      if (q.length < 3) return;
      timer = setTimeout(async () => {
        controller = new AbortController();
        try {
          const addresses = await searchAddresses(q, controller.signal);
          if (mine === token) render(q, addresses, false);
        } catch (err) {
          if (mine === token && err.name !== "AbortError") render(q, [], false);   // offline: the stops still work
        }
      }, 400);
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(`#${inputId}`) && !e.target.closest(`#${acId}`) && !e.target.closest(".planner-locate")) {
        ac.classList.add("hidden");
      }
    });
  }

  // A place picked as an address or position (not a stop) is a pin on the map, which can be dragged.
  function placeName(id) {
    if (id === "__origin__") return placeName(plannerState.originId);
    if (id === "__dest__") return placeName(plannerState.destId);
    const point = plannerState.points[id];
    return point ? point.name : stopDisplayName(id);
  }

  function refreshPointMarkers() {
    Object.values(plannerState.markers).forEach(m => map.removeLayer(m));
    plannerState.markers = {};
    [["origin", plannerState.originId, "Partenza", "Da"], ["dest", plannerState.destId, "Arrivo", "A"]].forEach(([role, id, title, letter]) => {
      const point = plannerState.points[id];
      if (!point) return;
      const marker = L.marker([point.lat, point.lon], {
        draggable: true, keyboard: false, title: `${title}: ${point.name}`,
        icon: L.divIcon({ className: "", html: `<div class="pt-pin pt-${role}"><span>${letter}</span></div>`, iconSize: [30, 38], iconAnchor: [15, 36] }),
      }).addTo(map);
      marker.on("dragend", () => {
        const pos = marker.getLatLng();
        point.lat = pos.lat; point.lon = pos.lng;
        point.name = point.name.replace(/ \(spostato\)$/, "") + " (spostato)";
        const input = document.getElementById(role === "origin" ? "planner-from" : "planner-to");
        if (input) input.value = point.name;
        if (plannerState.hasSearched) runPlannerSearch();
      });
      plannerState.markers[role] = marker;
    });
  }

  function setPlannerPlace(role, place) {
    const key = role === "origin" ? "originId" : "destId";
    const old = plannerState[key];
    if (old && plannerState.points[old]) delete plannerState.points[old];
    if (place.type === "stop") {
      plannerState[key] = place.stop.id;
    } else {
      const id = `pt:${role}:${Date.now()}`;
      plannerState.points[id] = { ...place.point };
      plannerState[key] = id;
    }
    refreshPointMarkers();
    const point = plannerState.points[plannerState[key]];
    if (point) map.setView([point.lat, point.lon], Math.max(map.getZoom(), 14));
    checkPlannerReady();
  }

  function useMyPosition() {
    const hint = document.getElementById("planner-hint");
    const input = document.getElementById("planner-from");
    const say = text => { if (hint) hint.textContent = text; };
    if (!navigator.geolocation) { say("Questo dispositivo non fornisce la posizione."); return; }
    say("Cerco la tua posizione…");
    navigator.geolocation.getCurrentPosition(pos => {
      const { latitude, longitude, accuracy } = pos.coords;
      setPlannerPlace("origin", { type: "point", point: { lat: latitude, lon: longitude, name: "La mia posizione" } });
      if (input) input.value = "La mia posizione";
      say(`Posizione trovata (precisione circa ${Math.round(accuracy)} m). Il segnaposto si può trascinare.`);
    }, err => {
      say(err.code === 1 ? "Permesso negato: abilita la posizione per questo sito nelle impostazioni del browser."
        : err.code === 3 ? "Posizione non trovata in tempo, riprova."
        : "Posizione non disponibile su questo dispositivo.");
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }

  function ensureTimetablesLoaded(routeIds) {
    return Promise.all(routeIds.map(fetchTimetable));
  }

  async function runPlannerSearch() {
    const resultsEl = document.getElementById("planner-results");
    plannerState.hasSearched = true;
    clearFocus();
    resultsEl.innerHTML = `<div class="empty-note">Ricerca combinazioni…</div>`;
    const originPoint = plannerState.points[plannerState.originId];
    const destPoint = plannerState.points[plannerState.destId];
    if (originPoint || destPoint) return runPointSearch(resultsEl, originPoint, destPoint);
    const origin = state.stops[plannerState.originId];
    const dest = state.stops[plannerState.destId];
    if (!origin || !dest) return;

    // Expand to "the same place" — many stops have a separate pole per direction a short
    // walk apart (e.g. "Razzuolo" / "Razzuolo 1"); a trip using either pole should count.
    const originCluster = state.stopClusters[origin.id] || new Set([origin.id]);
    const destCluster = state.stopClusters[dest.id] || new Set([dest.id]);

    const originRoutes = Array.from(new Set([...originCluster].flatMap(id => (state.stops[id] || { routes: [] }).routes))).filter(rid => state.routesById[rid]);
    const destRoutes = Array.from(new Set([...destCluster].flatMap(id => (state.stops[id] || { routes: [] }).routes))).filter(rid => state.routesById[rid]);
    const allNeeded = Array.from(new Set([...originRoutes, ...destRoutes]));

    await ensureTimetablesLoaded(allNeeded);

    const options = [];
    const routeOf = rid => state.routesById[rid];
    const MIN_TRANSFER = 3;
    const MAX_WAIT = 90;

    // Direct trips: any route that serves both origin and destination, in the right order
    const directRoutes = originRoutes.filter(rid => destRoutes.includes(rid));
    directRoutes.forEach(rid => {
      const tt = state.timetableCache[rid];
      tt.trips.forEach(t => {
        const oi = t.stops.findIndex(s => originCluster.has(s[0]));
        const di = t.stops.findIndex(s => destCluster.has(s[0]));
        if (oi === -1 || di === -1 || oi >= di) return;
        const weekdays = parseDayTypeToWeekdays(t.day_type);
        if (!dayFilterMatches(plannerState.dayFilter, weekdays)) return;
        const dep = timeToMinutes(t.stops[oi][2]);
        const arr = timeToMinutes(t.stops[di][1]);
        options.push({
          type: "diretto",
          duration: arr - dep,
          depMin: dep,
          legs: [{
            routeId: rid, tripId: t.trip_id, fromStop: t.stops[oi][0], toStop: t.stops[di][0],
            depTime: t.stops[oi][2], arrTime: t.stops[di][1], dayType: t.day_type,
          }],
        });
      });

      // Some lines (notably the Faentina train, split at Marradi) model a real
      // same-platform change as a single route_id: two distinct trips joined at a
      // common stop. Look for that too, since a "direct route" match doesn't imply
      // every trip on it actually runs end-to-end.
      if (routeOf(rid).mode !== "treno") return;
      const stopsArr = routeOf(rid).stop_order;
      const seenKeys = new Set();
      const places = [];
      stopsArr.forEach(sX => {
        if (originCluster.has(sX) || destCluster.has(sX)) return;
        const c = state.stopClusters[sX] || new Set([sX]);
        const key = [...c].sort().join(",");
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        places.push(c);
      });

      places.forEach(clusterT => {
        const legsA = [];
        tt.trips.forEach(t => {
          const oi = t.stops.findIndex(s => originCluster.has(s[0]));
          const ti = t.stops.findIndex(s => clusterT.has(s[0]));
          if (oi === -1 || ti === -1 || oi >= ti) return;
          const weekdays = parseDayTypeToWeekdays(t.day_type);
          if (!dayFilterMatches(plannerState.dayFilter, weekdays)) return;
          legsA.push({
            tripId: t.trip_id, dep: timeToMinutes(t.stops[oi][2]), arr: timeToMinutes(t.stops[ti][1]),
            depTime: t.stops[oi][2], arrTime: t.stops[ti][1], dayType: t.day_type, weekdays,
            fromStop: t.stops[oi][0], toStop: t.stops[ti][0],
          });
        });
        if (!legsA.length) return;

        const legsB = [];
        tt.trips.forEach(t => {
          const ti = t.stops.findIndex(s => clusterT.has(s[0]));
          const di = t.stops.findIndex(s => destCluster.has(s[0]));
          if (ti === -1 || di === -1 || ti >= di) return;
          const weekdays = parseDayTypeToWeekdays(t.day_type);
          if (!dayFilterMatches(plannerState.dayFilter, weekdays)) return;
          legsB.push({
            tripId: t.trip_id, dep: timeToMinutes(t.stops[ti][2]), arr: timeToMinutes(t.stops[di][1]),
            depTime: t.stops[ti][2], arrTime: t.stops[di][1], dayType: t.day_type, weekdays,
            fromStop: t.stops[ti][0], toStop: t.stops[di][0],
          });
        });
        if (!legsB.length) return;
        legsB.sort((a, b) => a.dep - b.dep);

        legsA.forEach(la => {
          let best = null;
          for (const lb of legsB) {
            if (lb.tripId === la.tripId) continue; // must be a genuinely different run
            if (lb.dep < la.arr + MIN_TRANSFER) continue;
            if (lb.dep - la.arr > MAX_WAIT) break;
            const overlap = [...la.weekdays].some(d => lb.weekdays.has(d)) || !la.weekdays.size || !lb.weekdays.size;
            if (!overlap) continue;
            best = lb;
            break;
          }
          if (best) {
            options.push({
              type: "cambio",
              duration: best.arr - la.dep,
              depMin: la.dep,
              waitMinutes: best.dep - la.arr,
              walkMinutes: 0,
              legs: [
                { routeId: rid, tripId: la.tripId, fromStop: la.fromStop, toStop: la.toStop, depTime: la.depTime, arrTime: la.arrTime, dayType: la.dayType },
                { routeId: rid, tripId: best.tripId, fromStop: best.fromStop, toStop: best.toStop, depTime: best.depTime, arrTime: best.arrTime, dayType: best.dayType },
              ],
            });
          }
        });
      });
    });

    // One-change trips: via a stop shared by both routes, or via two distinct but nearby
    // stops (different mode) reachable on foot — e.g. a bus stop next to a train station.

    originRoutes.forEach(rA => {
      if (destRoutes.includes(rA)) return; // already handled (or not useful) via direct search
      const stopsAArr = routeOf(rA).stop_order;
      const ttA = state.timetableCache[rA];

      destRoutes.forEach(rB => {
        if (rA === rB) return;
        const stopsBSet = new Set(routeOf(rB).stop_order);

        // Group route A's stops into distinct "places" (a stop and its directional-pole
        // siblings), so a transfer works even if leg A alights at one pole of a place and
        // leg B boards from another pole of that same place a short walk away.
        const seenClusterKeys = new Set();
        const places = [];
        stopsAArr.forEach(sA => {
          if (originCluster.has(sA) || destCluster.has(sA)) return;
          const clusterA = state.stopClusters[sA] || new Set([sA]);
          const key = [...clusterA].sort().join(",");
          if (seenClusterKeys.has(key)) return;
          seenClusterKeys.add(key);
          places.push(clusterA);
        });

        const pairList = []; // { clusterA, clusterB, walkMin }
        places.forEach(clusterA => {
          const sameStop = [...clusterA].find(id => stopsBSet.has(id));
          if (sameStop) {
            pairList.push({ clusterA, clusterB: clusterA, walkMin: 0 });
            return;
          }
          let bestWalk = null;
          clusterA.forEach(id => {
            (state.nearbyCrossMode[id] || []).forEach(n => {
              if (originCluster.has(n.id) || destCluster.has(n.id)) return;
              const clusterN = state.stopClusters[n.id] || new Set([n.id]);
              if (![...clusterN].some(x => stopsBSet.has(x))) return;
              const walkMin = Math.max(2, Math.round(n.dist / 70));
              if (!bestWalk || walkMin < bestWalk.walkMin) bestWalk = { clusterA, clusterB: clusterN, walkMin };
            });
          });
          if (bestWalk) pairList.push(bestWalk);
        });
        if (!pairList.length) return;
        const ttB = state.timetableCache[rB];

        pairList.forEach(({ clusterA, clusterB, walkMin }) => {
          const legsA = [];
          ttA.trips.forEach(t => {
            const oi = t.stops.findIndex(s => originCluster.has(s[0]));
            const ti = t.stops.findIndex(s => clusterA.has(s[0]));
            if (oi === -1 || ti === -1 || oi >= ti) return;
            const weekdays = parseDayTypeToWeekdays(t.day_type);
            if (!dayFilterMatches(plannerState.dayFilter, weekdays)) return;
            legsA.push({
              tripId: t.trip_id, dep: timeToMinutes(t.stops[oi][2]), arr: timeToMinutes(t.stops[ti][1]),
              depTime: t.stops[oi][2], arrTime: t.stops[ti][1], dayType: t.day_type, weekdays,
              fromStop: t.stops[oi][0], toStop: t.stops[ti][0],
            });
          });
          if (!legsA.length) return;

          const legsB = [];
          ttB.trips.forEach(t => {
            const ti = t.stops.findIndex(s => clusterB.has(s[0]));
            const di = t.stops.findIndex(s => destCluster.has(s[0]));
            if (ti === -1 || di === -1 || ti >= di) return;
            const weekdays = parseDayTypeToWeekdays(t.day_type);
            if (!dayFilterMatches(plannerState.dayFilter, weekdays)) return;
            legsB.push({
              tripId: t.trip_id, dep: timeToMinutes(t.stops[ti][2]), arr: timeToMinutes(t.stops[di][1]),
              depTime: t.stops[ti][2], arrTime: t.stops[di][1], dayType: t.day_type, weekdays,
              fromStop: t.stops[ti][0], toStop: t.stops[di][0],
            });
          });
          if (!legsB.length) return;
          legsB.sort((a, b) => a.dep - b.dep);

          const minGap = Math.max(MIN_TRANSFER, walkMin + 2);

          legsA.forEach(la => {
            let best = null;
            for (const lb of legsB) {
              if (lb.dep < la.arr + minGap) continue;
              if (lb.dep - la.arr > MAX_WAIT + walkMin) break;
              const overlap = [...la.weekdays].some(d => lb.weekdays.has(d)) || !la.weekdays.size || !lb.weekdays.size;
              if (!overlap) continue;
              best = lb;
              break;
            }
            if (best) {
              options.push({
                type: "cambio",
                duration: best.arr - la.dep,
                depMin: la.dep,
                waitMinutes: best.dep - la.arr,
                walkMinutes: walkMin,
                legs: [
                  { routeId: rA, tripId: la.tripId, fromStop: la.fromStop, toStop: la.toStop, depTime: la.depTime, arrTime: la.arrTime, dayType: la.dayType },
                  { routeId: rB, tripId: best.tripId, fromStop: best.fromStop, toStop: best.toStop, depTime: best.depTime, arrTime: best.arrTime, dayType: best.dayType },
                ],
              });
            }
          });
        });
      });
    });

    // Few or no results: look for journeys with more changes, or with two runs of the same line.
    if (options.length < 8) {
      try {
        resultsEl.innerHTML = `<div class="empty-note">Ricerca di percorsi con più cambi…</div>`;
        const asMap = cluster => new Map(Array.from(cluster, s => [s, 0]));
        options.push(...await multiLegSearch(asMap(originCluster), asMap(destCluster), false));
      } catch (err) {
        console.error("multi-leg search failed", err);
      }
    }

    return finalizeJourneys(options);
  }

  // From or to an address: walk to the nearest stops, then the round-based search does the rest.
  async function runPointSearch(resultsEl, originPoint, destPoint) {
    const side = (point, id) => {
      if (point) return stopsNearPoint(point.lat, point.lon);
      const stop = state.stops[id];
      const cluster = state.stopClusters[id] || new Set(stop ? [id] : []);
      return new Map(Array.from(cluster, s => [s, 0]));
    };
    const origins = side(originPoint, plannerState.originId);
    const dests = side(destPoint, plannerState.destId);
    if (!origins.size || !dests.size) {
      const which = !origins.size ? placeName(plannerState.originId) : placeName(plannerState.destId);
      resultsEl.innerHTML = `<div class="empty-note">Nessuna fermata entro 1,5 km da &laquo;${escapeHtml(which)}&raquo;. Prova un luogo più vicino alla zona servita.</div>`;
      return;
    }
    resultsEl.innerHTML = `<div class="empty-note">Ricerca percorsi…</div>`;
    let options = [];
    try {
      options = await multiLegSearch(origins, dests, true);
    } catch (err) {
      console.error("address search failed", err);
    }
    finalizeJourneys(options);
  }

  function finalizeJourneys(options) {
    // De-duplicate: the same pair of physical runs can be found through several shared
    // stops along an overlapping stretch of two routes — keep just one row for each.
    const seenRuns = new Set();
    const dedupedOptions = options.filter(opt => {
      const key = opt.legs.map(l => `${l.routeId}#${l.tripId}`).join("|");
      if (seenRuns.has(key)) return false;
      seenRuns.add(key);
      return modeFilterMatches(opt);
    });

    // Some rural lines split an otherwise identical run into one trip per weekday. Merge
    // options that are the same route sequence at the same clock times into one row with
    // a combined list of days, instead of near-duplicate rows differing only by day.
    const groups = new Map();
    dedupedOptions.forEach(opt => {
      const routeSeq = opt.legs.map(l => l.routeId).join(">");
      const key = `${routeSeq}|${opt.legs[0].depTime}|${opt.legs[opt.legs.length - 1].arrTime}`;
      if (!groups.has(key)) groups.set(key, { ...opt, dayTypes: new Set() });
      groups.get(key).dayTypes.add(opt.multi ? DAY_CLASS_LABELS[opt.dayClass]
        : Array.from(new Set(opt.legs.map(l => l.dayType))).join(" / "));
    });
    const mergedOptions = Array.from(groups.values()).map(g => ({
      ...g, dayLabel: Array.from(g.dayTypes).join(", "),
    }));

    // A journey found by the multi-change search is useless when another one leaves later (or at the
    // same time) and arrives earlier (or at the same time), or is as good with fewer changes.
    const arrivalOf = o => o.depMin + o.duration;
    const kept = mergedOptions.filter(o => !o.multi || !mergedOptions.some(x => x !== o
      && x.depMin >= o.depMin && arrivalOf(x) <= arrivalOf(o)
      && (x.depMin > o.depMin || arrivalOf(x) < arrivalOf(o) || x.legs.length < o.legs.length)));
    mergedOptions.length = 0;
    mergedOptions.push(...kept);

    mergedOptions.sort((a, b) => a.duration - b.duration || a.depMin - b.depMin);

    renderPlannerResults(mergedOptions.slice(0, 40), mergedOptions.length);
  }

  // ---------- Journeys with several changes, or starting/ending away from a stop ----------
  // Round-based earliest-arrival search (RAPTOR): round k finds the best way to reach every stop
  // with k vehicles. It covers what the direct/one-change search above cannot: two different runs
  // of the same line joined at an intermediate stop, three or more legs, and journeys that begin
  // or end at an address (walking to or from the nearest stops).

  const MAX_LEGS = 4;
  const MAX_FIRST_WAIT = 5;   // the first run must leave right after the chosen departure time
  const MAX_WAIT_TRANSFER = 90;
  const MAX_JOURNEY_MIN = 360;
  const DAY_CLASS_LABELS = { feriale: "Feriale (Lun-Ven)", sabato: "Sabato", festivo: "Domenica e festivi" };
  const WALK_M_PER_MIN = 70;
  const POINT_WALK_RADIUS_M = 1500;   // stops considered around an address
  const POINT_MAX_STOPS = 25;
  const WALK_DETOUR = 1.25;           // streets are longer than the straight line

  // Every run of every line for one kind of day, grouped by identical stop sequence.
  function patternsForDay(dayClass) {
    state.patternCache = state.patternCache || {};
    if (state.patternCache[dayClass]) return state.patternCache[dayClass];
    const patterns = new Map();
    state.routes.forEach(route => {
      const tt = state.timetableCache[route.id];
      if (!tt) return;
      tt.trips.forEach(t => {
        if (t.stops.length < 2) return;
        if (!dayFilterMatches(dayClass, parseDayTypeToWeekdays(t.day_type))) return;
        const key = route.id + "|" + t.stops.map(s => s[0]).join(",");
        let p = patterns.get(key);
        if (!p) {
          p = { routeId: route.id, stops: t.stops.map(s => s[0]), trips: [] };
          patterns.set(key, p);
        }
        p.trips.push({
          tripId: t.trip_id, dayType: t.day_type,
          arr: t.stops.map(s => timeToMinutes(s[1])), dep: t.stops.map(s => timeToMinutes(s[2])),
          arrText: t.stops.map(s => s[1]), depText: t.stops.map(s => s[2]),
        });
      });
    });
    const list = Array.from(patterns.values());
    list.forEach(p => p.trips.sort((a, b) => a.dep[0] - b.dep[0]));
    const at = new Map();   // stop -> [{p, i}]
    list.forEach(p => p.stops.forEach((sid, i) => {
      if (!at.has(sid)) at.set(sid, []);
      at.get(sid).push({ p, i });
    }));
    return (state.patternCache[dayClass] = { list, at });
  }

  // Where one can go on foot from a stop: the other poles of the same place and, between a
  // bus stop and a station, the short walk the one-change search also uses.
  function footLinks(stopId) {
    const links = [];
    (state.stopClusters[stopId] || new Set()).forEach(id => { if (id !== stopId) links.push({ to: id, walk: 0 }); });
    (state.nearbyCrossMode[stopId] || []).forEach(n => {
      const walk = Math.max(2, Math.round(n.dist / WALK_M_PER_MIN));
      links.push({ to: n.id, walk });
      (state.stopClusters[n.id] || new Set()).forEach(id => { if (id !== n.id) links.push({ to: id, walk }); });
    });
    return links;
  }

  // The stops one can walk to from an address, with the walking time of each.
  function stopsNearPoint(lat, lon) {
    const near = [];
    Object.values(state.stops).forEach(s => {
      const d = haversineMeters(lat, lon, s.lat, s.lon);
      if (d <= POINT_WALK_RADIUS_M) near.push([s.id, Math.max(1, Math.ceil(d * WALK_DETOUR / WALK_M_PER_MIN))]);
    });
    near.sort((a, b) => a[1] - b[1]);
    return new Map(near.slice(0, POINT_MAX_STOPS));
  }

  function raptorFrom(day, startMin, origins, dests) {
    const { at } = day;
    const best = new Map();       // stop -> best arrival with any number of legs
    const ready = new Map();      // stop -> {time, label}: earliest moment one can board there
    const found = [];
    const originLabel = { kind: "origin", arr: startMin, legs: 0, parent: null };
    let marked = new Set();
    origins.forEach((walk, s) => {
      if (walk === 0) {
        best.set(s, startMin);
        ready.set(s, { time: startMin, label: originLabel });
      } else {   // an address: walk to the stop first
        const label = { kind: "walk", arr: startMin + walk, legs: 0, parent: originLabel, walk, from: "__origin__", to: s };
        best.set(s, startMin + walk);
        ready.set(s, { time: startMin + walk + 1, label });
      }
      marked.add(s);
    });
    // a named origin: also a short walk to a stop of the other kind (a station next to a bus stop)
    origins.forEach((walk, s) => {
      if (walk !== 0) return;
      footLinks(s).forEach(({ to, walk: w }) => {
        if (w === 0 || origins.has(to) || startMin + w >= (best.get(to) ?? Infinity)) return;
        const label = { kind: "walk", arr: startMin + w, legs: 0, parent: originLabel, walk: w, from: s, to };
        best.set(to, startMin + w);
        ready.set(to, { time: startMin + w + 1, label });
        marked.add(to);
      });
    });
    let destBest = Infinity;

    for (let round = 1; round <= MAX_LEGS; round++) {
      // earliest marked position on every line that serves a marked stop
      const scan = new Map();
      marked.forEach(sid => (at.get(sid) || []).forEach(({ p, i }) => {
        if (!scan.has(p) || scan.get(p) > i) scan.set(p, i);
      }));
      const improved = new Map();
      scan.forEach((from, p) => {
        let trip = null, boardIdx = -1, boardLabel = null;
        for (let i = from; i < p.stops.length; i++) {
          const sid = p.stops[i];
          if (trip) {
            const arr = trip.arr[i];
            if (arr < (best.get(sid) ?? Infinity) && arr < destBest && arr - startMin <= MAX_JOURNEY_MIN) {
              const label = {
                kind: "ride", arr, legs: boardLabel.legs + 1, parent: boardLabel,
                pattern: p, trip, boardIdx, alightIdx: i,
              };
              best.set(sid, arr);
              improved.set(sid, label);
              if (dests.has(sid)) destBest = Math.min(destBest, arr + dests.get(sid));
            }
          }
          const r = ready.get(sid);
          if (r) {
            const limit = r.label.legs === 0 ? MAX_FIRST_WAIT : MAX_WAIT_TRANSFER;
            const prevTrip = r.label.kind === "ride" ? r.label.trip : (r.label.kind === "walk" ? r.label.parent.trip : null);
            if (!trip || r.time <= trip.dep[i]) {
              const cand = p.trips.find(t => t.dep[i] >= r.time && t.dep[i] - r.time <= limit && t !== prevTrip);
              if (cand && (!trip || cand.dep[i] < trip.dep[i])) { trip = cand; boardIdx = i; boardLabel = r.label; }
            }
          }
        }
      });

      // footpaths from the stops reached this round
      const reached = new Map(improved);
      improved.forEach((label, sid) => {
        footLinks(sid).forEach(({ to, walk }) => {
          const arr = label.arr + walk;
          if (arr < (best.get(to) ?? Infinity) && arr < destBest) {
            reached.set(to, { kind: "walk", arr, legs: label.legs, parent: label, walk, from: sid, to });
            best.set(to, arr);
          }
        });
      });

      marked = new Set();
      reached.forEach((label, sid) => {
        const gap = label.kind === "walk" ? Math.max(3, label.walk + 2) - label.walk : 3;
        const time = label.arr + gap;
        const current = ready.get(sid);
        if (!current || time < current.time) ready.set(sid, { time, label });
        marked.add(sid);
      });

      // arrivals at the destination this round (a walk to the destination counts too)
      let top = null, topTotal = Infinity, topWalk = 0;
      dests.forEach((destWalk, sid) => {
        const l = reached.get(sid);
        if (!l || l.legs !== round || (destWalk > 0 && l.kind !== "ride")) return;
        if (l.arr + destWalk < topTotal) { top = l; topTotal = l.arr + destWalk; topWalk = destWalk; }
      });
      if (top) found.push({ label: top, destWalk: topWalk });
      if (!marked.size) break;
    }
    return found;
  }

  function journeyFromLabel({ label, destWalk }) {
    const rides = [];
    for (let l = label; l; l = l.parent) {
      if (l.kind === "ride") rides.unshift(l);
    }
    let finalWalk = null;
    if (destWalk > 0) {
      finalWalk = { from: label.pattern.stops[label.alightIdx], to: "__dest__", min: destWalk };
    } else if (label.kind === "walk" && label.walk > 0) {
      finalWalk = { from: label.from, to: label.to, min: label.walk };
    }
    const before = rides[0].parent;
    const initialWalk = before && before.kind === "walk" && before.parent && before.parent.kind === "origin"
      ? { from: before.from, to: before.to, min: before.walk } : null;
    const legs = rides.map(l => ({
      routeId: l.pattern.routeId, tripId: l.trip.tripId,
      fromStop: l.pattern.stops[l.boardIdx], toStop: l.pattern.stops[l.alightIdx],
      depTime: l.trip.depText[l.boardIdx], arrTime: l.trip.arrText[l.alightIdx], dayType: l.trip.dayType,
    }));
    const transfers = [];
    for (let i = 0; i < rides.length - 1; i++) {
      const a = state.stops[legs[i].toStop], b = state.stops[legs[i + 1].fromStop];
      const walkMin = legs[i].toStop === legs[i + 1].fromStop ? 0
        : Math.max(2, Math.round((a && b ? haversineMeters(a.lat, a.lon, b.lat, b.lon) : 0) / WALK_M_PER_MIN));
      transfers.push({ walkMin, waitMin: timeToMinutes(legs[i + 1].depTime) - timeToMinutes(legs[i].arrTime) });
    }
    const dep = timeToMinutes(legs[0].depTime) - (initialWalk ? initialWalk.min + 1 : 0);
    const arr = timeToMinutes(legs[legs.length - 1].arrTime) + (finalWalk ? finalWalk.min : 0);
    const clock = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;
    return {
      type: legs.length === 1 ? "diretto" : "cambio", duration: arr - dep, depMin: dep, legs, transfers, finalWalk,
      initialWalk, arrText: clock(arr), depText: clock(dep),
      waitMinutes: transfers[0] ? transfers[0].waitMin : 0, walkMinutes: transfers[0] ? transfers[0].walkMin : 0,
    };
  }

  // origins / dests: Map(stopId -> minutes on foot, 0 for a named stop)
  async function multiLegSearch(origins, dests, includeDirect) {
    await ensureTimetablesLoaded(state.routes.map(r => r.id));
    const classes = plannerState.dayFilter === "__any__" ? ["feriale", "sabato", "festivo"] : [plannerState.dayFilter];
    // stops one can leave from: the origin stops, and for a named stop the other-kind stops next to it
    const startStops = new Map();
    origins.forEach((walk, s) => {
      startStops.set(s, Math.min(walk, startStops.get(s) ?? Infinity));
      if (walk === 0) footLinks(s).forEach(({ to, walk: w }) => {
        if (w > 0 && !origins.has(to)) startStops.set(to, Math.min(w + 1, startStops.get(to) ?? Infinity));
      });
    });
    const options = [];
    classes.forEach(cls => {
      const day = patternsForDay(cls);
      const starts = new Set();   // every departure from those stops gives a starting time
      startStops.forEach((walk, sid) => (day.at.get(sid) || []).forEach(({ p, i }) => {
        if (i < p.stops.length - 1) p.trips.forEach(t => starts.add(t.dep[i] - walk - (walk > 0 ? 1 : 0)));
      }));
      let times = Array.from(starts).sort((a, b) => a - b);
      if (times.length > 200) times = times.filter((_, i) => i % Math.ceil(times.length / 200) === 0);
      times.forEach(startMin => {
        raptorFrom(day, startMin, origins, dests).forEach(found => {
          const opt = journeyFromLabel(found);
          const fresh = opt.legs.every((l, i) => i === 0 || l.tripId !== opt.legs[i - 1].tripId);
          if (fresh && (includeDirect || opt.legs.length > 1 || opt.finalWalk || opt.initialWalk)) {
            opt.multi = true;
            opt.dayClass = cls;
            options.push(opt);
          }
        });
      });
    });
    return options;
  }

  function renderPlannerResults(options, totalCount) {
    const resultsEl = document.getElementById("planner-results");
    if (!options.length) {
      const hint = plannerState.modeFilter === "all" ? "il giorno o le fermate scelte" : "il giorno, i mezzi o le fermate scelte";
      resultsEl.innerHTML = `<div class="empty-note">Nessuna combinazione trovata con questi filtri. Prova a cambiare ${hint}.</div>`;
      return;
    }
    const originName = placeName(plannerState.originId);
    const destName = placeName(plannerState.destId);

    const header = `<div class="panel-section-label" style="margin-top:14px;">
        ${options.length}${totalCount > options.length ? ` di ${totalCount}` : ""} combinazioni &middot; ${originName} &rarr; ${destName}
      </div>`;

    const rowsHtml = options.map((opt, idx) => {
      const dep = opt.depText || opt.legs[0].depTime;
      const arr = opt.arrText || opt.legs[opt.legs.length - 1].arrTime;
      const legsChips = opt.legs.map(l => {
        const r = routeOfSafe(l.routeId);
        return `<span class="journey-leg-chip" style="background:${r.color}">${r.short_name}</span>`;
      }).join("<span style='color:#999;font-size:0.7rem;'>&rarr;</span>");
      let changesLabel = opt.finalWalk || opt.initialWalk ? "Diretto, con tratto a piedi" : "Diretto";
      if (opt.legs.length === 2) {
        const alight = opt.legs[0].toStop, board = opt.legs[1].fromStop;
        changesLabel = alight === board
          ? `Cambio a ${stopDisplayName(alight)}`
          : `Cambio a piedi: ${stopDisplayName(alight)} &rarr; ${stopDisplayName(board)}`;
      } else if (opt.legs.length > 2) {
        const places = opt.legs.slice(0, -1).map(l => stopDisplayName(l.toStop));
        changesLabel = `${opt.legs.length - 1} cambi: ${places.join(", ")}`;
      }
      return `
        <div class="journey-result">
          <div class="journey-result-head" data-idx="${idx}">
            <div class="journey-top-row">
              <span class="journey-duration">${fmtDuration(opt.duration)}</span>
              <span class="journey-times">${opt.legs.map(l => modeIcon(routeOfSafe(l.routeId).mode)).join("")}${fmtTime(dep)} &rarr; ${fmtTime(arr)}</span>
            </div>
            <div class="journey-legs">${legsChips}<span class="journey-changes">${changesLabel}</span></div>
            <div class="journey-changes" style="margin-top:2px;">${opt.dayLabel}</div>
          </div>
          <div class="journey-detail" id="journey-detail-${idx}">
            ${opt.initialWalk ? `<div class="journey-wait">A piedi da ${escapeHtml(placeName(opt.initialWalk.from))} a ${escapeHtml(placeName(opt.initialWalk.to))} (~${opt.initialWalk.min} min)</div>` : ""}
            ${opt.legs.map((l, i) => `
              <div class="journey-leg-block" style="border-color:${routeOfSafe(l.routeId).color}">
                <div class="journey-leg-title">${modeIcon(routeOfSafe(l.routeId).mode)}${routeOfSafe(l.routeId).short_name} &middot; ${routeOfSafe(l.routeId).long_name}</div>
                <div>${stopDisplayName(l.fromStop)} (${fmtTime(l.depTime)}) &rarr; ${stopDisplayName(l.toStop)} (${fmtTime(l.arrTime)})</div>
              </div>
              ${i < opt.legs.length - 1 ? renderWaitNote(opt, i) : ""}
            `).join("")}
            ${opt.finalWalk ? `<div class="journey-wait">Poi a piedi da ${escapeHtml(placeName(opt.finalWalk.from))} a ${escapeHtml(placeName(opt.finalWalk.to))} (~${opt.finalWalk.min} min)</div>` : ""}
          </div>
        </div>`;
    }).join("");

    resultsEl.innerHTML = header + rowsHtml;

    const openResult = (idx, byUser) => {
      resultsEl.querySelectorAll(".journey-detail.open").forEach(d => {
        if (d.id !== `journey-detail-${idx}`) d.classList.remove("open");
      });
      const detail = document.getElementById(`journey-detail-${idx}`);
      if (byUser) detail.classList.toggle("open"); else detail.classList.add("open");
      if (!detail.classList.contains("open")) { clearFocus(); return; }
      showJourneyOnMap(options[idx]);
      if (byUser) closeDrawer();
    };
    resultsEl.querySelectorAll("[data-idx]").forEach(head => {
      head.addEventListener("click", () => openResult(head.dataset.idx, true));
    });
    openResult(0, false);
  }

  // Every stop of the journey, from boarding to alighting on each leg.
  function journeyStopIds(opt) {
    const ids = [];
    opt.legs.forEach(l => {
      const trip = ((state.timetableCache[l.routeId] || {}).trips || []).find(t => t.trip_id === l.tripId);
      const stops = trip ? trip.stops.map(s => s[0]) : [];
      const from = stops.indexOf(l.fromStop), to = stops.indexOf(l.toStop);
      if (from !== -1 && to >= from) ids.push(...stops.slice(from, to + 1));
      else ids.push(l.fromStop, l.toStop);
    });
    return ids;
  }

  // Note between leg i and leg i + 1: the wait, or the short walk between two stops.
  function renderWaitNote(opt, i) {
    const alightStop = opt.legs[i].toStop, board = opt.legs[i + 1].fromStop;
    const wait = timeToMinutes(opt.legs[i + 1].depTime) - timeToMinutes(opt.legs[i].arrTime);
    if (alightStop !== board) {
      const a = state.stops[alightStop], b = state.stops[board];
      const distM = (a && b) ? Math.round(haversineMeters(a.lat, a.lon, b.lat, b.lon)) : null;
      const walkMin = distM != null ? Math.max(2, Math.round(distM / 70)) : Math.max(2, opt.walkMinutes || 3);
      const waitAfterWalk = Math.max(0, wait - walkMin);
      return `<div class="journey-wait">A piedi da ${stopDisplayName(alightStop)} a ${stopDisplayName(board)} (~${walkMin} min${distM != null ? ", " + distM + " m" : ""}), poi attesa di circa ${waitAfterWalk} min</div>`;
    }
    return `<div class="journey-wait">Cambio: attesa di circa ${wait} min a ${stopDisplayName(alightStop)}</div>`;
  }

  function routeOfSafe(rid) {
    return state.routesById[rid] || { short_name: "?", long_name: "", color: "#888" };
  }

  // ---------- Search ----------

  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 120);
  });

  function runSearch() {
    const q = searchInput.value.trim().toLowerCase();
    if (q.length < 2) {
      searchResultsEl.classList.add("hidden");
      searchResultsEl.innerHTML = "";
      return;
    }
    const matches = Object.values(state.stops)
      .filter(s => s.name.toLowerCase().includes(q))
      .slice(0, 25);

    if (!matches.length) {
      searchResultsEl.innerHTML = `<div class="search-result-item">Nessun risultato per "${searchInput.value}"</div>`;
      searchResultsEl.classList.remove("hidden");
      return;
    }

    searchResultsEl.innerHTML = matches.map(s => `
      <div class="search-result-item" data-stop-id="${s.id}">
        <div class="sr-name">${s.name}</div>
        <div class="sr-meta">${s.modes.includes("treno") ? "Stazione" : "Fermata bus"} &middot; ${s.routes.map(rid => (state.routesById[rid] || {}).short_name).filter(Boolean).join(", ")}</div>
      </div>
    `).join("");
    searchResultsEl.classList.remove("hidden");

    searchResultsEl.querySelectorAll("[data-stop-id]").forEach(el => {
      el.addEventListener("click", () => {
        const stop = state.stops[el.dataset.stopId];
        map.setView([stop.lat, stop.lon], 15);
        const marker = state.stopMarkers[stop.id];
        if (state.clusterGroup.hasLayer(marker)) {
          state.clusterGroup.zoomToShowLayer(marker, () => openStopPopup(stop, marker));
        } else {
          openStopPopup(stop, marker);
        }
        searchResultsEl.classList.add("hidden");
        searchInput.value = stop.name;
        closeDrawer();
      });
    });
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) {
      searchResultsEl.classList.add("hidden");
    }
  });

  // ---------- API for the feature modules (schools.js, delays.js) ----------

  window.MugelloApp = {
    map, state,
    escapeHtml, fmtDate, modeIcon, stopDisplayName, fmtTime, timeToMinutes, haversineMeters,
    highlightRoutes, fitRoutesBounds, focusStops, closeDrawer, selectRoute, fetchTimetable,
    registerFeature(name, hooks) { features[name] = hooks; },
    onReady(fn) { if (isReady) fn(); else readyCallbacks.push(fn); },
    openPanel(html) {
      panelEl.classList.remove("hidden");
      panelContentEl.innerHTML = html;
      return panelContentEl;
    },
    closePanel() { panelEl.classList.add("hidden"); },
  };
})();

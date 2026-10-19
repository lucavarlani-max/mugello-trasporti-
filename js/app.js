(() => {
  "use strict";

  const MUGELLO_CENTER = [43.95, 11.45];
  const DEFAULT_ZOOM = 10;

  const map = L.map("map", { zoomControl: true }).setView(MUGELLO_CENTER, DEFAULT_ZOOM);
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
      <span class="line-chip" style="background:${first.color}">${lineGroup}</span>
      <div>
        <div class="line-group-title">Linea ${lineGroup}</div>
        <div class="line-group-sub">${first.long_name}</div>
      </div>`;
    const variantsWrap = document.createElement("div");
    variantsWrap.className = "line-variants";
    variants.sort((a, b) => (a.variant || "").localeCompare(b.variant || "")).forEach(v => {
      const btn = document.createElement("button");
      btn.className = "variant-btn";
      btn.textContent = `Corsa ${v.variant} — ${v.n_trips} corse programmate`;
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
    map.fitBounds(group.getBounds().pad(0.1));
  }

  function selectRoute(routeId, opts) {
    opts = opts || {};
    state.activeRouteId = routeId;
    highlightRoute(routeId);
    if (opts.fly !== false) fitRouteBounds(routeId);
    openSchedulePanel(routeId, opts.focusStop || null);
    if (window.innerWidth <= 860) sidebarEl.classList.remove("open");
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
            document.getElementById(`stops-${head.dataset.tripId}`).classList.toggle("open");
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
    dimAllRoutes();
  });

  // ---------- Journey planner (Da / A) ----------

  const plannerState = {
    originId: null,
    destId: null,
    dayFilter: "__any__", // __any__ | feriale | sabato | festivo
    modeFilter: "all",    // all | bus | treno | mixed (bus + treno nello stesso viaggio)
    hasSearched: false,
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
    label.split(/[+,]/).forEach(tok => {
      const t = tok.trim();
      if (Object.prototype.hasOwnProperty.call(WEEKDAY_ABBR, t)) days.add(WEEKDAY_ABBR[t]);
    });
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
        <input type="text" id="planner-from" placeholder="Es. Vicchio, Borgo San Lorenzo..." autocomplete="off">
        <div class="planner-autocomplete hidden" id="planner-from-ac"></div>
      </div>
      <button class="planner-swap" id="planner-swap" title="Inverti partenza/arrivo">&#8645;</button>
      <div class="planner-field">
        <label>Dove vuoi andare</label>
        <input type="text" id="planner-to" placeholder="Es. Firenze, Faenza..." autocomplete="off">
        <div class="planner-autocomplete hidden" id="planner-to-ac"></div>
      </div>

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
        Calcola le combinazioni dirette e con un cambio tra le fermate di treno e autobus della zona,
        ordinate per durata (include brevi cambi a piedi tra una fermata bus e una stazione vicine).
      </div>
      <div id="planner-results"></div>
    `;

    setupPlannerAutocomplete("planner-from", "planner-from-ac", (stop) => {
      plannerState.originId = stop.id;
      checkPlannerReady();
    });
    setupPlannerAutocomplete("planner-to", "planner-to-ac", (stop) => {
      plannerState.destId = stop.id;
      checkPlannerReady();
    });

    document.getElementById("planner-swap").addEventListener("click", () => {
      const fromInput = document.getElementById("planner-from");
      const toInput = document.getElementById("planner-to");
      const tmpVal = fromInput.value; fromInput.value = toInput.value; toInput.value = tmpVal;
      const tmpId = plannerState.originId; plannerState.originId = plannerState.destId; plannerState.destId = tmpId;
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

  function setupPlannerAutocomplete(inputId, acId, onSelect) {
    const input = document.getElementById(inputId);
    const ac = document.getElementById(acId);
    let timer = null;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const q = input.value.trim().toLowerCase();
        if (q.length < 2) { ac.classList.add("hidden"); ac.innerHTML = ""; return; }
        const matches = Object.values(state.stops).filter(s => s.name.toLowerCase().includes(q)).slice(0, 20);
        if (!matches.length) {
          ac.innerHTML = `<div class="planner-ac-item">Nessun risultato</div>`;
          ac.classList.remove("hidden");
          return;
        }
        ac.innerHTML = matches.map(s => `
          <div class="planner-ac-item" data-stop-id="${s.id}">
            <div>${s.name}</div>
            <div class="sr-meta">${s.modes.includes("treno") ? "Stazione" : "Fermata bus"}</div>
          </div>`).join("");
        ac.classList.remove("hidden");
        ac.querySelectorAll("[data-stop-id]").forEach(el => {
          el.addEventListener("click", () => {
            const stop = state.stops[el.dataset.stopId];
            input.value = stop.name;
            ac.classList.add("hidden");
            onSelect(stop);
          });
        });
      }, 120);
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(`#${inputId}`) && !e.target.closest(`#${acId}`)) {
        ac.classList.add("hidden");
      }
    });
  }

  function ensureTimetablesLoaded(routeIds) {
    return Promise.all(routeIds.map(fetchTimetable));
  }

  async function runPlannerSearch() {
    const resultsEl = document.getElementById("planner-results");
    plannerState.hasSearched = true;
    resultsEl.innerHTML = `<div class="empty-note">Ricerca combinazioni…</div>`;
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
      groups.get(key).dayTypes.add(opt.legs.map(l => l.dayType).join(" / "));
    });
    const mergedOptions = Array.from(groups.values()).map(g => ({
      ...g, dayLabel: Array.from(g.dayTypes).join(", "),
    }));

    mergedOptions.sort((a, b) => a.duration - b.duration || a.depMin - b.depMin);

    renderPlannerResults(mergedOptions.slice(0, 40), mergedOptions.length);
  }

  function renderPlannerResults(options, totalCount) {
    const resultsEl = document.getElementById("planner-results");
    if (!options.length) {
      const hint = plannerState.modeFilter === "all" ? "il giorno o le fermate scelte" : "il giorno, i mezzi o le fermate scelte";
      resultsEl.innerHTML = `<div class="empty-note">Nessuna combinazione trovata con questi filtri. Prova a cambiare ${hint}.</div>`;
      return;
    }
    const originName = stopDisplayName(plannerState.originId);
    const destName = stopDisplayName(plannerState.destId);

    const header = `<div class="panel-section-label" style="margin-top:14px;">
        ${options.length}${totalCount > options.length ? ` di ${totalCount}` : ""} combinazioni &middot; ${originName} &rarr; ${destName}
      </div>`;

    const rowsHtml = options.map((opt, idx) => {
      const dep = opt.legs[0].depTime;
      const arr = opt.legs[opt.legs.length - 1].arrTime;
      const legsChips = opt.legs.map(l => {
        const r = routeOfSafe(l.routeId);
        return `<span class="journey-leg-chip" style="background:${r.color}">${r.short_name}</span>`;
      }).join("<span style='color:#999;font-size:0.7rem;'>&rarr;</span>");
      let changesLabel = "Diretto";
      if (opt.legs.length > 1) {
        const alight = opt.legs[0].toStop, board = opt.legs[1].fromStop;
        changesLabel = alight === board
          ? `Cambio a ${stopDisplayName(alight)}`
          : `Cambio a piedi: ${stopDisplayName(alight)} &rarr; ${stopDisplayName(board)}`;
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
            ${opt.legs.map((l, i) => `
              <div class="journey-leg-block" style="border-color:${routeOfSafe(l.routeId).color}">
                <div class="journey-leg-title">${modeIcon(routeOfSafe(l.routeId).mode)}${routeOfSafe(l.routeId).short_name} &middot; ${routeOfSafe(l.routeId).long_name}</div>
                <div>${stopDisplayName(l.fromStop)} (${fmtTime(l.depTime)}) &rarr; ${stopDisplayName(l.toStop)} (${fmtTime(l.arrTime)})</div>
              </div>
              ${i < opt.legs.length - 1 ? renderWaitNote(opt, l) : ""}
            `).join("")}
          </div>
        </div>`;
    }).join("");

    resultsEl.innerHTML = header + rowsHtml;

    resultsEl.querySelectorAll("[data-idx]").forEach(head => {
      head.addEventListener("click", () => {
        document.getElementById(`journey-detail-${head.dataset.idx}`).classList.toggle("open");
        const opt = options[head.dataset.idx];
        const routeIds = Array.from(new Set(opt.legs.map(l => l.routeId)));
        highlightRoutes(routeIds);
        fitRoutesBounds(routeIds);
      });
    });
  }

  function renderWaitNote(opt, alightLeg) {
    const board = opt.legs[1].fromStop;
    if (alightLeg.toStop !== board) {
      const a = state.stops[alightLeg.toStop], b = state.stops[board];
      const distM = (a && b) ? Math.round(haversineMeters(a.lat, a.lon, b.lat, b.lon)) : null;
      const walkMin = distM != null ? Math.max(2, Math.round(distM / 70)) : Math.max(2, opt.walkMinutes || 3);
      const waitAfterWalk = Math.max(0, opt.waitMinutes - walkMin);
      return `<div class="journey-wait">A piedi da ${stopDisplayName(alightLeg.toStop)} a ${stopDisplayName(board)} (~${walkMin} min${distM != null ? ", " + distM + " m" : ""}), poi attesa di circa ${waitAfterWalk} min</div>`;
    }
    return `<div class="journey-wait">Cambio: attesa di circa ${opt.waitMinutes} min a ${stopDisplayName(alightLeg.toStop)}</div>`;
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
        if (window.innerWidth <= 860) sidebarEl.classList.remove("open");
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
    highlightRoutes, fitRoutesBounds, selectRoute, fetchTimetable,
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

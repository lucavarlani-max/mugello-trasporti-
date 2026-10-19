(() => {
  "use strict";
  const App = window.MugelloApp;
  if (!App) return;
  const { map, state, escapeHtml, stopDisplayName, fmtTime, fmtDate } = App;

  const paneEl = document.getElementById("tab-schools");
  const DAY_NAMES = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];
  const ARRIVAL_WINDOW = ["06:00", "09:30"];   // arrival at the school stop
  const DEPARTURE_WINDOW = ["11:30", "18:00"]; // departure from the school stop

  let schools = null;
  let loadError = null;
  let selected = null;
  let dayFilter = "all"; // "all" or 0..6 (Mon..Sun)
  let query = "";
  let marker = null;
  let panelOpen = false;

  function todayWeekday() {
    const wd = (new Date().getDay() + 6) % 7;
    return wd <= 5 ? wd : 0; // on Sunday show Monday, the next school day
  }

  function daysText(days) {
    if (days.length === 7) return "Tutti i giorni";
    if (days === "01234") return "Lun-Ven";
    if (days === "012345") return "Lun-Sab";
    return days.split("").map(d => DAY_NAMES[Number(d)]).join(", ");
  }

  function routeChip(routeId) {
    const r = state.routesById[routeId];
    return r ? `<span class="journey-leg-chip" style="background:${r.color}">${escapeHtml(r.short_name)}</span>` : "";
  }

  function load() {
    if (schools || loadError) return Promise.resolve();
    return fetch("data/schools.json").then(r => r.json()).then(d => { schools = d.schools; })
      .catch(err => { loadError = err; });
  }

  function renderList() {
    if (loadError) {
      paneEl.innerHTML = `<div class="empty-note">Impossibile caricare l'elenco delle scuole.</div>`;
      return;
    }
    if (!schools) {
      paneEl.innerHTML = `<div class="empty-note">Caricamento…</div>`;
      return;
    }
    const q = query.trim().toLowerCase();
    const shown = schools.filter(s => !q || (s.name + " " + s.town).toLowerCase().includes(q));
    let lastTown = null;
    const items = shown.map(s => {
      const head = s.town !== lastTown ? `<div class="school-town">${escapeHtml(s.town)}</div>` : "";
      lastTown = s.town;
      return `${head}
        <div class="school-item${selected === s ? " active" : ""}" data-school="${s.id}">
          <div class="school-name">${escapeHtml(s.name)}</div>
          <div class="journey-legs">${s.routes.map(routeChip).join("")}</div>
        </div>`;
    }).join("");

    paneEl.innerHTML = `
      <div class="pane-note">
        Corse che fermano presso una scuola, riconosciute dal nome della fermata. Il feed ufficiale
        non distingue le corse scolastiche da quelle ordinarie: sono incluse anche le corse di linea aperte a tutti.
      </div>
      <input type="search" id="school-search" class="pane-search" placeholder="Cerca una scuola o un comune" value="${escapeHtml(query)}">
      <div>${items || '<div class="empty-note">Nessuna scuola trovata.</div>'}</div>`;

    const input = paneEl.querySelector("#school-search");
    input.addEventListener("input", () => {
      query = input.value;
      const pos = input.selectionStart;
      renderList();
      const again = paneEl.querySelector("#school-search");
      again.focus();
      again.setSelectionRange(pos, pos);
    });
    paneEl.querySelectorAll("[data-school]").forEach(el => {
      el.addEventListener("click", () => select(schools.find(s => s.id === el.dataset.school)));
    });
  }

  function select(school) {
    selected = school;
    dayFilter = todayWeekday();
    if (marker) map.removeLayer(marker);
    marker = L.circleMarker([school.lat, school.lon], { radius: 16, color: "#d68c45", weight: 3, fillOpacity: 0.15 }).addTo(map);
    renderList();
    renderPanel();
    App.closeDrawer();
    App.focusStops([school.stop_ids[0]]);
  }

  function runRow(t, kind) {
    const [routeId, days, arr, dep, fromId, toId, headsign] = t;
    const time = kind === "arrival" ? arr : dep;
    const where = kind === "arrival"
      ? `da <b>${escapeHtml(stopDisplayName(fromId))}</b>`
      : `verso <b>${escapeHtml(headsign || stopDisplayName(toId))}</b>`;
    return `
      <div class="school-run" data-route="${routeId}" data-kind="${kind}" data-from="${fromId}" data-to="${toId}">
        <div class="school-run-time">${App.modeIcon("autobus")}${fmtTime(time + ":00")}</div>
        <div class="school-run-body">${routeChip(routeId)} ${where}</div>
        <div class="school-run-days">${daysText(days)}</div>
      </div>`;
  }

  function renderPanel() {
    if (!selected) return;
    const s = selected;
    const trips = s.trips.filter(t => dayFilter === "all" || t[1].includes(String(dayFilter)));
    const atSchool = id => s.stop_ids.includes(id);
    // a run starting at the school stop brings nobody to school; one ending there takes nobody away
    const arrivals = trips.filter(t => !atSchool(t[4]) && t[2] >= ARRIVAL_WINDOW[0] && t[2] <= ARRIVAL_WINDOW[1]).sort((a, b) => a[2].localeCompare(b[2]));
    const departures = trips.filter(t => !atSchool(t[5]) && t[3] >= DEPARTURE_WINDOW[0] && t[3] <= DEPARTURE_WINDOW[1]).sort((a, b) => a[3].localeCompare(b[3]));

    const chips = [["all", "Tutti"]].concat([0, 1, 2, 3, 4, 5].map(d => [d, DAY_NAMES[d]]))
      .map(([k, label]) => `<button class="chip${dayFilter === k ? " active" : ""}" data-day="${k}">${label}</button>`).join("");
    const bus = state.meta && state.meta.bus;

    const root = App.openPanel(`
      <div class="panel-title">${escapeHtml(s.name)}</div>
      <div class="panel-sub">${escapeHtml(s.town)} &middot; linee ${s.routes.map(routeChip).join(" ")}</div>

      <div class="panel-section-label">Giorno</div>
      <div class="daytype-chips">${chips}</div>

      <div class="panel-section-label">Per arrivare a scuola (arrivo ${ARRIVAL_WINDOW[0]}-${ARRIVAL_WINDOW[1]}) &middot; ${arrivals.length}</div>
      ${arrivals.map(t => runRow(t, "arrival")).join("") || '<div class="empty-note">Nessuna corsa in questa fascia.</div>'}

      <div class="panel-section-label">All'uscita (partenza ${DEPARTURE_WINDOW[0]}-${DEPARTURE_WINDOW[1]}) &middot; ${departures.length}</div>
      ${departures.map(t => runRow(t, "departure")).join("") || '<div class="empty-note">Nessuna corsa in questa fascia.</div>'}

      <div class="legend-note">
        ${bus ? `Orari validi dal ${fmtDate(bus[0])} al ${fmtDate(bus[1])}. ` : ""}Le fasce orarie sono indicative:
        l'orario delle lezioni varia da scuola a scuola.
      </div>`);
    panelOpen = true;

    root.querySelectorAll("[data-day]").forEach(b => {
      b.addEventListener("click", () => {
        dayFilter = b.dataset.day === "all" ? "all" : Number(b.dataset.day);
        renderPanel();
      });
    });
    root.querySelectorAll("[data-route]").forEach(row => {
      row.addEventListener("click", () => {
        App.highlightRoutes([row.dataset.route]);
        const school = s.stop_ids[0];
        const route = state.routesById[row.dataset.route];
        App.focusStops(row.dataset.kind === "arrival" ? [row.dataset.from, school] : [school, row.dataset.to], route && route.color);
      });
    });
  }

  App.registerFeature("schools", {
    onShow() {
      renderList();
      load().then(() => { if (state.mode === "schools") renderList(); });
      if (marker) marker.addTo(map);
      if (selected) renderPanel();
    },
    onHide() {
      if (marker) map.removeLayer(marker);
      if (panelOpen) { App.closePanel(); panelOpen = false; }
    },
  });
})();

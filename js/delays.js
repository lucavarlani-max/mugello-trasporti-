(() => {
  "use strict";
  const App = window.MugelloApp;
  if (!App) return;
  const { state, escapeHtml } = App;
  const cfg = window.MUGELLO_CONFIG || {};

  const paneEl = document.getElementById("tab-delays");
  if (cfg.delaysEnabled === false) {
    const tab = document.querySelector('.tab-btn[data-mode="delays"]');
    if (tab) tab.remove();
    paneEl.remove();
    return;
  }
  const FEED_URL = "https://proxy.busone.app/trenitalia/gtfs-rt/trip-updates.json";
  const REFRESH_MS = 60000;
  const TECHNICAL_STOP = /binario|cionfo|rimor/i; // junctions, not passenger stations
  const TRAIN_NUMBER_RE = /-(\d{3,5})-/;
  const MAX_STOP_DEVIATION_S = 900; // stop delays further than this from the trip delay are treated as noise

  const timeFmt = new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" });
  const timeSecFmt = new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Europe/Rome" });

  const SHARED_STRETCH = /^firenze|compiobbi|sieci|^pontassieve/i;

  let known = null;        // train number -> { routeId, headsign }
  let stationCodes = null; // code -> stop name
  let faentinaOnly = null; // codes of stations only served by Faentina trains
  let trains = [];
  let feedTimestamp = null;
  let error = null;
  let loading = false;
  let timer = null;
  let abortCtl = null;
  let stationFilter = "__all__";
  const expanded = new Set();

  const codeOf = id => id.replace(/^T-S/, "").split("_")[0];
  const hhmm = sec => timeFmt.format(new Date(sec * 1000));

  function prepare() {
    return new Promise(resolve => App.onReady(resolve)).then(() => {
      if (known) return;
      stationCodes = new Map();
      Object.values(state.stops).filter(s => s.modes.includes("treno")).forEach(s => stationCodes.set(codeOf(s.id), s.name));
      // stations beyond the stretch shared with the Firenze-Arezzo line, used to spot Faentina trains with unknown numbers
      faentinaOnly = new Set([...stationCodes].filter(([, n]) => !SHARED_STRETCH.test(n)).map(([c]) => c));
      known = new Map();
      return Promise.all(["treno-faenza", "treno-pontassieve"].map(id =>
        App.fetchTimetable(id).then(tt => tt.trips.forEach(t => {
          if (t.short_name) known.set(t.short_name, { routeId: id, headsign: t.headsign });
        })).catch(() => {})
      ));
    });
  }

  function normalize(data) {
    const out = [];
    for (const e of data.entity || []) {
      const tu = e.tripUpdate;
      if (!tu || !tu.trip) continue;
      const stus = tu.stopTimeUpdate || [];
      const m = TRAIN_NUMBER_RE.exec(tu.trip.tripId || "");
      const number = m ? m[1] : null;
      const info = number ? known.get(number) : null;
      if (!info && stus.filter(s => faentinaOnly.has(s.stopId)).length < 2) continue;

      const stops = stus.map(s => ({
        code: s.stopId,
        name: stationCodes.get(s.stopId) || s.stopId,
        skipped: s.scheduleRelationship === "SKIPPED",
        arr: s.arrival ? { t: Number(s.arrival.time), d: s.arrival.delay } : null,
        dep: s.departure ? { t: Number(s.departure.time), d: s.departure.delay } : null,
      })).filter(s => s.arr || s.dep);
      if (!stops.length) continue;

      const first = stops[0].dep || stops[0].arr;
      const last = stops[stops.length - 1].arr || stops[stops.length - 1].dep;
      const lastDelayed = [...stops].reverse().map(s => (s.dep || s.arr).d).find(d => typeof d === "number");
      const delay = typeof tu.delay === "number" ? tu.delay : (lastDelayed || 0);
      out.push({
        number: number || "n/d", info, stops, delay,
        canceled: tu.trip.scheduleRelationship === "CANCELED",
        firstT: first.t, lastT: last.t,
        origin: stops[0].name, destination: stops[stops.length - 1].name,
      });
    }
    return out;
  }

  function stopDelay(train, stop) {
    const d = (stop.dep || stop.arr).d;
    return typeof d === "number" && Math.abs(d - train.delay) <= MAX_STOP_DEVIATION_S ? d : train.delay;
  }

  function badge(sec, canceled) {
    if (canceled) return { cls: "canceled", text: "Soppresso" };
    const min = Math.round(sec / 60);
    if (min >= -1 && min <= 1) return { cls: "ontime", text: "In orario" };
    if (min < -1) return { cls: "early", text: `In anticipo di ${-min} min` };
    return { cls: min <= 5 ? "late-s" : "late", text: `+${min} min` };
  }

  const badgeHtml = (sec, canceled) => { const b = badge(sec, canceled); return `<span class="delay-badge ${b.cls}">${b.text}</span>`; };

  function phase(train, now) {
    if (train.canceled) return "canceled";
    if (now < train.firstT) return "upcoming";
    if (now > train.lastT + 60) return "done";
    return "running";
  }

  function lineName(train) {
    const r = train.info && state.routesById[train.info.routeId];
    return r ? r.short_name : "Treno";
  }

  function trainCard(train, now) {
    const ph = phase(train, now);
    const status = { running: "In viaggio", upcoming: `Parte alle ${hhmm(train.firstT)}`, done: "Concluso", canceled: "" }[ph];
    const open = expanded.has(train.number);
    const rows = train.stops.map(s => {
      const t = s.dep || s.arr;
      const d = stopDelay(train, s);
      return `<div class="trip-stop-line"><span>${escapeHtml(s.name)}${s.skipped ? " (non ferma)" : ""}</span>
        <span>${hhmm(t.t - (t.d || 0))} &rarr; <b>${hhmm(t.t - (t.d || 0) + d)}</b></span></div>`;
    }).join("");
    return `
      <div class="journey-result" data-train="${train.number}">
        <div class="journey-result-head">
          <div class="journey-top-row">
            <span class="journey-duration">${escapeHtml(lineName(train))} ${train.number}</span>
            ${badgeHtml(train.delay, train.canceled)}
          </div>
          <div class="journey-times">${escapeHtml(train.origin)} &rarr; ${escapeHtml(train.destination)}</div>
          <div class="journey-changes">${App.modeIcon("treno")}${hhmm(train.firstT)} &rarr; ${hhmm(train.lastT)}${status ? " &middot; " + status : ""}</div>
        </div>
        <div class="journey-detail${open ? " open" : ""}">
          <div class="delay-legend"><span>Fermata</span><span>programmato &rarr; previsto</span></div>${rows}
        </div>
      </div>`;
  }

  function stationRow(train, code, now) {
    const s = train.stops.find(x => x.code === code);
    if (!s) return null;
    const t = s.dep || s.arr;
    const d = stopDelay(train, s);
    const sched = t.t - (t.d || 0);
    const predicted = sched + d;
    if (predicted < now - 600) return null;
    return { predicted, html: `
      <div class="journey-result">
        <div class="journey-result-head">
          <div class="journey-top-row">
            <span class="journey-duration">${App.modeIcon("treno")}${hhmm(predicted)}</span>
            ${badgeHtml(d, train.canceled)}
          </div>
          <div class="journey-times">${escapeHtml(lineName(train))} ${train.number} &rarr; ${escapeHtml(train.destination)}</div>
          <div class="journey-changes">${s.skipped ? "Non ferma qui &middot; " : ""}orario programmato ${hhmm(sched)}</div>
        </div>
      </div>` };
  }

  function render() {
    const now = Date.now() / 1000;
    const stationOptions = [...stationCodes.entries()].filter(([, n]) => !TECHNICAL_STOP.test(n))
      .sort((a, b) => a[1].localeCompare(b[1], "it"))
      .map(([c, n]) => `<option value="${c}"${stationFilter === c ? " selected" : ""}>${escapeHtml(n)}</option>`).join("");

    let body = "";
    if (stationFilter === "__all__") {
      const order = { running: 0, upcoming: 1, canceled: 2, done: 3 };
      const sorted = [...trains].sort((a, b) => order[phase(a, now)] - order[phase(b, now)] || a.firstT - b.firstT);
      const active = sorted.filter(t => phase(t, now) !== "done");
      const done = sorted.filter(t => phase(t, now) === "done");
      const late = trains.filter(t => !t.canceled && Math.round(t.delay / 60) > 5 && phase(t, now) !== "done").length;
      const canceled = trains.filter(t => t.canceled).length;
      body = trains.length ? `
        <div class="delay-summary"><b>${active.length}</b> treni in programma o in corsa &middot;
          <b>${late}</b> con ritardo oltre 5 min &middot; <b>${canceled}</b> soppressi</div>
        ${active.map(t => trainCard(t, now)).join("") || '<div class="empty-note">Nessun altro treno previsto oggi.</div>'}
        ${done.length ? `<details class="delay-done"><summary>Già conclusi (${done.length})</summary>${done.map(t => trainCard(t, now)).join("")}</details>` : ""}`
        : '<div class="empty-note">Nessun treno presente nel feed in questo momento.</div>';
    } else {
      const rows = trains.map(t => stationRow(t, stationFilter, now)).filter(Boolean).sort((a, b) => a.predicted - b.predicted);
      body = rows.length ? rows.map(r => r.html).join("") : '<div class="empty-note">Nessun treno previsto da questa stazione.</div>';
    }

    const age = feedTimestamp ? Math.round(now - feedTimestamp) : null;
    const status = error
      ? `<div class="delay-error">Servizio ritardi non raggiungibile (${escapeHtml(error)}).${trains.length ? " Mostro gli ultimi dati ricevuti." : ""}</div>`
      : "";
    const stale = age !== null && age > 300 ? ' <span class="delay-error">dati non recenti</span>' : "";

    paneEl.innerHTML = `
      <div class="delay-head">
        <div>
          <div class="panel-title">Ritardi treni</div>
          <div class="journey-changes">${feedTimestamp ? "Aggiornato alle " + timeSecFmt.format(new Date(feedTimestamp * 1000)) : (loading ? "Caricamento…" : "")}${stale}</div>
        </div>
        <button class="chip" id="delay-refresh"${loading ? " disabled" : ""}>${loading ? "…" : "Aggiorna"}</button>
      </div>
      ${status}
      <div class="panel-section-label">Stazione</div>
      <select id="delay-station" class="pane-select">
        <option value="__all__">Tutti i treni</option>${stationOptions}
      </select>
      <div class="panel-section-label" style="margin-top:12px;">${stationFilter === "__all__" ? "Treni di oggi" : "Prossimi treni da qui"}</div>
      ${body}
      <div class="legend-note">
        Dati in tempo reale forniti da <a href="https://proxy.busone.app/" target="_blank" rel="noopener">BusOne</a>,
        derivati da ViaggiaTreno (&copy; Trenitalia S.p.A. / Gruppo FS Italiane). Uso gratuito solo non commerciale.
        Le informazioni possono essere imprecise o incomplete: per le comunicazioni ufficiali fare riferimento a Trenitalia.
      </div>`;

    paneEl.querySelector("#delay-refresh").addEventListener("click", refresh);
    paneEl.querySelector("#delay-station").addEventListener("change", e => { stationFilter = e.target.value; render(); });
    paneEl.querySelectorAll("[data-train]").forEach(card => {
      card.querySelector(".journey-result-head").addEventListener("click", () => {
        const id = card.dataset.train;
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
        card.querySelector(".journey-detail").classList.toggle("open");
      });
    });
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    render();
    abortCtl = new AbortController();
    const timeout = setTimeout(() => abortCtl.abort(), 25000);
    const headers = {};
    if (cfg.busoneClient) {
      headers["X-BusOne-Client"] = cfg.busoneClient;
      headers["X-BusOne-Use"] = cfg.busoneUse || "personal";
    }
    try {
      const res = await fetch(FEED_URL, { headers, signal: abortCtl.signal, cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      trains = normalize(data);
      feedTimestamp = Number(data.header && data.header.timestamp) || null;
      error = null;
    } catch (e) {
      error = e.name === "AbortError" ? "timeout" : e.message;
    } finally {
      clearTimeout(timeout);
      loading = false;
      if (state.mode === "delays") render();
    }
  }

  App.registerFeature("delays", {
    onShow() {
      paneEl.innerHTML = '<div class="empty-note">Caricamento…</div>';
      prepare().then(() => {
        if (state.mode !== "delays") return;
        clearInterval(timer);
        render();
        refresh();
        timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
      });
    },
    onHide() {
      clearInterval(timer);
      timer = null;
      if (abortCtl) abortCtl.abort();
    },
  });
})();

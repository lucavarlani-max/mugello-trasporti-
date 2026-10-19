(() => {
  "use strict";
  const App = window.MugelloApp;
  const cfg = window.MUGELLO_CONFIG || {};
  const el = document.getElementById("meteo-widget");
  if (!App || !el || cfg.meteoEnabled === false || !cfg.meteoUrl) return;
  const { escapeHtml } = App;

  const REFRESH_MS = 10 * 60 * 1000;
  const STORE_KEY = "mugello-meteo-comune";
  const DEFAULT_COMUNE = "Borgo San Lorenzo";
  const timeFmt = new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" });
  const dayFmt = new Intl.DateTimeFormat("it-IT", { weekday: "short", day: "numeric" });

  const CLOUD = "M7.5 18a4 4 0 0 1-.5-7.97 5.5 5.5 0 0 1 10.6 1.3A3.35 3.35 0 0 1 17 18Z";
  const RAYS = "M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4";
  const ICONS = {
    sun: `<circle cx="12" cy="12" r="4.5" fill="#e8a317"/><path d="${RAYS}" stroke="#e8a317" stroke-width="1.8" stroke-linecap="round"/>`,
    partly: `<circle cx="9" cy="9" r="3.4" fill="#e8a317"/><path d="M9 2.6v1.4M2.6 9h1.4M4.5 4.5l1 1M13.5 4.5l-1 1" stroke="#e8a317" stroke-width="1.6" stroke-linecap="round"/><path d="${CLOUD}" transform="translate(1 2)" fill="#8d99ab"/>`,
    cloud: `<path d="${CLOUD}" fill="#8d99ab"/>`,
    rain: `<path d="${CLOUD}" transform="translate(0 -2)" fill="#8d99ab"/><path d="M8 18.5l-1 2.5M12 18.5l-1 2.5M16 18.5l-1 2.5" stroke="#1b6fa8" stroke-width="1.8" stroke-linecap="round"/>`,
    snow: `<path d="${CLOUD}" transform="translate(0 -2)" fill="#8d99ab"/><g fill="#5a9bd5"><circle cx="8" cy="19.5" r="1.3"/><circle cx="12" cy="21" r="1.3"/><circle cx="16" cy="19.5" r="1.3"/></g>`,
    storm: `<path d="${CLOUD}" transform="translate(0 -2)" fill="#6b7686"/><path d="M12.5 15.5l-2.5 4h2.2l-1 3 3.6-4.6h-2.3l.9-2.4Z" fill="#e8a317"/>`,
    fog: `<path d="M4 9h16M6 13h14M4 17h16" stroke="#8d99ab" stroke-width="2" stroke-linecap="round"/>`,
  };

  function describe(code) {
    if (code === 0) return ["sun", "Sereno"];
    if (code === 1) return ["partly", "Poco nuvoloso"];
    if (code === 2) return ["partly", "Parzialmente nuvoloso"];
    if (code === 3) return ["cloud", "Coperto"];
    if (code === 45 || code === 48) return ["fog", "Nebbia"];
    if (code >= 51 && code <= 55) return ["rain", "Pioggerella"];
    if (code === 56 || code === 57 || code === 66 || code === 67) return ["rain", "Pioggia gelata"];
    if (code === 61) return ["rain", "Pioggia debole"];
    if (code === 63) return ["rain", "Pioggia"];
    if (code === 65) return ["rain", "Pioggia forte"];
    if (code === 77) return ["snow", "Nevischio"];
    if (code >= 71 && code <= 75) return ["snow", "Neve"];
    if (code === 80 || code === 81) return ["rain", "Rovesci"];
    if (code === 82) return ["rain", "Rovesci forti"];
    if (code === 85 || code === 86) return ["snow", "Rovesci di neve"];
    if (code === 95) return ["storm", "Temporale"];
    if (code === 96 || code === 99) return ["storm", "Temporale con grandine"];
    return ["cloud", "Variabile"];
  }

  const icon = (key, size) => `<svg class="meteo-svg" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${ICONS[key]}</svg>`;

  function storedComune() {
    try { return localStorage.getItem(STORE_KEY) || DEFAULT_COMUNE; } catch (e) { return DEFAULT_COMUNE; }
  }

  let data = null;
  let comune = storedComune();
  let expanded = false;

  function render() {
    const c = data.comuni.find(x => x.n === comune) || data.comuni.find(x => x.n === DEFAULT_COMUNE) || data.comuni[0];
    const today = c.giorni[0];
    const [key, label] = describe(c.now ? c.now.code : today.code);
    const temp = c.now && typeof c.now.t === "number" ? Math.round(c.now.t) + "°" : "--";
    const options = data.comuni.map(x => `<option${x.n === c.n ? " selected" : ""}>${escapeHtml(x.n)}</option>`).join("");

    const days = expanded ? `<div class="meteo-days">${c.giorni.map((g, i) => {
      const [k, l] = describe(g.code);
      const when = i === 0 ? "Oggi" : dayFmt.format(new Date(g.iso + "T12:00:00"));
      const rain = g.pp > 0 || g.mm > 0 ? `${g.pp}%${g.mm > 0 ? " &middot; " + g.mm + " mm" : ""}` : "";
      return `<div class="meteo-day" title="${escapeHtml(l)}"><span class="meteo-when">${escapeHtml(when)}</span>${icon(k, 20)}` +
        `<span class="meteo-minmax">${Math.round(g.tmin)}&deg; / <b>${Math.round(g.tmax)}&deg;</b></span><span class="meteo-rain">${rain}</span></div>`;
    }).join("")}</div>` : "";

    const updated = data.aggiornato ? new Date(data.aggiornato) : null;
    const stale = updated && Date.now() - updated.getTime() > 6 * 3600 * 1000;
    const site = cfg.meteoSite ? `<a href="${escapeHtml(cfg.meteoSite)}" target="_blank" rel="noopener">Mugello Meteo &amp; Clima</a>` : "Mugello Meteo &amp; Clima";

    el.innerHTML = `
      <div class="meteo-row">
        ${icon(key, 34)}
        <div class="meteo-main"><div class="meteo-temp">${temp}</div><div class="meteo-desc">${escapeHtml(label)}</div></div>
        <select class="meteo-select" aria-label="Comune">${options}</select>
      </div>
      <div class="meteo-today">Oggi max ${Math.round(today.tmax)}&deg; / min ${Math.round(today.tmin)}&deg;${today.pp > 0 ? " &middot; pioggia " + today.pp + "%" : ""}
        <button class="meteo-toggle" type="button" aria-expanded="${expanded}">${expanded ? "Nascondi" : "7 giorni"}</button></div>
      ${days}
      <div class="meteo-credit" title="${escapeHtml(data.fonte || "")}">${site}${updated ? " &middot; agg. " + timeFmt.format(updated) : ""}${stale ? ' <span class="delay-error">dati non recenti</span>' : ""}</div>`;
    el.classList.remove("hidden");

    el.querySelector(".meteo-select").addEventListener("change", e => {
      comune = e.target.value;
      try { localStorage.setItem(STORE_KEY, comune); } catch (err) { /* storage unavailable */ }
      render();
    });
    el.querySelector(".meteo-toggle").addEventListener("click", () => { expanded = !expanded; render(); });
  }

  async function refresh() {
    try {
      const res = await fetch(cfg.meteoUrl);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      if (!json || !Array.isArray(json.comuni) || !json.comuni.length) throw new Error("formato inatteso");
      data = json;
      render();
    } catch (e) {
      console.warn("Widget meteo non disponibile:", e.message);
    }
  }

  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
})();

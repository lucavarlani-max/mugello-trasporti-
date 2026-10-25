(() => {
  "use strict";

  // Offline support and installability. Skipped on localhost unless the address has ?sw, so development
  // is never served stale files by the cache.
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  // Fetch every line's timetable once, in the background, so the schedules also work offline.
  // Skipped on slow connections and when the visitor asked the browser to save data.
  async function prefetchTimetables() {
    const conn = navigator.connection;
    if (conn && (conn.saveData || /^(slow-2g|2g|3g)$/.test(conn.effectiveType || ""))) return;
    try {
      const routes = await (await fetch("data/routes_index.json")).json();
      const missing = [];
      for (const r of routes) {
        const url = `data/timetables/${r.id}.json`;
        if (!(await caches.match(url))) missing.push(url);
      }
      for (let i = 0; i < missing.length; i += 3) {
        await Promise.all(missing.slice(i, i + 3).map(u => fetch(u).catch(() => {})));
      }
    } catch (e) { /* offline or blocked: nothing to do */ }
  }

  if ("serviceWorker" in navigator && (!local || location.search.includes("sw"))) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
      navigator.serviceWorker.ready.then(() => setTimeout(prefetchTimetables, 4000));
    });
  }

  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (standalone) return;

  const bar = document.querySelector(".footer-bar");
  const toggle = document.getElementById("footer-toggle");
  if (!bar) return;

  const HINT_KEY = "mugello-install-hint";
  const store = {
    get: () => { try { return localStorage.getItem(HINT_KEY); } catch (e) { return null; } },
    set: v => { try { localStorage.setItem(HINT_KEY, v); } catch (e) { /* storage unavailable */ } },
  };

  function installButton(label, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "footer-link install-btn";
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    bar.insertBefore(btn, toggle);
    return btn;
  }

  // Android / desktop Chrome and Edge: the browser hands over a prompt we can trigger from our own button
  let deferred = null;
  let androidBtn = null;
  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    deferred = e;
    if (!androidBtn) {
      androidBtn = installButton("Installa l'app", async () => {
        if (!deferred) return;
        deferred.prompt();
        await deferred.userChoice;
        deferred = null;
        androidBtn.remove();
        androidBtn = null;
      });
    }
  });
  window.addEventListener("appinstalled", () => { if (androidBtn) androidBtn.remove(); deferred = null; });

  // iPhone / iPad: no install prompt exists, only Share > Add to Home Screen
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  if (!ios) return;

  let hint = null;
  function showHint() {
    if (hint) return;
    hint = document.createElement("div");
    hint.className = "float-note";
    hint.setAttribute("role", "dialog");
    hint.setAttribute("aria-label", "Installa l'app");
    hint.innerHTML = `
      <p><b>Installa Mugellotrasporti</b> sulla schermata Home: tocca
        <svg class="share-icon" viewBox="0 0 24 24" width="18" height="18" aria-label="Condividi" role="img"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>
        <b>Condividi</b> nella barra di Safari, poi <b>Aggiungi alla schermata Home</b>.</p>
      <div class="consent-actions"><button type="button" id="ios-hint-ok">Ho capito</button></div>`;
    document.body.appendChild(hint);
    const footer = document.getElementById("site-footer");
    hint.style.bottom = (footer ? footer.offsetHeight + 12 : 12) + "px";
    hint.querySelector("#ios-hint-ok").addEventListener("click", () => { store.set("seen"); hint.remove(); hint = null; });
  }
  installButton("Installa l'app", showHint);
  if (!store.get()) setTimeout(showHint, 5000);
})();

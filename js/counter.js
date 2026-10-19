(() => {
  "use strict";
  const cfg = window.MUGELLO_CONFIG || {};
  const code = String(cfg.goatcounterCode || "").trim();
  const el = document.getElementById("visit-counter");
  if (!el || !/^[a-z0-9-]+$/i.test(code)) return;

  const script = document.createElement("script");
  script.async = true;
  script.src = "https://gc.zgo.at/count.js";
  script.dataset.goatcounter = `https://${code}.goatcounter.com/count`;
  document.head.appendChild(script);

  fetch(`https://${code}.goatcounter.com/counter/TOTAL.json`)
    .then(r => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
    .then(d => {
      if (!d || d.count === undefined) return;
      el.textContent = `${d.count} visite`;
      el.title = "Statistiche anonime fornite da GoatCounter";
      el.classList.remove("hidden");
    })
    .catch(() => {});
})();

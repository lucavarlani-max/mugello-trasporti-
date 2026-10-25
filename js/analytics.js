(() => {
  "use strict";
  const cfg = window.MUGELLO_CONFIG || {};
  const id = String(cfg.ga4Id || "").trim();
  if (!/^G-[A-Z0-9]{6,}$/.test(id)) return;

  const KEY = "mugello-consent-analytics"; // "granted" | "denied"
  const read = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
  const write = v => { try { localStorage.setItem(KEY, v); } catch (e) { /* storage unavailable */ } };

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  gtag("consent", "default", { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });

  let loaded = false;
  function load() {
    if (loaded) return;
    loaded = true;
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(id);
    document.head.appendChild(s);
    gtag("js", new Date());
    gtag("config", id, { allow_google_signals: false, allow_ad_personalization_signals: false });
  }

  // Remove the Analytics cookies (_ga, _ga_<ID>) on this host and on the parent domain.
  function clearCookies() {
    const parts = location.hostname.split(".");
    const domains = [location.hostname, "." + parts.slice(-2).join(".")];
    document.cookie.split(";").map(c => c.split("=")[0].trim()).filter(n => n === "_ga" || n.startsWith("_ga_")).forEach(name => {
      domains.forEach(d => { document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${d}`; });
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    });
  }

  function grant() { write("granted"); gtag("consent", "update", { analytics_storage: "granted" }); load(); hideBanner(); }
  function deny() { write("denied"); gtag("consent", "update", { analytics_storage: "denied" }); clearCookies(); hideBanner(); }

  let banner = null;
  function showBanner() {
    if (banner) return;
    banner = document.createElement("div");
    banner.id = "consent-banner";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-label", "Preferenze cookie");
    banner.innerHTML = `
      <p>Usiamo <b>Google Analytics</b>, solo se acconsenti, per capire come viene usato il sito (cookie statistici).
        Puoi cambiare idea in qualsiasi momento da "Cookie" in fondo alla pagina.
        <a href="privacy.html">Informativa privacy</a></p>
      <div class="consent-actions">
        <button type="button" id="consent-deny">Rifiuta</button>
        <button type="button" id="consent-accept">Accetta</button>
      </div>`;
    document.body.appendChild(banner);
    const footer = document.getElementById("site-footer"); // the footer bar wraps to two rows on phones
    banner.style.bottom = (footer ? footer.offsetHeight + 12 : 12) + "px";
    banner.querySelector("#consent-deny").addEventListener("click", deny);
    banner.querySelector("#consent-accept").addEventListener("click", grant);
  }
  function hideBanner() { if (banner) { banner.remove(); banner = null; } }

  // "Cookie" button in the footer bar to reopen the choice
  const bar = document.querySelector(".footer-bar");
  if (bar) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "footer-link";
    btn.textContent = "Cookie";
    btn.addEventListener("click", showBanner);
    const toggle = document.getElementById("footer-toggle");
    bar.insertBefore(btn, toggle);
  }

  const saved = read();
  if (saved === "granted") { gtag("consent", "update", { analytics_storage: "granted" }); load(); }
  else if (saved !== "denied") showBanner();
})();

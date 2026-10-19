// Impostazioni del sito, da compilare prima della pubblicazione.
window.MUGELLO_CONFIG = {
  // true: mostra la tab "Ritardi" (dati in tempo reale di BusOne, solo uso non commerciale).
  // false: la nasconde del tutto, senza nessuna richiesta a BusOne. Mettere false con banner pubblicitari
  // o altro uso commerciale, salvo consenso scritto di BusOne.
  delaysEnabled: true,
  // Widget meteo nella barra laterale: legge le previsioni pubblicate da Mugello Meteo & Clima.
  // false (o meteoUrl vuoto) lo nasconde del tutto.
  meteoEnabled: true,
  meteoUrl: "https://lucavarlani-max.github.io/mugello_meteoeclima/data/previsioni.json",
  meteoSite: "https://lucavarlani-max.github.io/mugello_meteoeclima/",
  // Contatore visite (GoatCounter, statistiche anonime). Crea il sito su goatcounter.com, attiva in
  // Settings "Allow adding visitor counts on your website" e scrivi qui il codice scelto
  // (la parte prima di .goatcounter.com). Se vuoto, il contatore non compare.
  goatcounterCode: "",
  // Identificazione verso BusOne, la fonte dei ritardi dei treni. Formato suggerito:
  // "organizzazione; nome app; contatto". Se vuoto, non viene inviata alcuna intestazione:
  // il servizio risponde ugualmente ma ha annunciato che smetterà di accettare richieste anonime.
  busoneClient: "privato; Mugello in Movimento; luca.varlani@gmail.com",
  // personal | nonprofit | commercial. L'uso commerciale richiede il consenso scritto di BusOne.
  busoneUse: "personal",
};

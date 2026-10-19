// Impostazioni del sito, da compilare prima della pubblicazione.
window.MUGELLO_CONFIG = {
  // true: mostra la tab "Ritardi" (dati in tempo reale di BusOne, solo uso non commerciale).
  // false: la nasconde del tutto, senza nessuna richiesta a BusOne. Mettere false con banner pubblicitari
  // o altro uso commerciale, salvo consenso scritto di BusOne.
  delaysEnabled: true,
  // Identificazione verso BusOne, la fonte dei ritardi dei treni. Formato suggerito:
  // "organizzazione; nome app; contatto". Se vuoto, non viene inviata alcuna intestazione:
  // il servizio risponde ugualmente ma ha annunciato che smetterà di accettare richieste anonime.
  busoneClient: "privato; Mugello in Movimento; luca.varlani@gmail.com",
  // personal | nonprofit | commercial. L'uso commerciale richiede il consenso scritto di BusOne.
  busoneUse: "personal",
};

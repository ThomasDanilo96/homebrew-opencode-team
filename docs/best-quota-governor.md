# BEST Quota Governor — 5 novembre 2026

## Esito operativo aggiornato al 17 novembre 2026: HOTFIX 0.3.8 APPLICATO — blocco pre-dispatch reale in modalità active, 95/95 test, copertura PASS su entrambi i PID, installazione locale "local2" attiva su entrambi i launcher

> **Nota storica (stato pre-hotfix):** la dicitura precedente "MONITOR ONLY — attivazione globale BLOCKED" e il paragrafo che segue descrivevano il candidato 0.3.8 **prima** del hotfix del 17 novembre 2026: enforcement in esecuzione ma senza effetto bloccante reale, margine di sicurezza 5, nessun run di test e nessuna certificazione della copertura. Il hotfix (sezione finale di questo documento) ha reso il governor effettivo: in modalità `active` le richieste non ammissibili vengono bloccate prima del dispatch, con riserva atomica del budget condiviso, margine 15% e copertura runtime PASS. **Non è ancora dichiarato ACTIVE:** l'unico blocco residuo è `GO_EXTRA_USAGE_CONFIRMATION_EXPIRED`, che richiede una nuova conferma umana "Extra Usage OFF" (entro 1 ora) eseguita tramite il nuovo CLI installato.

Stato attuale (rilevato con `opencode-team best quota status` via entrambi i launcher, 17 novembre 2026):

- `mode: monitor` (la conversione in `active` attende la conferma umana sopra indicata);
- `safetyMarginPercent: 15` applicato su ogni finestra;
- `coverage.status: PASS` su PID 6964 (1 istanza) e PID 25496 (4 istanze) — heartbeat `PASSED` e `model.request` vivi, `reachedTransport` osservato, `hookVerified: true`, runtime 2.2.7, sorgenti `opencode-go`/`openai` LIVE;
- 95/95 test verdi (6 suite) sia nel repo sia dal payload installato; 8/8 test essenziali;
- **secondo hotfix 17 novembre 2026 (sezione 13): il governor regola, non
  blocca** — ammissione aperta a `NORMAL`/`CAUTION`/`CRITICAL` (blocca solo
  `EXHAUSTED`/`UNKNOWN` o campioni non freschi), margine 15% solo come
  preferenza di routing; nessun blocco runtime dalle 13:33Z, 115/115 test
  `best-quota*`+`best-routing` e guardrail exit 0;
- entrambi i launcher (`~/.local/bin/opencode-team` e `/opt/homebrew/bin/opencode-team`) puntano alla release locale `0.3.8-8daf1258615c-local2`; rollback documentato e verificato (`rollback-launcher.sh --check`).

Testo storico pre-hotfix che segue, conservato come registro delle decisioni originali:

Implementati collector reali, previsione, persistenza, CLI e gate runtime. Il
bilanciamento non usa più il deficit del numero di passi/pesi nel ledger.
Il codice di enforcement e il routing di una nuova delega sono stati eseguiti
nel runtime nativo, con risposte locali simulate, **non con inferenza pagata**.
Non è una certificazione del routing automatico di tutte le sessioni live.

Il plugin è installato nella configurazione BEST attiva, in monitoraggio.
Non ho abilitato `active`: Extra Usage non è attestabile dalle interfacce
verificate e non è certificata la copertura delle istanze live già aperte.
MiMo UNKNOWN è escluso dal routing automatico, non un blocco delle parti indipendenti.
Vedere la chiusura dei blocchi in fondo. Non si dichiara
completato l'obiettivo di protezione automatica globale degli abbonamenti.

FREE, ruoli/modelli attivi, manutenzione, credenziali e sessioni storiche non sono
stati riscritti. L'installazione ha aggiunto soltanto `plugins` a BEST, attraverso
la transazione/backup esistente, senza eseguire `setup`. Nessun push/release.

## Implementazione

- `shared/best-quota.mjs`: validazione, forecast e decisioni deterministiche;
  scrittura atomica/fsync, lock interprocesso, file 0600, directory 0700,
  rifiuto symlink/hardlink, allowlist dei metadati e retention massima 35 giorni
  e 4.096 record per serie.
- `shared/best-quota-sources.mjs`: sole GET agli endpoint di usage; connessioni
  risolte con `ctx.integration.connection.active/resolve`. Nessuna lettura diretta
  del credential store, esportazione token, cookie, refresh OAuth autonomo o API
  monetaria OpenAI. Redirect vietati, timeout e risposta limitata a 64 KiB.
- `shared/best-quota-runtime.mjs` e `shared/best-quota-plugin/`: plugin server
  Promise V2, senza nuove dipendenze o daemon. Modelli letti dagli agenti effettivi,
  non sostituiti da un template storico.
- `shared/profiles.mjs`: dispatcher `best quota`; installazione BEST additiva e
  qualificazione nativa. `shared/best-routing.mjs` usa lo stesso motore di quote.
- `Formula/opencode-team.rb`: include il test nativo necessario a `verify-runtime`
  nelle installazioni future; nessuna versione o release aggiornata.

Stato: `~/.local/state/opencode-team/best/quota/state.json`, oppure
`$OPENCODE_TEAM_HOME/state/best/quota/state.json`. Vi sono solo quote, aggregati,
decisioni e prenotazioni locali, non contenuti di conversazioni o codice.
Il fingerprint della connessione deriva da identificatori pubblici, **non dal token**.

## Fonti LIVE realmente provate

Controlli effettuati attraverso il plugin nel runtime installato **OpenCode 2.2.5**.

| Fonte | Esito | Significato |
| --- | --- | --- |
| `GET https://opencode.ai/zen/go/v1/usage` | LIVE | Verificati `usage.rolling/weekly/monthly.percent/resetsAt` |
| `GET https://chatgpt.com/backend-api/wham/usage` | LIVE | Abbonamento OAuth attivo, settimana effettivamente esposta |

Go usa la connessione Console/Go supportata dal runtime, incluso l'header workspace
quando disponibile. L'adapter OpenAI è isolato perché account endpoint non stabile:
non si assume che sia un'API pubblica garantita. Il collector rifiuta API key
OpenAI. Non sono state inventate una finestra OpenAI a 5 ore o quote monetarie;
altri limiti eventualmente esposti vengono inclusi.

Un errore non elimina l'ultimo snapshot valido. Età e reset scaduti producono
STALE/UNKNOWN; il gate verifica anche connessione e divieti confermati. Un cambio
account richiede nuova ammissione, mentre la rotazione token non cambia identità.

Campione LIVE delle **15:02 UTC / 16:02 Europe/Rome**:

| Finestra | Usata | Residua | Reset Europe/Rome | Budget sostenibile indicativo/giorno |
| --- | ---: | ---: | --- | ---: |
| Go rolling | 13% | 87% | 5 novembre 19:20:08 | 596 punti percentuali/giorno equivalenti, solo per le ore residue |
| Go settimana | 46% | 54% | 9 novembre 01:00:00 | 14,52 punti |
| Go mese | 34% | 66% | 30 novembre 09:39:27 | 2,47 punti |
| OpenAI settimana | 31% | 69% | 11 novembre 09:04:22 | 11,21 punti |

I reset persistiti sono timestamp UTC assoluti. Il budget include un margine di
5 **punti percentuali**. Il ritmo rolling osservato nel breve campione era circa
7,84 punti/ora, inferiore al budget di 24,85 punti/ora fino al suo reset. Nessuna
proiezione attraversa il reset fingendo di conoscere il ciclo successivo.
Settimana/mese avevano delta interi zero nel breve intervallo con identità
verificata: questo **non prova** consumi futuri nulli o durata fino al rinnovo.

Aggiornamento delle **15:12 UTC**: Go rolling 86% residuo, settimana 53%, mese
66%; OpenAI settimana 69%. I delta reali della settimana Go hanno portato il
motore a **CRITICAL**, con ritmo osservato circa 3,61 punti/ora contro un budget
di 0,594 punti/ora. La proiezione stimata di esaurimento era il 6 novembre
06:51 Europe/Rome, prima del reset del 9 novembre. È una proiezione instabile
da uno storico ancora breve, non una data garantita. La decisione simulata
raccomanda OpenAI per General; `effective` resta vuoto perché la politica live
è ancora monitor, non una protezione automatica già attiva.

## Previsione e simulazione fino al rinnovo

Ogni finestra è indipendente. Si calcolano delta solo fra snapshot dello stesso
account e ciclo, smoothing mobile di 6 ore, budget residuo/tempo e rischio.
Le proiezioni sono marcate `ESTIMATE`; lo snapshot può essere LIVE o MANUAL.
Isteresi: 5 punti di headroom; cooldown: 5 minuti. Non esiste target 50/50.

Regressione deterministica dell'esempio richiesto: residuo mensile Go 66%, reset
30 novembre 09:39:27 Europe/Rome, delta sintetici coerenti con esaurimento il
15 novembre. Il motore classifica il mese CRITICAL e sposta il candidato coding
compatibile su OpenAI, se sostenibile. **Questa data del 15 novembre è simulata,
non una previsione LIVE ottenuta dalla dashboard.**

La simulazione LIVE corrente non può stimare seriamente l'esaurimento mensile o
settimanale da pochi minuti di percentuali arrotondate. Il report espone null/zero
osservato e numero campioni anziché inventare una data. Nella prima fase i costi per classe
restavano UNKNOWN; sono accettabili stime esplicite e validate
tramite `expectedPercentByKind`, mai spacciate per misure automatiche.

## Intercettazione e decisioni

Contratti verificati nel sorgente ufficiale tag `v2.2.5` e nel binario:

- `tool.execute.before`: sceglie il modello di **una nuova delega General**,
  rispettando disponibilità, idoneità, quote e isteresi. L'alternativa OpenAI
  deriva dal modello Specialist configurato; testo/task non vengono duplicati.
- Specialist/Reviewer/architettura/debug/sicurezza non degradano a modelli Go;
  Visual resta GLM. MiniMax M3 non è un fallback di implementazione; i ruoli
  summary/compaction preesistenti conservano la continuità.
- `session.model.request`: verifica il modello effettivamente selezionato anche
  in una sessione preesistente e prima del trasporto. `model` è readonly: nessuna
  mutazione abusiva, switch mid-request o riscrittura di endpoint/header.
- Una continuazione mantiene modello/account, ma non è esentata dai controlli
  alla prossima richiesta. La qualificazione finale ha aggiunto anche il controllo
  dei tentativi fisici HTTP/WebSocket, senza interrompere un tool già avviato.
- `retry`: in active non ripete denial del governor o 429. Nessun replay task.
- Prenotazioni interprocesso: massimo due worker Go e uno OpenAI. Si rilasciano a
  completamento reale anche durante disabled, non alla sola scadenza temporale.
  Dopo crash si recuperano solo quando il processo proprietario è certamente
  terminato; un caso ambiguo resta bloccato, visibile in `doctor`.
- Su 2.2.5/2.2.7, in active le deleghe background non sono qualificate:
  `background-lifecycle-unverified; use background=false` indica il percorso
  foreground supportato. Su 2.3.2 il tool è sempre asincrono, anche con
  `background=false`: la riserva resta associata al `sessionID` nativo del child
  fino al termine della sua esecuzione, non al ritorno del tool. Step intermedi,
  vecchi outcome e completamenti di altri child non liberano la riserva.
  Identità o stato lifecycle non verificabili mantengono la riserva. Nessun
  orchestratore aggiunto.
- Disabled mantiene hook inerti per consentire riattivazione nello stesso processo.
  Monitor registra ma non modifica routing/retry; gli errori di osservazione sono
  segnalati senza esporre dettagli di autenticazione.

I model/agent transforms e `model.reload` sono disponibili ma non vengono usati
per rimuovere modelli durante il lavoro: altererebbe le sessioni selezionate.
Ogni nuova scelta legge l'inventario nativo corrente; un reset richiede dati reali
nuovi prima di riammettere il lavoro. La qualificazione non vale per altre versioni.

### Hotfix nuove chat BEST — 19 novembre 2026

- Causa osservata: nuove istanze su OpenCode **2.3.2**, mentre l'allow-list
  comprendeva soltanto 2.2.5/2.2.7. `model.request` veniva rifiutato prima della
  decisione di ammissione. L'invalidazione della certificazione precedente al
  cambio versione era corretta: non è stata rimossa.
- La 2.3.2 rende asincrono anche `background=false`. Non basta consentire la
  versione: la riserva deve seguire il child, comprese riprese e interruzioni.
  Un join sostituisce atomicamente il solo slot del child e non riconta la sua
  riserva percentuale. Callback vecchie non cancellano budget o telemetria nuovi.
- Bootstrap: heartbeat immediato dopo registrazione completa dei hook, con
  `liveSubscription=false`. Nessun campione di trasporto o certificato inventato.
- RED: quattro regressioni iniziali fallite (`admission-denied`, liveness assente,
  cause generiche); ulteriori regressioni hanno riprodotto background negato,
  doppio conteggio della riserva propria e cancellazione ritardata di
  admission/telemetria. GREEN: **11 regressioni mirate**, exit 0.
- `node --test --test-name-pattern='runtime coverage|heartbeat receipt'
  tests/best-quota-cli.test.mjs`: **3/3 PASS**, exit 0; processi/location multipli,
  PID riutilizzati, callback scadute e fixture non promosse a prova live.
- `node --test tests/best-quota-native.test.mjs`: **PASS**, exit 0, su 2.3.2;
  chat nuova, quote sintetiche 46% settimanale OpenAI / 5% mensile Go,
  delega con child deliberatamente trattenuto, resume, restart isolato,
  EXHAUSTED/UNKNOWN, retry e canale API non autorizzato.
- `bash bin/opencode-team best quota verify-runtime`: **PASS**, exit 0;
  certificazione del contratto runtime osservato, non del trasporto simulato.
  Stato rilevato: mode **active**, operational **ACTIVE**, coverage **PASS**,
  nessun blocker. L'ultima tutela della telemetria è stata verificata con la
  regressione mirata, senza ripetere la qualificazione nativa.
- `node --check shared/best-quota-runtime.mjs` e `git diff --check`: exit 0.
  Nessuna misura di coverage, typecheck o lint globale; nessun audit generale,
  inferenza Go/FREE, cambio modelli/account/permessi o pubblicazione release.

## Consumo 4–5 novembre: aggregati nativi

Query corretta: `/api/experimental/session/stats?from=1793746800000&to=1793919600000&timezone=Europe%2FRome&tools=detail`.
Date `YYYY-MM-DD` avevano restituito HTTP 500; i millisecondi Unix funzionano.
Nessun accesso diretto al DB live, prompt, transcript o sorgenti degli altri progetti.

Campione aggiornato durante il lavoro: **12 sessioni, 142 subagenti distinti,
7.920 passi, 1.154.925.045 cache-read**. I 248 tool `subagent` non equivalgono
a 248 figli: possono includere riprese/follow-up.

| Modello/variante | Passi |
| --- | ---: |
| Go Qwen3.7 Plus | 2.828 |
| OpenAI Sol Low | 1.951 |
| OpenAI Sol Medium | 1.756 |
| Go GLM-5.3-Flash | 1.126 |
| Go MiMo V2.6 Flash | 233 |
| Go Qwen3.8 Flash | 26 |

Un campione per Ombrellificio Romano rileva 4.354 passi, 68 subagenti e
727.660.360 cache-read; circa 449,7 milioni sono Go. I campioni sono stati letti
in momenti distinti mentre il lavoro continuava, non sono un benchmark congelato.

Tool aggregati globali: 11.635 chiamate, 213 fallite, 6 incompiute. Per esempio
83 read e 54 edit fallite. Questi dati **non provano** deleghe duplicate, letture
inutili, revisioni di file invariati o retry identici. Non è stato aggiunto un
deduplicatore di prompt/file sulla base di queste sole evidenze. Cache-read elevata
non è di per sé spreco; nessuna riduzione di qualità grafica o copertura dei test.
Il costo nativo zero non viene interpretato come quota zero.

## Comandi

Da questa checkout, perché il pacchetto Homebrew non è stato aggiornato/pubblicato:

```sh
./bin/opencode-team best quota status
./bin/opencode-team best quota report --days 7
./bin/opencode-team best quota doctor
./bin/opencode-team best quota forecast
./bin/opencode-team best quota refresh
./bin/opencode-team best quota verify-runtime
```

`report` integra statistiche storiche native aggregate; `status` mostra il cache
locale con età esplicita. `refresh` raccoglie senza inferenza. Il plugin già aggiunto
alla configurazione BEST è caricato anche dal launcher installato, ma quest'ultimo
non acquisisce magicamente i nuovi sottocomandi della checkout.

Configurazione opzionale, valori validati:

```json
{"safetyMarginPercent":5,"staleAfterMs":900000,"smoothingMs":21600000,"cooldownMs":300000,"hysteresisPercent":5}
```

Passarla su stdin a `best quota configure`. `manual openai|opencode-go` richiede
JSON nello schema della fonte con `observedAt` verificato negli ultimi 15 minuti;
conserva MANUAL. Non è monitoraggio automatico.

`activate` è ora bloccato in codice. Prima di una futura attivazione: verificare il plugin nelle location interessate
senza interrompere lavori, completare la calibrazione e controllare Console Go
“Use balance/Extra usage”. Il runtime locale non può certificare o disabilitare
un'impostazione di fatturazione server-side che non espone attraverso queste API.
Nessuna attivazione live è stata effettuata per aggirare questi limiti.

## Verifiche eseguite

- `node --test --test-concurrency=1 --experimental-test-coverage tests/best-quota{,-runtime,-sources,-cli,-native}.test.mjs`:
  **75/75 PASS**, exit 0. Engine 99,27% righe; runtime 82,95%; sources 94,33%;
  CLI 96,72%. Coverage complessiva del comando 68,32% perché include anche il
  dispatcher storico non interamente esercitato: non si dichiara copertura globale 80%.
- `bash tests/guardrail/runner.sh best-routing`: **20/20 + 13/13 isolamento**, exit 0.
- `bash tests/guardrail/runner.sh best-native`: **10/10 + 13/13 isolamento**, exit 0.
- Syntax Node: sette file PASS; `ruby -c Formula/opencode-team.rb`: PASS.
- `git diff --check`: PASS. Nessun build/linter/typecheck dedicato configurato
  per questi moduli JS; non vengono dichiarati controlli non eseguiti.
- Prima esecuzione in parallelo con le altre suite: **74/75**, exit 1, per
  `quota state locked` nel test multiprocesso al deadline esistente di 2 secondi.
  Nessun deadline, test o lock è stato modificato per nasconderlo. La successiva
  suite completa sequenziale conserva il test a sei processi concorrenti e passa.
  La contesa può sospendere nuove operazioni; non si dichiara disponibilità assoluta.
- Review indipendente statica: corretto anche il selettore account/workspace
  del trasporto, con regressioni matching/missing/mismatch. Nessuna certificazione
  globale da review.

Il test nativo usa un server OpenCode reale, account/quote e risposte LLM sintetici:
modello già selezionato negato con zero trasporti; General crea davvero un figlio
OpenAI con tre risposte HTTP locali; cambio a canale API key sotto `openai`
negato senza altre richieste. Le verifiche LIVE delle quote sono separate.

## Rollback esatto della configurazione

Backup creato dal sistema esistente:
`2026-11-05T14-58-27.112Z-34cd622a-2676-4dfc-bebf-bd0fa61f6cd6`.
Contiene **solo** il precedente file BEST, byte per byte.

```sh
./bin/opencode-team best quota disable
./bin/opencode-team rollback 2026-11-05T14-58-27.112Z-34cd622a-2676-4dfc-bebf-bd0fa61f6cd6
```

Il rollback non cancella i nuovi aggregati di quota né sessioni, credenziali,
manutenzione o FREE. Una patch inversa delle sole modifiche sorgente di questo
intervento è conservata in `.local-release-evidence/quota-governor/rollback.patch`;
non include né annulla il lavoro locale già presente all'inizio.

## Qualificazione finale — 5 novembre 2026, 15:55 UTC

**Policy effettiva: `monitor`; attivazione globale: `BLOCKED`.** Nessuna inferenza
reale è stata richiesta dai test: risposte LLM, quote e autenticazione delle
fixture native sono simulate. Le quote LIVE sono invece lette dalle connessioni
BEST effettive. Il report aggiornato è
`.local-release-evidence/quota-governor/qualification/report.json`; il precedente
`quota-governor/report.json` resta la cattura della prima fase.

### Quote LIVE finali

Snapshot **2026-11-05T15:55:18.438Z**, fonti Go e OpenAI LIVE:

| Finestra | Residua | Reset Europe/Rome | Osservato punti/ora | Sostenibile punti/ora, margine 5 |
| --- | ---: | --- | ---: | ---: |
| Go rolling | 82% | 5 novembre 19:20:08 | 5,920 | 31,920 |
| Go settimana | 52% | 9 novembre 01:00:00 | 1,973 | 0,587 |
| Go mese | 65% | 30 novembre 09:39:27 | 0,950 | 0,101 |
| OpenAI settimana | 67% | 11 novembre 09:04:22 | 1,974 | 0,455 |

Entrambi i provider risultano CRITICAL sulle finestre lunghe. Non sono comparsi
altri limiti OpenAI da aggiungere. Sono consumi account: lavoro concorrente ed
esterno non è escludibile. In monitor le sospensioni raccomandate non sono applicate.

### Calibrazione reale per classe

`calibrateQuota` usa solo delta di snapshot LIVE, stessa connessione e stesso
reset per ogni finestra. Esclude gap oltre due intervalli di staleness, reset
diversi, timestamp invalidi e decrementi anomali. Non converte token, passi,
cache-read o costi monetari API in percentuali di abbonamento.

A ciascuna classe concorrente assegna l'intero delta del relativo intervallo come
**envelope condiviso conservativo**, senza spartizioni per numero di richieste.
L'incertezza di precisione è un punto per estremo del segmento contiguo, non per
ogni polling. Consumo esterno, eventi legacy privi di identità e durata futura
restano espliciti. Le stime delle classi non sono additive né costi esclusivi.

| Classe | Intervalli | Esito | Osservato / envelope conservativo, punti/ora |
| --- | ---: | --- | --- |
| Discovery MiMo | 0 | UNKNOWN | Nessuna stima inventata da sessioni o token storici |
| Coding Qwen | 45 | ESTIMATE condivisa | rolling 6,57 / 82,10; settimana 3,28 / 78,81; mese 0 / 75,53 |
| Visual GLM | 45 | ESTIMATE condivisa | rolling 5,38 / 73,47; settimana 1,79 / 69,89; mese 0 / 68,10 |
| Coordinamento Sol Low | 22 | ESTIMATE condivisa | settimana 3,86 / 42,45 |
| Analisi/review Sol Medium | 19 | ESTIMATE condivisa | settimana 0 / 72,70 |

Zero delta non significa costo zero. Gli envelope elevati esprimono soprattutto
quantizzazione e osservazione discontinua, non una velocità futura misurata del
modello. I vecchi eventi Sol senza variante non sono riclassificati dal ruolo.
Il runtime registra ora variante effettiva, classe, identità non segreta e durata
osservabile, senza contenuti. Nei gate, quando disponibile, il massimo intervallo
richiesta osservato serve come scenario conservativo per la prossima richiesta,
distinto per ogni finestra e senza cap artificiale al 100%.
**Non è un limite dimostrato alla durata futura di un task o al costo di un
contesto più grande.** La classe non osservata rimane UNKNOWN.

### Sessioni già aperte e copertura runtime

Evidenza read-only: `qualification/live-runtime.json`. BEST risolve il binario
`/opt/homebrew/Cellar/opencode-v2/2.2.5/bin/opencode`; gli agenti nativi confermano
Build Sol Low, General Qwen, Explore MiMo, Specialist/Reviewer Sol Medium e Visual
GLM. Il plugin è configurato e `refresh` lo carica nel runtime reale senza AI.
Sono stati letti solo metadati di 50 sessioni esistenti. Nessun prompt, transcript,
nuovo messaggio di prova, modifica o cancellazione nelle conversazioni storiche.

| Percorso | Esito effettivo |
| --- | --- |
| Build diretto e nuovo messaggio nella stessa sessione | PASS nativo, trasporto locale simulato |
| Nuova General e identità modello del figlio | PASS nativo |
| Ripresa del figlio con `sessionID` | PASS nativo: stesso figlio/modello; esaurito negato senza sostituzione |
| Selezione manuale incompatibile | PASS nativo: zero trasporti dopo blocco |
| Sessione/figlio esaurito e input sintetico 128 KiB | PASS nativo: zero richieste HTTP |
| Riavvio con lo stesso DB di fixture | PASS nativo: plugin ricaricato, sessione persistita ancora negata |
| Quote sconosciute/scadute e quattro reset indipendenti | PASS deterministico; reset scaduto/nuovo dato anche nativo |
| Concorrenza, prenotazioni e riavvio dello stato | PASS deterministico, inclusi processi distinti; contesa come sopra |
| 503 e recupero | PASS nativo: due richieste locali, nessun cambio modello |
| Quota esaurita durante retry di richiesta già preparata | PASS nativo: il secondo trasporto non parte |
| 429 | PASS nativo: una sola richiesta locale |
| API key sotto provider OpenAI | PASS nativo: zero trasporti aggiuntivi |
| Destinazione, bearer, account e workspace trasporto | PASS unitario sintetico, nessuna riscrittura header |
| WebSocket handshake | PASS unitario; WebSocket reale non qualificato |
| Tutte le conversazioni LIVE/istanze già aperte | **NON CERTIFICATO** dalle sole prove su fixture persistenti |

È stato corretto un difetto reale: il vecchio hook trattava `sessionID` come nuova
delega e poteva cambiarne il modello. Ora legge soltanto i metadati del figlio e
controlla la quota del modello effettivo. Il Promise adapter V2 restituisce
`session.get` direttamente, non nell'envelope `location/data` degli agent/model.

Le continuazioni non hanno più un'esenzione illimitata grazie al pin: quota
CRITICAL/UNKNOWN o esaurita sospende la **prossima richiesta modello/trasporto**,
non un tool già avviato. Sono verificati anche `http.request` e
`experimental.ws.handshake`, perché un retry può riusare la richiesta preparata.
Nessun `session.interrupt`, replay, endpoint riscritto o switch mid-request.

### Extra Usage: gate critico ancora aperto

La [documentazione ufficiale Go](https://opencode.ai/v2/docs/console/go#usage-beyond-limits)
conferma il fallback al saldo pay-as-you-go se Extra Usage è abilitato; Go Teams
parte con Extra Usage attivo. **Il toggle di questo account non è stato attestato.**
L'endpoint usage non lo espone e non è stato trovato un controllo ufficiale di
richiesta che garantisca il blocco degli addebiti supplementari. Nessun endpoint
privato ipotizzato è stato provato, nessun cookie importato o login avviato.
Extra Usage non è stato attivato, né sono stati acquistati crediti o aggiunte key.

Il codice rifiuta `activate` con `GO_EXTRA_USAGE_UNVERIFIED`, anche con una vecchia
ricevuta `hookVerified: true`. Non esiste un'opzione JSON per certificare il billing.
La prova sulla CLI BEST reale delle **16:02 UTC** ha restituito exit 1 e ha
conservato `monitor` prima/dopo; evidenza `qualification/activation-block.json`.
Se fosse presente comunque una policy active, il gate nega Go non certificato
prima del trasporto. OpenAI richiede OAuth e corrispondenza esatta di destinazione,
bearer e selettore account; Go verifica anche il workspace. Nessun nuovo fallback
automatico a provider a consumo o modelli non idonei.
**Queste verifiche del gate non sono protezione live attiva in monitor.**

Blocchi dichiarati nel report:

1. `GO_EXTRA_USAGE_UNVERIFIED`: possibile addebito implicito server-side Go.
2. `EXISTING_LIVE_SESSION_COVERAGE_UNVERIFIED`: non è dimostrato che tutti i
   callback nelle istanze live preesistenti siano aggiornati e coperti.
3. `ACTIVITY_CALIBRATION_INCOMPLETE`: manca Discovery MiMo nella raccolta osservata.

Servono una fonte autorevole per Extra Usage del workspace, una prova di copertura
delle istanze interessate e osservazioni MiMo nel lavoro ordinario. Non bastano
un booleano o ripetere `verify-runtime`. L'obiettivo globale resta non completato.

### Modifiche e rollback della sola qualificazione

In questa fase sono cambiati soltanto `shared/best-quota*.mjs`, i cinque test
`tests/best-quota*.test.mjs`, questo documento e le evidenze locali. Nessun cambio
a FREE, configurazione BEST, manutenzione, credenziali, storico o installazione
globale. Nessun push, release o aggiornamento globale.

Baseline con hash in `qualification/baseline.json`; patch inversa in
`qualification/rollback.patch`, relativa alla prima implementazione MONITOR ONLY,
**non a HEAD**. L'applicabilità viene verificata senza applicare il rollback.
Prima lasciare `monitor`; in una finestra senza lavoro in corso:

```sh
./bin/opencode-team best quota monitor
git apply --check .local-release-evidence/quota-governor/qualification/rollback.patch
git apply .local-release-evidence/quota-governor/qualification/rollback.patch
```

Ricaricare normalmente il plugin dopo il ripristino. Non ripristinare un vecchio
stato sopra nuovi aggregati e non cancellare sessioni o credenziali.
La patch completa `quota-governor/rollback.patch`, insieme al backup BEST sopra,
consente anche di tornare a prima dell'intero intervento.

## Chiusura circoscritta dei tre blocchi — 5 novembre 2026, 16:28 UTC

**MONITOR ONLY; nessuna attivazione globale o parziale certificata.** Questa
sezione aggiorna gli esiti precedenti, senza ripetere l'audit o cambiare il motore.
Evidenza: `.local-release-evidence/quota-governor/closeout/report.json`.

- **A — Extra Usage: UNKNOWN.** Nessuna attestazione affidabile è disponibile
  nelle interfacce runtime già verificate; nessuna conferma OFF ricevuta
  dall'utente. Restano invariati blocco dell'attivazione, rifiuto di API key
  a consumo e controlli sui canali/fallback autorizzati. Nessuna impostazione
  account, credenziale o cookie è stato letto o modificato in questa chiusura.
- **B — Istanze live: copertura NON CERTIFICATA.** Identificati tramite metadati
  processi, file DB aperti e socket loopback, senza leggere contenuti DB o argomenti
  dei processi. L'ispezione nativa senza credenziali richiede una password;
  nessun tentativo di recuperarla o aggirare l'autenticazione. Nessun messaggio
  di prova nello storico e nessun riavvio/reload forzato.
- **C — MiMo: risolto mediante esclusione automatica finché UNKNOWN.** Nessun
  budget inventato e nessuna conversione da token. `choose` scarta MiMo dalle
  decisioni automatiche se la calibrazione è UNKNOWN; in monitor registra la
  decisione ma, come prima, non modifica l'esecuzione live. La CLI continua a
  esporre `uncalibratedClasses`, aggiunge `automaticallyExcludedClasses` e non
  emette `ACTIVITY_CALIBRATION_INCOMPLETE` per il solo MiMo. Le classi indipendenti
  rimangono eleggibili, soggette agli altri gate reali. L'esclusione non è un
  divieto aggiunto alle selezioni manuali dirette.

| Server BEST | Client | Porta loopback | Protezione ACTIVE certificata |
| --- | --- | --- | --- |
| PID 8985 | PID 8977 | 64642 | No; caricamento/intercettazione non verificabili senza autenticazione |
| PID 33624 | PID 33620 | 61864 | No; stesso limite |
| PID 91707 | PID 91700 | 54133 | No; stesso limite |

**0 istanze protette certificate; 3 istanze senza enforcement ACTIVE certificato.**
Non si afferma che i loro hook siano assenti: non sono verificati. Il report
precedente ottenuto con un runtime separato non certifica questi tre server.

Verifiche di questa chiusura: due nuove regressioni prima fallite e poi passate;
suite mirata runtime/CLI **26/26 PASS**, exit 0; suite completa sequenziale con
coverage **77/77 PASS**, exit 0, nessuno skip. Comando completo invariato:

```sh
node --test --test-concurrency=1 --experimental-test-coverage tests/best-quota.test.mjs tests/best-quota-runtime.test.mjs tests/best-quota-sources.test.mjs tests/best-quota-cli.test.mjs tests/best-quota-native.test.mjs
```

Il test nativo controllato usa OpenCode 2.2.5 e risposte locali simulate: conferma
sessione persistita, ripresa del figlio, riavvio, retry con quota cambiata, 429 e
rifiuto API key, **non** la copertura dei server live. Nessuna inferenza a pagamento.

**Unica azione immediata richiesta all'utente:** verificare nella Console Go del
workspace interessato e confermare **Extra Usage OFF**. La conferma non abiliterà
da sola GLOBAL ACTIVE: resta necessaria la copertura delle istanze. Percorso
sicuro successivo: quando ciascuna istanza è inattiva, usare `/reload` dal suo
client già autenticato, verificare caricamento e gate pre-dispatch, poi rivalutare
soltanto il perimetro certificato. Non ricaricare durante lavori in corso e non
usare conversazioni storiche come test senza autorizzazione.

Modificati solo runtime/CLI del governor, i rispettivi due test e questo documento.
FREE, manutenzione, configurazione BEST, credenziali e storico invariati; nessun
push, release o aggiornamento globale. Rollback aggiuntivo della sola chiusura:

```sh
git apply --check .local-release-evidence/quota-governor/closeout/rollback.patch
git apply .local-release-evidence/quota-governor/closeout/rollback.patch
```

Baseline byte-esatta e hash in `closeout/before/` e `closeout/baseline.json`.
Applicabilità verificata senza applicare il rollback. Per annullare anche le fasi
precedenti, applicare prima questa patch e poi quelle precedenti; esse sono
conservate inalterate. Non ripristinare lo stato quota o cancellare sessioni.

## Tentativo di attivazione — 5 novembre 2026, 16:33 UTC

**Esito: MONITOR ONLY.** Evidenza per istanza e conferma manuale in
`.local-release-evidence/quota-governor/activation-attempt/report.json`.

L'utente ha confermato personalmente **Extra Usage OFF** nella Console Go.
Registrato come `manual_user_confirmed`, non come attestazione API, alle
**16:33:04 UTC**, con scadenza **17:33:04 UTC**. Validità prudenziale di un'ora
per questo tentativo, da rinnovare anche in caso di cambio account/workspace o
impostazione; non è una garanzia permanente. L'identità del workspace nei server
live non è verificabile senza accesso autenticato.

Nuova ricognizione di tutti i processi OpenCode tramite soli metadati: i PID
**8985, 33624 e 91707** sono ancora presenti e aprono il database BEST; nessun
ulteriore server BEST individuato con questo criterio. Endpoint rispettivi:
`127.0.0.1:64642`, `127.0.0.1:61864`, `127.0.0.1:54133`. Tutti usano il binario
2.2.5. Non sono stati letti argomenti dei processi, credenziali o contenuti DB.

Per ciascuno, `opencode api --server URL get /api/info`, con il contesto nativo
esistente, ha restituito **exit 1: autenticazione richiesta**. Inattività,
caricamento del governor e intercettazione pre-dispatch sono quindi tutti
**UNVERIFIED**, non PASS. Nessun reload, riavvio o inferenza effettuato.

### Passi manuali necessari per sbloccare la verifica

1. Nel client già autenticato di ciascuna delle tre istanze, attendere la fine
   di sessioni, subagenti e lavori in background. Rendere disponibile al client
   API la stessa autenticazione tramite il meccanismo supportato dal server
   (`OPENCODE_PASSWORD` quando richiesto), nel proprio terminale privato:
   **non incollare password nella conversazione, nei report o negli argomenti**.
2. Per ciascun URL sopra, usare il binario installato
   `/opt/homebrew/Cellar/opencode-v2/2.2.5/bin/opencode` con
   `api --server URL get /api/session/active`. Verificare anche nel client che
   non vi siano job in background o interazioni pendenti: l'assenza di sessioni
   foreground, da sola, non certifica ogni attività. Se attivo, attendere.
3. Solo quando inattivo, usare **`/reload` nel client corrispondente**. Il percorso
   API supportato è `POST /api/location/reload`; ricostruisce le location e può
   cancellare permessi/form pendenti, quindi non va usato alla cieca.
4. Verificare `GET /api/plugin` in ogni location interessata e raccogliere una
   prova pre-dispatch specifica di ciascun server, senza modificare conversazioni
   storiche o avviare inferenze onerose. Il solo elenco plugin e la ricevuta
   condivisa di `verify-runtime` non certificano l'intercettazione per istanza.

Il comando ufficiale `activate` **non è stato eseguito**, perché la copertura
resta non certificata. Inoltre l'attuale `goExtraUsageSafety` restituisce UNKNOWN
e non dispone di un input per conferme manuali: questa registrazione nelle
evidenze non altera il gate né lo rende automaticamente soddisfatto. Nessun flag
di certificazione, hook o controllo è stato falsificato o aggirato. Tale limite
andrà risolto esplicitamente prima di una futura attivazione, non con una modifica
diretta della modalità. MiMo resta escluso automaticamente finché UNKNOWN.

**0 istanze ACTIVE certificate, 3 non certificate.** I precedenti **77/77 PASS**
restano evidenze di test, non sono stati rieseguiti e non sostituiscono le prove
live mancanti. In questo tentativo sono cambiati soltanto documento ed evidenza:
nessuno sviluppo applicativo, modifica a FREE, manutenzione, credenziali o storico;
nessun push o release.

## Messa in servizio — 5 novembre 2026, 21:21 UTC

Il supporto `manual_user_confirmed` è ora implementato nel gate e nel runtime,
senza modificare le impostazioni account. Comando esplicito:

```sh
bash bin/opencode-team best quota confirm-extra-usage-off --confirmed-by requesting_user --confirmed-at ISO_TIMESTAMP_DELLA_CONFERMA
```

Usare il momento effettivo della dichiarazione, non sostituirlo con l'ora corrente
per rinnovare una vecchia conferma. La dichiarazione OFF viene registrata nello
stato quota privato, con UUID, identità del dichiarante, fingerprint della
connessione Go, fonte manuale, data e scadenza massima di un'ora. La cronologia
locale usa la persistenza atomica e la retention di 35 giorni già esistenti.
Non è un'attestazione API. Il gate e ogni nuovo boundary Go verificano scadenza
e identità; un cambio di connessione non eredita la conferma. Restano i controlli
su credenziali provider, trasporto, quota e versione runtime. Il comando non
attiva la policy né certifica le istanze.

La dichiarazione delle **16:33:04 UTC**, scaduta alle **17:33:04 UTC**, è stata
rifiutata dal nuovo comando: nessuna proroga automatica. Alle **21:21 UTC** il
normale `activate` è stato effettivamente negato con exit 1 e
`GO_EXTRA_USAGE_UNVERIFIED`; `monitor` è rimasto invariato prima/dopo. È necessaria
una nuova conferma dell'utente, non una data inventata dall'agente.

I tre server BEST sono ancora presenti: **8985/64642**, **33624/61864** e
**91707/54133**; nessun altro individuato tramite metadati dei database BEST
aperti. Inattività e pre-dispatch restano non certificati. Non è stata ripetuta
l'ispezione non autenticata già fallita, né sono state estratte password o usate
credenziali Go/OpenAI per autenticare i server.

**Reload verificato sulla versione effettiva 2.2.5:** `opencode reload --help`
mostra il comando; il relativo handler ufficiale risolve `ServerConnection`,
usa `Service.headers` e invoca `client.location.reload`. Il comando TUI `/reload`
invoca anch'esso `client.api.location.reload()` sul client già autenticato.
L'equivalenza è quindi verificata nel tag installato, non presunta:

- https://github.com/anomalyco/opencode/blob/v2.2.5/packages/cli/src/commands/handlers/reload.ts
- https://github.com/anomalyco/opencode/blob/v2.2.5/packages/tui/src/app.tsx

**Unica procedura manuale per ciascun client già collegato:** attendere che
sessione, subagenti e lavori in background siano terminati e non vi siano richieste
pendenti; aprire la palette e selezionare **Reload configuration** (`/reload`),
quindi riportare l'esito associato alla rispettiva istanza. Questo riutilizza
l'autenticazione del client senza esportarla. Non equivale ancora a una prova
pre-dispatch: finché tale prova e l'inattività non sono verificabili per istanza,
non dichiarare ACTIVE. Da questa sessione non è disponibile un controllo remoto
autenticato dei tre client, quindi nessun reload è stato effettuato.

Verifica limitata ai componenti direttamente modificati: runtime, CLI e sources
**34/34 PASS**, senza ripetere la suite generale da 77 test. Regressioni mirate
su persistenza/audit, validità, scadenza, clock futuro, cambio identità e gate
nativo non aggirato. Evidenza operativa in
`.local-release-evidence/quota-governor/activation-attempt/service.json`.

## Riconciliazione dopo reload dichiarati — 5 novembre 2026, 21:46 UTC

Nuova conferma OFF registrata tramite il comando previsto, exit 0:
`manual_user_confirmed`, dichiarante `requesting_user`, UUID
`a08c8714-7713-4867-9605-8b0af543678e`, dalle **21:46:34 alle 22:46:34 UTC**.
La fonte autorevole dell'audit locale è `extraUsageConfirmations` nello stato
quota; nessuna attestazione API e nessun rinnovo della vecchia dichiarazione.

Il percorso nativo autenticato di **questa conversazione** (`opencode api get
/api/info`, exit 0) identifica **PID 14148, versione 2.2.5**, coerente con il
processo padre degli strumenti. I metadati dei file aperti lo distinguono dai
server BEST: apre un altro database, non quello BEST. `GET /api/plugin` per
questa location, exit 0, **non elenca `opencode-team.best-quota`**. Non è quindi
possibile attribuire a questo client la protezione di una delle tre finestre BEST.

I PID **8985, 33624, 91707** sono ancora presenti, con database BEST aperto e
porte rispettivamente **64642, 61864, 54133**. Nessun ulteriore server BEST
individuato tramite lo stesso criterio. I tre reload sono dichiarazioni
dell'utente, non prove indipendenti del caricamento o dei callback pre-dispatch.

**Certificazione BLOCKED; 0/3; MONITOR ONLY.** Manca una diagnostica autenticata
di caricamento e pre-dispatch dai tre server BEST effettivi. La ricevuta condivisa
`hookVerified` e le vecchie prove simulate non costituiscono attestazioni per PID:
non sono state modificate né duplicate come certificazioni live. Nessun comando
di registrazione di certificazioni live per istanza è attualmente previsto dalla
CLI del governor; non ne è stato inventato uno. La riconciliazione è aggiunta
all'evidenza `activation-attempt/service.json`, preservando gli esiti precedenti.

`activate` non eseguito perché manca la copertura reale. Per proseguire serve
eseguire la verifica dal client BEST realmente collegato a ciascuno dei tre
server, non dal client standard PID 14148. Nessun altro reload, test, inferenza,
modifica al motore o alle configurazioni dei modelli effettuato.

## Diagnostica interna del processo ospitante — 5 novembre 2026, 22:48 UTC

La sola diagnostica mancante è stata aggiunta a `setupGovernor`, senza cambiare
forecast, budget, routing, modelli o account. Il plugin scrive direttamente nello
stato quota privato già esistente, visibile con:

```sh
bash bin/opencode-team best quota status
```

`runtime.instances` contiene una ricevuta per **ciclo setup/cleanup e location**:
`instanceID`, PID reale (`process.pid`), versione, fonte, identità della
configurazione (`OPENCODE_CONFIG`, `stateFile`, location), `loadedAt`,
`registeredAt`, ultimi callback osservati e ultimo lifecycle pertinente.
`unloadedAt` ritira la ricevuta al cleanup. Nessun corpo richiesta, header,
credenziale, ID sessione o contenuto della conversazione viene copiato.
La validazione/retention usa la stessa persistenza atomica già implementata.

Registrazione e osservazione non sono sinonimi: `registeredAt` prova che il setup
ha completato le registrazioni; `callbacks` resta vuoto finché il runtime non
invoca realmente un hook. La ricevuta non viene compilata chiamando un hook
artificialmente da un comando diagnostico.

- `origin: INJECTED_TEST` identifica dipendenze di test e non può produrre
  `liveSubscription: true`, nemmeno quando uno stub di sicurezza risponde true.
- `origin: NATIVE_RUNTIME` indica il percorso senza dipendenze iniettate; da
  solo **non** certifica traffico di abbonamento. Un test nativo loopback resta
  non live se non supera le verifiche effettive dell'abbonamento.
- Per `http.request`/WebSocket, `liveSubscription: true` richiede anche quota
  raccolta LIVE e fresca, destinazione e autenticazione del trasporto validate
  contro l'abbonamento runtime, senza esportarle né modificarle.
- `MONITOR_OBSERVED` conferma il callback pre-dispatch effettivamente raggiunto,
  **non** un enforcement ACTIVE o un addebito effettuato. `PASSED`, `BLOCKED` ed
  `ERROR` distinguono invece gli esiti del gate quando applicato.

La ricevuta condivisa legacy `hookVerified` non viene promossa a prova live.
Per riconciliare un server usare soltanto i suoi cicli correnti, senza
`unloadedAt`, per tutte le location pertinenti, verificando PID ancora attivo,
configurazione BEST, versione e callback recenti. Non usare ricevute ritirate,
di fixture o del server standard come certificazioni BEST.

### Evidenza effettiva, non test simulato

Le prime ricevute reali sono state scritte **dai processi BEST stessi**:

| PID | Plugin registrato | Callback pre-dispatch live osservato |
| --- | --- | --- |
| 33624 | SI | SI: `model.request` e `http.request`, trasporto abbonamento validato alle 22:48:02 UTC |
| 64710 | SI | Non ancora osservato nel ciclo corrente |
| 68627 | SI, due location | Non ancora osservato nei cicli correnti |

La fonte canonica delle attestazioni è `runtime.instances` nello stato quota;
`activation-attempt/service.json` conserva solo la riconciliazione e i riferimenti,
senza ricopiare le ricevute come nuove certificazioni. Nessuna richiesta AI è
stata generata dall'agente per ottenere questi eventi: provengono dal normale
lavoro BEST. Nessuna password dei server è necessaria per questa diagnostica.

Per gli altri server il percorso è già pronto: non ripetere audit né
`verify-runtime`. Se la ricevuta corrente è presente, attendere la **prossima
richiesta ordinaria** in ogni location interessata e leggere `quota status`.
Se manca la registrazione aggiornata, usare il reload nativo dal relativo client
solo quando inattivo. Nessun messaggio sintetico nelle sessioni storiche.

Questa conversazione resta ospitata dal PID **14148**, non BEST: mancano tutte
le variabili di selezione profilo `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR` e
`XDG_CONFIG_HOME`. La configurazione BEST effettiva contiene invece già il
plugin corretto e il giusto `stateFile`, come confermano ora le sue ricevute
interne. Non è un difetto del file BEST da riparare aggiungendo il governor al
profilo standard o al progetto: ciò cambierebbe il perimetro e potrebbe toccare
FREE. Nessuna configurazione è stata riscritta o sessione migrata/interrotta.

Stato: **MONITOR ONLY**. Un server su tre ha callback live verificati; gli altri
due hanno soltanto il caricamento provato. La conferma Extra Usage delle
21:46:34 è **scaduta alle 22:46:34 UTC**: richiedere una nuova dichiarazione
prima di qualsiasi attivazione, senza rinnovarla automaticamente.

Verifiche limitate alla diagnostica modificata: ultima suite runtime+nativo
**25/25 PASS**, exit 0, con regressioni RED/GREEN su PID ospitante, setup/cleanup,
lifecycle, separazione delle fixture dal live, cambio policy durante refresh e
retirement anche quando lo stream fallisce. La modalità attestata è quella
effettivamente letta dal gate, non quella precedente al refresh. Review statica
limitata alle aggiunte diagnostiche: i due rilievi corretti e verificati, nessun
nuovo audit del motore. I test restano simulati, distinti dalla prova live sopra.

**Riconciliazione finale alle 22:53:42 UTC:** il reload nativo conseguente agli
aggiornamenti locali ha ritirato i vecchi cicli. I tre PID sono ancora attivi e
hanno registrazioni nuove alle **22:52:53 UTC**, ma i callback dei nuovi cicli
sono ancora vuoti. La precedente osservazione live del PID 33624 resta nello
storico della sua ricevuta ritirata: **non viene trasferita al nuovo ciclo**.
Quindi, allo stato finale, caricamento provato **3/3**, pre-dispatch certificato
nei cicli correnti **0/3**. Il prossimo normale lavoro BEST produrrà le prove
mancanti senza altra diagnostica esterna. Nessun reload è stato forzato
dall'agente, nessuna sessione è stata interrotta né modificata e non è stata
prodotta inferenza di prova. Extra Usage resta scaduto; policy monitor.

Nessun audit generale, modifica a FREE/manutenzione/configurazione modelli,
push o release.

## Candidato 0.3.8 — qualificazione autonoma del 6 novembre (UTC 5 novembre)

**NO-GO alla pubblicazione e all'aggiornamento locale; MONITOR ONLY.** Il rapporto
completo è [readiness 0.3.8](maintenance/opencode-team-038-release-readiness.md).
VERSION prepara 0.3.8, mentre release, formula distribuita e launcher installati
restano 0.3.7. Il checksum dell'archivio ufficiale 0.3.7 è stato riscaricato e
verificato; nessun checksum locale viene spacciato per archivio ufficiale 0.3.8.

Correzioni effettive: configurazione BEST nuova con plugin incluso; migrazione
del percorso del plugin senza duplicarlo né cambiare opzioni/modelli; packaging
stabile/staging autosufficiente per i test protetti; default monitor coerente.
Il gate confronta ora le ricevute con i processi BEST reali, identificati tramite
DB aperto e data di avvio: nessun `hookVerified` simulato può sostituire la
copertura live. Ogni location già osservata nel processo corrente deve avere
una ricevuta corrente con callback recenti; una location ritirata senza prova
di copertura sostitutiva non viene semplicemente ignorata. In caso di inventario
non disponibile il gate resta chiuso. La copertura è una fotografia verificata,
non una garanzia su processi/configurazioni futuri.

Corretto inoltre un difetto reale del collector/validator: il campo ufficiale
OpenCode V2 2.2.5 è **`metadata.accountID`**, non `accountId`. Ora fingerprint,
header di quota e selettore del trasporto usano la stessa identità nativa;
supportati browser e headless OAuth. Nessuna credenziale è stata modificata.
Le osservazioni raccolte con identità precedente non vengono rietichettate:
le stime Sol possono quindi tornare UNKNOWN fino a nuovi delta attribuibili.

Campione reale di questa fase: **2026-11-05T23:30:49.824Z**, entrambi i collector
LIVE. Go residuo rolling **95%** (reset 23:32:25 UTC), settimana **49%**
(9 novembre 00:00 UTC), mese **63%** (30 novembre 08:39:27 UTC). OpenAI settimana
**61%**, reset 11 novembre 08:04:22 UTC. Go mensile resta CRITICAL: osservato
0,218 punti/ora contro 0,099 sostenibili, proiezione incerta al 18 novembre.
OpenAI non ha ancora una serie comparabile sufficiente sulla nuova identità:
il ritmo zero iniziale non significa consumo gratuito o costo futuro nullo.

Rilevati a quel momento **due** server BEST: PID **33624 e 68627**; 64710 non
è più attivo. Copertura live corrente **0/2**. I blocchi effettivi sono conferma
Extra Usage scaduta, copertura corrente incompleta e classi Sol non ancora
calibrate sulla corretta identità. L'utente non disponibile non autorizza a
rinnovare la dichiarazione delle 21:46:34, scaduta alle 22:46:34 UTC.

Suite governor **84/84 PASS**, Node 22, exit 0; regressioni generali in sandbox
PASS con skip espliciti per permessi nativi/evidenza Hybrid live non forniti.
Il vero test Homebrew isolato è invece **BLOCKED**, exit 3: Homebrew rifiuta
l'elusione del sandbox annidato per un account nel gruppo admin. Nessuna
protezione è stata allentata e nessun retry nel prefisso reale effettuato.
Backup, hash, log completi e rollback di questa sola preparazione sono privati
in `.local-release-evidence/release-0.3.8/`. Non ripristinare il vecchio stato
quota sopra le osservazioni nuove. FREE, launcher, configurazione personale,
manutenzione e sessioni non sono stati modificati; nessun commit/push/tag/release
o aggiornamento Mac dipendente dai gate mancanti.

---

## Hotfix 0.3.8 — 17 novembre 2026: il governor applica blocchi reali pre-dispatch

### 1. Radice del problema (due guasti, entrambi confermati)

1. **Il governor era solo osservativo.** `checkRequest` in monitor registrava la
   decisione ma non bloccava nulla; in modalità `active` il gate esisteva ma era
   inutilizzabile perché (a) il margine di sicurezza era 5% e (b) il verificatore
   di trasporto rifiutava ogni richiesta non-Bearer. Conseguenza: le sessioni
   BEST hanno continuato a bruciare quota Go ~14 giorni prima della fine del
   mese (16 novembre: $24.29 in un solo giorno su $50.86 totali del 10–16 nov).
2. **Bug di trasporto (bloccante, scoperto durante l'hotfix).** I provider
   `qwen3.7-plus`, `qwen3.8-max`, `qwen3.8-flash`, `minimax-m3`, `minimax-m2.7`,
   `claude-haiku-5-5` in `~/.cache/opencode/models.json` hanno override
   `provider: {"npm":"@ai-sdk/anthropic","api":"https://opencode.ai/inference/go/anthropic/v1"}`
   (e `gemini-4-argon-contributor` usa `@ai-sdk/google`): gli SDK autenticano con
   `x-api-key`/`x-goog-api-key`, non con `Authorization: Bearer`. Il
   `verifySubscriptionTransport` Bearer-only avrebbe classificato come non
   verificabile — e quindi **bloccato in active mode** — ogni richiesta
   Qwen/MiniMax/Gemini/Haiku, cioè la maggior parte del traffico Go. Corretto:
   accetta Bearer **oppure** (solo per provider `opencode-go`) `x-api-key`/
   `x-goog-api-key` pari alla stessa credenziale risolta; per ChatGPT resta
   Bearer-only. Rotta, scadenza token e binding organizzazione invariati.

### 2. Modifiche effettive (riuso del codice esistente, nessun nuovo servizio)

- `shared/best-quota-sources.mjs`: fix trasporto Anthropic/Google (sopra);
  `goExtraUsageSafety`, `collectQuotas` invariate nella struttura.
- `shared/best-quota.mjs`: `VERIFIED_RUNTIME_VERSIONS = ['2.2.5','2.2.7']` +
  `verifiedRuntime()` (fuori lista → ammissione negata, nessuna inferenza);
  margine di sicurezza default 5 → **15** in `quotaOptions`/`decideQuota`;
  **riserva atomica** percentuale: `decideQuota` sottrae
  `options.reserved[provider]` (somma delle leve `percent` vive) da
  `remaining − 15`; `updateQuotaState` esegue callback e scrittura in un solo
  blocco atomico; `liveLeases()` scarta le leve di processi morti (ESRCH) e
  scade solo le leve `scope:'admission'` (+15 min); `checkRequest` fa
  forecast + `fitsObservedRequest` + `decideQuota` + push decisione + push
  levain **un solo** `updateQuotaState` atomico.
- `shared/best-quota-runtime.mjs`: gate `transportSafety` prima del blocco
  atomico (re-verifica trasporto per tentativo fisico); `checkRequest` in
  monitor fa early-return dopo la registrazione (nessun effetto collaterale);
  **heartbeat** del plugin (intervallo 18 s, `unref()`, azzerato all'unload,
  saltato in `disabled`) che registra `callbacks.heartbeat = {at, outcome:
  PASSED|MONITOR_OBSERVED, mode, liveSubscription:false}` — solo liveness.
- `shared/best-quota-cli.mjs`: regola di copertura
  `alive = fresh('heartbeat') || fresh('model.request')` (fresh = outcome≠ERROR,
  ≥ registeredAt, ≤ now, ≤ 900 s) **e** `governed = !sample || reachedTransport
  || sample.outcome === 'BLOCKED'`; PASS = `alive && governed` più i controlli
  invariati di origine/versione/config/ordinamento.
- **Suppressione retry** (solo modalità active): `retry:false` su
  `BEST_QUOTA_BLOCKED`, 429, 402, 403; la politica nativa 5xx resta invariata e
  ogni tentativo 5xx ri-passa l'ammissione; in monitor nessuna modifica ai retry.
- **Deleghe concorrenti**: caps base per provider scalati da
  `instanceCapacity` (istanze live × base go 2 / openai 1); leve `record:false`
  escludono solo la levain della sessione del proprio evento; leve
  `scope:'admission'` portano `percent` (riserva), le leve di routing/delega
  no (niente doppio conteggio) e sono PID-governate, solo concorrenza.
- Nessun abbassamento dei controlli di sicurezza esistenti; nessun nuovo
  servizio/daemon/osservabilità; nessuna conversione inventata di
  `opencode.allowance` (non esposto in 2.2.7: solo eventi `session.usage.*` e
  `/api/experimental/usage/limits`).

### 3. Origine reale dei consumatori (indagine su metadata locali, nessuna lettura indiscriminata di prompt/codice)

Ledger finestra opencode-go 32.9 h → 1113 richieste: **qwen 63.3%, kimi 33.0%,
mimo 3.2%, minimax 0.4%**; finestra openai 39.5 h → 2140 richieste, **100%
`openai/gpt-6.1-sol`**. Totali per modello (ledger stato): sol 2300, qwen 779,
glm 609, kimi 367, mimo 36, minimax 5.

- **Kimi K2.7 Code (399 richieste il 16 nov):** invocato dal comando
  `codeComplex` + sottagente `go-specialist` (vincolato
  `opencode-go/kimi-k2.7-code`) del coordinatore BEST `build` in
  giaffatto-core — 4 sessioni l'16 nov da 80–204 turni, cache-read alto, >
  190K di input fresco ciascuna (`ses_e1bb48`: 1.09M input), ~399/515
  richieste. Kimi finiva in `unclassified` perché `classifyActivity` non ha
  una regola kimi (`ACTIVITY_PROVIDERS` la priva).
- **Qwen/MiniMax/Haiku/Gemini:** routing BEST su modelli Go "economici" via
  override SDK Anthropic/Google in `models.json` (vedi §1.2).
- Nessun modello Go aggira il budget comune per essere "economico": la riserva
  e l'ammissione sono per provider, non per modello.

### 4. Budget sostenibili da dati reali (snapshot 17 nov 08:35Z)

- **Go mensile:** usato 88 / residuo 12, reset `2026-11-30T08:39:27Z`;
  `usable = max(0, 100 − 88 − 15) = −3` → **budget sostenibile 0 → Go
  BLOCCATO fino al reset mensile** (anomalia `budget-spike` registrata).
- **Go rolling 5 h:** NORMAL, 22.95%/h residui. **Go settimanale:** NORMAL,
  47/53, reset `2026-11-23T00:00:00Z`, 0.2806%/h ≈ **6.74%/giorno** — la
  finestra più restrittiva governa: dopo il reset mensile sarà il settimanale
  a tenere il ritmo (~6.74%/g di 23.68 richieste per 1% ≈ **~158 richieste
  Go/giorno**).
- **OpenAI settimanale:** 26/74, reset `2026-11-22T17:24:12Z`, 0.458%/h ≈
  **10.99%/giorno** (~82.3 richieste per 1% ≈ **~906 richieste OpenAI/giorno**).
- Regola: la finestra con il minor budget utilizzabile governa; reset
  settimanale ≠ rinnovo mensile; STALE/UNKNOWN ≠ illimitato; i dati si
  aggiornano a ogni nuovo campione; nessun oscillatore rapido tra provider
  (la riserva liscia le transizioni).
- Routing in modalità attiva con questo snapshot: **Go negato (mensile
  esaurito), OpenAI ammesso** → i task BEST vanno su modelli OpenAI idonei;
  se entrambi sotto pressione → **blocco ordinato, nessun fallback pagato**.

### 5. Protezione pre-dispatch — PASS

- **Casi coperti:** build/dirette, General/Explore/Visual Designer,
  specialisti configurati su Go, proseguimento sessioni, retry, deleghe,
  operazioni ausiliarie Go, modelli scelti manualmente, sessioni BEST
  parallele — tutti passano da `checkRequest` (hook nativo su
  `session.prompt`/`message`), con ammissione atomica + riserva.
- **Limiti noti e dichiarati (nessuna pretesa di copertura totale):** le
  richieste esterne al profilo BEST (sessioni FREE/non-BEST, altri tool che
  usano le stesse credenziali Go fuori da opencode-team) **non sono governate**
  — il governor agisce solo sulle sessioni BEST dotate del plugin; le leve di
  routing senza stime `percent` sono coperte solo dai cap di concorrenza
  (margine 15% + riserva sulle ammissioni con percent); un kill del processo
  host prima della conferma di consegna lascia una levain orfana che
  `liveLeases` raccoglie al prossimo giro.
- Verifica nativa con risposte locali simulate: **mai** una richiesta Go reale
  per testare il blocco.

### 6. Multi-istanza — PASS

- 1/3/5+ terminali condividono le decisioni su un account/spazio di lavoro
  tramite lo stato persistito (`~/.local/state/opencode-team/best/quota/state.json`)
  e il blocco atomico di `updateQuotaState`: nessuna sovrascrittura perdente.
- **Imprevisto prima del nuovo snapshot:** le ammissioni concorrenti
  sottraggono la loro percentuale via leve `scope:'admission'` vive → tre
  istanze che partono insieme non possono consumare insieme più del budget
  ammesso (test essenziale 5: `3 concurrent instances` → nessun
  superamento del budget condiviso).
- Le vecchie sessioni sono **gated al proseguimento** (test 7), le nuove
  istanze si **auto-governano all'avvio** (test 8): nessuna limitazione
  permanente a una sola finestra, nessuna sessione in corso annullata o
  interrotta.

### 7. Test — 95/95 (6 suite) e 8/8 essenziali

- Suite: `best-quota`, `best-quota-runtime`, `best-quota-cli`,
  `best-quota-sources`, `best-quota-native`, `best-quota-essential`.
- Eseguite **due volte verdi**: repo (95/95) e payload installato (Node
  22.23.4, cwd = `local2/payload`, 95/95, exit 0, 11604 ms) →
  `.local-release-evidence/release-0.3.8/local-activation2/installed-cli-tests.log`.
- Gli 8 essenziali (`tests/best-quota-essential.test.mjs`, fixture
  autonoma, deterministica, risposte locali simulate): (1) Go mensile
  esaurito → zero richieste Go; (2) Go settimanale OK ma mensile critico →
  vince il mensile; (3) OpenAI disponibile → routing OpenAI; (4) entrambi
  pressati → blocco sicuro senza API a pagamento; (5) 3 istanze concorrenti →
  nessun superamento del budget condiviso; (6) sessione preesistente gated
  al proseguimento; (7) nuova istanza auto-governata all'avvio; (8) errore
  provider → nessun retry incontrollato.

### 8. Copertura runtime — PASS su entrambi i PID

- PID 6964 (1 istanza, avviato 16 nov 08:16Z, giaffatto-core) e PID 25496
  (4 istanze, avviato 12 nov): `coverage.status: PASS`,
  `nativeQualification: LIVE_CALLBACKS_OBSERVED`, `hookVerified: true`,
  runtime 2.2.7, sorgenti `opencode-go`/`openai` LIVE, unico blocker
  `GO_EXTRA_USAGE_CONFIRMATION_EXPIRED`.
- `verify-runtime` via payload installato: exit 0, versione binario 2.2.7,
  copertura PASS → `verify-runtime.log`.

### 9. Installazione locale verificata (prima di GitHub/Homebrew)

- **Payload `local2`**: `~/.local/share/opencode-team/releases/0.3.8-8daf1258615c-local2/`
  = archivio base 0.3.8 (80 file, `baseArchiveSha256 8daf1258615c…`) + overlay
  di 10 file hotfix (`shared/best-quota{,-cli,-runtime,-sources}.mjs`,
  `shared/profiles.mjs`, 5 test `best-quota*`); `installation.json` documenta
  `localRevision: local2` e lo scopo dell'overlay. Costruito e verificato da
  `.local-release-evidence/release-0.3.8/local-activation2/build-local2.mjs`
  (modalità `build` | `manifest`).
- **Entrambi i launcher** (`~/.local/bin/opencode-team` PATH pos 8 e
  `/opt/homebrew/bin/opencode-team` PATH pos 9 — quest'ultimo usato davvero da
  `PRODUCT_BINARY` in `shared/profiles.mjs` e da sei job launchd) sono stati
  scambiati con swap atomico guardato (mktemp+mv, verifica dell'hash atteso
  prima dello swap) → ora puntano al wrapper `local2/bin/opencode-team`
  (exec `node@22 …/local2/payload/shared/profiles.mjs`). Nessun eseguibile
  sostituito; vecchi target preservati (local1 + Cellar 0.3.7).
- **Verifiche:** `version` = `OpenCode Team 0.3.8` via PATH e via
  `/opt/homebrew/bin`; `doctor` exit 0; `best quota status` via entrambi i
  path → margine 15, copertura PASS, blocker solo
  `GO_EXTRA_USAGE_CONFIRMATION_EXPIRED`; `verify-runtime` exit 0.
- **Auto-caricamento nuove istanze:** il plugin in
  `~/.config/opencode-team/best/opencode.jsonc` (riga 1350) punta al package
  repo `shared/best-quota-plugin` (`index.js` importa
  `../best-quota-runtime.mjs`); le copie nel payload sono hash-identiche
  (`index.js ce27a40e…`, `package.json c2eb6119…`) → le nuove sessioni BEST
  caricano il governor corretto fin dall'avvio.
- **Rollback pronto:** `.local-release-evidence/release-0.3.8/local-activation2/rollback-launcher.sh`
  ripristina entrambi i launcher agli storici target (guard su hash local1
  `47c89f77…` e Cellar 0.3.7 `d3e9b4cb…`); `--check` exit 0 senza modifiche.
  La release `local1` è intatta.
- Config/credenziali BEST e FREE, sessioni e manutenzione preservate;
  **nessun `setup` eseguito** (avrebbe sovrascritto le configurazioni
  custom). Pubblicazione GitHub/Homebrew **dopo** la qualifica locale.

### 10. Registro decisioni dell'hotfix

- Version gating: fuori `VERIFIED_RUNTIME_VERSIONS` → ammissione negata.
- Margine 5 → 15 su ogni finestra (`quotaOptions`/`decideQuota`).
- Riserva condivisa = ledger percentuale sulle leve `leases` (atomico via
  `updateQuotaState`); `decideQuota` sottrae `options.reserved[provider]`.
- `checkRequest`: forecast + fit + decisione + push decisione + push levain
  **un solo** blocco atomico; `transportSafety` prima del blocco.
- Retry: `retry:false` su BLOCKED/429/402/403 solo in active; 5xx nativi
  invariati e ri-passano l'ammissione per tentativo (una proposta di
  sopprimere anche i retry 5xx è stata **ritirata**: i 5xx transitano dal
  canale di fallback nativo e la loro soppressione avrebbe cambiato
  comportamento osservato senza bisogno).
- Heartbeat = solo liveness (`liveSubscription:false` per design: non è una
  verifica di credenziale); la regola di copertura combina heartbeat o
  `model.request` freschi **e** `reachedTransport`/`BLOCKED`.
- Trasporto: Bearer ovunque, `x-api-key`/`x-goog-api-key` solo per
  `opencode-go`; ChatGPT Bearer-only; nessuna conversione di
  `opencode.allowance` inventata.
- `best quota activate` e `confirm-extra-usage-off` **solo** dal nuovo CLI
  (local2 o repo), mai da local1 (margine 5 e gate vecchi).

### 11. Finding pre-esistente (fuori scope, documentato, non regressione)

Sei job launchd `it.danilodantoni.opencode-team.*` invocano
`opencode-team maintenance <task>`, ma né 0.3.7 né 0.3.8 in `profiles.mjs`
hanno una dispatch `maintenance`: falliscono con `Unknown command or
arguments: maintenance` (exit 1) dal 31 ottobre (installazione 0.3.7).
`local2` riproduce l'identico errore (nessuna regressione dell'hotfix).
Il job giornaliero `io.opencode-team.safe-caches` chiama direttamente
`maintenance.py` e funziona. **Non fixato: fuori scope dell'hotfix.**

### 12. Blocco residuo e azione umana richiesta (l'unico ostacolo ad ACTIVE)

`GO_EXTRA_USAGE_CONFIRMATION_EXPIRED` — l'attestazione "Extra Usage OFF" è
scaduta e deve essere **nuova, umana, entro 1 ora**:

```sh
opencode-team best quota confirm-extra-usage-off \
  --confirmed-by USER --confirmed-at <ISO 8601 now>
opencode-team best quota activate
```

eseguiti tramite il **nuovo CLI installato** (entrambi i launcher già su
local2). Poi verificare `best quota status` → `mode: active` con
`coverage.status: PASS` su entrambi i PID. **Finché il blocco sussiste non si
dichiara ACTIVE.** Nessun accesso a provider a pagamento per il fallback;
nessuna protezione di sicurezza è stata abbassata per superare il gate.

### 13. Secondo hotfix 17 novembre 2026: il governor **regola**, non blocca

Segnalazione: "le mie chat sono bloccate di nuovo" — alcune richieste BEST
venivano rifiutate con `BEST_QUOTA_BLOCKED (quota-unavailable)`.

**Diagnosi.** Nessun blocco runtime reale dall'installazione della modalità
`monitor`: l'ultimo blocco effettivo è delle **13:33:13Z** (registro
`decisions` del file di stato), mentre le richieste continuavano a fluire
(ultimo `usage` osservato 15:03:02Z). Il motivo del rifiuto mostrato alle
chat era la **raccomandazione stale** prodotta dalla payload precedente:
`decideQuota()` classificava come non ammissibile qualsiasi finestra
`CRITICAL` (oltre che `EXHAUSTED`/`UNKNOWN`) e sottraeva il margine di
sicurezza 15% dal residuo anche in fase di ammissione, così una quota al 91%
con budget residuo veniva presentata come `quota-unavailable` e il gate la
leggeva come blocco. Il monitor non bloccava nulla, ma la raccomandazione
rimaneva "bloccata" e veniva riportata come tale.

**Correzione** (`shared/best-quota.mjs`, `decideQuota()`):

- **Ammissione**: accetta gli stati `NORMAL`, `CAUTION` e `CRITICAL`; blocca
  solo `EXHAUSTED` e `UNKNOWN` (provider/finestra), campioni non `FRESH`,
  reset scaduti e `provider.at` stale/futuro. Un budget può quindi legittimamente
  arrivare al 0% prima del tempo previsto: l'unico blocco è alla reale
  esaurimento o indisponibilità.
- **Gate per finestra**: `remaining - held > 0 && remaining - held >= (estimate ?? 0)`
  — il margine di sicurezza 15% resta **solo** come preferenza di routing
  (nel punteggio), non più come soglia di ammissione, così il lavoro prosegue
  finché c'è budget reale.
- **Ordinamento candidati**: `b.score - a.score || b.budget - a.budget ||
  a.index - b.index` (budget reale residuo come spareggio stabile).
- **Invariati**: runtime (`checkRequest`, short-circuit `EXHAUSTED`/`UNKNOWN`
  a riga 256, `fitsObservedRequest`), retry suppression, verifiche di
  trasporto, riserva atomica multi-istanza, `no paid fallback`, blocchi per
  `EXHAUSTED`/`UNKNOWN`/non-`FRESH`. Nessuna protezione di sicurezza è stata
  abbassata.

**Modalità**: `mode: monitor` (reimpostata; le richieste fluiscono e il
governor osserva e regola il routing OpenAI↔Go senza fermare il lavoro).

**Test**: 115/115 verdi (`best-quota*` + `best-routing`) e guardrail
`tests/guardrail/runner.sh` exit 0. Le aspettative dei test che presumevano
un blocco in fase di `CRITICAL` sono state riscritte sulla nuova specifica
(blocco solo a esauro reale o provider indisponibile), senza modificare il
runtime. Gli 8 test essenziali restano 8/8, incluso "no paid fallback" e la
riserva atomica a 3 istanze concorrenti.

**Payload**: `shared/best-quota.mjs` + i 3 test sincronizzati nella release
installata `0.3.8-8daf1258615c-local2`, `installation.json` ricompilato
(`build-local2.mjs manifest`, 80 file, overlay 12). Verifica CLI installata:
`best quota status` → `recommended.blocked: false`, `reason: quota-headroom`,
candidato `openai/gpt-6.1-sol#medium` per `coding` (prima: `quota-unavailable`);
decisioni live delle 15:03Z con candidato `opencode-go` — la regolazione
OpenAI↔Go funziona.

**Limiti dichiarati**: la proiezione non è una garanzia del provider; le
finestre `EXHAUSTED`/`UNKNOWN` e i campioni non freschi continuano a bloccare;
`visual` resta senza candidato idoneo quando Go è esaurito (comportamento
atteso, non un blocco delle chat); `GO_EXTRA_USAGE_CONFIRMATION_EXPIRED`
resta l'unico ostacolo alla dichiarazione ACTIVE.

## Sezione 13 — 17 novembre 2026: il routing OpenAI/Go viene APPLICATO, non solo raccomandato

**Problema**: la decisione `decideQuota()` veniva registrata (`scope: routing`)
ma nulla la applicava al turno in esecuzione: la sessione proseguiva sul modello
già selezionato. La raccomandazione era quindi solo un registro.

**Punto di enforcement verificato nel sorgente opencode 2.2.7** (`/tmp/oc-src`):
l'hook nativo `prompt` di `SessionPrompt.prepare`
(`packages/core/src/session/prompt.ts`) viene eseguito **prima** che l'ammessione
della richiesta e che il runner risolva il modello del turno (`prepareContext` →
`context.select` → `store.get` letto per ogni step). Uno `switchModel` applicato
in quell'hook è quindi il modello su cui il turno gira davvero. Il valore di
ritorno dell'hook è ignorato: contano solo gli effetti in place.

**Implementazione** (`shared/best-quota-runtime.mjs`, hook `prompt` inserito
prima dell'hook `model.request`):

- **Figli, agenti sconosciuti, modello mancante**: ritorno anticipato
  (`SKIPPED`). I figli sono già instradati da `execute.before`; re-ordinarli
  qui combatterebbe il dispatch e raddoppierebbe il budget.
- **Candidati**: specchio della regola di delega nuova — modello configurato
  dell'agente + `specialist` quando l'agente è `general` e il suo modello
  inizia con `openai/`.
- **`choose()`** decide (stessa logica di `execute.before`, lease rilasciato
  subito dopo la decisione: la prenotazione resta solo su `model.request`).
- **Active + `blocked`**: `blocked(reason)` → `BEST_QUOTA_BLOCKED` (i blocchi
  `EXHAUSTED`/`UNKNOWN` restano intatti). **Active + candidato diverso dal
  modello effettivo**: `ctx.session.switchModel({sessionID, model:{providerID,id,variant}})`.
  Se il modello effettivo è già quello raccomandato, nessuno switch.
- **`applied`**: dopo lo switch (o quando il modello effettivo coincide già)
  la decisione viene marcata con `applied === candidate.model` tramite
  `updateQuotaState` mirato (`scope==='routing' && at===decision.at`);
  `cleanState` accetta il campo `applied` (regex modello, ≤200 char).
- **Monitor**: registra e basta (`enforced: false`, nessun `applied`, nessuno
  switch). Receipt `callbacks.prompt` con esito
  `APPLIED`/`MONITOR_OBSERVED`/`SKIPPED`/`BLOCKED`/`ERROR` in
  try/catch/finally (`liveSubscription: false`: un prompt non è prova di
  trasporto).
- **Continuazioni**: ogni prompt registra la propria decisione, ma se il
  modello applicato coincide con la raccomandazione non si ri-switcha.
- **Multi-istanza**: le riserve delle altre istanze (`percent` dei lease)
  entrano nel gate: se un'altra istanza ha già impegnato la testa residua di
  Go, questo istanza viene instradata su OpenAI, e solo il proprio lease viene
  rilasciato.

**CLI** (`shared/best-quota-cli.mjs`, blocco `routing` in `quota status`):
`automatic: PASS/FAIL` richiede `mode === 'active'` **e** ultima decisione
`routing` con `enforced === true && applied === candidate.model`; in monitor
riporta sempre `FAIL` (onestamente), con `mode`, `recommended`, `applied`,
`at`, `enforced`, `decisions`, `appliedDecisions`.

**Verifiche locali deterministiche** (nessuna richiesta di inferenza Go):

- 8 nuovi test in `tests/best-quota-runtime.test.mjs` (32/32 verdi): switch
  General Go→OpenAI con `model.request` PASS e receipt `APPLIED`; route Go
  sana mantenuta; continuazione senza re-switch; monitor mai switcha; figlio
  `SKIPPED` con `execute.before` invariato; Build bloccato senza provider
  idoneo; floor GLM di Visual (applicato se Go sano, bloccato se esaurito);
  riserva di un'altra istanze al 90% su Go devia il routing su OpenAI.
- Test CLI: `automatic: PASS` con decisione applicata → `FAIL` senza `applied`
  → `FAIL` in monitor.
- Suite complete: `best-quota*` + `best-routing` **124/124 verdi**,
  `tests/guardrail/runner.sh` exit 0, 8/8 essenziali.

**Copertura istanze**: la regola `runtimeCoverage` è invariata (heartbeat
fresco, PID/luogo allineati, nessuna origine iniettata); il nuovo receipt
`prompt` entra nelle callback ammesse da `cleanState`.

**Non attivo**: `routing.automatic` PASS richiede `mode: active`, e
l'attivazione resta bloccata da `GO_EXTRA_USAGE_CONFIRMATION_EXPIRED` — la
conferma umana "Extra Usage OFF" va chiesta all'utente, mai rinnovata in
automatico. Nessuna pubblicazione GitHub/Homebrew prima della qualifica locale.

### 14. Hotfix 18 novembre 2026 (0.3.9): la dichiarazione "Extra Usage OFF" è persistente e revocabile

La regola `GO_EXTRA_USAGE_CONFIRMATION_EXPIRED` (1 ora) è stata **rimossa**:
la dichiarazione umana "Extra Usage OFF" non scade più, senza introdurre
servizi, daemon, scheduler o database nuovi.

- **Persistenza.** `goExtraUsageSafety()` non legge più `expiresAt` come
  scadenza: quella finestra resta solo un vincolo di formato dello storage
  (≤ 1 ora) perché i lettori più vecchi possano validare la voce. La voce
  restante viene marcata `persistent: true` e
  `autoDetectsConsoleChanges: false` — onestamente: **un cambio futuro del
  Go Console non viene rilevato in automatico**, va revocata e riconfermata.
- **Identità.** Ora la voce registra anche `provider: "opencode-go"` e resta
  legata all'`connection` fingerprint del subscription Go: un cambio
  account/workspace non eredita la dichiarazione, e un'identità
  inverificabile non viene indovinata su altri account (`apiAttested: false`
  invariato: è una dichiarazione umana, mai un'attestazione API).
- **Revoca.** Nuovo comando CLI (audit mai cancellato):
  `opencode-team best quota revoke-extra-usage-confirmation --confirmed-by USER_LABEL`.
  La voce di revoca usa `confirmedBy: revoked.<label>` e una connection nil
  (`REVOKED_CONNECTION`): ogni lettore fallisce in chiusura, l'effetto è
  immediato e verificabile (`status: REVOKED`, blocker
  `GO_EXTRA_USAGE_CONFIRMATION_REVOKED`), poi una nuova conferma ripristina
  la dichiarazione. La history non viene mai rimossa (solo cap fisso
  `MAX_ENTRIES`, il filtro di 35 giorni sulle conferme è stato rimosso).
- **CLI conferma.** `confirm-extra-usage-off` accetta ormai un `--confirmed-at`
  anche vecchio (rifiuta solo timestamp futuri/impossibili): niente
  re-conferma oraria o giornaliera. I gate `activate` nativi (pre-dispatch,
  copertura istanze) restano invariati e non vengono bypassati.
- **Sicurezza economica invariata.** Nessun fallback a pagamento, nessuna
  chiave API a pagamento non autorizzata, blocchi `EXHAUSTED`/`UNKNOWN`/dati
  stale, soppressione del retry su errore quota, riserva atomica multi-istanza
  e admission `CRITICAL` con quota reale: la dichiarazione OFF **non giustifica
  mai una quota esausta**.
- **Test (10 mirati + regressioni):** persistenza via restart e seconda
  istanza, assenza di scadenza 60min/24h/30gg, cambio account negato,
  revoca → re-conferma, Go esausto, rifiuto del fallback a pagamento,
  routing operativo, più `best-quota*` + `best-routing` 124/124 e
  `tests/guardrail/runner.sh` exit 0.
- **Attivazione (18 novembre).** Dichiarazione registrata sullo stato vivo
  con la data originale `2026-11-18T14:13:43.000Z`, round-trip di revoca
  verificato live e re-conferma finale; `operational: ACTIVE`, copertura
  PASS, evidenza runtime applicata (`routing.appliedDecisions: 7`).
  Le istanze live non sono state riavviate. Nota onesta: al momento della
  verifica `activation.status` può risultare `BLOCKED` da
  `SUBSCRIPTION_QUOTAS_UNVERIFIED` (dati quota stale > 15 minuti perché
  l'istanza BEST non ha raccolto da ultimo) — gate preesistente e
   indipendente dal hotfix, che si dissolve alla prossima raccolta.

### 15. BEST Sol effort — qualifica locale del 20 novembre 2026

Solo Build GPT-6.2 Sol su OpenCode 2.3.2 usa il confine nativo
`experimental.model.resolve` del Governor. La decisione cambia il modello della
richiesta, non la selezione persistente della sessione:

- **Low:** una risposta singola inequivocabile (`Reply exactly TOKEN` e
  equivalenti), senza allegati, agenti o skill. Non è una soglia sulla lunghezza.
- **Medium:** default per lavoro non classificato positivamente.
- **High:** mandato nativo `/goal`, allegati specialistici (`agent.name` o
  `skill.id` sicurezza/architettura), oppure più task eseguibili nel mandato.
  Serve una risposta High osservata per la stessa connessione OAuth e quota
  ammissibile. Altrimenti la scelta automatica resta Medium.
- Le varianti esplicite Low/Medium/High sono preservate: High esplicito passa
  o viene bloccato, mai sostituito silenziosamente. Una selezione del solo
  modello, normalizzata dal runtime come `default`, non fissa l'effort.
- L'effort resta stabile nel ciclo di esecuzione; un nuovo limite può degradare
  High automatico a Medium al confine della richiesta successiva. Non si
  rialza fino al ciclo seguente. HTTP/retry non cambiano effort.

High ha la classe `reasoning-sol-high`. Il bootstrap non assume un moltiplicatore:
riserva il massimo fra margine di sicurezza esistente, due punti di incertezza
degli endpoint e gli envelope Sol osservati su uno scenario di 15 minuti
(orizzonte del lease, non durata prevista). Senza calibrazione disponibile o con
finestre insufficienti High non passa. Restano binding OAuth, trasporto verificato,
riserve atomiche condivise e blocchi EXHAUSTED/UNKNOWN/stale. La risoluzione del
padre non consuma uno slot subagente: la riserva percentuale resta su
`model.request`. Nessun nuovo classificatore LLM, scheduler o stato persistente.

Per compatibilità con istanze già caricate e rollback, gli eventi High salvano
modello e variante, omettendo il nuovo enum opzionale `activityClass`: i nuovi
lettori inferiscono High da quei campi; i vecchi continuano a leggere lo stato.
I plugin già caricati mantengono il proprio codice fino al normale reload; nessun
reload forzato, riscrittura o riavvio di sessioni esistenti. Il profilo locale già riferisce
questo plugin nel checkout canonico: nessun setup o cambio configurazione necessario.

**Qualifica reale:** un primo tentativo è stato fermato prima dell'invio da
riserve concorrenti (`ses_e07463c31ffeS2u1nGqQiOOYUB`). Dopo nuova evidenza di
headroom, una sola richiesta effettiva ha restituito `HIGH_OAUTH_OK`:
`ses_e07420a86ffeRQH2GG4H8EPdN8`, modello registrato
`openai/gpt-6.2-sol#high`, 48.234 input / 8 output, nessun tool,
`model.request=PASSED` e handshake OAuth `liveSubscription=true`, modalità active.
Low automatico reale: `ses_e073e90ebffer9hEWjWHQaKlLE`, variante `low`,
48.350 input / 7 output, selezione persistente assente.

**Unico confronto:** stessa fixture port, file iniziali e mandato; correzione,
RED/GREEN con test congelati, riuso della precedente evidenza integration,
bundle con SHA-256, installazione non autorizzata. Medium preesistente
`ses_e07b5398dffeDcUv32gkR9Q85b`; High
`ses_e0740e2d0ffelsMfz52DrgP1ok`.

| Misura osservata | Medium | High |
|---|---:|---:|
| Requisiti autorizzati completati | sì | sì |
| Richieste modello | 13 | 14 |
| Durata primo/ultimo messaggio assistant | 57,318 s | 66,488 s |
| Token input / output | 59.351 / 931 | 60.079 / 1.017 |
| Token cache-read / reasoning | 651.008 / 0 | 704.768 / 83 |
| Test unitari | un RED, un GREEN | un RED, un GREEN |
| Report intermedi / deleghe | 0 / 0 | 0 / 0 |

La delegazione era vietata dal mandato della fixture: non è misurata la sua
qualità. High ha separato più comandi shell (8 anziché 6), non aggiunto verifiche
unitarie. Nessun vantaggio dimostrato: non si promuove High a default.
Le osservazioni quota condivisa adiacenti al confronto sono 62% prima e dopo:
risoluzione e concorrenza impediscono di attribuire una percentuale al trial,
non significano consumo zero. Cache, istruzioni e carico non costituiscono un
A/B controllato; il risultato non prova prestazioni generali dei due effort.

**Regressioni:** RED osservato per downgrade/classificazione/bootstrap e router
mancante; ulteriore RED nativo ha individuato la variante implicita `default`.
Finale: `bash tests/guardrail/runner.sh quota --experimental-test-coverage`,
100/100 + 13 controlli OS PASS, copertura linee 96,15% sui tre moduli quota
(runtime 93,28%). `node --test tests/best-quota-native.test.mjs`: PASS, con
Low/Medium/High effettivi in loopback, selezioni intatte, subagenti, goal,
restart, 503/429 e rifiuto API-key. I fixture sintetici non qualificano OAuth.
Un precedente run ha esposto un errore intermittente nel test multiprocesso
preesistente (`unsafe quota file or hardlink`); riesecuzione circoscritta e run
finale PASS, senza cambiare quel test o i controlli filesystem.
Sintassi Node e `git diff --check` PASS; nessun build/typecheck/linter configurato
per questi moduli JavaScript. Review indipendente approvata dopo le correzioni.
Il lettore quota di `f59587c` ha letto lo stato condiviso vivo con eventi High:
rollback compatibile verificato. Hash delle configurazioni BEST/FREE e della
guida personale FREE invariati; nessuna credenziale esportata o modificata.

## 20 novembre 2026 — envelope coerente fra risoluzione e admission

Questa correzione sostituisce la descrizione precedente della riserva solo su
`model.request`: per Build 6.2 sul runtime 2.3.2 la scelta dell'effort e la riserva
avvengono atomicamente in `experimental.model.resolve`, prima di costruire la
richiesta. Nessun retry aggiunto, nessuna variazione di soglie o calibrazione.

**Evidenze locali, senza inferenza:** lettura SQLite `mode=ro`/`query_only` e
stato quota, senza modificare sessioni, lease o policy. Due fallimenti reali:

| Sessione | Fallimento UTC | Ultima variante assistant registrata |
|---|---|---|
| `ses_e07746ed1ffeA1u9UB77LdeJKh` | 20 novembre, 14:10:09.426 | High |
| `ses_e06c27ee9ffe0BjRmWeFaMzxck` | 20 novembre, 14:10:42.196 | High |

Entrambi terminano con `calibrated-request-envelope`. Le decisioni adiacenti
registrano `quota-headroom`, applicato a `openai/gpt-6.2-sol#high`.
Ricostruendo forecast e calibrazione con soli campioni precedenti al fallimento:
OpenAI weekly LIVE/FRESH, 65% usato, 35% residuo, reset
`2026-11-22T17:24:12Z`; margine invariato 15 punti, envelope High 15,
Medium 0,3291476445, Low 1,0984285452 punti. La sola finestra OpenAI disponibile
nei campioni è weekly: non si inventano quote per finestre non restituite.
Il margine è una preferenza di routing; il bootstrap High lo usa come minimo
dell'envelope, non come ulteriore addebito.

I lease storici non sono conservati: non è dimostrabile il totale concorrente
esatto di ciascun fallimento. Una lettura successiva durante l'analisi ha
osservato due prenotazioni High valide da 15 punti, PID proprietari vivi, nelle
stesse due sessioni (14:25:36.766 e 14:26:05.043, scadenze 15 minuti dopo).
Con 35 punti residui e 30 impegnati, High non passa mentre Medium può passare.
Non vi è prova di lease obsoleti da eliminare; nessuno è stato rimosso.

**Causa riprodotta:** il router escludeva tutti i lease della stessa sessione e
sceglieva High senza riservarne il budget. Admission contava quei lease e poteva
vedere ulteriori prenotazioni concorrenti; inoltre ricalcolava la stima dopo la
preparazione, anche nei controlli HTTP/WebSocket. Due regressioni RED osservate:
High anziché Medium con 30 punti prenotati, e tre High concorrenti su soli
35 punti. Checkpoint RED: `6150972`.

**Correzione minima nel runtime esistente:** risoluzione e prenotazione sotto lo
stesso lock; admission e trasporto riusano solo il receipt vivo di quella
richiesta e il suo envelope congelato, ricontrollando quota, account e sicurezza.
High automatico può scendere a Medium e poi Low se presenti nell'inventario e
ammissibili; nessuna sostituzione di selezioni esplicite, provider o modello.
La ripresa di un subagente già in corso mantiene il trattamento preesistente.
Eventi di completamento rilasciano le riserve terminate senza cancellare quelle
di altre sessioni o di richieste successive. Schema persistente invariato:
nessuna migrazione richiesta alle istanze già caricate.

**Verifiche:** regressioni concorrenza, self-counting, variazione delle stime,
rilascio, eventi ritardati, inventario nativo, quota esaurita e passaggio
active→monitor/disabled durante la risoluzione. Suite guardata quota, CLI,
essential e routing (`bash tests/guardrail/runner.sh quota --experimental-test-coverage tests/best-quota-cli.test.mjs tests/best-quota-essential.test.mjs tests/best-routing.test.mjs`):
142/142 PASS, più 13 controlli OS; copertura linee runtime
95,60%. Due fixture corrette senza indebolire asserzioni: inventario che
dichiarava solo High ma aspettava Medium; scenario CLI “solo MiMo sconosciuto”
privo del campione High introdotto in precedenza.
Test server nativo 2.3.2 con sole risposte loopback: PASS, incluso downgrade
automatico High→Medium sotto concorrenza, rilascio e blocchi espliciti/esaurimento.
Sintassi Node e diff-check PASS; nessun build/typecheck/linter configurato per
questi moduli. La copertura complessiva del run allargato, che include il grande
dispatcher dei profili, è 77,06%: non è una dichiarazione di copertura globale ≥80%.
`bash tests/guardrail/runner.sh best-native` PASS; review indipendente finale
approvata dopo la regressione sul cambio di policy.

**Attivazione:** il BEST locale già riferisce
`shared/best-quota-plugin` nel checkout canonico, il cui entrypoint importa il
runtime aggiornato. Nuove istanze BEST caricheranno questa correzione senza
setup, modifiche di configurazione, launcher o reload. Istanze già caricate
restano sul codice precedente fino al normale rinnovo: nessun riavvio o reload
forzato. Nessuna inferenza reale eseguita per qualificare il nuovo codice; il
test loopback non certifica OAuth live. FREE, credenziali, autorizzazioni,
isolamento e conferme Extra Usage non modificati; nessuna pubblicazione.

# OpenCode Team 0.3.6 — reliability audit

## Esito: PARTIAL / NO-GO

**Aggiornamento post-audit:** disponibile la candidata locale 0.3.7-rc1, non
installata né pubblicata. Vedere il [rapporto di stabilizzazione](opencode-team-037-stabilization.md)
per evidenze successive, guardrail, manifest/checksum dell'artefatto e test finali.
Le sezioni seguenti conservano la fotografia del primo audit, non descrivono
tutte lo stato del codice attuale.

Audit del 29 ottobre 2026. Correzioni preparate nel repository, **non installate**.
La causa precisa del timeout storico non è ricostruibile dal log esistente.
La successiva esecuzione automatica delle 04:15 è **PENDING**, non sostituita da
un lancio manuale. È inoltre avvenuto un incidente di isolamento dei test,
descritto sotto: il requisito di assenza di mutazioni reali non è soddisfatto.

## 1. Ambiente, sorgente e revisione

- Repository: `/Users/thomasd/Sites/Github/brew-opencode-team`, branch `master`.
- HEAD iniziale: `10614f66669c1259ce6d9827c90e11864f705a72`.
- macOS 26.6.2; Python del LaunchAgent `/usr/bin/python3`, versione 3.9.6;
  Python alternativo usato nei test 3.13.5.
- `VERSION` sorgente e `/opt/homebrew/opt/opencode-team/libexec/VERSION`: 0.3.6.
- Formula: `Formula/opencode-team.rb`, archivio v0.3.6.
- Installazione: `/opt/homebrew/opt/opencode-team/libexec`.
- SHA-256 dello script installato e di `HEAD:shared/maintenance.py` identico:
  `9c9f902b9ae8bb711de83ddbe1c43d29e18323ec5409eb7dcb3f892a64e02d5a`.
- Il working tree corretto differisce intenzionalmente dall'installazione.
- Preesistenti e non modificati: `docs/best-graphify-evaluation.md` e
  `docs/best-quota-abc-evaluation.md` (untracked).
- Nessun push, rilascio, aggiornamento globale, modifica definitiva del keg,
  bootstrap/bootout o modifica dei plist eseguiti.

## 2. Timeout originale e diagnosi

Il log reale `~/.local/state/opencode-team/maintenance/logs/maintenance.launchd.log`
contiene esattamente:

```json
{"status":"error","task":"best.snapshot","type":"TimeoutError"}
```

`launchctl print gui/$(id -u)/io.opencode-team.safe-caches` conferma tre esecuzioni,
ultimo exit 1, stato `not running`. Il vecchio logger scarta la ragione
dell'eccezione e non registra fase, timestamp o durata. È dimostrato il timeout,
**non** la fase né una contesa SQLite o un problema disco quale causa storica.

Lo snapshot condivide 30 secondi fra inventario, SHA e quick-check dei precedenti,
backup online, conversione DELETE, quick-check, digest logico, SHA fisico,
fsync/pubblicazione e retention. L'inventario è quindi parte del costo, non un
preflight gratuito. Un incremento arbitrario del default non è stato applicato.

Misure attuali sui quattro snapshot presenti, usando lettura file e connessioni
`mode=ro&immutable=1` (nessuna apertura in scrittura):

| Profilo / dimensione DB | SHA secondi | quick-check secondi | Esito |
|---|---:|---:|---|
| BEST 719499264 byte | 0.406 | 0.334 | hash conforme, ok |
| BEST 724312064 byte | 0.477 | 0.657 | hash conforme, ok |
| BEST 719486976 byte | 0.425 | 0.278 | hash conforme, ok |
| FREE 14032896 byte | 0.008 | 0.003 | hash conforme, ok |

Digest logico dell'ultimo snapshot BEST: 6.709 s, conforme al manifest; FREE:
0.077 s, conforme. Sono misure odierne, con cache/carico diversi: **non provano
la causa del timeout notturno**, né misurano il backup online della sorgente.
Il controllo FREE dimostra coerenza dello snapshot, non equivalenza con lo stato
live attuale. Il vecchio `unchanged` è coerente con il contratto di deduplicazione;
la sua equivalenza storica non è verificabile retroattivamente.

## 3. Correzioni e contratti

File applicativo modificato: `shared/maintenance.py`.

- Errori snapshot: preservato `type`; aggiunti `error_type`, `phase`, `reason`,
  `elapsed_ms`, `budget_ms`, `published`, `timing_ms`. Ragioni note allowlistate;
  nessun messaggio arbitrario, percorso o contenuto conversazione nei report.
- Fasi distinte: verifica precedenti, backup, integrity, logical, checksum,
  publish, retention. Durate delle fasi completate e di quella fallita.
- Errori della verifica iniziale ora annotati; errori dopo rename riconoscibili
  tramite `published=true`, che non equivale a conferma di fsync riuscito.
- Controllo deadline prima della pubblicazione.
- Script Python: opzione additiva `--timeout SECONDS`, finita e positiva,
  default ancora 30. Non è una nuova opzione inoltrata dal wrapper Node e non è
  stata aggiunta al plist reale.
- Digest logico: alias rowid non oscurato, confronto case-insensitive; gestione
  WITHOUT ROWID; errore esplicito se tutti gli alias del rowid sono oscurati.
  Corretto un caso riprodotto su fixture in cui una modifica del rowid veniva
  ignorata. Non dimostrato che lo schema operativo presenti quel caso.
- Reclaim: busy/locked/interrupted gestiti anche su PRAGMA iniziali/finali e
  checkpoint; altri errori propagati. In rollback mode acquisizione del lock
  di commit prima del vacuum per evitare lavoro poi annullato dal reader.
  Regressione con `BEGIN EXCLUSIVE` esterno dimostrata RED prima del fix.
- Nessuna nuova dipendenza, migrazione, servizio, classe o modifica dei manifest.
  Profili, percorsi, formato `snapshots-v1`, calendario e vecchi campi preservati.

Il timeout rimane **cooperativo**, non hard real-time: callback/progress handler
interrompono SQLite e hashing, ma fsync, syscall, sort del digest e cleanup non
sono preemptibili dal budget. `sqlite3.OperationalError` può avere ragione
sanitizzata `database`; fase e tipo non attribuiscono da soli contesa o deadline.
Non viene promesso un limite rigoroso a tutte le operazioni di filesystem.

## 4. Garanzie e limiti snapshot

Manifest e DB vengono sincronizzati nella directory privata temporanea, poi
pubblicati con rename nello stesso filesystem e fsync della directory padre.
Nessun pruning prima della pubblicazione. La retention conserva tre snapshot e
usa rename `.retired-*` per recuperare rimozioni parziali. Corruzione precedente
blocca in modo conservativo la creazione; non viene cancellata per liberare spazio.
Il finally pulisce solo il temporaneo della chiamata; artefatti sconosciuti e
vecchi `.pending-*` non vengono cancellati automaticamente.

I crash sono simulati tramite errori di I/O/fsync/rename su fixture; non è stato
eseguito un power-loss fisico. Il successo di rename non garantisce da solo la
durabilità dopo perdita di alimentazione. Il budget non è stato dimensionato con
uno stress test rappresentativo e non è stato aumentato.

## 5. Test, RED/GREEN e review

File test modificato: `tests/test_maintenance.py` (28 test iniziali, 50 finali).
Tutte le fixture finali impostano HOME e root temporanei; comandi esterni mockati
nei percorsi CLI. Il subprocess di lock usa esclusivamente stato temporaneo.

Comandi realmente eseguiti:

| Comando | Risultato osservato |
|---|---|
| `/usr/bin/python3 -B -m unittest discover -s tests -p test_maintenance.py` | finale 50/50, 2.198 s, exit 0; rieseguito dal coordinatore |
| `python3 -B -m unittest discover -s tests -p test_maintenance.py` | finale 50/50, 1.801 s, exit 0; rieseguito dal coordinatore |
| `node --test tests/*.test.mjs` | 49 totali: 47 pass, 2 skip, 0 fail |
| `bash tests/setup-smoke.sh` | 36 Node pass, 1 skip; 48 Python pass; packaging smoke PASS |
| `bash tests/homebrew-workflow.test.sh` | 7 scenari release PASS, exit 0; non un rilascio reale |
| `ruff check --select E4,E7,E9,F,D301,D400,D415,D419 shared/maintenance.py tests/test_maintenance.py` | PASS |
| `ruff check shared/maintenance.py tests/test_maintenance.py` | FAIL: rilievi di stile preesistenti; non dichiarato PASS |
| `git diff --check` | PASS |

Confronto Ruff tramite `git show HEAD:<file>` e `ruff check --stdin-filename`:
baseline 6 rilievi sorgente + 15 test; eliminati i 9 rilievi nuovi individuati.
Non cambiati contratti di errore esistenti per soddisfare regole cosmetiche.

RED documentato dal worker: 51 test, 13 failure e 2 errori per nuove aspettative;
successivo RED lock esterno: `OperationalError: database is locked` al PRAGMA.
GREEN finale dopo rimozione di tre test duplicati: 48; due ulteriori regressioni
ENOSPC simulato e manifest invalido portano a 50. Nessun test rimosso per occultare
un fallimento. Review indipendente read-only: nessun finding bloccante; corretto
il finding sul test deadline pubblicazione rendendolo deterministico.

Copertura comportamentale: backup/ripristino, NUL/BLOB e identità righe, WAL,
reader/writer, lock, dedup, retention e retry, corruzione, manifest invalido,
spazio insufficiente, timeout backup/checksum/integrity/logical/retention,
interruzioni prima/dopo pubblicazione, fsync fallito, symlink, artefatti ignoti,
dry-run, exit nonzero, log JSON sanitizzato, lock interprocesso, timeout subprocess.
Fixture benchmark: 750 pagine recuperate, circa 0.02 s; non è un benchmark BEST.

Ripristino: apertura del DB snapshot su fixture e confronto delle righe; verifiche
fisiche e logiche PASS. Nessun ripristino sul DB reale. Coverage percentuale,
type checking completo, stress prolungato, SIGKILL/power-loss, audit completo dei
permessi di tutti gli alberi live e test nativi opzionali non eseguiti. I due skip
Node richiedono binario/export nativi opzionali: non contati come PASS.

## 6. LaunchAgent reali

Tutti gli otto plist presenti. Stato ottenuto separatamente con
`launchctl print gui/<uid>/<label>`, senza avviare job.

| Label (prefisso legacy `it.danilodantoni.opencode-team.`) | Trigger | Loaded / runs / ultimo exit |
|---|---|---|
| `io.opencode-team.safe-caches` | 04:15 | sì / 3 / 1 |
| `host-storage-gc` | 14400 s | sì / 108 / 1 |
| `runtime-gc` | 05:30 | sì / 20 / 1 |
| `version-check` | 00:00 + 43200 s + RunAtLoad | sì / 40 / 1 |
| `openai-retention` | 04:15 | sì / 20 / 1 |
| `playwright-gc` | 14400 s | sì / 108 / 1 |
| `best-tool-output-gc` | 04:45 | sì / 20 / 1 |
| `best-retention` | 05:00 | **no**, launchctl exit 113; runs/exit non disponibili |

Safe-caches: plist mode 0600, comando esatto `/usr/bin/python3
/opt/homebrew/opt/opencode-team/libexec/shared/maintenance.py`; stdout/stderr nel
log maintenance.launchd.log. Calendario 04:15 corretto, symlink stabile Homebrew.
Il processo eredita l'ambiente launchd: PATH/HOME effettivi dell'esecuzione passata
non ricostruiti; la suite verifica configurazione e sanitizzazione su fixture.

I sei job legacy caricati invocano `/opt/homebrew/bin/opencode-team maintenance
<job>`, comando assente nella 0.3.6. I rispettivi `.launchd.err` contengono
`Unknown command or arguments: maintenance`: causa distinta dal timeout BEST.
Plist legacy mode 0644. Non ripristinate vecchie operazioni di cancellazione per
far sparire exit 1. La loro dismissione richiede una decisione esplicita su job
legacy estranei al receipt attuale; non alterati automaticamente.

Best-retention usa Python gestito 3.13 e `~/.local/bin/opencode-cleanup` con
`--v2 --v2-standalone --v2-apply --v2-upgrade-confirmed`. Log fino al 15 ottobre,
con API_ERROR/fetch failed, **non prova di attività corrente**: agente non caricato,
coerentemente con la dismissione documentata. Non riattivato.
Gli altri log storici non forniscono timestamp affidabili per ogni errore;
l'ultima esecuzione esatta per tutti i job rimane non accertata.
Sovrapposizione calendariale safe-caches/openai-retention alle 04:15; version-check
ha tre trigger. Nessuna prova che questa sovrapposizione causi il timeout.

FREE reclaim `not-configured`: `auto_vacuum != INCREMENTAL`, condizione prevista,
nessuna conversione necessaria. Nel run storico BEST 256 pagine recuperate, WAL
1079472 byte finale (sotto soglia checkpoint): il ramo `checkpoint_status=deferred`
è coerente con scadenza dei 250 ms, non prova di un reader bloccante. PASSIVE non
viene sostituito con TRUNCATE/RESTART. Cache e aggiornamenti storici risultano ok
e informational/outdated_count=0; non equivalgono a copertura di tutti i vecchi job.

## 7. Incidente di isolamento — requisito di sicurezza violato

Durante il primo RED di un worker, un test CLI senza ambiente temporaneo chiamò
`main()` cinque volte con timeout `0`, `-1`, `nan`, `inf`, `-inf`. Il parser ancora
non validava questi valori. **Fu eseguita manutenzione reale**, non autorizzata.

Output riportato dal worker:
- BEST reclaim: committed_pages 1350, 1, 3, 0, 0.
- Due snapshot BEST creati: 719486976 e 719499264 byte.
- FREE reclaim: not-configured, zero pagine; snapshot unchanged per nan/inf.
- Cinque invocazioni ciascuna di `shared/disk-cleanup.sh --safe-caches-only` e
  `brew outdated --json=v2 --formula`, report cache ok e outdated_count 0.
- La retention è stata percorsa. Senza inventario precedente **non è accertabile
  se/quali snapshot validi siano stati rimossi**.
- Lo stdout dettagliato cache era scartato: non accertabili le singole rimozioni.
  I rami possibili comprendono cache Chrome, Docker build cache vecchie e log Serena.

Nessun rollback tentato: avrebbe potuto sovrascrivere lavoro corrente. Il test è
stato isolato, poi HOME temporaneo esteso a tutto setUp e ricontrollato dal reviewer.
I quattro snapshot rimasti hanno hash e quick-check validi, mode DB 0600.
**Non è possibile attestare assenza di mutazioni reali, conservazione di tutti i
backup precedenti o assenza di effetti cache.** Non risultano istruzioni di delete
sessioni nel nuovo codice, ma manca una baseline live che dimostri conservazione
integrale prima/dopo l'incidente. Questo impedisce categoricamente PASS globale.

## 8. Distribuzione, rollback e criteri persistenti

File del lavoro: script, test e questo rapporto. Nessun commit automatico o artefatto
pubblicato. Formula e VERSION intenzionalmente invariati: non riutilizzare il tag
immutabile v0.3.6 con bytes diversi.

Piano, **non eseguito**:
1. Approvare il diff e il trattamento dei sei agenti legacy senza ripristinare
   cancellazioni storiche; chiarire gli effetti dell'incidente ove possibile.
2. Preparare una nuova versione/tag e archivio con checksum verificato, testare
   l'archivio in staging isolato, aggiornare la formula solo con autorizzazione.
3. Installare attraverso il normale processo Homebrew approvato, confrontare hash
   installato con artefatto, verificare plist e interprete. Non editare il keg.
4. Osservare la **vera successiva esecuzione delle 04:15**, senza kickstart sostitutivo:
   salvare offset/inode del log e runs prima, poi controllare incremento runs,
   ultimo exit, nuovi report JSON di tutti i task e timing/phase in caso di errore.
5. Verificare snapshot pubblicati con hash, quick-check e manifest in sola lettura;
   preservare l'inventario precedente. Un rinvio reclaim esplicito è previsto,
   non prova che tutto il lavoro sia stato completato.

Rollback: mantenere artefatto/versione precedente e relativo hash, ripristinare
soltanto il codice tramite distribuzione approvata, non ripristinare né cancellare
DB, sessioni o snapshot. Nessuna migrazione da annullare. I campi JSON aggiuntivi
non richiedono migrazione manifest. Non riabilitare automaticamente job legacy.

Diagnostica effettivamente usata: `git status --short`, `git rev-parse HEAD`,
`git branch --show-current`, `git show HEAD:shared/maintenance.py`, lettura plist
tramite `plistlib`, `launchctl print`, SHA-256 streaming tramite `hashlib`,
quick-check SQLite immutable e digest logico read-only. Nessun contenuto di
conversazioni o credenziale incluso nel rapporto.

**Restano aperti:** attribuzione del timeout storico, limite temporale hard delle
syscall, dimensionamento rappresentativo, dismissione approvata dei job legacy,
installazione corretta, verifica notturna reale ed effetti non ricostruibili
dell'incidente. Stato conclusivo: **PARTIAL / NO-GO**.

Autovalutazione: accuratezza 4/5 (misure attuali non spiegano il timeout storico);
completezza 1/5 (violato il vincolo sui dati reali, installazione e notte pendenti);
chiarezza 4/5 (rapporto esteso per distinguere prove e limiti); azionabilità 3/5
(patch testata, ma rilascio e gestione legacy richiedono decisioni); concisione 3/5
(dettaglio necessario per l'incidente). Media 3.0/5. Priorità: chiarire effetti
dell'incidente senza ulteriori mutazioni, approvare distribuzione, acquisire
diagnostica della vera esecuzione schedulata. Nessuna autovalutazione sostituisce
i criteri di accettazione dell'utente.

## 9. Evidenze successive e stabilizzazione

- Due pubblicazioni dell'incidente identificabili dai nomi time_ns:
  **2026-10-29 08:49:37.299550 UTC** (719486976 byte) e
  **08:50:26.566545 UTC** (719499264 byte). Non sono timestamp di inizio delle
  cinque invocazioni: questi ultimi restano non ricostruibili individualmente.
- Inventario attuale: tre BEST e uno FREE; SHA-256 e quick-check immutable OK.
  BEST precedente: 654 sessioni; entrambe le copie dell'incidente: 661. Nessuno
  dei 654 ID precedenti manca nelle due copie. FREE: 6 sessioni. Non è una prova
  di conservazione di ogni contenuto o dell'intero stato live corrente.
- Il log prova una creazione BEST da 724983808 byte non più presente
  nell'inventario: rimozione per retention durante l'incidente coerente con il
  limite tre, ma tempo/autore/identificativo esatto non sono provati.
- Correzione dell'annotazione storica best-retention: sono presenti righe datate
  fino al **26 ottobre 2026**, non soltanto al 15; il job resta non caricato.
- Questa fase ha effettuato solo letture sui dati reali: nessun rollback,
  restore, cleanup, sostituzione snapshot o intervento sui servizi.
- Test ora protetti da staging, ambiente allowlist, sandbox kernel e controlli
  negativi prima delle suite; gli entrypoint diretti vengono rifiutati. Non usare
  i vecchi comandi unittest/Node/shell non isolati riportati nella sezione storica.
  Comando corrente: `bash tests/guardrail/runner.sh`.
- Diagnostica completata per busy/interrupted/ENOSPC/EIO, recovery e cleanup;
  conservato l'errore primario e aggiunte ragioni deferred. Default sempre 30 s.
- Verifica dell'archivio candidato: **55 Python + 13 controlli negativi PASS**,
  **48 Node PASS, 2 skip**, smoke e sette scenari shell PASS. Ruff selettivo PASS;
  Ruff completo conserva 24 rilievi di stile, documentati nel rapporto finale.
- Candidata, distribuzione, collaudo notturno e incidente restano stati distinti:
  **PASS locale delle verifiche eseguite; PARTIAL / NO-GO globale**.

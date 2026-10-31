# OpenCode Team — stabilizzazione e candidata locale 0.3.7-rc1

29 ottobre 2026. Continuazione dell'[audit 0.3.6](opencode-team-036-reliability-audit.md),
non un nuovo audit da zero. **PASS delle verifiche locali riportate; PARTIAL /
NO-GO globale** finché distribuzione approvata e vera esecuzione automatica non
sono verificate. Nessun rilascio, push, installazione nel keg, bootstrap, bootout,
kickstart, cleanup reale o rollback dei dati effettuato in questa fase.

## 1. Incidente: confermato, dedotto, non ricostruibile

L'incidente precedente rimane una violazione confermata: cinque chiamate reali
di manutenzione durante un test, con reclaim BEST, due snapshot e cache cleanup.
Non viene annullato dai test successivi e non è stato tentato alcun rollback.

### Evidenze confermate recuperate in sola lettura

| Snapshot attuale, suffisso directory | Pubblicazione UTC da time_ns | Byte | Sessioni | SHA/quick-check |
|---|---|---:|---:|---|
| BEST `ed52807ba5d948af860326eebeaf0057` | 28/10 03:15:30.291183 | 724312064 | 654 | conformi / ok |
| BEST `80f1e7c1af4d40db8ac6b724ba388919` | 29/10 08:49:37.299550 | 719486976 | 661 | conformi / ok |
| BEST `15705a16c4c540d7b0127a508a9fde79` | 29/10 08:50:26.566545 | 719499264 | 661 | conformi / ok |
| FREE `ba21dce4649646c49d4374b5e149146d` | 27/10 03:15:24.733967 | 14032896 | 6 | conformi / ok |

SHA-256 integrali verificati rispettivamente:

```text
a7ceae8a81655b3c847234380ab2b39a83a5ca78043bd69e98d00dccddeed2c2
2040e0a79e01614c6fcf709802415524d28c7c51717b90e043d0cc7a041643ef
4131c7278204bb4cf17db45f67b13803c4cd0a536aca6c60a305d1c2b0570a13
636b6f3bbbcb544f9c2f0313c4635eb93103da2a9db635b4dc4274f537cb4ecc
```

DB snapshot mode 0600; ciascuna directory contiene solo DB e manifest, senza
sidecar/pending/retired rilevati. Letture SQLite esclusivamente
`mode=ro&immutable=1`, con query-only per l'inventario; nessun contenuto di
conversazione, titolo, ID sessione o credenziale riportato.

Il confronto degli insiemi ID fra BEST precedente e ciascuna copia dell'incidente
restituisce **0 ID precedenti mancanti**. Il timestamp minimo di creazione è
identico nelle tre copie BEST (1790579263989 ms). Questo dimostra disponibilità
di quelle sessioni negli snapshot, non equivalenza integrale delle conversazioni,
allegati e output né assenza universale di perdita.

I DB live esistono nei percorsi canonici
`~/.local/share/opencode-team/{best,free}/data/opencode/opencode.db`.
Sono stati letti solo i metadata, **non aperti con SQLite**: BEST 753090560 byte,
WAL 3967592 byte; FREE 14032896 byte, WAL 0. BEST ha scritture successive durante
l'uso corrente: le differenze attuali non sono attribuibili al solo incidente.
SHM FREE osservato con mtime 29/10 08:50:34 UTC, coerente temporalmente con
l'incidente ma non prova dell'autore di quella modifica.

### Deduzioni, non fatti provati

Il log storico conferma uno snapshot BEST creato da 724983808 byte; nessuno
snapshot con quella dimensione è più nell'inventario. Due snapshot storici e due
nuovi superano il limite tre: rimozione del più vecchio durante la retention
dell'incidente è una spiegazione coerente. Mancano inventario precedente, nome
del vecchio snapshot e log delle rimozioni: **tempo e causa della scomparsa non
sono dimostrati**. Non è corretto trasformarla in perdita di sessioni accertata.

### Informazioni non ricostruibili

- Inizio/fine individuali delle cinque invocazioni: solo le due pubblicazioni
  hanno timestamp recuperabile. I nomi non misurano l'inizio del backup.
- Singoli file/cache eventualmente rimossi: l'output dettagliato venne scartato;
  `caches=ok` non identifica le cancellazioni. Non ripetuto il cleanup.
- Conservazione di tutti gli snapshot precedenti e di ogni contenuto storico.
- Causa/fase del timeout notturno originale: il vecchio log conserva solo il tipo.

## 2. Isolamento e controlli automatici

Nuovi file necessari: `tests/guardrail/runner.sh`, `profile.sb`,
`assert-isolated.mjs`, `tests/test_isolation.py`. Dettagli e limiti in
[tests/README.md](../../tests/README.md).

- Il runner copia solo gli alberi applicativi/test/config necessari in un nuovo
  staging temporaneo, senza `.git`, `node_modules`, documenti personali o stato live.
- Ambiente dei figli costruito con `env -i`: HOME, OPENCODE_TEAM_HOME, TMPDIR e
  TMPPREFIX nello staging; non ereditati credenziali, endpoint Docker, export
  nativi, NODE_OPTIONS, override XDG e percorsi di dipendenze personali.
- Kernel sandbox: scritture solo nello staging/device output; letture HOME
  reale e team reale ereditato negate, anche quando il team è esterno a HOME.
  HOME reale deriva dall'account UID, non dal valore ambientale modificabile.
  TCP/UDP negati, unix bind ammesso per il socket mock, connessioni in uscita
  negate. Entry point launchctl/brew/docker esplicitamente negati.
- Se sandbox-exec manca, exit 70; se un controllo negativo fallisce, nessuna suite
  funzionale parte. Non esiste fallback non isolato.
- Entry point Python, Node e shell rifiutano il contesto non staged; Python
  controlla ROOT/HOME/team/TMPDIR prima di creare fixture o importare maintenance.
  SQLite/path maintenance confinati a una root esclusivamente creata dal test;
  URI, bytes e symlink verificati, subprocess manutenzione non mockati bloccati.
- I controlli negativi usano **sentinelle temporanee**, non DB reali: read/write,
  socket, exec, URI/path, subprocess e rifiuto degli entry point prima delle fixture.
- zsh usa TMPPREFIX per heredoc: impostato nello staging; nessuna concessione di
  scrittura a `/tmp` o all'intero `/private/var/folders`.

Limiti espliciti: lettura dei file di sistema/toolchain e mach-lookup rimangono
ampi; non è una sandbox universale contro codice ostile/qualsiasi IPC. I test
non provano che future modifiche arbitrarie non possano violare il modello.
Il deny del team esterno è implementato; manca una regressione separata dedicata
a ogni singola variabile ambientale fuori staging.

## 3. Chiusura Python e compatibilità

Preservate tutte le precedenti regressioni e correzioni. Ulteriori fix:

- SQLite busy/locked/interrupted classificati tramite codice primario/esteso o
  fallback testuale esatto su Python 3.9; ENOSPC/EIO riconoscibili senza messaggi
  arbitrari. Gli errori sconosciuti non diventano successi.
- Recovery retired con fase e deadline esplicite. Fasi backup, integrity,
  logical, checksum, publish, retention e cleanup attribuibili nei report.
- Un errore cleanup non maschera l'errore primario; campi additivi
  `cleanup_error_type` e `cleanup_reason`. Cleanup isolato fallisce con fase cleanup.
- Reclaim deferred esplicita busy/deadline; checkpoint deferred esplicita
  deadline/page-budget. PASSIVE conservativo, nessuna migrazione auto_vacuum.
- Default snapshot **30 secondi**, CLI Python `--timeout` finito e positivo;
  nessuna modifica automatica al plist o nuova opzione inoltrata dal wrapper Node.
- Pubblicazione e retention restano conservative, manifest `snapshots-v1`
  invariato, vecchi campi `type/status/task` preservati, errori obbligatori exit nonzero.
- Vecchi manifest ancora verificabili. Con colonna `_rowid_` oscurata, il digest
  corretto può produrre uno snapshot aggiuntivo una tantum, non invalidare i vecchi.

Timeout sempre **cooperativo**: fsync, sort e syscall non hanno hard deadline.
Nessun benchmark rappresentativo nuovo sui dati reali, né stress/fault injection
live. Il rischio di dimensionamento dei 30 secondi resta aperto, senza causa
storica inventata o incremento arbitrario.

## 4. LaunchAgent e decisione legacy

Stato osservato con sole query `launchctl print gui/<uid>/<label>`:

| Label (legacy prefisso `it.danilodantoni.opencode-team.`) | Loaded | Runs | Exit |
|---|---|---:|---:|
| `io.opencode-team.safe-caches` | sì | 3 | 1 |
| `host-storage-gc` | sì | 109 | 1 |
| `runtime-gc` | sì | 20 | 1 |
| `version-check` | sì | 41 | 1 |
| `openai-retention` | sì | 20 | 1 |
| `playwright-gc` | sì | 109 | 1 |
| `best-tool-output-gc` | sì | 20 | 1 |
| `best-retention` | no | non disponibile | query 113 |

I sei legacy hanno dispatcher rimosso, non lo stesso errore BEST. Matrice di
origine, funzione, sostituzione, rischio e raccomandazione in
[legacy-launchagents.md](legacy-launchagents.md). Best-retention rimane dismesso;
righe storiche fino al 26/10 non dimostrano che sia caricato oggi.

Nessuna nuova logica installer/uninstaller per quei sei job: sono estranei al
receipt del solo safe-caches. Non ricreate retention di sessioni o GC distruttive.
Dismissione reversibile futura, separatamente approvata, conservando plist/log.
Calendario attuale safe-caches sempre 04:15; sovrapposizione legacy openai-retention
rimane presente, non modificata né dimostrata causa del timeout.

## 5. Verifiche realmente eseguite

Verifica finale eseguita **dall'archivio estratto**, non soltanto dal working tree:

```sh
bash tests/guardrail/runner.sh
```

| Verifica | Esito numerico |
|---|---|
| Isolamento, prima delle suite | 13 PASS, 0 skip/failure |
| Manutenzione Python `/usr/bin/python3` 3.9.6 | 55 PASS, 0 skip/failure |
| Node native profiles | 36 PASS, 1 skip |
| Node disk cleanup, solo fixture/mock | 3 PASS |
| Node Hybrid fixture | 5 PASS, 1 skip |
| Node packaging | 4 PASS |
| Node totale, senza contare ripetizioni | **48 PASS, 2 skip, 0 failure** |
| Shell setup smoke | PASS; ripete 55 Python e 36 Node PASS + 1 skip |
| Shell release mock | 7 scenari PASS |
| Installazione formula Ruby DSL mock + smoke installato | PASS nel test packaging |
| Ruff `E4,E7,E9,F,D301,D400,D415,D419` sui tre Python toccati | PASS |
| Python compile senza bytecode, bash -n, ruby -c, actionlint | PASS |
| Manifest archivio: SHA estratti/sorgenti, formula URL/checksum | 32/32 file conformi |
| Review indipendente statica | blocker corretti; nessun nuovo blocker |

Skip: evaluator V2 nativo ed export reali Hybrid opzionali, deliberatamente non
ereditati dal runner. Non sono PASS. Suite smoke duplicate non sommate ai test
unici. Non misurati coverage percentuale e type checking completo; non eseguiti
stress prolungati, power-loss fisico o collaudo reale Homebrew/CI remota.

Ruff completo: **FAIL, 24 rilievi** (6 applicativo, 18 test manutenzione, 0
isolamento); comprende stili preesistenti e quattro SIM117 nei test aggiunti.
Non silenziati e non spacciati per lint verde; nessun errore nel set selettivo.

RED/GREEN: diagnostica nuova 55 test con 15 failure/4 errori prima del fix
(evidenza worker), poi PASS sotto guardrail; contratto workflow→runner RED
prima dell'allineamento YAML, poi PASS. Un tentativo di sandbox annidata durante
il nuovo smoke installato ha restituito `sandbox_apply: Operation not permitted`:
test fallito registrato, nessuna protezione rilassata. Lo smoke installato viene
ora eseguito sotto la sandbox già ereditata; il blocco formula generato continua
a usare il runner quando avviato normalmente fuori da una sandbox preesistente.

Log locali conservati sotto la directory temporanea approvata OpenCode:
- `stabilization-final-tests.log`: fallimento della sandbox annidata, non un PASS.
- `stabilization-final-artifact-tests.log`: run dell'artefatto finale, exit 0.
- `maintenance-green-final.log`: evidenza RED/GREEN del worker Python (GREEN).

## 6. Artefatto preparato, non pubblicato

Etichetta locale **0.3.7-rc1**, VERSION runtime numerico **0.3.7**. Base Git
`10614f66669c1259ce6d9827c90e11864f705a72`, branch master, modifiche non committate.
Non esiste un tag o una release remota nuova. Manifest dichiara `dirty_source=true`:
non si pretende che HEAD includa il codice corretto.

Directory locale:

```text
/private/var/folders/fs/7py3y1294056jtqn3vhvq3l80000gn/T/opencode/opencode-team-0.3.7-rc1-final-c6xrxq1x/
```

Contiene:
- `opencode-team-0.3.7-rc1.tar.gz` — 87199 byte, 32 file;
- `SHA256SUMS`, `candidate-manifest.json` con SHA/mode di ogni file;
- `opencode-team-candidate.rb` con URL file locale, versione e digest esatti;
- `extracted/opencode-team-0.3.7/`, sorgente realmente collaudata.
- `logs/`, copie del run finale e del precedente fallimento della sandbox annidata.

SHA-256 archivio:

```text
e8bb725c1f45f06844bdea27cbc3fa122ddde5f828192dae6c44d07d9587ff46
```

Tar/gzip costruito con ordine deterministico, mtime/uid/gid normalizzati, solo
file regolari allowlistati e nessun DB, segreto o albero di stato. Estrazione
verificata senza traversal/symlink e SHA di tutti i membri confrontati anche col
working tree finale. I rapporti di manutenzione sono esterni all'artefatto per
evitare riferimenti circolari al suo stesso checksum. La directory è temporanea:
conservarla prima di eventuali pulizie future, senza installarla implicitamente.

Formula stabile **byte-identica a HEAD**, ancora URL/SHA 0.3.6. Il renderer staging
installa guardrail/test necessari e usa runner smoke; workflow source/staging/
official allineati, percorso storico dello stable 0.3.6 non riscritto.
La formula candidata e i test di installazione usano il DSL Homebrew mock:
**nessun vero brew install/test** sul sistema. Il checksum locale non è il futuro
checksum dell'archivio GitHub e non deve essere copiato nel tap come se lo fosse.

SHA dello script corretto:
`8e416ea6c77ee1e85c1a79d3b6b783bf013b92e52650daff836a3b6ea98b14af`.
Installato ancora:
`9c9f902b9ae8bb711de83ddbe1c43d29e18323ec5409eb7dcb3f892a64e02d5a`.
Quindi i test della candidata **non dimostrano il funzionamento dell'installazione
in uso**, che rimane 0.3.6.

## 7. File modificati e consegna

Preservati diff ed evidenze precedenti. File applicativo: `shared/maintenance.py`;
versione: `VERSION`; packaging/CI: `.github/scripts/render-staging-formula.rb`,
`.github/workflows/homebrew-install.yml`; test: i quattro `*.test.mjs`,
`test_maintenance.py`, `setup-smoke.sh`, `homebrew-workflow.test.sh`, `README.md`
e i quattro nuovi file isolamento sopra indicati. Documenti: audit aggiornato,
matrice legacy e questo rapporto. `shared/profiles.mjs` e formula stabile invariati.
I due documenti personali untracked preesistenti non modificati né impacchettati.

Diagnostica effettiva: Python pathlib/stat/hashlib, SQLite immutable sui soli
snapshot, query aggregate e differenza insiemi ID senza output sensibile;
`launchctl print` sugli otto label; `git status`, `git show`, `git diff --check`;
runner isolato, Ruff, actionlint, ruby -c/bash -n e compile Python. Nessun comando
di manutenzione reale usato per ricostruire l'incidente.

## 8. Distribuzione e rollback del solo codice — non eseguiti

1. Approvare diff e candidata; conservare manifest/log. Committare il codice
   approvato e costruire l'artefatto dal commit: il pacchetto attuale è working-tree,
   non una prova CI legata a un tag.
2. Verificare formula candidata in un ambiente Homebrew realmente disposable,
   con install/test e launcher fuori dalla directory di lavoro. Nessun keg reale
   da sostituire durante questo collaudo.
3. Solo dopo autorizzazione, seguire i gate release esistenti, ottenere il checksum
   dell'archivio ufficiale e promuovere la formula senza alterare v0.3.6. Conservare
   il vecchio pacchetto/codice. Mai sostituire manualmente lo script nel keg.
4. Dopo installazione approvata: confrontare SHA/versioni, plist, comando/interprete,
   HOME/PATH e calendario 04:15. La dismissione dei sei legacy è una decisione
   separata; non riattivare best-retention.
5. Salvare inventario snapshot e offset/inode log, runs/exit prima della vera
   esecuzione delle 04:15. Dopo: incremento runs, nuovi task JSON, exit e reason,
   timing per fase, integrità manifest/hash/quick-check in sola lettura.
   Non usare un kickstart manuale come prova equivalente.

Rollback: reinstallare soltanto il precedente codice/pacchetto approvato attraverso
il percorso di distribuzione; non riportare DB, sessioni, cache o snapshot a uno
stato precedente. Nessuna migrazione schema da annullare. Conservare i dati nuovi
e non riabilitare job legacy in nome del rollback.

**PENDING:** vero test Homebrew/CI remota, distribuzione autorizzata, corrispondenza
installazione-candidata, esecuzione schedulata reale e dimensionamento dei budget.
Gli effetti non ricostruibili dell'incidente restano dichiarati, non cancellati
da una futura esecuzione riuscita. **Esito globale: PARTIAL / NO-GO.**

Autovalutazione: accuratezza 4/5 (distinte prove snapshot e stato live non letto),
completezza 4/5 (brew/CI e notte rimangono verifiche future esplicite), chiarezza
4/5 (confini e stato per fase separati), azionabilità 4/5 (artefatto e digest
disponibili, ma serve approvazione della distribuzione), concisione 3/5 (rapporto
esteso per conservare limiti ed evidenze). Media 3.8/5; priorità successiva è il
collaudo Homebrew disposable, non una nuova prova sui dati reali.

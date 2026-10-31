# OpenCode Team 0.3.7 — final release readiness

> Fotografia rc2 conservata. La consegna successiva, con digest ottimizzato,
> budget operativo 120 s, qualifica 30/30 e decisione RETIRE del solo job
> runtime-gc, è in [final delivery](opencode-team-037-final-delivery.md).
> I checksum e i comandi rc2 sotto non identificano il nuovo artefatto.

## 1. Executive summary e decisione

Verifica del 29 ottobre 2026, proseguita dagli audit precedenti senza riscriverli.
**Non è stata pubblicata o installata una release stabile.** Il risultato rimane
una candidata locale **0.3.7-rc2**, VERSION runtime `0.3.7`.

| Livello | Stato | Significato e limiti |
|---|---|---|
| A. CODE READY | **PASS funzionale** | Regressioni isolate e review completate; non certifica capacità sotto carico o installazione Homebrew. |
| B. RELEASE READY | **BLOCKED** | Installazione Homebrew completa non raggiunta, budget operativo non qualificato e una decisione legacy aperta. Non pronta per produzione. |
| C. PRODUCTION VERIFIED | **PENDING** | Installato ancora 0.3.6; nessun deploy né prima esecuzione schedulata della candidata. |

**Non tutti i controlli sono PASS:** il benchmark finale ha **19 snapshot riusciti
e 1 timeout su 20 tentativi**. Il default di 30 secondi resta invariato e non è
dimostrato affidabile sotto il carico osservato. Il timeout nuovo è attribuito al
digest logico; **non dimostra la causa del timeout storico**.

Nessun `cleanup run` reale, kickstart, bootstrap, bootout, upgrade globale, push,
tag, release remota, restore DB o cancellazione di dati/snapshot/cache reali.

## 2. Stato Git e responsabilità dei cambiamenti

- Repository: `/Users/thomasd/Sites/Github/brew-opencode-team`.
- Branch iniziale e finale: `master`; HEAD invariato:
  `10614f66669c1259ce6d9827c90e11864f705a72`.
- VERSION era già `0.3.7` all'inizio di questo mandato; non attribuito a questa fase.
- Working tree già modificato: manutenzione, test, guardrail, packaging e CI della
  stabilizzazione precedente. Conservati, non resettati né attribuiti interamente
  al nuovo intervento. Nessun commit creato.
- Non modificati i due documenti personali untracked
  `docs/best-graphify-evaluation.md` e `docs/best-quota-abc-evaluation.md`.
- Audit storico e rapporto di stabilizzazione preservati. Questo documento è la
  fotografia successiva, non una sostituzione delle loro evidenze.

Interventi di questa fase:

- `shared/maintenance.py`: identità e timestamp dei report, senza nuova attività DB.
- `shared/profiles.mjs`, `tests/native-profiles.test.mjs`: lifecycle legacy esplicito.
- `shared/maintenance_evidence.py`, `tests/test_maintenance_evidence.py`: controllo
  baseline/post-esecuzione read-only e regressioni.
- `tests/benchmark_maintenance.py`, `tests/test_benchmark_maintenance.py`: benchmark
  riproducibile e controllo della completezza della matrice.
- `tests/homebrew-isolated.sh`, `tests/code_rollback.py`: prove isolate aggiuntive.
- `tests/guardrail/runner.sh`: integrazione delle prove nel confine esistente.
- `tests/test_maintenance.py`: regressione dell'identità del run.
- `.github/scripts/render-staging-formula.rb`: inclusione dei test evidence nel package.
- `README.md`, `completions/_opencode-team`, `docs/maintenance/timeout-benchmark.md`:
  changelog candidato, CLI e istruzioni.
- `.gitignore`: esclusione delle evidenze private persistenti generate localmente.

Formula stabile e workflow CI conservano rispettivamente il pin 0.3.6 e le
modifiche preesistenti; nessuna promozione automatica della formula.

## 3. Artefatti, riproducibilità e checksum

Directory **persistente nel repository, privata e ignorata da Git**:

```text
.local-release-evidence/0.3.7-rc2-nocrcyd1/
```

Non cancellarla durante cleanup locali; conservarne una copia approvata prima
della distribuzione. Non contiene copie dei DB reali: soltanto software,
metadata di verifica e log diagnostici.

| Artefatto | Verifica |
|---|---|
| `opencode-team-0.3.7-rc2.tar.gz` | 108926 byte, 38 file regolari, due build normalizzate byte-identiche |
| `candidate-manifest.json` | Hash e mode dei 38 file, base Git, `dirty_source=true` |
| `SHA256SUMS` | Digest dell'archivio candidato |
| `opencode-team-candidate.rb` | Formula locale con versione, URL file e SHA esatti |
| `opencode-team-0.3.6-installed-code.tar.gz` | Nove file software precedenti, senza dati/configurazioni personali |
| `previous-code-manifest.json`, `formula-0.3.6.rb` | Provenienza/hash del codice precedente e formula immutabile conservata |
| `predeploy-baseline.json`, `launchagents-before-deploy.json` | Evidenza reale raccolta esclusivamente in lettura |
| `final-*.log`, `readiness-*.log`, `benchmark-results-final.json` | Successi, fallimenti e verifiche interrotte, non soltanto output verdi |

SHA-256 candidata:

```text
58a3aa285a0c705b58a64dd664a303865496bb83948e7c813df888da2a32f2f9
```

SHA-256 archivio del **solo codice installato 0.3.6**, non dell'archivio GitHub:

```text
d6b460ed13d05e100b1406925a14d7bebdb5380ff4b7c43022856f09c2a1d8bd
```

L'archivio rc1 storico è ancora integro: verificati SHA e tutti i 32 membri.
Non è stato sovrascritto. Rc2 include i cambiamenti successivi, verificati dal
**suo archivio estratto**, con parità dei 38 hash anche rispetto al working tree.
Tar/gzip ordinati, uid/gid/mtime normalizzati; esclusi link, traversal, stato,
cache, `.git` e documenti personali. I rapporti sono esterni all'archivio per
evitare checksum circolari. Non è un archivio legato a un nuovo commit/tag.

## 4. Ambiente e compatibilità

macOS 26.6.2, Homebrew ARM in `/opt/homebrew`. Codice Homebrew letto dalla
revisione locale `3ef701b4e99c9b36985d12df36ec25742e9abc0a`.

- `/usr/bin/python3`: **3.9.6**, interprete reale del LaunchAgent.
- `/opt/homebrew/bin/python3.13`: **3.13.14**, usato nella matrice protetta finale.
  Non confuso con il Python 3.13.5 dell'ambiente di sviluppo.
- `/opt/homebrew/opt/node@22/bin/node`: **22.23.4**, CLI e figli testati con quel
  PATH; non soltanto con il Node predefinito della macchina.
- Nessuna nuova dipendenza runtime: stdlib Python, Node e `plutil` nativo macOS.
  Dipendenze formula ancora `git`, `node@22`, `uv`.

Lo script candidato ha SHA:
`20155386329b040d239f39f311b32b594daa347e53f76dee572fda0b90e0340c`.
Installato ancora SHA:
`9c9f902b9ae8bb711de83ddbe1c43d29e18323ec5409eb7dcb3f892a64e02d5a`.
I nove file software trattenuti sono stati ricontrollati: installazione reale
invariata rispetto alla raccolta precedente.

## 5. Homebrew reale: BLOCKED, non installazione PASS

Eseguito realmente, attraverso il runner protetto:

```sh
bash tests/guardrail/runner.sh homebrew
```

La prova copia **il file** `bin/brew` in un prefix temporaneo separato: un symlink
avrebbe potuto risolvere il repository/Cellar originale. Codice e core Homebrew
sono condivisi in lettura; prefix, Cellar, tap, HOME, cache, log, lock e temp sono
separati. Prima dell'installazione sono verificati `brew --prefix` e `--cellar`.
Niente dipendenze ignorate, nessun sudo o scrittura al prefix originale.

L'opt-in Homebrew supportato `HOMEBREW_AVOID_NESTED_SANDBOXING=1` riconosce la
sandbox già presente: **non disabilita il guardrail esterno**. Auto-update,
cleanup e analytics disabilitati; autenticazione non interattiva, rete negata.
Supervisore con limite 180 s e reap del process group; nessun retry non protetto.

Risultato del vero resolver/installer:

- configurazione custom-prefix **Tier 3**;
- prefix di 105 caratteri, alcune bottle rilocabili al massimo in 13: Homebrew
  propone build da sorgente per gettext/pkgconf/git/openssl;
- 24 dipendenze richieste;
- primo download GHCR fallito nella sandbox:
  `https://ghcr.io/v2/homebrew/core/json-c/manifests/0.19-1`, host non risolvibile;
- `HOMEBREW_RESULT=BLOCKED phase=install`, exit **3**.

Non aggirato il blocco con altro prefix reale, rete aperta, bottle forzate,
dipendenze ignorate o falsi receipt. Il package candidato non è stato installato
dal vero Homebrew. **Brew test, linking/unlinking e uninstall reali non sono stati
raggiunti**; non dichiarati PASS. Nessun keg candidato da disinstallare nello
staging fallito (NOT APPLICABLE a quell'istanza, non un test di uninstall superato).

Alternative completate: installazione Ruby DSL mock, byte/mode degli asset,
wrapper/versione/errori CLI, smoke del package installato in fixture. Non sono
una sostituzione del collaudo mancante. Serve un macOS disposable con prefix
supportato, dipendenze disponibili e isolamento qualificato, incluso il rapporto
fra sandbox Homebrew e runner: il vero `brew test` rimane da dimostrare.

## 6. Regressioni finali e conteggi

Comandi eseguiti dalla candidata estratta, sempre tramite il runner:

```sh
bash tests/guardrail/runner.sh
bash tests/guardrail/runner.sh compatibility
bash tests/guardrail/runner.sh benchmark
bash tests/guardrail/runner.sh rollback ARCHIVIO_CODICE_036 MANIFEST_CODICE_036
```

| Gruppo, senza sommare ripetizioni | PASS | FAIL | SKIP |
|---|---:|---:|---:|
| Controlli negativi kernel/entrypoint | 13 | 0 | 0 |
| Manutenzione Python | 56 | 0 | 0 |
| Controllo evidence | 15 | 0 | 0 |
| Controllo matrice benchmark | 1 | 0 | 0 |
| Node native profiles / CLI / LaunchAgent mock | 50 | 0 | 1 |
| Node cache fixture | 3 | 0 | 0 |
| Node Hybrid fixture | 5 | 0 | 1 |
| Node packaging | 4 | 0 | 0 |
| **Totale casi di regressione distinti** | **147** | **0** | **2** |

**149 casi**, di cui due opzionali non eseguiti: evaluator V2 nativo ed export
Hybrid reali. Non contati come PASS. Smoke ripete test Python/Node e non gonfia
il totale. Matrice aggiuntiva Python 3.13: 56 + 15 PASS; Node 22: 62 PASS, 2 SKIP.

Ulteriori prove, conteggiate separatamente:

- sette scenari release mock PASS;
- tre selezioni codice 0.3.7 → 0.3.6 → 0.3.7 e rimozione del solo codice nuovo
  in fixture: **quattro controlli PASS**, dati sentinella preservati; non Homebrew
  uninstall e non rollback di DB;
- benchmark: **19/20 successi, un timeout**, exit 1;
- Homebrew reale: **un tentativo BLOCKED**, non FAIL funzionale attribuito al package.

Due prime esecuzioni parallele della regressione/compatibilità sono state
interrotte dal timeout del tool a 360 s. Nessun PASS attribuito a quei log parziali.
Verificata assenza di processi residui appartenenti ai due staging; rieseguite
**in seriale** con limite adeguato, entrambe exit 0. Log parziali conservati.

Ruff selettivo `E4,E7,E9,F,D301,D400,D415,D419`, sintassi Python/Bash/Node/Ruby,
actionlint e `git diff --check`: PASS. Ruff completo: ancora **24 rilievi di stile**
nei due Python preesistenti (6 + 18); nuovi Python zero. Non dichiarato lint
completo verde. Coverage percentuale, type check completo, power-loss fisico,
dominio launchd separato reale e CI remota: **non eseguiti**.

RED/GREEN conservati: identità del run (`KeyError: run_id` prima del fix), ragione
diagnostica evidence (`KeyError: error_reason`), matrice incompleta che restituiva
exit 0. Review indipendente ha richiesto e verificato correzioni per loaded senza
plist, intent erroneamente dichiarati ritirati e cross-filesystem prima di bootout.
Nessun finding bloccante statico residuo; non è una review della futura notte.

## 7. Isolamento effettivo

Riusato il guardrail qualificato precedente, non sostituito da HOME temporaneo:
ambiente allowlist, HOME/team/temp/TMPPREFIX nello staging, deny reale HOME/account
e team esterno, scritture fuori staging negate, rete negata, entrypoint manutenzione
reali bloccati. I 13 controlli negativi precedono ogni suite funzionale.

Nuovi test importano i guard o verificano esplicitamente lo staging; i comandi
esterni sono mockati tranne gli interpreti/probe esplicitamente confinati.
Il benchmark riusa la root privata del test di manutenzione; nessun DB reale
copiato nel benchmark o aperto in RW. Il rollback usa esclusivamente software.

Restano letture di sistema/toolchain e mach-lookup ampi: non è una sandbox
universale per codice ostile, né una prova contro ogni IPC possibile.

## 8. Benchmark: distribuzioni e timeout osservato

Fixture sintetiche da **105406464** e **736198656** byte, rispettivamente 100 e
650 sessioni. Payload distinti SHAKE256; due budget × cinque tentativi per volume.
WAL quiescente, non un benchmark con writer/reader attivi. Contesa WAL/reader/
writer/busy, PASSIVE, reclaim e interruzioni sono coperte dalle regressioni SQLite.

Ultima matrice, contemporanea ad altri collaudi locali:

| Volume | Budget | Successi/tentativi | Totale min / mediana / p95 / max dei soli successi, ms |
|---|---:|---:|---|
| 105 MB | 30 s | 5/5 | 984.7 / 1145.4 / 1309.9 / 1309.9 |
| 105 MB | 120 s | 5/5 | 908.5 / 1106.7 / 1145.6 / 1145.6 |
| 736 MB | 30 s | **4/5** | 7095.1 / 8604.9 / 8981.0 / 8981.0 |
| 736 MB | 120 s | 5/5 | 9461.4 / 15434.6 / 16179.8 / 16179.8 |

Il quinto tentativo grande/30 s fallisce con:

```json
{"elapsed_ms":30181.3,"phase":"logical","reason":"logical-checksum-deadline","rep":4}
```

Non escluso dal verdetto: cella `incomplete`, benchmark exit **1**. Il p95 di
8.981 s è **condizionato ai quattro successi**, non rappresenta il tentativo
fallito. Una precedente matrice senza quel picco aveva 20/20 successi: entrambe
le evidenze sono conservate, nessuna scelta selettiva per ottenere PASS.

Dettaglio grande/120 s, cinque successi, ms:

| Misura | Min | Mediana | p95/max |
|---|---:|---:|---:|
| Inventario, probe indipendente | 0.1 | 0.1 | 0.2 |
| Inventario + validazione precedenti | 3.6 | 1637.9 | 3448.2 |
| SHA precedenti, aggregato | 0.0 | 1162.2 | 2331.5 |
| Backup online | 1190.5 | 2457.5 | 2848.9 |
| Quick-check nuovo DB | 876.3 | 956.6 | 1387.7 |
| Digest logico | 5345.0 | 7769.8 | 12315.8 |
| SHA nuovo DB | 302.2 | 528.3 | 542.3 |
| fsync, wrapper aggregato | 0.0 | 0.1 | 0.1 |
| Pubblicazione, include fsync | 1.4 | 1.8 | 2.0 |
| Retention | 0.2 | 0.3 | 10.7 |

Misure annidate, **non additive**; con n=5 il p95 nearest-rank coincide col max.
Fsync non misura F_FULLFSYNC né durabilità dopo power-loss. Fixture rappresentative
di volume, non dello schema/distribuzione righe reali o di ogni carico notturno.
Le verifiche finali di checksum/ripristino/conteggio sessioni delle quattro celle
sono positive; non trasformano in successo lo snapshot andato in timeout.

**Budget operativo: rischio aperto, prova sotto carico FAIL.** Nessun aumento del
default 30 s; `--timeout` Python rimane configurabile e cooperativo. Non è una nuova
opzione inoltrata dal wrapper cleanup né dal plist attuale. Un futuro budget
schedulato diverso richiede una decisione/configurazione gestita approvata, non
una modifica manuale nascosta del receipt. Il nuovo caso isola una fase; non
attribuisce retroattivamente la causa del TimeoutError del 29 ottobre alle 04:15.

## 9. Inventario e classificazione LaunchAgent

Tutti gli otto plist presenti. Query read-only salvate in
`launchagents-before-deploy.json`; sorgente 0.3.7 `cleanup legacy-status` ha
confermato sei plist validi/loaded e **zero ritirati**, senza cambiamenti.

| Label (legacy prefisso `it.danilodantoni.opencode-team.`) | Stato / runs / ultimo exit | Decisione |
|---|---|---|
| `io.opencode-team.safe-caches` | loaded / 3 / 1 | **KEEP**, upgrade del solo codice |
| `host-storage-gc` | loaded / 110 / 1 | **RETIRE**, previa approvazione |
| `runtime-gc` | loaded / 20 / 1 | **UNRESOLVED**, non approvare ancora |
| `version-check` | loaded / 41 / 1 | **RETIRE**, previa approvazione |
| `openai-retention` | loaded / 20 / 1 | **RETIRE**, previa approvazione |
| `playwright-gc` | loaded / 110 / 1 | **RETIRE**, previa approvazione |
| `best-tool-output-gc` | loaded / 20 / 1 | **RETIRE**, previa approvazione |
| `best-retention` | non loaded, query 113 / runs-exit non disponibili | **RETIRE già dismesso**, conservare plist/log |

Safe-caches: `/usr/bin/python3` e script nel symlink opt Homebrew; calendario
04:15, log aggregato già noto. Sei legacy: `/opt/homebrew/bin/opencode-team
maintenance <job>`, ancora incompatibile con 0.3.7. Best-retention: Python gestito
e `~/.local/bin/opencode-cleanup --v2 --v2-standalone --v2-apply --v2-upgrade-confirmed`.

Origini ricostruite da Git locale, distinguendo VERSION del commit e primo tag
locale contenente quel codice (non una nuova verifica delle release remote):

| Job | Primo codice / VERSION / primo tag locale | Funzione e sostituzione |
|---|---|---|
| safe-caches | `37d5451` / 0.3.4 / v0.3.5 | Job owned; SQLite unificato esteso in `6fea24f` / 0.3.6, corretto in candidata 0.3.7 |
| host-storage-gc | `bf020f6` / 0.1.29 / v0.1.30 | Chrome clone, Docker storage; safe-caches 0.3.6 sostituisce solo cache/build cache, non immagini/volumi/clone |
| runtime-gc | `5f81ffd` / 0.1.10 / v0.1.11 | GC/rotazione lifecycle classico; nessun equivalente automatico corrente |
| version-check | `3efb1c5` / 0.1.45 / v0.1.45 | GitHub/notifiche; sostituzione parziale con updates informational 0.3.6 |
| openai-retention | `65b0689` / 0.1.1-dev / v0.1.1 | Cancellazione sessioni OpenAI; deliberatamente non sostituita |
| playwright-gc | `bf020f6` / 0.1.29 / v0.1.30 | GC output/revisioni Playwright; deliberatamente non ripristinato |
| best-tool-output-gc | `65b0689` / 0.1.1-dev / v0.1.1 | GC tool output BEST; conservazione dati prevale |
| best-retention | `65b0689` / 0.1.1-dev / v0.1.1 | Tool legacy distinto, non gestito dal nuovo ritiro |

Dispatcher rimosso in `cfa4016`, VERSION 0.2.0. Owner dei sei dispatcher: vecchio
codice prodotto `shared/maintenance` e moduli core/team; owner attuale del solo
safe-caches: `shared/profiles.mjs` + `shared/maintenance.py`. Non tutti i label
sono nati insieme nel primo framework di manutenzione.

**Runtime-gc resta aperto:** sono stati osservati runtime classici ancora attivi.
Non è corretto dedurre dal comando fallito che tutti i suoi vecchi target siano
spariti. Non fermati processi o analizzati/cancellati i loro dati. Va chiarita la
necessità del housekeeping legacy con il proprietario; fino ad allora è
un'eccezione esplicita al requisito «nessun job unsupported loaded».

Per gli altri rifiuti di cancellazione la scelta RETIRE deriva dalla policy di
conservazione e dal nuovo perimetro del prodotto, non dal solo exit 1. Rischio
residuo: accumulo spazio e perdita della vecchia UX di notifica. Dipendenze esterne
ai job esaminati non qualificate esaustivamente; richiedono decisione operatore.

## 10. Upgrade legacy implementato, non applicato

```sh
opencode-team cleanup legacy-status
opencode-team cleanup legacy-retire LABEL --approve
```

Setup/upgrade non invocano mai il secondo comando. Sei label tecnicamente
riconosciuti, **non sei autorizzazioni di dismissione**: per runtime-gc la decisione
funzionale rimane aperta. Best-retention esplicitamente escluso.

Controlli: HOME login, label/argv prodotto esatti, niente Program alternativo,
owner/link/perms, receipt con path/hash/argv validi, loaded path coerente,
filesystem compatibile prima di bootout, archivio privato mai sovrascritto.
Un label loaded senza plist è rifiutato anche con receipt completo/parziale.
Plist spostato nell'archivio, mai eliminato; intent conservato se un errore segue
bootout, retry verificato per hash. Stato «retired» solo con archivio verificato
e label non loaded. Nessuna wildcard o modifica a servizi estranei.

L'azione scrive lock/receipt di migrazione e archivio sotto lo state prodotto;
non promette immutabilità di quei metadata di controllo. Preserva log, stato dei
vecchi tool, DB, sessioni e backup. Test con plutil reale su fixture e launchctl
mockato; nessun dominio launchd reale creato/modificato.

Rollback del servizio, se mai approvato separatamente: controllare hash e assenza
di plist concorrente, ripristinare i byte archiviati nella posizione originaria,
poi bootstrap del **solo label approvato**. Non parte del rollback codice e non
riabilita automaticamente best-retention o job che cancellano sessioni.

## 11. Preservazione dati e incidente storico

Nuova baseline reale esclusivamente read-only, ore **16:30:30 UTC**:

- installato 0.3.6, loaded, runs 3, ultimo exit 1;
- log device 16777230, inode **288010779**, size/offset **3149**;
- prefisso log SHA `1e049fbc89871abd115d61fcecd1b82c9d63bde9cd3f9f1401e19f1ca2cb15b4`;
- quattro snapshot, manifest/SHA/quick-check immutable validi, zero artefatti ignoti.

Nessuna connessione SQLite ai DB live. Snapshot reali soltanto letti immutable;
rollback e fault injection solo su fixture. Nessuna nuova mutazione di manutenzione
sui dati reali eseguita. L'attività ordinaria dell'app può continuare a scrivere
i suoi DB: non viene attribuita a queste verifiche né dichiarata byte-immutabile.

L'incidente dei cinque run rimane documentato nei rapporti precedenti. Inclusione
dei 654 ID nelle due copie da 661 sessioni è evidenza limitata, non una garanzia
globale sui contenuti. Effetti cache e rimozioni precedenti non integralmente
ricostruibili; nessun restore/rollback dati tentato per cancellare l'incidente.

## 12. Piano di distribuzione — DA APPROVARE, NON ESEGUITO

Prerequisiti bloccanti: collaudo Homebrew completo in ambiente disposable,
decisione budget dopo il timeout osservato, decisione runtime-gc ed eventuali
eccezioni, revisione del commit approvato e checksum ufficiale. Il changelog
candidato è nel README. URL previsto, **non pubblicato/verificato**:

```text
https://github.com/ThomasDanilo96/homebrew-opencode-team/archive/refs/tags/v0.3.7.tar.gz
```

Formula stabile ancora v0.3.6/SHA ufficiale
`3f3fb7be10d4dd116307b264ed315dbe146409ed770072f82dd18e17c1847f0d`.
Non copiare il SHA locale rc2 sotto l'URL GitHub: quello ufficiale è **PENDING**.
Nessun riuso/modifica del tag 0.3.6. Commit/tag/push/release e upgrade richiedono
autorizzazione; conservare i cambiamenti preesistenti senza un `git add .` indiscriminato.

Procedura futura, solo dopo approvazione e chiusura dei gate:

```sh
REPO=/Users/thomasd/Sites/Github/brew-opencode-team
umask 077
BASE="$HOME/.local/state/opencode-team/release-evidence"
mkdir -p "$BASE"
EVIDENCE="$(mktemp -d "$BASE/037.XXXXXXXX")"
/usr/bin/python3 -B "$REPO/shared/maintenance_evidence.py" baseline --output "$EVIDENCE/predeploy.json"
opencode-team version
shasum -a 256 /opt/homebrew/opt/opencode-team/libexec/shared/maintenance.py
/bin/launchctl print "gui/$(id -u)/io.opencode-team.safe-caches"
```

Conservare anche gli otto stati e il software precedente come negli artefatti
di questa fase. Non basta una baseline temporanea: gli output di deploy devono
rimanere in un percorso persistente privato. Eseguire l'upgrade soltanto con
versione 0.3.7 già pubblicata/approvata e formula/checksum qualificati:

```sh
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=Never SSH_ASKPASS_REQUIRE=never
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.interactive GIT_CONFIG_VALUE_0=false
export GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o NumberOfPasswordPrompts=0 -o ConnectTimeout=15'
HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 \
  brew upgrade --formula ThomasDanilo96/opencode-team/opencode-team
test "$(opencode-team version)" = 'OpenCode Team 0.3.7'
test "$(command -v opencode-team)" = /opt/homebrew/bin/opencode-team
shasum -a 256 /opt/homebrew/opt/opencode-team/libexec/shared/maintenance.py
/usr/bin/plutil -p "$HOME/Library/LaunchAgents/io.opencode-team.safe-caches.plist"
opencode-team cleanup status
opencode-team cleanup legacy-status
```

Hash script atteso per **questi byte**: `20155386329b040d239f39f311b32b594daa347e53f76dee572fda0b90e0340c`.
Fermarsi se artefatto/versione/hash/comando/interprete/HOME/PATH differiscono.
Non chiamare setup, cleanup run o kickstart per completare il deploy. Il job KEEP
usa già il percorso opt stabile: nessun reload preventivo necessario se plist e
receipt rimangono identici. Ogni ulteriore modifica ai servizi richiede approvazione.

Solo per singoli label con decisione RETIRE approvata e job non in esecuzione:

```sh
opencode-team cleanup legacy-retire it.danilodantoni.opencode-team.host-storage-gc --approve
opencode-team cleanup legacy-retire it.danilodantoni.opencode-team.version-check --approve
opencode-team cleanup legacy-retire it.danilodantoni.opencode-team.openai-retention --approve
opencode-team cleanup legacy-retire it.danilodantoni.opencode-team.playwright-gc --approve
opencode-team cleanup legacy-retire it.danilodantoni.opencode-team.best-tool-output-gc --approve
opencode-team cleanup legacy-status
```

Non eseguire quella lista come batch non approvato; runtime-gc escluso finché
UNRESOLVED, best-retention non riattivato. Verificare unloaded, archivio/hash e
receipt per ciascun label; una seconda invocazione valida deve essere no-op.
L'approvazione deve chiarire anche la retention snapshot esistente (tre copie):
nessun pruning reale è stato eseguito per il collaudo e non sono autorizzate qui
nuove cancellazioni o variazioni della policy.

## 13. Rollback del solo codice

La prova isolata usa il vero codice 0.3.6 trattenuto, selezionando directory
software temporanee: 0.3.7 → 0.3.6 → 0.3.7, dati esterni sentinella identici.
Non prova il rollback Homebrew completo, ancora BLOCKED.

Per un eventuale rollback reale approvato: mantenere il keg precedente disabilitando
cleanup dell'upgrade, conservare formula/archivio ufficiale 0.3.6 e verificare i
checksum. Se occorre reinstallare il vecchio package, usare un tap rollback locale
con la **formula 0.3.6 originale**, non il renderer candidato contro l'archivio vecchio.
Il tap e l'uninstall/reinstall sono operazioni reali separate da approvare e da
qualificare prima in ambiente disposable. Esempio di sequenza, non eseguita:

```sh
brew tap-new --no-git opencode-team/rollback
# Copiare la formula-0.3.6.rb verificata nel Formula/opencode-team.rb di quel tap.
# Dopo nuova approvazione dell'interruzione del solo codice:
HOMEBREW_NO_INSTALL_CLEANUP=1 brew uninstall --formula ThomasDanilo96/opencode-team/opencode-team
HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 \
  brew install --formula opencode-team/rollback/opencode-team
test "$(opencode-team version)" = 'OpenCode Team 0.3.6'
```

Non improvvisare `brew switch`, force-link o sostituzioni manuali nel keg. Pianificare
fuori dalla finestra schedulata; non riabilitare legacy per rollback. Nessuna
migrazione DB da annullare, nessun ripristino delle conversazioni o cancellazione
dei nuovi snapshot. Il ritorno a 0.3.6 ripristina anche i suoi limiti diagnostici.

## 14. Prima esecuzione automatica delle 04:15

**PENDING.** La baseline predeploy 0.3.6 non deve essere usata come baseline di
una verifica che richiede codice invariato 0.3.7: acquisirne una seconda dopo
l'installazione approvata, prima della notte e quando il job non è in esecuzione.

```sh
CHECK=/opt/homebrew/opt/opencode-team/libexec/shared/maintenance_evidence.py
/usr/bin/python3 -B "$CHECK" baseline --output "$EVIDENCE/pre-0415.json"
# Attendere la vera esecuzione prevista; niente kickstart o cleanup run.
/bin/launchctl print "gui/$(id -u)/io.opencode-team.safe-caches"
# Solo a esecuzione conclusa:
/usr/bin/python3 -B "$CHECK" verify --baseline "$EVIDENCE/pre-0415.json" \
  --expected-version 0.3.7 \
  --expected-sha256 20155386329b040d239f39f311b32b594daa347e53f76dee572fda0b90e0340c \
  --output "$EVIDENCE/post-0415.json"
```

Il controllo è read-only sui dati, scrive soltanto il nuovo output esplicito:
inode/device/offset e SHA del prefisso log, append persistito, runs incrementati,
ultimo exit, otto task completi di uno stesso run ID, versione/hash, timestamp,
stati consentiti per task, motivazioni deferred, nuovi snapshot e integrità
immutable. Rotazione/troncamento, task duplicati/incompleti, codice cambiato o
errori non diventano successi. Più run fra baseline e verifica non permettono
di attribuire a tutti l'unico last-exit esposto da launchctl: falliscono chiusi.

Exit tool: 0 baseline, 1 evidenza fallita, 2 run/attribuzione PENDING. Anche con
`evidence_verdict=PASS`, `production_verdict` resta **PENDING** senza attribuzione
attendibile a launchd. Calendario e ora coerenti, loaded e runs **non bastano**.
Conservare un'osservazione di launchd sul label nella finestra reale, ad esempio
un'acquisizione read-only dei log unificati con start/end espliciti:

```sh
/usr/bin/log show --style json --start "$WINDOW_START" --end "$WINDOW_END" \
  --predicate 'process == "launchd" AND eventMessage CONTAINS "io.opencode-team.safe-caches"' \
  > "$EVIDENCE/launchd-window.json"
```

I valori WINDOW_START/END vanno fissati sulla notte osservata, con fuso registrato.
Non assumere che i log disponibili contengano il motivo calendariale: se manca,
è redatto o non accessibile, attribuzione **PENDING/BLOCKED**, non un PASS manuale.
Nessun parser inventato o flag per auto-attestare la schedulazione. Una condizione
locked/deferred non equivale al completamento di tutte le attività.

## 15. Evidenze riproducibili e blocchi residui

La directory privata contiene log seriali finali, log paralleli interrotti,
benchmark fallito, precedenti misure riuscite, RED/GREEN, baseline, inventario,
archivi e manifest. Per ripetere il rollback protetto, copiare prima i due file
**software** in un nuovo staging temporaneo approvato fuori da HOME e passare
quei percorsi al runner; il deny di HOME non va allentato.

Diagnostica reale eseguita: git status/branch/HEAD/log/tag/show; letture del codice
Homebrew locale, plist/metadata, launchctl print; baseline immutable; status legacy
read-only; hash dei nove file installati. Nessuna operazione di servizio in scrittura.

Restano:

1. **BLOCKED:** install/test/link/uninstall/rollback reali Homebrew in ambiente
   disposable supportato, senza allentare l'isolamento.
2. **FAIL capacità osservata:** un timeout logical su fixture grande/30 s;
   budget configurabile, ma nessuna affidabilità notturna dimostrata.
3. **PENDING:** decisione runtime-gc e qualificazione delle dipendenze legacy.
4. **PENDING:** commit/artefatto ufficiale/checksum/promozione approvati, deploy,
   corrispondenza installata e prima vera notte con attribuzione attendibile.
5. **Non ricostruibile integralmente:** incidente storico, senza cancellarne le evidenze.

**Decisione: codice funzionale verificato, candidata conservata; NO-GO alla
release stabile/produzione finché questi gate non sono chiusi.**

Autovalutazione: accuratezza 4/5 (nessuna attribuzione retroattiva del timeout),
completezza 3/5 (Homebrew, budget e notte non chiusi), chiarezza 4/5 (esiti separati),
azionabilità 4/5 (artefatti e procedura disponibili, ma soggetti ad approvazione),
concisione 3/5 (rapporto esteso per preservare evidenze e limiti). Media 3.6/5.
Priorità: collaudo Homebrew disposable e decisione sul budget, non prove mutanti
sull'installazione in uso.

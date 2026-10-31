# OpenCode Team 0.3.7 — consegna operativa finale

## Chiusura gate release — 30 ottobre 2026

**Homebrew BLOCKED per infrastruttura macOS disposable non disponibile.**
Verifica locale mirata, senza nuovi tentativi di installazione equivalenti:
`tart`, `utmctl`, `prlctl`, `VBoxManage`, `qemu-system-aarch64`, `vfkit`,
`limactl` e `podman` non presenti nel PATH; assenti le applicazioni UTM,
Parallels Desktop, VMware Fusion, VirtualBox e OrbStack nei percorsi standard.
Docker disponibile: `docker --context desktop-linux info` riporta
**linux/aarch64, Docker Desktop**, non un guest macOS. Non qualifica bottle,
interprete sistema o launchd macOS. Nessun endpoint Mac remoto disposable fornito
o verificato: la presenza di SSH non è disponibilità di un host autorizzato.
Non cercate credenziali, non avviate/installate VM né modificato Homebrew host.
Questa è l'infrastruttura effettivamente accessibile verificata, non una prova
dell'inesistenza di altri Mac o hypervisor fuori dai percorsi controllati.

Evidenza persistente: `.local-release-evidence/release-gate-20261030/preflight.json`.
SHA archivio atteso confermato, **38/38 membri** e VERSION 0.3.7 verificati;
**zero differenze** fra membri qualificati e sorgenti correnti. Formula locale
coerente con file URL/versione/SHA e dipendenze git/node@22/uv. Wrapper Node,
Python con default operativo 120 s e compatibilità manifest sono gli stessi byte
già qualificati: riusate le evidenze precedenti, **nessuna suite rieseguita** e
nessun archivio ricostruito. Nessuna nuova prova installazione dichiarata PASS.

Per chiudere il gate serve un guest **macOS ARM disposable**, con Homebrew nel
proprio `/opt/homebrew`, senza mount del Cellar/HOME host, servizi o dati personali.
Predisporre tap/dipendenze/cache sincronizzati nel guest prima del test protetto;
trasferire soltanto i file software qualificati e verificarne SHA. Rigenerare
soltanto la formula di staging per il file URL del guest, mantenendo SHA archivio:

```sh
ruby .github/scripts/render-staging-formula.rb Formula/opencode-team.rb \
  "$STAGING_FORMULA" OpencodeTeamCandidate 0.3.7 \
  "$CANDIDATE_FILE_URL" \
  1700612252f8983cb36e3bf61697232e6540a4ce90e11f66d340d8c5d2bb5263
```

STAGING_FORMULA deve essere il file nel tap locale disposable; CANDIDATE_FILE_URL
il file URL dell'archivio trasferito. Non riusare il percorso HOME del Mac host.
Il target `homebrew` corrente crea un prefix lungo: **non risolve quel vincolo
il solo trasferimento in una VM**. Prima di eseguire il ciclo, adattare nel guest
il confinamento del runner a un prefix supported disposable e qualificare i
controlli negativi; non eseguire install/test/uninstall fuori dal runner. Nessuna
deroga della sandbox host o check di integrità. Poi provare il ciclo Homebrew
completo già specificato sotto, con receipt, hash, link e uninstall verificati.
Quell'adattamento non è stato eseguito o dichiarato qualificato senza il guest.

**Commit/tag:** non creati né staged; proposta commit
`fix: qualify 0.3.7 maintenance and release packaging`, tag previsto `v0.3.7`.
Restano da approvare dopo il gate Homebrew; vietato includere indiscriminatamente
documenti personali o evidenze private. L'archivio ufficiale non esiste ancora
come output di questo mandato: checksum ufficiale PENDING, formula pubblica
non promossa. Procedura di pubblicazione: approvare commit e tag, pubblicare solo
con autorizzazione separata, acquisire l'archivio ufficiale effettivo, verificarne
membri/versione e digest, quindi aggiornare e qualificare la formula ufficiale.
Il digest del tar locale **non sostituisce** quello dell'archivio GitHub.

Deploy/rollback e verifica prima notte: procedura sotto invariata, nessuna azione
reale. Gate finali: **CODE READY PASS; RELEASE READY BLOCKED; PRODUCTION VERIFIED
PENDING**. Non c'è un nuovo difetto applicativo dimostrato da correggere.

## Esito

| Gate | Stato |
|---|---|
| CODE READY | **PASS**: regressioni, compatibilità, checksum e qualifica 30/30 |
| RELEASE READY | **BLOCKED**: ciclo Homebrew reale install/test/uninstall non completato |
| PRODUCTION VERIFIED | **PENDING**: nessuna installazione o notte automatica della nuova versione |

Preparata **0.3.7 final-candidate**, non denominata stabile. Nessun commit, tag,
push, pubblicazione, deploy, dismissione reale o manutenzione sui dati reali.
Gli audit e l'incidente storico restano conservati; questo documento aggiorna,
non cancella, la fotografia rc2 del precedente readiness.

## Problemi chiusi e prestazioni

- **Digest lento:** profiling della fixture 736198656 byte/650 sessioni:
  fetch 0.458 s, repr 3.739 s, encoding 0.106 s, hashing 0.775 s,
  sorting 0.000097 s. Ottimizzata la serializzazione BLOB con hashing incrementale
  dello **stesso byte stream repr**, senza cambiare algoritmo o manifest.
  Oracle rc2, casi scalari/Unicode/BLOB/duplicati/rowid e riuso manifest verificati.
- **Prima/dopo**, cinque snapshot per variante: mediana logical **4.523 → 3.424 s**,
  totale **7.779 → 6.665 s**, picco allocazioni Python **8931060 → 6346895 byte**.
  Il confronto cambia soltanto il digest; la correzione WAL è comune alle varianti.
- **Starvation backup WAL:** commit concorrenti potevano riavviare il backup.
  Transazione read-only sul sorgente prima delle letture metadata, rilasciata
  immediatamente dopo il backup. Regressione deterministica RED → GREEN.
- **Qualifica:** **30 snapshot consecutivi riusciti**, dieci idle, dieci con
  reader WAL + writer ogni 50 ms, dieci anche con worker SHA e rewrite/fsync 8 MiB.
  Verificati checksum e 650 sessioni per snapshot. Mediane/max: idle 7.068/7.222 s,
  WAL 7.198/7.731 s, WAL+CPU/I/O 7.367/7.831 s. Contatori: 2571 commit,
  130616 hash e 1206 fsync di carico.
- **Budget operativo finale: 120 s**, default autorevole Python ereditato da CLI
  e job, override finito positivo disponibile. Il precedente batch completo 30/30
  aveva massimo **88.141 s** sotto variabilità host: margine 31.859 s, **36.1%**.
  Non scelto ignorando i campioni lenti; 30 s non qualificato. Il default low-level
  `snapshot(..., budget=30)` resta compatibile, main passa sempre il budget operativo.
  Deadline cooperativa, non garanzia hard-real-time o statistica di produzione.

Dettagli, tentativi falliti e limiti: [timeout-benchmark.md](timeout-benchmark.md).

## Homebrew: blocco dimostrato, non equivalente a PASS

Riusati in sola lettura keg/receipt originali, dipendenze risolte da `brew deps`
nativo, nessun parser alternativo o dipendenza ignorata. Corretti nel collaudo
controllo receipt/glob e gestione fail-closed dell'exit install.

`integration-homebrew.log`: exit **3**, `BLOCKED phase=install`. Il tap core
`4e7f920312c` dichiara versioni diverse dal Cellar: per esempio Node 22.23.3_3
contro 22.23.4, uv 0.13.1 contro 0.13.5, brotli 1.2.0 contro 1.2.1.
Il resolver richiede download GHCR (fra cui json-c 0.19), rete negata dalla sandbox.
Il prefix temporaneo lungo 105 caratteri supera anche il limite di rilocazione
di alcune bottle (13). Il checkmark fetch della candidata **non prova installazione**.

Piano eseguibile mancante: su **Mac/VM disposable** con prefix ARM `/opt/homebrew`,
tap e dipendenze sincronizzati, predisporre Homebrew e cache prima del collaudo;
trasferire archivio/formula locale verificati. In quell'ambiente separato eseguire
`brew install --formula opencode-team/staging/opencode-team-candidate`, `brew test
--force` della stessa formula, verifiche hash/versione/permessi/link e `brew uninstall`.
Qualificare la sandbox del test Homebrew senza disabilitare quella dei test prodotto.
Non è autorizzazione ad aggiornare Homebrew/tap sul Mac in uso o aprire la sandbox.

Formula **0.3.7 locale verificata** nell'artefatto sotto, con file URL e SHA corretti.
`Formula/opencode-team.rb` resta stabile 0.3.6: l'URL ufficiale previsto
`https://github.com/ThomasDanilo96/homebrew-opencode-team/archive/refs/tags/v0.3.7.tar.gz`
e il suo checksum non possono essere falsamente abbinati al tar locale.
Promozione della formula ufficiale dopo pubblicazione/byte ufficiali qualificati,
non un placeholder SHA né una modifica del tag 0.3.6.

## runtime-gc e lifecycle

**RETIRE del solo job**, con approvazione futura individuale. Codice originario
`5f81ffd:core/lib/runtime-lifecycle.mjs` e ultimo dispatcher `cfa4016^` letti:
GC di directory RECLAIMABLE e rotate log, non launcher/heartbeat. Non necessario
al funzionamento dei runtime, anche se vecchi runtime restano attivi. Target e
rischio di crescita disco documentati in [legacy-launchagents.md](legacy-launchagents.md).
Nessuna cancellazione migrata o riattivata; nessun consumer esterno dichiarato assente.
Lifecycle esplicito rc2 riutilizzato e regressioni staging superate; setup non
ritira job. Best-retention resta escluso e non riattivato.

## Verifiche finali, conteggi senza duplicare smoke

Solo `bash tests/guardrail/runner.sh TARGET`, con 13 negativi preventivi,
HOME/root/temp isolati, sandbox kernel e mock. Nessun test su dati reali.

| Casi distinti | PASS | FAIL | SKIP |
|---|---:|---:|---:|
| Guardrail / manutenzione / evidence / controllo benchmark | 13 / 59 / 15 / 2 | 0 | 0 |
| Node profiles / cache / Hybrid / packaging | 50 / 3 / 5 / 4 | 0 | 2 |
| **Totale regressioni: 153 casi** | **151** | **0** | **2** |

A parte: sette scenari release, tre casi receipt Homebrew e quattro controlli
rollback codice PASS; qualifica snapshot **30/30**. I due skip opzionali V2/Hybrid
non sono PASS. Python 3.13.14 e Node 22.23.4: compatibilità PASS; Python sistema
3.9.6 incluso nella suite. Smoke e suite dall'archivio estratto PASS.
Homebrew reale: **BLOCKED**, non sommato come test superato.
Ruff selettivo/sintassi/diff verificati; Ruff completo conserva **23 finding
preesistenti**, non dichiarato verde. Coverage e power-loss fisico non qualificati.

## Artefatti e repository

HEAD `10614f66669c1259ce6d9827c90e11864f705a72`, branch master, working tree non
committato, cambiamenti precedenti preservati. Documenti personali esclusi.

```text
.local-release-evidence/final-execution-digest/    # profiling, RED/GREEN, 30 run, suite
.local-release-evidence/final-execution-package/   # archivio, manifest, formula e suite estratta
```

Archivio `opencode-team-0.3.7-final-candidate.tar.gz`: **38 file**, due build
normalizzate byte-identiche, membri/hash verificati. SHA-256:
`1700612252f8983cb36e3bf61697232e6540a4ce90e11f66d340d8c5d2bb5263`.
Script Python SHA-256:
`5192672a5b2860b783a1dd871d43037cc134ed7ca270a7c72235ecda2ab475ed`.
Rc1/rc2 non modificati. Le evidenze private ignorate da Git vanno conservate.

Cambi di questa fase: `shared/maintenance.py`; test manutenzione, benchmark e
controllo benchmark; `tests/guardrail/runner.sh`; `tests/homebrew-isolated.sh` e
`tests/homebrew-workflow.test.sh`; README e tre documenti tecnici aggiornati,
oltre a questo riepilogo. Nessun nuovo runtime layer/dependency o script di upgrade
automatico: si riusano formula e lifecycle esplicito esistenti.

## Deploy e rollback — pronti alla revisione, non eseguiti

Riusare la procedura controllata §§12–14 del [readiness](opencode-team-037-final-release-readiness.md)
con queste **sostituzioni obbligatorie**: artefatto/hash di questa consegna, budget
default 120 s e runtime-gc RETIRE approvabile. Non usare gli hash rc2 nella verifica.

1. Chiudere il gate Homebrew disposable; approvare commit/release/formula ufficiali.
2. Prima dell'upgrade registrare versione/hash, conservare codice 0.3.6 verificato,
   otto stati launchd/runs/exit, plist, log inode/offset e snapshot read-only.
3. Upgrade Homebrew approvato con auto-cleanup disabilitato; nessuna modifica manuale
   al keg. Verificare VERSION 0.3.7, CLI, hash script, owner/perms e wrapper/link.
4. Verificare plist owned: `/usr/bin/python3`, script nel percorso opt corretto,
   HOME/PATH e calendario 04:15, receipt coerente. Nessun kickstart/cleanup run.
5. Ritirare soltanto label individualmente approvati con `legacy-retire LABEL --approve`;
   controllare unloaded/archivio/hash/receipt; non toccare dati o best-retention.
6. Acquisire baseline **post-deploy/pre-04:15** persistente; dopo la vera notte usare
   `maintenance_evidence.py verify` con SHA script sopra. Richiedere otto task,
   stessa identità, nuovi log/runs/exit e snapshot validi, motivi deferred e attribuzione
   attendibile a launchd. Senza attribuzione, produzione resta PENDING.
7. Rollback solo codice tramite formula 0.3.6 originale e artefatto trattenuto,
   separatamente approvato; nessun restore DB o riattivazione automatica legacy.

**Unico blocco tecnico di rilascio rimasto:** ciclo Homebrew reale completo
nell'ambiente disposable descritto. Approvazioni e osservazione della notte restano
necessarie; 30/30 e test verdi non autorizzano installazione o manutenzione reale.

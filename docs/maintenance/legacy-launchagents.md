# Legacy LaunchAgents — matrice e dismissione

## Decisione finale 0.3.7 (successiva alla fotografia sotto)

`runtime-gc`: **RETIRE del solo job schedulato**, previa approvazione reale.
Verificati con `git show 5f81ffd:core/lib/runtime-lifecycle.mjs` e
`git show cfa4016^:shared/maintenance/run-maintenance.sh` il codice introdotto
(VERSION 0.1.10, primo tag locale v0.1.11) e l'ultimo dispatcher prima della
rimozione 0.2.0. Non è un launcher, watchdog o servizio necessario ai runtime:
esegue soltanto `gc --apply` seguito da `rotate --apply`.

Target GC: `$RUNTIME_ROOT/runs/*` e `$RUNTIME_ROOT/{best,go,openai,daily}/runs/*`,
default `$CACHE_ROOT/runtime`. Rimuove directory dichiarate RECLAIMABLE solo dopo
controlli identità/processi/lock/file aperti. Rotate scorre quei run, i log
`$STATE_ROOT/maintenance/logs` e `$DATA_ROOT/<team>/{state/team/logs,data/opencode/log,logs}`;
ruota log/err/out/jsonl sopra 1 MB, tre rotazioni di default. Non è un heartbeat
né un prerequisito per avviare o mantenere attivi i runtime.

La decisione non richiede che i vecchi runtime o dati siano scomparsi: quelli
osservati attivi restano intatti. Ritirare il job non li ferma e non cancella i
target; comporta la rinuncia esplicita a GC/rotazione automatici legacy e il
rischio di crescita disco. Nessun sostituto nel design nativo BEST/FREE, nessuna
migrazione di cancellazioni nella manutenzione corrente. KEEP richiederebbe
ripristinare un dispatcher rimosso; MIGRATE introdurrebbe housekeeping distruttivo
non richiesto. Non si afferma assenza di consumer esterni o di dati storici.

Il lifecycle esplicito `cleanup legacy-retire LABEL --approve` di rc2 copre già
questo label con le verifiche di ownership, unloaded/archive/receipt e idempotenza
testate in staging; non occorrono modifiche automatiche all'installer.
La precedente classificazione UNRESOLVED è superata per **il job**, non costituisce
autorizzazione a eliminare runtime, cache o log. Nessuna dismissione reale applicata.

Le sezioni successive conservano la fotografia storica; le raccomandazioni di
non estendere `profiles.mjs` precedono il lifecycle esplicito separato di rc2.

Stato dei job `it.danilodantoni.opencode-team.*` presenti in
`~/Library/LaunchAgents/`. Analisi read-only: sorgente repo, git log locale,
plist reali, log/err reali, `launchctl print`. Nessun job avviato, modificato o
rimosso.

## Stato consolidato

La nuova architettura (≥ 0.3.5) installa **un solo** job proprietario:
`io.opencode-team.safe-caches`, gestito tramite `opencode-team cleanup *` e
tracciato nel receipt `~/.local/state/opencode-team/cleanup.json`.

I sei job legacy sotto sono tutti **loaded** e falliscono ad ogni esecuzione
con `last exit code = 1`, perché invocano il sottocomando
`opencode-team maintenance <job>` rimosso dal refactor `cfa4016` (0.2.0). Ogni
`.launchd.err` contiene:

```
opencode-team: Unknown command or arguments: maintenance. Use --help; only best/free profiles are supported.
```

Istanziazione originale: `65b0689` (v0.1.1, `Add automatic maintenance`).
Dispatch originale: `shared/maintenance/run-maintenance.sh` →
`opencode-team maintenance <task>` (scomparso).

## Matrice sei legacy

Le raccomandazioni sono proposte di dismissione futura, non autorizzazioni già
applicate. «Basso» riguarda la perdita di funzionalità del job oggi guasto, non
una verifica dell'assenza di dati storici nei suoi vecchi target.

| Label (senza `it.danilodantoni.opencode-team.`) | Funzione originale | Perché unsupported | Sostituto attuale | Dismissione | Rischio | Raccomandazione |
|---|---|---|---|---|---|---|
| `best-tool-output-gc` | GC della directory tool-output BEST + lookup sessioni dal DB, via `teams/best/tool-output-gc.mjs`. Calendario 04:45. | Sottocomando `maintenance` assente. Modulo `teams/best/tool-output-gc.mjs` non più installato. | Nessuno. L'architettura nuova non espone tool-output separato né GC dedicato. | `bootout` + rimozione plist. | Basso: job in exit 1 continuo, nessun target vivo. | Rimozione sicura. |
| `host-storage-gc` | GC storage host: clone code-sign Chrome, Docker builder prune, dangling images, volumi orfani, via `shared/maintenance/host-storage-gc.mjs`. Ogni 4 h. | Sottocomando `maintenance` assente. Modulo `shared/maintenance/host-storage-gc.mjs` non più installato. | Parziale: `disk-cleanup.sh --safe-caches-only` copre Docker build cache, cache browser, log Serena. Non copre clone Chrome. | `bootout` + rimozione plist. | Basso-medio: overlap funzionale parziale con safe-caches; i clone Chrome non sono più GC'ati. | Rimozione consigliata; valutare se coprire i clone Chrome in `disk-cleanup.sh` solo se concretamente necessario. |
| `openai-retention` | Retention sessioni team OpenAI via `opencode-cleanup.py --live-retention` + `openai-state-retention.mjs`. Calendario 04:15 (sovrapposizione con safe-caches). | Sottocomando `maintenance` assente. Team OpenAI esterno non più parte dei profili gestiti; cancellazione sessioni disabilitata nella nuova architettura. | Nessuno. Le sessioni V2 non vengono cancellate; retention è disabilitata per policy. | `bootout` + rimozione plist. | Basso: il target (team openai separato) non è più profilato; exit 1 continuo. | Rimozione sicura. Elimina anche la sovrapposizione calendariale delle 04:15. |
| `playwright-gc` | GC output Playwright MCP per tutti i team, via `shared/maintenance/playwright-gc.mjs`. Ogni 4 h. | Sottocomando `maintenance` assente. GC Playwright offline ritenuto non sicuro; esplicitamente omesso nella nuova architettura (`simplification-validation.md` §149). | Nessuno, per design: nessuna revisione Playwright viene cancellata, nessun browser scaricato per GC. | `bootout` + rimozione plist. | Basso: l'attuale `disk-cleanup.sh` stampa esplicitamente `SKIP Playwright native GC`. | Rimozione coerente con il design attuale. |
| `runtime-gc` | GC del runtime lifecycle (gc + rotate) per l'albero di processi dei team legacy (`core/lib/runtime-lifecycle.mjs gc --apply / rotate --apply`). Calendario 05:30. | Sottocomando `maintenance` assente. L'architettura multi-team con albero runtime dedicato è sostituita dai profili BEST/FREE nativi V2. | Nessuno. Non esiste più un runtime tree separato da GC'are. | `bootout` + rimozione plist. | Basso: i target (team best-ecc, go, daily, ecc.) non sono più installati come runtime separati. | Rimozione sicura. |
| `version-check` | Controllo nuova release tramite GitHub tags API, notifica terminal-notifier + hint `brew upgrade`, via `shared/maintenance/version-check.mjs`. 00:00 + 12 h + RunAtLoad. | Sottocomando `maintenance` assente. Modulo `shared/maintenance/version-check.mjs` non più installato. | Parziale: `maintenance.py` task `updates` esegue `brew outdated --json=v2` ma senza GitHub API né notifica interattiva. | `bootout` + rimozione plist. | Basso: ridondante rispetto al check `brew outdated` già incluso nella manutenzione; la notifica è una nicchia UX. | Rimozione consigliata; la notifica GitHub è opzionale e fuori scope del receipt. |

Nota comune: i plist legacy hanno permessi **0644** e uid 501 (proprietario
utente, non gestiti dal receipt). Il job attuale `io.opencode-team.safe-caches`
ha invece **0600** ed è l'unico tracciato da `cleanup.json`.

## `best-retention` — caso distinto (già dismesso)

| Label | Funzione originale | Stato | Sostituto |
|---|---|---|---|
| `best-retention` | Retention sessioni V2 BEST + reclaim SQLite + disk-cleanup, via oppure Python 3.13 gestito + `~/.local/bin/opencode-cleanup --v2 --v2-apply`. Calendario 05:00. | **Non loaded**: `launchctl print` restituisce exit 113 (`Could not find service`). Documentato come disabilitato con `launchctl disable` + `bootout` (`simplification-validation.md` §278-281). Plist e log conservati come asset di rollback, **non cancellati**. | Coperto da `maintenance.py`: `best.snapshot` (backup, retention 3), `best.reclaim` (vacuum incrementale), `caches` (safe-cache script). |

Questo job è già oggetto di dismissione separata e non entra nella matrice
dei sei: plist e log restano intatti. Snapshot/reclaim/cache non sostituiscono
la cancellazione di sessioni: quella funzionalità è deliberatamente assente.
Il rollback del solo codice non deve riattivare questo job.

## Necessità di modificare installer / uninstaller

**Conclusione: nessuna modifica necessaria.**

Motivazione:

1. **Receipt ownership preservato.** Il receipt `cleanup.json` traccia
   esclusivamente `io.opencode-team.safe-caches` (label, plist, enabled).
   I sei job legacy non sono nel receipt: `profiles.mjs` li rifiuta
   esplicitamente (`Refusing cleanup label already loaded without exact owned
   agent` / `Refusing unowned or modified cleanup agent`). Questo confine è
   corretto e va mantenuto.
2. **Nessuna responsabilità dell'installer.** `Formula/opencode-team.rb`
   installa i file in `libexec` e il wrapper `bin/opencode-team`; non tocca
   i LaunchAgent legacy. Aggiungere la loro rimozione all'uninstall amplierebbe
   il perimetro del formula oltre il proprio receipt e violerebbe la
   contropromessa espressa dal README: *"legacy user scripts/jobs are never
   overwritten"*.
3. **Dismissione solo dopo approvazione.** Verificare nuovamente label, comando,
   proprietà e plist prima di un eventuale bootout individuale. Conservare una
   copia del plist e dei log e spostare il plist fuori da LaunchAgents solo con
   autorizzazione. Non cancellare target, cache, sessioni o backup. Nessun
   comando di dismissione è stato eseguito durante questa stabilizzazione.
4. **Best-retention resta intoccato.** Plist e script vengono preservati per
   rollback; nessun li deve cancellare.

## Raccomandazione su `shared/profiles.mjs`

**Nessuna modifica a `shared/profiles.mjs`.** Il file gestisce
correttamente solo il job proprietario. Estendere `cleanup()` o la logica di
`enable/disable/uninstall` per toccare i job legacy:

- amplierebbe il receipt oltre il job realmente owned;
- introdurrebbe latenza e rischio di bootout/bootstrap su target non
  verificati;
- romperebbe la separazione attuale tra manutenzione owned e job
  legacy esterni.

La dismissione dei sei job è una housekeeping action separata, non parte del
lifecycle install/uninstall del package. Se si vuole automatizzare, il punto
corretto è uno script/toolhousekeeping autonomo o un passaggio documentato,
mai il receipt cleanup.

## Evidenze usate

- Sorgente: `shared/profiles.mjs` (cleanup, receipt), `shared/maintenance.py`
  (task snapshot/reclaim/caches/updates), `shared/disk-cleanup.sh`
  (safe-caches-only).
- Git: `cfa4016` (rimozione sottocomando `maintenance`), `65b0689`
  (introduzione job), `6fea24f`/`f4faf2c`/`37d5451` (consolidamento safe-caches).
- Reale: `launchctl print gui/<uid>/<label>` per tutti gli 8 label (coordinatore);
  lettura plist/log e metadata Python nell'audit. I contatori sono puntuali,
  non uno stato garantito per le successive esecuzioni.
- `docs/simplification-validation.md`, `docs/maintenance/opencode-team-036-reliability-audit.md`
  per stato documentato dei job.

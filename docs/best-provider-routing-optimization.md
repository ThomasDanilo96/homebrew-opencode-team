# BEST — provider routing optimization (31 ottobre 2026)

## Esito e perimetro

**Configurazione BEST applicata**, non una nuova release OpenCode Team.
OpenCode nativo rilevato: **2.2.1**. Nessun modello interrogato dalle fixture;
nessun login, provider a consumo, plugin, daemon o servizio aggiunto.
FREE, istruzioni globali, manutenzione attiva e patch `best.sessions` intatti.

| Stato | Esito effettivo |
|---|---|
| CONFIG READY | JSON/configurazione applicati; rilettura istruzioni/skill osservata. Acceptance test nativo isolato **BLOCKED**, non certificato PASS. |
| ROUTING VERIFIED | **PASS simulato**: selezioni deterministiche, indisponibilità e policy; non esecuzione dei modelli. |
| BALANCE MEASURED | Traffico storico aggregato misurato; **nuovo lavoro pesato PENDING**, zero unità reali registrate. |
| VISUAL DESIGNER READY | GLM 5.3 Flash su Go configurato come agente grafico; fallback M3. Claude escluso da agenti, comandi e disponibilità. Accesso live/quota **non verificati**. |
| PRODUCTION USAGE VERIFIED | **PENDING** per la nuova politica; nessun risparmio o 50/50 delle quote certificato. |

## Prima → dopo

Fonte esplicita: `~/.config/opencode-team/best/opencode.jsonc`; istruzioni
`~/.config/opencode-team/best/v2/AGENTS.md`, dopo le regole globali esistenti.
BEST usa XDG separati e `OPENCODE_CONFIG`; non sono stati trovati altri JSON
OpenCode di progetto/antenati/system nei percorsi controllati in questo repository.
Le configurazioni di altri progetti possono sovrascrivere il profilo: non alterate.

Prima: root/Build **OpenAI Sol Low**, General **Go LongCat 2.0**, Explore MiMo.
Ora root/Build **Go MiniMax M3**, che completa direttamente coding e test ordinari;
non c'è un passaggio obbligatorio attraverso un orchestratore OpenAI.
Sessioni già aperte conservano il modello selezionato: `/code` lo cambia
esplicitamente a M3; la modifica del JSON non riscrive sessioni storiche.

| Ruolo | Modello effettivamente configurato |
|---|---|
| Build / General | `opencode-go/minimax-m3` |
| Explore, read-only | `opencode-go/mimo-v2.6-flash` |
| Analysis complessa, read-only | `opencode-go/qwen3.7-plus` |
| Go specialist selettivo | `opencode-go/kimi-k2.7-code` |
| `/small`, solo modifiche minime | `opencode-go/minimax-m3.1-flash#low` |
| Architect / Plan / Debugger / Specialist / Reviewer critico | `openai/gpt-6.1-sol#medium` |
| `visual-designer` | `opencode-go/glm-5.3-flash` |
| `/visualFallback`, stesso agente e contratto grafico | `opencode-go/minimax-m3` |
| Title / Summary / Compaction | Luna Low OpenAI / M3 Go / M3 Go, invariati |

ID verificati dal catalogo disponibile; `auth list` espone soltanto Go “API key
stored” e OpenAI “OAuth stored”, senza segreti. Go è il provider già collegato,
non una nuova API Anthropic. Credenziali salvate/catalogo non provano quota o
connettività attuale. Sonnet premium non configurato: nessun accesso autorizzato
verificato. Le policy consentono soltanto `openai` e `opencode-go`.
Nessuna impostazione Extra Usage/Console balance modificata; relativo stato
dell'account non attestato da questa campagna.

Comandi nativi espliciti: `/code`, `/small`, `/scan`, `/analyze`, `/codeComplex`,
`/architect`, `/debug`, `/reviewCritical`, `/visual`, `/visualFallback`,
`/codeOpenai`. Impostano agente/modello e `subagent:false`: non richiedono un
costoso viaggio di andata/ritorno nel parent. La semantica è documentata da V2;
il test del server isolato non ha potuto esercitarne l'esecuzione nativa.

## 50/50 verificabile, senza fingere quote confrontabili

Proxy: peso **1** piccolo/localizzato, **3** implementazione ordinaria delimitata,
**5** contratto complesso/cross-module. Peso dichiarato prima, una sola registrazione
per criterio accettato; nessun doppio conteggio parent/child dello stesso risultato.
Contano nel lavoro completato solo record `passed`; errori/blocchi restano visibili.
Target 50/50 ±5 punti dopo almeno **40 unità**, non 40 richieste HTTP.
Competenza, rischio e disponibilità prevalgono sempre sul deficit cumulativo.
La registrazione è richiesta all'agente o eseguita dall'operatore: nessun hook
automatico intercetta le sessioni. Le unità non registrate non sono misurate.

`routing.mjs` è un ausilio locale one-shot: legge modelli dai comandi BEST e
restituisce una selezione; **non lancia LLM**, non è uno scheduler o un hook.
Coding ammissibile su entrambi favorisce il provider sottoutilizzato; sicurezza,
architettura e debug critico restano OpenAI; scansione/grafica Go.
Le istruzioni chiedono all'agente di consultarlo e seguire il risultato, oppure
si possono usare direttamente i comandi nativi. Non è un bilanciatore obbligatorio
del runtime e non garantisce matematicamente la quota del traffico futuro.

```sh
node ~/.config/opencode-team/best/routing.mjs route coding 3 \
  --config ~/.config/opencode-team/best/opencode.jsonc \
  --availability ~/.config/opencode-team/best/routing-availability.json \
  --work ~/.local/state/opencode-team/best/routing-work.jsonl
node ~/.config/opencode-team/best/routing.mjs report \
  --work ~/.local/state/opencode-team/best/routing-work.jsonl
```

Registrazione solo di attività **realmente completate**, con `record --work FILE`
e JSON su stdin: id univoco, kind, peso, provider/model/agent effettivi, durata,
outcome; fallback e token/cache opzionali. Nessun prompt, codice o credenziale.
Lock esclusivo e rifiuto dei duplicati; nessun retry infinito o cancellazione
automatica di lock. Token parziali espongono `tokenSamples`, non una contabilità
completa. Modello Claude su Go viene contato in Go. Quote residue sempre ignote.
La snapshot availability va aggiornata da catalogo/errori attendibili: non è
un controllo live né una promessa che il provider sia raggiungibile.

Fallback prima dell'esecuzione: Claude assente/indisponibile/esaurito dichiarato
→ M3 con lo stesso agente. Se il guasto avviene dopo modifiche, stop e un solo
handoff con brief, diff e test; non replay automatico. OpenCode non espone una
catena automatica cross-model configurabile: nessun campo `fallback` inventato.

Concorrenza: **2 Go + 1 OpenAI è una regola operativa**, non un semaforo nativo.
`experimental.subagent_depth:1` è invece supportato; grafo senza cicli e worker
senza delega di ritorno. Nessun fan-out obbligatorio, seconda scansione completa
o review OpenAI automatica per una modifica semplice. Riduzione attesa delle
chiamate ridondanti, **non un risparmio percentuale misurato**.

## Consumi storici disponibili

Finestra richiesta: 24–31 ottobre, cattura `2026-10-31T10:07:09Z`.
Lettura SQLite `mode=ro&immutable=1`, query-only, soli aggregati di metadati:
**checkpoint principale, WAL live escluso**, quindi non totale nativo completo.
Non sono stati letti prompt o file di autenticazione. `stats --help` conferma
`--days 7 --models --cost --json`, ma il wrapper forza standalone: eseguirlo sui
dati reali può inizializzare/migrare il DB. Per questo non è stato eseguito.

| Provider | Passi modello | Input | Output | Reasoning | Cache-read | Durate passi sommate |
|---|---:|---:|---:|---:|---:|---:|
| OpenAI | 4138 (**45.1%**) | 14541931 | 944890 | 645902 | 722659072 | 174782027 ms |
| Go | 5030 (**54.9%**) | 13727930 | 1428013 | 2507634 | 882739344 | 98898136 ms |

Cache-write: zero nel checkpoint osservato. Passi ≠ richieste HTTP; retry nascosti
non contati. Durate concorrenti sommate ≠ tempo di parete. I ruoli/modelli sono
aggregati separatamente in `historical-usage.json`; non si inferisce il ruolo dal
nome del modello. I valori monetari nativi sono equivalenti nominali, non fatture:
OpenAI zero non significa quota zero. Nessun confronto di quote ufficiali disponibile.
Questo traffico precede la nuova configurazione: non ne dimostra l'efficacia.
Modelli più usati nel campione: Sol 4136 passi, LongCat 3221, M3 1191,
MiMo Flash 618. M3 registra 203061904 cache-read e 13.053 di equivalente nominale,
LongCat 629131264 e 4.453: task diversi, non un confronto controllato. **M3 non
è dichiarato più economico di LongCat**; è la scelta di competenza richiesta.
Il controllo principale resta evitare contesti enormi/riletture e misurare il
nuovo mix; non spostare automaticamente tutto su un singolo abbonamento.

## Grafica e skills

Installata solo per BEST la skill ufficiale `frontend-design`, immutata, da
`anthropics/skills@ca45fc496a3436251f191354091d557da31c15b5`, con LICENSE.txt
**Apache-2.0** conservata. Provenienza/hash in `skill-provenance.json`.
Nessuna esecuzione remota. Riusate ECC `accessibility`, `frontend-a11y`,
`make-interfaces-feel-better`, `design-system`, `browser-qa` e design direction
solo quando pertinenti. Bootstrap 5, template Django e Three.js sono istruzioni
specialistiche del visual agent, non sette nuove skills o dipendenze.
Tema acquistato e fedeltà a PDF/screenshot prevalgono sulle preferenze estetiche;
nessuna promessa di image generation. Serena e Playwright esistenti invariati.

## Test ed evidenze

Runner isolato: `bash tests/guardrail/runner.sh best-routing [CONFIG AVAILABILITY]`.
**13 negativi + 17 casi routing + 3 casi configurazione = 33 PASS** distinti;
**1 FAIL tecnico/BLOCKED**, zero skip, nel test di acceptance nativa.
Quest'ultimo avvia OpenCode 2.2.1 con HOME/XDG disposable, MCP disabilitati e DB
`:memory:`: fallisce prima della readiness con `Failed to start server ... port 0`
nel confine di rete della sandbox. Non allentato, rimosso o conteggiato PASS.
Il tentativo di validazione tramite schema pubblico ha restituito HTTP 403:
nessuna attestazione di validazione schema remoto. JSON/sintassi verificati,
opzioni selezionate dalle guide V2, non inventate.

Fixture: scanner/coder, rischio, Claude presente/assente/esaurito, provider mancanti,
no extra-paid-provider, catalogo ignoto, 40 unità pesate con attività ad alto rischio,
skills visual-only, grafo senza cicli, record/lock/symlink e rollback newline ledger.
Nel campione sintetico ad alto rischio: **50/50 su 40 unità, peso totale 100**;
è una prova dell'algoritmo sul campione, non traffico reale o qualità dei modelli.
Backup originale e dieci hash protetti verificati; FREE e patch manutenzione invariati.
Letture di cfg/istruzioni/skill aggiornate osservate nel runtime attuale, senza
cambiare il modello già memorizzato nella sessione. Non sostituiscono il test
nativo isolato rimasto bloccato. Nessun test reale di inferenza/connettività.

## File e rollback

BEST: `opencode.jsonc`, `v2/AGENTS.md`, nuovi `routing.mjs`,
`routing-availability.json`, `v2/skills/frontend-design/{SKILL.md,LICENSE.txt}`.
Repository: `shared/best-routing.mjs`, `tests/best-routing.test.mjs`,
`tests/best-config.test.mjs`, target/integrazione di `tests/guardrail/runner.sh`
e questo rapporto. Nessuna modifica del generatore comune o dei profili attivi
di manutenzione. **Il vecchio `opencode-team setup` può rigenerare la vecchia
configurazione**: non eseguirlo come aggiornamento di queste preferenze BEST.

Backup verificabili e manifest delle sole sei modifiche:
`.local-release-evidence/best-routing-20261031/{original/,applied-manifest.json}`.
Rollback: verificare gli hash correnti contro `after_sha256`; ripristinare soltanto
i due originali con i mode registrati, rimuovere soltanto i quattro nuovi file
riconosciuti dal manifest. Non toccare altri file o directory di profilo.
OpenCode rilegge la configurazione; non serve riavviare servizi. Le sessioni già
selezionate non vengono riscritte. Nessun commit/push/release.

**Patch `best.sessions`: ancora preparata, NON applicata.** Hash del candidato,
activation.md, script attivo, timeout, plist e receipt di manutenzione invariati.

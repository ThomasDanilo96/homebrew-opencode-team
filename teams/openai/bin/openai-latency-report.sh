#!/bin/bash
# The no-argument interface is deliberately kept as the small legacy TSV report.
# Cumulative JSON/Markdown are opt-in and are owned by openai-report.mjs.
set -euo pipefail
root=$(cd "$(dirname "$0")" && pwd)
case "${1:-}" in
  --json|--markdown) exec node "$root/openai-report.mjs" "$@" ;;
esac
[ "$#" -eq 0 ] || { printf '%s\n' 'Usage: openai-latency-report.sh [--json|--markdown] [openai-report options]' >&2; exit 2; }
exec node --input-type=module - <<'NODE'
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const file=join(process.env.OPENAI_TEAM_STATE_ROOT||'/tmp','logs','latency-metrics.jsonl');
const safe=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(v)?v:null;
const rows=[];
if(existsSync(file)) for(const line of readFileSync(file,'utf8').split(/\r?\n/))try{if(line.trim()){const r=JSON.parse(line);if(safe(r.stage)&&safe(r.outcome))rows.push(r)}}catch{}
if(!rows.length){console.log('No local latency metrics');process.exit(0)}
const q=(a,p)=>a.sort((x,y)=>x-y)[Math.ceil(a.length*p)-1];
const grouped=new Map;
for(const r of rows){const key=[r.stage,safe(r.agent),safe(r.model),r.outcome].join('\0');if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(r)}
for(const [key,rs] of [...grouped].sort(([a],[b])=>a.localeCompare(b))){const [stage,agent,model,outcome]=key.split('\0'), n=rs.length, ns=k=>rs.reduce((s,r)=>s+(Number.isFinite(r[k])?r[k]:0),0), durations=rs.map(r=>r.duration_ms).filter(Number.isFinite);
 if(agent&&model){const input=ns('input_tokens'),cached=ns('cached_input_tokens');console.log([stage,agent,model,outcome,n,input,cached,ns('cache_write_input_tokens'),ns('output_tokens'),ns('reasoning_tokens'),ns('total_tokens'),durations.length?q(durations,.5):0,input,Math.round(100*cached/(input+cached||1))].join('\t'))}
 else console.log([stage,outcome,n,durations.length?Math.round(ns('duration_ms')/durations.length):0,durations.length?q(durations,.5):0,durations.length?q(durations,.95):0].join('\t'));
}
NODE

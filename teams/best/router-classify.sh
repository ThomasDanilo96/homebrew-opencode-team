#!/bin/bash
set -uo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')
[ -z "$PROMPT" ] && exit 0
[ -z "$SESSION_ID" ] && exit 0
echo "$PROMPT" | grep -q "BEST_ROUTER_CONTEXT" && exit 0
echo "$PROMPT" | grep -q "BEST_ROUTER_ROUTE" && exit 0
[ ${#PROMPT} -lt 30 ] && exit 0

EXPLORE_RE='\b(find\s+where|where\s+is\b.*implement|locate\s+implement|trace\b|find\s+all\s+reference|which\s+files|identify\s+all\s+files|map\s+workflow|how\s+(are|is)\s+.*connected|search\s+(the\s+)?repository|across\s+(the\s+)?codebase|where\s+does\b|list\s+all\s+files?\s+involv|search\s+for\b|find\s+all\b|repository|repo|codebase|project\s+structure|main\s+architecture|architecture|structure|implementation|implemented|explore|inspect|analy[sz]e\s+.*(repository|repo|project|codebase)|analyse\s+.*(repository|repo|project|codebase)|trova\s+dove|cerca\s+dove|esplora|inspect|analizza\s+.*(repository|repo|progetto|codice)|ispeziona|traccia|quali\s+file|in\s+quali\s+file|implementat[oa]|implementazione|struttura|architettura|progetto|codice)'
RESEARCH_RE='\b(official\s+documentation|official\s+docs|official\b.*\bdocument(ation|s)\b|external\s+documentation|recommended\s+(django|drf|rest\s+framework)\s+approach|recommendations?|official\s+recommendation|best\s+practices?|what\s+does\s+.*recommend|what\s+do\s+the\s+docs\s+say|according\s+to\s+official|standards?|guidelines?|compare\s+.*\b(documentation|docs|recommendations?|best\s+practices?)\b|review\s+.*and\s+compare|security\s+practices?\s+.*compar|documentazione\s+ufficiale|documentazione\s+esterna|best\s+practices?|buone\s+pratiche|raccomandazioni?\s+ufficiali|raccomand|consiglia|linee\s+guida|standard|confront\w*\s+.*documentazione|confront\w*\s+.*(raccomand|pratiche))'

needs_explore=0
needs_research=0
if echo "$PROMPT" | grep -qiE "$EXPLORE_RE"; then needs_explore=1; fi
if echo "$PROMPT" | grep -qiE "$RESEARCH_RE"; then needs_research=1; fi
[ "$needs_explore" -eq 0 ] && [ "$needs_research" -eq 0 ] && exit 0

if [ "$needs_explore" -eq 1 ] && [ "$needs_research" -eq 1 ]; then
  echo "<BEST_ROUTER_ROUTE>BOTH</BEST_ROUTER_ROUTE>"
elif [ "$needs_explore" -eq 1 ]; then
  echo "<BEST_ROUTER_ROUTE>EXPLORE</BEST_ROUTER_ROUTE>"
elif [ "$needs_research" -eq 1 ]; then
  echo "<BEST_ROUTER_ROUTE>LIBRARIAN</BEST_ROUTER_ROUTE>"
fi

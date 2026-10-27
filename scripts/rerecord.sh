#!/bin/bash
# Re-record some questions live (appends to the cassettes; the newest answer for the same request wins).
# Usage (from a_prime): bash scripts/rerecord.sh sertraline-pssd darolutamide-angioedema
cd "$(dirname "$0")/.."
export SAMPLE_MODE=false APRIME_RECORD=true
reset() { .venv/Scripts/python -I -X utf8 -c "import sys; sys.path.insert(0,'scripts'); from zhelp import psql; psql('DELETE FROM pt_decision; DELETE FROM reopen_condition;')"; }
for q in "$@"; do reset; APRIME_ALL_VOTES=1 node --no-warnings app/cli.ts $q agents > runs/record/$q.log 2>&1; echo "$q done $(date +%T)"; done
reset
echo ALL DONE

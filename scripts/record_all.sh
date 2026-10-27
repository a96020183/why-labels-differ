#!/bin/bash
# Re-record SAMPLE_MODE: live Zetaris + live Nightshift, one model request at a time, appending to sample/cassettes/.
# Usage (from a_prime): bash scripts/record_all.sh   (takes about an hour; Nightshift answers slowly)
cd "$(dirname "$0")/.."
set -e
export SAMPLE_MODE=false APRIME_RECORD=true
reset() { .venv/Scripts/python -I -X utf8 -c "import sys; sys.path.insert(0,'scripts'); from zhelp import psql; psql('DELETE FROM pt_decision; DELETE FROM reopen_condition;')"; }
mkdir -p runs/record
rm -f sample/cassettes/zetaris.jsonl sample/cassettes/models.jsonl
reset
for q in semaglutide-naion sertraline-pssd darolutamide-angioedema; do
  node --no-warnings app/cli.ts $q propose > runs/record/$q.log 2>&1; echo "$q done $(date +%T)"
done
node --no-warnings app/cli.ts replay > runs/record/replay.log 2>&1; echo "replay done $(date +%T)"
node --no-warnings app/cli.ts ledger > runs/record/ledger.log 2>&1; echo "ledger done $(date +%T)"
node --no-warnings app/score1a.ts > runs/record/set1a.log 2>&1; echo "set1a done $(date +%T)"
reset
echo ALL DONE

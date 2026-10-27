#!/bin/bash
# Queue after the question recordings: re-record gemcitabine (its writer reply was cut short), then the "why" scoring
# run, then the two night-scan arms (product MN, re-read baseline FR). One Nightshift request at a time.
cd "$(dirname "$0")/.."
until grep -q "ALL DONE" runs/record/rerecord.log 2>/dev/null; do sleep 30; done
mv runs/record/rerecord.log runs/record/rerecord_1.log
bash scripts/rerecord.sh gemcitabine-dress > runs/record/rerecord.log 2>&1; echo "gemcitabine done $(date +%T)"
SAMPLE_MODE=false APRIME_RECORD=true node --no-warnings app/scorewhy.ts > runs/record/why.log 2>&1; echo "why done $(date +%T)"
for i in 1 2 3; do APRIME_BATCH=3 node --no-warnings engine/scan.ts MN >> runs/record/scan_MN.log 2>&1 && break; sleep 60; done; echo "MN done $(date +%T)"
for i in 1 2 3; do APRIME_BATCH=3 node --no-warnings engine/scan.ts FR >> runs/record/scan_FR.log 2>&1 && break; sleep 60; done; echo "FR done $(date +%T)"
echo ALL DONE

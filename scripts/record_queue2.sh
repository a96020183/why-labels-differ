#!/bin/bash
# After the "why" run: stop the queued night scans, re-record gemcitabine (rubric change), then run the scans.
cd "$(dirname "$0")/.."
until grep -q "why done" runs/record/record_more.log 2>/dev/null; do sleep 20; done
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -match 'record_more.sh|engine/scan.ts' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -Confirm:\$false }"
sleep 5
bash scripts/rerecord.sh gemcitabine-dress > runs/record/rerecord_gem2.log 2>&1; echo "gemcitabine2 done $(date +%T)"
for i in 1 2 3; do APRIME_BATCH=3 node --no-warnings engine/scan.ts MN >> runs/record/scan_MN.log 2>&1 && break; sleep 60; done; echo "MN done $(date +%T)"
for i in 1 2 3; do APRIME_BATCH=3 node --no-warnings engine/scan.ts FR >> runs/record/scan_FR.log 2>&1 && break; sleep 60; done; echo "FR done $(date +%T)"
echo ALL DONE

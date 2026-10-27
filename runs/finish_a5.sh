#!/bin/bash
# A5 finisher: Markovian (M) and fair opponent (C) run at the same time, each with one model request in flight
# (2 in total), then the full re-read estimate (F) and the score against the v2 answer key. Both systems: 3-row
# batches, stream + tier-split off + iso scope (engine/scan.ts CALL). Each batch gets at most 6 tries (backoff
# 15-180 s); after that its rows stay missing (scored 0) and the scan moves on (listed under "skipped" in the ledger).
# A crashed process is resumed from the cache after 5 minutes, at most 3 times per system.
# Usage (from a_prime): nohup bash runs/finish_a5.sh > runs/finish_a5.log 2>&1 &
cd "$(dirname "$0")/.."
export APRIME_MODEL=${APRIME_MODEL:-nvidia/nemotron-3-ultra-550b-a55b} APRIME_BATCH=${APRIME_BATCH:-3}
scan() {
  local s=$1 ok=0
  for i in 1 2 3; do
    node engine/scan.ts $s >> runs/scan_${s}_b${APRIME_BATCH}.log 2>&1 && { ok=1; break; }
    echo "round $i of $s failed $(date +%T)"; sleep 300
  done
  echo "exit $s ok=$ok $(date +%T)"
  [ $ok = 1 ]
}
scan M & pm=$!
scan C & pc=$!
wait $pm; rm_=$?; wait $pc; rc_=$?
[ $rm_ = 0 ] && [ $rc_ = 0 ] || exit 1
node engine/scan.ts F
./.venv/Scripts/python -I scripts/a6_score.py out/answer_key_v2_independent.json out/ledger_M.json out/ledger_C.json > out/score.json && echo "scored $(date +%T)"

#!/usr/bin/env bash
# ingest.sh — Option D: push manual health reports so the live portal graph shows Degraded / Unhealthy.
# This is the "send health reports to make the degraded and so on" mechanism the request asked about.
#
# Maps to the portal IngestHealthReport blade:
#   AHM-CloudHealth-Portal/.../Blades/IngestHealthReportBlade/IngestHealthReport.ReactView.tsx:83-100
#   AHM-CloudHealth-Portal/.../Shared/CloudHealthApiV3.ts:228-231  (POST .../entities/{name}/ingestHealthReport)
# CLI: `az monitor health-models entity ingest-health-report`
#   --health-state {Healthy|Degraded|Unhealthy|Unknown|Deleted}  --signal-name  --expires-in-minutes (default 60)
#
# The entity must already exist; the signal is created/updated by the report. State reverts when the
# report expires (expires-in-minutes, 1..10080), so pick a window long enough to screenshot.
#
# DRY_RUN=1 (default) prints commands. Set DRY_RUN=0 to push for real.
set -euo pipefail

DRY_RUN="${DRY_RUN:-1}"
RG="${RG:-rg-hm-diagrams}"
MODEL="${MODEL:-shop-workload-health}"
TTL="${TTL:-180}"   # minutes the forced state stays visible

run() { if [[ "$DRY_RUN" == "1" ]]; then echo "+ $*"; else "$@"; fi; }

report() { # entity signal state
  run az monitor health-models entity ingest-health-report -g "$RG" --health-model-name "$MODEL" \
    --entity-name "$1" --signal-name "$2" --health-state "$3" \
    --expires-in-minutes "$TTL" --additional-context "diagram capture: $3" -o none
}

echo "== Force a degraded logistics + healthy shop, so the root rolls up to Degraded =="
report "shop-and-commerce" "checkout-availability" "Healthy"
report "logistics"         "order-queue-depth"    "Degraded"
report "logistics"         "carrier-api-latency"  "Degraded"

echo ""
echo "States pushed (TTL ${TTL}m). Open: portal.azure.com -> health model '$MODEL' -> Graph."
echo "Take the screenshot within the TTL window. Re-run with different states for Unhealthy captures."
echo "(DRY_RUN=$DRY_RUN)"

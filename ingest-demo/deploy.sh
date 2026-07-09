#!/usr/bin/env bash
# deploy.sh — Option D: deploy a real Azure Monitor health model so you can screenshot the live portal graph.
# Control-plane only (data-plane state is pushed later by ingest.sh). Command shapes verified via
# `az monitor health-models ... --help` on extension `health-models`.
#
# Live run needs: an Azure subscription + RBAC to create Microsoft.CloudHealth/healthmodels, and the
# health-models CLI extension (`az extension add --name health-models`). CloudHealth is region-limited;
# swedencentral is a known-good region (see raw/abossard/mcp/healthmodels-live-test-2026-07-06.md).
#
# DRY_RUN=1 (default) prints the commands instead of executing, so the script is runnable with no cloud.
set -euo pipefail

DRY_RUN="${DRY_RUN:-1}"
RG="${RG:-rg-hm-diagrams}"
LOCATION="${LOCATION:-swedencentral}"
MODEL="${MODEL:-shop-workload-health}"

run() { if [[ "$DRY_RUN" == "1" ]]; then echo "+ $*"; else "$@"; fi; }

echo "== 1. Resource group =="
run az group create -n "$RG" -l "$LOCATION" -o none

echo "== 2. Health model (system-assigned identity) =="
run az monitor health-models create -n "$MODEL" -g "$RG" -l "$LOCATION" --mi-system-assigned true -o none

# The root entity MUST be named == the model name (the RP manages a built-in root by that name).
echo "== 3. Root entity =="
run az monitor health-models entity create -g "$RG" --health-model-name "$MODEL" \
  --entity-name "$MODEL" --display-name "Workload root" --impact Standard \
  --canvas-position "{x:400,y:40}" -o none

echo "== 4. Component entities (with canvas layout) =="
run az monitor health-models entity create -g "$RG" --health-model-name "$MODEL" \
  --entity-name "shop-and-commerce" --display-name "Shop and commerce" --impact Standard \
  --canvas-position "{x:120,y:240}" -o none
run az monitor health-models entity create -g "$RG" --health-model-name "$MODEL" \
  --entity-name "logistics" --display-name "Logistics" --impact Standard \
  --canvas-position "{x:560,y:240}" -o none

echo "== 5. Roll-up relationships (child -> parent) =="
run az monitor health-models relationship create -g "$RG" --health-model-name "$MODEL" \
  --relationship-name "shop-to-root" --parent-entity-name "$MODEL" --child-entity-name "shop-and-commerce" -o none
run az monitor health-models relationship create -g "$RG" --health-model-name "$MODEL" \
  --relationship-name "logistics-to-root" --parent-entity-name "$MODEL" --child-entity-name "logistics" -o none

echo ""
echo "Deployed model '$MODEL' in RG '$RG'. Next: ./ingest.sh to push Degraded/Unhealthy states,"
echo "then open the portal Graph blade and screenshot. (DRY_RUN=$DRY_RUN)"

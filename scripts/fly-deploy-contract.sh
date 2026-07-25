#!/usr/bin/env bash
# Run scripts/deploy-midnight.mjs from a one-shot Fly Machine on the same
# 6PN network as choreo-node, so it can reach ws://choreo-node.internal:9944
# without exposing the node publicly.
#
# Requires flyctl + FLY_ACCESS_TOKEN (or `flyctl auth login`).
#
# IMPORTANT: The faucet (choreo-faucet) also uses genesis seed …0002. Two
# wallets on the same seed submitting txs concurrently can race on UTXO
# selection. Before running this script, scale the faucet to 0:
#   flyctl scale count 0 -a choreo-faucet
# Then re-scale after deploy completes:
#   flyctl scale count 1 -a choreo-faucet
#
# Usage:
#   ./scripts/fly-deploy-contract.sh


set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${FLY_ACCESS_TOKEN:-}" && -n "${FLY_API_TOKEN:-}" ]]; then
  export FLY_ACCESS_TOKEN="$FLY_API_TOKEN"
fi

# The deploy image bundles bun + the compiled artefacts. Build & push once,
# then run as a --rm machine on the choreo-node app so it joins 6PN.
LABEL="deploy-$(date +%s)"
IMAGE="registry.fly.io/choreo-node:$LABEL"

echo "==> Building deploy image ($IMAGE)"
flyctl deploy \
  -c fly.deploy.toml \
  --build-only \
  --image-label "$LABEL" \
  --push \
  --remote-only




echo "==> Running one-shot deploy machine"
flyctl machine run "$IMAGE" \
  -a choreo-node \
  --rm \
  --vm-memory 2048 \
  --vm-cpus 2 \
  --env VITE_NETWORK_ID=undeployed \
  --env VITE_INDEXER_URL=https://choreo-indexer.fly.dev/api/v4/graphql \
  --env VITE_INDEXER_WS_URL=wss://choreo-indexer.fly.dev/api/v4/graphql/ws \
  --env VITE_PROOF_SERVER_URL=https://choreo-proof.fly.dev \
  --env VITE_NODE_WS=ws://choreo-node.internal:9944 \
  bun scripts/deploy-midnight.mjs


echo "==> Done. The contract address was printed above; paste it into"
echo "    your Lovable env as VITE_DEFAULT_CONTRACT."

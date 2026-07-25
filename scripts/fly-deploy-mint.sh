#!/usr/bin/env bash
# Deploy choreo-mint to Fly. Safe to re-run — Fly builds a fresh image and
# rolls the single machine. Contract artefacts under
# contracts/managed/tokenized-choreo-kits are baked into the image.
#
# Usage:
#   FLY_API_TOKEN=... ./scripts/fly-deploy-mint.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${FLY_ACCESS_TOKEN:-}" && -n "${FLY_API_TOKEN:-}" ]]; then
  export FLY_ACCESS_TOKEN="$FLY_API_TOKEN"
fi

if [[ ! -d contracts/managed/tokenized-choreo-kits/contract ]]; then
  echo "ERROR: contracts/managed/tokenized-choreo-kits/contract missing."
  echo "Run \`bun run midnight:compile\` (or \`compact compile ...\`) first."
  exit 1
fi

echo "==> Deploying choreo-mint"
flyctl deploy -c fly/mint/fly.toml --remote-only --ha=false --wait-timeout=900

echo "==> Health check"
sleep 3
curl -s https://choreo-mint.fly.dev/health || true
echo
echo
echo "Done. First mint after cold start takes 60–120s while the proof"
echo "server loads the proving key. Watch logs with: flyctl logs -a choreo-mint"

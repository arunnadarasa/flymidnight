#!/usr/bin/env bash
# One-shot bootstrap for the hosted Midnight stack on Fly.io.
#
# Requires either `flyctl auth login` or FLY_API_TOKEN / FLY_ACCESS_TOKEN in env.
# Safe to re-run — every step treats "already exists" as success.
#
# Usage:
#   FLY_API_TOKEN=... FLY_ORG=personal ./scripts/fly-bootstrap.sh
#   ./scripts/fly-bootstrap.sh            # if you're logged in via flyctl auth
#
# What it does:
#   1. Installs flyctl if missing.
#   2. Creates 4 apps: choreo-node, choreo-indexer, choreo-proof, choreo-faucet.
#   3. Creates a 1 GB persistent volume for the node.
#   4. Pushes FAUCET_SEED (from env) into choreo-faucet.
#   5. Deploys all four via `flyctl deploy --remote-only`.
#   6. Scales every app to exactly 1 machine.
#   7. Prints the three public URLs.

set -euo pipefail
cd "$(dirname "$0")/.."

ORG="${FLY_ORG:-personal}"
REGION="${FLY_REGION:-iad}"

# Normalise token env var (flyctl reads FLY_ACCESS_TOKEN).
if [[ -z "${FLY_ACCESS_TOKEN:-}" && -n "${FLY_API_TOKEN:-}" ]]; then
  export FLY_ACCESS_TOKEN="$FLY_API_TOKEN"
fi

if ! command -v flyctl >/dev/null 2>&1; then
  echo "Installing flyctl…"
  curl -sL https://fly.io/install.sh | sh
  export PATH="$HOME/.fly/bin:$PATH"
fi

flyctl version

echo "==> Verifying auth"
flyctl auth whoami

create_app() {
  local name="$1"
  if flyctl apps list --json | grep -q "\"Name\":\"$name\""; then
    echo "  app $name already exists"
  else
    flyctl apps create "$name" --org "$ORG"
  fi
}

echo "==> Creating apps"
create_app choreo-node
create_app choreo-indexer
create_app choreo-proof
create_app choreo-faucet

echo "==> Creating node volume"
if ! flyctl volumes list -a choreo-node --json 2>/dev/null | grep -q '"name":"chain_data"'; then
  flyctl volumes create chain_data -a choreo-node --region "$REGION" --size 1 --yes
else
  echo "  volume chain_data already exists"
fi

echo "==> Setting faucet secret"
if [[ -n "${FAUCET_SEED:-}" ]]; then
  flyctl secrets set "FAUCET_SEED=$FAUCET_SEED" -a choreo-faucet --stage
else
  echo "  WARNING: FAUCET_SEED not in env — faucet won't boot until you set it:"
  echo "    flyctl secrets set FAUCET_SEED=<64-hex> -a choreo-faucet"
fi

echo "==> Deploying node"
flyctl deploy -c fly/node/fly.toml --remote-only --ha=false --wait-timeout=600

echo "==> Deploying indexer"
flyctl deploy -c fly/indexer/fly.toml --remote-only --ha=false --wait-timeout=600

echo "==> Deploying proof-server"
flyctl deploy -c fly/proof/fly.toml --remote-only --ha=false --wait-timeout=900

echo "==> Retiring faucet (server-side mint on choreo-mint replaces it)"
flyctl scale count 0 -a choreo-faucet --yes || true

echo "==> Creating choreo-mint app"
create_app choreo-mint

echo "==> Deploying choreo-mint"
flyctl deploy -c fly/mint/fly.toml --remote-only --ha=false --wait-timeout=900

echo "==> Pinning to 1 machine each (faucet stays at 0)"
for app in choreo-node choreo-indexer choreo-proof choreo-mint; do
  flyctl scale count 1 -a "$app" --yes || true
done

cat <<EOF

==============================================
Hosted Midnight stack is live:

  Indexer HTTPS  https://choreo-indexer.fly.dev/api/v4/graphql
  Indexer WSS    wss://choreo-indexer.fly.dev/api/v4/graphql/ws
  Proof server   https://choreo-proof.fly.dev
  Mint API       https://choreo-mint.fly.dev/mint    (POST) + /health
  Node (6PN)     ws://choreo-node.internal:9944      (private)

Faucet is retired: server-side mint on choreo-mint pays fees with the
genesis-funded seed, so visitors never need Lace or tDUST.

Next: run \`./scripts/fly-deploy-contract.sh\` to deploy the contract
against these endpoints, then paste the address into .env as
VITE_DEFAULT_CONTRACT.
==============================================
EOF

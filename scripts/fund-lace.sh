#!/usr/bin/env bash
# scripts/fund-lace.sh
#
# One-shot funder for the Lace wallet on the local Undeployed Midnight stack.
# Uses the official midnightntwrk/midnight-local-dev CLI which ships an
# interactive faucet (menu option 2: "Fund accounts by public key").
#
# Steps performed here:
#   1. Clone midnight-local-dev into /tmp (if not present)
#   2. Install its deps
#   3. Start its interactive CLI
#
# What you do next:
#   - In Lace, copy your UNSHIELDED address (mn_addr_undeployed1...)
#   - In the CLI, select option 2 and paste that address
#   - You receive 50,000 tNIGHT
#   - Back in Lace, tap "Generate tDUST" on your tNIGHT balance
#   - Wait one block — the app's "tDUST tank empty" chip flips to a live number
#
# Note: midnight-local-dev may want to run its own node/indexer/proof-server
# stack. If it prompts for that, stop our docker compose stack first
# (`docker compose down`) or reuse its bring-up entirely.

set -euo pipefail

REPO_DIR="${MIDNIGHT_LOCAL_DEV_DIR:-/tmp/midnight-local-dev}"

if [ ! -d "$REPO_DIR" ]; then
  echo "→ cloning midnight-local-dev into $REPO_DIR"
  git clone https://github.com/midnightntwrk/midnight-local-dev.git "$REPO_DIR"
fi

cd "$REPO_DIR"

if [ ! -d node_modules ]; then
  echo "→ installing midnight-local-dev deps"
  npm install
fi

echo
echo "→ starting midnight-local-dev CLI"
echo "   choose menu option 2 ('Fund accounts by public key')"
echo "   paste your Lace UNSHIELDED address (mn_addr_undeployed1…)"
echo
exec npm start

#!/usr/bin/env bash
# Thin wrapper around `docker compose` for the local Midnight stack.
# Usage: scripts/midnight-stack.sh {up|down|logs [service]|ps|reset}
set -euo pipefail

cd "$(dirname "$0")/.."

case "${1:-}" in
  up)    docker compose up -d ;;
  down)  docker compose down ;;
  logs)  docker compose logs -f "${2:-}" ;;
  ps)    docker compose ps ;;
  reset) docker compose down -v ;;
  *)     echo "usage: $0 {up|down|logs [service]|ps|reset}"; exit 1 ;;
esac

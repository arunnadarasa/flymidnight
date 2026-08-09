# Tokenized Choreo Kits

**Sell bundled choreography sequences as tokenized, licensable assets on Midnight.**
Single-page Midnight ZK demo — Compact 0.23 contract, Lace wallet, local or Fly-hosted proof server.

> Built during the **Creative AI & Quantum Hackathon** organised by StreetKode Fam
> during Indian Krump Festival 14.

Repo: https://github.com/arunnadarasa/flymidnight

## The idea

Choreographers today have no privacy-preserving way to license routines. Post it
publicly and anyone can copy it; keep it private and you can't sell it. Midnight's
ZK ledger lets us publish the **kit** (title, steps, price) while keeping the
**author's identity** hidden behind a per-entry commitment. Buyers see verifiable
provenance; sellers stay pseudonymous.

## Hackathon fit

Targeted at the **DeFi Track** (tokenized/licensable content) with strong overlap
into Gaming/Creative and Best Beginner Hack.

| Criterion | How this project addresses it |
| --- | --- |
| **Technology** | Compact 0.23 ZK circuit, `persistentHash` author commitment, `disclose()` boundary, real ZK proving. |
| **Originality** | ZK for choreography IP — an unexplored niche. Public catalog + private authorship is a genuinely new tradeoff. |
| **Execution** | One polished page. Real "Proving… 30–120s" UX. Undeployed mobile path mints without Lace/tDUST. |
| **Completion** | End-to-end: connect → deploy → publish → browse. All in a single index route. |
| **Documentation** | This README covers setup, run, test, and criteria in under 5 minutes. |
| **Business value** | MVP for a choreography licensing marketplace — creators keep pseudonymity, buyers get provable authorship. |

## Stack

- Vite + React SPA (TanStack Start template, single index route).
- Compact 0.23 contract → proof server on `:6300` (local) or Fly.
- **Undeployed hosted:** server-side mint via `choreo-mint` (genesis wallet pays fees); Lace optional.
- All Midnight code paths gated behind `<ClientOnly>` for SSR safety.
- Local Docker still supported for offline Lace-signed flows.

## Prerequisites

- [Bun](https://bun.sh) (install + scripts)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) for local Midnight stack
- Compact compiler (one-time; see below)

Dependencies resolve from the **public npm registry** via the committed `bun.lock`
(fresh clone: `bun install` should not hit private registries).

## Contract

See [`contracts/TokenizedChoreoKits.compact`](./contracts/TokenizedChoreoKits.compact).

| Surface | Contents |
| --- | --- |
| Public ledger | `kit_count`, `last_kit` (JSON blob), `last_author_commitment` |
| Private witness | `localSecretKey()` → per-user 32-byte value (localStorage in the browser) |
| Circuit | `publishKit(payload)` discloses commitment + payload and bumps the counter |

Author identity never lands on chain — only
`persistentHash([domain, seq, secretKey])`.

## Tests

Offline Compact simulator (no Docker, no proofs):

```bash
bun install
bun test
```

[`contracts/tokenized-choreo-kits.test.ts`](./contracts/tokenized-choreo-kits.test.ts)
asserts constructor `kit_count`, `publishKit` payload/counter updates, and that
`last_author_commitment` matches `pureCircuits.authorCommitment` (privacy invariant).

## Hosted stack (Fly.io) — published site

The published site reaches these Fly apps:

| App | Purpose | Public? |
| --- | --- | --- |
| `choreo-node` | Midnight standalone node (`0.22.5`) | 6PN-internal only |
| `choreo-indexer` | Indexer GraphQL (`/api/v4/graphql`) | HTTPS + WSS |
| `choreo-proof` | Proof server (`8.0.3`) | HTTPS |
| `choreo-mint` | Server-side `publishKit` (genesis seed `…0002`) | HTTPS |
| `choreo-faucet` | Optional tDUST faucet (scale to 0 when mint owns the seed) | HTTPS |

Mobile visitors can mint without Lace: the UI proxies `POST /api/mint` →
`https://choreo-mint.fly.dev`.

**One-time bootstrap** (Mac/Linux, needs a Fly.io account):

```bash
export FLY_API_TOKEN=FlyV1...        # from https://fly.io/user/personal_access_tokens
export FAUCET_SEED=<64-hex>          # openssl rand -hex 32 — only if you run the faucet
export FLY_ORG=personal              # or your org slug
./scripts/fly-bootstrap.sh
./scripts/fly-deploy-contract.sh     # prints VITE_DEFAULT_CONTRACT
```

Paste the contract address into Lovable env `VITE_DEFAULT_CONTRACT` and republish.
Redeploy mint after server changes with `./scripts/fly-deploy-mint.sh`.

## One-time local setup

Prerequisite: **Docker Desktop** running (`docker info` succeeds).

```bash
# 1. Compact compiler (macOS/Linux)
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
source ~/.zshrc 2>/dev/null || source ~/.bashrc 2>/dev/null || true
compact update
compact --version

# 2. Install JS dependencies (public npm via bun.lock)
bun install
```

## Quick start — local Docker

Once the compiler is installed:

```bash
bun run compile
```

This runs, in order:

1. `bun run midnight:compile` — compile Compact + copy ZK assets into `public/`.
2. `bun run midnight:up` — start node + indexer + proof server via Docker.
3. `VITE_NETWORK_ID=undeployed bun scripts/deploy-midnight.mjs` — deploy + write `.env`.
4. `bun run dev` — start the Vite dev server.

First run pulls ~1 GB of Docker images; initial ZK key generation can take 30–120 s.

### Manual steps

```bash
bun run midnight:compile
docker compose up -d && docker compose ps
VITE_NETWORK_ID=undeployed bun scripts/deploy-midnight.mjs
bun run dev
```

### Image tags

Pinned to match [`midnight-local-dev` `standalone.yml`](https://github.com/midnightntwrk/midnight-local-dev/blob/main/standalone.yml):

- `midnightntwrk/proof-server:8.0.3`
- `midnightntwrk/midnight-node:0.22.5` — standalone `--dev` build (do **not** bump to `2.x`)
- `midnightntwrk/indexer-standalone:4.0.2`

### Fund Lace (local Lace-signed mint only)

On Undeployed **hosted** mint, fees are paid by `choreo-mint` — Lace/tDUST is optional.
For local Lace-signed submits, fund a fresh chain once:

```bash
scripts/fund-lace.sh
```

1. Copy your Lace **unshielded** address (`mn_addr_undeployed1…`).
2. In the faucet CLI, option **2** — fund by public key → **50,000 tNIGHT**.
3. In Lace, **Generate tDUST**, then mint from the app.

Point Lace at **Settings → Network → Custom → `ws://localhost:9944`**.

### Troubleshooting

- **`indexer did not become ready` / node exited** — `docker compose logs --tail=80 node`, then `docker compose down -v && docker compose pull && bun run compile`.
- **Stale chain after image/tag change** — `docker compose down -v` before recompile.
- **Mint stuck / wrong contract** — prefer `VITE_DEFAULT_CONTRACT` over stale `localStorage`.

## Environment

Copy [`.env.example`](./.env.example) for the hosted Fly stack:

```
VITE_NETWORK_ID=undeployed
VITE_INDEXER_URL=https://choreo-indexer.fly.dev/api/v4/graphql
VITE_INDEXER_WS_URL=wss://choreo-indexer.fly.dev/api/v4/graphql/ws
VITE_PROOF_SERVER_URL=https://choreo-proof.fly.dev
VITE_DEFAULT_CONTRACT=d27f543491f863f7ddb40365ad82d7896435253c4ea8728bbf5b6f1478b503d5
VITE_MINT_URL=https://choreo-mint.fly.dev
```

For local Docker, point indexer/proof/node at localhost (`8088` / `6300` / `9944`)
and let the deploy script fill `VITE_DEFAULT_CONTRACT`.

## Explicit non-goals (5-credit scope)

- No IPFS/Pinata — kit content is inline JSON.
- No AI Gateway calls.
- No transfer/resale logic yet — v1 is the license record.
- No CI pipeline (local `bun test` covers the contract simulator).

## Credits

Built during the **Creative AI & Quantum Hackathon** organised by StreetKode Fam
during Indian Krump Festival 14.

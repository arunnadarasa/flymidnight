# Tokenized Choreo Kits

**Sell bundled choreography sequences as tokenized, licensable assets on Midnight.**
Single-page Midnight ZK demo — Compact 0.23 contract, Lace wallet, local proof server.

> Built during the **Creative AI & Quantum Hackathon** organised by StreetKode Fam
> during Indian Krump Festival 14.

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
| **Technology** | Compact 0.23 ZK circuit, `persistentHash` author commitment, `disclose()` boundary, local proof server for real ZK proving. |
| **Originality** | ZK for choreography IP — an unexplored niche. Public catalog + private authorship is a genuinely new tradeoff. |
| **Execution** | One polished page. Real "Proving… 30–120s" UX. Lace-native auth, no Web2 fallback. |
| **Completion** | End-to-end: connect → deploy → publish → browse. All in a single index route. |
| **Documentation** | This README covers setup, run, and criteria in under 5 minutes. |
| **Business value** | MVP for a choreography licensing marketplace — creators keep pseudonymity, buyers get provable authorship. |

## Stack

- Vite + React SPA (TanStack Start template, single index route).
- Compact 0.23 contract → local proof server on `:6300`.
- Lace wallet is the sole auth surface.
- All Midnight code paths gated behind `<ClientOnly>` for SSR safety.
- **Hosted stack on Fly.io** (node + indexer + proof server + faucet) so any visitor with Lace can test the dApp. Local Docker still supported for offline dev.

## Hosted stack (Fly.io) — for the published site

The published site at `choreokits.lovable.app` reaches four Fly apps:

| App | Purpose | Public? |
| --- | --- | --- |
| `choreo-node` | Midnight standalone node (`CFG_PRESET=dev`) | 6PN-internal only |
| `choreo-indexer` | Indexer GraphQL (`/api/v4/graphql`) | HTTPS + WSS |
| `choreo-proof` | Proof server | HTTPS |
| `choreo-faucet` | tDUST faucet (rate-limited, in-memory) | HTTPS |

**One-time bootstrap** (Mac/Linux, needs a Fly.io account):

```bash
export FLY_API_TOKEN=FlyV1...        # from https://fly.io/user/personal_access_tokens
export FAUCET_SEED=<64-hex>          # generate: openssl rand -hex 32 — save it, it funds the faucet
export FLY_ORG=personal              # or your org slug
./scripts/fly-bootstrap.sh
```

Then fund the faucet wallet (one-off) by sending tDUST from the genesis
deployer wallet (seed `…0002`) to the faucet's shown address, and deploy the
contract from a Fly Machine on 6PN:

```bash
./scripts/fly-deploy-contract.sh     # writes VITE_DEFAULT_CONTRACT to stdout
```

Paste the contract address into the Lovable env var `VITE_DEFAULT_CONTRACT`
and republish.

### Local Docker (offline dev)


## Contract

See [`contracts/TokenizedChoreoKits.compact`](./contracts/TokenizedChoreoKits.compact).
Public ledger: `kit_count`, `last_kit` (JSON blob), `last_author_commitment`.
Private witness: `localSecretKey()` → per-user 32-byte value in `localStorage`.
Circuit: `publishKit(payload)` writes the commitment + payload and bumps the counter.

## One-time local setup (Docker Desktop)

Prerequisite: **Docker Desktop** running (`docker info` succeeds).

```bash
# 1. Compact compiler (macOS/Linux)
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
# macOS uses zsh — reload the right rc file, or just open a new shell:
source ~/.zshrc 2>/dev/null || source ~/.bashrc 2>/dev/null || true
compact update            # installs the default compiler (compactc)
compact --version         # sanity check

# 2. Install JS dependencies
bun install
```

## Quick start — everything in one command

Once the compiler is installed, `bun run compile` chains the whole local flow:

```bash
bun run compile
```

It runs, in order:

1. `bun run midnight:compile` — compile the Compact contract and copy ZK assets into `public/`.
2. `bun run midnight:up` — start the local Midnight stack (node + indexer + proof server) via Docker.
3. `VITE_NETWORK_ID=undeployed bun scripts/deploy-midnight.mjs` — deploy the contract and write the address to `.env`.
4. `bun run dev` — start the Vite dev server.

First run pulls ~1 GB of Docker images and the initial ZK key generation can
take 30–120 s. After that, subsequent runs reuse the compiled assets and chain
state.

## Step-by-step (if you prefer manual control)

```bash
# Compile the contract and copy ZK assets into public/
compact compile contracts/TokenizedChoreoKits.compact contracts/managed/tokenized-choreo-kits
cp -r contracts/managed/tokenized-choreo-kits/keys public/keys
cp -r contracts/managed/tokenized-choreo-kits/zkir public/zkir

# Bring up the local Midnight stack (node + indexer + proof server)
docker compose up -d       # first run pulls ~1 GB
docker compose ps          # all three services should be "Up"

# Deploy the contract and save the address to .env
VITE_NETWORK_ID=undeployed bun scripts/deploy-midnight.mjs

# Start the app
bun run dev
```

Docker cheat sheet:

```bash
docker compose pull                    # first run — pulls pinned image tags
docker compose logs -f proof-server    # tail proof server (Ctrl+C to detach)
docker compose logs -f node            # tail chain node
docker compose down                    # stop everything (keeps chain data)
docker compose down -v                 # stop + wipe the chain data volume
# equivalent shortcuts: scripts/midnight-stack.sh {up|down|logs [svc]|ps|reset}
```

### Image tags

`docker-compose.yml` mirrors the official
[`midnightntwrk/midnight-local-dev` `standalone.yml`](https://github.com/midnightntwrk/midnight-local-dev/blob/main/standalone.yml),
pinned to the same tags:

- `midnightntwrk/proof-server:8.0.3`
- `midnightntwrk/midnight-node:0.22.5` — the standalone `--dev` build
- `midnightntwrk/indexer-standalone:4.0.2`

Do **not** bump `midnight-node` to `2.x` — those are Partner Chain builds
that require Cardano `db-sync` (or a `mock_registrations_file`) and will
crash-loop on a standalone stack.

### Troubleshooting

- **`indexer did not become ready` / `Container 'midnight-node' is exited`** — the deploy script inspects `midnight-node` and fails fast on `restarting` / `exited`. Run `docker compose logs --tail=80 node` to see the crash reason, then `docker compose down -v && docker compose pull && bun run compile`.
- **Stale chain state after a compose or image-tag change** — always `docker compose down -v` (wipes the volume) before re-running `bun run compile`.

Point Lace at the local node: **Settings → Network → Custom → `ws://localhost:9944`**.

## Fund Lace with tNIGHT + tDUST (one-time per fresh chain)

Fresh chains start empty for browser wallets. Lace connects fine, but until it has
tDUST it can't pay fees, so **Mint kit** will fail with `Unexpected error submitting
scoped transaction '<unnamed>': Error`.

In a second terminal (leave the main app running):

```bash
scripts/fund-lace.sh
```

That clones and starts [`midnightntwrk/midnight-local-dev`](https://github.com/midnightntwrk/midnight-local-dev),
which ships an interactive faucet CLI.

1. In Lace, copy your **unshielded** address (shown on the app's `01 · connect lace` panel).
   Prefix: `mn_addr_undeployed1…`.
2. In the CLI, select **option 2** — "Fund accounts by public key" — and paste that address.
   The wallet receives **50,000 tNIGHT**.
3. Back in Lace, tap **Generate tDUST** on the tNIGHT balance. Within one block the
   `tDUST tank empty` chip in the app flips to a live number.
4. Now **Mint kit** goes through.

After `docker compose down -v` (or any chain reset) you'll need to fund again.



## Run the app

If you already deployed and just want to restart the UI:

```bash
cp .env.example .env   # only if you don't have a .env yet
bun run dev
```

Open the preview, connect Lace, and mint kits. The deploy script already wrote
`VITE_DEFAULT_CONTRACT` to `.env`, so the contract address should be pre-filled.

## Environment

Copy `.env.example` to `.env`:

```
VITE_NETWORK_ID=undeployed
VITE_INDEXER_URL=http://localhost:8088/api/v4/graphql
VITE_INDEXER_WS_URL=ws://localhost:8088/api/v4/graphql/ws
VITE_PROOF_SERVER_URL=http://localhost:6300
VITE_NODE_WS=ws://localhost:9944
VITE_DEFAULT_CONTRACT=  # paste hex address after deploy
```

> The local standalone Indexer serves `/api/v4/graphql` (matches hosted preview/preprod).

## Explicit non-goals (5-credit scope)

- No IPFS/Pinata — kit content is inline JSON.
- No AI Gateway calls.
- No transfer/resale logic yet — v1 is the license record. Marketplace tx flow
  is a natural v2 using the same contract shape.
- No tests, no CI. Ship the demo.

## Credits

Built during the **Creative AI & Quantum Hackathon** organised by StreetKode Fam
during Indian Krump Festival 14.

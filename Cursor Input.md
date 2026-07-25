# Cursor Input — flymidnight / Tokenized Choreo Kits

Session notes from getting **flymidnight** (Lovable + Midnight ZK / Undeployed hosted on Fly.io) minting end-to-end: Fly node + indexer + proof + `choreo-mint`, Lovable/localhost UI → real `publishKit` txs.

Repo: https://github.com/arunnadarasa/flymidnight

---

## Goal

1. Bring up (or keep healthy) the Fly Undeployed stack (`choreo-node` / `choreo-indexer` / `choreo-proof` / `choreo-mint`).
2. Keep Compact contract `TokenizedChoreoKits` deployed at a stable address.
3. Make mobile-friendly mint work without Lace/tDUST (genesis seed `…0002` on the mint server).
4. Unblock UI stuck on “wallet warming up, retry in 30s” and prove a real on-chain mint.

---

## Successes

### 1. Wallet warm: wrong readiness shape (root cause of endless 503)

- **Symptom:** UI showed “Warming up mint server” / `wallet warming up, retry in 30s`. `/health` stayed `{ ok:false, synced:false, dust:"0", address:null, error:null }` forever.
- **False lead:** Skill note about `subscribeRuntimeVersion` `1000 Normal Closure` on Fly 6PN. That log **does appear**, but is **non-fatal** — `wallet.start()` still returns and dust syncs.
- **Cause:** `fly/mint/server.mjs` (and `scripts/deploy-midnight.mjs` `waitForWalletReady`) checked the **legacy** wallet state shape:
  - `state.syncProgress.synced`
  - `state.balances`
  - `state.address`
- WalletFacade / testkit-js **4.1.1** emits `{ shielded, unshielded, dust, pending }` with:
  - `state.shielded.state.progress.isStrictlyComplete()`
  - `state.unshielded.progress.isStrictlyComplete()`
  - `state.dust.state.progress.isStrictlyComplete()`
  - `state.dust.balance(new Date())`
  - address from `keystore.getBech32Address().asString()`
- **Fix:** `readWalletReady()` using the Facade API. SSH probe on the mint machine went from “never ready” → **READY in ~3s** with dust `1.25e24`.
- **Also fixed:** same readiness logic in `scripts/deploy-midnight.mjs`.

### 2. Stale contract address in the browser (37fab… vs d27f…)

- **Symptom:** Mint stuck on `mint-resolve: looking up contract 37fabdd8f3…` for minutes; user’s real Fly deploy was `d27f543491f863f7ddb40365ad82d7896435253c4ea8728bbf5b6f1478b503d5`.
- **Cause:** UI preferred `localStorage.choreo:contract-address` over `VITE_DEFAULT_CONTRACT`. An old local/redeploy address overrode `.env`.
- **Evidence:** Indexer GraphQL confirmed `d27f5434…` as `ContractDeploy` at block 375. `findDeployedContract` for `d27f…` completed in **~400ms**.
- **Fix:** Prefer env when set; overwrite stale localStorage. Deploy panel copy points at Fly/`VITE_DEFAULT_CONTRACT`. Added 60s timeout around `findDeployedContract` so bad addresses fail loudly.

### 3. Proof server unreachable over 6PN (mint prove failure)

- **Symptom:** After resolve succeeded for `d27f…`, mint returned:
  ```text
  Unable to connect. Is the computer able to access the url?
  ```
  Stage stuck at `mint-prove`.
- **Cause:** `fly/mint/fly.toml` had `PROOF_SERVER_URL=http://choreo-proof.internal:6300`. Stock `proof-server:8.0.3` is **IPv4-only**; Fly 6PN is **IPv6**. DNS for `.internal` resolves, TCP/HTTP from mint fails.
- **Evidence (from mint machine SSH):**
  - `http://choreo-proof.internal:6300/version` → `FAIL Unable to connect`
  - `https://choreo-proof.fly.dev/version` → `8.0.3`
- **Fix:** `PROOF_SERVER_URL=https://choreo-proof.fly.dev` (matches `fly/proof/fly.toml` comment: public edge only, no socat/IPv6 proxy).

### 4. End-to-end mint proof

After readiness + proof URL fixes:

| Field | Value |
| --- | --- |
| Contract | `d27f543491f863f7ddb40365ad82d7896435253c4ea8728bbf5b6f1478b503d5` |
| Mint HTTP | `200` in ~23s (warm path) |
| txId | `00a49553fba15d0cad5bd2f8f06769686dccb18f8a84b59271a6b96caabd7a84b9` |
| `/health` stage | `confirmed` → `ready` |

UI later confirmed another submit (`Submitted on-chain. Tx: 009edb2a…`).

### 5. Stack health checks that saved time

Before chasing wallet bugs:

- Indexer tip was live (`block.height` ~700–840) — node **was** authoring.
- Proof public `/version` → `8.0.3`.
- Indexer GraphQL subscriptions: `blocks`, `contractActions`, `dustLedgerEvents`, … — **no** `wallet` field (confirms indexer 4.0.2; do not use wallet@5 against this stack).

---

## Failures & false starts

| What went wrong | Why | Lesson |
| --- | --- | --- |
| Assumed Fly WS `1000 Normal Closure` was the hard hang | Same log appears on successful warm; start still completes | Treat skill “known blockers” as hypotheses; verify with SSH probes |
| Health had no `progress` / `restarts` fields initially | Live image lagged local `server.mjs` with stage plumbing | Redeploy mint after readiness/progress changes; curl `/health` shape |
| Mint hung on `37fab…` while `.env` had `d27f…` | localStorage > env | Env is canonical for Fly undeployed demos |
| `choreo-proof.internal` in mint env | IPv4-only proof binary vs IPv6 6PN | Prefer public `https://choreo-proof.fly.dev` unless you add an IPv6 sidecar |
| Early health check right after deploy showed `ok:false` | Wallet needs ~10–30s for unshielded `isStrictlyComplete` | Poll `/health` until `stage:ready`, don’t declare failure at `sleep 3` |
| Debug ingest `127.0.0.1:7512` from Fly | Fly machines can’t reach the laptop ingest | Use `flyctl logs` + structured `[stage]` / temporary `[dbg]` console lines |
| This workspace download had no `.git` | Lovable ↔ GitHub sync is the source of truth for push | Clone/push via `arunnadarasa/flymidnight`; don’t assume Downloads zip is the remote |

---

## How we would do things differently next time

1. **Smoke the Fly stack before any UI mint:** indexer tip, proof `/version`, mint `/health` until `ok:true` + `stage:ready`.
2. **Probe WalletFacade state shape in 30 seconds** on the mint machine (or locally against Docker) before writing readiness checks — never assume `syncProgress`/`balances`.
3. **Treat `VITE_DEFAULT_CONTRACT` as canonical** on Undeployed Fly demos; localStorage is cache only, not source of truth.
4. **Proof server from mint = public HTTPS** unless you’ve verified IPv6 listen on proof. Do not copy “use `.internal` for everything” from node/indexer.
5. **Node/indexer stay on 6PN** (`choreo-node.internal:9944`, `choreo-indexer.internal:8088`) — those worked; only proof was the IPv4 trap.
6. **Timeout `findDeployedContract`** (e.g. 60s) so stale addresses surface as 500s, not infinite “PROVING…”.
7. **SSH into `choreo-mint` early** for DNS/TCP/WS/proof probes — faster than guessing from the browser.
8. **Redeploy mint after every server.mjs / fly.toml env change**; UI-only fixes don’t update the Fly image.
9. **Lovable vs localhost:** mint API is on Fly either way; frontend env/localStorage bugs still break Lovable independently of Cursor disk edits until synced/pushed.
10. **Keep product mint status UI** (boot → wallet-start → dust-sync → ready → prove). Strip only temporary debug ingest logs after confirmation.

---

## Key files

| Path | Role |
| --- | --- |
| `fly/mint/server.mjs` | Genesis-wallet mint API; Facade readiness; resolve timeout |
| `fly/mint/fly.toml` | `PROOF_SERVER_URL=https://choreo-proof.fly.dev`; node/indexer `.internal` |
| `fly/proof/fly.toml` | Stock proof image, public HTTP, 2gb RAM |
| `fly/node/fly.toml` | `--alice --force-authoring`, RPC on `[::]:9944` |
| `scripts/fly-deploy-mint.sh` | Redeploy mint image |
| `scripts/deploy-midnight.mjs` | Contract deploy + fixed `waitForWalletReady` |
| `src/routes/api/mint.ts` | Thin proxy → `choreo-mint.fly.dev` |
| `src/routes/index.tsx` | Prefer `VITE_DEFAULT_CONTRACT` over stale localStorage |
| `src/components/MintServerStatus.tsx` | Warm/mint pipeline UI |
| `src/components/PublishKitForm.tsx` | Undeployed → POST `/api/mint` |
| `.env` | `VITE_DEFAULT_CONTRACT=d27f5434…b503d5` + Fly indexer/proof URLs |

---

## Fly apps (this session)

| App | Role | Notes |
| --- | --- | --- |
| `choreo-node` | Midnight node `0.22.5` | Internal 9944; must author blocks |
| `choreo-indexer` | Indexer `4.0.2` | Public GraphQL `/api/v4/graphql` |
| `choreo-proof` | Proof server `8.0.3` | Public only from mint’s POV |
| `choreo-mint` | Bun mint API | Genesis seed `…0002`; 2gb VM |

No Fly org token was required in-session when `~/.fly/config.yml` already held a valid access token (`flyctl auth` / local flyctl).

---

## Current working commands

```bash
# Mint health (wait until ok:true / stage ready)
curl -s https://choreo-mint.fly.dev/health | jq '{ok,synced,dust,stage:.progress.stage,message:.progress.message}'

# Indexer tip + contract
curl -s -X POST https://choreo-indexer.fly.dev/api/v4/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"{ block { height } }"}'
curl -s -X POST https://choreo-indexer.fly.dev/api/v4/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"query($a:HexEncoded!){ contractAction(address:$a){ __typename } }","variables":{"a":"d27f543491f863f7ddb40365ad82d7896435253c4ea8728bbf5b6f1478b503d5"}}'

# Redeploy mint after server.mjs / fly.toml changes
FLY_ACCESS_TOKEN=... ./scripts/fly-deploy-mint.sh

# Manual mint smoke (warm ~20–40s; cold prove longer)
curl -s -X POST https://choreo-mint.fly.dev/mint \
  -H 'content-type: application/json' \
  -d '{"contractAddress":"d27f543491f863f7ddb40365ad82d7896435253c4ea8728bbf5b6f1478b503d5","title":"Krump","steps":"Krump","priceDust":10}'
```

Env (frontend / Lovable):

```text
VITE_NETWORK_ID=undeployed
VITE_INDEXER_URL=https://choreo-indexer.fly.dev/api/v4/graphql
VITE_INDEXER_WS_URL=wss://choreo-indexer.fly.dev/api/v4/graphql/ws
VITE_PROOF_SERVER_URL=https://choreo-proof.fly.dev
VITE_DEFAULT_CONTRACT=d27f543491f863f7ddb40365ad82d7896435253c4ea8728bbf5b6f1478b503d5
# optional override:
# VITE_MINT_URL=https://choreo-mint.fly.dev
```

---

## Open / out of scope

- Lace signing on Undeployed — intentionally skipped; server mint pays fees.
- `choreo-faucet` was not present / not required for this mobile-mint blueprint.
- Optional later: IPv6/socat on proof if you insist on `.internal` for mint→proof latency.
- Sync this Downloads workspace (or Lovable edits) into GitHub `arunnadarasa/flymidnight` so Cursor Input + mint fixes land on the connected branch.

---

## Retrospective — one-line summary

**Undeployed Fly mint works when readiness uses WalletFacade `isStrictlyComplete` + `dust.balance`, the UI sticks to `VITE_DEFAULT_CONTRACT`, and the mint app proves via public `https://choreo-proof.fly.dev` — not `choreo-proof.internal`.**

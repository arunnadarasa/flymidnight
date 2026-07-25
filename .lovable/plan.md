# Blueprint: fully mobile-first Midnight Undeployed dApp on Fly.io

Goal: a hackathon participant can visit `flymidnight.lovable.app` from their phone, tap **Mint Kit**, and get a real on-chain Midnight tx — with zero laptop, zero Docker, zero Lace tDUST. Everything server-side runs on Fly.

## Current gap

The published Cloudflare Worker can’t run `mint.server.ts` (Node/WASM/WebSockets). `vite.config.ts` swaps it for a stub in the build, so the UI shows:

> Server mint is only available in local dev against the Undeployed Docker stack.

Fly already hosts node, indexer, proof-server, faucet. What’s missing is a `**choreo-mint` Fly app** that owns the mint flow, and a Worker route that just proxies to it.

## What to build

### 1. New Fly app: `choreo-mint`

- `fly/mint/Dockerfile` (Bun 1.2 debian, same base as `fly/faucet`) — bundles `src/lib/mint.server.ts` logic + the compiled contract artefacts from `contracts/managed/tokenized-choreo-kits/`.
- `fly/mint/server.mjs` — tiny `http.createServer` bound to `0.0.0.0:8080`:
  - `POST /mint` `{ contractAddress, title, steps, priceDust }` → runs the exact `publishKitLocal` flow (genesis seed …0002, warmed wallet cached in module scope) → returns `{ txId }`.
  - `GET /health` → `{ ok, synced, dust }`.
  - CORS `*` + `OPTIONS`.
- `fly/mint/fly.toml`:
  - `image = oven/bun:1.2.20-debian`, internal port 8080, public HTTPS.
  - `[[vm]] memory = "2gb"` (proof calls buffer keys), `min_machines_running = 1`, `auto_stop_machines = "suspend"`.
  - Env: `NETWORK_ID=undeployed`, `NODE_WS=ws://choreo-node.internal:9944`, `INDEXER_URL=http://choreo-indexer.internal:8088/api/v4/graphql`, `INDEXER_WS_URL=ws://choreo-indexer.internal:8088/api/v4/graphql/ws`, `PROOF_SERVER_URL=http://choreo-proof.internal:6300` (internal 6PN — no public egress needed, and the internal proof endpoint avoids the public 2gb-RAM contention).
  - Uses the **same genesis seed `…0002` as the faucet-funder path** — but only ONE service should sign with it at a time. Scale `choreo-faucet` to 0 (or move faucet to a different seed) before enabling mint, otherwise UTXO races reappear.

### 2. Rewire the Worker route

- `src/routes/api/mint.ts` becomes a thin proxy: validate with Zod, `fetch("https://choreo-mint.fly.dev/mint", { method: "POST", body })`, forward status + JSON. No `mint.server.ts` import, no SSR stub needed.
- Delete `src/lib/mint.server.ts`, `src/lib/mint.ssr-stub.ts`, and the mint entries in `midnightSsrStub()`. This removes a large chunk of Vite build risk.
- Add `VITE_MINT_URL` env (default `https://choreo-mint.fly.dev`) so preview/prod point at the same Fly service.

### 3. Frontend UX fixes for mobile / Fly-only mode

- `src/components/PublishKitForm.tsx`: on Undeployed, always call `/api/mint`; remove the “only available in local dev” error and replace with a "Server is warming up (~30s on first mint)" state that polls `choreo-mint /health` before enabling the button.
- `src/components/WalletConnectPanel.tsx`: on Undeployed, hide Lace + tDUST panels entirely (already partially done) — mobile visitors won’t have Lace anyway. Add a one-line "Fees paid by the demo server on Fly" note.
- `src/routes/index.tsx`: reword step 02 — the contract is already deployed on Fly (`d27f543491…b503d5`), so hide the "Try in-browser deploy" button and the "run bun scripts/deploy-midnight.mjs" instructions. Show the address as read-only with a check mark.

### 4. Bootstrap + deploy scripts

- Extend `scripts/fly-bootstrap.sh` with a `create_app choreo-mint` block + `flyctl secrets set` for the genesis seed (or reuse the same secret name).
- Add `scripts/fly-deploy-mint.sh` mirroring `fly-deploy-contract.sh`: `flyctl deploy -c fly/mint/fly.toml`.
- One-time: contract deploy stays via `scripts/fly-deploy-contract.sh` (ephemeral 6PN machine). Address gets written to `.env` and committed as `VITE_DEFAULT_CONTRACT`.

### 5. Skill update (`lovable-midnight`)

Add a **"Mobile-only Fly.io blueprint"** section documenting:

- The 5-app topology (`choreo-node`, `choreo-indexer`, `choreo-proof`, `choreo-faucet`, `choreo-mint`).
- Rule: only one Fly service signs with the genesis seed at a time — either faucet OR mint, not both. Recommend disabling faucet on Undeployed since the server pays fees anyway.
- Worker route pattern (thin proxy, no `.server.ts` imports).
- Warm-up UX (`/health` polling, 30–60s first request, spinner budget ≥ 5 min).

## Sequence

```text
1. Author fly/mint/{Dockerfile, server.mjs, fly.toml}
2. Rewrite src/routes/api/mint.ts as a proxy; delete mint.server.ts + stub; simplify vite.config.ts
3. Frontend edits (PublishKitForm, WalletConnectPanel, index step 02)
4. Extend fly-bootstrap.sh + add fly-deploy-mint.sh
5. Deploy choreo-mint from the sandbox (requires FLY_API_TOKEN)
6. Scale choreo-faucet to 0 to avoid seed contention
7. Verify /api/mint end-to-end from the published site (open on phone)
8. Update lovable-midnight skill with the mobile-only blueprint
```

## Open question before I build

Do you want to **keep `choreo-faucet` for future Lace users** (and move it to a second funded seed), or **retire it entirely** since server-side mint means visitors never need tDUST? Retiring is simpler and cheaper — the app runs on 4 machines instead of 5, and there’s zero seed contention. Recommend: retire. 

retire please
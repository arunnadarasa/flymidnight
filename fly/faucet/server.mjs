// Minimal HTTP tDUST faucet for the hosted Undeployed stack.
// POST /grant { address } -> { txId } | { error }
// GET  /health           -> { ok, address, balance }
//
// The faucet wallet is opened from FAUCET_SEED on boot and pointed at the
// Fly indexer + proof-server (NODE_WS is the internal ws:// URL to
// choreo-node.internal:9944).
//
// Rate limit: per-address in-memory sliding window (MAX_PER_HOUR).
import { WebSocket } from "ws";
globalThis.WebSocket = WebSocket;

import { WalletBuilder } from "@midnight-ntwrk/wallet";
import { NetworkId } from "@midnight-ntwrk/zswap";
import { ttlOneHour } from "@midnight-ntwrk/midnight-js-utils";

const {
  FAUCET_SEED,
  INDEXER_URL,
  INDEXER_WS_URL,
  PROOF_SERVER_URL,
  NODE_WS,
  NETWORK_ID = "undeployed",
  DUST_PER_REQUEST = "50000000",
  MAX_PER_HOUR = "3",
  PORT = "8787",
} = process.env;

if (!FAUCET_SEED || FAUCET_SEED.length !== 64) {
  console.error("FAUCET_SEED must be a 64-char hex string");
  process.exit(1);
}

const NET =
  NETWORK_ID === "undeployed" || NETWORK_ID === "preview"
    ? NetworkId.Undeployed
    : NETWORK_ID === "mainnet"
      ? NetworkId.MainNet
      : NetworkId.TestNet;

const DUST_AMOUNT = BigInt(DUST_PER_REQUEST);
const MAX = Number(MAX_PER_HOUR);
const HOUR = 60 * 60 * 1000;
const grants = new Map(); // address -> number[] timestamps

console.log("Opening faucet wallet…");
console.log("Indexer:", INDEXER_URL, INDEXER_WS_URL);
console.log("Proof server:", PROOF_SERVER_URL);
console.log("Node:", NODE_WS);
const wallet = await WalletBuilder.buildFromSeed(
  INDEXER_URL,
  INDEXER_WS_URL,
  PROOF_SERVER_URL,
  NODE_WS,
  FAUCET_SEED,
  NET,
);
wallet.start();
console.log("Wallet started; waiting for sync…");

// Poll wallet state forever — no readiness timeout. On a fresh node the
// wallet may take a few minutes to sync; after a node restart it may need
// to re-sync from block 0. /health reflects the live state either way.
// "ready" requires BOTH a non-zero dust balance AND syncProgress.synced,
// so we never try to spend before the wallet has seen its own UTXOs.
let ready = false;
let lastStatus = { balance: "0", synced: false, applyGap: null };
(async () => {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const s = wallet.state();
      const balance = s?.balances?.dust?.toString?.() ?? "0";
      const sp = s?.syncProgress;
      // Different SDK versions expose sync differently — accept any truthy
      // "synced" flag, or applyGap === 0n, as "caught up".
      const synced =
        sp?.synced === true ||
        (sp?.applyGap !== undefined && BigInt(sp.applyGap) === 0n) ||
        (sp?.sourceGap !== undefined && BigInt(sp.sourceGap) === 0n);
      lastStatus = {
        balance,
        synced: !!synced,
        applyGap: sp?.applyGap?.toString?.() ?? null,
      };
      const nowReady = BigInt(balance) > 0n && !!synced;
      if (nowReady !== ready) {
        ready = nowReady;
        console.log(
          `Faucet ${ready ? "READY" : "NOT READY"} — balance=${balance} synced=${synced} applyGap=${lastStatus.applyGap}`,
        );
      } else {
        console.log(
          `sync: balance=${balance} synced=${synced} applyGap=${lastStatus.applyGap}`,
        );
      }
    } catch (e) {
      console.warn("wallet.state() threw:", e?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
})();


const ADDR_RE = /^mn_(?:shield-)?addr_(undeployed|test)1[0-9a-z]+$/i;

function rateOk(addr) {
  const now = Date.now();
  const list = (grants.get(addr) ?? []).filter((t) => now - t < HOUR);
  if (list.length >= MAX) {
    grants.set(addr, list);
    return false;
  }
  list.push(now);
  grants.set(addr, list);
  return true;
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
}

import http from "node:http";
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  if (req.url === "/health") {
    const s = wallet.state();
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        ok: ready,
        address: s?.address ?? null,
        balance: s?.balances?.dust?.toString?.() ?? lastStatus.balance,
        synced: lastStatus.synced,
        applyGap: lastStatus.applyGap,
      }),
    );
  }


  if (req.method !== "POST" || req.url !== "/grant") {
    res.writeHead(404).end("not found");
    return;
  }

  let body = "";
  for await (const c of req) body += c;
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "invalid json" }));
  }
  const address = String(payload?.address ?? "").trim();
  if (!ADDR_RE.test(address)) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "invalid address" }));
  }
  if (!ready) {
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "faucet warming up, retry in 30s" }));
  }
  if (!rateOk(address)) {
    res.writeHead(429, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: `rate limited — max ${MAX}/hour per address` }));
  }
  try {
    const tx = await wallet.transferTransaction([
      { amount: DUST_AMOUNT, tokenType: "dust", receiverAddress: address },
    ], ttlOneHour());
    const proved = await wallet.proveTransaction(tx);
    const txId = await wallet.submitTransaction(proved);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ txId, amount: DUST_AMOUNT.toString() }));
  } catch (e) {
    // Transient node/indexer blips can leave the wallet in a bad state.
    // Flip ready=false so the next /health cycle re-evaluates from
    // wallet.state() instead of pinning us at 500 forever.
    ready = false;
    console.error("grant failed — marking faucet not-ready:", e);
    res.writeHead(500, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: e?.message ?? "grant failed" }));
  }
});


server.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Faucet listening on :${PORT}`);
});

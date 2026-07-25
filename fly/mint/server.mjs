// choreo-mint — HTTP wrapper around a warmed Midnight wallet that signs
// publishKit txs against the deployed TokenizedChoreoKits contract.
// The wallet uses the genesis-funded seed (…0002) so visitors never need Lace.
//
// Endpoints
//   GET  /health -> { ok, synced, dust, address }
//   POST /mint   -> { txId }        body: { contractAddress, title, steps, priceDust }
//
// Boot: opens the wallet, waits for sync + non-zero dust, warms providers
// + compiledContract, then keeps them in module scope. First mint after boot
// takes 60–120s (proof server cold-loads the proving key); warm mints ~30s.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { firstValueFrom } from "rxjs";
import { WebSocket } from "ws";
globalThis.WebSocket = WebSocket;

import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { FluentWalletBuilder } from "@midnight-ntwrk/testkit-js";
import {
  LedgerParameters,
  ZswapSecretKeys,
  DustSecretKey,
} from "@midnight-ntwrk/midnight-js-protocol/ledger";
import { ttlOneHour } from "@midnight-ntwrk/midnight-js-utils";

const {
  NETWORK_ID = "undeployed",
  INDEXER_URL,
  INDEXER_WS_URL,
  PROOF_SERVER_URL,
  NODE_WS,
  PORT = "8080",
} = process.env;

const NODE_HTTP = (NODE_WS ?? "").replace(/^ws/, "http");
const GENESIS_SEED =
  "0000000000000000000000000000000000000000000000000000000000000002";

const ZK_CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "contracts",
  "managed",
  "tokenized-choreo-kits",
);

setNetworkId(NETWORK_ID);

console.log("choreo-mint boot", { NETWORK_ID, INDEXER_URL, PROOF_SERVER_URL, NODE_WS });

let status = { ok: false, synced: false, dust: "0", address: null, error: null, restarts: 0, lastClosure: null };
let warmed = null; // { providers, compiledContract, deployedCache: Map, teardown }
let warming = null;

// Fine-grained progress the UI polls to render a step list. `stage` is the
// current phase; `steps` is a bounded history so users can watch phases
// tick through even if their poll misses a transition.
const STAGES = [
  "boot",           // process started, env parsed
  "wallet-start",   // wallet.start() + first-state handshake
  "dust-sync",      // waiting for indexer sync + genesis dust balance
  "providers",      // building proof/indexer/private-state providers
  "ready",          // wallet warm, accepting mints
  "reconnecting",   // WS dropped, re-warming
  "mint-resolve",   // findDeployedContract for the requested address
  "mint-prove",     // building tx + proving via proof server
  "mint-submit",    // submitting proven tx to the node
  "confirmed",      // last mint returned a txId
  "error",
];

const progress = {
  stage: "boot",
  message: "process starting",
  since: Date.now(),
  steps: [{ stage: "boot", message: "process starting", at: Date.now() }],
  lastMint: null, // { txId, at }
};

function setStage(stage, message = "") {
  if (!STAGES.includes(stage)) stage = "error";
  progress.stage = stage;
  progress.message = message;
  progress.since = Date.now();
  progress.steps.push({ stage, message, at: Date.now() });
  if (progress.steps.length > 40) progress.steps.splice(0, progress.steps.length - 40);
  console.log(`[stage] ${stage}${message ? ": " + message : ""}`);
}

/** WalletFacade readiness — NOT the legacy {syncProgress,balances,address} shape. */
function readWalletReady(state, keystore) {
  const shieldedDone = state?.shielded?.state?.progress?.isStrictlyComplete?.() === true;
  const unshieldedDone = state?.unshielded?.progress?.isStrictlyComplete?.() === true;
  const dustDone = state?.dust?.state?.progress?.isStrictlyComplete?.() === true;
  const synced = shieldedDone && unshieldedDone && dustDone;
  let dust = 0n;
  try {
    const raw = state?.dust?.balance?.(new Date()) ?? 0n;
    dust = typeof raw === "bigint" ? raw : BigInt(raw);
  } catch {
    dust = 0n;
  }
  const address = keystore?.getBech32Address?.()?.asString?.() ?? null;
  return { synced, dust, address, ok: synced && dust > 0n };
}


// Fly Machines occasionally close the node WS handshake with code 1000
// ("Normal Closure") before the wallet finishes its initial subscribe. The
// wallet SDK surfaces this as either a thrown error from `wallet.start()` or
// a silent stall (no state emissions). Wrap start() to detect both and retry
// with backoff; also re-warm on later stream errors.
const WS_RETRY_MAX = 8;
const WS_RETRY_BASE_MS = 1500;
const FIRST_STATE_TIMEOUT_MS = 45_000;

function isTransientWsError(err) {
  const msg = String(err?.message ?? err ?? "");
  return (
    /1000/.test(msg) ||
    /Normal Closure/i.test(msg) ||
    /WebSocket/i.test(msg) ||
    /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|handshake/i.test(msg)
  );
}

async function startWithRetry(wallet, zswapSecretKeys, dustSecretKey) {
  for (let attempt = 1; attempt <= WS_RETRY_MAX; attempt++) {
    try {
      setStage("wallet-start", attempt === 1 ? "opening node WebSocket" : `retry ${attempt}/${WS_RETRY_MAX}`);
      await wallet.start(zswapSecretKeys, dustSecretKey);
      // Watchdog: ensure the state stream actually emits — a silent stall
      // after start() usually means the node WS closed during subscribe.
      const firstState = await Promise.race([
        firstValueFrom(wallet.state()),
        sleep(FIRST_STATE_TIMEOUT_MS).then(() => {
          throw new Error(`first-state timeout after ${FIRST_STATE_TIMEOUT_MS}ms (WS handshake stalled)`);
        }),
      ]);
      return firstState;
    } catch (err) {
      const transient = isTransientWsError(err);
      console.warn(`wallet.start attempt ${attempt}/${WS_RETRY_MAX} failed${transient ? " (transient)" : ""}:`, err?.message ?? err);
      status.error = `start attempt ${attempt}: ${err?.message ?? err}`;
      status.lastClosure = { reason: err?.message ?? String(err), at: Date.now(), transient, source: "wallet.start", attempt };
      try { await wallet.close?.(); } catch {}
      if (!transient && attempt >= 3) throw err;
      if (attempt === WS_RETRY_MAX) throw err;
      const delay = Math.min(WS_RETRY_BASE_MS * 2 ** (attempt - 1), 20_000);
      await sleep(delay);
    }
  }
  throw new Error("unreachable");
}

function scheduleRewarm(reason) {
  console.warn("re-warming wallet:", reason);
  status.ok = false;
  status.error = `re-warming: ${reason}`;
  status.restarts += 1;
  status.lastClosure = { reason: String(reason), at: Date.now(), transient: true, source: "rewarm", attempt: status.restarts };
  setStage("reconnecting", reason);
  try { warmed?.teardown?.(); } catch {}
  warmed = null;
  warming = null;
  void ensureWarming();
}

async function warm() {
  const build = await FluentWalletBuilder.forEnvironment({
    walletNetworkId: NETWORK_ID,
    networkId: NETWORK_ID,
    indexer: INDEXER_URL,
    indexerWS: INDEXER_WS_URL,
    node: NODE_HTTP,
    nodeWS: NODE_WS,
    proofServer: PROOF_SERVER_URL,
  })
    .withSeed(GENESIS_SEED)
    .withDustOptions({
      ledgerParams: LedgerParameters.initialParameters(),
      additionalFeeOverhead: 1_000n,
      feeBlocksMargin: 15,
    })
    .buildWithoutStarting();

  const { wallet, seeds, keystore } = build;
  const zswapSecretKeys = ZswapSecretKeys.fromSeed(seeds.shielded);
  const dustSecretKey = DustSecretKey.fromSeed(seeds.dust);
  await startWithRetry(wallet, zswapSecretKeys, dustSecretKey);

  // Subscribe to state stream so we can detect later WS drops and re-warm.
  // Any error/complete on state() means the underlying node subscription
  // collapsed; re-warming rebuilds the WebSocket handshake.
  const stateSub = wallet.state().subscribe({
    error: (e) => scheduleRewarm(`state stream error: ${e?.message ?? e}`),
    complete: () => scheduleRewarm("state stream completed unexpectedly"),
  });

  setStage("dust-sync", "waiting for indexer sync and genesis dust balance");
  // Poll wallet.state() until synced + funded. If the stream errors mid-poll
  // (transient WS drop), surface it and let scheduleRewarm restart us.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const s = await Promise.race([
        firstValueFrom(wallet.state()),
        sleep(30_000).then(() => { throw new Error("state poll timeout"); }),
      ]);
      const ready = readWalletReady(s, keystore);
      status = {
        ok: ready.ok,
        synced: ready.synced,
        dust: ready.dust.toString(),
        address: ready.address,
        error: null,
        restarts: status.restarts,
        lastClosure: status.lastClosure,
      };
      // Surface interim sync progress so the UI can show "syncing N blocks".
      if (!ready.synced) {
        const applied = s?.dust?.state?.progress?.appliedIndex;
        setStage(
          "dust-sync",
          applied != null ? `syncing dust (applied ${applied})` : "syncing indexer",
        );
      } else if (ready.dust <= 0n) {
        setStage("dust-sync", "synced; waiting for genesis dust balance");
      }
      if (ready.ok) break;
    } catch (e) {
      status.error = e?.message ?? String(e);
      if (isTransientWsError(e)) {
        try { stateSub.unsubscribe(); } catch {}
        throw e; // bubble to ensureWarming; caller schedules re-warm
      }
    }
    await sleep(3_000);
  }
  console.log("wallet ready", status);
  setStage("providers", "building proof + indexer providers");



  const coinPublicKey = zswapSecretKeys.coinPublicKey;
  const zkConfigProvider = new NodeZkConfigProvider(ZK_CONFIG_PATH);
  const walletProvider = {
    getCoinPublicKey: () => coinPublicKey,
    getEncryptionPublicKey: () => zswapSecretKeys.encryptionPublicKey,
    balanceTx: async (tx) => {
      const recipe = await wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: zswapSecretKeys, dustSecretKey },
        { ttl: ttlOneHour() },
      );
      return wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx) => wallet.submitTransaction(tx),
  };

  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: "choreo-mint-server",
      privateStoragePasswordProvider: () => "Choreo-Kits-Local-2026!",
      accountId: coinPublicKey,
    }),
    publicDataProvider: indexerPublicDataProvider(INDEXER_URL, INDEXER_WS_URL),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(PROOF_SERVER_URL, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };

  const { Contract } = await import(
    "./contracts/managed/tokenized-choreo-kits/contract/index.js"
  );
  const { CompiledContract } = await import(
    "@midnight-ntwrk/midnight-js-protocol/compact-js"
  );

  const authorSecret = crypto.getRandomValues(new Uint8Array(32));
  const witnesses = {
    localSecretKey: (ctx) => {
      const sk = ctx?.privateState?.localSecretKey ?? authorSecret;
      return [{ ...(ctx?.privateState ?? {}), localSecretKey: sk }, sk];
    },
  };

  const compiledContract = CompiledContract.make(
    "TokenizedChoreoKitsContract",
    Contract,
  ).pipe(
    (self) => CompiledContract.withWitnesses(self, witnesses),
    CompiledContract.withCompiledFileAssets(ZK_CONFIG_PATH),
  );

  warmed = {
    providers,
    compiledContract,
    authorSecret,
    deployedCache: new Map(),
    teardown: async () => {
      try { stateSub.unsubscribe(); } catch {}
      try { await wallet.close?.(); } catch {}
    },
  };
  setStage("ready", "wallet warm, accepting mints");
}

function ensureWarming() {
  if (warmed) return Promise.resolve();
  if (!warming) {
    warming = warm().catch(async (err) => {
      warming = null;
      status.error = err?.message ?? String(err);
      console.error("warm failed:", err);
      if (isTransientWsError(err)) {
        // Auto-retry the whole warm cycle after a cooldown; this covers the
        // Fly Machines 1000-closure handshake bug end-to-end.
        const delay = Math.min(5_000 * (status.restarts + 1), 30_000);
        console.warn(`re-warming after transient failure in ${delay}ms`);
        status.restarts += 1;
        await sleep(delay);
        void ensureWarming();
      }
      throw err;
    });
  }
  return warming;
}
// Kick off wallet warm-up immediately so the first request is fast.
void ensureWarming();

async function mint({ contractAddress, title, steps, priceDust }) {
  await ensureWarming();
  if (!warmed) throw new Error("wallet not ready");

  setStage("mint-resolve", `looking up contract ${contractAddress.slice(0, 10)}…`);
  let deployed = warmed.deployedCache.get(contractAddress);
  if (!deployed) {
    const RESOLVE_TIMEOUT_MS = 60_000;
    deployed = await Promise.race([
      findDeployedContract(warmed.providers, {
        contractAddress,
        compiledContract: warmed.compiledContract,
        privateStateId: `choreo-mint-${contractAddress}`,
        initialPrivateState: { localSecretKey: warmed.authorSecret },
      }),
      sleep(RESOLVE_TIMEOUT_MS).then(() => {
        throw new Error(
          `findDeployedContract timed out after ${RESOLVE_TIMEOUT_MS}ms — is ${contractAddress.slice(0, 10)}… deployed on this node?`,
        );
      }),
    ]);
    warmed.deployedCache.set(contractAddress, deployed);
  }

  const payload = JSON.stringify({
    title: String(title).trim(),
    steps: String(steps).trim(),
    priceDust: Number(priceDust) || 0,
    publishedAt: new Date().toISOString(),
  });
  setStage("mint-prove", "building transaction and proving (cold: 60–120s, warm: ~30s)");
  const result = await deployed.callTx.publishKit(payload);
  setStage("mint-submit", "submitting proven transaction to node");
  const txId = result?.public?.txId ?? null;
  if (txId) {
    progress.lastMint = { txId, at: Date.now() };
    setStage("confirmed", `tx ${txId.slice(0, 16)}…`);
    // Return to ready shortly so subsequent mints show fresh progress.
    setTimeout(() => { if (warmed) setStage("ready", "wallet warm, accepting mints"); }, 4000);
  }
  return txId;
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ...status, progress }));
  }

  if (req.method !== "POST" || req.url !== "/mint") {
    res.writeHead(404).end("not found");
    return;
  }

  let body = "";
  for await (const c of req) body += c;
  let payload;
  try { payload = JSON.parse(body); } catch {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "invalid json" }));
  }

  const address = String(payload?.contractAddress ?? "").trim();
  const title = String(payload?.title ?? "").trim();
  const steps = String(payload?.steps ?? "").trim();
  const priceDust = Number(payload?.priceDust ?? 0);
  if (!/^(0x)?[0-9a-fA-F]{6,}$/.test(address) || !title || !steps) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "invalid input" }));
  }

  if (!status.ok) {
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "wallet warming up, retry in 30s", status }));
  }

  try {
    const txId = await mint({ contractAddress: address, title, steps, priceDust });
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ txId }));
  } catch (e) {
    console.error("mint failed:", e);
    if (isTransientWsError(e)) scheduleRewarm(`mint WS drop: ${e?.message ?? e}`);
    res.writeHead(500, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: e?.message ?? "mint failed" }));
  }
});

server.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`choreo-mint listening on :${PORT}`);
});

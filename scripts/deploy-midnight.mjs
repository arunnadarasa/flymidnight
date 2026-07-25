#!/usr/bin/env node
// Deploy TokenizedChoreoKits to the local Undeployed Midnight stack.
// This script is meant to be invoked by `bun run compile`, but you can run it
// standalone once the Docker stack is up:
//
//   VITE_NETWORK_ID=undeployed bun scripts/deploy-midnight.mjs
//
// It writes the deployed contract address to `.env` as VITE_DEFAULT_CONTRACT so
// the dev server picks it up automatically.

import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { WebSocket } from "ws";
import { firstValueFrom } from "rxjs";


const execFileP = promisify(execFile);

import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
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
import pino from "pino";

// GraphQL subscriptions need a WebSocket global in Node.
globalThis.WebSocket = WebSocket;

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: { target: "pino-pretty" },
});

// Local devnet genesis-mint wallet — pre-funded with tDUST on the standalone
// chain (see @midnight-ntwrk/testkit-js LocalTestEnvironment.genesisMintWalletSeed[0]).
const ALICE_LOCAL_SEED =
  "0000000000000000000000000000000000000000000000000000000000000002";


const NETWORK_ID = process.env.VITE_NETWORK_ID ?? "undeployed";
const NODE_WS = process.env.VITE_NODE_WS ?? "ws://localhost:9944";
const NODE_HTTP = NODE_WS.replace("ws://", "http://").replace("wss://", "https://");
const INDEXER_URL = process.env.VITE_INDEXER_URL ?? "http://localhost:8088/api/v4/graphql";
const INDEXER_WS_URL = process.env.VITE_INDEXER_WS_URL ?? "ws://localhost:8088/api/v4/graphql/ws";

const PROOF_SERVER_URL = process.env.VITE_PROOF_SERVER_URL ?? "http://localhost:6300";

const ZK_CONFIG_PATH = path.resolve(
  new URL(import.meta.url).pathname,
  "..",
  "..",
  "contracts",
  "managed",
  "tokenized-choreo-kits",
);


async function checkContainerHealthy(name) {
  try {
    const { stdout } = await execFileP("docker", [
      "inspect",
      name,
      "--format",
      "{{.State.Status}}",
    ]);
    const status = stdout.trim();
    if (status === "restarting" || status === "exited" || status === "dead") {
      throw new Error(
        `Container '${name}' is ${status}. Run:\n\n  docker compose logs --tail=80 ${name.replace(
          /^midnight-/,
          "",
        )}\n\nto see the crash reason.`,
      );
    }
  } catch (e) {
    if (e.message?.startsWith("Container ")) throw e;
    // docker not available or container missing — let waitForService handle it
  }
}

async function waitForService(url, name, timeoutMs = 120_000, containerName) {
  const start = Date.now();
  logger.info(`Waiting for ${name} at ${url}...`);
  while (Date.now() - start < timeoutMs) {
    if (containerName) await checkContainerHealthy(containerName);
    try {
      const resp = await fetch(url, { method: "POST", body: JSON.stringify({ query: "{ __typename }" }) });
      if (resp.status < 500) {
        logger.info(`${name} is ready.`);
        return;
      }
    } catch {
      // not ready yet
    }
    await setTimeout(1_000);
  }
  throw new Error(`${name} at ${url} did not become ready within ${timeoutMs}ms`);
}

async function waitForBlockHeight(indexerUrl, minHeight, timeoutMs = 60_000) {
  const start = Date.now();
  logger.info(`Waiting for node to produce block height >= ${minHeight}...`);
  let lastHeight = -1;
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(indexerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ block { height } }" }),
      });
      const json = await resp.json();
      const h = Number(json?.data?.block?.height ?? -1);
      if (h !== lastHeight) {
        logger.info(`  current tip height: ${h}`);
        lastHeight = h;
      }
      if (h >= minHeight) {
        logger.info(`Node is producing blocks (height ${h}).`);
        return;
      }
    } catch {
      // indexer not fully warm yet
    }
    await setTimeout(2_000);
  }
  throw new Error(`Node did not reach block height ${minHeight} within ${timeoutMs}ms`);
}

async function waitForWalletReady(wallet, timeoutMs = 90_000) {
  const start = Date.now();
  logger.info("Waiting for wallet to reach tip and see dust balance...");
  let lastLog = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const state = await firstValueFrom(wallet.state());
      // WalletFacade state shape (testkit-js 4.1.1): shielded/unshielded/dust
      // with progress.isStrictlyComplete() — not legacy syncProgress/balances.
      const synced =
        state?.shielded?.state?.progress?.isStrictlyComplete?.() === true &&
        state?.unshielded?.progress?.isStrictlyComplete?.() === true &&
        state?.dust?.state?.progress?.isStrictlyComplete?.() === true;
      let dust = 0n;
      try {
        const raw = state?.dust?.balance?.(new Date()) ?? 0n;
        dust = typeof raw === "bigint" ? raw : BigInt(raw);
      } catch {
        dust = 0n;
      }
      const line = `  synced=${synced} dust=${dust.toString()}`;
      if (line !== lastLog) {
        logger.info(line);
        lastLog = line;
      }
      if (synced && dust > 0n) {
        logger.info("Wallet is ready.");
        return;
      }
    } catch (e) {
      // state stream may not be primed yet
    }
    await setTimeout(2_000);
  }
  logger.warn(`Wallet did not fully sync within ${timeoutMs}ms; proceeding anyway (retry loop will catch TTL failures).`);
}



async function main() {
  if (NETWORK_ID !== "undeployed") {
    throw new Error(
      `This script only supports the Undeployed local stack. Set VITE_NETWORK_ID=undeployed (got: ${NETWORK_ID}).`,
    );
  }

  setNetworkId(NETWORK_ID);

  // Make sure the compiled contract artifacts exist.
  try {
    await import("../contracts/managed/tokenized-choreo-kits/contract/index.js");
  } catch (e) {
    throw new Error(
      `Compiled contract not found at contracts/managed/tokenized-choreo-kits. Run 'bun run midnight:compile' first.\n${e}`,
    );
  }

  // Wait for the stack to be ready. Pass container names so we fail fast if
  // the node is crash-looping instead of waiting the full timeout.
  await waitForService(INDEXER_URL, "indexer", 120_000, "midnight-node");
  await waitForService(PROOF_SERVER_URL, "proof-server", 180_000, "midnight-proof-server");

  // Wait until the node is actually producing blocks. Without this the wallet
  // stamps ttlOneHour() against a stale tip and the tx is rejected with
  // "1010: Invalid Transaction: Custom error: 171".
  await waitForBlockHeight(INDEXER_URL, 2, 60_000);

  const envConfig = {
    walletNetworkId: NETWORK_ID,
    networkId: NETWORK_ID,
    indexer: INDEXER_URL,
    indexerWS: INDEXER_WS_URL,
    node: NODE_HTTP,
    nodeWS: NODE_WS,
    proofServer: PROOF_SERVER_URL,
  };

  // Build the local devnet wallet from the pre-funded genesis seed.
  logger.info("Building local devnet wallet from genesis seed...");
  const buildResult = await FluentWalletBuilder.forEnvironment(envConfig)
    .withSeed(ALICE_LOCAL_SEED)
    .withDustOptions({
      ledgerParams: LedgerParameters.initialParameters(),
      additionalFeeOverhead: 1_000n,
      feeBlocksMargin: 15,
    })
    .buildWithoutStarting();

  const { wallet, seeds, keystore } = buildResult;
  const zswapSecretKeys = ZswapSecretKeys.fromSeed(seeds.shielded);
  const dustSecretKey = DustSecretKey.fromSeed(seeds.dust);

  logger.info("Starting wallet sync...");
  await wallet.start(zswapSecretKeys, dustSecretKey);

  // Wait until the wallet reports it has synced to the tip AND sees a non-zero
  // dust balance. Fixed 15s sleeps race with WS reconnects on a cold chain.
  await waitForWalletReady(wallet, 90_000);



  const coinPublicKey = zswapSecretKeys.coinPublicKey;
  const accountId = coinPublicKey;

  const zkConfigProvider = new NodeZkConfigProvider(ZK_CONFIG_PATH);
  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: `choreo-kits-deploy-${Date.now()}`,
      privateStoragePasswordProvider: () => "Choreo-Kits-Local-2026!",
      accountId,
    }),
    publicDataProvider: indexerPublicDataProvider(INDEXER_URL, INDEXER_WS_URL),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(PROOF_SERVER_URL, zkConfigProvider),
    walletProvider: {
      getCoinPublicKey: () => coinPublicKey,
      getEncryptionPublicKey: () => zswapSecretKeys.encryptionPublicKey,
      balanceTx: async (tx) => {
        const ttl = ttlOneHour();
        const recipe = await wallet.balanceUnboundTransaction(
          tx,
          { shieldedSecretKeys: zswapSecretKeys, dustSecretKey },
          { ttl },
        );
        return wallet.finalizeRecipe(recipe);
      },
      submitTx: (tx) => wallet.submitTransaction(tx),
    },
    midnightProvider: {
      getCoinPublicKey: () => coinPublicKey,
      getEncryptionPublicKey: () => zswapSecretKeys.encryptionPublicKey,
      balanceTx: async (tx) => {
        const ttl = ttlOneHour();
        const recipe = await wallet.balanceUnboundTransaction(
          tx,
          { shieldedSecretKeys: zswapSecretKeys, dustSecretKey },
          { ttl },
        );
        return wallet.finalizeRecipe(recipe);
      },
      submitTx: (tx) => wallet.submitTransaction(tx),
    },
  };

  const { Contract, ledger, pureCircuits } = await import(
    "../contracts/managed/tokenized-choreo-kits/contract/index.js"
  );
  const { CompiledContract } = await import(
    "@midnight-ntwrk/midnight-js-protocol/compact-js"
  );

  const deployerSecret = crypto.getRandomValues(new Uint8Array(32));
  const witnesses = {
    localSecretKey: (ctx) => {
      const sk = ctx?.privateState?.localSecretKey ?? deployerSecret;
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

  logger.info("Deploying TokenizedChoreoKits contract...");
  let deployed;
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      deployed = await deployContract(providers, {
        compiledContract,
        privateStateId: `choreo-kits-deployer-${Date.now()}-${attempt}`,
        initialPrivateState: { localSecretKey: deployerSecret },
      });
      break;
    } catch (e) {
      const msg = String(e?.message ?? e);
      const retryable = /Insufficient Funds|Custom error: 171|Invalid Transaction|Transaction submission error/i.test(msg);
      if (retryable && attempt < maxAttempts) {
        logger.warn(`Deploy attempt ${attempt}/${maxAttempts} failed (${msg.split("\n")[0]}); retrying in 10s...`);
        await setTimeout(10_000);
        continue;
      }
      throw e;
    }
  }




  const contractAddress = deployed.deployTxData.public.contractAddress;
  logger.info(`Contract deployed at: ${contractAddress}`);

  // Sanity-check the ledger state.
  const state = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!state) {
    throw new Error("Contract state not found on indexer after deployment.");
  }
  const parsed = ledger(state.data);
  logger.info({ kitCount: Number(parsed.kit_count) }, "Initial contract state");

  // Persist the address so `bun run dev` can pick it up.
  const envPath = path.resolve(new URL(import.meta.url).pathname, "..", "..", ".env");
  let env = "";
  try {
    env = await readFile(envPath, "utf8");
  } catch {
    // .env does not exist yet; we'll create it from the example.
    try {
      env = await readFile(envPath + ".example", "utf8");
    } catch {
      // no example either
    }
  }

  const updated = env.includes("VITE_DEFAULT_CONTRACT=")
    ? env.replace(
        /^VITE_DEFAULT_CONTRACT=.*$/m,
        `VITE_DEFAULT_CONTRACT=${contractAddress}`,
      )
    : env.trimEnd() + `\nVITE_DEFAULT_CONTRACT=${contractAddress}\n`;

  await writeFile(envPath, updated);
  logger.info(`Wrote VITE_DEFAULT_CONTRACT to ${envPath}`);

  console.log("\n=== DEPLOYMENT SUCCESS ===");
  console.log(`Contract address: ${contractAddress}`);
  console.log(`It has also been saved to .env as VITE_DEFAULT_CONTRACT.`);
  console.log("You can now open the app and connect Lace to ws://localhost:9944.");

  await wallet.stop();
  process.exit(0);
}

main().catch((err) => {
  logger.error(err);
  console.error("\nDeployment failed:", err.message);
  process.exit(1);
});

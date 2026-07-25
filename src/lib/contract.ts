import { Buffer } from "buffer";
import type { ConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";
import { createCircuitCallTxInterface } from "@midnight-ntwrk/midnight-js-contracts";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import type {
  CoinPublicKey,
  EncPublicKey,
  FinalizedTransaction,
  TransactionId,
} from "@midnight-ntwrk/midnight-js-protocol/ledger";
import type {
  MidnightProvider,
  PrivateStateProvider,
  ProofProvider,
  PublicDataProvider,
  WalletProvider,
  ZKConfigProvider,
} from "@midnight-ntwrk/midnight-js-types";
import { createProofProvider } from "@midnight-ntwrk/midnight-js-types";
import { parseCoinPublicKeyToHex, parseEncPublicKeyToHex } from "@midnight-ntwrk/midnight-js-utils";

const PRIVATE_STATE_ID = "choreo-kits-author";
const PRIVATE_STATE_PREFIX = "choreo-kits:private-state:v1";

export type KitPayload = {
  title: string;
  steps: string;
  priceDust: number;
  publishedAt: string;
};

type ContractModule = {
  Contract: unknown;
  ledger: (state: string) => {
    kit_count: bigint;
    last_kit: string;
    last_author_commitment: string;
  };
};

let contractModuleCache: ContractModule | null = null;

export async function loadContractModule(): Promise<ContractModule | null> {
  if (contractModuleCache) return contractModuleCache;
  if (typeof window === "undefined") return null;
  try {
    // Path is loaded directly by the browser in Vite dev. It is produced by
    // `compact compile` under contracts/managed, not copied to public/contract.
    // Keep it hidden from Vite's static resolver so fresh clones still start
    // before the user runs `bun run compile`.
    const p = "../../contracts/managed/tokenized-choreo-kits/contract/index.js";
    const mod: any = await import(/* @vite-ignore */ p);
    contractModuleCache = (mod.default ?? mod) as ContractModule;
    return contractModuleCache;
  } catch (err) {
    console.error("Failed to load compiled contract module:", err);
    return null;
  }
}

class FetchZKConfigProvider implements ZKConfigProvider<string> {
  constructor(private base: string) {}

  private async fetchBytes(path: string): Promise<Uint8Array> {
    const r = await fetch(`${this.base}${path}`);
    if (!r.ok) throw new Error(`Failed to fetch ${path}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  async getZKIR(circuitId: string): Promise<any> {
    return this.fetchBytes(`/zkir/${circuitId}.bzkir`);
  }

  async getProverKey(circuitId: string): Promise<any> {
    return this.fetchBytes(`/keys/${circuitId}.prover`);
  }

  async getVerifierKey(circuitId: string): Promise<any> {
    return this.fetchBytes(`/keys/${circuitId}.verifier`);
  }

  async getVerifierKeys(circuitIds: string[]): Promise<any> {
    return Promise.all(
      circuitIds.map(async (id) => [id, await this.getVerifierKey(id)] as [string, any]),
    );
  }

  async get(circuitId: string): Promise<any> {
    return {
      circuitId,
      zkir: await this.getZKIR(circuitId),
      proverKey: await this.getProverKey(circuitId),
      verifierKey: await this.getVerifierKey(circuitId),
    };
  }

  asKeyMaterialProvider(): any {
    return this;
  }
}

async function getWalletKeys(api: ConnectedAPI, networkId: string) {
  const addrs = await api.getShieldedAddresses();
  return {
    coinPublicKey: parseCoinPublicKeyToHex(addrs.shieldedCoinPublicKey, networkId),
    encryptionPublicKey: parseEncPublicKeyToHex(addrs.shieldedEncryptionPublicKey, networkId),
  };
}

function describeLaceError(error: unknown): string {
  if (error instanceof Error) {
    const pieces = [error.name, error.message].filter(Boolean);
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause) pieces.push(`cause=${describeLaceError(cause)}`);
    return pieces.join(": ");
  }

  if (typeof error === "string") return error;

  try {
    const json = JSON.stringify(error);
    if (json && json !== "{}") return json;
  } catch {
    // fall through to String()
  }

  return String(error);
}

class LaceWalletProvider implements WalletProvider {
  constructor(
    private api: ConnectedAPI,
    private coinPublicKey: CoinPublicKey,
    private encryptionPublicKey: EncPublicKey,
  ) {}

  getCoinPublicKey(): CoinPublicKey {
    return this.coinPublicKey;
  }

  getEncryptionPublicKey(): EncPublicKey {
    return this.encryptionPublicKey;
  }

  async balanceTx(tx: any, _ttl?: Date): Promise<FinalizedTransaction> {
    const hex = Buffer.from(tx.serialize()).toString("hex");
    const { tx: balancedHex } = await this.api.balanceUnsealedTransaction(hex, { payFees: true });
    const bytes = Buffer.from(balancedHex, "hex");
    const mod: any = await import("@midnight-ntwrk/midnight-js-protocol/ledger");
    const Transaction = mod.Transaction ?? mod.default?.Transaction;
    return Transaction.deserialize("signature", "proof", "binding", bytes) as FinalizedTransaction;
  }
}

class LaceMidnightProvider implements MidnightProvider {
  constructor(private api: ConnectedAPI) {}

  async submitTx(tx: FinalizedTransaction): Promise<TransactionId> {
    const hex = Buffer.from(tx.serialize()).toString("hex");
    try {
      await this.api.submitTransaction(hex);
    } catch (e) {
      const msg = describeLaceError(e);
      console.error("Lace submitTransaction failed:", e);
      if (/already|duplicate|known/i.test(msg)) {
        return tx.transactionHash();
      }
      // Detect the empty-dust case and surface a clear next step. Lace usually
      // throws a generic "Unexpected error submitting scoped transaction …"
      // when the wallet has zero tDUST to pay fees.
      try {
        const dustApi = this.api as unknown as { getDustBalance?: () => Promise<{ balance: bigint }> };
        if (typeof dustApi.getDustBalance === "function") {
          const d = await dustApi.getDustBalance();
          const bal = typeof d?.balance === "bigint" ? d.balance : BigInt(d?.balance ?? 0);
          if (bal <= 0n) {
            throw new Error(
              "Lace has 0 tDUST — cannot pay transaction fees. Fund your unshielded address via scripts/fund-lace.sh (midnight-local-dev menu → option 2), then click 'Generate tDUST' in Lace and retry.",
            );
          }
        }
      } catch (probe) {
        if (probe instanceof Error && /0 tDUST/.test(probe.message)) throw probe;
        // ignore probe failure — fall through to generic error
      }
      throw new Error(`Lace rejected submission: ${msg || "unknown error"}`);
    }
    return tx.transactionHash();
  }
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function encodeForStorage(value: unknown): JsonValue {
  if (value instanceof Uint8Array) {
    return { __type: "Uint8Array", data: Array.from(value) };
  }
  if (Array.isArray(value)) {
    return value.map(encodeForStorage);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        encodeForStorage(nested),
      ]),
    );
  }
  return value as JsonValue;
}

function decodeFromStorage(value: JsonValue): unknown {
  if (Array.isArray(value)) {
    return value.map(decodeFromStorage);
  }
  if (value && typeof value === "object") {
    const record = value as { [key: string]: JsonValue };
    if (record.__type === "Uint8Array" && Array.isArray(record.data)) {
      return new Uint8Array(record.data.map((n) => Number(n)));
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, nested]) => [key, decodeFromStorage(nested)]),
    );
  }
  return value;
}

function safeGetLocalStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function createPrivateStateProvider(accountId: string): PrivateStateProvider<string, unknown> {
  let contractAddress: string | null = null;
  const root = `${PRIVATE_STATE_PREFIX}:${accountId}`;

  const makePrivateKey = (privateStateId: string) => {
    if (!contractAddress) {
      throw new Error("Contract address not set. Call setContractAddress() first.");
    }
    return `${root}:contracts:${contractAddress}:states:${privateStateId}`;
  };
  const makeSigningKey = (address: string) => `${root}:signing:${address}`;

  const read = <T,>(key: string): T | null => {
    const storage = safeGetLocalStorage();
    if (!storage) return null;
    const raw = storage.getItem(key);
    if (!raw) return null;
    return decodeFromStorage(JSON.parse(raw) as JsonValue) as T;
  };

  const write = (key: string, value: unknown) => {
    const storage = safeGetLocalStorage();
    if (!storage) return;
    storage.setItem(key, JSON.stringify(encodeForStorage(value)));
  };

  const removeWhere = (predicate: (key: string) => boolean) => {
    const storage = safeGetLocalStorage();
    if (!storage) return;
    const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(
      (key): key is string => typeof key === "string" && predicate(key),
    );
    keys.forEach((key) => storage.removeItem(key));
  };

  return {
    setContractAddress(address) {
      contractAddress = address;
    },
    async get(privateStateId) {
      return read(makePrivateKey(privateStateId));
    },
    async set(privateStateId, state) {
      write(makePrivateKey(privateStateId), state);
    },
    async remove(privateStateId) {
      safeGetLocalStorage()?.removeItem(makePrivateKey(privateStateId));
    },
    async clear() {
      if (!contractAddress) {
        throw new Error("Contract address not set. Call setContractAddress() first.");
      }
      removeWhere((key) => key.startsWith(`${root}:contracts:${contractAddress}:states:`));
    },
    async getSigningKey(address) {
      return read(makeSigningKey(address as string));
    },
    async setSigningKey(address, signingKey) {
      write(makeSigningKey(address as string), signingKey);
    },
    async removeSigningKey(address) {
      safeGetLocalStorage()?.removeItem(makeSigningKey(address as string));
    },
    async clearSigningKeys() {
      removeWhere((key) => key.startsWith(`${root}:signing:`));
    },
    async exportPrivateStates() {
      throw new Error("Private-state export is not available in this demo build.");
    },
    async importPrivateStates() {
      return { imported: 0, skipped: 0, overwritten: 0 } as any;
    },
    async exportSigningKeys() {
      throw new Error("Signing-key export is not available in this demo build.");
    },
    async importSigningKeys() {
      return { imported: 0, skipped: 0, overwritten: 0 } as any;
    },
  };
}

async function ensurePrivateState(
  provider: PrivateStateProvider,
  contractAddress: string,
  privateStateId: string,
) {
  provider.setContractAddress(contractAddress);
  const existing = await provider.get(privateStateId);
  if (!existing) {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    await provider.set(privateStateId, { localSecretKey: secret });
  }
}

export async function publishKit(
  api: ConnectedAPI,
  networkId: string,
  contractAddress: string,
  title: string,
  steps: string,
  priceDust: number,
): Promise<string> {
  setNetworkId(networkId);

  const cfg = await api.getConfiguration();
  const zkConfigProvider: ZKConfigProvider<string> = new FetchZKConfigProvider(window.location.origin);
  const provingProvider = await api.getProvingProvider(zkConfigProvider);
  const proofProvider: ProofProvider = createProofProvider(provingProvider);
  const publicDataProvider: PublicDataProvider = indexerPublicDataProvider(cfg.indexerUri, cfg.indexerWsUri);

  const { coinPublicKey, encryptionPublicKey } = await getWalletKeys(api, networkId);
  const privateStateProvider = createPrivateStateProvider(coinPublicKey);
  const walletProvider: WalletProvider = new LaceWalletProvider(api, coinPublicKey, encryptionPublicKey);
  const midnightProvider: MidnightProvider = new LaceMidnightProvider(api);

  await ensurePrivateState(privateStateProvider, contractAddress, PRIVATE_STATE_ID);

  const contractMod = await loadContractModule();
  if (!contractMod) {
    throw new Error(
      'Compiled contract not found at contracts/managed/tokenized-choreo-kits. Run "bun run midnight:compile" first.',
    );
  }

  const { Contract } = contractMod;
  const { CompiledContract } = await import("@midnight-ntwrk/midnight-js-protocol/compact-js");

  const witnesses = {
    localSecretKey: (ctx: { privateState?: { localSecretKey?: Uint8Array } }) => {
      const sk = ctx?.privateState?.localSecretKey;
      if (!sk) throw new Error("Missing localSecretKey in private state");
      return [ctx.privateState, sk];
    },
  };

  const compiledContract = (CompiledContract.withWitnesses as any)(
    (CompiledContract.make as any)("TokenizedChoreoKitsContract", Contract),
    witnesses,
  );

  const providers = {
    privateStateProvider,
    publicDataProvider,
    zkConfigProvider,
    proofProvider,
    walletProvider,
    midnightProvider,
  };

  const circuitCall = createCircuitCallTxInterface(
    providers,
    compiledContract as any,
    contractAddress,
    PRIVATE_STATE_ID,
  );

  const payload = JSON.stringify({
    title: title.trim(),
    steps: steps.trim(),
    priceDust,
    publishedAt: new Date().toISOString(),
  });

  const result = await circuitCall.publishKit(payload);
  return result.public.txId;
}

export async function decodeChainState(hexState: string): Promise<{
  kitCount: number;
  lastKit: KitPayload | null;
  lastAuthorCommitment: string;
}> {
  const mod = await loadContractModule();
  if (!mod) {
    return { kitCount: 0, lastKit: null, lastAuthorCommitment: "" };
  }
  try {
    const state = mod.ledger(hexState);
    let lastKit: KitPayload | null = null;
    if (state.last_kit) {
      try {
        lastKit = JSON.parse(state.last_kit) as KitPayload;
      } catch {
        // ignore parse errors
      }
    }
    return {
      kitCount: Number(state.kit_count ?? 0),
      lastKit,
      lastAuthorCommitment: state.last_author_commitment ?? "",
    };
  } catch {
    return { kitCount: 0, lastKit: null, lastAuthorCommitment: "" };
  }
}

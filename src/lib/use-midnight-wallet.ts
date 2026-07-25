import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectedAPI, InitialAPI } from "@midnight-ntwrk/dapp-connector-api";

export type WalletStatus =
  | "idle"
  | "detecting"
  | "ready"
  | "connecting"
  | "connected"
  | "error";

export type DustInfo = { balance: bigint; cap: bigint } | null;

type Connector = Omit<InitialAPI, "connect"> & {
  connect: (networkId: string) => Promise<ConnectedAPI>;
};

function pickConnector(): Connector | null {
  if (typeof window === "undefined") return null;
  const m = (window as unknown as { midnight?: Record<string, Connector> }).midnight;
  if (!m) return null;
  for (const v of Object.values(m)) {
    if (v && typeof v === "object" && "apiVersion" in v && /^4\./.test(String(v.apiVersion))) {
      return v as Connector;
    }
  }
  const first = Object.values(m)[0];
  return first && "apiVersion" in first ? (first as Connector) : null;
}

function inferNetwork(addr: string): string {
  const m = addr.match(/^mn_(?:shield-)?addr_([a-z0-9]+?)1/i);
  if (!m) return "unknown";
  const s = m[1].toLowerCase();
  if (s === "test") return "preprod";
  if (s === "undeployed") return "undeployed";
  return s;
}

async function readUnshieldedAddress(api: ConnectedAPI): Promise<string | null> {
  if (typeof api.getUnshieldedAddress !== "function") return null;
  try {
    const u = await api.getUnshieldedAddress();
    return typeof u === "string" ? u : (u as { unshieldedAddress?: string })?.unshieldedAddress ?? null;
  } catch {
    return null;
  }
}

async function readDust(api: ConnectedAPI): Promise<DustInfo> {
  if (typeof (api as { getDustBalance?: unknown }).getDustBalance !== "function") return null;
  try {
    const d = await (api as unknown as { getDustBalance: () => Promise<{ balance: bigint; cap: bigint }> }).getDustBalance();
    // Normalise — some builds return numbers or strings.
    const toBig = (v: unknown): bigint => {
      if (typeof v === "bigint") return v;
      if (typeof v === "number") return BigInt(Math.trunc(v));
      if (typeof v === "string") return BigInt(v);
      return 0n;
    };
    return { balance: toBig(d?.balance), cap: toBig(d?.cap) };
  } catch {
    return null;
  }
}

export function useMidnightWallet() {
  const [status, setStatus] = useState<WalletStatus>("idle");
  const [address, setAddress] = useState<string | null>(null);
  const [unshieldedAddress, setUnshieldedAddress] = useState<string | null>(null);
  const [api, setApi] = useState<ConnectedAPI | null>(null);
  const [apiVersion, setApiVersion] = useState<string | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dust, setDust] = useState<DustInfo>(null);
  const [tick, setTick] = useState(0);
  const apiRef = useRef<ConnectedAPI | null>(null);
  apiRef.current = api;

  useEffect(() => {
    if (typeof window === "undefined") return;
    setStatus((p) => (p === "connected" ? p : "detecting"));
    setError(null);
    const t0 = Date.now();
    const iv = window.setInterval(() => {
      const c = pickConnector();
      if (c) {
        window.clearInterval(iv);
        setApiVersion(c.apiVersion);
        setStatus((p) => (p === "connected" ? p : "ready"));
        if (!/^4\./.test(c.apiVersion)) {
          setStatus("error");
          setError(`Lace connector ${c.apiVersion} is not compatible. Update Lace.`);
        }
      } else if (Date.now() - t0 > 5000) {
        window.clearInterval(iv);
        setStatus("error");
        setError("No Midnight wallet detected. Install Lace from lace.io.");
      }
    }, 100);
    return () => window.clearInterval(iv);
  }, [tick]);

  const refreshDust = useCallback(async () => {
    const current = apiRef.current;
    if (!current) return;
    const d = await readDust(current);
    setDust(d);
  }, []);

  const connect = useCallback(async () => {
    try {
      setError(null);
      setStatus("connecting");
      const c = pickConnector();
      if (!c) throw new Error("No Midnight wallet detected.");
      const preferred = (import.meta.env.VITE_NETWORK_ID as string) || "undeployed";
      const candidates = Array.from(new Set([preferred, "undeployed", "preview", "preprod"]));
      let connectedApi: ConnectedAPI | null = null;
      let used: string | null = null;
      let mismatch: unknown = null;
      for (const n of candidates) {
        try {
          connectedApi = await c.connect(n);
          used = n;
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/network|mismatch/i.test(msg)) {
            mismatch = e;
            continue;
          }
          throw e;
        }
      }
      if (!connectedApi || !used) {
        throw new Error(
          mismatch
            ? "Lace is on a different network. Switch Lace to your local Undeployed node and retry."
            : "Failed to connect to Lace.",
        );
      }
      let addr: string | null = null;
      if (typeof connectedApi.getShieldedAddresses === "function") {
        try {
          const s = await connectedApi.getShieldedAddresses();
          if (Array.isArray(s)) addr = s[0] ?? null;
          else if (s && typeof s === "object") {
            const rec = s as Record<string, string>;
            addr = rec.shieldedAddress ?? Object.values(rec)[0] ?? null;
          }
        } catch {
          // ignore
        }
      }
      const unshielded = await readUnshieldedAddress(connectedApi);
      if (!addr) addr = unshielded;
      if (!addr) throw new Error("Connected but couldn't read an address. Update Lace.");
      setAddress(addr);
      setUnshieldedAddress(unshielded);
      setApi(connectedApi);
      apiRef.current = connectedApi;
      setNetwork(used ?? inferNetwork(addr));
      setApiVersion(c.apiVersion);
      setStatus("connected");
      const d = await readDust(connectedApi);
      setDust(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

  // Poll dust while connected so the UI reflects a running "Generate tDUST".
  // Skip on Undeployed — writes go through the server /api/mint (genesis wallet)
  // so the user's Lace balance is irrelevant.
  useEffect(() => {
    if (status !== "connected" || !api) return;
    const networkId = (import.meta.env.VITE_NETWORK_ID as string) || "undeployed";
    if (networkId === "undeployed") return;
    const iv = window.setInterval(() => {
      void refreshDust();
    }, 6000);
    return () => window.clearInterval(iv);
  }, [status, api, refreshDust]);

  return {
    status,
    address,
    unshieldedAddress,
    api,
    apiVersion,
    network,
    error,
    dust,
    refreshDust,
    connect,
    disconnect: () => {
      setAddress(null);
      setUnshieldedAddress(null);
      setApi(null);
      apiRef.current = null;
      setNetwork(null);
      setStatus("ready");
      setError(null);
      setDust(null);
    },
    redetect: () => setTick((n) => n + 1),
  };
}

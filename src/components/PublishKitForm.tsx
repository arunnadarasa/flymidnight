import type { ConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";
import { useCallback, useEffect, useState } from "react";
import { publishKit } from "@/lib/contract";
import type { DustInfo } from "@/lib/use-midnight-wallet";
import { MintServerStatus } from "@/components/MintServerStatus";

const NETWORK_ID = (import.meta.env.VITE_NETWORK_ID as string) || "undeployed";
const IS_UNDEPLOYED = NETWORK_ID === "undeployed";

export function PublishKitForm({
  walletConnected,
  walletApi,
  contractAddress,
  dust,
  onPublished,
}: {
  walletConnected: boolean;
  walletApi: ConnectedAPI | null;
  contractAddress: string | null;
  dust?: DustInfo;
  onPublished: (payload: KitPayload) => void;
}) {
  // On Undeployed the server /api/mint pays fees with the genesis wallet, so
  // Lace tDUST is irrelevant. On preview/preprod Lace signs and must be funded.
  const dustEmpty = !IS_UNDEPLOYED && (!dust || dust.balance <= 0n);
  const [title, setTitle] = useState("");
  const [steps, setSteps] = useState("");
  const [priceDust, setPriceDust] = useState("10");
  const [proving, setProving] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    if (!proving) return;
    const t0 = Date.now();
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 250);
    return () => clearInterval(iv);
  }, [proving]);

  const submit = useCallback(async () => {
    setError(null);
    setOk(null);
    // Lace is optional on Undeployed (server-side wallet signs).
    if (!IS_UNDEPLOYED && !walletConnected) {
      setError("Connect Lace first.");
      return;
    }
    if (!contractAddress) {
      setError("Set the deployed contract address in step 2 first.");
      return;
    }
    if (dustEmpty && walletApi) {
      setError("Lace has 0 tDUST — fees can't be paid. Fund via scripts/fund-lace.sh, then Generate tDUST in Lace.");
      return;
    }
    if (!title.trim() || !steps.trim()) {
      setError("Title and steps are required.");
      return;
    }
    const payload: KitPayload = {
      title: title.trim(),
      steps: steps.trim(),
      priceDust: Number(priceDust) || 0,
      publishedAt: new Date().toISOString(),
    };
    setProving(true);
    try {
      // Persist locally so the feed reflects it even before indexer sync.
      const local = JSON.parse(localStorage.getItem("choreo:local-kits") ?? "[]") as KitPayload[];
      local.unshift(payload);
      localStorage.setItem("choreo:local-kits", JSON.stringify(local.slice(0, 20)));

      let txId: string;
      if (IS_UNDEPLOYED) {
        // Server-append: /api/mint uses the genesis-funded seed …0002.
        const r = await fetch("/api/mint", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contractAddress,
            title: payload.title,
            steps: payload.steps,
            priceDust: payload.priceDust,
          }),
        });
        const j = (await r.json().catch(() => ({}))) as { txId?: string; error?: string };
        if (!r.ok || !j.txId) throw new Error(j.error ?? `mint failed (HTTP ${r.status})`);
        txId = j.txId;
      } else {
        if (!walletApi) throw new Error("Connect Lace to mint on this network.");
        txId = await publishKit(
          walletApi,
          NETWORK_ID,
          contractAddress,
          payload.title,
          payload.steps,
          payload.priceDust,
        );
      }
      setOk(`Submitted on-chain. Tx: ${txId.slice(0, 24)}…`);
      onPublished(payload);
      setTitle("");
      setSteps("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProving(false);
      setElapsed(0);
    }
  }, [walletConnected, walletApi, contractAddress, dustEmpty, title, steps, priceDust, onPublished]);

  const disabled =
    proving ||
    !contractAddress ||
    (!IS_UNDEPLOYED && !walletConnected) ||
    (dustEmpty && !!walletApi);

  return (
    <div className="p-5 border border-border rounded-md space-y-3 bg-card">
      <div className="text-xs uppercase tracking-widest text-muted-foreground">
        03 · publish choreo kit
      </div>

      {IS_UNDEPLOYED && <MintServerStatus />}


      <div className="grid gap-2">
        <label className="text-[10px] uppercase tracking-widest text-muted-foreground">Title</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Krump Foundations Vol. 1"
          className="px-3 py-2 bg-background border border-border rounded text-sm"
        />

        <label className="text-[10px] uppercase tracking-widest text-muted-foreground">
          Steps summary
        </label>
        <textarea
          value={steps}
          onChange={(e) => setSteps(e.target.value)}
          rows={4}
          placeholder="8-count breakdown, chest pops, arm swings, jab sequence…"
          className="px-3 py-2 bg-background border border-border rounded text-sm font-mono"
        />

        <label className="text-[10px] uppercase tracking-widest text-muted-foreground">
          License price (tDUST)
        </label>
        <input
          type="number"
          min={0}
          value={priceDust}
          onChange={(e) => setPriceDust(e.target.value)}
          className="w-32 px-3 py-2 bg-background border border-border rounded text-sm font-mono"
        />
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => void submit()}
          disabled={disabled}
          className="px-4 py-2 bg-primary text-primary-foreground text-xs font-semibold uppercase tracking-wider rounded disabled:opacity-40"
        >
          {proving ? `Proving… ${elapsed}s` : "Mint kit (ZK)"}
        </button>
        {proving && (
          <span className="text-[11px] text-muted-foreground">
            Fees paid by the demo server on Fly. First mint after a cold start takes 60–120s.
          </span>
        )}
      </div>

      {error && <p className="text-[12px] text-destructive">{error}</p>}
      {ok && <p className="text-[12px] text-primary">{ok}</p>}
    </div>
  );
}

export type KitPayload = {
  title: string;
  steps: string;
  priceDust: number;
  publishedAt: string;
};

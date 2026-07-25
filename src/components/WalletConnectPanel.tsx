import { useEffect, useState } from "react";
import type { ConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";
import { useMidnightWallet, type DustInfo } from "@/lib/use-midnight-wallet";

const FAUCET_URL = (import.meta.env.VITE_FAUCET_URL as string | undefined) ?? "";


function truncate(a: string, h = 14, t = 10) {
  return a.length <= h + t + 1 ? a : `${a.slice(0, h)}…${a.slice(-t)}`;
}

function fmtDust(n: bigint): string {
  // dust is a very large integer; render as decimal with up to 4 significant digits.
  if (n === 0n) return "0";
  const s = n.toString();
  if (s.length <= 6) return s;
  return `${s.slice(0, s.length - 6)}.${s.slice(s.length - 6, s.length - 4)}M`;
}

function FaucetPanel({ address, onFunded }: { address: string | null; onFunded: () => void }) {
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "err">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  async function request() {
    if (!address) return;
    setStatus("loading");
    setMsg(null);
    try {
      const r = await fetch(`${FAUCET_URL.replace(/\/$/, "")}/grant`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
      setStatus("ok");
      setMsg(`Sent — tx ${String(j.txId).slice(0, 14)}… Wait ~1 block, then refresh.`);
      setTimeout(onFunded, 8000);
    } catch (e) {
      setStatus("err");
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <div className="text-[11px] leading-relaxed p-3 border border-dashed border-destructive/60 rounded bg-destructive/5 space-y-2">
      <div className="font-semibold uppercase tracking-widest text-destructive">
        Fund this wallet before minting
      </div>
      {FAUCET_URL ? (
        <>
          <p className="text-muted-foreground">
            The hosted faucet will send you tDUST on the shared Undeployed chain. Rate-limited.
          </p>
          <button
            onClick={() => void request()}
            disabled={status === "loading" || !address}
            className="px-3 py-2 bg-primary text-primary-foreground text-[10px] font-semibold uppercase tracking-widest rounded disabled:opacity-50"
          >
            {status === "loading" ? "requesting…" : "request tDUST"}
          </button>
          {msg && (
            <p className={status === "err" ? "text-destructive" : "text-primary"}>{msg}</p>
          )}
        </>
      ) : (
        <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
          <li>
            In a second terminal, run <code className="font-mono">scripts/fund-lace.sh</code>.
          </li>
          <li>Choose <strong>option 2</strong> and paste the unshielded address above.</li>
          <li>In Lace, tap <strong>Generate tDUST</strong> on the tNIGHT balance.</li>
        </ol>
      )}
    </div>
  );
}

export function WalletConnectPanel({
  expectedNetwork = "undeployed",
  onConnected,
  onApiReady,
  onDustChange,
}: {
  expectedNetwork?: string;
  onConnected?: (addr: string) => void;
  onApiReady?: (api: ConnectedAPI) => void;
  onDustChange?: (dust: DustInfo) => void;
}) {
  const w = useMidnightWallet();
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (w.status === "connected" && w.address) onConnected?.(w.address);
    if (w.status === "connected" && w.api) onApiReady?.(w.api);
  }, [w.status, w.address, w.api, onConnected, onApiReady]);

  useEffect(() => {
    onDustChange?.(w.dust);
  }, [w.dust, onDustChange]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  const wrong =
    w.status === "connected" &&
    w.network &&
    w.network !== "unknown" &&
    w.network !== expectedNetwork;

  // On Undeployed we don't need tDUST in Lace — the server /api/mint signs
  // with the genesis wallet. Suppress the "fund me" affordances entirely.
  const isUndeployed = expectedNetwork === "undeployed";
  const dustEmpty = !isUndeployed && w.status === "connected" && (!w.dust || w.dust.balance <= 0n);

  const [skipped, setSkipped] = useState(false);

  return (
    <div className="p-5 border border-border rounded-md space-y-3 bg-card">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs uppercase tracking-widest text-muted-foreground">
          01 · connect lace{isUndeployed ? " (optional)" : ""}
        </span>
        {w.apiVersion && (
          <span className="text-[10px] font-mono opacity-60">connector v{w.apiVersion}</span>
        )}
      </div>

      {isUndeployed && (w.status === "ready" || w.status === "detecting" || w.status === "error") && !skipped && (
        <p className="text-[11px] text-muted-foreground">
          Optional on Undeployed. Mint fees are paid server-side by the genesis wallet.
          Connect only if you want an on-chain identity commitment tied to your Lace address.
        </p>
      )}

      {isUndeployed && skipped && (
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="font-mono">lace skipped — using server signer</span>
          <button
            onClick={() => setSkipped(false)}
            className="text-[10px] uppercase tracking-widest text-primary"
          >
            connect anyway
          </button>
        </div>
      )}

      {w.status === "detecting" && !skipped && (
        <p className="text-sm text-muted-foreground">Detecting Midnight wallet…</p>
      )}

      {w.status === "ready" && !skipped && (
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={() => void w.connect()}
            className="px-4 py-2 bg-primary text-primary-foreground text-xs font-semibold uppercase tracking-wider rounded"
          >
            Connect wallet
          </button>
          {isUndeployed && (
            <button
              onClick={() => setSkipped(true)}
              className="px-4 py-2 border border-border text-xs font-semibold uppercase tracking-wider rounded"
            >
              Skip
            </button>
          )}
          <span className="text-xs text-muted-foreground">
            Reads your shielded &amp; unshielded addresses — no signing, no funds moved.
          </span>
        </div>
      )}

      {w.status === "connecting" && (
        <p className="text-sm text-muted-foreground">Approve the connection in Lace…</p>
      )}


      {w.status === "connected" && w.address && (
        <div className="space-y-3">
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
              shielded address
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <code className="font-mono text-xs break-all">{truncate(w.address)}</code>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(w.address ?? "");
                  setCopied("shielded");
                }}
                className="text-[10px] uppercase tracking-widest text-primary"
              >
                {copied === "shielded" ? "copied" : "copy"}
              </button>
            </div>
          </div>

          {w.unshieldedAddress && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
                unshielded address (paste into faucet)
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <code className="font-mono text-xs break-all">
                  {truncate(w.unshieldedAddress)}
                </code>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(w.unshieldedAddress ?? "");
                    setCopied("unshielded");
                  }}
                  className="text-[10px] uppercase tracking-widest text-primary"
                >
                  {copied === "unshielded" ? "copied" : "copy"}
                </button>
              </div>
            </div>
          )}

          {!isUndeployed && (
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`text-[10px] font-mono uppercase tracking-widest px-2 py-1 rounded border ${
                  dustEmpty
                    ? "border-destructive text-destructive"
                    : "border-primary text-primary"
                }`}
              >
                {w.dust
                  ? dustEmpty
                    ? "tDUST tank empty"
                    : `tDUST ${fmtDust(w.dust.balance)} / ${fmtDust(w.dust.cap)}`
                  : "tDUST unknown"}
              </span>
              <button
                onClick={() => void w.refreshDust()}
                className="text-[10px] uppercase tracking-widest opacity-60"
              >
                refresh
              </button>
            </div>
          )}

          {isUndeployed && (
            <p className="text-[11px] text-muted-foreground">
              Undeployed network — mint fees are paid server-side by the genesis wallet.
              Lace is used only to identify you; no tDUST needed.
            </p>
          )}

          {dustEmpty && <FaucetPanel address={w.unshieldedAddress ?? w.address} onFunded={() => void w.refreshDust()} />}

          <div className="flex items-center gap-4 text-[11px] flex-wrap">
            <span>
              network · <span className="font-mono">{w.network}</span>
            </span>
            <button
              onClick={w.disconnect}
              className="text-[10px] uppercase tracking-widest opacity-60"
            >
              disconnect
            </button>
          </div>
          {wrong && (
            <p className="text-[12px] text-destructive">
              Lace is on <span className="font-mono">{w.network}</span> but this app expects{" "}
              <span className="font-mono">{expectedNetwork}</span>. Switch networks inside Lace
              (Settings → Network → Custom → ws://localhost:9944).
            </p>
          )}
        </div>
      )}

      {w.status === "error" && !skipped && (
        <div className="space-y-2">
          <p className="text-sm text-destructive">{w.error ?? "Something went wrong."}</p>
          <div className="flex gap-3 flex-wrap">
            <button
              onClick={w.redetect}
              className="px-3 py-2 border border-border text-[10px] uppercase tracking-widest rounded"
            >
              Retry
            </button>
            <a
              href="https://www.lace.io/"
              target="_blank"
              rel="noreferrer"
              className="px-3 py-2 border border-border text-[10px] uppercase tracking-widest rounded"
            >
              Install Lace ↗
            </a>
            {isUndeployed && (
              <button
                onClick={() => setSkipped(true)}
                className="px-3 py-2 border border-border text-[10px] uppercase tracking-widest rounded"
              >
                Skip — use server signer
              </button>
            )}
          </div>
        </div>
      )}

    </div>
  );
}

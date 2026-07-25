import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "choreo:contract-address";

export function DeployPanel({
  walletConnected,
  address,
  onDeployed,
}: {
  walletConnected: boolean;
  address: string | null;
  onDeployed: (addr: string) => void;
}) {
  const [proving, setProving] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!proving) return;
    const t0 = Date.now();
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 250);
    return () => clearInterval(iv);
  }, [proving]);

  const saveManual = useCallback(() => {
    setError(null);
    const trimmed = manual.trim();
    if (!/^(0x)?[0-9a-fA-F]{6,}$/.test(trimmed)) {
      setError("Enter the hex contract address printed by scripts/deploy-midnight.mjs.");
      return;
    }
    localStorage.setItem(STORAGE_KEY, trimmed);
    onDeployed(trimmed);
  }, [manual, onDeployed]);

  const tryBrowserDeploy = useCallback(async () => {
    setError(null);
    setProving(true);
    try {
      // Browser deploy is intentionally not wired in this build. The canonical
      // Undeployed path is to run `bun scripts/deploy-midnight.mjs` locally and
      // paste the printed hex address below.
      throw new Error(
        "Browser deploy not wired in this build. Run `bun scripts/deploy-midnight.mjs` locally and paste the hex address below.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProving(false);
      setElapsed(0);
    }
  }, []);

  const disabled = !walletConnected || proving;

  return (
    <div className="p-5 border border-border rounded-md space-y-3 bg-card">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-widest text-muted-foreground">
          02 · deploy contract
        </span>
        {address && (
          <span className="text-[10px] font-mono opacity-60">
            active · {address.slice(0, 10)}…{address.slice(-6)}
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Fly Undeployed: the live contract address comes from{" "}
        <code className="font-mono">VITE_DEFAULT_CONTRACT</code> (currently{" "}
        <code className="font-mono">
          {address ? `${address.slice(0, 10)}…${address.slice(-6)}` : "not set"}
        </code>
        ). Only paste a different address if you redeployed the contract.
      </p>

      <div className="flex gap-2 flex-wrap">
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="0x… (contract hex address)"
          className="flex-1 min-w-[220px] px-3 py-2 bg-background border border-border rounded font-mono text-xs"
        />
        <button
          onClick={saveManual}
          disabled={!manual.trim()}
          className="px-4 py-2 bg-primary text-primary-foreground text-xs font-semibold uppercase tracking-wider rounded disabled:opacity-40"
        >
          Use address
        </button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => void tryBrowserDeploy()}
          disabled={disabled}
          className="px-3 py-2 border border-border text-[10px] uppercase tracking-widest rounded disabled:opacity-40"
        >
          {proving ? `Proving… ${elapsed}s (30–120s)` : "Try in-browser deploy"}
        </button>
        {proving && (
          <span className="text-[11px] text-muted-foreground">
            Local proof server on :6300 is generating ZK keys. This can take 30–120s.
          </span>
        )}
      </div>

      {error && <p className="text-[12px] text-destructive">{error}</p>}
    </div>
  );
}

export { STORAGE_KEY as CONTRACT_STORAGE_KEY };

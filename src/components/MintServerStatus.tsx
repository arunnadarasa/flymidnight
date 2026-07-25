import { useEffect, useState } from "react";

// Polls /api/mint (proxy to choreo-mint /health) and renders the pipeline
// as a step list: boot → wallet-start → dust-sync → providers → ready,
// then per-mint: mint-resolve → mint-prove → mint-submit → confirmed.
// Reconnecting is treated as an out-of-band phase overlaying the list.

type Stage =
  | "boot"
  | "wallet-start"
  | "dust-sync"
  | "providers"
  | "ready"
  | "reconnecting"
  | "mint-resolve"
  | "mint-prove"
  | "mint-submit"
  | "confirmed"
  | "error";

type Progress = {
  stage: Stage;
  message: string;
  since: number;
  steps?: { stage: Stage; message: string; at: number }[];
  lastMint?: { txId: string; at: number } | null;
};

type Health = {
  ok?: boolean;
  synced?: boolean;
  dust?: string;
  address?: string | null;
  error?: string | null;
  restarts?: number;
  progress?: Progress;
  lastClosure?: {
    reason: string;
    at: number;
    transient?: boolean;
    source?: string;
    attempt?: number;
  } | null;
};

const WARMUP_STEPS: { stage: Stage; label: string; etaSec: number }[] = [
  { stage: "boot", label: "Boot mint server", etaSec: 2 },
  { stage: "wallet-start", label: "Open node WebSocket", etaSec: 10 },
  { stage: "dust-sync", label: "Sync indexer + confirm dust", etaSec: 60 },
  { stage: "providers", label: "Build proof + indexer providers", etaSec: 5 },
  { stage: "ready", label: "Wallet warm", etaSec: 0 },
];

const MINT_STEPS: { stage: Stage; label: string; etaSec: number }[] = [
  { stage: "mint-resolve", label: "Resolve deployed contract", etaSec: 5 },
  { stage: "mint-prove", label: "Prove transaction (ZK)", etaSec: 90 },
  { stage: "mint-submit", label: "Submit to Midnight node", etaSec: 8 },
  { stage: "confirmed", label: "Confirmed on-chain", etaSec: 0 },
];

const MINT_STAGES: Stage[] = ["mint-resolve", "mint-prove", "mint-submit", "confirmed"];

function stageIndex(list: { stage: Stage }[], stage: Stage) {
  return list.findIndex((s) => s.stage === stage);
}

const LS_HEALTH_KEY = "choreo:mint-health";
const LS_RECONNECT_KEY = "choreo:mint-reconnect";

type ReconnectRecord = {
  attempt: number;   // health.restarts when reconnect first observed
  startedAt: number; // wall-clock ms when this reconnect began
  etaSec: number;    // ETA snapshot at reconnect start
};

function readLS<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeLS(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or disabled — ignore */
  }
}

function reconnectEta(attempt: number) {
  // Mirrors server backoff: ~45s base + 15s per prior restart, capped at 180s.
  return Math.min(45 + Math.max(0, attempt - 1) * 15, 180);
}

export function MintServerStatus() {
  const [health, setHealth] = useState<Health | null>(null);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [reconnect, setReconnect] = useState<ReconnectRecord | null>(null);
  const [showDiag, setShowDiag] = useState(false);

  // Hydrate persisted state after mount (avoid SSR hydration mismatch).
  useEffect(() => {
    const savedHealth = readLS<Health>(LS_HEALTH_KEY);
    if (savedHealth) setHealth(savedHealth);
    const savedReconnect = readLS<ReconnectRecord>(LS_RECONNECT_KEY);
    if (savedReconnect) setReconnect(savedReconnect);
    const savedAt = readLS<number>("choreo:mint-health-at");
    if (typeof savedAt === "number") setReceivedAt(savedAt);
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch("/api/mint", { method: "GET" });
        const j = (await r.json()) as Health;
        if (!alive) return;
        const at = Date.now();
        setHealth(j);
        setReceivedAt(at);
        writeLS(LS_HEALTH_KEY, j);
        writeLS("choreo:mint-health-at", at);
        setUnreachable(false);

        // Track reconnect lifecycle so the timer survives reloads.
        const stage = j.progress?.stage;
        const restarts = j.restarts ?? 0;
        const inReconnect = stage === "reconnecting" || (restarts > 0 && stage !== "ready" && stage !== "confirmed");
        setReconnect((prev) => {
          if (!inReconnect) {
            if (prev) localStorage.removeItem(LS_RECONNECT_KEY);
            return null;
          }
          // Start a new record when the attempt count advances or none exists.
          if (!prev || prev.attempt !== restarts) {
            const rec: ReconnectRecord = {
              attempt: restarts,
              startedAt: Date.now(),
              etaSec: reconnectEta(restarts),
            };
            writeLS(LS_RECONNECT_KEY, rec);
            return rec;
          }
          return prev;
        });
      } catch {
        if (!alive) return;
        setUnreachable(true);
      }
    };
    void poll();
    const id = setInterval(poll, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (unreachable) {
    return (
      <div className="rounded border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2 text-[12px]" role="status">
        <div className="font-semibold">Mint server unreachable</div>
        <div className="opacity-80">Retrying every 2.5s…</div>
      </div>
    );
  }

  const p = health?.progress;
  const stage: Stage = p?.stage ?? "boot";
  const isMinting = MINT_STAGES.includes(stage);
  const isReconnecting = stage === "reconnecting" || (health?.restarts ?? 0) > 0 && stage !== "ready" && !isMinting && stage !== "confirmed";
  const steps = isMinting ? MINT_STEPS : WARMUP_STEPS;
  const activeIdx = stageIndex(steps, stage);
  const inStageElapsed = p ? Math.max(0, Math.floor((now - p.since) / 1000)) : 0;

  const shellColor = isReconnecting
    ? "border-amber-500/40 bg-amber-500/5"
    : stage === "error"
    ? "border-destructive/40 bg-destructive/5"
    : stage === "confirmed"
    ? "border-primary/40 bg-primary/5"
    : "border-border bg-card";

  const heading = isReconnecting
    ? `Reconnecting to Midnight node (attempt ${health?.restarts ?? 1})`
    : isMinting
    ? "Minting on-chain"
    : stage === "ready"
    ? "Mint server ready"
    : "Warming up mint server";

  return (
    <div className={`rounded border ${shellColor} px-3 py-2 text-[12px] space-y-2`} role="status" aria-live="polite">
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full ${stage === "ready" || stage === "confirmed" ? "bg-primary" : "bg-current animate-pulse"}`}
          aria-hidden
        />
        <span className="font-semibold">{heading}</span>
        {p?.message && <span className="opacity-70 truncate">· {p.message}</span>}
      </div>

      <ol className="space-y-1">
        {steps.map((s, i) => {
          const done = activeIdx > i || stage === "ready" || stage === "confirmed" && i < steps.length;
          const active = activeIdx === i && stage !== "ready" && stage !== "confirmed";
          const pending = !done && !active;
          const icon = done ? "✓" : active ? "●" : "○";
          const color = done
            ? "text-primary"
            : active
            ? isReconnecting ? "text-amber-600 dark:text-amber-400" : "text-foreground"
            : "text-muted-foreground";
          return (
            <li key={s.stage} className={`flex items-baseline gap-2 font-mono text-[11px] ${color}`}>
              <span className="w-3 text-center">{icon}</span>
              <span className={active ? "font-semibold" : ""}>{s.label}</span>
              {active && s.etaSec > 0 && (
                <span className="opacity-70">
                  · {inStageElapsed}s / ~{s.etaSec}s
                </span>
              )}
              {done && s.stage !== "ready" && s.stage !== "confirmed" && (
                <span className="opacity-50">done</span>
              )}
              {pending && s.etaSec > 0 && (
                <span className="opacity-40">~{s.etaSec}s</span>
              )}
            </li>
          );
        })}
      </ol>

      {isReconnecting && (
        <div className="text-[11px] text-amber-600 dark:text-amber-400 opacity-90 space-y-0.5">
          <div>
            Fly Machines dropped the wallet WebSocket. Resuming from the top of the pipeline — no user action needed.
          </div>
          {reconnect && (
            <div className="font-mono opacity-90">
              elapsed {Math.max(0, Math.floor((now - reconnect.startedAt) / 1000))}s / ~{reconnect.etaSec}s
              {reconnect.attempt > 0 && <> · attempt {reconnect.attempt}</>}
            </div>
          )}
        </div>
      )}

      {stage === "confirmed" && p?.lastMint?.txId && (
        <div className="text-[11px] text-primary font-mono truncate">
          tx {p.lastMint.txId.slice(0, 24)}…
        </div>
      )}

      {health?.error && stage !== "ready" && stage !== "confirmed" && (
        <div className="text-[11px] text-muted-foreground truncate">last: {health.error}</div>
      )}

      <div className="pt-1 border-t border-border/60">
        <button
          type="button"
          onClick={() => setShowDiag((v) => !v)}
          className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          aria-expanded={showDiag}
        >
          {showDiag ? "Hide diagnostics" : "View diagnostics"}
        </button>
        {showDiag && (
          <div className="mt-2 space-y-2 text-[11px]">
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono">
              <span className="text-muted-foreground">last poll</span>
              <span>
                {receivedAt
                  ? `${Math.max(0, Math.floor((now - receivedAt) / 1000))}s ago (${new Date(receivedAt).toLocaleTimeString()})`
                  : "—"}
              </span>
              <span className="text-muted-foreground">restarts</span>
              <span>{health?.restarts ?? 0}</span>
              <span className="text-muted-foreground">last WS closure</span>
              <span className="break-all">
                {health?.lastClosure ? (
                  <>
                    {health.lastClosure.reason}
                    <span className="opacity-60">
                      {" "}· {Math.max(0, Math.floor((now - health.lastClosure.at) / 1000))}s ago
                      {health.lastClosure.source ? ` · ${health.lastClosure.source}` : ""}
                      {health.lastClosure.transient ? " · transient" : ""}
                    </span>
                  </>
                ) : (
                  <span className="opacity-60">none observed</span>
                )}
              </span>
            </div>
            <details>
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                Raw /api/mint payload
              </summary>
              <pre className="mt-1 max-h-56 overflow-auto rounded bg-muted/40 p-2 font-mono text-[10px] leading-snug">
                {health ? JSON.stringify(health, null, 2) : "no payload yet"}
              </pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}

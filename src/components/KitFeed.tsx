import { useEffect, useState } from "react";
import type { KitPayload } from "@/components/PublishKitForm";
import { decodeChainState } from "@/lib/contract";

type FeedEntry = KitPayload & { source: "local" | "chain" };

async function readIndexerState(indexerUrl: string, address: string): Promise<string | null> {
  try {
    const r = await fetch(indexerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($a:HexEncoded!){ contractAction(address:$a){ state } }`,
        variables: { a: address },
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.data?.contractAction?.state ?? null;
  } catch {
    return null;
  }
}

export function KitFeed({
  contractAddress,
  refreshTick,
}: {
  contractAddress: string | null;
  refreshTick: number;
}) {
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const [chainState, setChainState] = useState<string | null>(null);
  const [indexerErr, setIndexerErr] = useState<string | null>(null);

  useEffect(() => {
    const local = JSON.parse(localStorage.getItem("choreo:local-kits") ?? "[]") as KitPayload[];
    setEntries(local.map((k) => ({ ...k, source: "local" as const })));
  }, [refreshTick]);

  useEffect(() => {
    if (!contractAddress) return;
    const indexerUrl = import.meta.env.VITE_INDEXER_URL as string | undefined;
    if (!indexerUrl) {
      setIndexerErr("VITE_INDEXER_URL not set — running in local-only mode.");
      return;
    }
    let cancelled = false;
    const poll = async () => {
      const hex = await readIndexerState(indexerUrl, contractAddress);
      if (cancelled) return;
      if (hex) {
        setChainState(hex);
        setIndexerErr(null);
        const decoded = await decodeChainState(hex);
        const lastKit = decoded.lastKit;
        if (lastKit) {
          setEntries((prev) => {
            const exists = prev.some(
              (e) => e.source === "chain" && e.publishedAt === lastKit.publishedAt,
            );
            if (exists) return prev;
            return [{ ...lastKit, source: "chain" as const }, ...prev];
          });
        }
      } else {
        setIndexerErr("Indexer reachable but no state yet — waiting for first tx.");
      }
    };
    void poll();
    const iv = setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [contractAddress, refreshTick]);

  return (
    <div className="p-5 border border-border rounded-md space-y-3 bg-card">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-widest text-muted-foreground">
          04 · kit feed
        </span>
        <span className="text-[10px] font-mono opacity-60">
          {chainState ? "chain · synced" : contractAddress ? "chain · waiting" : "local · draft"}
        </span>
      </div>

      {entries.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No kits yet. Publish one above to see it here.
        </p>
      )}

      <ul className="space-y-2">
        {entries.map((k, i) => (
          <li
            key={`${k.publishedAt}-${i}`}
            className="p-3 border border-border rounded bg-background/50 space-y-1"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">{k.title}</span>
              <span className="text-[10px] font-mono opacity-60">
                {k.priceDust} tDUST · {k.source}
              </span>
            </div>
            <p className="text-xs text-muted-foreground whitespace-pre-wrap">{k.steps}</p>
            <p className="text-[10px] font-mono opacity-50">
              {new Date(k.publishedAt).toLocaleString()}
            </p>
          </li>
        ))}
      </ul>

      {chainState && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted-foreground uppercase tracking-widest">
            raw chain state (hex)
          </summary>
          <code className="block mt-2 break-all font-mono opacity-70">
            {chainState.slice(0, 320)}
            {chainState.length > 320 ? "…" : ""}
          </code>
        </details>
      )}

      {indexerErr && (
        <p className="text-[11px] text-muted-foreground italic">{indexerErr}</p>
      )}
    </div>
  );
}

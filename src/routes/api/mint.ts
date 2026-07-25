import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

// Proxy /api/mint -> choreo-mint Fly app. Keeps the Cloudflare Worker free
// of Midnight WASM / Node-only deps. Configure via VITE_MINT_URL (defaults
// to the public choreo-mint app).
const MINT_BASE =
  (import.meta.env.VITE_MINT_URL as string | undefined) ??
  "https://choreo-mint.fly.dev";

const MintSchema = z.object({
  contractAddress: z.string().regex(/^(0x)?[0-9a-fA-F]{6,}$/),
  title: z.string().min(1).max(200),
  steps: z.string().min(1).max(4000),
  priceDust: z.number().int().min(0).max(1_000_000),
});

export const Route = createFileRoute("/api/mint")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "content-type",
          },
        }),
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid json" }, { status: 400 });
        }
        const parsed = MintSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { error: "invalid input", issues: parsed.error.issues },
            { status: 400 },
          );
        }
        try {
          const r = await fetch(`${MINT_BASE}/mint`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(parsed.data),
          });
          const text = await r.text();
          return new Response(text, {
            status: r.status,
            headers: { "content-type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("/api/mint proxy failed:", e);
          return Response.json(
            { error: `choreo-mint unreachable: ${msg}` },
            { status: 502 },
          );
        }
      },
      GET: async () => {
        try {
          const r = await fetch(`${MINT_BASE}/health`);
          const text = await r.text();
          return new Response(text, {
            status: r.status,
            headers: { "content-type": "application/json" },
          });
        } catch (e) {
          return Response.json(
            { ok: false, error: (e as Error).message },
            { status: 502 },
          );
        }
      },
    },
  },
});

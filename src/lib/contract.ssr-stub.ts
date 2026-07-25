// SSR-safe stub for src/lib/contract.ts. The home route is ssr:false, so these
// helpers are never invoked on the server; this stub just satisfies the import
// graph during the Cloudflare workerd bundle pass.
import type { ConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";

export async function publishKit(
  _api: ConnectedAPI,
  _networkId: string,
  _contractAddress: string,
  _title: string,
  _steps: string,
  _priceDust: number,
): Promise<string> {
  throw new Error("publishKit is not available during SSR");
}

export async function decodeChainState(
  _contractAddress: string,
  _hexState?: string | null,
): Promise<unknown> {
  return null;
}

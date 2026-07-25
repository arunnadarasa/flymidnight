import { useEffect, useState, type ReactNode } from "react";

/**
 * Renders children only after client hydration. Required for any Midnight
 * code path that touches window, Buffer, or WASM top-level await.
 */
export function ClientOnly({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <>{fallback}</>;
  return <>{children}</>;
}

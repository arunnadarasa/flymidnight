// SSR-safe stub for Midnight WASM packages. These packages only ship browser/node
// entries and crash the Cloudflare workerd resolver. The home route is ssr:false,
// so this stub is bundled but never executed on the server.
export default {};

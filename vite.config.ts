import { defineConfig } from "vite";

export default defineConfig({
  // Baked into the bundle so a released widget needs no gateway-url attribute
  // — the embed snippet stays a single tag. Empty unless the build sets it
  // (release.yml passes the production gateway), which keeps every local build
  // behaving exactly as before: attribute required.
  define: {
    __MANEKI_GATEWAY_URL__: JSON.stringify(process.env.MANEKI_GATEWAY_URL ?? ""),
  },
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "maneki-widget.js",
    },
    // ES module output (not iife/umd) deliberately — Rollup can't code-split
    // a single-file iife/umd bundle, which would force livekit-client to be
    // inlined into the always-loaded bundle instead of fetched lazily on
    // tap-to-talk. Embed snippet is <script type="module" src="...">.
    rollupOptions: {
      output: {
        chunkFileNames: "[name]-[hash].js",
      },
    },
    target: "es2020",
  },
});

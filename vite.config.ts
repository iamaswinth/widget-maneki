import { defineConfig } from "vite";

export default defineConfig({
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

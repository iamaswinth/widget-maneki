import { defineConfig } from "vitest/config";

export default defineConfig({
  // This config is entirely separate from vite.config.ts — vitest does not
  // read it — so the build-time global has to be declared here too. Without
  // it every test that touches the element throws ReferenceError on
  // __MANEKI_GATEWAY_URL__.
  //
  // Hardcoded empty rather than read from the environment, so the suite always
  // exercises the "no baked-in URL" path (gateway-url attribute required) and
  // a stray MANEKI_GATEWAY_URL in someone's shell can't quietly change what
  // the tests assert.
  define: {
    __MANEKI_GATEWAY_URL__: JSON.stringify(""),
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
  },
});

/** The gateway URL baked in at build time, substituted by Vite's `define`
 * (see vite.config.ts). Empty string when the build didn't set one, which is
 * the case for every local build and every test run — so the `gateway-url`
 * attribute stays required unless a release build supplied a default. */
declare const __MANEKI_GATEWAY_URL__: string;

# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## What this is

`widget` is the embedded, client-side piece of Maneki: a small `<maneki-widget>` Custom
Element a business pastes onto their site, letting a real visitor talk to the voice sales
agent in-browser. It joins a LiveKit room using a token minted by the API gateway
(`POST /widget/token`), publishes the visitor's mic audio, and reacts to `navigate`/
`interrupt` events the voice runtime sends over the LiveKit data channel.

This is the fourth and newest Maneki service — see the workspace root `../CLAUDE.md` for
how it fits with `Firecrawl-scraper-ingestion`, `voice runtime gateway`, and `api-gateway`.
Full design context: `C:\Users\iamas\.claude\plans\api-gateway-sleepy-sunset.md` (despite
the filename, its current contents are the widget plan — the API gateway plan that
originally lived there is superseded, its build already shipped).

## Stack

- Vanilla TypeScript, no framework — this code runs inside someone else's page, so no
  React/Vue runtime gets bundled into a third-party script.
- Custom Elements + Shadow DOM (`src/element.ts`) for style encapsulation both directions.
- `livekit-client` for the real-time transport — **lazy-loaded via dynamic `import()`** on
  tap-to-talk, not bundled into the always-loaded shell. This is why the build output is a
  single ES module (`formats: ["es"]` in `vite.config.ts`), not `iife`/`umd` — Rollup can't
  code-split a single-file bundle, which would force `livekit-client` to be inlined into the
  main file. Embed snippet is `<script type="module" src="...">`, not a plain `<script src>`.
- `sessionStorage`-backed **visitor grant** (`src/session.ts`) — an opaque, gateway-signed
  blob replayed on every `POST /widget/token`. The `visitor_id`/`session_id` inside it are
  minted server-side (the latter becomes the voice runtime's LangGraph `thread_id`), which
  is what lets a visitor's conversation survive a same-tab cross-page navigation the agent
  itself triggers. **The widget never generates or sends either id directly** — when it
  did, any caller could name another visitor's session and have the agent resume their
  conversation. See `api-gateway/app/widget/grant.py`.

## Commands

```powershell
npm install
npm run dev              # Vite dev server
npm test                 # vitest run (jsdom environment)
npm run build             # outputs dist/maneki-widget.js
```

Manual visual check (this project has no way to be verified by an agent without a real
browser): `npm run build`, then open `examples/index.html` directly in a browser, or serve
it (`npx serve .`) and navigate to `/examples/`. Use the on-page buttons or
`document.querySelector('maneki-widget').setState('listening')` in devtools to cycle states.

## Releases

Delivered as a hosted script on Cloudflare R2, not via npm (`package.json` is `private`).
`dist/` stays gitignored and is built in CI — see `README.md` for the embed snippet, the
release/rollback runbooks, and the one-time R2 setup.

Two invariants that are easy to break and expensive to discover:

- **Deploys are additive; never add `--delete` to `scripts/promote.sh`.** The entry file
  imports a content-hashed chunk by name and is cached by browsers, so deleting an older
  release's chunks 404s already-cached entry files on live customer sites — unfixable by
  redeploying.
- **The bucket needs CORS.** `<script type="module">` and dynamic `import()` both fetch in
  CORS mode; without `Access-Control-Allow-Origin` the widget cannot load cross-origin at
  all. `scripts/smoke.sh` checks this (plus MIME type and chunk resolution) on every
  release, before the floating alias moves.

`__MANEKI_GATEWAY_URL__` is substituted at build time by Vite's `define`. It must be
declared in **both** `vite.config.ts` and `vitest.config.ts` — vitest does not read the
former, and a missing definition is a `ReferenceError` in every element test.

## Conventions worth preserving

- Every network call needs a defined failure UI state — this code runs inside someone else's
  web page, so a silent hang or an uncaught exception is not acceptable.
- **Data-channel messages are only acted on if the sender is the agent** (`kind ===
  ParticipantKind.AGENT`, assigned by the LiveKit server, not self-reported). `navigate`
  and `interrupt` drive the host page; another participant in the room must not be able to.
- **Never assign a data-channel-supplied value to `location.href` unchecked.** Navigation
  targets go through `resolveNavigationTarget` (http(s) scheme + same origin), and the
  parsed URL it returns is what gets assigned — not the original string. A `javascript:`
  target would otherwise execute on the tenant's own page, and an off-origin one is an open
  redirect. Targets trace back to crawled page content, so they are not trusted input.
- Nothing outside `src/` global scope may be assumed available or safe to mutate.
- `handleTapToTalk` (or its Session 2+ replacement) is the boundary between the always-loaded
  shell and the lazily-loaded `livekit-client` — don't import `livekit-client` at module top
  level anywhere reachable from `src/index.ts`'s initial evaluation.

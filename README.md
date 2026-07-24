# @maneki/widget

The embeddable `<maneki-widget>` Custom Element a business pastes onto their site to let
visitors talk to the Maneki voice sales agent.

Not published to npm — it is delivered as a hosted script. See `CLAUDE.md` for the
architecture and `../CLAUDE.md` for how it fits with the rest of the stack.

## Embedding

```html
<script type="module"
        src="https://YOUR_CDN/v1/maneki-widget.js"
        site-id="acme"></script>
<maneki-widget site-id="acme"></maneki-widget>
```

`type="module"` is required — the build is an ES module so that `livekit-client` (733 KB)
can be code-split and fetched lazily on tap-to-talk rather than on page load. A plain
`<script src>` will not work.

`gateway-url` is optional on a released build, which has the production gateway baked in.
Set it to point a page at a local or staging gateway:

```html
<maneki-widget site-id="acme" gateway-url="http://localhost:8080"></maneki-widget>
```

## Versioning

| URL | Guarantee |
|---|---|
| `/v1/maneki-widget.js` | Latest `1.x`. Bug fixes and features arrive automatically; no breaking changes. **Embed this.** |
| `/v1.2.3/maneki-widget.js` | Exactly that build, forever. Never receives fixes. |

Embed the floating major. It is the only way you can ship a security fix to sites you don't
control. Pin the exact version only when a customer explicitly requires change control, and
understand that you then own telling them when to move.

### Why old files are never deleted

`maneki-widget.js` imports a content-hashed sibling chunk by name. Browsers cache the entry
file, so a visitor can be holding an entry file from an earlier release and will request
*that* release's chunk. Deleting old chunks 404s those cached files on live customer sites,
and no redeploy can fix a file already in someone's browser cache.

Deploys are therefore strictly additive. `scripts/promote.sh` must never gain a `--delete`.

## Local development

```powershell
npm install
npm test            # vitest, jsdom
npm run typecheck   # tsc --noEmit
npm run build       # -> dist/
```

Manual visual check (needs a real browser, so an agent can't do it): `npm run build`, then
serve the repo and open `examples/index.html` — see `CLAUDE.md` for the port the seeded
`acme` tenant expects.

## Releasing

CI must be green on `main` first.

```bash
npm version 1.2.3          # updates package.json, creates the v1.2.3 tag
git push --follow-tags
```

`.github/workflows/release.yml` then:

1. verifies the tag matches `package.json` (a mismatch fails the release),
2. re-runs typecheck + tests + build — a tag can point at any commit, including one CI
   never saw,
3. uploads to `/v1.2.3/` as immutable,
4. **smoke-tests that path** before anything points at it,
5. copies it to `/v1/`,
6. smoke-tests `/v1/`.

The smoke test (`scripts/smoke.sh`) checks status, JavaScript MIME type, CORS headers, and
that the lazy chunk actually resolves — the four things that make the difference between
"the file uploaded" and "a browser on someone else's site can run it".

### Rolling back

Run the **Promote** workflow with an earlier version (e.g. `1.2.2`). It re-points `/v1/` at
bytes that were already published and smoke-tested — no rebuild, and it works even if the
bad version's source no longer builds. Live within ~5 minutes (the entry file's TTL).

## One-time infrastructure setup

### 1. Cloudflare R2

1. Create an R2 bucket, e.g. `maneki-widget`.
2. **Public access.** Connect a custom domain (recommended) or enable the `r2.dev` URL.
3. **CORS policy — mandatory.** Without it, a cross-origin module script fails outright:

   ```json
   [
     {
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```

   `*` is correct here: this is public static JavaScript served with no credentials.
4. Create an R2 API token with **Object Read & Write** scoped to the bucket. Note the
   Access Key ID, Secret Access Key, and your Account ID.

### 2. GitHub → Settings → Secrets and variables → Actions

| Kind | Name | Value |
|---|---|---|
| Secret | `R2_ACCOUNT_ID` | Cloudflare account ID |
| Secret | `R2_ACCESS_KEY_ID` | from the R2 API token |
| Secret | `R2_SECRET_ACCESS_KEY` | from the R2 API token |
| Variable | `R2_BUCKET` | e.g. `maneki-widget` |
| Variable | `CDN_BASE_URL` | public base URL, no trailing slash |
| Variable | `MANEKI_GATEWAY_URL` | production gateway; leave empty until one is deployed |

With `MANEKI_GATEWAY_URL` empty the widget simply requires the `gateway-url` attribute, as
it does today — nothing here is blocked on the gateway being live.

### Get a domain before the first customer embed

`r2.dev` works for testing, but three things make it wrong for production:

1. **Cloudflare rate-limits it** and explicitly says not to use it for production traffic.
2. **It serves everything uncompressed.** Measured against the live bucket: the
   `livekit-client` chunk transfers **733 KB** even when the client offers `gzip, br` — no
   `Content-Encoding` comes back. Gzipped it is **166 KB**, so every cold load on every
   customer's site costs 4.4× more bandwidth than it needs to. A custom domain puts the
   bucket behind Cloudflare's normal CDN path, which compresses automatically.
3. **The embed URL is effectively permanent** once it is pasted into customers' HTML —
   migrating later means a support campaign you will never fully finish.

A domain is ~$10/yr; switching is one `CDN_BASE_URL` change plus DNS, no code change.

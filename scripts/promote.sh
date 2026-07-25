#!/usr/bin/env bash
#
# Points the floating major alias at an already-published exact version.
#
#   scripts/promote.sh 1.2.3     ->  /v1/ now serves 1.2.3
#
# This is both the release step and the rollback mechanism: promoting an older
# version is a pure server-side copy, no rebuild, and takes effect within the
# entry file's 300s TTL.
#
# THE DEPLOY IS ADDITIVE AND MUST STAY THAT WAY. Never add --delete here.
# Browsers cache the entry file, and a cached entry file references its own
# content-hashed chunk by name. Deleting chunks belonging to a previous version
# 404s those already-cached entry files on live customer sites, and no redeploy
# can fix a file that is already in someone's browser cache. Stale chunks are
# cheap; deleting them is unrecoverable.
#
# Requires: R2_BUCKET, R2_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.
set -euo pipefail

VERSION="${1:?usage: promote.sh <version>}"
: "${R2_BUCKET:?}" "${R2_ACCOUNT_ID:?}"

MAJOR="${VERSION%%.*}"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
SRC="s3://${R2_BUCKET}/v${VERSION}"
DST="s3://${R2_BUCKET}/v${MAJOR}"

# Two passes, because the two kinds of file need opposite cache policies and
# `aws s3 cp --recursive` can only apply one.
#
# Chunks first, entry file second — deliberately. The entry file is the only
# thing that references a chunk, so publishing it before its chunk exists opens
# a window where a visitor loads the new entry and its import 404s.
# --metadata-directive REPLACE is required to change Cache-Control on a copy.

# 1. Hashed chunks: immutable, and additive — previous versions' chunks stay.
aws s3 cp "${SRC}/" "${DST}/" \
  --recursive \
  --exclude "maneki-widget.js" \
  --endpoint-url "$ENDPOINT" \
  --metadata-directive REPLACE \
  --content-type "text/javascript" \
  --cache-control "public, max-age=31536000, immutable"

# 2. Entry file: short TTL. This is the whole rollback mechanism — the alias
# can only move as fast as this value lets caches expire.
aws s3 cp "${SRC}/maneki-widget.js" "${DST}/maneki-widget.js" \
  --endpoint-url "$ENDPOINT" \
  --metadata-directive REPLACE \
  --content-type "text/javascript" \
  --cache-control "public, max-age=300"

echo "promoted v${VERSION} -> /v${MAJOR}/"

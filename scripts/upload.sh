#!/usr/bin/env bash
#
# Uploads a freshly-built dist/ to the immutable path for one exact version.
#
#   scripts/upload.sh 1.2.3
#
# Everything under /v{full}/ is immutable and never rewritten — that is what
# makes it safe to cache for a year and what gives promote.sh something stable
# to point the floating alias at.
#
# Requires: R2_BUCKET, R2_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.
set -euo pipefail

VERSION="${1:?usage: upload.sh <version>}"
: "${R2_BUCKET:?}" "${R2_ACCOUNT_ID:?}"

ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

if [ ! -f dist/maneki-widget.js ]; then
  echo "dist/maneki-widget.js not found — run 'npm run build' first" >&2
  exit 1
fi

# Content-Type is set explicitly rather than left to extension sniffing.
# Module scripts are subject to strict MIME checking: a chunk served as
# binary/octet-stream is refused by the browser outright, and the widget fails
# at tap-to-talk with an error that points nowhere near the cause.
aws s3 cp dist/ "s3://${R2_BUCKET}/v${VERSION}/" \
  --recursive \
  --endpoint-url "$ENDPOINT" \
  --content-type "text/javascript" \
  --cache-control "public, max-age=31536000, immutable"

echo "uploaded v${VERSION}"

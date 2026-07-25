#!/usr/bin/env bash
#
# Verifies a published path is actually usable by a browser on someone else's
# site — which is more than "the file is there".
#
#   scripts/smoke.sh https://cdn.example.com v1.2.3
#
# Checks, in the order they'd bite:
#   1. the entry file returns 200
#   2. it is served with a JavaScript MIME type (module scripts are subject to
#      strict MIME checking — the wrong type means the browser refuses to
#      execute it, with no useful error)
#   3. it carries Access-Control-Allow-Origin (a cross-origin module script
#      without CORS fails outright; missing bucket CORS is the single most
#      likely way this ships broken)
#   4. the content-hashed chunk it imports resolves and passes the same checks
#
# Point 4 matters most on the floating alias: whatever entry file the edge is
# currently serving — possibly a cached older one — must still find its chunk.
# That is the additive-deploy invariant, checked directly.
set -euo pipefail

BASE="${1:?usage: smoke.sh <base-url> <path>}"
PATH_PREFIX="${2:?usage: smoke.sh <base-url> <path>}"

ORIGIN="https://smoke-test.example.com"
FAILED=0

check() {
  local url="$1" label="$2"
  local headers status ctype cors

  headers=$(curl -fsSI -H "Origin: ${ORIGIN}" "$url" 2>/dev/null) || {
    echo "  FAIL ${label}: request failed (${url})"
    FAILED=1
    return
  }

  # `|| true` on every grep: a header being absent is exactly what this script
  # is looking for, but under `set -e` a non-matching grep in a command
  # substitution aborts the script — silently, before it can report which
  # header was missing.
  status=$(printf '%s' "$headers" | head -1 | tr -d '\r')
  ctype=$(printf '%s' "$headers" | grep -i '^content-type:' | tr -d '\r' | head -1 || true)
  cors=$(printf '%s' "$headers" | grep -i '^access-control-allow-origin:' | tr -d '\r' | head -1 || true)

  echo "  ${label}"
  echo "    ${status}"
  echo "    ${ctype:-content-type: (absent)}"
  echo "    ${cors:-access-control-allow-origin: (ABSENT)}"

  case "$ctype" in
    *javascript*|*ecmascript*) ;;
    *)
      echo "    FAIL: not a JavaScript MIME type — browsers will refuse to execute this module"
      FAILED=1
      ;;
  esac

  if [ -z "$cors" ]; then
    echo "    FAIL: no CORS header — a cross-origin module script cannot load this"
    FAILED=1
  fi
}

ENTRY="${BASE}/${PATH_PREFIX}/maneki-widget.js"
echo "smoke: ${BASE}/${PATH_PREFIX}"
check "$ENTRY" "entry  maneki-widget.js"

# Read the chunk name out of the file actually being served, rather than from
# the local dist/ — on the floating alias those can legitimately differ, and
# the served one is what visitors will request.
CHUNK=$(curl -fsS "$ENTRY" | grep -o 'import("\./[^"]*")' | head -1 | sed 's/^import("\.\///; s/")$//' || true)

if [ -z "$CHUNK" ]; then
  echo "  FAIL: no lazy chunk import found in the served entry file"
  echo "        (the livekit-client code-split collapsed — see vite.config.ts)"
  exit 1
fi

check "${BASE}/${PATH_PREFIX}/${CHUNK}" "chunk  ${CHUNK}"

if [ "$FAILED" -ne 0 ]; then
  echo "smoke FAILED"
  exit 1
fi
echo "smoke OK"

#!/usr/bin/env bash
#
# Guard: the base (non-overlay) deployment must stay E2EE-off.
#
# E2EE-REVIEW-13 condition 8 / issue #35: the base stack keeps
# `KRUG_E2EE_ENABLED=false`; only the disposable test overlay
# (`deploy/docker-compose.e2ee-test.yml`) may force the flag on.
#
# CI and `scripts/release-check.sh` run this check before building anything.
# Exit code: 0 = safe defaults, 1 = a committed default would enable E2EE.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

failed=0

check() {
  local file="$1"
  local pattern="$2"
  local description="$3"

  if [[ ! -f "$file" ]]; then
    printf 'FAIL  %s — missing file %s\n' "$description" "$file"
    failed=1
    return
  fi

  if grep -Eq "$pattern" "$file"; then
    printf 'ok    %s\n' "$description"
  else
    printf 'FAIL  %s — pattern %q not found in %s\n' "$description" "$pattern" "$file"
    failed=1
  fi
}

check "deploy/.env.example" \
  '^KRUG_E2EE_ENABLED=false$' \
  "deploy/.env.example keeps KRUG_E2EE_ENABLED=false"

check "deploy/docker-compose.yml" \
  'KRUG_E2EE_ENABLED: \$\{KRUG_E2EE_ENABLED:-false\}' \
  "base compose defaults the backend flag to false"

check "deploy/docker-compose.yml" \
  'VITE_E2EE_ENABLED: \$\{KRUG_E2EE_ENABLED:-false\}' \
  "base compose defaults the SPA build flag to false"

check "frontend/Dockerfile" \
  '^ARG VITE_E2EE_ENABLED=false$' \
  "frontend Dockerfile defaults VITE_E2EE_ENABLED=false"

# The overlay is the only place allowed to force the flag on. If it stops doing
# that, the gated F7B workflow would silently test the flag-off stack.
check "deploy/docker-compose.e2ee-test.yml" \
  'KRUG_E2EE_ENABLED: "true"' \
  "test overlay forces the backend flag on"

check "deploy/docker-compose.e2ee-test.yml" \
  'VITE_E2EE_ENABLED: "true"' \
  "test overlay forces the SPA build flag on"

# A local (gitignored) deploy/.env may legitimately point at the test overlay.
# Warn, do not fail: it is not part of the committed defaults.
if [[ -f deploy/.env ]] && grep -Eq '^KRUG_E2EE_ENABLED=true' deploy/.env; then
  printf 'WARN  deploy/.env has KRUG_E2EE_ENABLED=true (local overlay state; never commit)\n'
fi

if (( failed )); then
  printf '\nE2EE base flags are NOT safe: refusing to build/deploy.\n' >&2
  exit 1
fi

printf '\nE2EE base flags are safe (false); only the overlay forces them on.\n'

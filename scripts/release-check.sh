#!/usr/bin/env bash
#
# Release rebuild / verification for the E2EE pilot (issue #35).
#
# Runs the same blocking gates as CI and captures reproducible artifact hashes:
#   1. frontend  `npm ci` + `npm run check` (eslint, prettier, contract drift,
#      stickers, client security, session writers, vitest, tsc + vite build)
#   2. backend   `mvn -B -ntp test` (unit + Testcontainers integration)
#   3. contract  `contract:check` + SHA-256 of contracts/openapi.yaml
#   4. artifacts SHA-256 of `frontend/dist` assets and Docker image IDs
#
# It never pushes images, never tags a release and never enables E2EE: the base
# stack must stay `KRUG_E2EE_ENABLED=false`, and the test overlay is not used.
#
# Usage:
#   scripts/release-check.sh [options]
#
# Options:
#   --skip-frontend   Skip npm ci / npm run check
#   --skip-backend    Skip mvn test
#   --skip-images     Do not inspect Docker images
#   --build-images    Build backend/frontend images first (base compose, flag off)
#   --assets-from-image
#                     Hash SPA assets extracted from the frontend image instead of
#                     the local `frontend/dist` (implied by --build-images)
#   --out DIR         Output base directory
#                     (default: $TMPDIR/krug-release-check)
#   -h, --help        Show this help
#
# Exit code: 0 = every executed gate passed, 1 = a gate failed.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_BASE="${RELEASE_OUT_DIR:-${TMPDIR:-/tmp}/krug-release-check}"
OUT_DIR="$OUT_BASE/$STAMP"

SKIP_FRONTEND=0
SKIP_BACKEND=0
SKIP_IMAGES=0
BUILD_IMAGES=0
ASSETS_FROM_IMAGE=0
ASSETS_ROOT="${FRONTEND_ASSET_ROOT:-/usr/share/nginx/html}"
ASSET_TMP=""

BACKEND_IMAGE="${KRUG_BACKEND_IMAGE:-krug-backend:latest}"
FRONTEND_IMAGE="${KRUG_FRONTEND_IMAGE:-krug-frontend:latest}"

RESULTS=()
FINAL_STATUS=0

usage() {
  cat <<'EOF'
Release rebuild / verification for the E2EE pilot (issue #35).

Runs the same blocking gates as CI and captures reproducible artifact hashes:
  1. frontend  npm ci + npm run check (lint, format, contract, security,
               session writers, vitest, tsc + vite build)
  2. backend   mvn test (unit + Testcontainers integration)
  3. contract  contract:check + SHA-256 of contracts/openapi.yaml
  4. artifacts SHA-256 of SPA assets (from the image or frontend/dist) and Docker image IDs

Never pushes images, never creates git tags, never enables E2EE.

Usage: scripts/release-check.sh [options]

Options:
  --skip-frontend   Skip npm ci / npm run check
  --skip-backend    Skip mvn test
  --skip-images     Do not inspect Docker images
  --build-images    Build backend/frontend images first (base compose, flag off)
  --assets-from-image
                    Hash SPA assets from the frontend image (implied by --build-images)
  --out DIR         Output base directory (default: $TMPDIR/krug-release-check)
  -h, --help        Show this help

Exit code: 0 = every executed gate passed, 1 = a gate failed.

Environment:
  MAVEN_REPO_LOCAL  Optional Maven local repository path (writable sandboxes);
                    maps to -Dmaven.repo.local.
EOF
}

log() {
  printf '\n==> %s\n' "$*"
}

warn() {
  printf 'WARN  %s\n' "$*" >&2
}

record_result() {
  RESULTS+=("$1|$2")
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

refresh_java_home() {
  if [[ -x /usr/libexec/java_home ]]; then
    local detected
    if detected="$(/usr/libexec/java_home -v 21 2>/dev/null)"; then
      export JAVA_HOME="$detected"
    fi
  fi
}

capture_versions() {
  {
    printf 'date_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'node=%s\n' "$(node --version 2>/dev/null || echo missing)"
    printf 'npm=%s\n' "$(npm --version 2>/dev/null || echo missing)"
    printf 'java=%s\n' "$(java -version 2>&1 | head -n 1 || echo missing)"
    printf 'mvn=%s\n' "$(mvn --version 2>/dev/null | head -n 1 || echo missing)"
    printf 'docker=%s\n' "$(docker --version 2>/dev/null || echo missing)"
    if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
      printf 'git_rev=%s\n' "$(git -C "$ROOT" rev-parse HEAD)"
    else
      printf 'git_rev=no-git-repository\n'
    fi
  } > "$OUT_DIR/versions.txt"
}

write_report() {
  {
    printf '# Release check — %s\n\n' "$STAMP"
    printf 'Repository: `%s`\n\n' "$ROOT"
    printf 'E2EE base flag: `false` (enforced by `scripts/check-e2ee-base-flags.sh`).\n'
    printf 'This run did **not** push images, create git tags or enable E2EE.\n\n'
    printf '## Gates\n\n'
    printf '| Gate | Result |\n|---|---|\n'
    local entry
    for entry in "${RESULTS[@]}"; do
      printf '| %s | %s |\n' "${entry%%|*}" "${entry##*|}"
    done
    printf '\n## Toolchain\n\n```\n'
    cat "$OUT_DIR/versions.txt"
    printf '```\n\n'
    printf '## Backend tests\n\n'
    if [[ -f "$OUT_DIR/backend-test.log" ]]; then
      local summary
      summary="$(grep -E '^\[INFO\] Tests run: [0-9]+, Failures: [0-9]+, Errors: [0-9]+, Skipped: [0-9]+$' "$OUT_DIR/backend-test.log" | tail -n 1 || true)"
      printf '```\n%s\n```\n\n' "${summary:-no Maven summary line found}"
    else
      printf '_skipped_\n\n'
    fi
    printf '## Contract\n\n'
    if [[ -f "$OUT_DIR/contract-stats.txt" ]]; then
      printf '```\n'
      cat "$OUT_DIR/contract-stats.txt"
      printf '```\n\n'
    fi
    if [[ -f "$OUT_DIR/contract-sha256.txt" ]]; then
      printf 'OpenAPI SHA-256: `%s`\n\n' "$(cat "$OUT_DIR/contract-sha256.txt")"
    fi
    printf '## Images\n\n'
    if [[ -f "$OUT_DIR/images.tsv" ]]; then
      printf '| Image | ID | Created | RepoDigests |\n|---|---|---|---|\n'
      local image id created digests
      while IFS=$'\t' read -r image id created digests; do
        printf '| `%s` | `%s` | %s | %s |\n' "$image" "$id" "$created" "${digests:-none}"
      done < "$OUT_DIR/images.tsv"
      printf '\n'
    else
      printf '_not inspected_\n\n'
    fi
    printf '## Frontend assets (SHA-256)\n\n'
    if [[ -s "$OUT_DIR/assets.txt" ]]; then
      if [[ -f "$OUT_DIR/assets-source.txt" ]]; then
        printf 'Source: `%s`\n\n' "$(cat "$OUT_DIR/assets-source.txt")"
      fi
      printf '```\n'
      cat "$OUT_DIR/assets.txt"
      printf '```\n\n'
    else
      printf '_no SPA assets found_\n\n'
    fi
    printf '## Logs\n\n'
    printf 'Raw gate output is in `%s`.\n' "$OUT_DIR"
  } > "$OUT_DIR/release-$STAMP.md"
}

finish() {
  write_report
  if (( FINAL_STATUS == 0 )); then
    printf '\nRELEASE CHECK PASSED\n'
    printf 'Report: %s\n' "$OUT_DIR/release-$STAMP.md"
  else
    printf '\nRELEASE CHECK FAILED\n'
    printf 'Report: %s\n' "$OUT_DIR/release-$STAMP.md"
  fi
  exit "$FINAL_STATUS"
}

while (( $# )); do
  case "$1" in
    --skip-frontend) SKIP_FRONTEND=1 ;;
    --skip-backend) SKIP_BACKEND=1 ;;
    --skip-images) SKIP_IMAGES=1 ;;
    --build-images) BUILD_IMAGES=1 ;;
    --assets-from-image) ASSETS_FROM_IMAGE=1 ;;
    --out)
      if [[ $# -lt 2 ]]; then
        printf 'error: --out requires a directory\n' >&2
        exit 2
      fi
      OUT_BASE="$2"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'error: unknown option %s\n\n' "$1" >&2
      usage
      exit 2
      ;;
  esac
  shift
done

if (( BUILD_IMAGES == 1 )); then
  ASSETS_FROM_IMAGE=1
fi

OUT_DIR="$OUT_BASE/$STAMP"
mkdir -p "$OUT_DIR"

log "Preflight"
for tool in node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'error: %s is required\n' "$tool" >&2
    exit 2
  fi
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then
  printf 'error: Node >= 20.19 is required, found %s\n' "$(node --version)" >&2
  exit 2
fi

if ! "$ROOT/scripts/check-e2ee-base-flags.sh"; then
  record_result "E2EE base flags" "FAIL"
  FINAL_STATUS=1
  capture_versions
  finish
fi
record_result "E2EE base flags" "PASS"

capture_versions

if (( SKIP_FRONTEND == 0 )); then
  log "Frontend: npm ci"
  if ( cd "$ROOT/frontend" && npm ci --no-audit --no-fund ) > "$OUT_DIR/frontend-install.log" 2>&1; then
    record_result "frontend install" "PASS"
  else
    record_result "frontend install" "FAIL"
    FINAL_STATUS=1
    finish
  fi

  log "Frontend: npm run check"
  if ( cd "$ROOT/frontend" && npm run check ) > "$OUT_DIR/frontend-check.log" 2>&1; then
    record_result "frontend check" "PASS"
  else
    record_result "frontend check" "FAIL"
    FINAL_STATUS=1
    finish
  fi
else
  record_result "frontend check" "SKIPPED"
fi

if (( SKIP_BACKEND == 0 )); then
  if ! command -v mvn >/dev/null 2>&1; then
    printf 'error: mvn is required for backend tests (or pass --skip-backend)\n' >&2
    exit 2
  fi
  refresh_java_home
  if ! java -version 2>&1 | grep -q 'version "21'; then
    printf 'error: JDK 21 is required for backend tests (or pass --skip-backend)\n' >&2
    exit 2
  fi

  log "Backend: mvn test (JAVA_HOME=${JAVA_HOME:-inherited})"
  MVN_ARGS=(-B -ntp -Dstyle.color=never)
  if [[ -n "${MAVEN_REPO_LOCAL:-}" ]]; then
    MVN_ARGS+=("-Dmaven.repo.local=$MAVEN_REPO_LOCAL")
  fi
  if ( cd "$ROOT/backend" && mvn "${MVN_ARGS[@]}" test ) > "$OUT_DIR/backend-test.log" 2>&1; then
    record_result "backend test" "PASS"
  else
    record_result "backend test" "FAIL"
    FINAL_STATUS=1
    finish
  fi
else
  record_result "backend test" "SKIPPED"
fi

log "Contract check"
if (( SKIP_FRONTEND == 0 )); then
  if ( cd "$ROOT/frontend" && npm run contract:check ) > "$OUT_DIR/contract-check.log" 2>&1; then
    record_result "contract drift" "PASS"
  else
    record_result "contract drift" "FAIL"
    FINAL_STATUS=1
    finish
  fi
else
  record_result "contract drift" "SKIPPED"
fi

sha256_file "$ROOT/contracts/openapi.yaml" > "$OUT_DIR/contract-sha256.txt"

if command -v python3 >/dev/null 2>&1 && python3 -c 'import yaml' >/dev/null 2>&1; then
  python3 - "$ROOT/contracts/openapi.yaml" > "$OUT_DIR/contract-stats.txt" <<'PY'
import sys

import yaml

with open(sys.argv[1], encoding="utf-8") as handle:
    spec = yaml.safe_load(handle)

paths = spec.get("paths", {})
methods = {"get", "post", "put", "patch", "delete", "head", "options"}
operations = sum(1 for item in paths.values() for key in item if key in methods)
schemas = spec.get("components", {}).get("schemas", {})
print(f"paths={len(paths)} operations={operations} schemas={len(schemas)}")
PY
else
  warn "python3 + PyYAML not available; skipping contract counts"
fi

if (( SKIP_IMAGES == 0 )); then
  if ! command -v docker >/dev/null 2>&1; then
    warn "docker not available; skipping image capture"
    record_result "image capture" "SKIPPED"
  else
    if (( BUILD_IMAGES == 1 )); then
      log "Images: docker compose build (base stack, KRUG_E2EE_ENABLED=false)"
      ENV_FILE=".env"
      if [[ ! -f "$ROOT/deploy/.env" ]]; then
        ENV_FILE=".env.example"
      fi
      if ( cd "$ROOT/deploy" && KRUG_E2EE_ENABLED=false docker compose \
            --env-file "$ENV_FILE" -f docker-compose.yml build backend frontend ) \
          > "$OUT_DIR/images-build.log" 2>&1; then
        record_result "image build" "PASS"
      else
        record_result "image build" "FAIL"
        FINAL_STATUS=1
        finish
      fi
    else
      record_result "image build" "SKIPPED"
    fi

    : > "$OUT_DIR/images.tsv"
    for image in "$BACKEND_IMAGE" "$FRONTEND_IMAGE"; do
      if docker image inspect "$image" >/dev/null 2>&1; then
        id="$(docker image inspect --format '{{.Id}}' "$image")"
        created="$(docker image inspect --format '{{.Created}}' "$image")"
        digests="$(docker image inspect --format '{{join .RepoDigests ","}}' "$image")"
        printf '%s\t%s\t%s\t%s\n' "$image" "$id" "$created" "$digests" >> "$OUT_DIR/images.tsv"
      else
        printf '%s\tmissing\t-\t-\n' "$image" >> "$OUT_DIR/images.tsv"
        warn "image $image not found (run with --build-images to build it)"
      fi
    done
    record_result "image capture" "PASS"
  fi
else
  record_result "image capture" "SKIPPED"
fi

log "Frontend assets"
assets_dir=""
assets_source="unavailable"

if (( ASSETS_FROM_IMAGE == 1 )) && (( SKIP_IMAGES == 0 )) \
  && command -v docker >/dev/null 2>&1 \
  && docker image inspect "$FRONTEND_IMAGE" >/dev/null 2>&1; then
  container_id="$(docker create "$FRONTEND_IMAGE")"
  ASSET_TMP="$(mktemp -d "${TMPDIR:-/tmp}/krug-assets.XXXXXX")"
  if docker cp "$container_id:$ASSETS_ROOT/." "$ASSET_TMP/" >/dev/null 2>&1; then
    assets_dir="$ASSET_TMP"
    assets_source="image:$FRONTEND_IMAGE ($(docker image inspect --format '{{.Id}}' "$FRONTEND_IMAGE"))"
  else
    warn "could not extract $ASSETS_ROOT from $FRONTEND_IMAGE; falling back to frontend/dist"
  fi
  docker rm "$container_id" >/dev/null 2>&1 || true
fi

if [[ -z "$assets_dir" && -d "$ROOT/frontend/dist" ]]; then
  assets_dir="$ROOT/frontend/dist"
  assets_source="dist (local npm run check build)"
fi

if [[ -n "$assets_dir" ]]; then
  : > "$OUT_DIR/assets.txt"
  while IFS= read -r file; do
    printf '%s  %s\n' "$(sha256_file "$file")" "${file#"$assets_dir"/}" \
      >> "$OUT_DIR/assets.txt"
  done < <(find "$assets_dir" -type f \( -name '*.js' -o -name '*.css' -o -name 'index.html' \) | sort)
  printf '%s\n' "$assets_source" > "$OUT_DIR/assets-source.txt"
  record_result "asset hashes" "PASS"
else
  warn "no image assets and no frontend/dist; asset hashes unavailable"
  record_result "asset hashes" "SKIPPED"
fi

if [[ -n "$ASSET_TMP" && -d "$ASSET_TMP" ]]; then
  rm -rf "$ASSET_TMP"
fi

finish

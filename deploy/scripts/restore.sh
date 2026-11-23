#!/usr/bin/env bash
#
# Сова production restore: PostgreSQL (application + Keycloak) and MinIO.
#
# This is destructive: every target table/object is overwritten. The script
# stops the public tier first, verifies the backup checksums, restores the two
# databases and (optionally) mirrors MinIO, then starts the stack again.
#
# Usage:
#   deploy/scripts/restore.sh --backup /srv/backups/krug/krug-backup-...
#
# Options:
#   --backup PATH          backup directory produced by backup.sh (required)
#   --env-file PATH        compose environment file (default: deploy/production/.env.prod)
#   --compose-file PATH    compose file (default: deploy/production/docker-compose.prod.yml)
#   --skip-minio           restore PostgreSQL only
#   --skip-keycloak        restore the application database only
#   --exact-minio          also delete objects that are absent from the backup
#   --yes                  skip the typed confirmation (automation only)
#   -h, --help             show this help
#
# You must type RESTORE to proceed unless --yes is given. Take a fresh backup
# (backup.sh --tag pre-restore) before running this on a live installation.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PROD_DIR="$DEPLOY_DIR/production"

COMPOSE_FILE="${COMPOSE_FILE:-$PROD_DIR/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-$PROD_DIR/.env.prod}"
BACKUP_DIR=""
SKIP_MINIO=0
SKIP_KEYCLOAK=0
EXACT_MINIO=0
ASSUME_YES=0

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

die() {
  log "ERROR: $*"
  exit "${2:-1}"
}

usage() {
  cat <<'EOF'
Сова production restore: PostgreSQL (application + Keycloak) and MinIO.

This is destructive: every target table/object is overwritten. The script
stops the public tier first, verifies the backup checksums, restores the two
databases and (optionally) mirrors MinIO, then starts the stack again.

Usage:
  deploy/scripts/restore.sh --backup /srv/backups/krug/krug-backup-...

Options:
  --backup PATH          backup directory produced by backup.sh (required)
  --env-file PATH        compose environment file (default: deploy/production/.env.prod)
  --compose-file PATH    compose file (default: deploy/production/docker-compose.prod.yml)
  --skip-minio           restore PostgreSQL only
  --skip-keycloak        restore the application database only
  --exact-minio          also delete objects that are absent from the backup
  --yes                  skip the typed confirmation (automation only)
  -h, --help             show this help

You must type RESTORE to proceed unless --yes is given. Take a fresh backup
(backup.sh --tag pre-restore) before running this on a live installation.
EOF
}

on_error() {
  local rc=$?
  log "restore failed (exit $rc). The public tier may still be stopped."
  log "Do not start the stack until the backup and database state are understood."
  exit "$rc"
}
trap on_error ERR

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup)
      BACKUP_DIR="${2:?--backup requires a directory}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:?--env-file requires a path}"
      shift 2
      ;;
    --compose-file)
      COMPOSE_FILE="${2:?--compose-file requires a path}"
      shift 2
      ;;
    --skip-minio)
      SKIP_MINIO=1
      shift
      ;;
    --skip-keycloak)
      SKIP_KEYCLOAK=1
      shift
      ;;
    --exact-minio)
      EXACT_MINIO=1
      shift
      ;;
    --yes)
      ASSUME_YES=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1" 2
      ;;
  esac
done

[[ -n "$BACKUP_DIR" ]] || { usage >&2; die "--backup is required" 2; }
command -v docker >/dev/null 2>&1 || die "docker is not installed" 2
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required" 2
[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE" 2
[[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE" 2

BACKUP_DIR="$(cd -- "$BACKUP_DIR" && pwd)"
[[ -f "$BACKUP_DIR/MANIFEST.txt" ]] || die "not a backup directory (no MANIFEST.txt): $BACKUP_DIR" 2
[[ -f "$BACKUP_DIR/SHA256SUMS" ]] || die "backup has no SHA256SUMS: $BACKUP_DIR" 2

manifest_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$BACKUP_DIR/MANIFEST.txt" | tail -n 1
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

service_running() {
  compose ps --status running --services 2>/dev/null | grep -qx -- "$1"
}

log "verifying backup checksums"
if command -v sha256sum >/dev/null 2>&1; then
  ( cd -- "$BACKUP_DIR" && sha256sum -c SHA256SUMS )
else
  ( cd -- "$BACKUP_DIR" && shasum -a 256 -c SHA256SUMS )
fi

MANIFEST_APP="$BACKUP_DIR/app.dump"
[[ -s "$MANIFEST_APP" ]] || die "app.dump is missing or empty" 2

MANIFEST_KEYCLOAK="$(manifest_value keycloak_database || true)"
MANIFEST_BUCKET="$(manifest_value s3_bucket || true)"
if [[ "$SKIP_KEYCLOAK" -eq 0 && "$MANIFEST_KEYCLOAK" == "skipped" ]]; then
  log "Keycloak was skipped in this backup; skipping it on restore too"
  SKIP_KEYCLOAK=1
fi
if [[ "$SKIP_MINIO" -eq 0 && "$MANIFEST_BUCKET" == "skipped" ]]; then
  log "MinIO was skipped in this backup; skipping it on restore too"
  SKIP_MINIO=1
fi
if [[ "$SKIP_KEYCLOAK" -eq 0 ]]; then
  [[ -s "$BACKUP_DIR/keycloak.dump" ]] || die "keycloak.dump is missing or empty" 2
fi
if [[ "$SKIP_MINIO" -eq 0 ]]; then
  [[ -d "$BACKUP_DIR/minio" ]] || die "minio/ directory is missing" 2
  MANIFEST_BUCKET="${MANIFEST_BUCKET:-krug}"
fi

log "backup: $BACKUP_DIR"
log "created: $(manifest_value created_at_utc || true)"
log "app database: krug"
log "keycloak database: $([[ "$SKIP_KEYCLOAK" -eq 1 ]] && echo skipped || echo "${MANIFEST_KEYCLOAK:-keycloak}")"
log "minio bucket: $([[ "$SKIP_MINIO" -eq 1 ]] && echo skipped || echo "$MANIFEST_BUCKET")"

if [[ "$ASSUME_YES" -eq 0 ]]; then
  if [[ ! -t 0 ]]; then
    die "refusing to restore without a TTY; pass --yes only in an approved automation path" 2
  fi
  printf '\n'
  printf 'This will overwrite the CURRENT production data with the backup above.\n'
  printf 'There is no automatic undo. Type RESTORE to continue: '
  read -r answer
  [[ "$answer" == "RESTORE" ]] || die "restore cancelled" 2
else
  log "WARNING: --yes supplied; typed confirmation skipped"
fi

service_running postgres || die "postgres is not running" 2
if [[ "$SKIP_KEYCLOAK" -eq 0 ]]; then
  service_running keycloak-postgres || die "keycloak-postgres is not running" 2
fi
if [[ "$SKIP_MINIO" -eq 0 ]]; then
  service_running minio || die "minio is not running" 2
fi

log "stopping public tier and Keycloak"
compose stop caddy frontend backend keycloak >/dev/null 2>&1 || true
if service_running backend; then
  die "backend is still running; refusing to restore a live database" 2
fi
if [[ "$SKIP_KEYCLOAK" -eq 0 ]] && service_running keycloak; then
  die "keycloak is still running; refusing to restore a live Keycloak database" 2
fi

restore_database() {
  local service="$1"
  local label="$2"
  local file="$3"

  log "restoring $label from $file"
  if ! compose exec -T "$service" sh -ec '
      PGPASSWORD="$POSTGRES_PASSWORD" pg_restore \
        --host=127.0.0.1 \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB" \
        --clean \
        --if-exists \
        --no-owner \
        --exit-on-error \
        --single-transaction
    ' <"$file"; then
    die "pg_restore failed for $label"
  fi
  log "ok: $label"
}

restore_database postgres app "$BACKUP_DIR/app.dump"
if [[ "$SKIP_KEYCLOAK" -eq 0 ]]; then
  restore_database keycloak-postgres keycloak "$BACKUP_DIR/keycloak.dump"
else
  log "skipping Keycloak database"
fi

if [[ "$SKIP_MINIO" -eq 0 ]]; then
  log "restoring MinIO bucket '$MANIFEST_BUCKET'"
  if [[ "$EXACT_MINIO" -eq 1 ]]; then
    log "WARNING: --exact-minio will delete objects absent from the backup"
    if ! compose --profile ops run --rm --no-deps -T \
        --user "$(id -u):$(id -g)" \
        -e HOME=/tmp -e MC_CONFIG_DIR=/tmp/.mc \
        -v "$BACKUP_DIR/minio:/backup:ro" \
        minio-backup mirror --overwrite --remove \
        "/backup/$MANIFEST_BUCKET" "local/$MANIFEST_BUCKET"; then
      die "mc mirror restore failed"
    fi
  else
    if ! compose --profile ops run --rm --no-deps -T \
        --user "$(id -u):$(id -g)" \
        -e HOME=/tmp -e MC_CONFIG_DIR=/tmp/.mc \
        -v "$BACKUP_DIR/minio:/backup:ro" \
        minio-backup mirror --overwrite \
        "/backup/$MANIFEST_BUCKET" "local/$MANIFEST_BUCKET"; then
      die "mc mirror restore failed"
    fi
  fi
  log "ok: MinIO"
else
  log "skipping MinIO"
fi

log "starting the stack; waiting for the backend health endpoint"
compose up -d
healthy=0
for _ in $(seq 1 60); do
  if compose exec -T backend curl -fsS http://127.0.0.1:8081/api/v1/health >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 5
done
[[ "$healthy" -eq 1 ]] || die "backend did not become healthy within 5 minutes" 1
log "restore complete; backend is healthy"

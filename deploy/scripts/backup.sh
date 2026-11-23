#!/usr/bin/env bash
#
# Сова production backup: PostgreSQL (custom format) + Keycloak PostgreSQL +
# MinIO objects, with checksums, a manifest and age-based retention.
#
# It never talks to the database or MinIO over a published host port: every
# command runs inside the compose network, so the production stack can keep
# PostgreSQL/Keycloak/MinIO internal-only.
#
# Usage:
#   deploy/scripts/backup.sh [options]
#
# Options:
#   --env-file PATH        compose environment file (default: deploy/production/.env.prod)
#   --compose-file PATH    compose file (default: deploy/production/docker-compose.prod.yml)
#   --out-dir PATH         backup root (default: KRUG_BACKUP_DIR or deploy/backups)
#   --retention-days N     delete matching backups older than N days (default: 30)
#   --tag NAME             suffix the backup directory, e.g. pre-upgrade
#   --skip-minio           skip the MinIO mirror (PostgreSQL only)
#   --skip-keycloak        skip the Keycloak database
#   --no-retention         do not delete old backups
#   -h, --help             show this help
#
# Exit codes: 0 success, 2 usage/configuration error, 1 backup failure.
#
# The backup directory is created with mode 0700; dumps and metadata are 0600.
# It contains user data and DB password hashes: encrypt it at rest and copy it
# off-host. The .env.prod file is deliberately NOT included; keep
# the content-encryption key in a secret manager (see docs/PRODUCTION-RUNBOOK.md).

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd -- "$DEPLOY_DIR/.." && pwd)"
PROD_DIR="$DEPLOY_DIR/production"

COMPOSE_FILE="${COMPOSE_FILE:-$PROD_DIR/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-$PROD_DIR/.env.prod}"
BACKUP_ROOT="${KRUG_BACKUP_DIR:-$DEPLOY_DIR/backups}"
RETENTION_DAYS="${KRUG_BACKUP_RETENTION_DAYS:-30}"
TAG=""
SKIP_MINIO=0
SKIP_KEYCLOAK=0
NO_RETENTION=0
OUT_DIR_SET=0
RETENTION_SET=0

WORK_DIR=""
DEST_DIR=""

usage() {
  cat <<'EOF'
Сова production backup: PostgreSQL (custom format) + Keycloak PostgreSQL +
MinIO objects, with checksums, a manifest and age-based retention.

Usage:
  deploy/scripts/backup.sh [options]

Options:
  --env-file PATH        compose environment file (default: deploy/production/.env.prod)
  --compose-file PATH    compose file (default: deploy/production/docker-compose.prod.yml)
  --out-dir PATH         backup root (default: KRUG_BACKUP_DIR or deploy/backups)
  --retention-days N     delete matching backups older than N days (default: 30)
  --tag NAME             suffix the backup directory, e.g. pre-upgrade
  --skip-minio           skip the MinIO mirror (PostgreSQL only)
  --skip-keycloak        skip the Keycloak database
  --no-retention         do not delete old backups
  -h, --help             show this help

Exit codes: 0 success, 2 usage/configuration error, 1 backup failure.

The backup directory is created with mode 0700; dumps and metadata are 0600.
It contains user data and DB password hashes: encrypt it at rest and copy it
off-host. The .env.prod file is deliberately NOT included; keep the
content-encryption key in a secret manager (see docs/PRODUCTION-RUNBOOK.md).
EOF
}

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

die() {
  log "ERROR: $*"
  exit "${2:-1}"
}

cleanup() {
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -rf -- "$WORK_DIR" || true
  fi
}

on_error() {
  local rc=$?
  log "backup failed (exit $rc); removing incomplete work directory"
  exit "$rc"
}
trap on_error ERR
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:?--env-file requires a path}"
      shift 2
      ;;
    --compose-file)
      COMPOSE_FILE="${2:?--compose-file requires a path}"
      shift 2
      ;;
    --out-dir)
      BACKUP_ROOT="${2:?--out-dir requires a path}"
      OUT_DIR_SET=1
      shift 2
      ;;
    --retention-days)
      RETENTION_DAYS="${2:?--retention-days requires a number}"
      RETENTION_SET=1
      shift 2
      ;;
    --tag)
      TAG="${2:?--tag requires a name}"
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
    --no-retention)
      NO_RETENTION=1
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

command -v docker >/dev/null 2>&1 || die "docker is not installed" 2
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required" 2
[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE" 2
[[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE (copy .env.prod.example)" 2

# Read a simple KEY=VALUE default from the env file without sourcing it (a
# compromised env file must not execute arbitrary shell code in the backup job).
env_file_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 1
  sed -n "s/^[[:space:]]*${key}=//p" "$ENV_FILE" | tail -n 1 \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

if [[ "$OUT_DIR_SET" -eq 0 && -z "${KRUG_BACKUP_DIR:-}" ]]; then
  value="$(env_file_value KRUG_BACKUP_DIR || true)"
  if [[ -n "$value" ]]; then
    BACKUP_ROOT="$value"
  fi
fi
if [[ "$RETENTION_SET" -eq 0 && -z "${KRUG_BACKUP_RETENTION_DAYS:-}" ]]; then
  value="$(env_file_value KRUG_BACKUP_RETENTION_DAYS || true)"
  if [[ -n "$value" ]]; then
    RETENTION_DAYS="$value"
  fi
fi

[[ -n "$BACKUP_ROOT" ]] || die "backup root is empty" 2
[[ "$BACKUP_ROOT" != "/" ]] || die "refusing to use / as the backup root" 2
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || die "retention-days must be a non-negative integer" 2
[[ "$RETENTION_DAYS" -ge 1 ]] || die "retention-days must be at least 1" 2
[[ -z "$TAG" || "$TAG" =~ ^[A-Za-z0-9._-]+$ ]] || die "tag may contain only letters, digits, dot, underscore and dash" 2

mkdir -p -- "$BACKUP_ROOT"
BACKUP_ROOT="$(cd -- "$BACKUP_ROOT" && pwd)"
[[ "$BACKUP_ROOT" != "/" ]] || die "refusing to use / as the backup root" 2

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

service_running() {
  compose ps --status running --services 2>/dev/null | grep -qx -- "$1"
}

for service in postgres keycloak-postgres minio; do
  if [[ "$service" == "keycloak-postgres" && "$SKIP_KEYCLOAK" -eq 1 ]]; then
    continue
  fi
  if [[ "$service" == "minio" && "$SKIP_MINIO" -eq 1 ]]; then
    continue
  fi
  service_running "$service" || die "service '$service' is not running; start the production stack first" 2
done

BUCKET="${S3_BUCKET:-}"
if [[ -z "$BUCKET" ]]; then
  BUCKET="$(env_file_value S3_BUCKET || true)"
fi
BUCKET="${BUCKET:-krug}"
[[ "$BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] \
  || die "invalid S3 bucket name: $BUCKET" 2

TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
NAME="krug-backup-$TIMESTAMP"
if [[ -n "$TAG" ]]; then
  NAME="$NAME-$TAG"
fi
DEST_DIR="$BACKUP_ROOT/$NAME"
WORK_DIR="$BACKUP_ROOT/.$NAME.partial"
[[ ! -e "$DEST_DIR" ]] || die "backup directory already exists: $DEST_DIR" 2
mkdir -m 700 -- "$WORK_DIR"

log "backup started: $NAME"
log "backup root: $BACKUP_ROOT"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

dump_database() {
  local service="$1"
  local label="$2"
  local output="$3"
  local partial="$output.partial"
  local logfile="$WORK_DIR/${label}.pg_dump.log"

  log "dumping $label database from $service"
  if ! compose exec -T "$service" sh -ec '
      PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
        --host=127.0.0.1 \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB" \
        --format=custom \
        --compress=9 \
        --no-owner \
        --verbose
    ' >"$partial" 2>"$logfile"; then
    die "pg_dump failed for $label (see $logfile)"
  fi
  [[ -s "$partial" ]] || die "pg_dump produced an empty dump for $label"

  log "verifying $label dump"
  compose exec -T "$service" pg_restore --list <"$partial" >/dev/null \
    || die "pg_restore --list rejected the $label dump"

  mv -- "$partial" "$output"
  log "ok: $label ($(du -h "$output" | awk '{print $1}'))"
}

dump_database postgres app "$WORK_DIR/app.dump"
if [[ "$SKIP_KEYCLOAK" -eq 0 ]]; then
  dump_database keycloak-postgres keycloak "$WORK_DIR/keycloak.dump"
else
  log "skipping Keycloak database (--skip-keycloak)"
fi

if [[ "$SKIP_MINIO" -eq 0 ]]; then
  log "mirroring MinIO bucket '$BUCKET'"
  mkdir -m 700 -- "$WORK_DIR/minio"
  # The Chainguard mc image runs as uid 65532; run it as the invoking user so
  # the backup files stay readable by the operator. HOME/MC_CONFIG_DIR are
  # writable because an arbitrary uid has no passwd entry.
  if ! compose --profile ops run --rm --no-deps -T \
      --user "$(id -u):$(id -g)" \
      -e HOME=/tmp -e MC_CONFIG_DIR=/tmp/.mc \
      -v "$WORK_DIR/minio:/backup" \
      minio-backup mirror --overwrite --preserve \
      "local/$BUCKET" "/backup/$BUCKET" \
      >"$WORK_DIR/minio.log" 2>&1; then
    die "mc mirror failed (see $WORK_DIR/minio.log)"
  fi
  log "ok: MinIO mirror"
else
  log "skipping MinIO (--skip-minio)"
fi

{
  printf 'backup_name=%s\n' "$NAME"
  printf 'created_at_utc=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'hostname=%s\n' "$(hostname 2>/dev/null || echo unknown)"
  printf 'git_commit=%s\n' "$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  printf 'compose_file=%s\n' "$COMPOSE_FILE"
  printf 'app_database=krug\n'
  if [[ "$SKIP_KEYCLOAK" -eq 0 ]]; then
    printf 'keycloak_database=%s\n' "$(env_file_value KC_DB_NAME || true)"
  else
    printf 'keycloak_database=skipped\n'
  fi
  if [[ "$SKIP_MINIO" -eq 0 ]]; then
    printf 's3_bucket=%s\n' "$BUCKET"
  else
    printf 's3_bucket=skipped\n'
  fi
  printf 'retention_days=%s\n' "$RETENTION_DAYS"
  printf 'format=pg_dump-custom+mc-mirror\n'
} >"$WORK_DIR/MANIFEST.txt"

log "writing SHA256SUMS"
(
  cd -- "$WORK_DIR"
  while IFS= read -r -d '' file; do
    sha256 "$file"
  done < <(find . -type f ! -name 'SHA256SUMS' -print0 | sort -z)
) >"$WORK_DIR/SHA256SUMS"

chmod 600 "$WORK_DIR"/*.dump "$WORK_DIR"/MANIFEST.txt "$WORK_DIR"/SHA256SUMS 2>/dev/null || true
mv -- "$WORK_DIR" "$DEST_DIR"
WORK_DIR=""
log "backup complete: $DEST_DIR ($(du -sh "$DEST_DIR" | awk '{print $1}'))"

if [[ "$NO_RETENTION" -eq 0 ]]; then
  log "applying retention: ${RETENTION_DAYS} days"
  while IFS= read -r -d '' old; do
    log "removing old backup: $old"
    rm -rf -- "$old"
  done < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d \
    -name 'krug-backup-*' -mtime +"$RETENTION_DAYS" -print0)
fi

log "done"

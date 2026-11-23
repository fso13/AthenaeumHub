#!/usr/bin/env bash
#
# Pre-flight checks for the production environment file. It does not start
# anything and never prints secret values.
#
# Usage:
#   deploy/scripts/preflight.sh [--env-file PATH] [--compose-file PATH] [--strict]
#
# --strict also fails on noop AV, a non-587 SMTP port and a non-standard
# runtime Keycloak client. Warnings are printed as WARN; errors exit 1.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PROD_DIR="$DEPLOY_DIR/production"

ENV_FILE="${ENV_FILE:-$PROD_DIR/.env.prod}"
COMPOSE_FILE="${COMPOSE_FILE:-$PROD_DIR/docker-compose.prod.yml}"
STRICT=0
ERRORS=0
WARNINGS=0

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
    --strict)
      STRICT=1
      shift
      ;;
    -h|--help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

fail() { printf 'FAIL  %s\n' "$*" >&2; ERRORS=$((ERRORS + 1)); }
warn() { printf 'WARN  %s\n' "$*" >&2; WARNINGS=$((WARNINGS + 1)); }
ok() { printf 'ok    %s\n' "$*"; }

[[ -f "$ENV_FILE" ]] || { printf 'FAIL  env file not found: %s\n' "$ENV_FILE" >&2; exit 1; }
[[ -f "$COMPOSE_FILE" ]] || { printf 'FAIL  compose file not found: %s\n' "$COMPOSE_FILE" >&2; exit 1; }

value() {
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | tail -n 1 \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

require() {
  local key="$1"
  if [[ -z "$(value "$key")" ]]; then
    fail "$key is empty"
  else
    ok "$key is set"
  fi
}

placeholder() {
  local key="$1"
  local val
  val="$(value "$key")"
  if [[ "$val" =~ (change-me|CHANGE_ME|CHANGEME|example\.com|__.*__) ]]; then
    fail "$key still contains a placeholder"
  fi
}

min_length() {
  local key="$1" length="$2"
  local val
  val="$(value "$key")"
  if [[ -n "$val" && "${#val}" -lt "$length" ]]; then
    fail "$key is shorter than $length characters"
  fi
}

# The file is a secrets file; refuse group/world-readable modes.
perm="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || true)"
case "$perm" in
  400|600) ok "env file permissions $perm" ;;
  '') warn "could not determine env file permissions" ;;
  *) fail "env file permissions are $perm; use chmod 600" ;;
esac

required=(
  DOMAIN
  FILES_DOMAIN
  ACME_EMAIL
  KRUG_DB_PASSWORD
  KRUG_APP_PASSWORD
  KRUG_AUTH_JWT_SECRET
  KRUG_CONTENT_KEY
  KRUG_AUTH_BFF_EMAIL_SECRET_KEY
  KC_DB_PASSWORD
  KC_BOOTSTRAP_ADMIN_PASSWORD
  KC_ADMIN_USER
  KC_ADMIN_PASSWORD
  KC_ADMIN_EMAIL
  SPRING_MAIL_HOST
  SPRING_MAIL_USERNAME
  SPRING_MAIL_PASSWORD
  KRUG_MAIL_FROM
  S3_ACCESS_KEY
  S3_SECRET_KEY
)
for key in "${required[@]}"; do
  require "$key"
done

for key in "${required[@]}"; do
  placeholder "$key"
done

min_length KRUG_AUTH_JWT_SECRET 32
min_length KRUG_CONTENT_KEY 32
min_length KRUG_AUTH_BFF_EMAIL_SECRET_KEY 32
min_length KRUG_DB_PASSWORD 16
min_length KRUG_APP_PASSWORD 16
min_length KC_DB_PASSWORD 16
min_length KC_ADMIN_PASSWORD 16
min_length KC_BOOTSTRAP_ADMIN_PASSWORD 16
min_length S3_SECRET_KEY 16
min_length S3_ACCESS_KEY 8

domain="$(value DOMAIN)"
files_domain="$(value FILES_DOMAIN)"
if [[ "$domain" == http://* || "$domain" == https://* ]]; then
  fail "DOMAIN must be a bare host name, not a URL"
fi
if [[ "$files_domain" == "$domain" ]]; then
  fail "FILES_DOMAIN must differ from DOMAIN"
fi
if [[ "$domain" == *.example.com || "$domain" == example.com ]]; then
  warn "DOMAIN looks like a documentation placeholder"
fi
if [[ "$(value ACME_EMAIL)" != *@*.* ]]; then
  fail "ACME_EMAIL is not a valid address"
fi
if [[ "$(value KRUG_MAIL_FROM)" != *@*.* ]]; then
  fail "KRUG_MAIL_FROM is not a valid address"
fi

if [[ "$(value KRUG_E2EE_ENABLED)" != "false" ]]; then
  fail "KRUG_E2EE_ENABLED must stay false until the E2EE release gate is closed"
else
  ok "KRUG_E2EE_ENABLED=false"
fi

if [[ "$(value KRUG_KEYCLOAK_ADMIN_REALM)" == "master" ]]; then
  fail "runtime Keycloak admin realm must not be master"
fi
if [[ "$(value KC_ADMIN_CLIENT_ID)" == "admin-cli" ]]; then
  fail "runtime Keycloak client must not be master-realm admin-cli"
fi
if [[ "$(value KC_ADMIN_USER)" == "admin" ]]; then
  warn "KC_ADMIN_USER is the bootstrap admin; use svc-krug-bff for runtime"
fi
if [[ "$(value SPRING_PROFILES_ACTIVE)" != *prod* ]]; then
  warn "SPRING_PROFILES_ACTIVE does not include prod"
fi

smtp_port="$(value SPRING_MAIL_PORT)"
if [[ "$smtp_port" =~ ^[0-9]+$ ]]; then
  if [[ "$smtp_port" == "465" ]]; then
    if [[ "$STRICT" -eq 1 ]]; then
      fail "SMTP 465 implicit TLS is not supported by the current mail config (use 587 STARTTLS)"
    else
      warn "SMTP 465: current config supports STARTTLS only; use 587 or follow F-102-C"
    fi
  elif [[ "$smtp_port" != "587" ]]; then
    if [[ "$STRICT" -eq 1 ]]; then
      fail "SMTP port is $smtp_port; 587 + STARTTLS is the tested production path"
    else
      warn "SMTP port is $smtp_port; 587 + STARTTLS is the tested production path"
    fi
  fi
else
  fail "SPRING_MAIL_PORT is not numeric"
fi
if [[ "$(value SPRING_MAIL_SMTP_STARTTLS)" != "true" ]]; then
  warn "SPRING_MAIL_SMTP_STARTTLS is not true"
fi

scan_mode="$(value S3_SCAN_MODE)"
if [[ "$scan_mode" == "noop" ]]; then
  if [[ "$STRICT" -eq 1 ]]; then
    fail "S3_SCAN_MODE=noop is a production launch blocker; enable the scan profile"
  else
    warn "S3_SCAN_MODE=noop; enable ClamAV before go-live"
  fi
elif [[ "$scan_mode" != "clamav" ]]; then
  fail "S3_SCAN_MODE must be noop or clamav"
fi

if command -v docker >/dev/null 2>&1; then
  if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --quiet >/dev/null 2>&1; then
    ok "docker compose config"
  else
    fail "docker compose config failed"
  fi
else
  warn "docker not found; skipped compose validation"
fi

printf '\n%d error(s), %d warning(s)\n' "$ERRORS" "$WARNINGS" >&2
if [[ "$ERRORS" -gt 0 ]]; then
  printf 'Pre-flight failed; do not deploy.\n' >&2
  exit 1
fi
printf 'Pre-flight passed.\n'

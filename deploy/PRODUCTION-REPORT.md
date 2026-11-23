# Issue #102 — production ops report

> Дата: 2026-11-23 · Роль: DevOps (Sova) · Ветка: `main` (рабочее дерево,
> без commit/push). Изменялись только deploy/docs/scripts; backend-код не
> редактировался.

## Итог

**DONE** для объёма #102: production compose с Caddy/TLS, internal-only
сервисами, `.env.prod.example`, production realm без demo-пользователей,
backup/restore с проверкой контрольных сумм и подтверждением, preflight и
полный runbook. Все запрошенные артефакты созданы и статически проверены.

Production go-live остаётся условным: перед реальным запуском нужно закрыть
пункты из §5 (как минимум `S3_SCAN_MODE=clamav`, закрепить digest образов,
провести restore drill). Это не блокирует #102, но блокирует production.

## 1. Что добавлено

| Файл | Назначение |
|---|---|
| [`deploy/production/docker-compose.prod.yml`](production/docker-compose.prod.yml) | Caddy edge, internal-only БД/Keycloak/MinIO, healthchecks, restart, volumes, логи |
| [`deploy/production/Caddyfile`](production/Caddyfile) | ACME TLS для `DOMAIN` и `FILES_DOMAIN`, HSTS/заголовки, reverse proxy, read-only presigned GET |
| [`deploy/production/.env.prod.example`](production/.env.prod.example) | Все env-переменные, плейсхолдеры секретов, SMTP, Keycloak, backup |
| [`deploy/production/realm-export.prod.json`](production/realm-export.prod.json) | Realm `krug` без demo-пользователей, `sslRequired=external`, brute-force/password policy |
| [`deploy/scripts/preflight.sh`](scripts/preflight.sh) | Проверка `.env.prod`: плейсхолдеры, длины, E2EE, Keycloak realm/client, compose config |
| [`deploy/scripts/backup.sh`](scripts/backup.sh) | `pg_dump --format=custom` ×2, `mc mirror`, manifest, SHA-256, retention |
| [`deploy/scripts/restore.sh`](scripts/restore.sh) | Проверка checksums, typed `RESTORE`, `pg_restore --clean`, MinIO restore, health-wait |
| [`deploy/scripts/README.md`](scripts/README.md) | Backup/restore runbook, cron/systemd, encryption, DR drill |
| [`docs/PRODUCTION-RUNBOOK.md`](../docs/PRODUCTION-RUNBOOK.md) | Deploy/upgrade/migrations/rollback, TLS, SMTP, Keycloak, HttpOnly plan, backups, rotation |
| [`deploy/README.md`](README.md) | Ссылка на production-стек; dev-инструкции не изменены |
| `.gitignore` | Исключение для `.env.prod.example`, игнор `deploy/backups/` |
| `scripts/validate-yaml.py` | Валидация `deploy/production/*.yml` |
| `.github/workflows/ci.yml` | ShellCheck теперь покрывает `deploy/scripts/*.sh` |

Существующий [`deploy/docker-compose.yml`](docker-compose.yml) не менялся.

## 2. Архитектурные решения

- **Единственная published-точка — Caddy** (`80/443/443udp`). `postgres`,
  `keycloak-postgres`, `keycloak`, `minio`, `backend` не имеют host-port
  mappings. `docker compose config` подтверждает это для default и
  `ops`/`scan` profiles.
- **Две сети:** `edge` (Caddy ↔ frontend/minio, egress для backend SMTP) и
  `internal: true` (backend ↔ postgres/keycloak/minio). Keycloak и обе
  PostgreSQL доступны только изнутри.
- **`FILES_DOMAIN`:** presigned URL подписывается на публичный host, поэтому
  MinIO не публикуется напрямую, но получает отдельный TLS-host через Caddy.
  Caddy сохраняет `Host` (SigV4) и разрешает только `GET/HEAD/OPTIONS`.
- **Production realm:** отдельный `realm-export.prod.json` без
  `test@krug.local/Test1234!`, с `sslRequired=external` и
  `registrationAllowed=false`. Импорт одноразовый; изменения realm после
  первого старта в файл не подхватываются.
- **`SPRING_PROFILES_ACTIVE=keycloak,prod`:** `prod` включает строгий
  `ProdGuard` и убирает dev-эндпоинты; `keycloak` даёт OIDC/BFF defaults.
- **SMTP:** реальный relay через `SPRING_MAIL_*`; runtime-настройки админки
  имеют приоритет. Поддержан 587/STARTTLS.
- **Keycloak runtime:** backend использует `realm=krug`,
  `client_id=krug-web` и технического пользователя `svc-krug-bff` с ролями
  `manage-users/view-users/query-users`. Master realm и `admin-cli` в runtime
  не используются. Это не client-credentials service account — см. F-102-A.
- **Секреты:** только в `.env.prod` (gitignored); compose использует `:?` и
  падает при отсутствии обязательной переменной. В образы/репозиторий секреты
  не попадают.

## 3. Проверки (выполнены локально)

| Проверка | Команда | Результат |
|---|---|---|
| YAML parse | `python3 scripts/validate-yaml.py` | 12/12 файлов, включая production compose |
| Compose default | `docker compose --env-file deploy/production/.env.prod.example -f ... config --quiet` | OK |
| Compose `ops`+`scan` | то же с `--profile ops --profile scan` | OK |
| Compose dev | `docker compose --env-file deploy/.env.example -f deploy/docker-compose.yml config --quiet` | OK (не нарушен) |
| Caddyfile | `caddy validate` в `caddy:2.8-alpine` с env | `Valid configuration` |
| Caddy health | запуск контейнера с production Caddyfile, `wget http://127.0.0.1:2019/config/` | OK |
| Realm JSON | `python3 -m json.tool` | OK |
| Realm import | disposable `keycloak:26.2 start-dev --import-realm` с отрендеренным prod realm | `Realm 'krug' imported` |
| Shell syntax | `bash -n deploy/scripts/*.sh` | OK |
| ShellCheck | `shellcheck --severity=warning deploy/scripts/*.sh` | 0 замечаний |
| Preflight | временный `.env` с сгенерированными значениями | `Pre-flight passed` (1 ожидаемый WARN: `S3_SCAN_MODE=noop`) |
| Preflight `--strict` | тот же `.env`, `S3_SCAN_MODE=clamav`, SMTP 587 | `Pre-flight passed` (0 warnings) |
| `pg_dump` flags | disposable `postgres:16-alpine`: custom + compress=9 + `pg_restore --list` | OK |
| `pg_restore` flags | тот же стенд: `--clean --if-exists --no-owner --exit-on-error --single-transaction` | OK, строка восстановлена |
| `mc mirror` path | disposable MinIO + `--user $(id -u):$(id -g)`, `HOME=/tmp`, `MC_CONFIG_DIR=/tmp/.mc` | OK, объект скопирован |
| Git ignore | `git check-ignore` | `.env.prod` ignored, `.env.prod.example` not ignored, `deploy/backups/` ignored |

`docker compose up`, реальный deploy, ACME-выпуск, SMTP-отправка и
backup/restore **не запускались** — нет production-хоста и реальных данных.
Disposable self-tests удалены; destructive-команд над рабочими данными не
выполнялось. Контрольные суммы/секреты в отчёт не выводились.

## 4. Что важно знать перед запуском

1. DNS `DOMAIN` и `FILES_DOMAIN` → хост; 80/443 открыты; `FILES_DOMAIN ≠
   DOMAIN`.
2. `cp .env.prod.example .env.prod`, `chmod 600`, заменить все `CHANGE_ME`/`change-me`.
   `KRUG_CONTENT_KEY` сохранить в secret manager **до** первого запуска.
3. `./deploy/scripts/preflight.sh` должен пройти. Перед go-live — повторно с
   `--strict`: `S3_SCAN_MODE=noop` при `--strict` намеренно валит проверку.
4. Сначала поднять `postgres/keycloak/minio`, создать `svc-krug-bff`, затем
   остальной стек — иначе backend обращается к несуществующему admin-пользователю.
5. Проверить TLS, вход, скачивание файла, SMTP-тест и снять первый бэкап.
6. Включить `--profile scan` и `S3_SCAN_MODE=clamav`, либо письменно принять
   риск (launch blocker).

## 5. Риски, ограничения и follow-up

| ID | Severity | Тема | Статус / действие |
|---|---|---|---|
| F-102-A | medium | Backend `KeycloakHttp` умеет только password grant; настоящий service account (`client_credentials`) не реализован | Код-фикс + конфиг клиента описаны в runbook §4.2; до этого используется least-privilege технический пользователь, master/admin-cli в runtime нет |
| F-102-B | high (XSS) | Токены BFF отдаются в JSON и лежат в `sessionStorage`; HttpOnly cookies не реализованы | План в runbook §10; требует backend+frontend+contract. В #102 не код |
| F-102-C | low | Нет `mail.smtp.ssl.enable` для implicit TLS 465 | Использовать 587/STARTTLS; follow-up |
| — | launch blocker | `S3_SCAN_MODE=noop` по умолчанию (AV выключен) | Включить `scan` profile + `clamav`; проверено, что профиль валиден |
| — | hardening | `chainguard/minio:latest`, `clamav/clamav:stable`, `postgres:16-alpine` не pin по digest | Зафиксировать digest перед go-live |
| — | ограничение | Single-node backend/Keycloak; WS hub/rate limiter/outbox/retention in-process | HA — отдельная задача (Redis/Kafka/внешний scheduler) |
| — | ограничение | RPO = интервал backup (по умолчанию 24 ч); WAL-архива нет | Для меньшего RPO — отдельная задача |
| — | ограничение | Caddy access-логи выключены из-за ticket/token в query string | Включать только с redaction |
| — | note | `KC_HOSTNAME_STRICT=false` | Keycloak без published port; healthcheck ходит на loopback. Компенсируется сетевой изоляцией |
| — | note | `kcadm` provisioning использует bootstrap master admin | Только one-time/break-glass; runtime — realm `krug`, не master |

## 6. Откат изменений #102

Все изменения — новые файлы + четыре точечные правки (`.gitignore`,
`scripts/validate-yaml.py`, `deploy/README.md`, CI). Backend/frontend не
затронуты. Для отката достаточно удалить новые файлы и вернуть эти правки;
существующий dev compose и его volumes не менялись.

## 7. Статус

**DONE** — production ops артефакты #102 созданы, синтаксис и конфигурация
проверены. Production-ready **с условиями**: закрыть launch blockers из §5
перед реальным трафиком.

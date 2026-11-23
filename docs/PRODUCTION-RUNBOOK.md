# Сова — production runbook

> Статус: **production ops, issue #102**. Документ описывает single-host
> production stack в [`deploy/production/`](../deploy/production/). Backend-код
> в рамках #102 не менялся; всё, что требует изменений кода, помечено как
> follow-up и не считается закрытым.
>
> Связанные файлы: [`deploy/production/docker-compose.prod.yml`](../deploy/production/docker-compose.prod.yml),
> [`deploy/production/Caddyfile`](../deploy/production/Caddyfile),
> [`deploy/production/.env.prod.example`](../deploy/production/.env.prod.example),
> [`deploy/scripts/README.md`](../deploy/scripts/README.md).

## 1. Что развёрнуто

| Компонент | Образ | Порт на хосте | Сеть | Назначение |
|---|---|---|---|---|
| `caddy` | `caddy:2.8-alpine` | `80`, `443`, `443/udp` | `edge` | TLS, ACME, HSTS, reverse proxy |
| `frontend` | build `frontend/Dockerfile` | — | `edge` | nginx + SPA, `/api`, `/ws` |
| `backend` | build `backend/Dockerfile` | — | `edge`, `internal` | Spring Boot, BFF, Flyway |
| `postgres` | `postgres:16-alpine` | — | `internal` | БД приложения `krug` |
| `keycloak-postgres` | `postgres:16-alpine` | — | `internal` | БД Keycloak |
| `keycloak` | `quay.io/keycloak/keycloak:26.2` | — | `internal` | OIDC, realm `krug` |
| `minio` | `chainguard/minio:latest` | — | `edge`, `internal` | S3-объекты |
| `minio-backup` | `chainguard/minio-client:latest` | — | `internal` | one-off `mc` для backup/restore |
| `clamav` | `clamav/clamav:stable` | — | `internal` | опционально, profile `scan` |

Наружу опубликован только Caddy. `postgres`, `keycloak`, `minio` и `backend`
не имеют host-port mapping. `FILES_DOMAIN` — единственный публичный путь к
MinIO, и только для presigned `GET`/`HEAD`; загрузки идут через backend API.

Потоки:

```
browser ──443──> caddy ──> frontend (nginx) ──> backend ──> postgres
                                  │                 ├────> keycloak ──> keycloak-postgres
                                  └── /ws ──────────┘      └────> minio (internal S3)
browser ──443──> caddy (FILES_DOMAIN) ──> minio:9000   # presigned GET only
backend ──SMTP 587/TLS──> external relay
```

### Volumes

| Volume | Данные | Бэкап |
|---|---|---|
| `krug-prod-pgdata` | приложение | `backup.sh` (`app.dump`) |
| `krug-prod-keycloak-pgdata` | realm/users/clients | `backup.sh` (`keycloak.dump`) |
| `krug-prod-minio-data` | файлы, аватары, стикеры | `backup.sh` (`mc mirror`) |
| `krug-prod-caddy-data` | ACME-аккаунт и сертификаты | не обязателен, Caddy перевыпустит; при потере — новый ACME |
| `krug-prod-caddy-config` | runtime config Caddy | не критичен |
| `krug-prod-clamav-data` | сигнатуры ClamAV | не критичен, скачивается заново |
| `krug-prod-keycloak-import` | отрендеренный realm | не критичен, генерируется |

`docker compose down -v` **удаляет все данные**. В production использовать
только `down` без `-v`.

## 2. Предварительные требования

- Linux-хост с Docker Engine 24+ и Compose v2.20+ (проверено на Compose v5).
- 4 vCPU / 8 GB RAM / 100+ GB SSD — минимум для стека с ClamAV; для пилота
  допустимо 4 GB без ClamAV, но это решение фиксируется отдельно.
- DNS:
  - `DOMAIN` → A/AAAA хоста;
  - `FILES_DOMAIN` → A/AAAA того же хоста, **отличается** от `DOMAIN`.
- Firewall: входящие `80/tcp`, `443/tcp`, `443/udp`; всё остальное закрыто.
  Порты `5432`, `8081`, `8180`, `9000`, `9001` наружу не открываются.
- Исходящие: `80/443` для ACME, `587` (или корпоративный relay) для SMTP,
  registry для образов. Если SMTP/registry во внутренней сети — откройте
  только их.
- Secret manager (Vault/1Password/Ansible Vault и т.п.) для `.env.prod`,
  `KRUG_CONTENT_KEY` и пароля SMTP.
- Отдельный диск/volume для `/srv/backups/krug`, желательно с off-host копией.

## 3. Первый деплой

### 3.1. Подготовить окружение

```bash
git clone <repo> /opt/krug
cd /opt/krug
cp deploy/production/.env.prod.example deploy/production/.env.prod
chmod 600 deploy/production/.env.prod
$EDITOR deploy/production/.env.prod
```

Заменить **все** `CHANGE_ME`/`change-me` и `example.com`. Сгенерировать каждый секрет
отдельно:

```bash
openssl rand -base64 48 | tr -d '\n'; echo
```

Обязательные значения и их смысл — в комментариях
[`.env.prod.example`](../deploy/production/.env.prod.example). Особое внимание:

- `DOMAIN` / `FILES_DOMAIN` / `ACME_EMAIL` — от них зависит TLS;
- `KRUG_CONTENT_KEY` — **потеря ключа = потеря managed-сообщений**; сохранить
  в secret manager до первого запуска;
- `KRUG_AUTH_BFF_EMAIL_SECRET_KEY` — отдельный ключ для TOTP/email-секретов;
- `KC_BOOTSTRAP_ADMIN_PASSWORD` — только для provisioning и break-glass;
- `KC_ADMIN_*` — runtime-пользователь Keycloak (см. §4);
- `SPRING_MAIL_*` / `KRUG_MAIL_FROM` — реальный relay (см. §6).

Проверить, что compose видит конфигурацию (секреты не печатаются в отчёт), и
прогнать pre-flight:

```bash
cd /opt/krug
./deploy/scripts/preflight.sh
docker compose --env-file deploy/production/.env.prod \
  -f deploy/production/docker-compose.prod.yml config --quiet
```

`preflight.sh` завершится ошибкой, если остался `CHANGE_ME`/`change-me`, секрет короче
нормы, включён E2EE или выбран master/admin-cli для runtime Keycloak. Перед
go-live запустите `preflight.sh --strict`: он дополнительно требует
`S3_SCAN_MODE=clamav` и SMTP 587.

### 3.2. Поднять БД, Keycloak и MinIO

Сначала без backend/frontend/caddy, чтобы создать runtime-пользователя
Keycloak до первого обращения BFF:

```bash
cd /opt/krug
docker compose --env-file deploy/production/.env.prod \
  -f deploy/production/docker-compose.prod.yml \
  up -d postgres db-bootstrap keycloak-postgres keycloak-realm-init keycloak minio createbuckets
```

Дождаться health:

```bash
docker compose --env-file deploy/production/.env.prod \
  -f deploy/production/docker-compose.prod.yml ps
```

`keycloak` должен стать `healthy`; первый импорт realm занимает до минуты.
`keycloak` использует `KC_HOSTNAME=https://DOMAIN` как issuer; браузер к нему
не обращается. `KC_HOSTNAME_STRICT=false`, потому что host-port не публикуется,
а healthcheck ходит на loopback; безопасность обеспечивается сетевой
изоляцией и отсутствием published ports.

### 3.3. Создать runtime-пользователя Keycloak

Текущий backend (`KeycloakHttp.adminToken()`) использует **password grant**.
Поэтому «service account» в строгом смысле (client credentials) пока не
поддерживается; используется отдельный технический пользователь в realm
`krug`, а не master и не `admin-cli`. Это осознанный interim-шаг, см.
follow-up F-102-A в §10.

Войти bootstrap-админом (переменные уже есть в контейнере Keycloak):

```bash
docker compose --env-file deploy/production/.env.prod \
  -f deploy/production/docker-compose.prod.yml \
  exec -T keycloak bash -lc '
    /opt/keycloak/bin/kcadm.sh config credentials \
      --server http://127.0.0.1:8080 \
      --realm master \
      --user "$KC_BOOTSTRAP_ADMIN_USERNAME" \
      --password "$KC_BOOTSTRAP_ADMIN_PASSWORD"
  '
```

Создать пользователя (если его ещё нет) и выдать минимальные роли
`realm-management`:

```bash
docker compose --env-file deploy/production/.env.prod \
  -f deploy/production/docker-compose.prod.yml \
  exec -T keycloak bash -lc '
    set -e
    /opt/keycloak/bin/kcadm.sh get users -r krug -q username=svc-krug-bff --fields id,username >/tmp/u.json
    if ! grep -q 'svc-krug-bff' /tmp/u.json; then
      /opt/keycloak/bin/kcadm.sh create users -r krug \
        -s username=svc-krug-bff \
        -s enabled=true \
        -s email="$KC_ADMIN_EMAIL" \
        -s emailVerified=true \
        -s firstName=Krug \
        -s lastName=Ops
    fi
  '
```

`KC_ADMIN_EMAIL` берётся из `.env.prod`; при необходимости передайте его
явно через `exec -e KC_ADMIN_EMAIL=ops@example.com`.
Пароль задать отдельно, не печатая его в history:

```bash
read -r -s -p "Runtime Keycloak admin password: " KC_OPS_PASSWORD; echo
docker compose --env-file deploy/production/.env.prod \
  -f deploy/production/docker-compose.prod.yml \
  exec -T -e KC_OPS_PASSWORD="$KC_OPS_PASSWORD" keycloak bash -lc '
    /opt/keycloak/bin/kcadm.sh set-password -r krug \
      --username svc-krug-bff \
      --new-password "$KC_OPS_PASSWORD"
  '
unset KC_OPS_PASSWORD
```

Выдать роли (ровно те, что нужны Admin API пользователей/сессий):

```bash
docker compose --env-file deploy/production/.env.prod \
  -f deploy/production/docker-compose.prod.yml \
  exec -T keycloak bash -lc '
    for role in manage-users view-users query-users; do
      /opt/keycloak/bin/kcadm.sh add-roles -r krug \
        --uusername svc-krug-bff \
        --cclientid realm-management \
        --rolename "$role"
    done
  '
```

Проверить, что пользователь реально может читать realm (не master):

```bash
read -r -s -p "Runtime Keycloak admin password: " KC_OPS_PASSWORD; echo
docker compose --env-file deploy/production/.env.prod \
  -f deploy/production/docker-compose.prod.yml \
  exec -T -e KC_OPS_PASSWORD="$KC_OPS_PASSWORD" keycloak bash -lc '
    /opt/keycloak/bin/kcadm.sh config credentials \
      --server http://127.0.0.1:8080 \
      --realm krug \
      --client krug-web \
      --user svc-krug-bff \
      --password "$KC_OPS_PASSWORD"
    /opt/keycloak/bin/kcadm.sh get users -r krug -q username=svc-krug-bff --fields id,username,enabled
  '
unset KC_OPS_PASSWORD
```

`KC_ADMIN_PASSWORD` в `.env.prod` должен совпадать с только что заданным
паролем; при ротации меняются оба места.

### 3.4. Поднять приложение и TLS

```bash
cd /opt/krug
docker compose --env-file deploy/production/.env.prod \
  -f deploy/production/docker-compose.prod.yml up -d --build
```

Первый build собирает Maven/npm; это несколько минут. Caddy ждёт healthy
frontend, frontend — healthy backend. Если backend не стартует, смотреть:

```bash
docker compose --env-file deploy/production/.env.prod \
  -f deploy/production/docker-compose.prod.yml logs --tail=200 backend
```

Проверки:

```bash
curl -fsS https://chat.example.com/healthz
curl -fsS https://chat.example.com/api/v1/health
curl -sSI https://chat.example.com | grep -Ei 'strict-transport|content-type-options|referrer'
openssl s_client -connect chat.example.com:443 -servername chat.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

Ожидаемо: `200`, HSTS, `nosniff`, сертификат Let's Encrypt (или вашего ACME).
Проверить, что `https://FILES_DOMAIN` отдаёт `405` на `POST /` и не отдаёт
listing без подписи. Прямые `http://host:9000`, `:8180`, `:5432` не должны
открываться.

### 3.5. Первый вход и SMTP

- Открыть `https://DOMAIN`, зарегистрировать первого пользователя (BFF
  отправит код на SMTP — см. §6).
- Demo-пользователей в production realm нет: `realm-export.prod.json`
  содержит `"users": []`.
- Проверить админ-панель Совы и тестовое письмо.
- E2EE остаётся выключенным: `KRUG_E2EE_ENABLED=false`.

### 3.6. Первый бэкап

```bash
cd /opt/krug
./deploy/scripts/backup.sh --out-dir /srv/backups/krug
LATEST="$(ls -dt /srv/backups/krug/krug-backup-* | head -n 1)"
(cd "$LATEST" && sha256sum -c SHA256SUMS)
```

Настроить таймер/крон и off-host копирование: [`deploy/scripts/README.md`](../deploy/scripts/README.md).

## 4. Keycloak: режим доступа и service account

### 4.1. Что используется сейчас

- `KC_BOOTSTRAP_ADMIN_*` — master-realm admin, создаётся при первом старте;
  используется только для provisioning и break-glass. В backend **не**
  передаётся.
- Backend получает `KC_ADMIN_USER`, `KC_ADMIN_PASSWORD`,
  `KC_ADMIN_CLIENT_ID=krug-web`, `KRUG_KEYCLOAK_ADMIN_REALM=krug`.
  `KeycloakHttp` делает `grant_type=password` в
  `/realms/krug/protocol/openid-connect/token`.
- Пользователь `svc-krug-bff` имеет только `manage-users`, `view-users`,
  `query-users` в клиенте `realm-management` realm `krug`.
- Master realm и `admin-cli` в runtime не используются. Это требование
  выполнено для текущего стека.

Ограничение: это не client-credentials service account, а технический
пользователь с паролем. Пароль хранится в `.env.prod`; ротация — §9.

### 4.2. Целевой service account (follow-up F-102-A)

Для строгого `client_credentials` нужен небольшой код-фикс в
`backend/src/main/java/ru/krug/backend/auth/infrastructure/keycloak/KeycloakHttp.java`:
при непустом `KC_ADMIN_CLIENT_SECRET` отправлять
`grant_type=client_credentials` + `client_id` + `client_secret` вместо
`username/password`; не требовать `adminPassword`, когда задан secret;
добавить поле в `AuthBffProperties.Keycloak` и
`admin-client-secret: ${KC_ADMIN_CLIENT_SECRET:}` в `application.yml`.
После этого:

1. Создать конфиденциальный клиент в realm `krug`:
   ```bash
   /opt/keycloak/bin/kcadm.sh create clients -r krug \
     -s clientId=krug-bff-admin \
     -s enabled=true \
     -s publicClient=false \
     -s serviceAccountsEnabled=true \
     -s standardFlowEnabled=false \
     -s directAccessGrantsEnabled=false \
     -s secret="$KC_ADMIN_CLIENT_SECRET"
   ```
2. Получить service-account user id и выдать те же роли:
   ```bash
   /opt/keycloak/bin/kcadm.sh get clients -r krug -q clientId=krug-bff-admin --fields id
   /opt/keycloak/bin/kcadm.sh get clients/<client-id>/service-account-user --fields id
   /opt/keycloak/bin/kcadm.sh add-roles -r krug --uid <service-account-user-id> \
     --cclientid realm-management --rolename manage-users
   ```
3. В `.env.prod`: `KC_ADMIN_CLIENT_ID=krug-bff-admin`,
   `KC_ADMIN_CLIENT_SECRET=...`; удалить `KC_ADMIN_USER`/`KC_ADMIN_PASSWORD`
   из backend-окружения после проверки.
4. Перезапустить backend и проверить регистрацию/вход.

До этого фикса **не** пытайтесь подставить service account в текущий backend:
он не умеет `client_credentials` и вернёт 503 на auth-эндпоинтах.

### 4.3. Admin console без публикации порта

UI намеренно не публикуется: `keycloak` не имеет host-port mapping, а
`KC_HOSTNAME` указывает на публичный HTTPS-issuer. Штатный путь для ops —
`kcadm` внутри контейнера (команды выше); он не требует браузера и работает
по внутреннему HTTP.

Если UI критичен, поднимайте отдельный admin-host через Caddy с IP allowlist
и mTLS/SSO — это отдельное изменение периметра, а не часть #102. Не
добавляйте `8180:8080` в compose и не открывайте порт в firewall.

## 5. TLS / Caddy

- Сертификаты выпускаются автоматически для `DOMAIN` и `FILES_DOMAIN`.
  `ACME_CA` по умолчанию — Let's Encrypt production. Для прогона использовать
  staging URL и **отдельный** volume/стенд, чтобы не получить rate limit.
- Caddy хранит ACME-аккаунт и сертификаты в `krug-prod-caddy-data`. При
  пересоздании volume сертификаты выпускаются заново; следите за лимитами
  Let's Encrypt (5 неудачных валидаций/час, 50 сертификатов/домен/неделя).
- Продление автоматическое. Мониторинг: `openssl s_client ... -dates` или
  `docker compose logs caddy | grep -i certificate`.
- HSTS: `max-age=31536000; includeSubDomains`. `preload` **не** добавлять, пока
  все поддомены не переведены на HTTPS безвозвратно.
- Caddy проксирует `/ws` в nginx; nginx держит `proxy_read_timeout 3600s`.
  Caddy не буферизует WebSocket.
- Access-логи Caddy выключены (level ERROR), потому что query string может
  содержать one-time WS ticket и invite token. Включайте access-log только с
  редактированием query string.
- Проверка конфигурации перед reload:
  ```bash
  docker compose --env-file deploy/production/.env.prod \
    -f deploy/production/docker-compose.prod.yml \
    exec -T caddy caddy validate --config /etc/caddy/Caddyfile
  docker compose --env-file deploy/production/.env.prod \
    -f deploy/production/docker-compose.prod.yml \
    exec -T caddy caddy reload --config /etc/caddy/Caddyfile
  ```
  Caddyfile меняется на хосте; контейнер видит его read-only.
- Если TLS-termination уже есть на внешнем балансировщике, Caddy можно
  заменить, но тогда `PUBLIC_URL`, `S3_PUBLIC_ENDPOINT`, HSTS и WebSocket
  должны быть перенесены на него. Не оставляйте два TLS-слоя без причины.

### 5.1. Смена `DOMAIN` или `FILES_DOMAIN`

После первого импорта realm файл `realm-export.prod.json` больше не
применяется к существующей БД. Смена `DOMAIN` требует:

1. обновить DNS и `.env.prod`;
2. обновить в Keycloak `rootUrl`, `redirectUris`, `webOrigins` клиента
   `krug-web` (`kcadm update clients/<id> -r krug ...`) или переимпортировать
   realm в чистую БД;
3. `up -d --force-recreate backend keycloak frontend caddy` (issuer и
   собранный SPA меняются);
4. все пользователи входят заново: старые токены имеют прежний `iss`.

Смена `FILES_DOMAIN` дополнительно требует пересборки frontend
(`VITE_MEDIA_ORIGINS`) и обновления `S3_PUBLIC_ENDPOINT`; старые presigned
URL живут не дольше 5 минут.

## 6. SMTP в production

### 6.1. Переменные

Backend читает стандартные Spring-переменные (см.
`backend/src/main/resources/application.yml`):

```dotenv
SPRING_MAIL_HOST=smtp.example.com
SPRING_MAIL_PORT=587
SPRING_MAIL_USERNAME=...
SPRING_MAIL_PASSWORD=...
SPRING_MAIL_SMTP_AUTH=true
SPRING_MAIL_SMTP_STARTTLS=true
KRUG_MAIL_FROM=no-reply@example.com
```

Поддерживаемый production-путь — **587 + STARTTLS**. Implicit TLS 465 в
текущей конфигурации не выставлен (нет `mail.smtp.ssl.enable`); это
follow-up F-102-C. Если провайдер требует 465, используйте relay с 587 или
дождитесь фикса.

### 6.2. Приоритет настроек

`SmtpMailAdapter` сначала использует runtime-настройки из админ-панели
(`ops.system_settings`), и только если они не заполнены — переменные
окружения. Поэтому:

1. Задайте env как fallback и для первого запуска.
2. В админ-панели Совы откройте настройки SMTP, укажите те же host/port/
   username/password/from и включите STARTTLS.
3. Отправьте тестовое письмо из админ-панели.
4. После сохранения runtime-настроек env-пароль можно не менять, но
   документируйте источник истины.

Runtime-настройки поддерживают только STARTTLS; implicit TLS там не
предусмотрен.

### 6.3. Deliverability

- `KRUG_MAIL_FROM` должен быть в домене, для которого настроены SPF и DKIM;
  иначе письма с кодами попадут в спам.
- Настроить DMARC (`p=none` на старте, затем `quarantine`).
- Проверить PTR/reverse DNS у relay.
- Ограничить исходящий поток: BFF уже имеет rate limit на регистрацию,
  повторную отправку и email-инвайты.
- Не логировать SMTP-пароль и коды; `SmtpMailAdapter` их не логирует.
- Keycloak в этой схеме письма не отправляет; если включите Keycloak
  password-reset/verify-email, настройте SMTP в realm отдельно.

## 7. Обновление (upgrade)

### 7.1. Перед обновлением

1. Прочитать release notes/миграции; проверить, нет ли destructive DDL.
2. Снять бэкап с тегом:
   ```bash
   ./deploy/scripts/backup.sh --tag pre-upgrade
   ```
3. Проверить свободное место (`df -h`, `docker system df`) и здоровье:
   ```bash
   docker compose ... ps
   curl -fsS https://DOMAIN/api/v1/health
   ```
4. Зафиксировать текущий commit и digest образов:
   ```bash
   git rev-parse HEAD
   docker compose ... images
   ```
5. Для мажорного обновления Keycloak/PostgreSQL/MinIO — прогнать на staging с
   копией БД.

### 7.2. Применение

```bash
cd /opt/krug
git fetch --tags
git checkout <tag-or-commit>
docker compose --env-file deploy/production/.env.prod \
  -f deploy/production/docker-compose.prod.yml build --pull
docker compose --env-file deploy/production/.env.prod \
  -f deploy/production/docker-compose.prod.yml up -d
docker compose --env-file deploy/production/.env.prod \
  -f deploy/production/docker-compose.prod.yml logs -f backend
```

Flyway запускается при старте backend (профиль `keycloak,prod`). Смотреть
строки `Migrating schema ...`, `Successfully applied`. Если миграция упала —
backend не станет healthy; не запускать повторно вслепую, сначала прочитать
ошибку.

Проверки после:

```bash
curl -fsS https://DOMAIN/api/v1/health
# вход, список чатов, отправка сообщения, скачивание файла, WS
```

Zero-downtime в этой сборке нет: backend single-node (WS hub, rate limiter,
outbox, retention in-process). Обновление — короткое окно обслуживания.

### 7.3. Откат

Flyway-миграции forward-only, автоматического `undo` нет. Варианты:

| Ситуация | Действие |
|---|---|
| Изменён только код/конфиг, миграций не было | `git checkout <previous>` → `build` → `up -d` |
| Миграция применилась, но приложение не работает | остановить backend, восстановить `app.dump` из pre-upgrade, запустить предыдущий образ |
| Сломана схема Keycloak | остановить keycloak, восстановить `keycloak.dump`, запустить предыдущий образ Keycloak |
| Повреждены файлы | восстановить MinIO из `minio/` (см. restore.sh) |

Полный откат:

```bash
docker compose ... stop caddy frontend backend keycloak
./deploy/scripts/restore.sh --backup /srv/backups/krug/krug-backup-...-pre-upgrade
git checkout <previous-tag>
docker compose ... build
docker compose ... up -d
```

Помните: restore откатывает данные к моменту бэкапа; сообщения после него
будут потеряны.

## 8. Бэкапы и проверка восстановления

Полная процедура — [`deploy/scripts/README.md`](../deploy/scripts/README.md).
Кратко:

- Ежедневно `backup.sh` (02:15 + random delay), retention 30 дней.
- `app.dump` и `keycloak.dump` — custom format, проверяются `pg_restore --list`.
- MinIO — `mc mirror --overwrite --preserve`.
- `SHA256SUMS` + `MANIFEST.txt`; каталог `0700`, файлы `0600`.
- Off-host копия и шифрование (`age`/GPG) обязательны: бэкап содержит PII,
  password hashes и переписку.
- `KRUG_CONTENT_KEY` в бэкап не входит; храните его в secret manager.
- Раз в квартал — учебное восстановление в одноразовый stack; фиксируйте RTO
  и RPO.
- Алерты: бэкап не создан > 26 часов; `SHA256SUMS` не совпал; свободное место
  < 20%.

RPO по умолчанию — 24 часа (ежедневный бэкап), RTO — 1–2 часа при готовом
хосте и после тренировки. Для меньшего RPO нужен WAL-архив/непрерывная
репликация — это вне #102.

## 9. Ротация секретов

| Секрет | Процедура | Влияние |
|---|---|---|
| `KRUG_DB_PASSWORD` | `ALTER ROLE krug_migrator PASSWORD ...`; обновить `.env.prod`; `up -d db-bootstrap backend` | Flyway/бэкап используют новый пароль |
| `KRUG_APP_PASSWORD` | обновить `.env.prod`; перезапустить `db-bootstrap` (он сделает `ALTER ROLE krug_app`), затем backend | активные соединения переподключатся |
| `KC_DB_PASSWORD` | `ALTER ROLE keycloak PASSWORD ...`; `.env.prod`; `up -d keycloak` | короткий простой Keycloak |
| `KC_ADMIN_PASSWORD` | `kcadm set-password` для `svc-krug-bff`; `.env.prod`; `restart backend` | старые admin-токены живут до expiry |
| `KC_BOOTSTRAP_ADMIN_PASSWORD` | сменить в консоли/`kcadm`, обновить `.env.prod` | на уже инициализированной БД env не перезаписывает пароль |
| SMTP password | админ-панель + `.env.prod`; проверка тестовым письмом | письма с кодом могут временно не уходить |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | сменить root-креды MinIO, обновить `.env.prod`; `up -d minio createbuckets backend` | старые presigned URL живут ≤ 5 мин |
| `KRUG_AUTH_JWT_SECRET` | новый `openssl rand`; `.env.prod`; `restart backend` | в `keycloak`-профиле HMAC не выпускается; влияния на сессии нет |
| `KRUG_AUTH_BFF_EMAIL_SECRET_KEY` | новый ключ; `.env.prod`; `restart backend` | незавершённые email/TOTP-коды станут невалидны |
| `KRUG_CONTENT_KEY` | **не ротировать без миграции**: старые тела не расшифруются | нужен re-encryption tool (follow-up) |
| Caddy ACME | удалить `krug-prod-caddy-data` только осознанно | перевыпуск сертификатов, риск rate limit |

После каждой ротации: бэкап, проверка health, вход, отправка сообщения,
скачивание файла, тестовое письмо. Секреты не хранить в shell history:
использовать `read -r -s`, secret manager или `docker compose` env-file.

## 10. HttpOnly cookies — план (follow-up F-102-B)

Сейчас BFF возвращает `access_token`/`refresh_token` в JSON, а SPA хранит
сессию в `sessionStorage` (`frontend/src/auth/storage.ts`); `Set-Cookie` в
backend нет. Это значит, что XSS может украсть токены. TLS/HSTS и
sessionStorage (вместо localStorage) снижают риск, но не устраняют его.

Целевая схема (требует изменений backend + frontend + contract, в #102 не
реализована):

1. BFF на `/api/v1/auth/login|register|refresh` ставит `HttpOnly; Secure;
   SameSite=Lax` cookie с непрозрачным session id (access/refresh не отдаются
   в JSON).
2. CSRF: double-submit token или `SameSite=Strict` для state-changing
   эндпоинтов; добавить `GET /api/v1/auth/csrf`.
3. Frontend: `credentials: 'include'`, убрать чтение/запись токенов, обновить
   `authApi`, `PasswordAuthProvider`, тесты и OpenAPI.
4. Logout/refresh rotation и revocation на сервере; cookie очищается.
5. CSP (`default-src 'self'` с минимальными исключениями для media/blob)
   добавить в Caddy/nginx после проверки SPA.
6. Тесты: отсутствие токенов в JS/JSON, `HttpOnly`/`Secure`/`SameSite` в
   ответе, CSRF negative cases.

До реализации: короткий TTL access token, device binding, запрет
third-party scripts, регулярный dependency audit.

## 11. Мониторинг и day-2

Минимум:

```bash
# health всех сервисов
docker compose ... ps
# ошибки backend за последние 15 минут
docker compose ... logs --since=15m backend | grep -Ei 'error|exception|flyway'
# Caddy: сертификаты/ошибки
docker compose ... logs --since=24h caddy | grep -Ei 'certificate|error'
# диск и volumes
df -h / /var/lib/docker /srv/backups/krug
docker system df
```

Рекомендуется внешний black-box мониторинг:

- `GET https://DOMAIN/api/v1/health` каждую минуту;
- TLS expiry < 21 день;
- `https://FILES_DOMAIN/` отвечает (401/403/405, не 5xx);
- размер БД, lag/long transactions, свободное место;
- возраст последнего бэкапа;
- SMTP: периодическое тестовое письмо.

## 12. Инциденты: быстрые проверки

| Симптом | Что проверить |
|---|---|
| 502 от Caddy | `docker compose ps`; healthy ли frontend/backend; `logs frontend backend` |
| 503 на login/register | Keycloak healthy? `KC_ADMIN_*` совпадают с `svc-krug-bff`? роли выданы? |
| 401 на всех запросах | `KRUG_OIDC_ISSUER` = `https://DOMAIN/realms/krug`; системное время; JWKS доступен из backend |
| WS не подключается | Caddy/nginx `/ws`, `KRUG_WS_ALLOWED_ORIGINS=https://DOMAIN`, ticket TTL |
| Файлы не скачиваются | `FILES_DOMAIN` DNS/TLS; `S3_PUBLIC_ENDPOINT`; подпись Host; bucket |
| Письма не приходят | SMTP host/port/STARTTLS, from/SPF, runtime-настройки в админке, логи backend |
| Сертификат не выпускается | DNS A/AAAA, ports 80/443, Caddy logs, ACME rate limit |
| Диск заполнен | `docker system df`, старые образы/логи, retention бэкапов; не удалять volumes |
| Keycloak не стартует после restore | совместимость версии и `keycloak.dump`; логи; не откатывать схему вручную |

При аварии сначала остановить публичный tier (`compose stop caddy frontend`),
сохранить состояние (`docker compose ps`, логи, `df`), и только затем
восстанавливать.

## 13. Известные ограничения и follow-up

| ID | Тема | Статус |
|---|---|---|
| F-102-A | Keycloak client-credentials service account вместо password grant технического пользователя | follow-up, код |
| F-102-B | HttpOnly/Secure/SameSite cookie вместо токенов в JSON/sessionStorage | follow-up, код + контракт |
| F-102-C | Implicit TLS 465 (`mail.smtp.ssl.enable`) для SMTP | follow-up, конфиг/код |
| — | `S3_SCAN_MODE=noop` по умолчанию: перед production включить `scan` профиль и `S3_SCAN_MODE=clamav` | launch blocker |
| — | Single-node backend/Keycloak, без HA; Redis/Kafka/внешний scheduler — отдельная задача | ограничение |
| — | MinIO/Caddy/ClamAV образы с `latest`/`stable`; перед go-live зафиксировать digest | hardening |
| — | Нет WAL-архива; RPO = интервал бэкапа | ограничение |
| — | Access-логи Caddy выключены; включать только с redaction query string | ограничение |

## 14. Чек-лист go-live

- [ ] DNS для `DOMAIN` и `FILES_DOMAIN` указывает на хост; 80/443 открыты.
- [ ] `.env.prod` создан, `chmod 600`, все `CHANGE_ME`/`change-me` заменены, секреты в
      secret manager.
- [ ] `KRUG_CONTENT_KEY` сохранён отдельно; известна процедура восстановления.
- [ ] `docker compose config --quiet` проходит.
- [ ] `svc-krug-bff` создан, роли `manage-users/view-users/query-users`
      выданы, backend получает 200 на login.
- [ ] Demo-пользователей нет; bootstrap admin имеет сильный пароль.
- [ ] TLS-сертификаты выпущены для обоих доменов; HSTS есть.
- [ ] SMTP 587/STARTTLS проверен тестовым письмом; SPF/DKIM/DMARC настроены.
- [ ] `S3_SCAN_MODE=clamav`, ClamAV healthy (или письменно принят риск).
- [ ] `KRUG_E2EE_ENABLED=false` (до закрытия E2EE gate).
- [ ] Первый бэкап снят, `sha256sum -c` проходит, копия off-host.
- [ ] Восстановление прогнано на одноразовом стенде; RTO/RPO записаны.
- [ ] Мониторинг health/TLS/диска/бэкапа настроен.
- [ ] Порты 5432/8081/8180/9000/9001 недоступны из интернета.
- [ ] Runbook и контакты on-call доступны дежурному.

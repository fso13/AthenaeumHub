# Pickle — коробочный запуск

Один `docker compose` поднимает:

| Сервис | Роль | Порт хоста |
|---|---|---|
| `frontend` | React SPA + nginx, same-origin proxy `/api`, `/ws` | `8088` |
| `backend` | Spring Boot + Auth BFF, Keycloak internal, E2EE flag off | internal `8081` |
| `postgres` | PostgreSQL 16, Flyway V1–V20 | `127.0.0.1:5432` |
| `keycloak` | Keycloak 26.2 (`start`), realm `krug`, client `krug-web` | `8180` |
| `keycloak-postgres` | отдельная PostgreSQL для Keycloak | internal |
| `minio` | MinIO (Chainguard), S3 для managed-файлов | `9000` API, `9001` console |
| `mailpit` | SMTP + UI для писем подтверждения | `1025`, `8025` |

## Быстрый старт

```bash
cd deploy
cp .env.example .env
# открой .env и замени все change-me; сгенерируй секреты:
#   openssl rand -base64 48

docker compose --env-file .env up -d --build
docker compose --env-file .env ps
```

Открыть: **http://localhost:8088**

Вход в приложение — **свои формы Pickle**, без редиректа в Keycloak.  
Демо-пользователь: `test@krug.local` / `Test1234!` (логин — email)  
Письма подтверждения: **http://localhost:8025** (Mailpit).  
Админ Keycloak (только ops): `http://localhost:8180/admin/`, `admin` / `KC_ADMIN_PASSWORD`.

Первый запуск занимает несколько минут: Maven собирает backend, npm — frontend, Keycloak импортирует realm.

## Проверка

```bash
curl -fsS http://localhost:8088/healthz
curl -fsS http://localhost:8088/api/v1/health
docker compose --env-file .env logs -f backend
```

## Настройка домена / TLS

Для локального стенда `PUBLIC_URL=http://localhost:8088` уже работает. Для внешнего имени:

1. Поставьте TLS-терминацию (Caddy/Traefik/nginx) перед `frontend:8088`.
2. В `.env`:
   ```dotenv
   PUBLIC_URL=https://chat.example.com
   PUBLIC_WS_URL=wss://chat.example.com/ws
   S3_PUBLIC_ENDPOINT=https://files.example.com
   KC_PUBLIC_URL=https://admin.example.com
   APP_PORT=8088
   ```
3. Пересоберите frontend и перезапустите:
   ```bash
   docker compose --env-file .env up -d --build frontend backend
   ```
4. Браузер приложения не обращается к Keycloak, поэтому redirect URI прикладного домена больше не нужен. `KC_PUBLIC_URL` — только адрес admin-консоли/issuer для ops.

`S3_PUBLIC_ENDPOINT` должен быть доступен из браузера пользователя: presigned URL подписывается именно на этот host. Внутренний backend ходит в `http://minio:9000` отдельно. Для production используйте реальный S3/MinIO/Ceph и задайте `S3_ENDPOINT`/`S3_PUBLIC_ENDPOINT`/ключи.

## Auth / email

- Браузер вызывает только `/api/v1/auth/*`; Keycloak доступен только backend'у.
- Регистрация: письмо с 6-значным TOTP; Mailpit UI `http://localhost:8025`.
- В `.env` для production задайте реальный SMTP (`SPRING_MAIL_*`) и `KRUG_MAIL_FROM`.
- Админ Keycloak не проксируется через SPA; используйте `http://localhost:8180/admin/`.
- Для production замените master-realm `admin-cli` на отдельный Keycloak service account (follow-up).

## Файлы и AV

- MinIO S3 API: `http://localhost:9000`; консоль: `http://localhost:9001` (логин/пароль — `S3_ACCESS_KEY`/`S3_SECRET_KEY`). Данные — в volume `krug-minio-data`.
- Bucket `krug` создаётся sidecar-контейнером `createbuckets`; backend также создаёт его лениво.
- По умолчанию `S3_SCAN_MODE=noop` — **только для демо**.
- ClamAV:
  ```bash
  # в .env: S3_SCAN_MODE=clamav
  docker compose --env-file .env --profile scan up -d --build
  ```
  Первый старт ClamAV долгий (обновление баз); backend переживёт недоступность сканера и повторит.

## Данные и сброс

| Volume | Что внутри |
|---|---|
| `krug_krug-pgdata` | PostgreSQL |
| `krug_krug-keycloak-pgdata` | PostgreSQL для Keycloak (realm/users/clients) |
| `krug_krug-keycloak-import` | отрендеренный realm |
| `krug_krug-minio-data` | S3-объекты MinIO |
| `krug_krug-clamav-data` | базы ClamAV |

Полный сброс **удаляет все данные**:

```bash
docker compose --env-file .env down -v
```

## E2EE test mode (только тест)

```bash
cd deploy
docker compose --env-file .env   -f docker-compose.yml -f docker-compose.e2ee-test.yml up -d --build
```

Overlay включает `KRUG_E2EE_ENABLED=true` и пересобирает SPA с `VITE_E2EE_ENABLED=true`.
**Не использовать на production.** Для обычного стека запускайте без overlay; флаг остаётся false.

## Ограничения этой сборки

- Keycloak запущен в production-режиме `start` и хранит данные в отдельной PostgreSQL. Остаётся single-instance: для HA нужны несколько Keycloak-инстансов, внешний Infinispan/БД и балансировщик; TLS-терминация и `sslRequired=external` — на внешнем контуре.
- Backend — **single-node**: WebSocket hub, rate limiter, outbox relay и retention in-process. Для HA нужны Redis/Kafka и внешний scheduler.
- E2EE **выключен** (`KRUG_E2EE_ENABLED=false`): backend E2EE готов, клиентский крипто-слой за флагом, но включение ждёт G4/пентест и real-browser E2E.
- Используется community-сборка MinIO от Chainguard (`chainguard/minio`), без AIStor-лицензии. Для production можно заменить на свой S3/MinIO/Ceph.
- Порты `5432`, `8025`, `1025`, `8180`, `9000`, `9001` опубликованы для локальной отладки. В закрытом контуре уберите их из compose или ограничьте firewall.
- Секреты в `.env` не коммитить; `deploy/.env` в `.gitignore`.
- Бэкапить нужно две БД: `krug` (приложение) и `keycloak` (realm/users). H2 больше не используется.

## Остановка

```bash
docker compose --env-file .env down        # данные сохраняются
docker compose --env-file .env down -v     # данные удаляются
```

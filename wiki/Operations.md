# Operations

## Compose

```bash
cd deploy
cp .env.example .env
# заполнить секреты
docker compose --env-file .env up -d --build
```

Сервисы: postgres, db-bootstrap, keycloak-postgres, keycloak-realm-init, keycloak, minio,
createbuckets, backend, frontend, mailpit; optional ClamAV.

## Переменные

См. `deploy/.env.example`: `PUBLIC_URL`, `KRUG_APP_PASSWORD`, `KRUG_DB_PASSWORD`,
`KRUG_AUTH_JWT_SECRET`, `KRUG_CONTENT_KEY`, `KC_*`, `S3_*`, `KRUG_E2EE_ENABLED=false`.

`deploy/.env` — только локально/в secret store, не в git.

## Healthchecks

- backend `/api/v1/health`
- Keycloak `/health/ready`
- MinIO/S3, Mailpit
- frontend nginx

## Бэкапы

- PostgreSQL app + Keycloak DB: `pg_dump` по расписанию, retention, restore drill.
- MinIO/S3: versioning/replication или `mc mirror`.
- Секреты — в vault/secret manager.

## Миграции

- Flyway V1..V27; forward-only.
- V19/V20 требуют backup/maintenance и `DB_USER != FLYWAY_USER`; runbook — тикет #42.
- Не запускайте миграции runtime-ролью.

## TLS / production

- Reverse proxy TLS, WSS, HSTS, secure cookies.
- `PUBLIC_URL`/`KC_PUBLIC_URL`/`S3_PUBLIC_ENDPOINT` — реальные домены.
- Ограничить порты БД/Keycloak/MinIO.
- Тикеты #43/#44.

## E2EE overlay

Только для теста:

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose.e2ee-test.yml up -d --build
```

Base `.env`/compose остаются `false`; после теста вернуть base stack.

## Логи

`docker compose logs -f backend frontend keycloak`; request_id; plaintext/токены не логируются.

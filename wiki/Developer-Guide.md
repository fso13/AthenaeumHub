# Developer Guide

## Стек

- Java 21, Spring Boot 3.4.5, PostgreSQL 16, Flyway, Keycloak 26.2, MinIO/S3, Mailpit.
- React 19, Vite 7, TypeScript strict, MSW, Vitest/RTL, Playwright, axe.
- Модульный монолит; bounded contexts: `auth`, `workspace`, `chat`, `message`, `realtime`, `file`, `sticker`, `notification`, `ops`, `audit`.

## Структура

```
backend/src/main/java/ru/krug/backend/<context>/{domain,application,infrastructure,api}
frontend/src/{api,components,store,e2ee,realtime,...}
contracts/openapi.yaml + ws-protocol.md
deploy/  docs/  design/
```

Правила:
- домен — чистый Java, без Spring/JPA;
- JPA только infrastructure;
- API DTO только в `api`;
- ArchUnit 10/10;
- контракт — источник истины; `npm run contract:check`.

## Запуск

```bash
cd deploy
cp .env.example .env
docker compose --env-file .env up -d --build
```

Backend: `http://localhost:8088/api/v1`, health `/api/v1/health`.
Frontend: `http://localhost:8088`.

## Тесты

```bash
cd backend
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
mvn -o -Dmaven.repo.local=.m2repo test     # 453 tests + ArchUnit

cd ../frontend
npm ci
npm run check                              # lint/format/contract/security/vitest/build
npm run test:e2e                           # Playwright (mock)
npm run test:e2e:e2ee                      # browser KAT (gated)
```

E2EE-real (только disposable стенд):

```bash
cd deploy
docker compose --env-file .env -f docker-compose.yml -f docker-compose.e2ee-test.yml up -d --build
cd ../frontend
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npm run test:e2e:e2ee:real
```

## Контракт

- `contracts/openapi.yaml`: **47 paths / 55 operations / 87 schemas**.
- `frontend/src/api/schema.d.ts` генерируется `npm run api:types`.
- `check-contract.mjs` проверяет счётчики/пути/поля; не ослаблять без ADR.

## Auth BFF

- Браузер → `/api/v1/auth/*`; Keycloak internal.
- Login/register/verify/TOTP/refresh/logout; JIT provisioning.
- `X-Device-Id` обязателен для device-bound endpoints.
- Не логировать пароли/коды/токены/plaintext.

## E2EE

- Спецификация: `docs/E2EE-SPEC.md`.
- Флаги: `KRUG_E2EE_ENABLED=false`, `VITE_E2EE_ENABLED=false`.
- G4: `docs/E2EE-REVIEW-13.md` — GO WITH CONDITIONS, pilot only.
- Не включать base flag; тестовый overlay `deploy/docker-compose.e2ee-test.yml`.

## Отчёты и задачи

- `docs/TASKS.md`, `docs/TASKS-ADMIN-V2.md`, `docs/TASKS-E7.md`.
- GitHub issues: https://github.com/fso13/AthenaeumHub/issues
- Перед PR: `npm run check`, backend tests, contract, отчёт с evidence.

## Стиль

- React: функциональные компоненты, доступность, токены дизайна.
- Java: constructor injection, records для DTO/commands, DomainException.
- Никаких секретов в коде/логах/коммитах; `deploy/.env` в `.gitignore`.

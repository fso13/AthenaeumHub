# Architecture

## Контекст

```
Browser ──HTTPS/WSS──> nginx ──> SPA
                         │
                         └──> Backend BFF ──> Keycloak (internal)
                                      │
                                      ├──> PostgreSQL (RLS)
                                      ├──> MinIO/S3
                                      └──> SMTP
```

Браузер не обращается к Keycloak напрямую: вход/refresh/logout — через `/api/v1/auth/*`.

## Модули

| Контекст | Ответственность |
|---|---|
| auth | BFF, TOTP, users, devices, platform admin |
| workspace | spaces, memberships, roles, invites |
| chat | DIRECT/GROUP, limits, settings |
| message | messages, attachments, envelopes, history |
| realtime | WebSocket, tickets, presence, notifications |
| file | presign, upload, quota, AV |
| sticker | packs, recent, send |
| notification | unread/fanout |
| ops | system settings, admin, audit queries |
| audit | append-only events |

## DDD

`domain` — инварианты и value objects; `application` — use cases/ports; `infrastructure` — JPA/S3/Keycloak/WS; `api` — controllers/DTO/mappers. ArchUnit запрещает зависимости наружу.

## Данные

- Flyway V1..V27; RLS по workspace/user; runtime role `krug_app`, миграции отдельным пользователем.
- `message.messages` + `message.message_envelopes`; E2EE: `body_ciphertext NULL`, envelopes only.
- Audit append-only, hash-chain; admin queries через SECURITY DEFINER.
- Файлы: metadata в PostgreSQL, blob в S3/MinIO.

## Auth flow

1. Login → BFF → Keycloak direct grant.
2. BFF проверяет emailVerified; JIT upsert пользователя.
3. Access/refresh; device binding; `X-Device-Id`.
4. Suspend → Keycloak disable + logout + WS revoke.

## E2EE (gated)

- X3DH + Double Ratchet, per-device prekeys/OPK, sealed local copies.
- Server stores envelopes only; no plaintext.
- Browser support: Chromium/Firefox; WebKit blocked by ADR-26.
- Флаг off; pilot conditions в `docs/E2EE-REVIEW-13.md`.

## Наблюдаемость

- Request ID, structured logs; не логировать plaintext/токены.
- Healthchecks; compose logs; audit.

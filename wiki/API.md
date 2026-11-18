# API

Base: `http://localhost:8088/api/v1`  
Контракт: [contracts/openapi.yaml](https://github.com/fso13/AthenaeumHub/blob/main/contracts/openapi.yaml)

## Auth

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/auth/register` | регистрация + TOTP email |
| POST | `/auth/verify` | подтверждение email |
| POST | `/auth/login` | вход (email/password) |
| POST | `/auth/refresh` | refresh |
| POST | `/auth/logout` | logout |
| GET | `/me` | профиль |

Ошибки: `INVALID_CREDENTIALS` 401, `EMAIL_NOT_VERIFIED` 403, `ACCOUNT_SUSPENDED` 403, `AUTH_UNAVAILABLE` 503.

## Workspaces / chats

| Метод | Путь |
|---|---|
| GET | `/workspaces` |
| POST | `/workspaces` |
| GET | `/workspaces/{id}/members` |
| POST | `/workspaces/{id}/members` |
| PATCH/DELETE | `/workspaces/{id}/members/{userId}` |
| GET/POST | `/workspaces/{id}/chats` |
| GET | `/chats/{id}` |
| PATCH | `/chats/{id}` (D1) |
| GET/POST | `/chats/{id}/messages` |
| GET | `/chats/{id}/messages/{id}/thread` (D1) |

`POST /chats/{id}/messages` принимает `text` для managed и `envelopes` для E2EE; E2EE-ответ `text:null`.

## Files / stickers / notifications

- `POST /files/presign`, `POST /files/{id}/complete`, `GET /files/{id}`.
- `GET /stickers/packs`, `POST /chats/{id}/messages` (sticker).
- `GET /notifications`, `POST /notifications/read`.

## Admin

| Метод | Путь |
|---|---|
| GET | `/admin/users|chats|storage|audit` |
| POST | `/admin/users/{id}/suspend|activate` |
| DELETE | `/admin/chats/{id}` |

Только platform admin; non-admin 403.

## Headers

- `Authorization: Bearer <access_token>`
- `X-Device-Id: <uuid>` для device-bound endpoints
- `Idempotency-Key` для create/send, где поддерживается
- `X-Request-Id` — опционально; response `X-Request-Id`

## Ошибки

```json
{"code":"CHAT_LIMIT_REACHED","message":"...","details":{},"request_id":"req_..."}
```

Коды: `VALIDATION_FAILED`, `CHAT_LIMIT_REACHED`, `WORKSPACE_MEMBER_LIMIT_REACHED`, `MEMBER_ALREADY_EXISTS`, `USER_NOT_FOUND`, `CHAT_ALREADY_DELETED`, `E2EE_DISABLED`.

## Realtime

`/ws` + ticket; события `message.created`, `message.updated`, `session.revoked`, typing/presence. См. `contracts/ws-protocol.md`.

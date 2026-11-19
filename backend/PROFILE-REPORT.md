# PROFILE (#72) — PATCH /me, bio/phone, Keycloak sessions

> Формат — `docs/TASKS.md` §5. Зона сессии: `backend/**`, additive-правки
> `contracts/openapi.yaml`, регенерация единственного frontend-файла
> `frontend/src/api/schema.d.ts`. Остальной `frontend/**`, `docs/**`, `design/**`,
> `deploy/**` не менялись. Git-репозитория в рабочем дереве нет, поэтому «одним PR»
> проверить нельзя; изменения согласованы в рабочем дереве.

## Статус

**DONE в границах #72** (MVP без TOTP-authenticator): `PATCH /me` для
`display_name`/`bio`/`phone`, `GET /me/sessions`, `DELETE /me/sessions/{sessionId}`
через Keycloak Admin API, аудит `profile.updated` только с именами полей, best-effort
синхронизация display name в Keycloak и контрактные тесты.

Миграция — **`V35__profile_fields.sql`**. Параллельная #73 (file center) сначала
добавила свой `V35`, из-за чего Flyway на мгновение падал с
`Found more than one migration with version 35`; #73 отозвала миграцию, и #72
закрепила V35 за собой.

## Что сделано

### 1. Контракт (`contracts/openapi.yaml`, additive)

| Операция | Ответ | Ошибки |
|---|---|---|
| `PATCH /me` | `200 AuthUser` | `400`, `401`, `422` |
| `GET /me/sessions` | `200 ProfileSessions` | `401`, `503` |
| `DELETE /me/sessions/{sessionId}` | `204` | `400`, `401`, `404`, `503` |

Новые схемы: `AuthUser`, `ProfileUpdate`, `ProfileSession`, `ProfileSessions`.
`MeResponse.user` теперь ссылается на `AuthUser` (структурно те же поля плюс
необязательные `bio`/`phone`; старые клиенты и frontend-фикстуры не ломаются).

* `ProfileUpdate`: все поля опциональны; отсутствие поля = «не менять», `null`/пустая
  строка для `bio`/`phone` = очистить. Пустой объект — `422 VALIDATION_FAILED`
  (`reason=empty_patch`). `display_name=null`/пустой — `400 VALIDATION_FAILED`.
* `AuthUser`: `id`, `display_name` (1..80), `email`, `is_platform_admin`, `bio`
  (≤280), `phone` (≤32). `bio`/`phone` в ответах всегда присутствуют, включая `null`.
* `ProfileSession`: `id`, `name` (метка клиента), `created_at`, `last_access_at`,
  `current`; **нет** `ip`, `username`, токенов. `current` вычисляется по claim `sid`
  access token.
* Контракт явно фиксирует: email, пароль, статус, платформенная роль и E2EE-ключи
  через `PATCH /me` недоступны; неизвестные поля игнорируются; значения — plain text.

`frontend/src/api/schema.d.ts` регенерирован `npm run api:types`.
`npm run contract:check` — passed (67 operations / 103 schemas в текущем общем
контракте; вклад #72: +2 path, +3 operation, +4 schema).

### 2. Миграция и модель

`backend/src/main/resources/db/migration/V35__profile_fields.sql`:

* `auth.users.bio text`, `auth.users.phone text`;
* именованные CHECK-ограничения: `display_name` 1..80, `bio` ≤280, `phone` ≤32;
* комментарии колонок. Email/пароль не затрагиваются — они принадлежат Keycloak.

Домен:

* `Bio` и `Phone` — value objects: trim, пустое → `null`, bounds, запрет NUL/ISO
  control-символов (в bio разрешены `\n`/`\r`/`\t`, в phone — нет). HTML сервер не
  интерпретирует и не «санитайзит»: значение хранится как plain text.
* `User` получил `bio`, `phone`, `withProfile(...)`; старые фабрики
  `createDev/provision/reconstitute` сохранены как overloads.
* `UserEntity`, `UserPersistenceMapper`, `UserRepository.updateProfile(...)` —
  обновляют только `display_name/bio/phone/updated_at`. E2EE-таблицы
  (`auth.devices`, `auth.device_prekeys`) не трогаются.

### 3. PATCH /me

`UpdateProfileService` (`auth/application/usecase`):

* `tenantContext.activate(principal.withWorkspace(null))` → RLS видит только себя;
* пустой patch → `422 VALIDATION_FAILED` до записи;
* partial semantics: отсутствующее поле сохраняет текущее значение;
* `UserRepository.updateProfile` — один UPDATE трёх колонок;
* audit `profile.updated`, `target_type=user`, metadata **только**
  `{"fields":["display_name","bio","phone"]}`; значения (особенно bio/phone) в
  audit/logs не попадают;
* Keycloak display-name sync: `firstName`/`lastName` = новый display name,
  best-effort. Ошибка провайдера ловится и логируется без значения, email, IP и
  текста исключения; PATCH остаётся `200`. Для dev-пользователя без identity-link
  sync просто пропускается.

`PATCH /me` не является device-bound (как и `GET /me`), но присутствующий
`X-Device-Id` по-прежнему валидируется общим `DeviceBindingFilter`.

### 4. Keycloak sessions

Порт `KeycloakAdminPort` расширен:

* `listSessions(userId)` → `GET /admin/realms/{realm}/users/{id}/sessions`;
* `revokeSession(userId, sessionId)` →
  `DELETE /admin/realms/{realm}/users/{id}/sessions/{sessionId}`;
* `updateDisplayName(userId, displayName)` → `PUT .../users/{id}`.

`KeycloakAdminAdapter`:

* парсит только `id`, `startTime`, `lastAccess`, `clients`; `ipAddress` и `username`
  отбрасываются в адаптере и не попадают ни в application model, ни в ответ, ни в лог;
* `name` — человекочитаемая метка из имён клиентов (fallback `"Keycloak session"`,
  max 120);
* 404 на list = пустой список, 404 на revoke = «уже отозвана» (идемпотентно);
* transport/5xx → `ProviderUnavailableException`, без логирования тел/токенов.

`ProfileSessionService`:

* subject берётся только из собственного `auth.user_identities` link текущего
  пользователя; URL не содержит user id;
* ownership: перед revoke id должен присутствовать в списке сессий **этого**
  subject; чужая/уже отсутствующая сессия → `404 NOT_FOUND` без побочных эффектов;
* результат сортируется по `last_access_at` DESC; `current=true` при совпадении
  `sid` текущего токена;
* Keycloak недоступен → `503 AUTH_UNAVAILABLE` + `Retry-After: 5` (через общий
  `AuthBffErrors.authUnavailable`);
* текущую сессию разрешено отзывать (требование «current optional»); access token
  при этом, как и в Keycloak, живёт до истечения, но refresh-сессия больше не
  обновляется.

`Principal` получил `sessionId` (claim `sid`, nullable; для dev-токенов `null`);
4-аргументный конструктор сохранён для обратной совместимости.

### 5. Ошибки и безопасность

* `PATCH /me` и сессии — только для аутентифицированного вызывающего (`401` без JWT).
* `GET /me/sessions`/`DELETE` не логируют IP, userId Keycloak, session id, токены или
  тела ответов Keycloak.
* Нет эндпоинтов с чужим `userId`; ownership проверяется по Keycloak subject и
  списку сессий.
* Нет изменений email/password/2FA-authenticator; TOTP-authenticator вне среза.

## Тесты

Добавлен `backend/src/test/java/ru/krug/backend/integration/ProfileIT.java` (8 тестов,
`@ActiveProfiles("keycloak")`, реальные MockMvc + PostgreSQL Testcontainers + WireMock
Keycloak Admin):

1. PATCH обновляет display_name/bio/phone; GET /me и БД совпадают; audit содержит
   только имена полей и не содержит значений; Keycloak display name синхронизирован.
2. Validation/bounds: пустой patch `422`, blank/null/81-символьный display_name `400`,
   bio 281 `400`, phone 33 `400`; явный `null` очищает bio/phone; неизвестные
   `email`/`password` игнорируются и не меняют identity.
3. Keycloak update user → 503: PATCH всё равно `200`, локальное имя и audit есть,
   Keycloak имя не изменилось.
4. PATCH не меняет `auth.devices` (Ed25519+X25519 ключи) и `auth.device_prekeys`.
5. Без JWT все три endpoint'а дают `401`.
6. Sessions list: только сессии своего subject, сортировка, `current` по `sid`,
   в сыром ответе нет IP/email/username/токенов.
7. Revoke: своя сессия `204` и исчезает; чужая `404` и остаётся у владельца;
   повторный revoke `404`; текущая сессия отзывается `204`; malformed id `400`.
8. Keycloak outage: list/revoke `503 AUTH_UNAVAILABLE` + `Retry-After`, сессия не
   удалена, session id не утёк в тело ошибки.

WireMock-расширение `KeycloakWireMock` умеет список/удаление сессий, `sid`-claim в
`KeycloakTestSupport` и режимы отказа admin sessions/user update.

Фактические прогоны:

* `mvn -o -Dmaven.repo.local=.m2repo -Dtest=ProfileIT,ArchitectureTest test` —
  **18/18** (8 ProfileIT + 10 ArchUnit), 0 failures/errors.
* Полный backend suite под JDK 21 (проектный target) — **571/571**, 0 failures,
  0 errors, включая `ProfileIT` 8/8 и `ArchitectureTest` 10/10.
* `npm run contract:check` — passed; generated schema in sync.
* `npx tsc -p tsconfig.json --noEmit` (frontend typecheck против нового
  `schema.d.ts`) — passed.

> Полный suite запускался в изолированной копии исходников: параллельные
> backend-сессии пересобирают общий `backend/target`, из-за чего прямой прогон один
> раз получил `NoClassDefFoundError` и дубликат V35. Копия — snapshot финального
> рабочего дерева; после прогона она удаляется. JDK 26 не используется: Mockito
> inline-mock не инструментирует классы на 26, поэтому suite гонялся на JDK 21, как в
> README/CI.

## Приёмка

| Пункт | Статус |
|---|---|
| `PATCH /me` display_name/bio/phone → AuthUser | ✅ |
| Bounds/plain text/empty patch | ✅ `400`/`422`, V35 CHECK |
| Нет email/password/2FA изменений | ✅ request не содержит полей; unknown игнорируются |
| Audit `profile.updated` fields-only | ✅ metadata без значений |
| JIT/Keycloak displayName sync best-effort | ✅ failure не ломает PATCH |
| `GET /me/sessions` (id, name, created, last_access, current) без IP | ✅ |
| `DELETE /me/sessions/{sessionId}` → 204, ownership | ✅ своя 204, чужая 404 |
| Keycloak down → 503 | ✅ `AUTH_UNAVAILABLE` + Retry-After |
| E2EE keys unaffected | ✅ тест на devices/device_prekeys |
| Contract + generated `schema.d.ts` | ✅ additive, contract check passed |
| Full suite 544+ / ArchUnit | ✅ **571/571** + ArchUnit 10/10 (JDK 21) |

## Остаточные ограничения

* Keycloak session list не пагинируется: у пользователя практически несколько сессий;
  при необходимости — follow-up с `first/max` Keycloak Admin API.
* Отзыв текущей сессии не инвалидирует уже выданный stateless access token мгновенно
  (семантика Keycloak); refresh-сессия отзывается. Для мгновенного отзыва access token
  нужен короткий TTL/интроспекция — вне #72.
* В dev-профиле нет Keycloak identity link, поэтому `/me/sessions` честно отвечает
  `503 AUTH_UNAVAILABLE`, а не пустым списком; `PATCH /me` в dev работает и просто
  пропускает Keycloak sync.
* TOTP-authenticator, смена email/пароля, загрузка аватара и «выйти на всех
  устройствах» отдельной кнопкой не входят в этот срез (последнее уже покрыто
  существующим `POST /auth/logout`/admin logout).

**Итоговый статус: DONE.**

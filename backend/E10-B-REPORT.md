# E10-B — member directory + DIRECT chats

> Формат — `docs/TASKS.md` §5. Зона сессии: `backend/**`, additive-правки
> `contracts/openapi.yaml`, регенерация `frontend/src/api/schema.d.ts`. Остальной
> `frontend/**`, `docs/**`, `design/**`, `deploy/**` не менялись. Git-репозитория в
> рабочем дереве нет, поэтому «одним PR» проверить нельзя — изменения согласованы
> в рабочем дереве.

## Статус

**DONE в границах E10-B.** Реализованы `GET /workspaces/{workspaceId}/members` с
cursor-пагинацией, literal-поиском, стабильным порядком и active-only фильтрацией, а
также end-to-end проверка DIRECT-создания через этот каталог. Полный backend suite —
**434/434**, `ArchitectureTest` — **10/10** (JDK 21). `frontend/src/api/schema.d.ts`
регенерирован. `npm run contract:check` остаётся красным только на захардкоженных
счётчиках контракта (`41 paths / 81 schemas`); это зона E10-F (см. «Риски»).

## Сделано

### 1. Contract (additive)

`contracts/openapi.yaml`:

* path `GET /workspaces/{workspaceId}/members` (tag `workspaces`,
  `operationId: listWorkspaceMembers`);
* schemas `WorkspaceMember` и `WorkspaceMemberPage`;
* query-параметры `query` (max 80), `cursor`, `limit` (1..100, default 50);
* page shape `{items, next_cursor, has_more}` — как у существующих cursor-страниц
  (`AdminUserPage`, `NotificationPage`), без offset;
* ответ содержит только `user_id`, `display_name`, `role`, `joined_at`; email/пароли/
  устройства/ключи отсутствуют by construction;
* ответы contract-тестов валидируются `OpenApiContract.assertValid("WorkspaceMemberPage")`.

**Фактические счётчики контракта:** было **41 path / 47 operations / 81 schema**,
стало **42 / 48 / 83** (+1 path, +1 operation, +2 schemas). `openapi-typescript`
синхронен; `frontend/src/api/schema.d.ts` обновлён через `npm run api:types`.

### 2. V24 — member directory без ослабления RLS

`backend/src/main/resources/db/migration/V24__workspace_member_directory.sql`:

* `workspace.member_directory(p_workspace_id, p_query, p_limit,
  p_cursor_display_name, p_cursor_user_id)` — `STABLE`, read-only,
  `SECURITY DEFINER`, `search_path = pg_catalog, pg_temp`;
* причина SECURITY DEFINER: `auth.users` — FORCE RLS с self-only политикой (V2),
  поэтому обычный join к `auth.users` вернул бы только display_name вызывающего;
* функция сама проверяет `caller.user_id = ops.current_user_id()` и
  `caller.status = 'ACTIVE'` для запрошенной workspace. Вызов в обход HTTP-гарда
  (например, прямым SQL) для не-участника возвращает **0 строк**;
* возвращает только `u.id`, `u.display_name`, `m.role`, `m.joined_at`;
* active-only: `m.status = 'ACTIVE'`, `w.status = 'ACTIVE'`, `u.status = 'ACTIVE'`;
* поиск — `position(lower(p_query) IN lower(u.display_name)) > 0`, то есть literal
  подстрока, а не `LIKE`; `%`/`_` не являются wildcard;
* стабильный keyset `ORDER BY display_name ASC, user_id ASC` с ограничением
  `LIMIT LEAST(GREATEST(p_limit, 1), 101)` (101 = limit+1 для `has_more`);
* `REVOKE ALL ... FROM PUBLIC`, `GRANT EXECUTE ... TO krug_app`;
* partial index `ix_users_active_display_name_id (display_name, id)
  WHERE status = 'ACTIVE'` поддерживает порядок/keyset.

RLS-политики и существующие гранты не менялись. Owner функции должен видеть
`auth.users` (superuser/BYPASSRLS migration-роль в dev/test; в prod DBA настраивает
такое же разделение, как для `ops.platform_overview()` и V23).

### 3. Backend `workspace/members`

```
workspace/domain/model           WorkspaceMemberRow
workspace/domain/repository      WorkspaceMemberRepository
workspace/domain/exception       InvalidWorkspaceMemberCursorException (400)
workspace/application/model      WorkspaceMemberView, WorkspaceMemberPageView,
                                 WorkspaceMemberPageCursor
workspace/application/service    WorkspaceMemberPageRequests
workspace/application/usecase    ListWorkspaceMembersService
workspace/infrastructure/...     WorkspaceMemberRepositoryAdapter (native SQL, 1 запрос)
workspace/api                    WorkspaceMemberController + dto/mapper
```

* `ListWorkspaceMembersService` активирует tenant context, затем вызывает
  `WorkspaceAccessPort.requireActiveMember` → `403 FORBIDDEN` для не-участника,
  чужой и неизвестной workspace (существование не раскрывается);
* `limit` default 50, диапазон 1..100; `query` >80 → `400`; битый/чужой cursor →
  `400 VALIDATION_FAILED`;
* страница — один SQL-вызов `workspace.member_directory` с `limit + 1`; N+1 нет,
  `has_more` вычисляется по лишней строке;
* cursor — base64url `wmm1\0<workspace_id>\0<display_name>\0<user_id>`; привязан к
  workspace и endpoint, поля разделены NUL (PostgreSQL `text` не может содержать NUL),
  поэтому кавычки/`%`/переводы строк в display name безопасны;
* API-слой не видит domain-классы: controller → use case → view → response DTO.

### 4. DIRECT-создание

`ChatCreateService` уже содержал нужные проверки, E10-B их не дублирует и не меняет:

* `peer_id` обязателен для DIRECT и запрещён для GROUP;
* `peer_id != caller` → иначе `400 VALIDATION_FAILED` (`details.field=peer_id`);
* peer должен иметь `ACTIVE` membership в workspace → иначе `400 VALIDATION_FAILED`;
* существующая DIRECT-пара возвращается с `200` и тем же chat id (идемпотентность по
  ordered pair), в том числе при обратном вызове от peer;
* гонка разрешается `ON CONFLICT DO NOTHING`, лимиты проверяются под workspace-lock.

Добавлен интеграционный сценарий: owner находит peer через `/members`, создаёт DIRECT
(`201`), повторяет (`200`, тот же id), peer делает обратный вызов (`200`, тот же id);
в БД ровно один DIRECT-чат пары. Self, removed-peer и foreign-peer → `400`.

### 5. Tests

Добавлено **18** тестов (416 → **434**):

* `WorkspaceMemberPageCursorTest` (5): unicode/спецсимволы round-trip, url-safe без
  padding, привязка к workspace, мусор/неверная версия/битый UUID, невалидный
  constructor;
* `WorkspaceMemberPageRequestsTest` (6): default limit 50, границы 1/100, 0/101,
  trim/literal `%_`, query >80, blank cursor, round-trip через helper;
* `WorkspaceMemberDirectoryIT` (7):
  * active-only (ACTIVE membership + ACTIVE user; REMOVED/INVITED/SUSPENDED/DELETED
    исключены), ровно четыре поля, `joined_at` не null, нет email/password в теле;
  * caller включён, role OWNER/ADMIN и joined_at от membership;
  * literal-поиск `%` (LIKE вернул бы всех), case-insensitive, пагинация 2+2+1 без
    дублей/пропусков и с сортировкой `display_name`;
  * non-member/foreign/unknown workspace → `403 FORBIDDEN`; member (не owner) → `200`;
    без токена → `401 UNAUTHENTICATED`;
  * невалидные limit/query/cursor, cursor из другой workspace → `400`;
  * прямой вызов `workspace.member_directory` под RLS: участник видит 2 строки,
    не-участник — 0 (RLS-safe даже без HTTP-гарда);
  * DIRECT через каталог: 201 → 200 same id → reverse 200 same id; self/removed/foreign
    → 400; в БД один DIRECT-чат пары.

Полный suite: **434/434**, failures/errors 0 (`JAVA_HOME` JDK 21, `mvn -o test`,
1:27 min). `ArchitectureTest`: **10/10**. Запуск на JDK 26 даёт известные падения
существующих Mockito-тестов (inline mock maker) — это ограничение окружения, не E10-B;
эталон проекта — JDK 21.

### 6. README

`backend/README.md`:

* строка `GET /workspaces/{workspaceId}/members?query=&cursor=&limit=` в API surface;
* раздел «E10-B — member directory for DIRECT chats»: семантика, active-only,
  403/404-политика, limit/search/cursor, V24/RLS, partial index, curl-smoke,
  contract-count caveat для E10-F.

## Приёмка (TASKS §5 / E10)

| Пункт | Статус |
|---|---|
| `GET /workspaces/{id}/members` → `WorkspaceMemberPage`, `user_id/display_name/role/joined_at` | ✅ |
| Только active: ACTIVE membership + ACTIVE workspace + ACTIVE user | ✅ SQL + тест |
| Cursor opaque, привязан к workspace, stable order `display_name,user_id` | ✅ keyset |
| `limit` 1..100 default 50; `has_more` по limit+1 | ✅ |
| Search по `display_name` literal (без LIKE/wildcard) | ✅ `position()` |
| 403 non-member; foreign workspace не раскрывает существование | ✅ |
| RLS-safe, без ослабления политик, `SECURITY DEFINER` только `krug_app` | ✅ V24 + тест |
| No N+1: один SQL-вызов на страницу | ✅ |
| DIRECT: peer active member, not self, idempotent, existing pair 200 | ✅ сервис + IT |
| No email/password/устройства/ключи в ответе | ✅ проекция + тест |
| Contract additive, schema.d.ts regenerated | ✅ 42/48/83 |
| Full suite + ArchUnit | ✅ 434/434 + 10/10 (JDK 21) |
| README endpoint | ✅ |

## Contract

| Операция | Auth | Ответ |
|---|---|---|
| `GET /workspaces/{workspaceId}/members?query=&cursor=&limit=` | JWT + `X-Device-Id`, ACTIVE member | `WorkspaceMemberPage` — `items[]` (`user_id`, `display_name`, `role`, `joined_at`), `next_cursor`, `has_more` |

Новые схемы:

* `WorkspaceMember` — required `user_id`, `display_name`, `role`
  (`OWNER|ADMIN|MEMBER|GUEST`), `joined_at`; описание явно фиксирует отсутствие email/
  credentials/devices/keys и то, что вызывающий может быть в списке;
* `WorkspaceMemberPage` — required `items`, `has_more`; `next_cursor` nullable.

Существующие 41 path / 47 operations / 81 schema не менялись; правки только additive.
`OpenApiContract.assertValid` проверяет каждый ответ в `WorkspaceMemberDirectoryIT`.

## Security

* **Authorization.** HTTP: `requireActiveMember` → `403 FORBIDDEN` до чтения данных.
  SQL: независимая проверка `ops.current_user_id()` + `caller.status='ACTIVE'`; даже
  прямой вызов функции не-участником возвращает 0 строк. Чужая/неизвестная workspace —
  одинаковый `403`, без oracle существования.
* **RLS.** Политики не менялись; `auth.users` остаётся FORCE RLS/self-only. Функция
  узкая: read-only, `STABLE`, только 4 каталожные колонки, `EXECUTE` только `krug_app`,
  `PUBLIC` отозван. Owner функции — доверенная migration/BYPASSRLS роль.
* **No content.** В ответе нет email, password hash, device/key material, E2EE
  envelope, message text или file metadata. В SQL-проекции этих колонок нет.
* **Injection / wildcard.** Параметры биндятся через `?`; поиск literal через
  `position()`, поэтому `%`, `_`, кавычки и юникод не меняют семантику.
* **Resource limits.** `limit ≤ 100`, keyset (без offset), функция дополнительно
  ограничивает `p_limit` 101; `query ≤ 80`; битый cursor → `400`, не `500`.
* **DIRECT self-peer.** `peer_id == caller` отклоняется, несмотря на то что caller
  присутствует в каталоге; peer обязан быть ACTIVE-member.
* **Audit/no secrets.** Endpoint ничего не пишет в audit и логи; параметры поиска и
  display names в логи не попадают.

## Тесты

* Полный backend suite: **434/434**, failures/errors 0, skipped 0
  (`mvn -o test`, JDK 21.0.10).
* `ArchitectureTest`: **10/10** (domain purity, layer direction, cross-context).
* Новое: `WorkspaceMemberDirectoryIT` (7), `WorkspaceMemberPageCursorTest` (5),
  `WorkspaceMemberPageRequestsTest` (6).
* `ContractValidationIT` и `OpenApiContract` — без изменений; новые ответы
  валидируются в E10-B IT.
* JDK 26: известные падения существующих Mockito unit-тестов (inline mock maker),
  не связаны с E10-B; эталон — JDK 21 (как в E9-B).

## Риски и вопросы

1. **Frontend contract guard.** `frontend/scripts/check-contract.mjs` содержит
   `Object.keys(spec.paths).length === 41` и `Object.keys(schemas).length === 81`
   (строки ~506/517) и фиксированный список 47 операций. Реальный контракт теперь
   `42 / 48 / 83`. `schema.d.ts` синхронен (проверка типов проходит), но E10-F должен:
   поднять счётчики до 42/48/83 и добавить `GET /workspaces/{workspaceId}/members`
   в `operations` (иначе его никто не проверяет). Это вне зоны E10-B (нельзя
   `frontend/**`, кроме `schema.d.ts`), поэтому скрипт намеренно не менялся.
2. **Cursor не подписан HMAC.** Как и существующие admin/notification-курсоры, это
   base64url, а не подписанный токен (SYSTEM-ANALYSIS §7.3 упоминает HMAC). Курсор
   привязан к workspace и не является границей безопасности: данные всё равно
   фильтруются по membership в SQL. Если потребуется HMAC, это общее изменение для
   всех cursor-страниц, а не только E10-B.
3. **Caller в каталоге.** Список включает самого вызывающего (он active member).
   `ChatCreateService` отклоняет self-peer; E10-F должен либо скрыть себя, либо
   показать с disabled-состоянием.
4. **Suspended user с ACTIVE membership.** Каталог исключает его по
   `auth.users.status`, но существующая проверка DIRECT-peer смотрит только на
   `workspace.memberships.status`; прямой API-вызов с таким peer не будет отклонён.
   Менять общую семантику `WorkspaceAccessPort.isActiveMember` (влияет на все
   workspace/chat-доступы) в E10-B не стал — это отдельное решение.
5. **`X-Device-Id` обязателен** (как у `/chats` и `/limits`). Клиент E10-F должен
   использовать существующий authed-helper; запрос без заголовка — `401`.
6. **403 вместо 404** для неизвестной workspace — выбран осознанно, чтобы не
   раскрывать существование; TASKS допускает `403/404`.

## Файлы E10-B

* `backend/src/main/resources/db/migration/V24__workspace_member_directory.sql`
* `backend/src/main/java/ru/krug/backend/workspace/{domain,application,infrastructure,api}/**`
  (новые классы member directory + `WorkspaceApiMapper`)
* `backend/src/test/java/ru/krug/backend/integration/WorkspaceMemberDirectoryIT.java`
* `backend/src/test/java/ru/krug/backend/unit/WorkspaceMemberPageCursorTest.java`
* `backend/src/test/java/ru/krug/backend/unit/WorkspaceMemberPageRequestsTest.java`
* `contracts/openapi.yaml` (additive)
* `frontend/src/api/schema.d.ts` (регенерация)
* `backend/README.md` (endpoint + раздел E10-B)
* `backend/E10-B-REPORT.md` (этот файл)

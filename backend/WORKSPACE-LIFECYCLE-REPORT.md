# #99 — выход/удаление воркспейса и точный `member_count` чата

> Zone: `backend/**`, additive `contracts/**`, `frontend/src/api/schema.d.ts`.
> Дополнительно обновлён `frontend/scripts/check-contract.mjs`: contract-guard фиксирует
> точное число paths/operations и без него любой новый endpoint валит
> `npm run contract:check` (тот же осознанный выход за zone, что и в #98). Остальной
> `frontend/**` не редактировался; в общем рабочем дереве есть параллельные изменения
> других срезов, они не затронуты.
> Счётчики ниже — фактические на момент сдачи.

## Статус

**DONE в границах #99 (backend).**

- `DELETE /workspaces/{id}/members/me` — self-leave (идемпотентный `204`, `409 LAST_OWNER`).
- `DELETE /workspaces/{id}` — OWNER-only soft-delete (идемпотентный `204`).
- `ChatSummary.member_count` и `Chat.member_count` — точное число ACTIVE-участников чата,
  а не участников воркспейса; одинаково в list и detail.
- V55: `deleted_at/deleted_by`, две SECURITY DEFINER функции, RLS/grants/audit.
- `WorkspaceLifecycleIT` — 6/6; полный backend suite — **995 tests** (было 989),
  ArchUnit 10/10; contract-guard — **132 paths / 162 operations / 212 schemas**,
  generated TS in sync.
- Никаких изменений E2EE; сообщения, вложения и object-storage blobs не удаляются.

## 1. Принятые решения

### 1.1 Leave

| Ситуация | Ответ |
|---|---|
| ACTIVE MEMBER/ADMIN/GUEST | `204`, membership и все chat participants → `REMOVED` |
| повторный leave (в т.ч. после удаления админом) | `204`, без нового аудита |
| последний ACTIVE OWNER | `409 LAST_OWNER` |
| не участник / чужая / неизвестная workspace | `403 FORBIDDEN` (существование не раскрывается) |

В текущей схеме V2 `ux_memberships_one_owner` допускает ровно одного OWNER, поэтому
«другого OWNER» структурно нет и владелец всегда получает `LAST_OWNER`. Проверка в SQL
всё равно считает живых OWNER'ов (`count(*) > 1`), чтобы правило осталось верным при
будущих co-owner'ах. Выйти из воркспейса владелец сможет только после передачи/появления
второго OWNER; сейчас его путь — удаление воркспейса.

При leave удаляются и строки `chat.chat_members` этого пользователя во всех чатах
воркспейса. Это нужно для точного `member_count`: иначе «призрак» продолжал бы считаться
участником. Доступ к чатам и так был бы закрыт проверкой workspace membership, но строка
оставалась бы видимой в счётчике.

### 1.2 Delete

- Только ACTIVE OWNER. MEMBER/ADMIN — `403 WORKSPACE_PERMISSION_DENIED`; outsider/неизвестная
  workspace — `403 FORBIDDEN`.
- `workspace.workspaces.status = 'DELETED'`, `deleted_at`, `deleted_by`; `version` не
  трогается, `security_mode` неизменяем.
- Все memberships → `REMOVED`, все invites получают `revoked_at`, все chat participants →
  `REMOVED`, все боты воркспейса → `DISABLED`.
- `chat.chats`, `message.messages`, `file.attachments` и байты S3/MinIO **не удаляются и не
  помечаются deleted**: это зона будущего retention/export job. API-доступ исчезает сразу,
  потому что все guard'ы требуют ACTIVE workspace membership, а `isActiveMember` теперь
  дополнительно требует `workspace.status = 'ACTIVE'` (defence in depth).
- Повтор владельцем — `204 ALREADY_DELETED`, без второго аудит-события. Другой вызывающий
  на уже удалённой workspace получает тот же `403 FORBIDDEN`, что и на чужой.
- `workspace.deleted` audit: только id и счётчики (`memberships_removed`,
  `invites_revoked`, `chat_memberships_removed`, `bots_disabled`), без имён и контента.

### 1.3 «Сессии/устройства»

Локального per-workspace session store нет: JWT stateless, а Keycloak-сессия общая для всех
воркспейсов пользователя. Поэтому глобально отзывать сессию нельзя — это выкинуло бы
пользователя из остальных воркспейсов. Инвалидация сделана на уровне авторизации:

- `GET /me` перестаёт возвращать воркспейс (`listActiveMemberships` фильтрует ACTIVE и
  `w.status = 'ACTIVE'`);
- `/workspaces/{id}/sessions`, `/members`, `/chats`, файлы и все workspace-guard'ы
  отвечают `403` на следующем запросе;
- чат-доступ (`ChatAccessService`) и realtime-подписки проверяют workspace membership на
  каждом запросе/подписке;
- боты воркспейса выключаются, их bearer-токены перестают аутентифицироваться (`401`);
- приглашения отозваны, `accept_invite` на DELETED-workspace отвечает `404`
  (`WORKSPACE_UNAVAILABLE`), не раскрывая состояние.

Это документировано в контракте и в javadoc сервисов. Глобальный отзыв Keycloak-сессий —
сознательно вне #99 (потребовал бы per-workspace session model).

### 1.4 `member_count`

- `GROUP`: `count(*)` ACTIVE `chat.chat_members`, дополнительно JOIN на ACTIVE
  `workspace.memberships` — «зависшая» строка не раздувает число.
- `DIRECT`: те же правила; пока оба участника остаются ACTIVE-членами воркспейса, это 2.
  После leave одного из них его participant row становится `REMOVED`, и оставшийся видит 1
  (это точное число ACTIVE-участников, а не константа). В тесте зафиксирован кейс
  `DIRECT = 2` при живых обоих участниках.
- PRIVATE-канал считает только своих участников, поэтому 2 при 3 участниках воркспейса —
  ожидаемо и покрыто тестом.
- Поле добавлено в конец записей/DTO, позиционные индексы существующих колонок не сдвинуты.

## 2. Миграция V55

`V55__workspace_lifecycle.sql` (следующая свободная после V54).

### 2.1 `workspace.workspaces` (additive)

| Колонка | Тип |
|---|---|
| `deleted_at` | `timestamptz NULL` |
| `deleted_by` | `uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL` |

Плюс `ix_workspaces_status (status)` и комментарии колонок.

### 2.2 `workspace.leave_workspace(uuid, uuid)`

`RETURNS TABLE(outcome text, role text, chat_memberships_removed integer)`,
`SECURITY DEFINER`, `search_path = pg_catalog, pg_temp`, advisory lock
`workspace.members|<id>` (общий с V27 add/role/remove).

Порядок: advisory lock → workspace exists → membership row + `p_actor_id =
ops.current_user_id()` → `ALREADY_LEFT` для не-ACTIVE → `LAST_OWNER` для последнего OWNER →
membership `REMOVED` → chat participants `REMOVED` (JOIN по `chat.chats.workspace_id`, а не
по денормализованному `chat_members.workspace_id`) → счётчик.

Outcome: `OK`, `ALREADY_LEFT`, `FORBIDDEN`, `LAST_OWNER`.

### 2.3 `workspace.delete_workspace(uuid, uuid)`

`RETURNS TABLE(outcome text, memberships_removed integer, invites_revoked integer,
chat_memberships_removed integer, bots_disabled integer)`, тот же lock.

Порядок: advisory lock → workspace + deleted_at/created_by → если уже DELETED, то
`ALREADY_DELETED` только для OWNER/создателя, иначе `FORBIDDEN` → ACTIVE membership +
`ops.current_user_id()` → `NOT_OWNER` для не-владельца → soft-delete workspace →
memberships `REMOVED` → invites `revoked_at` → chat participants `REMOVED` → bots
`DISABLED` → счётчики.

Outcome: `OK`, `ALREADY_DELETED`, `FORBIDDEN`, `NOT_OWNER`.

Обе функции: `REVOKE ALL ... FROM PUBLIC`, `GRANT EXECUTE ... TO krug_app`, комментарии.
Ни одна не возвращает email, display name, сообщения или ключи.

## 3. API (additive)

| Метод | Путь | Права | Ответ |
|---|---|---|---|
| `DELETE` | `/workspaces/{workspaceId}/members/me` | любой ACTIVE-участник | `204`; `409 LAST_OWNER`; `403` |
| `DELETE` | `/workspaces/{workspaceId}` | только ACTIVE OWNER | `204` (идемпотентно); `403` |

`WorkspaceMemberController` получил literal-mapping `"/me"`: Spring выбирает literal
сегмент раньше `{userId}`-шаблона, поэтому UUID-конвертация не срабатывает (проверено IT).
`WorkspaceLifecycleController` — тонкий контроллер только для delete.

Новые поля в контракте:

- `ChatSummary.member_count` (integer, minimum 0) и `Chat.member_count` (то же) —
  аддитивные, с описанием «не число участников воркспейса», групповой/private/DIRECT
  семантикой и edge-case после leave.
- Error-описание дополнено: #99 переиспользует `LAST_OWNER` и
  `WORKSPACE_PERMISSION_DENIED`, новых кодов нет.

`frontend/src/api/schema.d.ts` перегенерирован (`npm run api:types`), diff — только новые
path/operation/types.

## 4. Application/domain

- `WorkspaceLeaveResult`, `WorkspaceDeletionResult` — domain-модели outcome + счётчики.
- `WorkspaceLifecycleRepository` + `WorkspaceLifecycleRepositoryAdapter` — по одному
  native-вызову V55-функции.
- `WorkspaceLifecycleErrors` — единый mapping outcome → `DomainException`.
- `LeaveWorkspaceService`, `DeleteWorkspaceService` — `@Transactional`:
  `tenantContext.activate(principal.withWorkspace(id))`, вызов функции, audit только на
  `OK`.
- `WorkspaceRepositoryAdapter.isActiveMember` теперь JOIN'ит `workspace.workspaces` и требует
  `status = 'ACTIVE'`: даже при частично сохранившейся membership строке удалённый/
  приостановленный воркспейс не даёт доступ ни чатам, ни файлам, ни сессиям.
- Аудит: `workspace.member.left` (`target=user`, metadata `role`,
  `chat_memberships_removed`) и `workspace.deleted` (`target=workspace`, счётчики).
  Оба пишутся в той же транзакции через `AuditPort`.

## 5. `member_count` в коде

В `ChatRepositoryAdapter.listActiveSummaries` в конец SELECT добавлена коррелированная
подвыборка:

```sql
(SELECT count(*)::integer
   FROM chat.chat_members mm
   JOIN workspace.memberships wm
     ON wm.workspace_id = mm.workspace_id
    AND wm.user_id = mm.user_id
    AND wm.status = 'ACTIVE'
  WHERE mm.chat_id = c.id
    AND mm.status = 'ACTIVE') AS member_count
```

Дополнительно `ChatRepository.countActiveChatMembers(workspaceId, chatId)` используется в
detail-fallback (`ChatViewAssembler`/`ChatCreateService`), когда у зрителя нет личной
summary-строки (workspace OWNER/ADMIN не участник чата).

Обновлены все маппинги: `ChatSummary` → `ChatSummaryView` → `ChatSummaryResponse`,
`ChatView` → `ChatResponse`, `ChatApiMapper`, `ChatQueryService`, `ChatCreateService`
(createdGroup получает фактический `memberCount`, createdDirect — 2),
`ChatViewAssembler` (createdGroup/createdDirect/fallback).

## 6. RLS, audit, безопасность

- Обе функции `SECURITY DEFINER` с фиксированным `search_path`; owner — migration role, как
  V24/V27/V42/V43. Runtime `krug_app` не получает прямого доступа к чужим membership rows.
- `p_actor_id = ops.current_user_id()` не позволяет подменить актора; вызов из чужого
  tenant-контекста возвращает `FORBIDDEN` (проверено IT).
- `workspace.workspaces.deleted_at/deleted_by` не входят в API-ответы и не содержат PII.
- Audit append-only, только id/роли/счётчики; email, display name, текст, имена файлов и
  ключи не попадают.
- Cross-tenant: неизвестная/чужая workspace и удалённая workspace для не-владельца дают
  одинаковый `403`; RLS-проверка видимости чужого workspace — 0 строк.
- E2EE не затронут: нет изменений в envelope/key/device путях.
- Blobs/сообщения/вложения сохраняются; hard-delete отсутствует.

## 7. Тесты

`WorkspaceLifecycleIT` (6 тестов, все зелёные):

1. `memberLeavesAndLosesWorkspaceAndChatAccess` — member leave, membership/chat rows
   `REMOVED`, audit без email/имени, `403` на chats/members/sessions, workspace исчезает из
   `/me`, `member_count` 2 → 1, повторный leave `204` без аудита.
2. `soleOwnerCannotLeave` — `409 LAST_OWNER`, membership остаётся ACTIVE, аудита нет,
   доступ сохраняется.
3. `permissionsAndIdempotencyAreEnforcedForLeaveAndDelete` — outsider/unknown `403`,
   member/admin delete `403 WORKSPACE_PERMISSION_DENIED`, состояние не изменилось, GUEST
   leave `204` + повторный `204`, ровно одно audit-событие.
4. `ownerDeletesWorkspaceSoftlyAndContentIsRetained` — реальное сообщение и сообщение бота
   до удаления; invite; после `DELETE`: `status=DELETED`, `deleted_at/deleted_by`,
   memberships/chat participants `REMOVED`, invite `revoked_at`, bot `DISABLED`, chat строка
   и `message` count сохранены, audit-счётчики, `403` на chats/sessions, `/me` без
   воркспейса, accept invite `404`, bot send `401`, повторный delete `204` без аудита.
5. `chatMemberCountIsExactForGroupDirectAndPrivate` — PUBLIC 3, DIRECT 2, PRIVATE 2 при 3
   участниках воркспейса; list и PATCH-detail совпадают; после leave второго участника
   PRIVATE 1, PUBLIC 2, DEFAULT 2, DIRECT 2.
6. `lifecycleFunctionsRejectBypassAndStayPrivate` — прямой вызов функций с чужим актором
   `FORBIDDEN`, spoofed actor `FORBIDDEN`, `PUBLIC` не имеет EXECUTE, колонки
   `deleted_at/deleted_by` существуют, RLS скрывает чужой workspace.

Также прогнаны затронутые срезы: `WorkspaceMemberManagementIT`,
`WorkspaceMemberDirectoryIT`, `ChannelVisibilityIT`, `ChannelSettingsIT`, `ChatSettingsIT`,
`ChatAvatarIT`, `ContractValidationIT`, `WorkspaceSessionsIT`, `CrossTenantIT`, `BotsIT`,
`WorkspaceOverviewIT` — 60/60.

Полный backend suite: **995 tests, 0 failures, 0 errors** (JDK 21; см. §8 про JDK 26).
ArchUnit — 10/10. Contract-guard — 132 paths / 162 operations / 212 schemas, generated
types in sync, `tsc --noEmit` — 0 ошибок.

## 8. Верификация

```bash
cd backend
mvn -o -Dmaven.repo.local="$PWD/.m2repo" -Dtest=WorkspaceLifecycleIT test
mvn -o -Dmaven.repo.local="$PWD/.m2repo" test          # JAVA_HOME=jdk21
cd ../frontend
npm run api:types
npm run contract:check
npx tsc -p tsconfig.json --noEmit
```

Примечание по окружению: полный прогон на локальном JDK 26 падает не из-за #99 —
Mockito inline mock maker в `spring-boot-starter-test` 3.4.5 не инструментирует классы на
JDK 26 (`Mockito cannot mock this class` в ~49 unit-тестах, включая `LoginServiceTest`,
`JitProvisioningServiceTest`). CI и целевая версия проекта — JDK 21
(`maven.compiler.release=21`, `ci.yml`: JDK 21); на JDK 21 весь suite зелёный. Это
pre-existing ограничение окружения, не регрессия #99.

## 9. Файлы

Новые:

- `backend/src/main/resources/db/migration/V55__workspace_lifecycle.sql`
- `backend/src/main/java/ru/krug/backend/workspace/api/WorkspaceLifecycleController.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/service/WorkspaceLifecycleErrors.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/usecase/LeaveWorkspaceService.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/usecase/DeleteWorkspaceService.java`
- `backend/src/main/java/ru/krug/backend/workspace/domain/model/WorkspaceLeaveResult.java`
- `backend/src/main/java/ru/krug/backend/workspace/domain/model/WorkspaceDeletionResult.java`
- `backend/src/main/java/ru/krug/backend/workspace/domain/repository/WorkspaceLifecycleRepository.java`
- `backend/src/main/java/ru/krug/backend/workspace/infrastructure/persistence/WorkspaceLifecycleRepositoryAdapter.java`
- `backend/src/test/java/ru/krug/backend/integration/WorkspaceLifecycleIT.java`

Изменённые:

- workspace: `WorkspaceMemberController`, `WorkspaceRepositoryAdapter`
- chat: `ChatSummary`, `ChatSummaryView`, `ChatSummaryResponse`, `ChatView`,
  `ChatResponse`, `ChatApiMapper`, `ChatQueryService`, `ChatCreateService`,
  `ChatViewAssembler`, `ChatRepository`, `ChatRepositoryAdapter`
- `contracts/openapi.yaml`
- `frontend/src/api/schema.d.ts`
- `frontend/scripts/check-contract.mjs` (guard counts/operation map; вне заявленной zone,
  но обязателен для зелёного `npm run check`; тот же прецедент, что в #98)

## 10. Ограничения и follow-up

- В схеме ровно один OWNER: self-leave владельца всегда `409 LAST_OWNER`; удаление —
  единственный путь для владельца. Если появятся co-owner'ы, SQL уже готов.
- Глобальные Keycloak-сессии и устройства не отзываются (общая сессия на несколько
  воркспейсов); доступ отзывается перепроверкой membership. Для «жёсткого» logout нужен
  per-workspace session model — отдельная задача.
- `member_count` для DIRECT после leave одного участника равен 1 (оставшийся видит чат);
  это осознанно точное число ACTIVE-участников, а не константа 2.
- Retention сообщений/файлов/чатов soft-deleted воркспейса — будущий job; #99 их не удаляет
  и не скрывает из БД, только из API.
- Боты выключаются, но их строки и token hash сохраняются (raw token не хранится).
- UI-индикация «воркспейс удалён» не входит в backend-срез; frontend использует
  существующие `403`/исчезновение из `/me`.

## Итог

**DONE** — backend-функциональность #99 реализована, покрыта интеграционными тестами,
контракт аддитивно обновлён, полный suite (JDK 21) и ArchUnit зелёные.

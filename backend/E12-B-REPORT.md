# E12-B — workspace member management (add / role / remove)

> Формат — `docs/TASKS.md` §5. Зона сессии: `backend/**`, additive-правки
> `contracts/openapi.yaml`, регенерация `frontend/src/api/schema.d.ts`. Остальной
> `frontend/**`, `docs/**`, `design/**`, `deploy/**` не менялись; порт `8080` не
> трогался. Git-репозитория в рабочем дереве нет, поэтому «одним PR» проверить нельзя —
> изменения согласованы в рабочем дереве.

## Статус

**DONE в границах E12-B.** Реализованы R-09 / FR-WS-4…FR-WS-7
(`docs/SYSTEM-ANALYSIS.md` §18.6):

* `POST /workspaces/{workspaceId}/members` `{email, role}` → `201 WorkspaceMember`;
* `PATCH /workspaces/{workspaceId}/members/{userId}` `{role}` → `200 WorkspaceMember`;
* `DELETE /workspaces/{workspaceId}/members/{userId}` → `204` (soft removal);
* OWNER/ADMIN guard, ADMIN не управляет OWNER/ADMIN, OWNER не назначается, последний
  OWNER/self защищены;
* атомарный `max_workspace_members`, `409 WORKSPACE_MEMBER_LIMIT_REACHED`;
* дубль `409 MEMBER_ALREADY_EXISTS`, неизвестный/неактивный email `404 USER_NOT_FOUND`;
* поиск существующего пользователя по email через `SECURITY DEFINER` (auth.users FORCE
  RLS);
* audit add/role/remove только с id/ролями, без email и display name;
* удалённый теряет доступ к workspace и его чатам на следующем запросе.

Полный backend suite — **453/453**, `ArchitectureTest` — **10/10** (JDK 21).
`frontend/src/api/schema.d.ts` регенерирован. `npm run contract:check` остаётся красным
только на захардкоженных счётчиках `46 paths / 85 schemas` (реально `47 / 87`); это
зона E12-F (вне `backend/**` + `schema.d.ts`), см. «Риски».

## 1. Contract (additive)

`contracts/openapi.yaml`:

* `POST /workspaces/{workspaceId}/members` — `AddWorkspaceMemberRequest` `{email, role}`,
  `201 WorkspaceMember`; `400/401/403/404/409`;
* `PATCH /workspaces/{workspaceId}/members/{userId}` — `ChangeWorkspaceMemberRoleRequest`
  `{role}`, `200 WorkspaceMember`; `400/401/403/404/409`;
* `DELETE /workspaces/{workspaceId}/members/{userId}` — `204`; `401/403/404/409`;
* существующая `WorkspaceMember` (`user_id`, `display_name`, `role`, `joined_at`)
  переиспользована без изменения полей; `WorkspaceMemberPage` не менялась;
* в описание `Error.code` добавлены E12-коды: `USER_NOT_FOUND`, `MEMBER_NOT_FOUND`,
  `MEMBER_ALREADY_EXISTS`, `WORKSPACE_MEMBER_LIMIT_REACHED`, `ROLE_CHANGE_FORBIDDEN`,
  `LAST_OWNER`;
* `X-Device-Id` объявлен на всех трёх мутациях (фильтр устройства уже требовал его для
  `/api/v1/workspaces/**`).

**Фактические счётчики контракта:** было **46 paths / 52 operations / 85 schemas**,
стало **47 / 55 / 87** (+1 path, +3 operations, +2 schemas). `openapi-typescript`
синхронен; `frontend/src/api/schema.d.ts` обновлён через `npm run api:types`.
Существующие path/schema не менялись — только additive.

## 2. V27 — SECURITY DEFINER, атомарный лимит и роли

`backend/src/main/resources/db/migration/V27__workspace_member_management.sql`:

* `workspace.add_member(p_workspace_id, p_actor_id, p_email, p_role)` — `plpgsql`,
  `SECURITY DEFINER`, `search_path = pg_catalog, pg_temp`;
* `workspace.change_member_role(p_workspace_id, p_actor_id, p_target_user_id, p_role)` —
  то же;
* `workspace.remove_member(p_workspace_id, p_actor_id, p_target_user_id)` — то же,
  ставит `status = 'REMOVED'`, не удаляет строку и `joined_at`;
* причина SECURITY DEFINER: `auth.users` — FORCE RLS с self-only политикой (V2), поэтому
  обычный runtime-join не смог бы найти пользователя по email. Функции возвращают только
  каталожные поля (`user_id`, `display_name`, `role`, `joined_at`) и никогда email/ключи;
* каждая функция заново проверяет `p_actor_id = ops.current_user_id()` и ACTIVE
  OWNER/ADMIN membership в ACTIVE workspace. Вызов в обход HTTP-гарда (прямой SQL) для
  не-участника/подменённого actor возвращает `FORBIDDEN`;
* перед проверками дубля/лимита берётся transaction advisory lock
  `workspace.members|<workspace_id>`. Два одновременных add за последний слот
  сериализуются: один `201`, второй `409` (проверено конкурентным тестом);
* `max_workspace_members` читается из `ops.system_settings` в той же транзакции; лимит
  считается по ACTIVE-членствам, включая OWNER;
* duplicate проверяется по любой строке membership, включая `REMOVED`/`INVITED`:
  повторный add после удаления — явный `409 MEMBER_ALREADY_EXISTS`, а не тихое
  «воскрешение»;
* `EXECUTE` только `krug_app`, `PUBLIC` отозван; RLS-политики и гранты на таблицы не
  менялись. Owner функций — доверенная migration/BYPASSRLS роль (та же предпосылка, что
  у `ops.platform_overview()`, V23 и V24).

### Правила ролей (реализованы и в SQL, и покрыты тестами)

| Actor | Add | Change role | Remove |
|---|---|---|---|
| `OWNER` | `ADMIN`/`MEMBER`/`GUEST` | `ADMIN`/`MEMBER`/`GUEST`, кроме self | `ADMIN`/`MEMBER`/`GUEST`, кроме self |
| `ADMIN` | `MEMBER`/`GUEST` | только `MEMBER`/`GUEST` → `MEMBER`/`GUEST`; не self, не `OWNER`/другой `ADMIN` | только `MEMBER`/`GUEST`; не self, не `OWNER`/другой `ADMIN` |
| `MEMBER`/`GUEST`/outsider | `403 FORBIDDEN` | `403 FORBIDDEN` | `403 FORBIDDEN` |

* `OWNER` не назначается никому (`403 ROLE_CHANGE_FORBIDDEN`); в workspace ровно один
  OWNER (V2 partial unique index), поэтому «последний OWNER» — это и есть OWNER;
* понижение/удаление OWNER → `409 LAST_OWNER`; изменение/удаление себя (не OWNER) →
  `409 SELF_ACTION_FORBIDDEN`;
* no-op change role идемпотентен (`200`) и не пишет audit-событие.

## 3. Backend `workspace/members`

```
workspace/domain/model           WorkspaceMemberMutation (+ Outcome)
workspace/domain/repository      WorkspaceMemberManagementRepository
workspace/application/command    AddWorkspaceMemberCommand,
                                 ChangeWorkspaceMemberRoleCommand
workspace/application/service    WorkspaceMemberErrors, WorkspaceMemberRequests
workspace/application/usecase    AddWorkspaceMemberService,
                                 ChangeWorkspaceMemberRoleService,
                                 RemoveWorkspaceMemberService
workspace/infrastructure/...     WorkspaceMemberManagementRepositoryAdapter
                                 (native SQL, один вызов на операцию), JdbcInstants
workspace/api                    WorkspaceMemberController + Add/Change DTOs + mapper
```

* controller тонкий: валидация `@Valid` и трансляция в команды;
* use case активирует tenant context, вызывает одну SQL-функцию, маппит outcome в
  transport-neutral `DomainException` и пишет audit в той же транзакции;
* ошибки: `USER_NOT_FOUND`/`MEMBER_NOT_FOUND` → 404, `ALREADY_EXISTS`/лимит/self/last
  owner → 409, `FORBIDDEN`/`ROLE_CHANGE_FORBIDDEN` → 403, неизвестная роль → 400;
* ответы не содержат email/display name сверх контрактного `display_name`; audit
  metadata — только `role` и `previous_role`;
* audit actions: `workspace.member.added`, `workspace.member.role_changed`,
  `workspace.member.removed` в workspace hash-chain scope;
* удаление soft: строка и `joined_at` сохраняются, но все guard'ы проверяют `ACTIVE`,
  поэтому доступ пропадает на следующем запросе. Access-токены не отзываются (stateless
  JWT); `/me` продолжает работать, но workspace исчезает из активных членств.

Попутно `WorkspaceMemberRepositoryAdapter` переведён на общий `JdbcInstants` (тот же
разбор `timestamptz`), поведение E10 не изменено.

## 4. Tests

Добавлено **6 интеграционных тестов** (`WorkspaceMemberManagementIT`):

1. **add by email**: `201`, OpenAPI `WorkspaceMember`, поля/`joined_at`, член видит
   workspace и чаты, duplicate `409 MEMBER_ALREADY_EXISTS`, unknown `404 USER_NOT_FOUND`,
   audit `workspace.member.added` без email/display name, ответ без email;
2. **limit**: `max_workspace_members=2`, второй add → `409
   WORKSPACE_MEMBER_LIMIT_REACHED` с `details.scope/limit/used`; конкурентные два add за
   последний слот → ровно один `201` и один `409`, в БД 2 ACTIVE membership;
3. **roles**: OWNER повышает MEMBER→ADMIN и понижает ADMIN→MEMBER; ADMIN управляет
   MEMBER/GUEST, но не OWNER/другим ADMIN и не собой; OWNER не назначается; self-demote
   OWNER → `409 LAST_OWNER`; no-op не плодит audit; unknown target → `404
   MEMBER_NOT_FOUND`; audit `role_changed` с `previous_role`/`role`;
4. **non-admin/outsider**: все три операции MEMBER и outsider → `403 FORBIDDEN`, чужой/
   неизвестный workspace → `403`, состояние не меняется;
5. **removal**: `204` без тела, `status=REMOVED`, `joined_at` сохранён, audit
   `workspace.member.removed` без email, удалённый получает `403` на members и список
   чатов воркспейса, но `/me` с тем же токеном `200`; повторный add → `409`, повторный
   delete → `404`. Конкретный чат/сообщения дополнительно закрыты `ChatAccessService`,
   который первым делом требует ACTIVE workspace membership;
6. **RLS/bypass**: прямой SQL `workspace.add_member` от outsider и с подменённым actor →
   `FORBIDDEN`; unknown email → `USER_NOT_FOUND`; RLS не отдаёт чужой workspace/чужого
   user; у V27-функций нет `EXECUTE` для `PUBLIC`.

`ArchitectureTest` (10 правил) зелёный; domain не зависит от infrastructure/api,
application не использует JPA/HTTP, API не видит domain.

Полный suite: **453/453**, failures 0, errors 0, skipped 0. В это число входят
параллельные изменения других сессий; E12-B добавляет 6 тестов. Один ранее красный
`AdminActionsIT` (ожидание `EMAIL_NOT_VERIFIED` vs `ACCOUNT_SUSPENDED` после auth-фикса)
исправлен parent/auth-потоком; E12-B `LoginService`/error mapping не менял.

## 5. Security / contract notes

* **Authorization не доверяет клиенту**: actor role и membership читаются в БД внутри
  той же транзакции; `role` из запроса — только целевая роль.
* **Идемпотентность/гонки**: duplicate и лимит проверяются под per-workspace advisory
  lock; partial unique index V2 (`ux_memberships_one_owner`) остаётся последним
  backstop'ом для OWNER.
* **Утечки**: API-ответы и audit не содержат email; `USER_NOT_FOUND` намеренно
  различает unknown email (требование FR-WS-5) — это email-existence oracle, доступный
  только OWNER/ADMIN workspace.
* **Удалённый доступ**: soft removal не отзывает JWT; это осознанно, авторизация
  пересчитывается на каждом запросе. Активные WS-сессии не закрываются (требование
  «active sessions? no»); после удаления их запросы получают 403.
* **Приглашения**: не реализованы (v1.1); добавить можно только существующий ACTIVE
  аккаунт.
* **RLS**: политики не ослаблены; SECURITY DEFINER функции узкие, с фиксированным
  `search_path`, проверкой actor и `GRANT EXECUTE` только `krug_app`.
* **Contract**: изменения только additive; `WorkspaceMember`/`WorkspaceMemberPage` не
  переопределены.

## Риски / follow-up

* `frontend/scripts/check-contract.mjs` всё ещё пинит `46 paths / 85 schemas`;
  реальные значения после E12-B — `47 / 87`. Скрипт вне зоны E12-B; E12-F должен
  обновить счётчики (и, при необходимости, карту операций). Генерация
  `schema.d.ts` уже синхронна — первая проверка drift-guard проходит.
* Нет отдельного rate limit на member mutations; злоупотребление возможно только
  OWNER/ADMIN и ограничено размером workspace. При необходимости — edge/Redis limiter
  в следующем слое.
* Нет endpoint'а «восстановить удалённого» и передачи OWNER; повторный add после
  удаления даёт `409` (осознанно). Передача OWNER — отдельная фича (v1.1+).
* `USER_NOT_FOUND` раскрывает существование email владельцу/админу workspace; это
  требование контракта, но стоит помнить при публичном развёртывании.

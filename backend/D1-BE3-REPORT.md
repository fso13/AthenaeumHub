# D1-BE3 — chat settings PATCH (name/description) + audit

> Формат — `docs/TASKS.md` §5. Зона сессии: `backend/**`, additive-правки
> `contracts/**`, регенерация `frontend/src/api/schema.d.ts`. Остальной `frontend/**`,
> `docs/**`, `design/**`, `deploy/**` не менялись; порт `8080` не трогался. Git-репозитория
> в рабочем дереве нет, поэтому «одним PR» проверить нельзя — изменения согласованы в
> рабочем дереве.

## Статус

**DONE в границах D1-BE3.** Реализованы настройки чата из
`docs/TASKS-DASHBOARD-V1.md` §3.4, §5.3:

* `PATCH /chats/{chatId}` `{name?, description?}` → `200 Chat` (полный view);
* правит только ACTIVE workspace `OWNER`/`ADMIN`; `MEMBER`/`GUEST` → `403`, чужой/
  неизвестный/удалённый чат → `404`;
* `name` trim/collapse, 1..120 code points; `description` trim, ≤ 500 code points,
  `""` очищает в `null`; строки — plain text без HTML/control;
* immutable E2EE policy: в E2EE-чате `name` разрешён, `description` (включая очистку)
  отклоняется `422 CHAT_SETTINGS_E2EE_UNSUPPORTED` без частичного применения;
* audit `chat.updated` — только имена изменённых полей, без значений/контента;
* `ChatSummary.description` / `Chat.description` — additive, nullable; list и PATCH
  отдают описание;
* миграция V30: колонка/CHECK + узкая `chat.settings_scope` для workspace-ролей.

Полный backend suite — **498/498**, `ArchitectureTest` — **10/10** (JDK 21).
`frontend/src/api/schema.d.ts` регенерирован; `npm run contract:check` красный только на
захардкоженных счётчиках `47 paths / 87 schemas` (реально `48 / 88`) — это зона
frontend-гарда, вне `backend/**` + `schema.d.ts`; см. «Риски».

## 1. Contract (additive)

`contracts/openapi.yaml`:

* новый path `PATCH /chats/{chatId}` (`operationId: updateChat`), параметры `ChatId` +
  `X-Device-Id`, тело `ChatUpdateRequest`, ответ `200 Chat`;
  документированы `400/401/403/404/409/422`;
* `ChatUpdateRequest` — `{name?: string|null, description?: string|null}`,
  `additionalProperties: false`; описание фиксирует trim/collapse, 1..120, 500,
  `description: ""` = очистка, plain text, E2EE-reject и «минимум одно поле»;
* `Chat.description: string|null` (`maxLength: 500`) — additive; поле не добавлено в
  `required`, старые клиенты не ломаются;
* `ChatSummary.description: string|null` (`maxLength: 500`) — additive, optional;
* в описание `Error.code` добавлены `CHAT_SETTINGS_E2EE_UNSUPPORTED` (422) и
  `VALIDATION_FAILED` для невалидного/пустого патча.

**Фактические счётчики контракта:** было **47 paths / 55 operations / 87 schemas**,
стало **48 / 56 / 88** (+1 path, +1 operation, +1 schema). `openapi-typescript`
синхронен: `frontend/src/api/schema.d.ts` обновлён через `npm run api:types`
(`ChatUpdateRequest`, `description` в `Chat`/`ChatSummary`, `updateChat` присутствуют).

## 2. V30 — схема, DB-backstop и workspace-scope

`backend/src/main/resources/db/migration/V30__chat_settings.sql`:

* `chat.chats.description text` — nullable, plain-text описание;
* `ck_chats_name_length`: `name IS NULL OR char_length(name) BETWEEN 1 AND 120`;
* `ck_chats_description_length`: `description IS NULL OR char_length(description) <= 500`;
  PostgreSQL `char_length` считает code points, поэтому emoji не «съедают» лимит
  (проверено unit-тестом на 120/500 code points);
* `chat.settings_scope(p_chat_id, p_user_id)` — `STABLE`, `SECURITY DEFINER`,
  `search_path = pg_catalog, pg_temp`; возвращает `workspace_id, workspace_role` для
  живого чата и ACTIVE-члена ACTIVE-воркспейса. Внутри дополнительно требуется
  `p_user_id = ops.current_user_id()`, поэтому principal нельзя подменить прямым SQL;
* `EXECUTE` только `krug_app`, `PUBLIC` отозван; RLS-политики и гранты на таблицы не
  менялись;
* **Почему функция:** URL `PATCH /chats/{chatId}` не содержит workspace, а `chat.chats`/
  `workspace.memberships` — FORCE RLS. Обычный runtime-SELECT не может найти workspace до
  установки workspace GUC, а `ChatWorkspacePort` требует членства **в чате**, тогда как
  D1-BE3 авторизует по **workspace-ролям**: ADMIN, добавленный в воркспейс после
  создания чата, должен иметь право править настройки. Узкая функция решает оба
  требования и не расширяет видимость таблиц.

Rollback (forward-only): `DROP FUNCTION chat.settings_scope`; снять оба CHECK; удалить
колонку `description`. Данные описаний при откате теряются; остальные данные чата не
затрагиваются.

## 3. Backend

```
chat/domain/model          Chat (+description,+createdAt, withSettings),
                           ChatSettingsScope (+canManage), ChatSummary (+description)
chat/domain/service        ChatSettingsPolicy (trim/bounds/plain-text/E2EE)
chat/domain/repository     ChatRepository (+findSettingsScope, +updateDetails)
chat/infrastructure/...    ChatEntity (+description,+created_at),
                           ChatPersistenceMapper, ChatRepositoryAdapter
chat/application/command   ChatUpdateCommand
chat/application/model     ChatView/ChatSummaryView (+description)
chat/application/usecase   ChatUpdateService (+audit), ChatQueryService, ChatCreateService
chat/api                   ChatController#updateChat, ChatUpdateRequest, ChatApiMapper
```

* **Порядок.** `ChatUpdateService`: пустой патч → `422`; активируется user-GUC;
  `chat.settings_scope` → `404`/`403`; активируется workspace-GUC; читается чат;
  E2EE-проверка; нормализация; UPDATE; audit; ответ.
* **Права.** `OWNER`/`ADMIN` воркспейса; чат-роль (`chat_members.role`) намеренно не
  используется — это соответствует §3.4. `MEMBER`/`GUEST` → `403 FORBIDDEN`; outsider,
  unknown, soft-deleted и чужой чат → `404` (существование не раскрывается). Проверено
  и для ADMIN без членства в чате.
* **Валидация.** `ChatSettingsPolicy`:
  * `name`: `strip`, внутренние пробелы схлопываются; 1..120 code points; `<`/`>` и
    control/bidi-control запрещены; 422 с `details.field=name/max_length`;
  * `description`: CRLF → LF, `strip`; пустая строка → `null`; ≤500 code points;
    `\n`/`\t` разрешены, остальные control и `<`/`>` запрещены; 422 с
    `details.field=description/max_length`;
  * пустой патч (`{}`/только null) → `422 VALIDATION_FAILED`, `details.reason=empty_patch`.
* **E2EE.** `ChatSettingsPolicy.requireDescriptionAllowed(e2ee)` вызывается до любых
  изменений; `description` (даже `""`) → `422 CHAT_SETTINGS_E2EE_UNSUPPORTED`. `name`
  разрешён (E2EE в E7 — только DIRECT, поэтому это единственный способ задать label).
  `security_mode` не обновляется и защищён V16-триггером.
* **Audit.** В той же транзакции: action `chat.updated`, target `chat/{id}`, metadata
  `{"fields":["name","description"]}` — только имена изменённых полей, без значений,
  описания, сообщений или файлов. Ошибка audit откатывает UPDATE.
* **Ответ.** Полный `Chat`: `id/type/security_mode/name/description/peer_id/
  peer_has_e2ee_capable_devices/last_seq/unread_count/created_at` (для workspace-ADMIN
  без членства в чате `unread_count=0`, `created_at` из `chat.chats`). Существующий
  список `GET /workspaces/{id}/chats` теперь отдаёт `description` в каждой
  `ChatSummary`. Отдельного `GET /chats/{chatId}` в контракте не было и в этом срезе не
  добавлялся.
* **Идемпотентность/конкурентность.** По ТЗ не требуются: нет `Idempotency-Key`, нет
  `version`/optimistic-lock; поведение — last-write-wins. No-op (то же значение) не
  схлопывается: успешный PATCH всегда пишет audit. Если чат удалён между чтением и
  UPDATE, `updateDetails` возвращает `false` → `404`, audit не пишется.

## 4. Tests

Добавлено **12 тестов** (486 → **498**):

| Класс | + | Что покрыто |
|---|---:|---|
| `ChatSettingsPolicyTest` | 7 | trim/collapse, 1..120 и 500 code points (включая emoji), HTML/control/bidi, CRLF, пустое описание → null, E2EE-код |
| `ChatSettingsIT` | 4 | owner PATCH + list + audit только имена полей; очистка описания; 6 validation-кейсов без side effects; unknown/deleted/foreign → 404; MEMBER/GUEST → 403; ADMIN без членства в чате → 200; `settings_scope`/spoof/grants/constraints/RLS |
| `E2eeChatSettingsIT` | 1 | E2EE: `description`/`description:""`/combined → 422 без изменений и audit; `name` → 200; list `description=null`; audit только `name` |

Ключевые проверки:

* `PATCH {name:"  Product   Team  ", description:"  hello\r\nworld  "}` →
  `200 Chat`, `name="Product Team"`, `description="hello\nworld"`; список отдаёт то же;
* `description:""` → `200`, `description:null` и в PATCH, и в списке;
* 121-символьное имя, пустое имя, `<b>`, 501-символьное описание, `<script>`, `{}` →
  `422 VALIDATION_FAILED`; имя/описание в БД не меняются, audit не растёт;
* MEMBER и GUEST, добавленные через E12, получают `403`; outsider/unknown/deleted/
  foreign — `404`; после повышения MEMBER→ADMIN тот же PATCH → `200` (чат-членство не
  требуется);
* audit `chat.updated`: `target_type=chat`, metadata содержит `fields/name/description`
  и **не содержит** значений;
* прямой SQL: `chat.settings_scope` под owner → `OWNER`, под member → `MEMBER`, под
  outsider/со спуфленным `p_user_id` → 0 строк; `prosecdef=true`, `PUBLIC` без EXECUTE,
  `krug_app` с EXECUTE; оба CHECK валидированы; `UPDATE` с 501/121 символом падает на
  constraint; RLS не отдаёт чужой чат;
* E2EE: combined name+description не применяет name (атомарность), audit появляется
  только после успешного name-only PATCH.

`ArchitectureTest` — **10/10**: domain/application/api разложены по слоям, API не видит
domain, application не использует JPA, контроллер в `chat/api`, DTO в `chat/api/dto`.

Команды:

```bash
cd backend
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
mvn -o -Dmaven.repo.local=.m2repo test
# Tests run: 498, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS
# ArchitectureTest: Tests run: 10, Failures: 0, Errors: 0

cd ../frontend
npm run api:types
# contracts/openapi.yaml -> src/api/schema.d.ts (openapi-typescript 7.13.0)
npm run contract:check
# FAIL: "Contract must expose exactly 47 paths" / "exactly 87 schemas"
# реально 48 / 88; schema.d.ts синхронен. Скрипт вне зоны D1-BE3 (frontend/**).
```

## 5. Security

* **Authorization.** Роль берётся из `workspace.memberships` в БД, не из JWT/запроса;
  `security_mode` из тела не применяется. Chat-роль не повышает права MEMBER/GUEST.
* **Existence hiding.** `settings_scope` возвращает строку только ACTIVE-члену
  ACTIVE-воркспейса; outsider/чужой/удалённый чат неотличимы от несуществующего (`404`).
  `MEMBER`/`GUEST` видят `403`, потому что они уже подтверждённые участники воркспейса.
* **E2EE.** `description` не сохраняется; `name` — только label. E2EE-контент, ключи и
  конверты не читаются и не меняются. `security_mode` immutable (V16 trigger).
* **Input.** Нормализация/границы в домене; `<`/`>` и control/bidi-control отклоняются;
  значения не интерполируются в SQL/HTML/пути, биндятся как параметры.
* **Audit.** Только имена полей; ни имени, ни описания, ни контента, ни plaintext.
  Событие в workspace hash-chain scope, append-only политика не менялась.
* **RLS/grants.** Политики не ослаблены; функция узкая, `SECURITY DEFINER` с
  фиксированным `search_path`, проверкой `current_user_id()`, `EXECUTE` только
  `krug_app`.
* **Rate limit.** Отдельного лимита на PATCH нет; операция доступна только OWNER/ADMIN
  и ограничена размерами workspace. При необходимости — edge/Redis limiter (follow-up).

## 6. Риски / follow-up

1. **`frontend/scripts/check-contract.mjs`** пинит `47 paths / 87 schemas` и не знает про
   новый path; реальные значения — `48 / 88`. Скрипт вне зоны D1-BE3 (`frontend/**`,
   кроме `schema.d.ts`) и намеренно не менялся. Нужен frontend-гард-апдейт (D1-FE/QA):
   поднять счётчики и добавить `PATCH /chats/{chatId}` в карту операций.
2. **Нет отдельного `GET /chats/{chatId}`.** PATCH возвращает полный `Chat`, список —
   `ChatSummary` с `description`; если FE-настройкам нужен detail-endpoint, это
   отдельная additive-операция (D1-FE5/contract).
3. **Нет WS-события `chat.updated`.** Другие участники увидят новое имя/описание после
   refetch; realtime-нотификация настроек не входила в D1-BE3. При необходимости —
   отдельный outbox/WS event с теми же metadata-only полями.
4. **Last-write-wins.** Идемпотентность/optimistic-lock по ТЗ не нужны; два OWNER/ADMIN
   могут перезаписать друг друга. `version` в `chat.chats` есть, но не используется.
5. **No-op audit.** Повтор с теми же значениями пишет второе событие `chat.updated`
   (идемпотентность не требуется). Если нужен «audit только при изменении» — сравнение
   значений в `ChatUpdateService` (точечно).
6. **V30 CHECK на существующих данных.** `ck_chats_name_length` проверяет и старые
   строки; при наличии legacy-имени >120 символов миграция упадёт. Существующий create
   path уже ограничивал 120, поэтому на текущих данных риск низкий; на большой БД
   `ALTER TABLE ... ADD CHECK` берёт блокировку — при необходимости `NOT VALID` +
   `VALIDATE CONSTRAINT` отдельной ops-миграцией.
7. **DIRECT name override.** PATCH разрешает задать `name` и для DIRECT (иначе нельзя
   было бы выполнить «E2EE — только name», т.к. E2EE в E7 только DIRECT). Клиент
   по-прежнему может выводить display name из peer; серверное значение — additive
   override. Продуктовое решение «показывать ли override в DIRECT» — D1-FE.
8. **`ChatSettingsPolicy` запрещает `<`/`>`.** Это осознанно (plain text, no HTML);
   легитимные «<3»/«a > b» в описании будут отклонены. Если продукту нужен более
   мягкий вариант — хранить как есть и полагаться только на React-escaping (не
   рекомендуется для audit/логов).

## 7. Изменённые файлы

Backend main:

* `backend/src/main/resources/db/migration/V30__chat_settings.sql`
* `backend/src/main/java/ru/krug/backend/chat/domain/model/{Chat,ChatSummary,ChatSettingsScope}.java`
* `backend/src/main/java/ru/krug/backend/chat/domain/service/ChatSettingsPolicy.java`
* `backend/src/main/java/ru/krug/backend/chat/domain/repository/ChatRepository.java`
* `backend/src/main/java/ru/krug/backend/chat/infrastructure/persistence/{ChatEntity,ChatPersistenceMapper,ChatRepositoryAdapter}.java`
* `backend/src/main/java/ru/krug/backend/chat/application/command/ChatUpdateCommand.java`
* `backend/src/main/java/ru/krug/backend/chat/application/model/{ChatView,ChatSummaryView}.java`
* `backend/src/main/java/ru/krug/backend/chat/application/usecase/{ChatUpdateService,ChatQueryService,ChatCreateService}.java`
* `backend/src/main/java/ru/krug/backend/chat/api/{ChatController}.java`
* `backend/src/main/java/ru/krug/backend/chat/api/dto/{ChatUpdateRequest,ChatResponse,ChatSummaryResponse}.java`
* `backend/src/main/java/ru/krug/backend/chat/api/mapper/ChatApiMapper.java`
* `backend/src/main/java/ru/krug/backend/shared/error/ErrorCode.java`

Тесты:

* `backend/src/test/java/ru/krug/backend/unit/ChatSettingsPolicyTest.java`
* `backend/src/test/java/ru/krug/backend/integration/ChatSettingsIT.java`
* `backend/src/test/java/ru/krug/backend/integration/E2eeChatSettingsIT.java`

Contracts / generated:

* `contracts/openapi.yaml`
* `frontend/src/api/schema.d.ts` (регенерация)
* `backend/D1-BE3-REPORT.md` (этот файл)

## 8. Приёмка D1-BE3

| Пункт | Статус |
|---|---|
| `PATCH /chats/{chatId}` `{name?, description?}` → `200 Chat` | ✅ |
| `ChatSummary.description` additive/null, list отдаёт описание | ✅ |
| name 1..120, description ≤500 (documented) | ✅ |
| 403/404/409/422 документированы | ✅ |
| только workspace OWNER/ADMIN; member/guest 403 | ✅ |
| E2EE: name разрешён, description → `CHAT_SETTINGS_E2EE_UNSUPPORTED` | ✅ |
| trim/plain text/no HTML; пустой патч 422 | ✅ |
| audit `chat.updated`, metadata — только имена полей | ✅ |
| без content/plaintext в audit | ✅ |
| no idempotency/no optimistic-lock | ✅ |
| response full chat, list/detail includes description | ✅ (detail-endpoint отсутствовал) |
| full suite 486+ | ✅ 498/498 |
| ArchUnit | ✅ 10/10 |
| contract counts/report | ✅ 48/56/88, schema.d.ts synced; frontend count guard — follow-up |
| no member API changes | ✅ |

## 9. Status

**DONE.** Единственный внешний красный сигнал — захардкоженные счётчики
`frontend/scripts/check-contract.mjs` (`47/87`), которые находятся вне зоны D1-BE3;
сам контракт валиден, `frontend/src/api/schema.d.ts` синхронен.

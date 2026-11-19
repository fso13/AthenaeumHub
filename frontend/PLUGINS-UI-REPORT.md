# D1 — Frontend плагинов: каталог и состояние в чате

> Зона: только `frontend/**`. `backend/**`, `contracts/**`, `docs/**`,
> `design/**` и `frontend/src/api/schema.d.ts` не менялись. Контракт в дереве —
> источник истины; типы плагинов берутся из уже сгенерированного `schema.d.ts`.
> Git-репозитория в рабочем дереве нет, поэтому дифф согласован в рабочем дереве.

## Статус

**DONE.** Реализованы typed API, серверный (без оптимистичных мутаций) read model,
страница каталога с per-chat переключателями, строка плагинов в `ChatDetails`,
MSW-хендлеры и тесты (unit + D1 e2e).

- full frontend suite — **977/977** (было 962; +15 новых);
- `npm run check` — **exit 0** (lint, prettier, contract, stickers, security,
  session-writers, tests, production build);
- D1 e2e — **36/36** (включая 3 новых плагинных сценария);
- backend/contracts/design/schema не тронуты; marketplace/install/выполнение кода
  отсутствуют.

## 1. API (typed)

`frontend/src/api/types.ts` добавлены алиасы из сгенерированной схемы:

```ts
(Plugin,
  PluginList,
  PluginPermission,
  PluginMode,
  PluginCatalogState,
  ChatPluginState,
  ChatPluginStateList,
  ChatPluginUnavailableReason,
  ChatPluginUpdateRequest);
```

`frontend/src/api/endpoints.ts` — `ChatApi` и реализация:

```ts
listPlugins(): Promise<PluginList>;                                  // GET /plugins
listChatPlugins(chatId): Promise<ChatPluginStateList>;               // GET /chats/{id}/plugins
updateChatPlugin(chatId, pluginId, body): Promise<ChatPluginState>;  // PATCH /chats/{id}/plugins/{pluginId}
```

`PATCH` шлёт ровно `{enabled}`, пути кодируются `encodeURIComponent`; все вызовы
проходят через общий `withReauth` и `X-Device-Id` клиента. `GET /plugins`
не требует device/workspace/chat — контракт это не объявляет.

## 2. Read model

`frontend/src/plugins/store.ts` — отдельный `PluginsStore`, подключён к
`ChatStore` (`store.plugins`, dispose/reset при logout), хуки
`usePluginsStore`/`usePluginsState` в `ChatProvider`.

Состояние: `catalogStatus/catalog/catalogError`, `chatId/chatStatus/chatStates/
chatError`, `pendingPluginIds`, `toggleError`, `lastToggle`.

- `ensureCatalog()` / `ensureChat(chatId)` дедуплицируют запросы; переключение
  чата сбрасывает прошлые строки;
- **нет оптимистичного обновления**: `toggle()` не меняет `chatStates` до ответа
  сервера, на время PATCH id попадает в `pendingPluginIds`;
- после ответа заменяется только одна строка `ChatPluginState`; `changed`
  вычисляется сравнением предыдущего серверного значения с ответом;
- ошибка PATCH не трогает последнее известное серверное состояние;
- `reset()` очищает всё при выходе/смене аккаунта.

`frontend/src/plugins/model.ts` — закрытые словари контракта
(`MESSAGES/MEMBERS/FILES/WEBHOOKS`, `MANAGED/E2EE`), policy
`pluginUnavailableReason()` (kill switch приоритетнее режима), `pluginStateMap`,
`enabledPluginCount`. Эти же helper'ы использует MSW.

## 3. `PluginsPage`

`frontend/src/components/pages/PluginsPage.tsx`:

- каталог из `GET /plugins` — ровно 5 серверных first-party плагинов; ничего не
  дорисовывается. `name/description/icon/permissions/modes/state` — серверные;
  `icon` — закрытый токен (`poll/task/translate/plug/shield`), неизвестный токен
  даёт нейтральную иконку, не URL/HTML;
- карточки: иконка, описание, chips разрешений и контуров, kill-switch
  (`Отключён в каталоге`);
- per-chat состояние: select групповых чатов (по умолчанию активный GROUP,
  иначе первый GROUP), затем `GET /chats/{id}/plugins`. Показаны
  `Включено X из Y`, режим чата и количество плагинов;
- переключатель `role="switch"` с `aria-checked`; **включён только для
  OWNER/ADMIN**, доступного плагина, загруженного состояния и не во время PATCH;
- честные причины: «Только владелец или администратор чата», «Недоступен в
  E2EE», «Отключён в каталоге», «Состояние загружается…», «Нет группового чата»;
- E2EE: отдельный баннер о том, что в каталоге только серверные `MANAGED`-
  плагины и клиентских нет; все переключатели disabled — это ограничение, а не
  ошибка UI;
- loading / empty / error + retry отдельно для каталога и состояния чата;
- audit feedback: после реального изменения — «Плагин «X» включён/выключен.
  Изменение записано в журнал аудита»; no-op ответ сервера честно сообщает, что
  значение уже было и событие аудита не писалось; `403` — отдельный текст;
- нет marketplace/install/версий/подписей/запуска — только каталог и
  переключатели; action в шапке — «Обновить», а не фейковая установка.

Роль для affordance: в `ChatSummary` и `ChatPluginState` роли нет. UI берёт
`activeWorkspace.role`; для dev-профиля, где workspace-роль не заполняется,
падением является уже загруженный справочник участников. Сервер всё равно
проверяет chat `OWNER`/`ADMIN`, и `403` показывается честно.

## 4. `ChatDetails`

Строка «Плагины чата» больше не показывает `—` и не притворяется выключенной:

- при открытии панели лениво вызывает `ensureChat(chat.id)` (только GROUP);
- count = число серверных `enabled` для этого чата; при loading/error — `—`;
- разворот показывает «X из Y включено» / «Ни один плагин не включён»,
  E2EE-пояснение либо подсказку про права и аудит, retry при ошибке;
- кнопка «Открыть плагины» ведёт на страницу; страница выбирает этот же чат,
  потому что активный чат сохранён в store;
- для E2EE кнопка остаётся доступной: страница честно объясняет недоступность.

## 5. MSW

`frontend/src/mocks/db.ts` — seed из V34 (5 плагинов, порядок
`polls/tasks/translate/telegram/dlp`, `modes=['MANAGED']`, `state='ACTIVE'`),
`chatPlugins`, audit-массив и наблюдаемые запросы.

`frontend/src/mocks/handlers.ts`:

- `GET /plugins` — Bearer, без обязательного `X-Device-Id`, стабильный порядок;
- `GET /chats/:chatId/plugins` — membership/404, `available/reason` из той же
  policy, что backend; E2EE → `PLUGIN_NOT_AVAILABLE`;
- `PATCH /chats/:chatId/plugins/:pluginId` — chat OWNER/ADMIN, unknown plugin
  `404 PLUGIN_NOT_FOUND`, E2EE/kill switch `422`, strict boolean `400`,
  идемпотентность и audit только при реальном изменении;
- injectable: задержки, forced errors каталога/чтения/PATCH, счётчики запросов.

Для e2e добавлен mock-контрол `__krugChatModes`
(`frontend/src/mocks/browser.ts`) — позволяет прогнать E2EE-политику без
настоящих ключей.

## 6. Тесты

| Файл                              |   + | Покрытие                                                                                                                                                                                                      |
| --------------------------------- | --: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/plugins.test.ts`         |   5 | typed catalog/state/toggle, идемпотентность + audit, unknown plugin, E2EE 422, 403 MEMBER                                                                                                                     |
| `src/components/Plugins.test.tsx` |  10 | 5 карточек/разрешения/контуры; per-chat переключение; отсутствие optimistic update; ошибка PATCH/403; no-op audit; права MEMBER; E2EE; retry каталога; retry состояния; axe; count + переход из `ChatDetails` |
| `e2e/d1-plugins.spec.ts`          |   3 | catalog → toggle → details count + axe; MEMBER disabled; E2EE honest + axe                                                                                                                                    |

Обновлены существующие ожидания: `Dashboard.test.tsx` (страница больше не
«недоступна», 5 switch'ей), `e2e/d1-visual-2.spec.ts` (5 карточек, 5 switch'ей).

```
npm run test        → 91 files, 977 tests passed
npm run check       → exit 0
npx playwright test → 36/36 passed (D1, system Chrome)
```

## 7. Контрактный guard

В дереве контракт уже содержит больше операций, чем в backend-отчёте #69:
**57 paths / 67 operations / 103 schemas** (добавились `PATCH /me`,
`GET /me/sessions`, `DELETE /me/sessions/{sessionId}`, `GET /files`), а
`MeResponse.user` стал `$ref: AuthUser`. Поэтому `frontend/scripts/check-contract.mjs`
обновлён: счётчики 57/67/103 и резолв `$ref` для проверки обязательных полей
`user`. `schema.d.ts` синхронен, `contract:check` зелёный. Это единственная
правка вне плагинной темы и она относится к frontend-гарду; контракт не менялся.

## 8. Ограничения / follow-up

1. **Роль чата не отдаётся контрактом.** `GET /chats/{id}/plugins` возвращает
   только `plugin_id/enabled/available/reason`, `ChatSummary` роли не имеет.
   UI использует workspace-роль как affordance; настоящий chat `OWNER` с
   workspace-ролью `MEMBER` увидит disabled-переключатели до появления
   `can_manage`/`role` в контракте. Серверная авторизация при этом корректна, а
   `403` показывается честно. Это главный follow-up.
2. **Нет WS-события `chat.plugin.changed`.** Другой участник увидит новое
   состояние после refetch/повторного открытия (бэкенд это также отмечает).
3. **Audit feedback без чтения аудита.** Контракт не даёт проверять событие;
   UI выводит факт аудита только для реального изменения (сравнение предыдущего
   серверного значения с ответом), а для no-op — честное «событие не писали».
4. **`enabled` для недоступного плагина.** Счётчик считает серверные `enabled`;
   при будущем kill switch уже включённого плагина UI всё равно блокирует
   переключатель по `available`, а бэкенд отдаёт сохранённое значение.
5. **Окружение e2e.** В этой машине не установлен bundled Chromium Playwright,
   поэтому штатный `npm run test:e2e:d1` падает на `browserType.launch`.
   Те же 36 D1-тестов прогнаны с временным конфигом `channel: 'chrome'`
   (системный Google Chrome) — 36/36; временный конфиг удалён. В CI с
   установленным браузером штатная команда должна работать без изменений.
6. **Установка/marketplace/исполнение** отсутствуют by design; в каталоге нет
   клиентского `stickers` — как и в V34.

## 9. Изменённые файлы

Код:

- `frontend/src/api/types.ts`
- `frontend/src/api/endpoints.ts`
- `frontend/src/plugins/model.ts` (new)
- `frontend/src/plugins/store.ts` (new)
- `frontend/src/store/ChatProvider.tsx`
- `frontend/src/store/chatStore.ts`
- `frontend/src/components/pages/PluginsPage.tsx`
- `frontend/src/components/ChatDetails.tsx`
- `frontend/src/i18n/ru.ts`
- `frontend/src/styles/app.css`

MSW:

- `frontend/src/mocks/db.ts`
- `frontend/src/mocks/handlers.ts`
- `frontend/src/mocks/browser.ts`

Тесты:

- `frontend/src/api/plugins.test.ts` (new)
- `frontend/src/components/Plugins.test.tsx` (new)
- `frontend/src/components/Dashboard.test.tsx`
- `frontend/e2e/d1-plugins.spec.ts` (new)
- `frontend/e2e/d1-helpers.ts`
- `frontend/e2e/d1-visual-2.spec.ts`

Гард:

- `frontend/scripts/check-contract.mjs`

Отчёт:

- `frontend/PLUGINS-UI-REPORT.md` (этот файл)

## 10. Приёмка

| Пункт                                                                 | Статус                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| typed `listPlugins` / `listChatPlugins` / `updateChatPlugin`          | ✅                                                                |
| каталог 5 built-in, permissions/modes, description/icon               | ✅                                                                |
| per-chat `enabled/available/reason`, переключатель только OWNER/ADMIN | ✅ (affordance по workspace-роли, сервер — chat-роль, см. §8.1)   |
| E2EE unavailable честно                                               | ✅                                                                |
| loading / empty / error / retry                                       | ✅                                                                |
| без оптимистичных обновлений, сервер — источник истины                | ✅                                                                |
| audit feedback                                                        | ✅                                                                |
| `ChatDetails`: enabled count и переход в страницу/состояние           | ✅                                                                |
| MSW: catalog/state/toggle/permissions/E2EE/errors                     | ✅                                                                |
| tests: axe на странице                                                | ✅                                                                |
| full `npm run check`                                                  | ✅ 977/977                                                        |
| D1 e2e                                                                | ✅ 36/36 (system Chrome; bundled browser в окружении отсутствует) |
| marketplace/install и выдуманные плагины                              | ✅ отсутствуют                                                    |
| backend/contracts/docs/design/schema не изменены                      | ✅                                                                |

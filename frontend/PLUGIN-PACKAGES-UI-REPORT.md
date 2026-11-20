# D1.2 (#86) — внешние плагины: admin UI, sandbox-раннер, MSW (frontend)

> Зона: `frontend/**`. Backend #86 (`admin ZIP packages`, static assets,
> `docs/PLUGIN-DEVELOPMENT.md`, contract 102/134/173) уже готов и не менялся.
> Ниже зафиксированы только изменения этого среза.

## Статус

**DONE в границах frontend #86.** Реализованы:

- admin API-клиент: список установленных external-пакетов, установка ZIP
  (`multipart/form-data`, прогресс, отмена через `AbortSignal`), удаление;
- аутентифицированное чтение ассетов пакета по контрактному `entry_url`;
- внешние карточки в каталоге `/plugins` (`kind=EXTERNAL`, версия, автор,
  permissions/modes) и полноэкранный sandbox-раннер `iframe sandbox="allow-scripts"`
  без `allow-same-origin`;
- minimal host-side postMessage-контракт из `docs/PLUGIN-DEVELOPMENT.md`;
- admin-вкладка `/admin?tab=plugins`: drag&drop/file picker, прогресс, ошибки
  размера/ZIP/manifest/traversal, список установленных пакетов, подтверждённое
  удаление, ссылка на developer docs;
- MSW-моки и тесты: list/install valid/install error/uninstall/assets, sandbox
  атрибуты iframe, axe.

Полный `npm run check` — зелёный: **1188/1188** тестов, 110 файлов.

## 1. Контракт и API-клиент

Использованы существующие operationId контракта (без правок `contracts/**`):

| Метод    | Путь                                     | Клиент                                                   |
| -------- | ---------------------------------------- | -------------------------------------------------------- |
| `GET`    | `/admin/plugins`                         | `api.listAdminPlugins()`                                 |
| `POST`   | `/admin/plugins`                         | `api.installPluginPackage(file, { onProgress, signal })` |
| `DELETE` | `/admin/plugins/{pluginId}`              | `api.uninstallPluginPackage(id)`                         |
| `GET`    | `/plugins/{pluginId}/assets/{assetPath}` | `api.getPluginAsset(entryUrl, assetPath?)`               |

`GET /plugins` уже отдаёт `kind/version/author/entry_url`; типы взяты из
регенерированного `schema.d.ts` (`Plugin`, `AdminPluginPackage`,
`AdminPluginPackageList`).

### 1.1 Multipart без компромиссов

`ApiClient.postFormData`:

- кодирует `FormData` в multipart-байты один раз (свой boundary), поэтому
  одинаково работает через `XMLHttpRequest` (реальный прогресс загрузки в
  браузере) и через `fetch`-fallback;
- не добавляет `Authorization`/`X-Device-Id` в URL — только заголовки;
- возвращает контрактные `ApiError` (400/413/409/403) и учитывает
  `AbortSignal`;
- тело ограничено одним файлом; ZIP ≤ 5 MiB проверяется и на клиенте.

### 1.2 URL ассетов

`src/plugins/assets.ts` — чистые помощники:

- `parsePluginAssetUrl(entry_url)` принимает только
  `/plugins/{id}/assets/{path}` (в т.ч. абсолютный URL → pathname);
- `pluginAssetApiPath` убирает префикс `/api/v1`, чтобы не получить двойной
  base path;
- `resolveRelativeAssetPath` резолвит ссылки внутри пакета и запрещает
  `..`, `.`, абсолютные и protocol-relative URL, `\`, пустые сегменты;
- `validatePluginPackageFile` — дешёвая клиентская проверка (пустой файл,
  расширение, 5 MiB, явно не-zip MIME).

## 2. Каталог `/plugins`

`PluginsPage` разделён на две секции:

- **Встроенные плагины** — прежние карточки/переключатели (D1.1), поведение не
  изменено;
- **Внешние плагины** — карточки `kind=EXTERNAL` с бейджем «Внешний пакет»,
  версией, автором, permissions/modes и кнопкой «Открыть».

Правила:

- кнопка «Открыть» активна только при `state=ACTIVE` и наличии `entry_url`;
- платформенный администратор видит «Управление пакетами» → `/admin?tab=plugins`;
  остальные пользователи этой кнопки не видят;
- переключатель per-chat остаётся серверным (`PATCH /chats/{chatId}/plugins/{id}`)
  без оптимистичных изменений; для E2EE-чата external-карточка показывает ту же
  недоступность, что и built-in, но открытие static-панели не блокируется
  (пакет не получает серверных данных);
- пустой external-каталог — честный empty state, без выдуманных плагинов.

## 3. Sandbox-раннер external-плагина

`src/components/plugins/ExternalPluginRunner.tsx` + `src/plugins/externalDocument.ts`.

### 3.1 Почему не `src={entry_url}`

Контракт и `docs/PLUGIN-DEVELOPMENT.md` §5 явно фиксируют: навигационный iframe
не отправляет `Authorization`, а токен нельзя класть в URL. Поэтому хост:

1. получает entry HTML через authenticated `fetch` (`api.getPluginAsset`);
2. строит inert-документ через `DOMParser` (скрипты не исполняются, ресурсы не
   загружаются);
3. инлайнит **только same-package** относительные ссылки (script/link/img/
   source/video poster + CSS `url(...)`), используя bearer-токен;
4. кладёт результат в `iframe srcdoc`.

`src=entry_url` в реализации не используется осознанно — иначе плагин получал бы
401 (в dev-контуре) либо требовал токен в URL. Это соответствует рекомендации
бэкенд-отчёта (srcdoc/blob) и не ослабляет sandbox.

### 3.2 Атрибуты iframe

```tsx
<iframe
  sandbox="allow-scripts"
  referrerPolicy="no-referrer"
  allow="clipboard-write"
  srcDoc={document}
  title={`Плагин «${plugin.name}»`}
/>
```

- `sandbox` — ровно `allow-scripts`; `allow-same-origin`, `allow-popups`,
  `allow-modals`, `allow-top-navigation` отсутствуют (проверяется тестом);
- origin iframe opaque (`"null"`), DOM/localStorage/cookie приложения недоступны;
- `onLoad` → `init`; повторная загрузка (попытка навигации) переводит раннер в
  состояние `blocked` и убирает iframe;
- никакой HTML пакета не вставляется в DOM приложения: только `srcdoc`
  sandboxed iframe.

### 3.3 Документ пакета

Перед `srcdoc` в `<head>` добавляется meta-CSP:

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
img-src data:; font-src data:; media-src data:; connect-src 'none';
frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
```

Дополнительно удаляются `<base>`, `<meta http-equiv=refresh>` и внешние
`<a href>` (остаются только `#fragment`). Абсолютные и выходящие за пакет
ссылки вырезаются; сетевой fallback запрещён CSP.

Лимиты клиента: entry ≤ 2 MiB, ≤ 64 инлайновых ассетов, ≤ 8 MiB суммарно.
При превышении — понятная ошибка, а не зависание.

### 3.4 postMessage (минимальный host)

Реализован документированный конверт `v: 1`:

| Направление   | type    | Обработка                                                                                 |
| ------------- | ------- | ----------------------------------------------------------------------------------------- |
| host → plugin | `init`  | `plugin_id`, `version`, `chat_id?`, `permissions`, `locale`, `theme`; токен не передаётся |
| plugin → host | `ready` | статус «Плагин готов»                                                                     |
| plugin → host | `rpc`   | `rpc_result` с `ok:false`, `METHOD_NOT_FOUND` (RPC-брокера в срезе нет)                   |
| plugin → host | `log`   | только счётчик; текст в DOM не выводится                                                  |

Проверки: `event.source === iframe.contentWindow`, `v===1`, whitelist type,
id ≤ 64, method ≤ 128, log ≤ 2000, сообщение ≤ 64 KiB, глубина ≤ 8, rate limit
60 сообщений/сек. Никаких capability-грантов и данных сверх permissions.

## 4. Admin-управление пакетами

Новая вкладка `/admin?tab=plugins` (`AdminPluginsSection`):

- **Загрузка:** drag&drop + file picker (`.zip`), выбранный файл, кнопка
  «Установить пакет», `role=progressbar` с `aria-valuenow`, статусы
  «Загружаем пакет…» / «Проверяем manifest на сервере…»;
- **Ошибки:** клиентские (пустой/не .zip/>5 MiB) и серверные
  `PLUGIN_PACKAGE_INVALID` (manifest/entry/traversal/symlink), 413
  `PLUGIN_PACKAGE_TOO_LARGE`, 409 `PLUGIN_ALREADY_INSTALLED` /
  `PLUGIN_ID_RESERVED`, 403, 503 — все с отдельными переводами;
- **Список:** имя/id, версия, автор, entry, permissions/modes, размер,
  число файлов, короткий SHA-256 (полный — в `title`), дата установки;
- **Удаление:** `AdminConfirmDialog` с явным destructive-confirm, ошибки 404/403/
  retryable, после `204` строка и каталог обновляются без перезагрузки;
- **Ссылка на docs:** `docs/PLUGIN-DEVELOPMENT.md` в GitHub-репозитории проекта
  (`target=_blank`, `rel="noopener noreferrer"`);
- не-админ: раздел недостижим (`App` → `AdminForbiddenScreen`), внутри секции
  есть read-only fallback; install/uninstall невозможны и на сервере (403).

## 5. MSW и тесты

### 5.1 Mocks

`src/mocks/pluginPackage.ts` — mock-only stored-ZIP writer/reader (без новых
зависимостей): `createStoredZip`, `readStoredZip`, `createMockPluginZip`,
`parseMockManifest`.

`src/mocks/db.ts` — `pluginPackages`, `pluginPackageAssets`, счётчики запросов,
инъекции ошибок, `seedMockPluginPackage`, `allCatalogPlugins`.
`src/mocks/handlers.ts`:

- `GET/POST /admin/plugins`, `DELETE /admin/plugins/{id}` c `requirePlatformAdmin`;
- безопасный разбор multipart, лимиты 5/10 MiB и 200 файлов, manifest/entry,
  reserved/duplicate id, SHA-256;
- `GET /plugins/{id}/assets/*` — bearer, exact-match, `nosniff`, CSP,
  `frame-ancestors 'self'`, content-type по расширению;
- `GET /plugins` и per-chat state теперь включают установленные external-пакеты.

### 5.2 Добавленные тесты (+30)

| Файл                                         |   + | Что покрыто                                                                                                                         |
| -------------------------------------------- | --: | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/pluginPackages.test.ts`             |   8 | list, install valid, progress callback, invalid ZIP/traversal, duplicate/reserved, 413, admin-only, uninstall, asset auth/traversal |
| `src/plugins/external.test.ts`               |   9 | path grammar/traversal, file validation, inert document/CSP/inlining, postMessage envelope/limits/init                              |
| `src/components/ExternalPlugins.test.tsx`    |   6 | external card metadata, sandbox attrs, srcdoc, Escape/focus, E2EE, admin-only entry, axe                                            |
| `src/components/admin/AdminPlugins.test.tsx` |   7 | valid install/list, progress, manifest error, oversized, uninstall confirm, docs link, non-admin 403                                |

Ключевые проверки iframe:

```ts
expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
expect(frame.getAttribute('srcdoc')).toContain('Hello panel');
expect(frame.getAttribute('src')).toBeNull();
```

axe: страница каталога с external-карточками — без serious/critical нарушений.
Сам iframe исключён из jsdom-прогона (axe не умеет cross-frame messaging в
jsdom); его контракт проверяется атрибутами выше. Это зафиксировано в тесте.

## 6. Полный check

```bash
cd frontend
npm run check
# lint: 0 errors (2 pre-existing warnings вне зоны: ChatDetails, chatBridgeSupport.test)
# format:check: All matched files use Prettier code style
# contract:check: 134 operations, 173 schemas, generated types in sync
# stickers:check, security:check (370 files), session-writers:check — green
# Test Files 110 passed (110), Tests 1188 passed (1188)
# build: tsc + vite build — success
```

На старте среза в общем дереве было 1150 тестов; этот срез добавляет **30**.
Итоговый прогон — **1188/1188**; остальной прирост дают параллельные срезы,
работающие в том же дереве.

## 7. Безопасность (frontend)

| Угроза                               | Мера                                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| XSS через manifest/HTML пакета       | manifest и метаданные рендерятся только текстом; HTML — только `srcdoc` sandboxed iframe; `react/no-danger` не нарушен             |
| Доступ к DOM/localStorage приложения | `sandbox` без `allow-same-origin` → opaque origin                                                                                  |
| Токен в URL/iframe/postMessage       | не передаётся; ассеты получает хост с bearer, в iframe уходят только metadata                                                      |
| Сеть из плагина                      | meta-CSP `connect-src 'none'`, `img-src data:`, `script-src 'unsafe-inline'`; абсолютные ссылки вырезаны                           |
| Traversal/symlink                    | клиент резолвит только same-package пути и запрещает `..`/абсолютные; сервер — источник истины; ассеты не пишутся в DOM приложения |
| Произвольный HTML в app DOM          | `DOMParser` inert + `textContent`/атрибуты; нет `innerHTML`/`dangerouslySetInnerHTML`                                              |
| Установка не-админом                 | UI скрыт/заблокирован, серверный 403 обрабатывается; MSW тоже требует platform_admin                                               |
| Утечка секретов в логи               | нет логирования пакета/токенов; `security:check` зелёный                                                                           |

## 8. Ограничения и follow-up

1. **`srcdoc` и CSP хоста.** В production `vite.config.ts` задаёт
   `script-src 'self'`, а srcdoc-документ наследует CSP родителя; inline-скрипты
   пакета в production могут быть заблокированы. В dev/MSW сценарий работает.
   Полноценное решение — выделенный `*.plugins` origin (уже заявлен как
   follow-up #4 в backend-отчёте) либо отдельная CSP-политика для plugin-origin.
   Это ограничение не маскируется: UI не утверждает, что пакет гарантированно
   выполнится в любом деплое.
2. **Инлайн только простых ссылок.** Поддерживаются HTML-ссылки на
   script/link/img/source/poster и CSS `url(...)`. `srcset`, ES-module imports,
   workers и вложенные CSS `@import` не инлайнятся; CSP их блокирует. Пакет
   должен быть самодостаточным (или поставлять один entry-файл).
3. **Нет RPC-брокера.** `rpc` всегда получает `METHOD_NOT_FOUND`; permissions —
   описательные, consent/capability-грантов в срезе нет.
4. **Нет обновления версий.** Только `DELETE` + повторный `POST`.
5. **Mock-ZIP только stored.** `createMockPluginZip` не сжимает данные; ZIP,
   собранный `zip -r` (deflate), MSW отклонит с 400. Реальный backend принимает
   deflate. Для тестов/демо используйте helper.
6. **Прогресс зависит от браузера.** Если браузер не отдаёт
   `lengthComputable`, показывается индетерминированный статус без выдуманных
   процентов.
7. **axe и iframe.** jsdom не поддерживает cross-frame messaging axe, поэтому
   содержимое iframe не сканируется; sandbox-контракт проверяется отдельно.
8. **Документация — внешняя ссылка.** Приложение не раздаёт `docs/`; ссылка
   ведёт на canonical файл в GitHub-репозитории.

## 9. Изменённые файлы

Новые:

- `src/plugins/assets.ts`
- `src/plugins/blob.ts`
- `src/plugins/externalDocument.ts`
- `src/plugins/messages.ts`
- `src/plugins/packageErrors.ts`
- `src/components/plugins/ExternalPluginRunner.tsx`
- `src/components/admin/AdminPluginsSection.tsx`
- `src/mocks/pluginPackage.ts`
- `src/api/pluginPackages.test.ts`
- `src/plugins/external.test.ts`
- `src/components/ExternalPlugins.test.tsx`
- `src/components/admin/AdminPlugins.test.tsx`
- `frontend/PLUGIN-PACKAGES-UI-REPORT.md`

Изменённые:

- `src/api/http.ts` — multipart с прогрессом/abort
- `src/api/endpoints.ts` — 4 admin/asset метода
- `src/api/types.ts` — `AdminPluginPackage*`
- `src/plugins/store.ts` — admin packages/install/uninstall/asset read model
- `src/components/pages/PluginsPage.tsx` — built-in/external секции, open, admin entry
- `src/components/admin/{tabs.ts,AdminScreen.tsx}` — вкладка «Плагины»
- `src/i18n/ru.ts` — внешние плагины и admin-пакеты
- `src/mocks/db.ts`, `src/mocks/handlers.ts` — packages/assets/install/uninstall
- `src/styles/app.css` — карточки, dropzone, progress, runner, admin rows

## 10. Приёмка #86 (frontend)

| Пункт                                                                                     | Статус                          |
| ----------------------------------------------------------------------------------------- | ------------------------------- |
| API: admin list/install ZIP/uninstall                                                     | ✅                              |
| API: аутентифицированный plugin asset URL                                                 | ✅                              |
| Built-in + external карточки (kind/version/author/permissions)                            | ✅                              |
| External open: sandbox `allow-scripts`, без `allow-same-origin`, full-screen panel, close | ✅                              |
| postMessage minimal по docs                                                               | ✅                              |
| Никакого исполнения серверного кода                                                       | ✅ (static srcdoc only)         |
| Admin ZIP drag&drop/picker, progress                                                      | ✅                              |
| Manifest/size/ZIP/traversal ошибки                                                        | ✅ (client + contract codes)    |
| Installed list + uninstall confirm                                                        | ✅                              |
| Ссылка на developer docs                                                                  | ✅                              |
| MSW + tests: list/install valid/error/uninstall/iframe/axe                                | ✅ +30                          |
| Admin-only install; non-admin read-only/hidden                                            | ✅ (App + section + server 403) |
| No `allow-same-origin`; no HTML injection в app DOM                                       | ✅                              |
| Brand Sova                                                                                | ✅ (существующие токены/стили)  |
| `npm run check` 1150+                                                                     | ✅ **1188/1188**                |
| Отчёт                                                                                     | ✅ этот файл                    |

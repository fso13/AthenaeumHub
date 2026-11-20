# Разработка внешних плагинов Sova

> Статус: D1.2 (#86). Сервер принимает **статические** ZIP-пакеты внешних плагинов и
> раздаёт их как статические ассеты. Код плагина **не исполняется** на сервере: нет
> runtime, sandbox-процесса, RPC-брокера, capability-токенов и сетевых вызовов из
> бэкенда. Изоляция выполнения — задача клиента: `iframe sandbox="allow-scripts"` и
> postMessage-контракт, описанный ниже.

## 1. Что можно и чего нельзя

| Можно | Нельзя |
|---|---|
| Поставлять HTML/CSS/JS/картинки/шрифты как статические файлы | Загружать серверный код (Java/Node/Python/бинарь), который будет исполняться |
| Рисовать UI внутри iframe и общаться с хостом через `postMessage` | Обращаться к API Sova напрямую из iframe, читать DOM/localStorage приложения |
| Использовать закрытый набор permissions из manifest v1 | Запрашивать произвольные/неизвестные permissions, URL, секреты |
| Быть установленным администратором платформы и включённым в чате | Самостоятельно устанавливаться, обновляться или ходить в сеть |

Внешний пакет — это **данные**. Сервер проверяет ZIP, складывает файлы в S3/MinIO и
отдаёт их по аутентифицированному пути. Никакой файл пакета не попадает в classpath,
не запускается как процесс и не интерпретируется как конфигурация сервера.

## 2. Manifest v1

В корне ZIP обязателен файл `manifest.json`:

```json
{
  "id": "hello-panel",
  "name": "Hello panel",
  "version": "1.0.0",
  "description": "Пример статической панели",
  "author": "Sova",
  "entry": "index.html",
  "permissions": ["chat.messages.read"],
  "modes": ["MANAGED"]
}
```

| Поле | Обязательно | Правила |
|---|---|---|
| `id` | да | slug `^[a-z][a-z0-9-]{0,63}$`; не может совпадать с built-in (`polls`, `tasks`, `translate`, `telegram`, `dlp`) |
| `name` | да | 1..120 символов, plain text без `<`, `>` и control-символов |
| `version` | да | semver `MAJOR.MINOR.PATCH` (`1.0.0`, `2.4.1-beta.1`); 1..32 символа |
| `description` | да | 1..500 символов, plain text |
| `author` | да | 1..120 символов, plain text |
| `entry` | да | относительный путь к существующему `.html`-файлу внутри пакета |
| `permissions` | да | массив 0..16 уникальных токенов из таблицы ниже |
| `modes` | да | непустой массив `MANAGED` и/или `E2EE`, без дубликатов |

Неизвестные поля запрещены (strict JSON): manifest v1 не поддерживает
`signature`, `url`, `min_app_version` и т. п. Лишний ключ — ошибка установки.

### 2.1 Permissions

Закрытый словарь manifest v1:

| Токен | Назначение (описательное) |
|---|---|
| `chat.messages.read` | Чтение сообщений чата через host-RPC |
| `chat.messages.write` | Отправка сообщений/действий от имени плагина |
| `chat.members.read` | Список участников чата |
| `chat.files.read` | Метаданные вложений |
| `chat.files.write` | Прикрепление файлов |
| `webhooks.send` | Исходящие webhook-события (в этом срезе не исполняются) |

В D1.2 permissions **описательные**: сервер не выдаёт capability-гранты и не выполняет
RPC. Хост обязан показывать пользователю, какие права запрашивает плагин, и не вызывать
методы, выходящие за пределы пересечения `manifest.permissions ∩ consent пользователя`.

### 2.2 Modes

* `MANAGED` — обычный managed-чат; UI-панель может быть доступна.
* `E2EE` — плагин допускается в E2EE-чате только как клиентский (сервер не видит
  plaintext). Внешний пакет в этом срезе не получает серверных данных в любом режиме.

## 3. Упаковка

```
hello-panel.zip
├── manifest.json
├── index.html
└── assets/
    ├── app.js
    └── logo.svg
```

Требования и лимиты (проверяются до записи в объектное хранилище):

| Ограничение | Значение |
|---|---|
| Размер ZIP | ≤ 5 MiB |
| Суммарный распакованный размер | ≤ 10 MiB (считается по фактически прочитанным байтам) |
| Количество файлов | ≤ 200 (плюс manifest; всего записей ≤ 400) |
| `manifest.json` | в корне, ≤ 64 KiB, валидный JSON без дублей ключей |
| Пути | только относительные ASCII-сегменты `[A-Za-z0-9][A-Za-z0-9._-]*`, разделитель `/` |
| Запрещено | `..`, `.`, абсолютные пути, `\`, пустые сегменты, дубликаты путей, symlink, шифрованные записи, неподдерживаемое сжатие |

`entry` должен быть `.html` и присутствовать в архиве. Файлы с неизвестным
расширением разрешены, но отдаются как `application/octet-stream` + `attachment` и не
рендерятся.

Сборка:

```bash
cd hello-panel
zip -r ../hello-panel.zip . -x '.*' -x '__MACOSX/*'
```

## 4. Установка и управление (admin API)

Все операции требуют bearer JWT **platform_admin**. Установка не запускает код и не
делает сетевых вызовов.

### 4.1 Установить пакет

```bash
curl -X POST "$API/api/v1/admin/plugins" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@hello-panel.zip;type=application/zip"
```

`201 Created`:

```json
{
  "id": "hello-panel",
  "name": "Hello panel",
  "version": "1.0.0",
  "description": "Пример статической панели",
  "author": "Sova",
  "entry": "index.html",
  "permissions": ["chat.messages.read"],
  "modes": ["MANAGED"],
  "size_bytes": 1420,
  "file_count": 3,
  "sha256": "9f2c…",
  "installed_at": "2026-11-20T10:00:00Z"
}
```

Ошибки:

| HTTP | Код | Когда |
|---|---|---|
| `400` | `PLUGIN_PACKAGE_INVALID` | не ZIP, traversal/symlink, лимиты, отсутствует manifest/entry, невалидный manifest |
| `403` | `FORBIDDEN` | не platform_admin |
| `409` | `PLUGIN_ALREADY_INSTALLED` | пакет с таким `id` уже установлен |
| `409` | `PLUGIN_ID_RESERVED` | `id` занят built-in плагином |
| `413` | `PLUGIN_PACKAGE_TOO_LARGE` | ZIP > 5 MiB |

### 4.2 Список установленных внешних пакетов

```bash
curl "$API/api/v1/admin/plugins" -H "Authorization: Bearer $TOKEN"
```

Возвращаются только `kind=EXTERNAL`; built-in в список не входят.

### 4.3 Удалить пакет

```bash
curl -X DELETE "$API/api/v1/admin/plugins/hello-panel" \
  -H "Authorization: Bearer $TOKEN"
```

`204 No Content`. Catalog-строка переводится в `install_state=UNINSTALLED` и
`state=DISABLED` (per-chat ссылки не ломаются), metadata и объекты удаляются; объекты —
best-effort после коммита. Повторное удаление — `404 PLUGIN_NOT_FOUND`. Повторная
установка того же `id` разрешена и реактивирует строку.

## 5. Каталог и ассеты

`GET /api/v1/plugins` возвращает установленные built-in и external плагины. Для
external добавлены:

```json
{
  "id": "hello-panel",
  "name": "Hello panel",
  "description": "Пример статической панели",
  "permissions": ["chat.messages.read"],
  "modes": ["MANAGED"],
  "state": "ACTIVE",
  "kind": "EXTERNAL",
  "version": "1.0.0",
  "author": "Sova",
  "entry_url": "/api/v1/plugins/hello-panel/assets/index.html"
}
```

`entry_url` — **аутентифицированный API-путь**, не presigned URL и не путь файловой
системы. Запрос требует bearer JWT:

```bash
curl "$API/api/v1/plugins/hello-panel/assets/index.html" \
  -H "Authorization: Bearer $TOKEN"
```

Ассеты считаются публичными для любого аутентифицированного пользователя:
в них не должно быть секретов, токенов и персональных данных. Сервер отдаёт:

* `Content-Type` только из закрытой карты расширений, иначе `application/octet-stream`;
* `X-Content-Type-Options: nosniff`;
* `Content-Security-Policy` с `default-src 'none'`, `connect-src 'none'`,
  `frame-ancestors 'self'`; для HTML — дополнительно `sandbox allow-scripts`;
* `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`,
  `Permissions-Policy` без камеры/микрофона/геолокации;
* `inline` только для безопасных типов, остальное — `attachment`.

> **Важно про iframe.** Браузерное навигационное открытие iframe не умеет отправлять
> `Authorization`. Хост должен получить байты через `fetch` с bearer-токеном и передать
> их в iframe через `srcdoc`/`blob:` либо через same-origin прокси, который добавляет
> токен. Токен не попадает в URL, `postMessage` и iframe.

## 6. iframe + postMessage контракт

Хост создаёт iframe примерно так:

```html
<iframe
  sandbox="allow-scripts"
  referrerpolicy="no-referrer"
  allow="clipboard-write"
  title="Hello panel"></iframe>
```

`sandbox` **обязателен** и не должен содержать `allow-same-origin`,
`allow-top-navigation`, `allow-popups` или `allow-modals`. В результате origin iframe
становится opaque (`"null"`), DOM/localStorage приложения недоступны, а сеть запрещена
CSP и отсутствием токена.

### 6.1 Сообщения

Все сообщения — JSON-объекты с полем `v: 1` и `type`. Размер каждого сообщения ≤ 64 KiB,
глубина ≤ 8.

| Направление | type | Payload |
|---|---|---|
| host → plugin | `init` | `{v, type:"init", plugin_id, version, chat_id?, permissions[], locale, theme}` |
| plugin → host | `ready` | `{v, type:"ready"}` |
| plugin → host | `rpc` | `{v, type:"rpc", id, method, params}` |
| host → plugin | `rpc_result` | `{v, type:"rpc_result", id, ok:true, result}` |
| host → plugin | `rpc_result` | `{v, type:"rpc_result", id, ok:false, error:{code,message}}` |
| host → plugin | `event` | `{v, type:"event", event, payload}` |
| plugin → host | `log` | `{v, type:"log", level:"debug"|"info"|"warn", message}` |

`id` — строка ≤ 64 символов, уникальная в пределах сессии; timeout RPC — 5 секунд.
`params`/`result` — JSON ≤ 64 KiB, без HTML-строк, которые хост вставляет в DOM без
экранирования.

### 6.2 Проверки на стороне хоста

1. `event.source === iframe.contentWindow` — обязательно.
2. `event.origin`: при `sandbox` без `allow-same-origin` приходит `"null"`;
   поэтому основная проверка — `event.source`, а `origin` проверяется, если хост
   использует выделенный origin (например, `*.plugins.example`).
3. Schema-валидация сообщения, allowlist методов по permissions, лимит размера/глубины,
   rate limit и timeout.
4. Никогда не передавать в iframe bearer JWT, refresh token, capability-токены, ключи
   E2EE, содержимое чужих чатов.
5. Ответы `rpc_result` должны содержать только данные, разрешённые permissions и
   consent; ошибки — стабильные коды (`METHOD_NOT_FOUND`, `INVALID_PARAMS`, `FORBIDDEN`,
   `RATE_LIMITED`, `TIMEOUT`).

### 6.3 Проверки на стороне плагина

1. Принять `init` только один раз; запомнить `plugin_id`/`version` и сверить со своими.
2. Слать `ready` после инициализации UI.
3. Не доверять `event.origin` слепо: при opaque origin проверять, что сообщение пришло
   от родителя, и игнорировать всё остальное.
4. Не использовать `localStorage`/`IndexedDB`/`document.cookie` — при sandbox они
   недоступны или изолированы.
5. Не делать `fetch`/`WebSocket`/`importScripts`: CSP `connect-src 'none'` и sandbox
   это блокируют; все данные — только через `rpc`.
6. Не пытаться выйти из iframe (`top.location`, `window.open`) — sandbox это запрещает.

## 7. Безопасность: что делает сервер

| Угроза | Мера |
|---|---|
| Zip bomb | Потоковое чтение с жёстким лимитом 10 MiB по фактическим байтам; лимит 200 файлов; ZIP ≤ 5 MiB |
| Path traversal | Грамматика путей (нет `..`, `.`, `/` в начале, `\`), exact-match lookup в БД; ассеты не извлекаются на диск |
| Symlink | `ZipArchiveEntry.isUnixSymlink()` → отказ |
| Шифрованные/неподдерживаемые записи | `usesEncryption()`/`canReadEntryData()` → отказ |
| Дубликаты/подмена manifest | Дубликаты путей и второй `manifest.json` → отказ |
| XSS/HTML-инъекции | Manifest — plain text; ассеты отдаются с `nosniff`, CSP, `frame-ancestors 'self'`; HTML — с CSP `sandbox allow-scripts` |
| Исполнение кода | Сервер не загружает классы/процессы из пакета; нет runtime/RPC/capability |
| Privilege escalation | Установка/удаление — только platform_admin; запись в `plugin.catalog` ограничена RLS строкой `kind='EXTERNAL'` |
| Утечка built-in каталога | `krug_app` не может UPDATE/DELETE built-in строки; в схеме `plugin` нет функций |
| Секреты в пакете | Ассеты доступны любому аутентифицированному пользователю; секреты в пакет класть нельзя |
| Аудит | `admin.plugin.installed`/`admin.plugin.uninstalled`: только id, версия, размеры, число файлов; без байтов и содержимого |

## 8. Локальная установка и тестирование

```bash
# 1. Собрать пакет
cd hello-panel
zip -r ../hello-panel.zip . -x '.*' -x '__MACOSX/*'

# 2. Поднять backend и получить dev-сессию
cd ../backend
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
mvn -o -Dmaven.repo.local=.m2repo spring-boot:run
TOKEN=$(curl -s -X POST localhost:8081/api/v1/dev/session \
  -H 'Content-Type: application/json' \
  -d '{"display_name":"dev"}' | jq -r .access_token)

# 3. Сделать пользователя platform_admin (dev/ops-SQL; в UI — через setup/admin)
psql "$DB_URL" -c "UPDATE auth.users SET is_platform_admin = true
                   WHERE id = '<user-id>';"

# 4. Установить, проверить каталог и ассет
curl -X POST localhost:8081/api/v1/admin/plugins \
  -H "Authorization: Bearer $TOKEN" -F file=@hello-panel.zip
curl localhost:8081/api/v1/admin/plugins -H "Authorization: Bearer $TOKEN"
curl localhost:8081/api/v1/plugins -H "Authorization: Bearer $TOKEN"
curl -i localhost:8081/api/v1/plugins/hello-panel/assets/index.html \
  -H "Authorization: Bearer $TOKEN"
```

Тесты бэкенда:

```bash
cd backend
mvn -o -Dmaven.repo.local=.m2repo \
  -Dtest='PluginPackageDomainTest,ZipPluginPackageReaderTest,PluginPackagesIT' test
```

Полезные проверки при отладке:

* `manifest.json` — ровно в корне, а не в подпапке;
* `entry` совпадает с реальным путём и заканчивается на `.html`;
* в ZIP нет `__MACOSX/`, `.DS_Store`, symlink и файлов > 10 MiB;
* пакет не пытается делать `fetch` — это заблокировано CSP;
* после `DELETE` каталог больше не отдаёт плагин, а `PATCH /chats/{chatId}/plugins/{id}`
  возвращает `404 PLUGIN_NOT_FOUND` (строка каталога скрыта).

## 9. Ограничения текущего среза

* Нет подписи пакета, SBOM, anti-virus и автоматического review — только admin-only
  установка и структурная валидация.
* Нет capability-JWT, RPC-брокера и consent-эндпоинтов; postMessage-контракт —
  рекомендация для клиента, серверная часть RPC появится отдельным срезом.
* Нет обновлений/версионирования поверх установленного пакета: сначала `DELETE`, затем
  `POST`. Две версии одновременно не поддерживаются.
* Ассеты отдаются с backend-origin, а не с отдельного `*.plugins` домена; изоляция
  обеспечивается iframe `sandbox` и CSP. Выделенный origin — следующий шаг.

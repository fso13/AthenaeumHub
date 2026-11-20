# D1.2 (#86) — внешние плагины ZIP + developer docs (backend)

> Зона: `backend/**`, additive-правки `contracts/**`, `frontend/src/api/schema.d.ts`,
> новый `docs/PLUGIN-DEVELOPMENT.md`. Остальной `frontend/**`, `design/**`, `deploy/**`
> не менялись. Рабочее дерево общее с параллельными срезами; ниже зафиксированы только
> изменения этой задачи.

## Статус

**DONE в границах #86.** Реализована admin-only установка статических ZIP-пакетов
внешних плагинов, безопасная проверка архива и manifest v1, хранение ассетов в
S3/MinIO, каталог external-плагинов, аутентифицированная раздача статических ассетов,
удаление пакета и документация для разработчиков плагинов.

Код плагина **не исполняется** на сервере. Нет runtime, sandbox-процесса, RPC-брокера,
capability-токенов, загрузки классов из пакета и сетевых вызовов. Изоляция выполнения —
клиентский `iframe sandbox="allow-scripts"` + postMessage-контракт из документации.

## 1. Manifest v1

Формат (`manifest.json` в корне ZIP):

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

Правила:

* `id` — slug `^[a-z][a-z0-9-]{0,63}$`; built-in id зарезервированы;
* `name` 1..120, `description` 1..500, `author` 1..120 — plain text без `<`/`>`/control;
* `version` — semver `MAJOR.MINOR.PATCH` (опционально `-pre`/`+build`), 1..32;
* `entry` — относительный путь к существующему `.html` внутри пакета;
* `permissions` — 0..16 уникальных токенов закрытого словаря
  `chat.messages.read|write`, `chat.members.read`, `chat.files.read|write`,
  `webhooks.send`;
* `modes` — непустой массив `MANAGED`/`E2EE` без дубликатов;
* неизвестные ключи и дубли ключей JSON запрещены (strict).

## 2. Миграция V44

`backend/src/main/resources/db/migration/V44__external_plugin_packages.sql`.

### 2.1 `plugin.catalog` (расширение)

Добавлены колонки:

| Колонка | Тип / ограничение |
|---|---|
| `kind` | `BUILTIN`/`EXTERNAL`, default `BUILTIN` |
| `install_state` | `INSTALLED`/`UNINSTALLED`, default `INSTALLED` |
| `version` | `text NULL`; обязателен для external |
| `author` | `text NULL`; обязателен для external |
| `entry` | `text NULL`; обязателен для external |

`ck_plugin_catalog_external_metadata` запрещает смешивать built-in и package-metadata.
Старый CHECK на `permissions` заменён на закрытый union built-in и manifest-токенов.

**RLS/least privilege.** `plugin.catalog` теперь `ENABLE ROW LEVEL SECURITY` (без
`FORCE`, чтобы migrator продолжал сеять built-ins):

* `p_plugin_catalog_read` — `SELECT USING (true)` (как раньше, каталог глобальный);
* `p_plugin_catalog_insert_external` — `INSERT WITH CHECK (kind='EXTERNAL')`;
* `p_plugin_catalog_update_external` — `UPDATE USING/WITH CHECK (kind='EXTERNAL')`;
* `p_plugin_catalog_delete_external` — `DELETE USING (kind='EXTERNAL')`.

`krug_app` получил `INSERT/UPDATE/DELETE` на каталог, но RLS не даёт изменить/удалить
built-in строку. Это не ослабление существующего RLS: `chat.chat_plugins` и остальные
tenant-таблицы не тронуты.

### 2.2 `plugin.packages`

| Колонка | Тип / ограничение |
|---|---|
| `plugin_id` | `text PK REFERENCES plugin.catalog(id) ON DELETE CASCADE` |
| `archive_sha256` | 64 hex, SHA-256 ZIP |
| `archive_size_bytes` | 1..5 242 880 |
| `unpacked_size_bytes` | 1..10 485 760 |
| `file_count` | 1..200 |
| `entry` | безопасный относительный путь, 1..512 |
| `installed_by` | `uuid NOT NULL` (без FK — удаление пользователя не ломает пакет) |
| `installed_at/updated_at` | `timestamptz NOT NULL DEFAULT now()` |

### 2.3 `plugin.package_objects`

`(plugin_id, path)` PK, `plugin_id` FK CASCADE, `object_key` UNIQUE, `content_type`,
`size_bytes`, `sha256`. В БД нет байтов файлов и filesystem-путей — только opaque
MinIO-ключи и метаданные. `GRANT SELECT/INSERT/UPDATE/DELETE` для `krug_app`.

Rollback (forward-only, destructive, только external):
`DROP TABLE plugin.package_objects; DROP TABLE plugin.packages;` и снятие добавленных
колонок/политик каталога. Built-in строки, чаты, сообщения и файлы не затрагиваются.

### 2.4 Номер миграции

На момент начала задачи V44 был свободен. Параллельный avatar-срез в процессе работы
занял V44 и затем перенёс свою миграцию на **V45**; итоговый порядок в дереве:
`V43 → V44 (external plugin packages) → V45 (chat avatar)`. Дубликата версий нет,
Flyway проходит.

## 3. Backend

```
plugin/domain/model      PluginKind, PluginManifest, PluginAsset, PluginPackage,
                         PluginPackageObject, PluginPaths, PluginContentTypes,
                         Plugin (+ kind/version/author/entry)
plugin/domain/repository PluginPackageRepository, PluginPackageObjectRepository,
                         PluginCatalogRepository (+ installExternal/markUninstalled)
plugin/application/port  PluginPackageArchivePort, PluginAssetStoragePort,
                         PluginPackageInvalidException
plugin/application/model PluginArchive, PluginPackageView, PluginAssetView
plugin/application/usecase InstallPluginPackageService, PluginPackageWriter,
                         ListAdminPluginPackagesService,
                         UninstallPluginPackageService, PluginPackageUninstallWriter,
                         GetPluginAssetService, ListPluginsService (external fields)
plugin/infrastructure    ZipPluginPackageReader (commons-compress),
                         ObjectStoragePluginAssetAdapter,
                         PluginPackageRepositoryAdapter,
                         PluginPackageObjectRepositoryAdapter,
                         PluginCatalogAdapter (+ external SQL)
plugin/api               PluginAdminController, PluginController (+ asset endpoint),
                         PluginApiMapper, DTOs
```

Слоистость сохранена: domain — чистый Java; application не видит infrastructure/api;
api видит только application/shared; JPA/Jackson — только в infrastructure/api DTO.
`ArchitectureTest` — **10/10**.

### 3.1 Endpoints

| Метод | Путь | Права | Поведение |
|---|---|---|---|
| `POST` | `/api/v1/admin/plugins` | platform_admin | multipart `file` (ZIP ≤5 MiB), полная проверка, 201 |
| `GET` | `/api/v1/admin/plugins` | platform_admin | установленные external, 200 |
| `DELETE` | `/api/v1/admin/plugins/{pluginId}` | platform_admin | soft-uninstall каталога + удаление metadata/objects, 204 |
| `GET` | `/api/v1/plugins` | authenticated | built-in + external, `kind/version/author/entry_url` |
| `GET` | `/api/v1/plugins/{pluginId}/assets/{*path}` | authenticated | статический ассет из MinIO |

Порядок установки:

1. `PlatformAdminGuard.require` (флаг из `auth.users`, не из JWT/тела);
2. проверка размера ZIP (5 MiB) и безопасное чтение архива;
3. валидация manifest/entry/лимитов;
4. проверка id: built-in → `409 PLUGIN_ID_RESERVED`; уже установлен →
   `409 PLUGIN_ALREADY_INSTALLED`; uninstalled external → reinstall разрешён;
5. запись ассетов в S3/MinIO (`plugin-packages/{id}/{version}/{installId}/...`);
6. транзакция: upsert catalog (`EXTERNAL/INSTALLED`), package metadata, object keys,
   audit; при ошибке — best-effort удаление записанных объектов;
7. ответ 201 с метаданными (без байтов и object keys).

Удаление: catalog-строка остаётся как tombstone (`UNINSTALLED`/`DISABLED`) из-за
`chat.chat_plugins.plugin_id → plugin.catalog(id) ON DELETE RESTRICT`; package metadata
удаляется, объекты удаляются best-effort после коммита. Повторная установка реактивирует
строку.

### 3.2 Безопасное чтение ZIP

`ZipPluginPackageReader` (commons-compress 1.24.0 из offline-репозитория):

* ZIP ≤ 5 MiB, распакованный объём ≤ 10 MiB считается по **фактически прочитанным**
  байтам, а не только по declared size;
* ≤ 200 файлов и ≤ 400 записей;
* запрещены symlink (`isUnixSymlink`), шифрованные записи (`usesEncryption`),
  неподдерживаемое сжатие (`canReadEntryData`);
* пути — только `[A-Za-z0-9][A-Za-z0-9._-]*` по сегментам, `/`, без `..`, `.`, `\`,
  абсолютных путей, пустых сегментов и дубликатов;
* `manifest.json` только в корне, ≤64 KiB, strict JSON (unknown keys/duplicates/
  trailing tokens запрещены);
* entry обязан существовать и быть `.html`;
* архив не извлекается на диск; байты живут только в памяти запроса.

### 3.3 Раздача ассетов

`GET /plugins/{pluginId}/assets/{*path}`:

* путь нормализуется и проверяется по той же грамматике, затем ищется **точным
  совпадением** в `plugin.package_objects`; traversal невозможен;
* ассет читается из MinIO bounded-чтением (≤10 MiB), проверяются `size_bytes` и
  SHA-256;
* content-type — из закрытой карты расширений, неизвестное → `application/octet-stream`
  + `attachment`;
* заголовки: `X-Content-Type-Options: nosniff`, `Content-Security-Policy`
  (`default-src 'none'`, `connect-src 'none'`, `frame-ancestors 'self'`;
  для HTML — `sandbox allow-scripts`), `Referrer-Policy: no-referrer`,
  `Cross-Origin-Resource-Policy: same-origin`, `Permissions-Policy`;
* `X-Frame-Options: DENY` снят **только** для пути ассетов (через
  `DelegatingRequestMatcherHeaderWriter`); остальные ответы API сохраняют `DENY`.
  Для ассетов framing ограничен CSP `frame-ancestors 'self'`.

### 3.4 Ошибки

| Код | HTTP | Когда |
|---|---|---|
| `PLUGIN_PACKAGE_INVALID` | 400 | не ZIP, traversal/symlink/лимиты, нет manifest/entry, невалидный manifest |
| `PLUGIN_PACKAGE_TOO_LARGE` | 413 | ZIP > 5 MiB (transport или service check) |
| `PLUGIN_ALREADY_INSTALLED` | 409 | id уже установлен |
| `PLUGIN_ID_RESERVED` | 409 | id занят built-in |
| `PLUGIN_NOT_FOUND` | 404 | uninstall/asset неизвестного пакета |
| `NOT_FOUND` | 404 | неизвестный ассет |
| `PLUGIN_STORAGE_UNAVAILABLE` | 503 | S3/MinIO недоступен |
| `FORBIDDEN` | 403 | не platform_admin |

### 3.5 Audit

| Action | Target | Metadata |
|---|---|---|
| `admin.plugin.installed` | `plugin` | `plugin_id`, `version`, `file_count`, `archive_size_bytes`, `unpacked_size_bytes` |
| `admin.plugin.uninstalled` | `plugin` | `plugin_id`, `version`, `file_count` |

Байты, HTML/JS, object keys, имена файлов и содержимое manifest в audit не пишутся.
Audit и изменение — в одной транзакции; тенантные GUC активируются в writer-транзакции,
поэтому RLS audit-события проходит по `actor_id`.

## 4. Contract (additive)

`contracts/openapi.yaml`:

* новые paths: `/admin/plugins`, `/admin/plugins/{pluginId}`,
  `/plugins/{pluginId}/assets/{assetPath}` (+3);
* новые operations: `listAdminPlugins`, `installPluginPackage`,
  `uninstallPluginPackage`, `getPluginAsset` (+4);
* новые schemas: `AdminPluginPackage`, `AdminPluginPackageList` (+2);
* `Plugin`: добавлены опциональные `kind`, `version`, `author`, `entry_url`;
  `permissions` расширены manifest-токенами (built-in значения сохранены);
* `PluginId` описан как slug built-in или external;
* `Error.description` дополнен кодами D1.2;
* `frontend/src/api/schema.d.ts` регенерирован.

Фактические счётчики: **102 paths / 134 operations / 173 schemas**.
`npm run contract:check` — зелёный: 134 operations, 173 schemas, generated types in sync.

## 5. Security

* **AuthN/AuthZ.** Все admin-операции требуют JWT + platform_admin (проверка по БД);
  asset-эндпоинт требует JWT. Установка/удаление не доступны workspace-ролям.
* **No execution.** Нет загрузки классов/процессов/скриптов из пакета; сервер не
  запускает ZIP, не читает его как конфигурацию и не делает сетевых вызовов.
* **Zip bomb / traversal / symlink.** См. §3.2; лимиты проверяются по фактическим
  байтам, пути — по грамматике + exact-match.
* **RLS.** Новые таблицы — глобальные метаданные без пользовательского контента;
  каталог получил external-only write RLS, built-ins защищены от `krug_app`.
  Существующий RLS tenant-таблиц не ослаблен.
* **XSS/iframe.** manifest — plain text; ассеты отдаются с `nosniff`, CSP и
  `frame-ancestors 'self'`; HTML — с CSP `sandbox allow-scripts`; iframe-контракт
  требует `sandbox="allow-scripts"` без `allow-same-origin`.
* **Секреты.** В пакете не должно быть секретов: ассеты доступны любому
  аутентифицированному пользователю; object keys и байты не логируются.
* **DoS.** 5 MiB/ZIP, 10 MiB unpacked, 200 файлов, 400 записей, bounded JSON manifest
  64 KiB; нет рекурсивного разбора.
* **Audit.** Только метаданные/ids/размеры; hash-chain не менялся.

## 6. Tests

Добавлено **22 теста**. Полный прогон в общем дереве — **759/759** (733 baseline + 22 этой задачи + 4 теста параллельных срезов):

| Класс | + | Что покрыто |
|---|---:|---|
| `unit/PluginPackageDomainTest` | 5 | manifest v1, permissions/modes, path grammar, content types, external/built-in инварианты |
| `unit/ZipPluginPackageReaderTest` | 11 | валидный ZIP, traversal, symlink, bomb, 200+ файлов, oversize, missing manifest/entry, missing permissions/modes, unknown keys/bad JSON, bad permission/mode, duplicates |
| `integration/PluginPackagesIT` | 6 | install/list/asset/enable, uninstall/tombstone/reinstall, invalid/oversized/missing part, admin-only/conflicts, traversal/unknown assets, DB RLS/grants/no functions |

Обновлены существующие проверки:

* `ChatPluginsIT` — каталог теперь `ENABLE RLS` (не FORCE), `krug_app` имеет
  external-only write-гранты;
* `PluginDomainTest` — permissions каталога стали строковыми (built-in + external).

Ключевые проверки:

* `POST /admin/plugins` валидного ZIP → 201; catalog `EXTERNAL/INSTALLED`, package и
  3 object-строки; `GET /admin/plugins` — 1; `GET /plugins` — 6 (5 built-in + demo),
  `kind=EXTERNAL`, `version/author/entry_url`;
* asset HTML → 200 `text/html`, CSP с `sandbox allow-scripts`, `nosniff`, XFO отсутствует;
  JS → `text/javascript`; без JWT → 401; неизвестный asset/плагин → 404;
* `PATCH /chats/{chatId}/plugins/demo-panel` → 200, плагин виден в per-chat state;
* `DELETE` → 204; packages/objects/metadata удалены; catalog
  `UNINSTALLED/DISABLED`; asset 404; повторный DELETE 404; reinstall 201;
* невалидные архивы (traversal/symlink/bomb/201 файл/битый JSON/нет entry/битый
  permission) → 400 `PLUGIN_PACKAGE_INVALID`; >5 MiB → 413
  `PLUGIN_PACKAGE_TOO_LARGE`; отсутствующая multipart-часть → 400;
* non-admin: POST/GET/DELETE → 403; duplicate → 409 `PLUGIN_ALREADY_INSTALLED`;
  built-in id → 409 `PLUGIN_ID_RESERVED`;
* DB: catalog RLS enabled/not forced, 4 политики, grants; `krug_app` не может
  UPDATE/DELETE built-in и INSERT `kind='BUILTIN'`; в схеме `plugin` 0 функций;
  packages/objects PK и лимиты;
* audit `admin.plugin.installed` содержит только id/version/counts, без HTML/JS.

Команды:

```bash
cd backend
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
mvn -o -Dmaven.repo.local=.m2repo test
# Tests run: 759, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS
# ArchitectureTest: Tests run: 10, Failures: 0, Errors: 0

cd ../frontend
npm run api:types
npm run contract:check
# Contract check passed: 134 operations, 173 contract schemas; generated types in sync
```

## 7. Риски / follow-up

1. **Нет подписи/SBOM/AV/review.** Пакет принимается только platform-admin и проходит
   структурную проверку; доверие к содержимому — на администраторе. Подпись, allowlist и
   review — отдельный срез (PLG-01/PLG-14).
2. **Нет capability-JWT/RPC-брокера/consent.** postMessage-контракт в документации —
   клиентская рекомендация; серверные RPC и выдача прав не реализованы.
3. **Bearer-токен и iframe.** Навигационный `iframe src` не отправляет
   `Authorization`; хост обязан получать ассеты через `fetch` и использовать
   `srcdoc`/`blob:` или same-origin прокси. Это ограничение задокументировано.
4. **Ассеты на backend-origin.** Выделенный `*.plugins` origin и отдельная CSP-политика
   для него — следующий шаг; сейчас изоляция — `sandbox` + CSP.
5. **Нет обновления версий.** Поддерживается `DELETE` + повторный `POST`; параллельные
   версии и rollback не реализованы.
6. **`X-Frame-Options` исключение для ассетов.** Осознанно: иначе `entry_url` нельзя
   использовать в iframe. Остальные ответы сохраняют `DENY`; для ассетов действует CSP
   `frame-ancestors 'self'`.
7. **Глобальный multipart-лимит.** `spring.servlet.multipart.max-file-size=5MB`
   установлен для единственного multipart-эндпоинта; при появлении других загрузок
   нужно вынести лимит на endpoint/Resolver.
8. **V44/V45.** Параллельный avatar-срез занял V45; порядок последователен. При
   появлении новых миграций использовать следующий свободный номер.
9. **`commons-compress 1.24.0`.** Выбрана версия из offline-репозитория; при обновлении
   зависимостей проверить `isUnixSymlink`/`SeekableByteChannel` API.
10. **Reinstall сохраняет per-chat toggle.** Строка `chat.chat_plugins` не удаляется при
    uninstall (tombstone каталога), поэтому после повторной установки того же `id`
    прежнее включение может вернуться. Если продукт требует сброса — удалять/обнулять
    toggle в uninstall (небольшое изменение сервиса).

## 8. Изменённые файлы

Backend main:

* `backend/pom.xml` (+commons-compress)
* `backend/src/main/resources/application.yml` (multipart limits)
* `backend/src/main/resources/db/migration/V44__external_plugin_packages.sql`
* `backend/src/main/java/ru/krug/backend/shared/api/GlobalExceptionHandler.java`
* `backend/src/main/java/ru/krug/backend/shared/error/ErrorCode.java`
* `backend/src/main/java/ru/krug/backend/shared/infrastructure/security/SecurityConfig.java`
* `backend/src/main/java/ru/krug/backend/plugin/domain/model/{Plugin,PluginKind,PluginManifest,PluginAsset,PluginPackage,PluginPackageObject,PluginPaths,PluginContentTypes}.java`
* `backend/src/main/java/ru/krug/backend/plugin/domain/repository/{PluginCatalogRepository,PluginPackageRepository,PluginPackageObjectRepository}.java`
* `backend/src/main/java/ru/krug/backend/plugin/application/{model,port,usecase}/…` (см. §3)
* `backend/src/main/java/ru/krug/backend/plugin/infrastructure/{archive,persistence,storage}/…`
* `backend/src/main/java/ru/krug/backend/plugin/api/{PluginAdminController,PluginController}.java`
* `backend/src/main/java/ru/krug/backend/plugin/api/{dto,mapper}/…`

Backend tests:

* `backend/src/test/java/ru/krug/backend/support/PluginPackageTestSupport.java`
* `backend/src/test/java/ru/krug/backend/unit/PluginPackageDomainTest.java`
* `backend/src/test/java/ru/krug/backend/unit/ZipPluginPackageReaderTest.java`
* `backend/src/test/java/ru/krug/backend/integration/PluginPackagesIT.java`
* `backend/src/test/java/ru/krug/backend/unit/PluginDomainTest.java` (permissions strings)
* `backend/src/test/java/ru/krug/backend/integration/ChatPluginsIT.java` (catalog RLS)

Contracts / docs:

* `contracts/openapi.yaml`
* `frontend/src/api/schema.d.ts` (регенерация)
* `docs/PLUGIN-DEVELOPMENT.md` (новый)
* `backend/PLUGIN-PACKAGES-REPORT.md` (этот файл)

## 9. Приёмка #86

| Пункт | Статус |
|---|---|
| Manifest v1: id/name/version/description/author/entry/permissions/modes | ✅ |
| `POST /admin/plugins` multipart ZIP ≤5 MiB, safe ZIP/manifest/entry, MinIO, catalog EXTERNAL INSTALLED, no execution | ✅ |
| `GET /admin/plugins`, `DELETE /admin/plugins/{pluginId}` (catalog disabled, objects best-effort) | ✅ |
| `GET /plugins` с `kind/version/author/entry_url` | ✅ |
| `GET /plugins/{id}/assets/{*path}` из MinIO, safe content types, no traversal, auth | ✅ |
| DB V44 package metadata/objects, RLS/grants | ✅ |
| Zip bomb/traversal/symlink/HTML/SVG/JS CSP, static iframe only, admin only | ✅ |
| `docs/PLUGIN-DEVELOPMENT.md` (manifest, packaging, permissions, postMessage, security, local test) | ✅ |
| Tests: valid/invalid zip, traversal, bomb, oversize, install/list/delete, assets, auth | ✅ 22 |
| Full backend 733+ | ✅ **759/759** |
| ArchUnit | ✅ **10/10** |
| Additive; no RLS weakening; no execution/network | ✅ |
| Contract counts | ✅ 102/134/173; guard green |

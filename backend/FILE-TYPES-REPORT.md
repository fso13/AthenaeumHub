# FILE-TYPES — admin-managed extension allowlist + M4A

> Зона сессии: `backend/**`, additive-правки `contracts/openapi.yaml`, регенерация
> `frontend/src/api/schema.d.ts`. Остальной `frontend/**`, `docs/**`, `design/**`,
> `deploy/**` не менялись. Git-репозитория в рабочем дереве нет; изменения проверены
> полным backend-suite и frontend contract/typecheck.

## Статус

**DONE.** M4A разрешён на всех уровнях, `allowed_file_extensions` добавлен в
`ops.system_settings` (V32), admin GET/PATCH, runtime-политику загрузки, audit и
контракт. Опасный MIME/extension-блок не ослаблен, произвольный MIME не добавлен,
файловые пути не используются.

**Backend suite: 527/527, failures/errors 0. ArchUnit: 10/10.**
Frontend: `npm run contract:check` — passed (60 operations, 91 schemas), `tsc --noEmit`
— без ошибок.

## 1. M4A

* MIME: `audio/mp4` и `audio/x-m4a` явно добавлены в `FileTypePolicy.EXACT_ALLOWED`;
  `audio/x-m4a` также добавлен в `MediaMetadata.AUDIO_ALLOWED`, поэтому M4A с
  `kind=AUDIO` и метаданными проходит, а не только generic upload.
* Extension: `m4a` входит в дефолтный allowlist (Java `AllowedFileExtensions.DEFAULTS`
  и SQL default V32).
* Frontend inline-audio preview уже поддерживал `audio/mp4`, `audio/x-m4a` и `m4a`
  (`frontend/src/files/format.ts`, `media.ts`); менять его не требовалось.
* Тесты: `FileTypePolicySettingsTest.m4aIsAllowedThroughBothMimeSpellings`,
  `MediaMetadataIT.m4aIsAcceptedWithBothMimeSpellingsAndRoundtripsAsAudio`,
  `AdminFileTypeSettingsIT.patchInvalidatesTheCacheImmediatelyAndUnlistedExtensionsBecome415`.

## 2. Настройка `allowed_file_extensions`

### V32

`backend/src/main/resources/db/migration/V32__allowed_file_extensions.sql`:

* `ops.system_settings.allowed_file_extensions text[] NOT NULL DEFAULT ARRAY[...]`
  — 74 безопасных расширения (прежний безопасный набор + `m4a` + common media/docs);
* `ops.allowed_file_extensions_valid(text[])` — `IMMUTABLE` DB-backstop:
  1..100 элементов, `^[a-z0-9]{1,10}$`, без `NULL`, без дублей и без опасных
  расширений;
* `ck_system_settings_allowed_file_extensions CHECK (...)` — constraint на функцию;
* `REVOKE ... FROM PUBLIC` + `GRANT EXECUTE ... TO krug_app`;
* forward-only rollback plan в комментарии.

`text[]` выбран вместо jsonb: плоский упорядоченный список, без вложенности; адаптер
маппит его через `array_to_string`/`string_to_array`. Дефолт БД сверяется с Java
константой в `MigrationsIT`.

### Значения и валидация

* 1..100 записей;
* паттерн `[a-z0-9]{1,10}`, без ведущей точки;
* вход нормализуется: trim + lower-case (`TXT` → `txt`), после чего проверяется
  паттерн, дубликаты и dangerous-список;
* опасные расширения (`exe`, `bat`, `sh`, `js`, `html`, `svg`, …) отклонить нельзя;
* явный пустой массив → `400 VALIDATION_FAILED`; `null`/отсутствие поля → «не менять».
  Дефолт не подставляется вместо пустого списка, чтобы PATCH не «сбрасывал» настройку
  неявно;
* ошибка домена: `400 VALIDATION_FAILED`, `details.field=allowed_file_extensions`;
  Bean Validation дополнительно ловит `minItems/maxItems` и длину элемента.

### API

* `GET /admin/settings` всегда возвращает `allowed_file_extensions` (нормализованный
  массив);
* `PATCH /admin/settings` принимает `allowed_file_extensions` как полную замену;
* `settings.updated` audit содержит только имя поля `allowed_file_extensions`, без
  значений списка (тест проверяет отсутствие `txt`/`m4a` в metadata);
* не-admin → 403 (существующий `PlatformAdminGuard`, без изменений).

## 3. Runtime-политика

`FileTypePolicy.check(filename, mime, AllowedFileExtensions)`:

1. dangerous extension → `DANGEROUS` (сильнее любого allowlist; при повреждённой
   настройке тоже);
2. dangerous MIME → `DANGEROUS` (прежний список не изменён);
3. нет MIME → extension обязан быть в allowlist, иначе `UNSUPPORTED` (415);
4. непустое неизвестное extension → `UNSUPPORTED` (415), даже если MIME разрешён;
5. extension разрешён (или отсутствует) + MIME в managed-allowlist → `ALLOWED`;
6. иначе `UNSUPPORTED`.

`InitUploadHandler` и `PreflightService` берут allowlist из `FileSettingsPort`
(`FilesSettingsAdapter` → `SystemSettingsPort`), поэтому preflight и init применяют
одну и ту же настройку. `415` теперь содержит `details.extension`, если он есть.

### Кэш и применение без рестарта

* `SystemSettingsService.allowedFileExtensions()` — `@Cacheable`
  (`system-settings-allowed-file-extensions`);
* `UpdateAdminSettingsService.update()` — `@CacheEvict` после успешного PATCH, поэтому
  следующий upload/preflight видит новое значение сразу;
* `SystemSettingsCacheRefresher` дополнительно очищает кэш раз в 30 секунд: в
  multi-node установке нода, не обработавшая PATCH, обновляется без рестарта (граница
  устаревания ≤ 30 с). В single-node изменение немедленное;
* `@EnableCaching` добавлен в `KrugApplication`; отдельный cache-provider не нужен
  (Spring Boot simple `ConcurrentMapCacheManager`).

## 4. Безопасность

* Dangerous MIME/extension block не ослаблен; список расширений дополнен
  `html/htm/xhtml/shtml/svg`, чтобы эти типы нельзя было разрешить даже без MIME.
* Произвольный MIME не разрешён: MIME-allowlist прежний, добавлены только два
  M4A-написания.
* Админ-эндпоинты защищены серверным `PlatformAdminGuard`; настройка не tenant-scoped
  (глобальная конфигурация установки), но менять её может только platform_admin.
* В audit/логи не попадают ни SMTP-секрет, ни значения allowlist.
* Нет операций с filesystem/путями: только имя файла и его extension.
* DB constraint — backstop для будущих write-path, включая прямой SQL.

## 5. Контракт

`contracts/openapi.yaml` — additive:

* `AdminSettings.allowed_file_extensions`: array 1..100, items `^[a-z0-9]{1,10}$`;
* `AdminSettingsPatch.allowed_file_extensions`: array/null, полная замена, описание
  нормализации и отказа от пустого массива;
* пути/операции/схемы не добавлялись.

Счётчики после изменений (фактические, `check-contract`):
**51 path / 60 operations / 91 schemas** — без изменения количества относительно
исходного контракта этой сессии; изменены две существующие схемы.

`frontend/src/api/schema.d.ts` регенерирован через `npm run api:types`. Поле ответа
оставлено необязательным в OpenAPI (`allowed_file_extensions?: string[]`), чтобы
additive-поле не ломало существующие mock/consumer literals до отдельной frontend-
задачи; backend всегда его отдаёт, что проверено `AdminSettingsIT` и
`AdminFileTypeSettingsIT`. `AdminSettingsPatch.allowed_file_extensions` — optional/null.

## 6. Тесты

Новое/расширенное:

* `FileTypePolicySettingsTest` (6): дефолты, нормализация/валидация, M4A (оба MIME),
  runtime-сужение, unknown/missing extension, dangerous block;
* `AdminFileTypeSettingsIT` (4): GET/PATCH + audit fields-only; 11 невалидных наборов
  (пустой, 101, точка, пробел, >10, дубликат после lower-case, exe/bat/html/svg,
  пустая строка); немедленная инвалидация кэша (png allowed → PATCH → 415, txt/m4a
  201, preflight m4a); dangerous нельзя настроить и нельзя загрузить, DB-backstop;
* `MediaMetadataIT` (+1): M4A `audio/mp4` с AUDIO-метаданными и `audio/x-m4a`;
* `MigrationsIT` (+1): `text[]`/NOT NULL/дефолт содержит все Java-дефолты и `m4a`,
  constraint, функция принимает валидные и отвергает exe/bat/html/uppercase/dot/
  duplicate/empty;
* `AdminSettingsIT`: reset очищает кэш и возвращает DB-дефолт.

Полный прогон (JDK 21, project-local `.m2repo`):

```
JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.10/libexec/openjdk.jdk/Contents/Home \
  mvn -o -Dmaven.repo.local=../.m2repo test
Tests run: 527, Failures: 0, Errors: 0, Skipped: 0
ArchitectureTest: 10/10
```

Frontend:

```
npm run api:types
npm run contract:check   # Contract check passed: 60 operations, 91 contract schemas
npx tsc -p tsconfig.json --noEmit
```

## 7. Файлы

Основные:

* `backend/src/main/resources/db/migration/V32__allowed_file_extensions.sql`
* `backend/src/main/java/ru/krug/backend/shared/domain/model/AllowedFileExtensions.java`
* `backend/src/main/java/ru/krug/backend/file/domain/model/FileTypePolicy.java`
* `backend/src/main/java/ru/krug/backend/file/domain/model/MediaMetadata.java`
* `backend/src/main/java/ru/krug/backend/file/domain/exception/UnsupportedFileTypeException.java`
* `backend/src/main/java/ru/krug/backend/file/application/port/FileSettingsPort.java`
* `backend/src/main/java/ru/krug/backend/file/application/usecase/{InitUploadHandler,PreflightService}.java`
* `backend/src/main/java/ru/krug/backend/file/infrastructure/config/FilesSettingsAdapter.java`
* `backend/src/main/java/ru/krug/backend/ops/domain/model/SystemSettings.java`
* `backend/src/main/java/ru/krug/backend/ops/application/{model,port,service,usecase}/...`
* `backend/src/main/java/ru/krug/backend/ops/infrastructure/persistence/SystemSettingsRepositoryAdapter.java`
* `backend/src/main/java/ru/krug/backend/ops/infrastructure/scheduling/SystemSettingsCacheRefresher.java`
* `backend/src/main/java/ru/krug/backend/ops/api/{dto,mapper}/...`
* `backend/src/main/java/ru/krug/backend/KrugApplication.java`
* `contracts/openapi.yaml`
* `frontend/src/api/schema.d.ts`

Тесты:

* `backend/src/test/java/ru/krug/backend/unit/FileTypePolicySettingsTest.java`
* `backend/src/test/java/ru/krug/backend/integration/AdminFileTypeSettingsIT.java`
* `backend/src/test/java/ru/krug/backend/integration/{MediaMetadataIT,MigrationsIT,AdminSettingsIT}.java`

## 8. Caveats

* Поле ответа `AdminSettings.allowed_file_extensions` в OpenAPI не required — см. §5;
  backend-контракт фактически всегда его возвращает.
* Multi-node: локальный кэш другой ноды обновляется периодическим refresher’ом
  (≤ 30 с); немедленная инвалидация — на ноде, обработавшей PATCH.
* Прямой SQL-`UPDATE` настроек (тестовые fixtures) не проходит через `@CacheEvict`;
  тесты, меняющие allowlist, используют PATCH либо очищают кэш явно.
* Пустой список намеренно отклоняется; «сбросить к дефолту» можно только передав
  полный дефолтный список (или через миграцию/DB default).

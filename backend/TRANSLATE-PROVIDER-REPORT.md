# #104 — LibreTranslate как конкретный translation provider

Итог: **DONE** (backend + deploy + admin UI + docs + tests). E2EE не затрагивался,
публичные сторонние translate API не используются.

## 1. Задача и результат

Нужно было превратить «абстрактный HTTP-провайдер с `{text,target}`» в реально
включаемый self-hosted переводчик: LibreTranslate в compose, корректный
адаптер, честный health, административный выбор протокола и документация.

Сделано:

| Блок | Результат |
|---|---|
| Backend adapter | LibreTranslate `POST {url}` `{q,source:"auto",target,format:"text"}` → `translatedText`; bounded errors; custom `{text,target}` сохранён |
| Detection | `AUTO` по path `/translate`, явные `LIBRETRANSLATE`/`CUSTOM`, нормализация base URL → `/translate` |
| Admin API | `provider` в `GET/PATCH`, валидация `TRANSLATION_PROVIDER_INVALID`, внутренний http для self-hosted |
| Health | Реальный `POST /translate` константой `ping`→`en`; `status`/`latency_ms`, без контента; без сервиса — `UNAVAILABLE`, не OK |
| Deploy | `libretranslate` под profile `translate` (dev и prod), internal-only, healthcheck, volume моделей, backend env по умолчанию |
| UI | Селектор протокола, пример URL, внутренний http, честный статус «включён, но недоступен» |
| Docs | `docs/TRANSLATION.md`, ссылки в `deploy/README.md` и `docs/PRODUCTION-RUNBOOK.md` |
| Tests | unit + integration + frontend admin validation; полный backend-прогон зелёный |

## 2. Поддерживаемые протоколы

### LibreTranslate

```http
POST http://libretranslate:5000/translate
Content-Type: application/json

{"q":"Hello","source":"auto","target":"ru","format":"text"}
```

```json
{"translatedText":"Привет","detectedLanguage":{"language":"en","confidence":90}}
```

- Парсится только `translatedText`; пустое/нестроковое/слишком большое тело —
  `TranslationUnavailableException`.
- `source` всегда `auto` — язык определяет сам LibreTranslate.
- Если администратор указал корень (`http://libretranslate:5000`) и протокол
  `LIBRETRANSLATE`, адаптер сам добавляет `/translate`; trailing slash нормализуется.

### Custom (исторический)

```http
POST {url}
{"text":"Hello","target":"ru"}
→ {"text":"Привет"}
```

Сохранён без изменений. `CUSTOM` — явный выбор.

### AUTO и совместимость

`AUTO` (значение по умолчанию для старых установок и env) определяет протокол по
последнему сегменту path:

- `…/translate` → LibreTranslate;
- иначе → custom.

Если auto-определённый LibreTranslate-вызов **отклонён** (HTTP-ошибка или ответ без
`translatedText`), адаптер делает ровно одну повторную попытку в custom-формате на
тот же URL. Это сохраняет работу старого custom-провайдера, который жил на
`/translate` и строго проверял поля. Явные `CUSTOM`/`LIBRETRANSLATE` не ретраятся.
Максимум 2 запроса к одному URL, оба ограничены timeout/size.

## 3. Backend: изменения

### Модель и БД

- `plugin/domain/model/TranslationProviderKind` — `AUTO | CUSTOM | LIBRETRANSLATE`,
  лояльный `parse`/`fromWireOrDefault`.
- `TranslationSettings`, `EffectiveTranslationSettings`, `TranslationSettingsView` —
  добавлен `provider`.
- `V58__translation_provider_kind.sql`:
  `provider text NOT NULL DEFAULT 'AUTO' CHECK (provider IN (...))`.
  Существующие строки получают `AUTO` — миграция без простоя и без изменения
  поведения.
- `TranslationSettingsRepositoryAdapter` читает/пишет `provider`.
- `TranslationSettingsService`:
  - PATCH принимает `provider` (null = без изменений, blank = `AUTO`);
  - `TRANSLATION_PROVIDER_INVALID` для неизвестного значения;
  - env fallback отдаёт `KRUG_PLUGINS_TRANSLATE_PROVIDER`; неизвестное значение env
    не роняет старт, а трактуется как `AUTO`;
  - audit metadata: `enabled`, `provider`, `url_changed`, `provider_changed`
    (без URL);
  - идемпотентность учитывает provider.
- `TranslationEndpoint` — резолв протокола и URL (`/translate` detection,
  нормализация base URL).
- `HttpTranslationProvider` — два payload-а, парсинг, bounded errors, probe,
  AUTO-retry; URL проверяется политикой на каждом вызове, поэтому
  hand-edited env не обходит правила.

### URL-политика

`TranslationProviderUrl`:

- `https://` — любой хост (как раньше);
- `http://` — только внутренний хост: single-label compose-имя (`libretranslate`),
  `localhost`, `*.localhost|.local|.internal|.lan|.home.arpa`, loopback,
  RFC 1918, link-local;
- по-прежнему запрещены userinfo/credentials, query, fragment, dot-segments,
  длина > 2048.

Причина: LibreTranslate в compose доступен как `http://libretranslate:5000/translate`;
заставлять администратора ставить TLS-прокси внутри одной сети бессмысленно, а
публичный plaintext-провайдер по-прежнему запрещён. Frontend-валидация
(`frontend/src/ops/translation.ts`) зеркалит эти правила.

### Health probe

`POST /admin/plugins/translate/test`:

- выключен → `DISABLED`, 0 мс, сетевого вызова нет;
- включён → один bounded `POST /translate` с текстом `ping` и target `en`;
- ответ провайдера **отбрасывается**, в API уходят только `status`/`latency_ms`,
  в audit — те же два поля;
- ошибка/таймаут/непригодный ответ/незапущенный сервис → `UNAVAILABLE`.

Требование к языкам: `en` должен быть в `LT_LOAD_ONLY` (проверяется реальный
pipeline, а не только `/health` порта).

### Приватность

- Исходный текст, перевод, тело ответа, URL и заголовки не логируются; исключения
  провайдера не содержат message/body.
- В конфигурации нет API-key/credential поля; URL без userinfo/query.
- DLP (`#101`) по-прежнему проверяет вход до вызова и результат после; BLOCK не
  вызывает провайдера.
- E2EE: перевод E2EE-сообщений отклоняется до чтения контента.

## 4. Admin API / контракт

```
GET   /api/v1/admin/plugins/translate       -> {enabled, url, provider}
PATCH /api/v1/admin/plugins/translate       -> {enabled?, url?, provider?}
POST  /api/v1/admin/plugins/translate/test  -> {status, latency_ms}
```

- `TranslationProviderSettings` (+`provider` required, enum),
  `TranslationProviderUpdate` (+`provider`), описания GET/PATCH/test и
  `TRANSLATION_*` коды обновлены в `contracts/openapi.yaml`.
- `frontend/src/api/schema.d.ts` перегенерирован (`npm run api:types`).
- ArchUnit: API-слой не зависит от domain-энума — wire-значение отдаёт
  `TranslationSettingsView.providerWire()` (правило `apiDependsOnlyOnApplicationAndShared`
  снова зелёное).

## 5. Deploy

### Development/demo (`deploy/docker-compose.yml`)

```yaml
libretranslate:
  image: libretranslate/libretranslate:v1.9.6
  profiles: ["translate"]
  expose: ["5000"]              # host-порт не публикуется
  environment:
    LT_LOAD_ONLY: ${LT_LOAD_ONLY:-en,ru}
    LT_UPDATE_MODELS: ${LT_UPDATE_MODELS:-true}
    LT_DISABLE_WEB_UI: "true"
  volumes:
    - krug-libretranslate-models:/home/libretranslate/.local:rw
  healthcheck:
    test: ["CMD-SHELL", "./venv/bin/python scripts/healthcheck.py"]
```

Backend env:

```dotenv
KRUG_PLUGINS_TRANSLATE_URL=http://libretranslate:5000/translate
KRUG_PLUGINS_TRANSLATE_PROVIDER=libretranslate
```

Запуск: `docker compose --env-file .env --profile translate up -d --build`.
Без профиля сервис не поднят: провайдер формально настроен, но health честно
`UNAVAILABLE`, переводы — `503`; UI предупреждает.

### Production (`deploy/production/docker-compose.prod.yml`)

Тот же сервис под `profiles: ["translate"]`, сеть только `internal`, без Caddy-маршрута,
с отдельным volume `krug-prod-libretranslate-models`. В `.env.prod`:
`KRUG_PLUGINS_TRANSLATE_URL=http://libretranslate:5000/translate`,
`KRUG_PLUGINS_TRANSLATE_PROVIDER=libretranslate` (закомментировано в example —
включение осознанное). Ресурсы: 2 vCPU / 2–4 ГБ RAM / ~1–2 ГБ диска на `en+ru`,
первый старт скачивает модели.

Проверено статически:

```bash
cd deploy
docker compose --env-file .env.example --profile translate config   # OK, internal, no ports
cd production
KC_ADMIN_PASSWORD=… docker compose -f docker-compose.prod.yml \
  --env-file .env.prod.example --profile translate config            # OK, internal, no ports
```

У `libretranslate` нет `ports`/Caddy-маршрута, network — `krug`/`internal`,
volume — `krug_(prod_)libretranslate-models` → `/home/libretranslate/.local`.

## 6. Frontend

`AdminTranslationProvider.tsx`:

- селектор «Протокол провайдера» (`AUTO`/`LibreTranslate`/`Свой сервис`), подсказка
  какой протокол реально будет использован;
- label «URL провайдера», placeholder `http://libretranslate:5000/translate`,
  подсказка про внутренний http и запрещённые части URL;
- при `UNAVAILABLE` chip меняется на «Провайдер включён, но недоступен», появляется
  предупреждение «переводы вернут 503…» — никакого зелёного статуса без успешной
  проверки;
- PATCH отправляет `provider` только при изменении; audit-hint обновлён.

`ops/translation.ts`: зеркало URL-политики, `isLibreTranslateUrl`,
`resolveTranslationProvider`, `translationDraftChanged` c provider.
MSW-моки и mock-db обновлены под `provider` и внутренний http.

## 7. Тесты и доказательства

Backend (JDK 21, offline `.m2repo`):

```bash
cd backend
JAVA_HOME=$(/usr/libexec/java_home -v 21) \
  mvn -o -Dmaven.repo.local=../.m2repo test
```

- Полный прогон: **1090 tests, 0 failures, 0 errors, BUILD SUCCESS** (JDK 21; baseline 1042 → +48, требование «1042+» выполнено)
- Contract: `npm run contract:check` — **passed** (162 operations, 213 schemas, generated types in sync).
- ArchUnit: **11/11**, включая `apiDependsOnlyOnApplicationAndShared`.
- Новые/обновлённые тесты:
  - `TranslationEndpointTest` (16) — detection, `/translate` append, trailing slash,
    явные override, парсинг provider;
  - `HttpTranslationProviderTest` (10) — точный LT payload/parse, custom на
    не-`/translate`, AUTO-fallback, явный CUSTOM без retry, base URL append, ошибки
    LT (500/`error`/неверный тип/blank/не-JSON), size cap, пустой URL, probe,
    отсутствие контента/URL в логах;
  - `TranslationProviderUrlTest` (19) — внутренний http принят, публичный http
    отклонён, прежние правила сохранены;
  - `TranslationSettingsServiceTest` (16) — provider в stored/env/fallback,
    invalid provider, идемпотентность, audit;
  - `TranslationProviderAdminIT` (4) — provider в GET/PATCH/БД/audit, внутренний
    http, contract schemas, health без контента, gate;
  - `TranslationEnvFallbackIT` (1) — env URL+provider fallback и disable-wins.

Frontend:

```bash
cd frontend
npx vitest run src/ops/translation.test.ts src/components/admin/AdminTranslation.test.tsx
```

- `ops/translation.test.ts` + `AdminTranslation.test.tsx`: **44 passed** (10 admin + 34 ops); полный frontend-прогон — **1392/1392 passed** (142 files)
- `npx tsc -p tsconfig.json --noEmit`: **0 errors**.
- `npm run lint`, `npm run format:check`, `npm run build`: **green**.
- Покрыто: внутренний http (IPv6 loopback/ULA принят, публичный IPv6 и
  public http отклонены), provider select → PATCH, hint, честные состояния
  «не проверен»/`UNAVAILABLE`, axe.

## 8. Ограничения и риски

- `AUTO`-эвристика неизбежно неоднозначна для custom-провайдера на `/translate`;
  решение — явный `CUSTOM` (UI + API + env), плюс одна compat-попытка.
- Health-probe использует target `en`: если `en` исключён из `LT_LOAD_ONLY`,
  probe даст `UNAVAILABLE` при рабочем переводе на другие языки. Это задокументировано.
- Compose задаёт URL по умолчанию, поэтому без profile `translate` провайдер
  «настроен, но недоступен». Это осознанный компромисс: включение одним профилем,
  честная индикация в UI и `503` в чате; контент никуда не уходит.
- Модели/языки меняются только рестартом LibreTranslate; per-workspace провайдера нет
  (настройка установочная).
- Публичные translate API не поддерживаются by design.

## 9. Изменённые файлы (основное)

Backend:

- `plugin/domain/model/TranslationProviderKind.java` (new)
- `plugin/domain/model/TranslationSettings.java`
- `plugin/application/model/{EffectiveTranslationSettings,TranslationSettingsView}.java`
- `plugin/application/port/TranslationEnvPort.java`
- `plugin/application/service/{TranslationEndpoint.java(new),TranslationProviderUrl}.java`
- `plugin/application/usecase/TranslationSettingsService.java`
- `plugin/api/{PluginTranslationAdminController.java,dto/*,mapper/PluginTranslationApiMapper.java}`
- `plugin/infrastructure/{translation/HttpTranslationProvider.java,persistence/TranslationSettingsRepositoryAdapter.java,config/{TranslationProperties,TranslationEnvAdapter}.java}`
- `resources/application.yml`, `resources/db/migration/V58__translation_provider_kind.sql`
- `shared/error/ErrorCode.java`
- tests: `unit/{TranslationEndpointTest,HttpTranslationProviderTest,TranslationProviderUrlTest,TranslationSettingsServiceTest}.java`,
  `integration/{TranslationProviderAdminIT,TranslationEnvFallbackIT}.java`
- `contracts/openapi.yaml`

Deploy/docs/frontend:

- `deploy/docker-compose.yml`, `deploy/production/docker-compose.prod.yml`
- `deploy/.env.example`, `deploy/production/.env.prod.example`
- `deploy/README.md`, `docs/PRODUCTION-RUNBOOK.md`, `docs/TRANSLATION.md`
- `frontend/src/ops/translation.ts`, `frontend/src/components/admin/AdminTranslationProvider.tsx`,
  `frontend/src/i18n/ru.ts`, `frontend/src/mocks/{handlers,db}.ts`,
  `frontend/src/api/schema.d.ts`, frontend tests.

## 10. Статус

**DONE**: адаптер LibreTranslate, detection/override, внутренний http, admin API,
deploy (dev+prod, internal-only, volume, healthcheck), UI-подсказки и честный статус,
документация и тесты. E2EE и custom-провайдер не сломаны.

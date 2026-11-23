# Перевод сообщений (self-hosted LibreTranslate)

Задача: **#104**. Этот документ описывает установку, включение и эксплуатацию
провайдера перевода в Сове. Провайдер — **только self-hosted**: LibreTranslate или
собственный сервис с совместимым контрактом. Публичные сторонние translate API
(Google/DeepL/…) не используются и не поддерживаются конфигурацией.

E2EE не затрагивается: сервер не читает ciphertext, перевод E2EE-сообщений
отклоняется `422 E2EE_METADATA_FORBIDDEN` до любого сетевого вызова.

---

## 1. Что поддерживается

| Протокол | Запрос | Ответ |
|---|---|---|
| **LibreTranslate** | `POST {url}` `{"q":"…","source":"auto","target":"ru","format":"text"}` | `200 {"translatedText":"…"}` |
| **Custom** (исторический) | `POST {url}` `{"text":"…","target":"ru"}` | `200 {"text":"…"}` |

Поле `provider` в настройках:

- `AUTO` (по умолчанию) — если path URL заканчивается на `/translate`, используется
  LibreTranslate, иначе — custom. Для `AUTO` адаптер делает **одну** попытку
  совместимости: если LibreTranslate-запрос отклонён (HTTP-ошибка или в ответе нет
  `translatedText`), тот же URL вызывается в custom-формате. Так старый custom-провайдер
  на `/translate` продолжает работать без миграции.
- `LIBRETRANSLATE` — всегда протокол LibreTranslate. Если указан корень сервиса
  (`http://libretranslate:5000`), адаптер сам добавляет `/translate`.
- `CUSTOM` — всегда `{text,target}`. Явный выбор нужен, если custom-сервис живёт
  именно на `/translate` и не переносит лишние поля.

Ответ провайдера ограничен `max-response-bytes` (64 KiB по умолчанию); пустой,
нестроковый или слишком большой ответ — это `503 TRANSLATION_UNAVAILABLE`, а не
«успешный» перевод. Текст ответа дополнительно проходит `PluginTextPolicy`
(длина ≤ 8000, без HTML/control-символов) и DLP.

---

## 2. Быстрый старт (development/demo stack)

```bash
cd deploy
cp .env.example .env          # если ещё не сделано
docker compose --env-file .env --profile translate up -d --build
```

Backend уже получает из compose:

```dotenv
KRUG_PLUGINS_TRANSLATE_URL=http://libretranslate:5000/translate
KRUG_PLUGINS_TRANSLATE_PROVIDER=libretranslate
```

Сервис `libretranslate` **не публикует порт** — доступен только по внутренней сети
compose. Первый старт скачивает модели Argos для языков из `LT_LOAD_ONLY`
(`en,ru` по умолчанию): это ~1–2 ГБ и несколько минут. Модели лежат в named volume
`krug_krug-libretranslate-models`, повторные старты быстрые.

Проверка:

```bash
docker compose --env-file .env --profile translate ps libretranslate
docker compose --env-file .env --profile translate logs -f libretranslate
# healthcheck LibreTranslate:
docker compose --env-file .env --profile translate exec libretranslate \
  ./venv/bin/python scripts/healthcheck.py && echo ok
```

Затем в UI: **Администрирование → Плагины → Переводчик**:

1. URL: `http://libretranslate:5000/translate`;
2. протокол: `LibreTranslate` (или `Авто`);
3. включить провайдер и нажать **Проверить соединение** — ожидается
   «Провайдер доступен · N мс.»;
4. после этого участники включают плагин `translate` в настройках конкретного чата.

Без профиля `translate` хост `libretranslate` не резолвится: провайдер формально
включён (URL задан окружением), но health-check честно показывает
`UNAVAILABLE`, карточка администратора — «Провайдер включён, но недоступен», а
перевод в чате возвращает `503` с `Retry-After: 30`. До первой проверки карточка
показывает нейтральное «Провайдер включён · не проверен», а не зелёный статус.
Фальшивого «всё работает» нет.

### Переменные

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `KRUG_PLUGINS_TRANSLATE_URL` | `http://libretranslate:5000/translate` (compose) | URL провайдера; пусто = провайдер выключен |
| `KRUG_PLUGINS_TRANSLATE_PROVIDER` | `libretranslate` (compose), `auto` (backend) | `auto`, `custom`, `libretranslate` |
| `KRUG_PLUGINS_TRANSLATE_CONNECT_TIMEOUT` | `2s` | connect timeout |
| `KRUG_PLUGINS_TRANSLATE_REQUEST_TIMEOUT` | `5s` | read timeout |
| `KRUG_PLUGINS_TRANSLATE_MAX_RESPONSE_BYTES` | `65536` | лимит тела ответа |
| `LT_LOAD_ONLY` | `en,ru` | какие языковые модели грузить |
| `LT_UPDATE_MODELS` | `true` | обновлять модели при старте |

`en` должен оставаться в `LT_LOAD_ONLY`: health-check переводит константу `ping` на
`en`, чтобы проверить реальный pipeline, а не только доступность порта.

---

## 3. Production

Сервис уже описан в `deploy/production/docker-compose.prod.yml` под профилем
`translate`, только во внутренней сети (`internal`), без публикации порта и без
Caddy-маршрута.

```bash
cd deploy/production
# в .env.prod:
#   KRUG_PLUGINS_TRANSLATE_URL=http://libretranslate:5000/translate
#   KRUG_PLUGINS_TRANSLATE_PROVIDER=libretranslate
#   LT_LOAD_ONLY=en,ru
docker compose --env-file .env.prod --profile translate up -d libretranslate
docker compose --env-file .env.prod up -d backend   # перечитать env
```

Проверка из backend-контейнера:

```bash
docker compose --env-file .env.prod exec backend \
  curl -fsS -X POST http://libretranslate:5000/translate \
  -H 'Content-Type: application/json' \
  -d '{"q":"ping","source":"auto","target":"en","format":"text"}'
```

Ожидается JSON с `translatedText` (содержимое — только `ping`, не пользовательский
текст).

### Ресурсы и модели

| Параметр | en+ru (минимум) | Комментарий |
|---|---|---|
| CPU | 2 vCPU | CPU-инференс; GPU-образ не используется |
| RAM | 2–4 ГБ | модели Argos + процесс |
| Диск | ~1–2 ГБ на пару | named volume, не репозиторий |
| Старт | 1–5 мин (первый раз) | скачивание моделей; далее — из volume |

Каждая дополнительная языковая пара увеличивает диск/RAM. Управляйте составом через
`LT_LOAD_ONLY`; поддерживаемые коды — ISO 639-1 (`en`, `ru`, `de`, …), список
доступных языков: `GET http://libretranslate:5000/languages` из backend-контейнера.
После изменения `LT_LOAD_ONLY` перезапустите сервис; старые модели можно удалить из
volume вручную.

Бэкап: модели не являются данными — их не нужно бэкапить, достаточно повторного
скачивания. Volume нужен только для скорости старта.

---

## 4. Администратор: API и валидация

```
GET   /api/v1/admin/plugins/translate       -> {enabled, url, provider}
PATCH /api/v1/admin/plugins/translate       -> {enabled?, url?, provider?}
POST  /api/v1/admin/plugins/translate/test  -> {status, latency_ms}
```

Правила URL:

- `https://…` — для любого хоста;
- `http://…` — **только** для внутреннего хоста: compose-имя без точки
  (`libretranslate`), `localhost`, `*.local`/`*.internal`/`*.lan`/`*.home.arpa`,
  loopback, RFC 1918 (`10/8`, `172.16–31`, `192.168/16`), link-local;
- credentials/userinfo, query string, fragment и dot-segments запрещены;
- длина ≤ 2048; пустая строка очищает URL.

Коды ошибок:

| Код | Когда |
|---|---|
| `422 TRANSLATION_URL_INVALID` | URL не проходит политику |
| `422 TRANSLATION_URL_REQUIRED` | включение без сохранённого/окруженческого URL |
| `422 TRANSLATION_PROVIDER_INVALID` | `provider` не `AUTO`/`CUSTOM`/`LIBRETRANSLATE` |
| `503 TRANSLATION_UNAVAILABLE` | провайдер выключен/недоступен/ответ непригоден |

Аудит: `admin.plugin.translate.updated` хранит `enabled`, `provider`,
`url_changed`, `provider_changed`; `admin.plugin.translate.tested` — только `status`
и `latency_ms`. **Сам URL и любой контент в аудит/логи не попадают.**

`AUTO`/`LIBRETRANSLATE` health-check — это реальный `POST /translate` с константой
`ping` → `en`; при выключенном провайдере сетевого вызова нет (`DISABLED`, 0 мс).

---

## 5. Приватность и безопасность

- **Только self-hosted.** Публичные translate API не поддерживаются; сетевой вызов
  уходит лишь на URL, который явно задал platform_admin (или окружение установки).
- **Контент не логируется.** Ни исходный текст, ни перевод, ни тело ответа, ни URL
  не пишутся в логи и audit; исключения провайдера — без message/body.
- **DLP до и после.** Вход проверяется workspace DLP (`scope=PLUGIN`/`ALL`); `BLOCK`
  → `422 DLP_BLOCKED` без вызова провайдера. Результат проверяется повторно и не
  возвращается/не аудируется при блокировке.
- **Никаких секретов.** В БД и API нет API-key/credential поля; URL не содержит
  userinfo/query. LibreTranslate запускается без `LT_API_KEYS` и доступен только
  внутри compose-сети; наружу не публикуется.
- **Границы.** URL задаёт platform_admin — это trusted-роль; политика URL всё равно
  не даёт сохранить публичный plaintext-эндпоинт и не даёт спрятать секрет в URL.
  Для внешнего доступа к LibreTranslate ставьте TLS-терминацию и не открывайте
  сервис в интернет.
- **E2EE.** Managed-only: E2EE-чаты/сообщения не переводятся, ciphertext не читается.

---

## 6. Ограничения

- Перевод — по одному сообщению на запрос: нет батчей, стриминга и кэша.
- Текст сообщения ≤ 8000 символов (общий лимит managed-сообщений); ответ провайдера
  тоже ≤ 8000 и ≤ 64 KiB по сети.
- Таймауты: connect 2 с / read 5 с (настраиваются). Ошибка/таймаут = `503` с
  `Retry-After: 30`.
- `AUTO`-режим при несовпадении протокола делает максимум 2 запроса к одному URL.
- Провайдер не проверяет «качество» перевода и не гарантирует поддержку пары языков:
  неподдерживаемая пара у LibreTranslate — ошибка провайдера → `503`.
- Нет per-workspace провайдера: настройка установочная (одна на инсталляцию).
- Модели/языки задаются при старте LibreTranslate (`LT_LOAD_ONLY`), горячая смена
  языка без перезапуска не поддерживается.

---

## 7. Диагностика

| Симптом | Проверка |
|---|---|
| `503 TRANSLATION_UNAVAILABLE` | провайдер включён? URL задан? сервис запущен (`--profile translate`)? |
| Health `UNAVAILABLE` при живом контейнере | `en` есть в `LT_LOAD_ONLY`? модели скачались? логи контейнера |
| «Провайдер включён, но недоступен» | это честное состояние: нажмите «Проверить соединение» после старта сервиса |
| Custom-сервис на `/translate` отвечает ошибкой | выберите протокол `Свой сервис {text,target}` (явный `CUSTOM`) |
| Долгий первый перевод | модели ещё грузятся/скачиваются; health-check покажет `UNAVAILABLE` |
| LibreTranslate ест много RAM | уменьшите `LT_LOAD_ONLY`, ограничьте контейнер memory-лимитом |

Логи backend по переводу содержат только коды/статусы; если нужен HTTP-трейс,
используйте сетевую диагностику внутри compose, не включайте логирование тел.

---

## 8. Проверка в коде

```bash
cd backend
JAVA_HOME=$(/usr/libexec/java_home -v 21) \
  mvn -o -Dmaven.repo.local=../.m2repo \
  -Dtest='TranslationEndpointTest,HttpTranslationProviderTest,TranslationProviderUrlTest,TranslationSettingsServiceTest,TranslationProviderAdminIT,TranslationEnvFallbackIT,ArchitectureTest' \
  test

cd ../frontend
npx vitest run src/ops/translation.test.ts src/components/admin/AdminTranslation.test.tsx
```

Тесты фиксируют: точный LibreTranslate payload, парсинг `translatedText`,
custom-совместимость, retry-поведение `AUTO`, bounded-ошибки, внутренний http,
health-probe, отсутствие контента в логах и честный `UNAVAILABLE` в UI.

---

## 9. Не-цели

- Публичные облачные переводчики и API-ключи.
- Автоперевод всей истории/чатов, перевод E2EE-контента.
- Хранение переводов на сервере (перевод — эфемерный ответ на действие).
- Управление моделями/языками из UI Совы (только `LT_LOAD_ONLY`/рестарт).

# E2EE CI / checklist / release — отчёт (#35)

> **Дата:** 2026-11-19. **Задача:** #35 (условие 8 в [`E2EE-REVIEW-13.md`](E2EE-REVIEW-13.md)).
> **Зона:** `.github/**`, `scripts/**`, `docs/**`, `STATUS.md`, `README.md`; production-код,
> контракты, `deploy/.env` не менялись.
> **E2EE не включён:** base-флаги остались `false`, overlay не запускался.

## Вердикт

Все артефакты #35 в дереве готовы и проверены локально эквивалентными CI командами.
**Статус: PARTIAL** — два пункта нельзя закрыть из этого workspace:

1. **Прогон GitHub Actions не выполнен:** в workspace нет `.git` и remote, поэтому
   workflow-файлы нельзя запушить и увидеть зелёный run. Локально те же команды зелёные
   (backend 498/498, frontend `npm run check`, contract, YAML/shell линтеры).
2. **git/tag/patch-bundle (one-PR)** из условия 8 — вне зоны и невозможен без репозитория.

Всё остальное по условию 8 закрыто ниже (§7). E2EE остаётся выключенным.

## 1. Что добавлено

| Файл | Назначение |
|---|---|
| [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | Blocking CI: backend, frontend, contract, guardrails. Без deploy и секретов. |
| [`.github/workflows/e2ee-gated.yml`](../.github/workflows/e2ee-gated.yml) | Ручной/label F7A+F7B; по умолчанию не запускается; destructive SQL только по явному input. |
| [`docs/E2EE-ENABLE-CHECKLIST.md`](E2EE-ENABLE-CHECKLIST.md) | Production-enable чеклист: условия, preflight, backup, V19/V20, метрики, rollout/rollback, kill switch. |
| [`scripts/release-check.sh`](../scripts/release-check.sh) | Release rebuild: `npm run check`, backend tests, contract, image digest + SHA-256 ассетов. Без push/tag. |
| [`scripts/check-e2ee-base-flags.sh`](../scripts/check-e2ee-base-flags.sh) | Guard: base-флаги `false`, overlay — единственное место с `true`. |
| [`scripts/validate-yaml.py`](../scripts/validate-yaml.py) | Парсинг всех gate/deploy/application YAML (python yaml). |
| [`STATUS.md`](../STATUS.md), [`README.md`](../README.md) | Ссылки, актуальные счётчики: 498 backend / 867 frontend / 48-56-88 contract. |

`.github/workflows/wiki.yml` не менялся — он не относится к CI и остаётся рабочим.

## 2. CI (`.github/workflows/ci.yml`)

- **Триггеры:** `push`/`pull_request` в `main`, `workflow_dispatch`.
  `paths-ignore`: `design/**`, `docs/**`, `wiki/**`, `**/*.md` (docs-only PR не тратит runner).
- **Concurrency:** `ci-${{ github.workflow }}-${{ github.ref }}`, `cancel-in-progress: true`.
- **Permissions:** `contents: read`; секреты не используются.
- **Кэш:** `actions/setup-java` (maven) и `actions/setup-node` (npm по
  `frontend/package-lock.json`).
- **Таймауты:** backend 45 мин, frontend 30, contract 15, guardrails 10.
- **Deploy отсутствует:** нет push образов, нет выкладки, нет E2EE flag-on.

| Job | Команда | Что проверяет |
|---|---|---|
| `backend` | `mvn -B -ntp -Dstyle.color=never test` (JDK 21 Temurin, `backend/`) | 498 тестов, unit + Testcontainers IT; Docker есть на ubuntu-runner. Surefire-отчёты — артефакт при падении. |
| `frontend` | `npm ci --no-audit --no-fund` + `npm run check` (Node 22) | eslint, prettier, contract drift, stickers, client security, session writers, 867 vitest, `tsc --noEmit` + `vite build`. |
| `contract` | `npm ci` + `npm run contract:check` | Быстрый отдельный drift-gate OpenAPI ↔ `src/api/schema.d.ts`. |
| `guardrails` | `python3 scripts/validate-yaml.py`; `shellcheck --severity=warning scripts/*.sh`; `check-e2ee-base-flags.sh`; `git ls-files` на секреты | YAML парсится, shell чистый, base-флаги `false`, `.env`/ключи не в индексе. |

Отдельный contract job дублирует установку npm — это осознанный компромисс: drift падает
за ~1 минуту, не дожидаясь полного frontend job.

## 3. E2EE gated workflow (`.github/workflows/e2ee-gated.yml`)

**Триггеры:** только `workflow_dispatch` или `pull_request: labeled` с меткой `e2ee-live`
(и только для same-repo PR). На `push` workflow не запускается.

| Input | По умолчанию | Смысл |
|---|---|---|
| `suite` | `browser-matrix` | `browser-matrix`, `real-two-device`, `both`. |
| `allow_destructive` | `false` | Включает `E2EE_REAL_RESET=1` (device reset / cleanup SQL). Только disposable stand. |
| `reset_volumes` | `false` | `docker compose down -v` после прогона. Удаляет все данные стенда. |

- **Plan job** печатает точные F7A/F7B команды (в т.ч. overlay) и первым делом проверяет
  base-флаги `false`.
- **F7A:** только Vite dev server, без backend и без флага. Chromium+Firefox — blocking;
  WebKit — `continue-on-error` с явным warning (ADR-26, expected-fail policy). Это и есть
  требуемая политика «Chromium/Firefox blocking, WebKit expected-fail».
- **F7B:** собирает `deploy/.env` из `.env.example` с random-секретами **внутри job**
  (не коммитится), поднимает `docker-compose.yml + docker-compose.e2ee-test.yml`, ждёт
  `healthz` + healthy backend, запускает `npm run test:e2e:e2ee:real` с
  `E2EE_REAL_DB_CHECK=1`, затем сканирует логи backend/frontend на
  `markerA/markerB/markerLost/markerR15/f7b_` и падает при находке.
- **Destructive:** `E2EE_REAL_RESET` = `1` только при `allow_destructive=true`, иначе `0`.
  Volumes удаляются только при `reset_volumes=true`; иначе `down` без `-v`.
- Логи не выгружаются (чтобы не тащить данные стенда в артефакты), трейсы F7B отключены
  конфигом Playwright.

## 4. Чеклист включения (`docs/E2EE-ENABLE-CHECKLIST.md`)

Разделы: правила (base false / overlay only / explicit GO) → статус условий #29–#37 и
#38 → preflight → backup + restore rehearsal → V19/V20 preflight SQL → наблюдаемые метрики
→ rollout по стадиям → rollback/kill switch → форма GO → ссылки.

Ключевые решения:

- Условия #29–#37 сведены в таблицу с issue-ссылками и статусами; #31 — **CLOSED
  (2026-11-19)**, #38 — **BLOCKED**, #35 — **IN PROGRESS** (этот отчёт).
- Явно сказано, что backend-флаг **глобальный** (`krug.e2ee.enabled`), а не per-workspace;
  «пилот на workspace» = canary-деплой + пилотные пользователи.
- Kill switch: backend — runtime flip; SPA — **пересборка** (`VITE_E2EE_ENABLED` compile-time),
  иначе старый бандл продолжит показывать E2EE UI и будет получать `409 E2EE_DISABLED`.
- Backup — две БД (`krug`, `keycloak`), `.env` (шифровать), compose config, образы; restore
  обязателен на disposable-стенде. Команды проверены на живых контейнерах (`select 1`).
- Метрики: 0 plaintext-строк у `E2EE_PAIRWISE`, envelope 272..33040 B, 0 маркеров в логах,
  0 quarantine на чистом стенде, отсутствие 5xx на E2EE-путях, seq/replay-инварианты.

## 5. Release rebuild (`scripts/release-check.sh`)

```bash
scripts/release-check.sh                 # всё: frontend + backend + contract + образы/ассеты
scripts/release-check.sh --build-images  # плюс сборка base-образов (флаг false)
scripts/release-check.sh --skip-frontend --skip-backend --out /tmp/release
```

- Гейты: `npm ci` + `npm run check`; `mvn test`; `contract:check`; SHA-256
  `contracts/openapi.yaml`; SHA-256 SPA-ассетов (`*.js`, `*.css`, `index.html`);
  `docker image inspect` (Id/Created/RepoDigests).
- Ассеты берутся **из frontend-образа** (`/usr/share/nginx/html`) при
  `--build-images`/`--assets-from-image` — это release-evidence; иначе хэшируется
  локальный `frontend/dist` и в отчёте явно пишется `Source: dist`.
- Пишет `release-<UTC>.md`, `versions.txt`, `images.tsv`, `assets.txt`, `assets-source.txt`,
  `backend-test.log`, `frontend-*.log` в `$TMPDIR/krug-release-check/<stamp>/`.
- **Никогда** не делает `docker push`, `git tag`, не включает E2EE; перед стартом гоняет
  `check-e2ee-base-flags.sh` и падает, если base-дефолты стали `true`.
- `MAVEN_REPO_LOCAL` — для sandbox/CI с нестандартным `.m2` (маппится в
  `-Dmaven.repo.local`).

## 6. Локальная валидация (2026-11-19)

| Проверка | Команда | Результат |
|---|---|---|
| YAML (python) | `python3 scripts/validate-yaml.py` | **11/11** файлов OK (workflows, compose, application*.yml, openapi) |
| Workflows | `actionlint .github/workflows/{ci,e2ee-gated,wiki}.yml` | **exit 0** |
| Shell | `shellcheck --severity=warning scripts/*.sh` | **exit 0** |
| Base-флаги | `scripts/check-e2ee-base-flags.sh` | **exit 0**, 6/6 ok |
| Frontend | `npx vitest run` | **81 файл / 867 тестов passed** |
| Frontend gate | `npm run check` (в release-check) | **PASS** (lint/format/contract/security/tests/build) |
| Backend | `mvn test` (JDK 21) | **498 tests, 0 failures, 0 errors; BUILD SUCCESS** |
| Contract | `contract:check` + подсчёт | **48 paths / 56 operations / 88 schemas**; SHA-256 `9c31acf8…e9668c` |
| Release script | `scripts/release-check.sh` | **RELEASE CHECK PASSED**: E2EE flags, frontend install/check, backend test, contract drift, image capture, asset hashes — PASS |
| Backup SQL | `docker exec krug-postgres psql -U krug_migrator … 'select 1'`; keycloak аналогично | **1** (команды из чеклиста рабочие) |

### Что не запускалось

- **F7A/F7B live** — это gated workflow (browser + overlay stack). В рамках #35 проверены
  YAML/линтеры и сами команды; живой прогон требует отдельного запуска и закрытого #29
  (clean fixture). Не выдаётся за evidence.
- **GitHub Actions** — нет `.git`/remote; см. «Вердикт».

### Замечания по окружению (не дефекты репозитория)

- Локальный Docker Desktop не достучался до Testcontainers Ryuk
  (`Could not connect to Ryuk at localhost:<port>`); повторный прогон с
  `TESTCONTAINERS_RYUK_DISABLED=true` — зелёный. На ubuntu-runner GitHub Ryuk работает
  штатно; в CI переменная не нужна.
- `npm ci` в песочнице требует writable cache: запускалось с
  `npm_config_cache=/tmp/krug-npm-cache`. На runner кэш пишется штатно.
- `docker compose build` в песочнице упирается в `~/.docker/buildx/activity` (EPERM);
  это ограничение sandbox, не скрипта. Проверка `--build-images` вынесена в отдельный
  прогон (§6.1).

### 6.1. Rebuild, образы и ассеты

`scripts/release-check.sh --build-images` собрал base-стек с
`KRUG_E2EE_ENABLED=false` (sandbox-обход buildx: `BUILDX_CONFIG=/tmp/krug-buildx`);
сборка `krug-backend` и `krug-frontend` — **успешно**. Capture-only прогон
(`--skip-frontend --skip-backend --assets-from-image`) зафиксировал артефакты,
привязанные к текущему дереву:

| Image | ID | Created |
|---|---|---|
| `krug-backend:latest` | `sha256:b682140f27ac0e0e8f1e6dfeb747dd787adccee480df41be24b7cfd564776793` | 2026-11-19T07:04:19Z |
| `krug-frontend:latest` | `sha256:61008a3e45fe62eb92a5320dec392da792976d657c3620548e526662993bb82d` | 2026-11-19T07:05:05Z |

Frontend-ассеты извлечены **из `krug-frontend:latest`** (`/usr/share/nginx/html`);
`Source: image:…` пишется в отчёт:

```
c4fbd81eb1718378705f205a42085137b6975f2b30c8fd76aa09ca4dac769c6a  assets/browser-Dt_WVD3Y.js
1ed31204aa843a527fcf1f3369ce070a953872792638007c6b9575e671511720  assets/index-uGIjhkd3.js
35d573ec5e86392cf877161247a71e2b141479ea0c0cd7b6464ffb19f056b8bb  assets/index-C0QV2G1O.css
5de0acb22ccdb00f8fbaa5c8bd277563e470dd5d5cca05cec756b64c57ad31e1  assets/realtime-ZsnNk0Bt.js
b6f81a94c4ed6d077f67fae09b80d0bad0aacec3d7977bfd00c10ea3a4b2aba3  index.html
26171599d94d5445297303f3a1f1cedec26835ea3d0057dcfa92ec520cb35cca  mockServiceWorker.js
```

Хэши локального `npm run check` build (Node 24) отличаются от образа (Node 22 + другие
`VITE_*` args) — поэтому release-evidence должен браться из образа:

```
a558eb2af2d59144f602c440b903b18bddda0eb6c58dd720ef01ffea9e71b962  assets/index-BLSTRm7p.js
70d429315f2b65e1f5c42116ad71b8989b09410521f7f79a93ddbf93cf40e10d  assets/realtime-HfL-WfOE.js
5142789aa24a0e9be53b5cc7287b850f1986aeca59732caaa7c7e1f8aafc0784  index.html
```

Полный прогон до сборки (`20261119T070043Z`) — все гейты PASS: E2EE flags, frontend
install/check, backend test (498), contract drift, image capture, asset hashes.

## 7. Условие 8 REVIEW-13 — покрытие

| Подпункт условия 8 | Статус | Где |
|---|---|---|
| F7A-матрица с явной политикой (Chromium/Firefox blocking, WebKit expected-fail) | **DONE** | `e2ee-gated.yml` → `browser-matrix` |
| F7B на чистом стеке в release-CI | **PARTIAL** | `e2ee-gated.yml` → `real-two-device` (manual/label, не default CI); «чистый стек» зависит от #29 |
| `log-capture` на отсутствие ciphertext/plaintext | **DONE** | `e2ee-gated.yml` → «Log capture — no plaintext/ciphertext markers» |
| Полный backend suite | **DONE** | `ci.yml` → `backend` (498) |
| `E2EE-ENABLE-CHECKLIST.md` | **DONE** | `docs/E2EE-ENABLE-CHECKLIST.md` (путь согласован в шапке) |
| Clean rebuild после финальных правок + image digest + asset SHA-256 | **DONE** | `scripts/release-check.sh --build-images`; образы и ассеты из образа — §6.1 |
| git/tag/patch-bundle (one-PR) | **BLOCKED (внешне)** | в workspace нет `.git`/remote; выполняется владельцем репозитория |

## 8. Первый запуск на GitHub (что ожидать)

1. Закоммитить новые файлы вместе с executable-битом на `scripts/*.sh`
   (`git update-index --chmod=+x`), иначе `./scripts/...` в docs/локальном запуске не сработает
   (CI вызывает `bash scripts/...`, это устойчиво).
2. Убедиться, что default branch — `main` (так в `wiki.yml`).
3. Открыть PR: должны запуститься 4 job-а. Backend на ubuntu-runner использует Docker для
   Testcontainers; отдельный сервис-контейнер не нужен.
4. Секреты не добавлять: CI не обращается к реальному SMTP; F7B использует Mailpit из
   compose, а пароли генерируются в job.
5. Для пилота: вручную запустить `E2EE gated (live)` с `suite=both`,
   `allow_destructive=false`, `reset_volumes=true` на disposable-стенде; приложить
   `release-check` report и GO из чеклиста.

## 9. Остаточные риски

- **GitHub-run не подтверждён** — возможны runner-специфичные мелочи (кэш, shellcheck
  версия, pip/PyYAML). Локальные эквиваленты зелёные; при первом PR смотреть именно
  `guardrails` (pip/PyYAML) и `backend` (Docker).
- **F7B не в default CI** — по требованию #35 он gated; «release-CI» для F7B остаётся
  ручным шагом, пока #29 не закроет clean fixture.
- **Образы собраны в локальной песочнице** — ID валиден для этого дерева, но для релиза
  повторить `--build-images` на чистом runner и приложить отчёт; buildx-обход
  (`BUILDX_CONFIG`) — только sandbox, в CI не нужен.
- **Kill switch протестирован только по коду/поведению** (409 `E2EE_DISABLED`), живой
  прогон — в #37.
- **Checklist не включает Safari/iOS** — отдельное условие 6 / #33.

## 10. Итог

**#35: PARTIAL.**

- В зоне #35 сделано всё: CI, gated F7A/F7B, чеклист, release-check, guardrails,
  обновлённые STATUS/README, валидация YAML/shell/tests/contract.
- E2EE **не включён**, base-флаги `false`, overlay не запускался.
- Открыто: зелёный GitHub Actions run (нет `.git`/remote) + git tag/patch-bundle;
  F7B clean-stack зависит от #29.

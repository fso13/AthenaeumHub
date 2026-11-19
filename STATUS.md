# Сова — статус проекта

> Актуальный статус ведётся в GitHub Issues: [ROADMAP #58](https://github.com/fso13/AthenaeumHub/issues/58).
> Wiki: https://github.com/fso13/AthenaeumHub/wiki · исходники страниц: [`wiki/`](wiki/).

## Сейчас

| Направление | Статус |
|---|---|
| Managed MVP: auth BFF, чаты, файлы, стикеры, realtime, уведомления | **DONE** |
| Admin: users/chats/storage/actions/audit/members | **DONE** |
| LDAP/AD/FreeIPA guide | **DONE** |
| E2EE | **GO WITH CONDITIONS** для Chromium/Firefox pilot; флаг **false** |
| D1 Message Dashboard v1.0 (MVP) | **DONE**; D1.1 queued |
| Auth/Ops hardening | **NEXT** |

## Тесты и контракт

- Backend: **498 tests**, ArchUnit 10/10.
- Frontend: **990 tests**, KAT 27/27, Chromium/Firefox F7B 2/2.
- Contract: **48 paths / 56 operations / 88 schemas**.

## CI и релиз

- CI (blocking): [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — JDK 21 + Maven (498),
  Node 22 + `npm run check` (867), отдельный contract job, guardrails (YAML, shellcheck,
  E2EE default flags, no secrets).
- E2EE live (manual / label `e2ee-live`, по умолчанию **не** запускается):
  [`.github/workflows/e2ee-gated.yml`](.github/workflows/e2ee-gated.yml).
- Release: [`scripts/release-check.sh`](scripts/release-check.sh) — без push/tag, фиксирует
  image digest и SHA-256 ассетов. Evidence: [`docs/E2EE-CI-REPORT.md`](docs/E2EE-CI-REPORT.md).

## E2EE

`docs/E2EE-REVIEW-13.md`: GO WITH CONDITIONS pilot-only; base flag-on — NO-GO.
Условия #29–#38: открыты #29, #30, #32–#37; #31 закрыт; #38 blocked.
`KRUG_E2EE_ENABLED=false`; тестовый overlay — только disposable стенд.
Порядок включения и evidence: [`docs/E2EE-ENABLE-CHECKLIST.md`](docs/E2EE-ENABLE-CHECKLIST.md).

## Новые функции

- Реакции, редактирование, удаление для себя/для всех.
- Аудио/видео звонки 1:1 (WebRTC signaling over WS).
- Сворачиваемое меню сайдбара.

## Очередь

- E2EE pilot: #29–#38 (открыто: #29, #30, #32–#37; #31 закрыт; #38 blocked).
- Hardening: #39–#45.
- D1 MVP: #46–#56 closed; D1.1: #57.

## Репозиторий

- Код: https://github.com/fso13/AthenaeumHub
- Issues: https://github.com/fso13/AthenaeumHub/issues
- Wiki source: [`wiki/`](wiki/); публикация: `scripts/publish-wiki.sh`

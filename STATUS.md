# Pickle — статус проекта

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

- Backend: **453 tests**, ArchUnit 10/10.
- Frontend: **758 tests**, KAT 27/27, Chromium/Firefox F7B 2/2.
- Contract: **47 paths / 55 operations / 87 schemas**.

## E2EE

`docs/E2EE-REVIEW-13.md`: GO WITH CONDITIONS pilot-only; base flag-on — NO-GO.
Открытые условия: #29–#38. `KRUG_E2EE_ENABLED=false`; тестовый overlay — только disposable стенд.

## Очередь

- E2EE pilot: #29–#38.
- Hardening: #39–#45.
- D1 MVP: #46–#56 closed; D1.1: #57.
- E2EE pilot: #29–#38.

## Репозиторий

- Код: https://github.com/fso13/AthenaeumHub
- Issues: https://github.com/fso13/AthenaeumHub/issues
- Wiki source: [`wiki/`](wiki/); публикация: `scripts/publish-wiki.sh`

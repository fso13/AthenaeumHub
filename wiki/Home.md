# Сова — документация

**Сова** — мессенджер для команд и близких кругов: managed-контур с аудитом и DLP-принципами и E2EE-контур, который сейчас **выключен по умолчанию**.

- Репозиторий: [fso13/AthenaeumHub](https://github.com/fso13/AthenaeumHub)
- Статус и очередь: [Issue #58 — ROADMAP / статус](https://github.com/fso13/AthenaeumHub/issues/58)
- Лицензия/исходники: см. `README.md` и `docs/`

## Быстрый старт

```bash
cd deploy
cp .env.example .env
# заменить секреты
docker compose --env-file .env up -d --build
# http://localhost:8088
```

Первый администратор проходит `/setup`: SMTP, параметры установки, лимиты.
Демо-стенд: `test@krug.local` / `Test1234!` (только локально; в production не использовать).

## Разделы

| Для кого | Страница |
|---|---|
| Пользователи | [User Guide](User-Guide) |
| Администраторы | [Admin Guide](Admin-Guide) |
| Разработчики | [Developer Guide](Developer-Guide) |
| Архитектура | [Architecture](Architecture) |
| API | [API](API) |
| Безопасность | [Security](Security) |
| Эксплуатация | [Operations](Operations) |
| План | [Roadmap](Roadmap) |
| Ошибки | [Troubleshooting](Troubleshooting) |

## Статус

| Направление | Статус |
|---|---|
| Managed MVP: auth BFF, чаты, файлы, стикеры, realtime, admin | DONE |
| Admin: users/chats/storage/actions/audit/members | DONE |
| LDAP/AD/FreeIPA guide | DONE |
| E2EE | GO WITH CONDITIONS для Chromium/Firefox pilot; `KRUG_E2EE_ENABLED=false` |
| D1 Message Dashboard v1.0 | QUEUED, P1/XL |

> E2EE не включать в base до закрытия условий `docs/E2EE-REVIEW-13.md` и тикетов #29–#38.

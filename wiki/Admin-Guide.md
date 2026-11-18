# Admin Guide

## Первый запуск

1. Поднимите стек: `cd deploy && cp .env.example .env && docker compose --env-file .env up -d --build`.
2. Откройте `http://localhost:8088`; первый вход создаёт platform admin.
3. Пройдите `/setup`:
   - SMTP host/port/user/password/from;
   - тестовое письмо;
   - параметры установки и лимиты;
   - завершение настройки.
4. `/setup` после завершения недоступен; настройки — `/admin?tab=settings`.

## Админка

`/admin` — только platform admin:

| Вкладка | Что показывает |
|---|---|
| Overview | users / workspaces / chats |
| Users | email, имя, статус, admin, workspaces/chats, storage, created |
| Chats | workspace/type/mode/members/messages/last activity |
| Storage | used/reserved/objects/attachments, per workspace |
| Audit | время, action, actor, target; без content/hash |
| Settings | SMTP, лимиты, регистрация, setup status |

### Действия

- **Suspend/activate user** — Keycloak disable/enable + logout + session revoke; suspended login → `403 ACCOUNT_SUSPENDED`.
- **Delete chat** — soft-delete, сообщения/файлы/членства сохраняются; повтор → `409 CHAT_ALREADY_DELETED`.
- **Audit** — только metadata; `actor_email` — единственное PII.
- Защита: нельзя suspend себя/последнего platform admin.

### Участники пространства

- Владелец/админ открывает «Участники» у switcher.
- Добавление существующего пользователя по email; роли ADMIN/MEMBER/GUEST.
- `max_workspace_members`; дубль/лимит → 409.
- Нельзя удалить последнего OWNER/себя; OWNER не назначается через API.

## Лимиты

Defaults: 100 чатов/пользователь, 1000/пространство, 100 участников.
Настраиваются в `/admin?tab=settings`; ошибки `409 CHAT_LIMIT_REACHED` / `WORKSPACE_MEMBER_LIMIT_REACHED`.

## SMTP

- Локально: Mailpit `http://localhost:8025`, SMTP `mailpit:1025`.
- Production: SMTP с TLS, SPF/DKIM/DMARC; секреты — через env/secret store.
- Проверка: «Отправить тестовое письмо» в настройках.

## LDAP / AD / FreeIPA

Полная инструкция: [docs/LDAP-KEYCLOAK.md](https://github.com/fso13/AthenaeumHub/blob/main/docs/LDAP-KEYCLOAK.md).

- Keycloak → User Federation → LDAP;
- bind DN, users DN, mappers email/displayName/username;
- AD/FreeIPA атрибуты;
- **Trust Email** только для доверенного каталога;
- пароль остаётся в каталоге, Pickle его не хранит.

## Безопасность

- Не выдавайте platform admin без необходимости.
- Проверяйте audit после suspend/delete.
- E2EE-флаг не включайте без выполнения `docs/E2EE-REVIEW-13.md`.
- Резервные копии и TLS — см. [Operations](Operations).

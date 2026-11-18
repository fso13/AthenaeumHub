# Troubleshooting

## Не приходит письмо

- Локально: Mailpit `http://localhost:8025`.
- Проверьте SMTP в `/admin?tab=settings`, «Тестовое письмо».
- Production: SPF/DKIM/DMARC, spam, TLS.

## `testuser` не входит

Логин — **email**, например `test@krug.local`; пароль `Test1234!` только на локальном demo.

## 413 при загрузке

- Лимит файла; nginx `client_max_body_size` (16m в репозитории).
- Пересоберите frontend после изменения nginx.

## 409 при создании чата

`CHAT_LIMIT_REACHED` — лимит пользователя/пространства; администратор меняет в settings.

## 409 при добавлении участника

`WORKSPACE_MEMBER_LIMIT_REACHED` / `MEMBER_ALREADY_EXISTS`; проверьте лимит и список.

## Suspended login

`403 ACCOUNT_SUSPENDED` — администратор приостановил; activate в `/admin?tab=users`.

## E2EE не работает в Safari

Ожидаемо: WebKit блокируется RFC 8032 Ed25519 self-test (ADR-26). Используйте Chromium/Firefox для E2EE pilot; managed работает.

## E2EE-чат не создаётся

Проверьте `KRUG_E2EE_ENABLED` (должен быть false в base), devices/prekeys, `409 E2EE_DISABLED`/`E2EE_NO_ACTIVE_DEVICES`.

## База/контейнеры

```bash
docker compose ps
docker compose logs --tail=200 backend
```

Не удаляйте volumes без backup.

# Security

## Модель

- Managed: сервер видит plaintext, есть аудит/лимиты; доступ по JWT + workspace membership.
- E2EE: сервер хранит только envelope; plaintext только на устройствах. **Сейчас выключен.**
- Keycloak скрыт за BFF; браузер не получает admin credentials.

## Меры

- RLS на tenant-таблицах; runtime role `krug_app`; миграции отдельным пользователем.
- Device binding (`X-Device-Id`), refresh rotation, revoke при suspend.
- Admin actions: platform guard, self/last-admin protections, audit.
- Audit append-only/hash-chain; SECURITY DEFINER функции с минимальными грантами.
- WebCrypto only; без JS fallback; KAT в Chromium/Firefox.
- WebKit блокируется RFC 8032 self-test (ADR-26).

## E2EE gate

`docs/E2EE-REVIEW-13.md`:
- GO WITH CONDITIONS только Chromium/Firefox pilot;
- base flag-on — NO-GO;
- открытые условия #29–#38.

**Не включайте `KRUG_E2EE_ENABLED=true` без отдельного GO.**

## Секреты

- `deploy/.env` не коммитится; `.gitignore` исключает.
- Пароли/токены/коды/plaintext не логировать.
- Ротация Keycloak/S3/SMTP секретов; service account вместо master admin (тикет #40).

## Reporting

Для уязвимостей не создавайте публичный issue с секретами; свяжитесь с владельцем репозитория приватно.

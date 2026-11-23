# #100 — email-приглашения на незарегистрированный email

**Verdict: DONE (backend + contract + generated types).** Чистый полный backend-прогон
на JDK 21: **1042 tests, 0 failures, 0 errors, ArchUnit 10/10**. Оговорка про параллельные
сборки в общем workspace — в §7.

Срез добавляет одноразовые email-приглашения в воркспейс, публичный предпросмотр
invite-ссылки, привязку к нормализованному адресу и авто-вступление после подтверждения
email при регистрации. Миграция — `V56`. Все изменения аддитивные: существующие
email-less ссылки сохраняют многоразовую семантику, ни одна RLS-политика/грант не ослаблены.
Никакого E2EE в этом срезе нет.

## 1. Контракт и сгенерированные типы

`contracts/openapi.yaml` изменён аддитивно: **133 paths / 213 schemas** (было 132 / 212;
+1 path `GET /workspace-invites/{token}`, +1 schema `WorkspaceInvitePreview`).

* `WorkspaceInviteCreateRequest.email` — необязательный адрес; непустой означает
  одноразовое email-приглашение (`max_uses` принудительно `1`).
* `WorkspaceInvite.email` — нормализованный адрес для email-приглашения, `null` для ссылки.
* `AuthRegisterRequest.invite_token` — необязательный invite-токен.
* Новый `WorkspaceInvitePreview` — только `workspace_name`, `workspace_slug`, `role`,
  `email_bound`, `expires_at`.

`frontend/src/api/schema.d.ts` перегенерирован (`npm run api:types`, openapi-typescript
7.13.0). `npm run contract:check` проходит: *162 operations, 213 contract schemas, generated
types in sync*. Счётчики в `frontend/scripts/check-contract.mjs` обновлены на 133/213 (файл
вне заявленной зоны, но без этого contract-guard красный).

## 2. API

| Операция | Семантика |
|---|---|
| `POST /workspaces/{id}/invites` c `email` | OWNER/ADMIN (`manage_invites`) + role ceiling. Адрес нормализуется (`strip` + lower). Создаётся **single-use** приглашение (`max_uses=1`; явный `max_uses != 1` → `400 VALIDATION_FAILED`). Письмо уходит через существующий SMTP-адаптер (Mailpit в dev) с абсолютной ссылкой `PUBLIC_URL/workspace-invite/{token}`. В ответе, как и раньше, токен возвращается создателю один раз; в БД — только SHA-256. |
| `POST /workspaces/{id}/invites` без `email` | Прежняя email-less ссылка: `max_uses` 1..1000 или unlimited, письмо не отправляется. |
| `GET /workspace-invites/{token}` | **Анонимный** предпросмотр (`security: []`, `permitAll` для `GET`). SECURITY DEFINER функция по hash токена отдаёт имя/slug воркспейса, роль, `email_bound`, `expires_at`. Токен, его hash и адрес приглашённого не возвращаются. Неизвестный/недоступный — `404`; revoked/expired/exhausted — `410` с отдельным кодом; rate limit per IP. |
| `POST /workspace-invites/{token}/accept` | Без изменений для ссылок. Для email-приглашения SECURITY DEFINER функция сравнивает `invite.email` с `auth.users.email` без учёта регистра (citext + `lower()`); чужой аккаунт получает `403 WORKSPACE_INVITE_EMAIL_MISMATCH`, приглашение **не расходуется**. Повторный accept действующим участником идемпотентен. |
| `DELETE /workspaces/{id}/invites/{inviteId}` | Без изменений: идемпотентный revoke, после него email-приглашение не принимается. |
| `POST /auth/register` c `invite_token` | Токен валидируется по формату, хэшируется SHA-256 и сохраняется рядом с pending-регистрацией. Сырой токен не хранится. |
| `POST /auth/verify-email` | После подтверждения кода локальный пользователь провижинится, затем invite клеймится тем же атомарным `accept_invite`. Валидное/совпадающее приглашение → membership + `used_count=1`; повторный клейм идемпотентен. Истёкшее/отозванное/исчерпанное/чужое — молча игнорируется, приглашение остаётся как есть; ответ регистрации/верификации не меняется (нет enumeration). |

## 3. Регистрационный claim

* `auth.email_verifications.invite_token_hash` — `text` с CHECK `^[a-f0-9]{64}$`, nullable.
  Сырой `invite_token` не сохраняется ни в БД, ни в audit, ни в логах.
* `RegisterUserService` считает digest через общий `shared.domain.model.TokenDigest`
  (тот же SHA-256, что и у `WorkspaceInviteTokens`). Некорректный/пустой токен → `null`,
  регистрация отвечает ровно так же, как без токена.
* `VerifyEmailService` при наличии digest:
  1. провижинит локального `auth.users` (нужно для membership; работает и в ветке 2FA
     enrollment challenge),
  2. завершает обычный login-gate,
  3. вызывает `RegistrationInviteClaimPort` → `WorkspaceInviteService.claimAfterVerification`.
* `claimAfterVerification` использует тот же `workspace.accept_invite`, поэтому:
  * membership и `used_count` меняются атомарно под `FOR UPDATE`;
  * повторный вызов возвращает `already_member=true` и не пишет второй audit;
  * не-OK исходы (REVOKED/EXPIRED/EXHAUSTED/EMAIL_MISMATCH/NOT_FOUND) не бросают
    исключение и не меняют строку приглашения;
  * audit — `workspace.invite.accepted` с `invite_id`, `role`, `claim=registration`
    (только id/роль).

## 4. Миграция и RLS

`backend/src/main/resources/db/migration/V56__workspace_invite_email.sql`:

* `workspace.invites.email citext` (nullable) + CHECK длины 3..254 и
  `email IS NULL OR max_uses = 1`; частичный индекс `(workspace_id, email)`.
  Колонка живёт под существующей tenant FORCE RLS-политикой.
* `workspace.accept_invite(text, uuid)` заменена (`CREATE OR REPLACE`, сигнатура и
  прежние outcomes сохранены; добавлен `EMAIL_MISMATCH`). Сравнение адресов —
  регистронезависимое, invite не расходуется при mismatch.
* Новая `workspace.preview_invite(text)`: `SECURITY DEFINER`, `SET search_path =
  pg_catalog, pg_temp`, `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO krug_app`.
  Единственное анонимное чтение invite; возвращает только display-metadata.
* `auth.email_verifications.invite_token_hash` с CHECK на 64 hex; таблица, как и раньше,
  не tenant-RLS (pre-auth), доступ только у `krug_app`.
* Ни одна существующая колонка/политика/функция не удалена и не ослаблена.

## 5. Безопасность

* Токен — 32 случайных байта base64url; в БД только SHA-256 hex. В API-списке, audit,
  письме-логе и `WorkspaceInviteCreatedView.toString()` токен отсутствует/редактируется.
* `OutboundEmail.toString()` печатает `body=redacted`; SMTP-адаптер не логирует ни адрес,
  ни тело. Пароль SMTP по-прежнему расшифровывается только в памяти.
* Адрес приглашённого не попадает в audit (только `email_bound=true/false`) и не
  возвращается публичным preview.
* Rate limit: отправка письма — отдельные окна per workspace и per normalized email
  (`krug.rate-limit.invite-email-*`); публичный preview — per IP
  (`invite-preview-per-ip`). Оба независимы от link-invite/accept окон.
* Claim не раскрывает существование аккаунта: одинаковый `202`/`200` и для валидного,
  и для истёкшего/неизвестного токена.
* E2EE не затрагивается; фича-флаг остаётся выключенным по умолчанию.

## 6. Тесты

Новые классы:

| Класс | Тесты | Что покрыто |
|---|---|---|
| `WorkspaceInviteEmailIT` | **8** | отправка письма через SMTP-порт (captured MailAdapter — тот же путь, что Mailpit в dev), нормализация адреса, single-use, публичный preview без секретов, accept по совпадению, mismatch `403` без расхода, revoked/expired/unknown, email-less multi-use, role ceiling/`manage_invites`, `max_uses != 1`, rate limit per email, auto-claim после verify, идемпотентность, неудачный claim (revoked/expired/invalid token) |
| `WorkspaceInviteEmailDomainTest` | **6** | нормализация/валидация email, принудительный single-use, email-less multi-use, запрет OWNER, preview status |
| `WorkspaceInviteRateLimitTest` | **2** | окна per address/per workspace, preview per IP, fail-closed `429 RATE_LIMITED` |
| `SmtpMailAdapterWorkspaceInviteTest` | **1** | письмо уходит через `JavaMailSender` с корректными to/from/subject, body редактируется в `toString` |

Обновлён `AuthBffSchemaIT` (11 колонок + `invite_token_hash`). Изолированный прогон:

```
Tests run: 49, Failures: 0, Errors: 0, Skipped: 0
  WorkspaceInviteEmailIT 8, ProfileWorkspace82IT 29, AuthBffSchemaIT 3,
  WorkspaceInviteEmailDomainTest 6, WorkspaceInviteRateLimitTest 2,
  SmtpMailAdapterWorkspaceInviteTest 1
```

ArchUnit — **10/10** (в т.ч. domain purity и направление зависимостей:
`workspace.infrastructure` реализует auth-порт, `workspace.application` не зависит от
infrastructure/api).

## 7. Полный прогон

Чистый прогон всего backend на JDK 21 в изолированной копии workspace:

```
JAVA_HOME=$(/usr/libexec/java_home -v 21) \
  mvn -o -Dmaven.repo.local=../.m2repo test        # чистый target
Tests run: 1042, Failures: 0, Errors: 0, Skipped: 0
ArchitectureTest: 10/10
```

Это больше заявленного порога 995+. Первый прогон дал единственный flaky-сбой
`BotEventsIT` (ожидалась 2-я доставка app_mention); он прошёл изолированно и на повторном
полном прогоне — к #100 отношения не имеет.

Оговорка про общий workspace: параллельно работают другие агенты (#101 DLP,
retention/session и др.), поэтому прогон в общем `backend/` ловит гонки сборки
(`class path resource ... cannot be opened`, чужой `mvn clean`/recompile во время
запуска) и незакоммиченные чужие изменения. Отчётный прогон выше сделан в копии
`backend-run/` (удалена после проверки), чтобы `target` не клобберился соседями.
Финальный CI-прогон должен выполняться без параллельных сборок в том же каталоге.

Важно для окружения: Maven должен запускаться на **JDK 21**. Дефолтный `mvn` на этой
машине использует Java 26, где Byte Buddy/Mockito не инструментирует concrete-классы →
десятки ложных `MockitoException` в чужих unit-тестах.

## 8. Остаточные риски / замечания

* Письмо отправляется внутри транзакции создания приглашения: SMTP-ошибка → `503
  SMTP_UNAVAILABLE` и rollback (приглашение не остаётся «висящим»). Медленный SMTP держит
  транзакцию — для MVP допустимо; production-вариант — outbox.
* `email` в ответе списка/создания виден менеджерам воркспейса (OWNER/ADMIN). Это
  осознанно: админ должен видеть, кому выдано приглашение; публичный preview адрес не
  раскрывает.
* Токен для email-приглашения по-прежнему возвращается создателю в `POST`-ответе (для
  совместимости контракта). Ссылка считается секретом получателя; создатель и так имеет
  `manage_invites`.
* Письмо использует `PUBLIC_URL` (в backend уже приходит как WS-origin в deploy), а при
  его отсутствии — `KRUG_WS_ALLOWED_ORIGINS`, затем `http://localhost:5173`. Deploy должен
  выставлять публичный origin.

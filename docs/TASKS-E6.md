# E6 — Notifications slice (E6-B / E6-F)

> **Цель:** in-app уведомления и настройки: колокольчик, unread count, список, отметка прочитанного, предпочтения по типу/каналу.  
> **Контракт:** [`contracts/openapi.yaml`](<../contracts/openapi.yaml>) — `/notifications`, `/notifications/read`, `/notification-preferences`.  
> **Анализ:** [`docs/SYSTEM-ANALYSIS.md`](<SYSTEM-ANALYSIS.md>) §5, §7, §11.3, §14.4, §15.

## 0. Правила

| Зона | Владелец | Можно менять | Нельзя менять |
|---|---|---|---|
| `backend/**` | E6-B | всё внутри | `frontend/**`, `docs/**`, `contracts/**` |
| `frontend/**` | E6-F | всё внутри | `backend/**`, `docs/**`, `contracts/**` |

- Контракт расширен PM (23 paths / 26 operations / 35 schemas); менять нельзя.
- Managed и E2EE: **в E2EE тело уведомления всегда null**, только generic title/chat name. Не добавлять текст сообщения в E2EE.
- Email — через порт; dev-адаптер log, реальная отправка v1.
- Порты: backend 8081, frontend 5173, Keycloak 8180, PostgreSQL 5432; `8080` не трогать.

## 1. E6-B — backend: notifications

**Владелец:** backend-сессия  
**Оценка:** 1–2 сессии  
**Статус:** **DONE** — 269 тестов, ArchUnit 10/10, live 8081

### Scope

1. **DDD `ru.krug.backend.notification`**
   - domain: `Notification`, `NotificationType`, `NotificationPreference`, `Channel`, `Mode`, exceptions.
   - application: `ListNotificationsUseCase`, `MarkReadUseCase`, `GetPreferencesUseCase`, `UpdatePreferenceUseCase`, `NotifyUseCase`, ports `NotificationSenderPort`, `ChatDirectoryPort`, `ClockPort`.
   - infrastructure: JPA adapters, email/log sender, listener/consumer, scheduler (retention).
   - api: controllers/DTO/mappers.
   - ArchUnit обновить.
2. **V15**
   - `notifications` (id, user_id, workspace_id, chat_id, type, title, body, dedupe_key, read_at, created_at), `notification_preferences` (user_id, workspace_id, chat_id nullable, type, channel, mode).
   - RLS по `user_id` (и workspace); indexes `(user_id, created_at)`, unique `dedupe_key`.
   - Retention 90 дней (GC).
3. **События/логика**
   - На `message.created` (application event / outbox) создать уведомления всем active members чата, кроме отправителя.
   - `MENTION` — если есть упоминание (если в E6 нет mentions, только MESSAGE/SYSTEM; не выдумывать).
   - dedupe key: `(user_id, chat_id, message_id, type)`.
   - title generic: «Новое сообщение» + chat_name; body null для E2EE; для managed body можно null по умолчанию.
   - Не уведомлять при MUTE, учитывать prefs (IN_APP/EMAIL, ALL/MENTIONS/MUTE).
   - Email sender — log stub; не блокировать запрос.
4. **API**
   - `GET /notifications?cursor&limit` → items + page + unread_count.
   - `POST /notifications/read` `{ids?|all}` → 204; only own.
   - `GET /notification-preferences`; `PATCH` one pref; ownership; 422 invalid.
5. **Тесты**
   - fan-out, no self, dedupe, prefs MUTE, E2EE body null, unread count, mark read, pagination, foreign user 404/403, RLS;
   - full suite 249 baseline + ArchUnit 10/10.
6. **Live**: send message → notification for member not sender; list; read; prefs mute; E2EE fixture body null.

### Вне scope

Push/Web Push (v1), email provider, mentions parser, digest, quiet hours (v1), notification WS event (можно добавить позже), E2EE content.

## 2. E6-F — frontend: bell/panel/preferences

**Владелец:** frontend-сессия  
**Оценка:** 1–2 сессии  
**Статус:** **DONE** — 180 Vitest, contract 26/35, real notifications 1/1

### Scope

1. **Bell**
   - Иконка в sidebar/header с unread badge; загрузка `GET /notifications?limit=...` при bootstrap и периодически/после `message.created`.
   - Панель/список: title, chat_name, time, read/unread; empty/error/loading.
2. **Read**
   - «Прочитать все», клик по уведомлению → mark read + переход в чат (если возможно).
   - optimistic unread count; rollback.
3. **Preferences**
   - Экран/секция: per-chat/type/channel mode (ALL/MENTIONS/MUTE); `GET/PATCH`.
   - 80/95/100? Нет; только notification prefs.
4. **E2EE**
   - Не показывать body; generic title; бейдж/пояснение «контент скрыт».
5. **Tests**
   - MSW; RTL bell/panel/read/prefs/E2EE; Playwright mock; axe.
   - Contract types regen (23/26/35); `npm run check`.

### Вне scope

Push, email UI, digest, mentions parser, quiet hours.

### E6: результат

| Проверка | Результат |
|---|---|
| Backend E6-B | 269 тестов, ArchUnit 10/10; fan-out/no self/dedupe/MUTE/E2EE body null |
| Frontend E6-F | 180 Vitest, contract 26/35, mock e2e 11/11, axe |
| Real notifications E2E | **1 passed**: bell → panel → read all → unread cleared (seeded notification) |
| E2EE | body null, generic title, контент не рендерится |
| Retention | 90 дней, worker-role |

## 3. Acceptance (E6-AC)

| ID | Сценарий | Ожидание |
|---|---|---|
| E6-AC-01 | Новое сообщение | Участник (не отправитель) получает in-app notification |
| E6-AC-02 | Unread | badge/unread_count корректен |
| E6-AC-03 | Read one/all | 204, badge уменьшается, идемпотентно |
| E6-AC-04 | Prefs MUTE | уведомление не создаётся/не показывается |
| E6-AC-05 | E2EE | body null, generic title |
| E6-AC-06 | Pagination | cursor, has_more, стабильный порядок |
| E6-AC-07 | Foreign user | 403/404, RLS |
| E6-AC-08 | A11y | bell/panel доступны с клавиатуры, aria-live |

## 4. Решения

| ID | Решение | Причина |
|---|---|---|
| E6-D-01 | In-app first, email stub | MVP; push/email v1 |
| E6-D-02 | Body null по умолчанию | Приватность; E2EE не читается |
| E6-D-03 | Dedup by message/user/type | Повторные события не плодят уведомления |
| E6-D-04 | No WS notification event в E6 | Достаточно fetch после `message.created`; WS event — v1 |

## 5. Известный долг

- Push/email provider, mentions, digest, quiet hours — v1.
- Нет notification WS event; polling/fetch.
- Email dev log stub.

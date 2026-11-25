# Каталог событий и контракты

> Дополняет [MICROSERVICES.md §5.2](MICROSERVICES.md#52-события). Схемы лежат в `contracts/events/` (создаются в Wave 0).
> Диаграмма механики — [06-event-flow](diagrams/svg/06-event-flow.svg).

---

## 1. Принципы

1. **Событие — факт, а не команда.** `message.created` — «сообщение создано», а не «отправь push».
2. **At-least-once.** Консьюмер идемпотентен по `event_id`; duplicate — норма.
3. **Порядок только в пределах `partition_key`.** Глобального порядка нет.
4. **Контракт версионируется.** Ломающее изменение — новый major-топик.
5. **Никакого plaintext, ключей, токенов и PII сверх необходимого.**
6. **Outbox — единственный способ публикации.** Публикация «после коммита» без outbox запрещена.
7. **DLQ обязательна.** Poison-сообщение не блокирует партицию.

---

## 2. Envelope

```json
{
  "event_id": "018f3b6f-4e6c-7a2a-9c1a-2a0d9f7b1c33",
  "type": "message.created",
  "version": 1,
  "occurred_at": "2026-11-25T08:21:44.512Z",
  "producer": "conversation",
  "workspace_id": "6b0f3a3e-...",
  "aggregate_type": "message",
  "aggregate_id": "b1e0...",
  "partition_key": "chat:8f2c...",
  "trace_id": "4bf92f3577b34da6",
  "actor_id": "3c1e...",
  "payload": {}
}
```

| Поле | Обязательно | Правило |
|---|---|---|
| `event_id` | да | UUID, уникален навсегда; ключ дедупа |
| `type` | да | `<domain>.<entity>.<action>`, lower-case |
| `version` | да | целое, начиная с 1 |
| `occurred_at` | да | UTC ISO-8601, время бизнес-факта |
| `producer` | да | имя сервиса |
| `workspace_id` | для тенантных | RLS/фильтр; `null` только для platform-событий |
| `aggregate_type/id` | да | тип и ID агрегата |
| `partition_key` | да | `chat:<id>`, `workspace:<id>`, `user:<id>` |
| `trace_id` | желательно | W3C traceparent |
| `actor_id` | если есть | кто инициировал; для ботов — `bot:<id>` |
| `payload` | да | схема в `contracts/events/<type>.v<version>.json` |

---

## 3. Топики

### 3.1. Доменные

| Топик | Партиции | Ключ | Retention | Владелец |
|---|---:|---|---|---|
| `krug.identity.v1` | 12 | `user_id` | 14 дней | `identity` |
| `krug.workspace.v1` | 12 | `workspace_id` | 14 дней | `workspace` |
| `krug.chat.v1` | 24 | `chat_id` | 14 дней | `conversation` |
| `krug.message.v1` | 48 | `chat_id` | 7 дней | `conversation` |
| `krug.media.v1` | 12 | `workspace_id` | 14 дней | `media` |
| `krug.plugin.v1` | 12 | `workspace_id` | 14 дней | `extensions` |
| `krug.notify.v1` | 12 | `user_id` | 7 дней | `notification` |
| `krug.realtime.v1` | 24 | `chat_id` | 3 дня | `realtime` |

### 3.2. Служебные

| Топик | Назначение | Ключ | Retention |
|---|---|---|---|
| `krug.chat.acl.v1` | compacted-снапшоты ACL чата (members, roles, epoch) | `chat_id` | compact |
| `krug.message.v1.dlq` | poison-сообщения | — | 14 дней |
| `krug.audit.v1` | экспорт аудита в SIEM (внешний консьюмер) | `workspace_id` | 30 дней |

`krug.chat.acl.v1` — единственный compacted-топик: по нему `realtime`/`media` восстанавливают ACL-кэш после рестарта, не дергая `conversation` на каждый чих.

---

## 4. Каталог событий

> В таблицах указано короткое имя события. Полный `type` в envelope = `<bounded-context>.<event>`:
> `member.changed` из Workspace → `workspace.member.changed`, `scan.completed` из Media → `media.scan.completed`.
> Для служебных событий (`receipt.*`, `audit.*`) префикс уже входит в имя.

### 4.1. Identity

| Событие | Payload (минимум) | Потребители |
|---|---|---|
| `user.registered` | user_id, workspace_id?, created_at | workspace, notification, admin, audit |
| `user.updated` | user_id, changed_fields[], version | conversation, notification, admin, audit |
| `user.deleted` | user_id, deleted_at, anonymized | workspace, conversation, media, audit, admin |
| `device.revoked` | user_id, device_id, reason, key_generation | conversation, realtime, notification, audit |
| `device.keys.updated` | user_id, device_id, key_generation, prekey_count | conversation, realtime |
| `session.revoked` | user_id, session_id, reason | realtime, audit |

### 4.2. Workspace

| Событие | Payload | Потребители |
|---|---|---|
| `workspace.created` | workspace_id, name, owner_id, plan | conversation, media, notification, admin |
| `workspace.updated` | workspace_id, changed_fields[], version | conversation, media, admin |
| `workspace.deleted` | workspace_id, deleted_at | conversation, media, audit, admin |
| `member.changed` | workspace_id, user_id, role, status, actor_id | conversation, media, notification, audit |
| `invite.accepted` | invite_id, workspace_id, user_id, chat_id? | notification, audit, admin |
| `limits.changed` | workspace_id, limits{}, version | conversation, media |
| `policy.changed` | workspace_id, policy_type, version | conversation, audit |
| `security.changed` | workspace_id, mode, changed_fields[] | conversation, media, audit |

### 4.3. Chat

| Событие | Payload | Потребители |
|---|---|---|
| `chat.created` | chat_id, workspace_id, type, security_mode, member_ids[] | realtime, notification, search, admin, audit |
| `chat.updated` | chat_id, changed_fields[], version | realtime, search, admin, audit |
| `chat.member.changed` | chat_id, user_id, old_role, new_role, status, actor_id, epoch | realtime, conversation (internal), notification, search, audit |
| `chat.pin.changed` | chat_id, message_id, action, actor_id | realtime, audit |
| `chat.archived` | chat_id, archived_by, at | realtime, search, audit |

`chat.member.changed` — триггер инвалидации ACL-кэша и (для E2EE) ротации sender keys. `epoch` обязателен: консьюмер игнорирует событие с `epoch` меньше известного.

### 4.4. Message

| Событие | Payload | Потребители |
|---|---|---|
| `message.created` | message_id, chat_id, seq, sender_id, type, created_at, attachment_ids[], sticker_id?, thread_root_id?, e2ee, plugin_content? | realtime, notification, extensions, search (managed), admin, audit |
| `message.edited` | message_id, chat_id, seq, version, edited_at, editor_id | realtime, search, admin, audit |
| `message.deleted` | message_id, chat_id, seq, deleted_by, scope, deleted_at | realtime, media (attachments), search, admin, audit |
| `message.reaction.changed` | message_id, chat_id, user_id, emoji, action, count | realtime, audit |
| `message.read` | chat_id, user_id, last_read_seq | notification, admin |
| `message.delivered` | message_id, user_id, device_id, delivered_at | notification, admin |

`message.created` **не содержит** plaintext, конвертов и вложений-блобов. Только IDs и метаданные. Для E2EE `payload.e2ee=true`, конверты — через `POST /internal/v1/messages/envelopes:batch`.

### 4.5. Media

| Событие | Payload | Потребители |
|---|---|---|
| `upload.completed` | upload_id, attachment_id, workspace_id, size_bytes, sha256, scan_status | conversation (readiness cache), audit |
| `media.scan.completed` | attachment_id, workspace_id, scan_status (CLEAN/INFECTED/FAILED), engine, details | conversation, realtime, notification, audit |
| `quota.threshold.reached` | workspace_id, threshold (80/95/100), used, limit | notification, audit, admin |
| `sticker.pack.changed` | pack_id, workspace_id, status, enabled_chat_ids[], version | realtime, search, admin, audit |
| `attachment.deleted` | attachment_id, workspace_id, reason | conversation, audit |

### 4.6. Extensions

| Событие | Payload | Потребители |
|---|---|---|
| `plugin.installed` | installation_id, plugin_id, version, permissions[] | audit, notification, admin |
| `plugin.enabled` | chat_id, installation_id, plugin_id, enabled_by | realtime, audit |
| `plugin.disabled` | chat_id, installation_id, reason | realtime, audit |
| `plugin.killed` | plugin_id, installation_id, scope, reason | realtime, audit, notification |
| `plugin.consent.changed` | chat_id, user_id, plugin_id, decision | realtime, audit |
| `bot.event.delivered` | bot_id, delivery_id, event_type, status, attempt | admin, audit |
| `bot.event.failed` | bot_id, delivery_id, event_type, status, error_class | admin, audit |
| `poll.closed` | chat_id, poll_id, message_id, closed_by | conversation (projection), realtime, audit |
| `task.updated` | chat_id, task_id, changed_fields[] | conversation (projection), realtime, audit |

### 4.7. Realtime

| Событие | Payload | Потребители |
|---|---|---|
| `receipt.delivered` | message_id, chat_id, user_id, device_id, at | conversation, notification |
| `receipt.read` | chat_id, user_id, last_read_seq | conversation, notification, admin |
| `call.ended` | call_id, chat_id, kind, duration_ms, participants[] | audit, admin |

`typing` и `presence` — **не** Kafka: Redis pub/sub + TTL. Они не replay-ятся и не являются фактами.

### 4.8. Notification и audit

| Событие | Payload | Потребители |
|---|---|---|
| `notification.sent` | notification_id, user_id, channel, at | audit, admin |
| `notification.failed` | notification_id, user_id, channel, error_class, attempt | audit, admin |
| `audit.appended` | audit_id, workspace_id, action, actor_id, hash | SIEM, admin |
| `audit.anchor.created` | workspace_id, anchor_id, period, hash | SIEM, admin |

### 4.9. Служебное

| Событие | Назначение |
|---|---|
| `search.index.requested` | явный reindex (managed) |
| `search.index.completed` | метрика/аудит reindex |
| `breakglass.approved` / `breakglass.access` | контроль доступа |

---

## 5. Матрица producer/consumer

`P` — публикует, `C` — потребляет, `—` — не участвует.

| Сервис | identity | workspace | chat | message | media | plugin | realtime | notify |
|---|---|---|---|---|---|---|---|---|
| `identity` | **P** | — | — | C | — | — | C | C |
| `workspace` | C | **P** | C | C | C | — | — | C |
| `conversation` | C | C | **P** | **P** | C | C | C | — |
| `media` | C | C | C | C | **P** | — | — | — |
| `realtime` | C | — | C | C | C | C | **P** | — |
| `notification` | C | C | C | C | C | C | — | **P** |
| `extensions` | C | C | C | C | C | **P** | — | — |
| `audit` | C | C | C | C | C | C | C | C |
| `search` | — | C | C | C | — | — | — | — |
| `admin` | C | C | C | C | C | C | C | C |

`audit` и `admin` потребляют всё — это осознанно: они строят производные представления. Если это станет дорого, вводится отдельный `audit-fanout`/`projection` consumer group с батчингом.

---

## 6. Совместимость

| Изменение | Допустимо | Как |
|---|---|---|
| Добавить необязательное поле | да | minor, consumer игнорирует неизвестное |
| Добавить обязательное поле | нет | новый major + dual publish на переходный период |
| Удалить/переименовать поле | нет | deprecated → 2 релиза → major |
| Изменить тип | нет | новое поле + миграция |
| Изменить семантику | нет | новый `type` или major |
| Добавить значение enum | осторожно | consumer должен знать fallback |

Правила:

- consumer обязан игнорировать неизвестные поля (Jackson `FAIL_ON_UNKNOWN_PROPERTIES=false`);
- producer не удаляет поля без deprecation-периода;
- `version` в envelope = major; схема — `<type>.v<version>.json`;
- CI сравнивает схемы с `main` и блокирует ломающие изменения без major.

---

## 7. Доставка, идемпотентность, порядок

### 7.1. Идемпотентность

- ключ — `event_id`;
- таблица `processed_events(event_id PK, consumer, processed_at)` в БД консьюмера;
- TTL — не меньше retention топика (7–14 дней);
- альтернатива для upsert-моделей — естественный ключ (`message_id`, `attachment_id`).

### 7.2. Порядок

- гарантируется только в пределах `partition_key`;
- `message.*` — ключ `chat_id`, поэтому `seq` приходит по порядку;
- `chat.member.changed` — ключ `chat_id`, `epoch` защищает от reorder;
- `user.*` — ключ `user_id`; межпользовательский порядок не гарантирован.

### 7.3. Retry и DLQ

- retry с exponential backoff (1s → 2s → … → 1 мин), максимум 5–8 попыток;
- non-retryable (schema error, 4xx) — сразу DLQ;
- DLQ-алерт при любом сообщении;
- replay: инструмент `kafka-replay` с фильтром по `type`/`event_id`, идемпотентный.

### 7.4. Replay и rebuild

- `krug.chat.acl.v1` compacted — восстановление ACL-кэша;
- `admin`/`search` — полный rebuild из топиков с retention;
- для истории сообщений replay не используется: источник — `conversation` API/БД.

---

## 8. Безопасность и E2EE

| Правило | Детали |
|---|---|
| Нет plaintext | `message.created` не содержит текст, даже managed |
| Нет конвертов | E2EE-конверты не кладутся в Kafka; только `e2ee=true` + batch-запрос |
| Нет токенов/ключей | никогда, ни в payload, ни в headers |
| Нет лишнего PII | email/телефон — только в `identity`; в событиях — `user_id` |
| Аудит | metadata-only; контент не пишется |
| ACL | compacted ACL-топик содержит только ID и роли, без профилей |
| Push | без контента; `notification` не получает plaintext |
| Логи | `event_id`, `type`, `workspace_id`; без payload |

---

## 9. Примеры схем

### 9.1. `message.created.v1.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://krug/contracts/events/message.created.v1.json",
  "type": "object",
  "required": ["message_id", "chat_id", "seq", "sender_id", "type", "created_at", "e2ee"],
  "properties": {
    "message_id": { "type": "string", "format": "uuid" },
    "chat_id": { "type": "string", "format": "uuid" },
    "seq": { "type": "integer", "minimum": 1 },
    "sender_id": { "type": "string", "format": "uuid" },
    "type": { "type": "string", "enum": ["TEXT", "STICKER", "POLL", "TASK"] },
    "created_at": { "type": "string", "format": "date-time" },
    "e2ee": { "type": "boolean" },
    "attachment_ids": { "type": "array", "items": { "type": "string", "format": "uuid" }, "maxItems": 10 },
    "sticker_id": { "type": ["string", "null"], "format": "uuid" },
    "thread_root_id": { "type": ["string", "null"], "format": "uuid" },
    "plugin_content": { "type": ["object", "null"] }
  },
  "additionalProperties": false
}
```

### 9.2. `media.scan.completed.v1.json`

```json
{
  "type": "object",
  "required": ["attachment_id", "workspace_id", "scan_status"],
  "properties": {
    "attachment_id": { "type": "string", "format": "uuid" },
    "workspace_id": { "type": "string", "format": "uuid" },
    "scan_status": { "type": "string", "enum": ["CLEAN", "INFECTED", "FAILED"] },
    "engine": { "type": "string" },
    "details": { "type": ["string", "null"] }
  },
  "additionalProperties": false
}
```

---

## 10. Чек-лист нового события

- [ ] тип и версия согласованы с владельцем домена;
- [ ] схема в `contracts/events/`, CI-валидация;
- [ ] нет plaintext/PII/секретов;
- [ ] `partition_key` выбран осознанно;
- [ ] producer пишет в outbox в той же транзакции;
- [ ] consumer идемпотентен, есть DLQ;
- [ ] добавлено в матрицу §5 и в [service-catalog.yaml](service-catalog.yaml);
- [ ] обновлены дашборды lag/DLQ;
- [ ] есть тест duplicate/replay;
- [ ] документация и пример payload.

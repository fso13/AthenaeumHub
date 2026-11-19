# G4f — durable receiver dedupe (P1-01) + reload/unread/notification

> **Итог: PARTIAL.** Durable dedupe P1-01, reload-поведение и локальный
> unread-учёт исправлены и покрыты тестами. Серверное уведомление для
> replacement нельзя удалить/надёжно сопоставить существующим API: в DTO
> `Notification` нет `message_id`, а сервер не видит маркер внутри E2EE-payload.
> Точное ограничение — §5; ничего не подделывается.
>
> **Зона:** только `frontend/**`. `backend/**`, `contracts/**`, `docs/**`,
> `design/**`, `schema.d.ts`, base E2EE flag не менялись. Base-флаги остались
> `false`; для прогона F7B временно поднимался тестовый overlay, после прогона
> стек возвращён на base (проверено: `KRUG_E2EE_ENABLED=false`,
> `VITE_E2EE_ENABLED:"false"`).

## 1. Что было сломано

P1-01 REVIEW-14: `retry_of_client_message_id` жил только в in-memory
`E2eeReceiveOutcome`. После reload `receive()` отвечал
`DUPLICATE_OR_OLD_MESSAGE` / `NO_SESSION`, store восстанавливал sealed copy, но
не знал, что это replacement:

- replacement рендерился вторым видимым сообщением;
- failed original рендерился error-строкой рядом с replacement;
- hidden replacement всё равно увеличивал unread и создавал notification.

## 2. Durable marker в sealed incoming copy

- `LocalCopyPayloadV1` и `StoredLocalMessageCopy` получили
  `retryOfClientMessageId: string | null` (`src/e2ee/outbox/types.ts`).
- `prepareLocalCopy` валидирует UUID/null и пишет маркер **и** в sealed payload,
  **и** в plaintext-mirror stored-записи; `decryptLocalCopy` сверяет оба
  источника (tamper → `KEY_STORAGE_UNAVAILABLE`).
- `commitIncomingE2eeMessage` передаёт `opened.retryOfClientMessageId` в copy
  (`src/e2ee/session/receive.ts`). Outgoing copy тоже self-describing.
- Legacy-копии без поля читаются: payload default `null`, mirror проверяется
  только если присутствует.
- `lookupIncomingLocalCopy` / `E2eeLocalCopyView` отдают маркер
  (`src/e2ee/app/chatBridge.ts`, `src/e2ee/app/types.ts`), поэтому reload-путь
  не зависит от живого receive outcome.

## 3. Reload-дедуп: одно видимое сообщение

`chatStore.decryptE2eeSlice` теперь применяет маркер из:

- `outcome.kind === 'message'` (live replacement);
- `outcome.kind === 'none'` + sealed copy (reload);
- error-ветки + sealed copy (сессия уже удалена).

Правило:

- original `decrypted`/`superseded` → replacement `superseded` (скрыт);
- original `failed`/`unavailable`/error → original `superseded`, replacement
  показывается;
- reset, поставленный в очередь для скрытого original, отменяется: replacement
  уже доставил это окно, повторный `SESSION_RESET` не отправляется.

## 4. Unread / notification

### 4.1 Unread

- `readSeq` восстанавливается из контрактного инварианта
  `unread_count = last_seq - last_read_seq` (`loadChat` и `applySync`), поэтому
  reload знает серверный read-cursor без нового API.
- Для deduped пары локальный duplicate-unread вычитается ровно один раз:
  hidden replacement или original, который тоже был unread. Видимый replacement
  сохраняет один unread, если logical message реально не прочитан.
- `POST /chats/{id}/read` вызывается только когда hidden replacement — хвост без
  разрыва (`unread == 0`, `readSeq >= replacement.seq - 1`) и все строки после
  `readSeq` — скрытые дубли; иначе unrelated-сообщения не помечаются
  прочитанными. Для batch после decrypt-прохода есть отдельная проверка хвоста.
- Гарантия «0 unread» после reload достигнута в безопасном случае (replacement —
  единственный unread-tail). Если unread-gap содержит другие сообщения, сервер
  нельзя пометить по одному сообщению: `last_read_seq` — курсор, отдельного
  per-message read API нет (§5.2).

### 4.2 Notification — best-effort + честный PARTIAL

Клиент:

- ставит в очередь подавление notification для времени replacement;
- ищет кандидата только в том же `chat_id`, только после `message.created_at` и
  не дальше `+250 ms`, и только если кандидат **ровно один**;
- если кандидат unread — вызывает существующий
  `POST /notifications/read {ids:[id]}` и убирает строку из панели; повторный
  refresh снова применяет подавление (маркер durable).

**Точное серверное ограничение:** контракт `Notification` содержит только
`id, type, chat_id, chat_name, title, body, created_at, read` — без
`message_id`. `dedupe_key` с message_id есть только в БД и наружу не отдаётся.
`/notifications/read` умеет только помечать, delete-API нет. Сервер не видит
`retry_of_client_message_id` (поле внутри запечатанного TEXT_JSON), поэтому не
может не создавать notification для replacement. Если кандидатов 0 или >1,
клиент **не трогает** уведомление и не угадывает. Следовательно literal
«0 уведомлений на сервере» без backend-изменения недостижим; UI-подавление и
read-флаг работают, но строка остаётся в БД. Это причина статуса **PARTIAL**.

## 5. Тесты

Добавлено:

- `src/e2ee/outbox.test.ts` +2 — durable roundtrip маркера в sealed copy,
  legacy `null`, tamper mirror/payload → `KEY_STORAGE_UNAVAILABLE`.
- `src/e2ee/sessionSendReceive.test.ts` +1 — реальный send/receive:
  `retry_of_client_message_id` доезжает в inner payload, sealed incoming copy и
  outgoing copy.
- `src/store/e2eeChat.test.ts` +3:
  - reload B после R-15: original `decrypted`, replacement `superseded`, ровно
    одна видимая копия, unread 0, safe `markRead` дошёл до сервера, notification
    replacement помечен read и скрыт;
  - failed original: original `superseded`, replacement `decrypted`, reset не
    отправлен;
  - hidden replacement не добавляет unread.
- `e2e/e2ee.real.spec.ts` R-15 step: после reset перезагружается **B**;
  `markerA/markerLost/markerR15` ровно по одному, нет
  «Не удалось расшифровать сообщение» и «Недоступно на этом устройстве».

### Результаты

| Проверка             | Результат                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `npm run check`      | **exit 0**, 81 файл, **876/876** тестов, lint/format/contract/security/session-writers/build зелёные |
| F7B real E2EE        | **2 passed** (Chromium 7.7 s, Firefox 9.5 s), 2 skipped gated negative key-change                    |
| Base flag            | `KRUG_E2EE_ENABLED=false`, SPA `VITE_E2EE_ENABLED:"false"` после возврата стека                      |
| Overlay на время F7B | backend `KRUG_E2EE_ENABLED=true`, SPA `"true"`                                                       |
| Plaintext в WS/логах | не менялось; F7B assertions прошли (`wsFrames`/backend logs без маркеров)                            |

Firefox в песочнице запускался с writable
`TMPDIR=$PWD/.pw-tmp CFFIXED_USER_HOME=$PWD/.pw-home
MOZ_DISABLE_CONTENT_SANDBOX=1 MOZ_DISABLE_GPU_SANDBOX=1` — это ограничение среды,
не проекта.

## 6. Остаточные ограничения (не замаскированы)

1. **Server notification row** для replacement остаётся в БД: нет `message_id` в
   DTO и нет delete-API. Требуется backend-изменение (expose `message_id`/
   dedupe-ключ и/или серверный dedupe по retry-маркеру, что невозможно без
   раскрытия маркера).
2. **Per-message unread** безопасно закрывается только для gapless tail. При
   наличии других unread-сообщений между `readSeq` и replacement клиент не
   двигает `last_read_seq` (иначе fake-read); локальный бейдж подавляется, но
   следующий `/sync` вернёт серверный счётчик. Нужен per-message read API или
   серверный dedupe.
3. Клиентская эвристика notification ограничена окном 250 ms и уникальностью;
   при неоднозначности уведомление остаётся (осознанно, без fake-read).

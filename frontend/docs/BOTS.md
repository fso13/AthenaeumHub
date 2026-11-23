# #96 — боты: UI и API-сниппет

MVP-срез «боты как в Slack»: бот создаётся в пространстве, один раз получает
bearer-токен, устанавливается в MANAGED GROUP-канал и может отправлять туда
сообщения. Чтение истории, события, slash-команды, файлы и звонки боту
недоступны.

## Где это в UI

| Экран                           | Что можно сделать                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `Настройки → Боты`              | Список ботов пространства (читают все ACTIVE-участники), создание, смена токена, включение/отключение, удаление (OWNER/ADMIN).               |
| `Настройки чата → Боты` (GROUP) | Список установленных ботов, установка активного бота пространства, удаление из чата (chat OWNER/ADMIN). E2EE-канал показывает честный отказ. |
| Лента сообщений                 | Бот определяется по `sender_type=BOT`; рядом с именем рисуется бейдж «БОТ». Реакции и ответы доступны, редактирование/удаление — нет.        |

## Одноразовый токен

- `POST /workspaces/{id}/bots` и `POST /workspaces/{id}/bots/{botId}/token`
  — единственные ответы, содержащие `token`.
- UI показывает токен в модальном окне **один раз**, кладёт его только в
  in-memory snapshot `botsStore` и очищает при закрытии окна, уходе с вкладки,
  смене пространства и logout.
- Токен не пишется в `localStorage`/`sessionStorage`, не логируется и не
  попадает в audit (сервер хранит SHA-256 hash).
- Повторно увидеть токен нельзя: нужен новый (`Сменить токен`); старый
  становится недействителен сразу после ротации.

## curl-сниппет

Переменные: `SOVA_API` (например `https://sova.example/api/v1`),
`ACCESS_TOKEN`/`DEVICE_ID` — обычная пользовательская сессия,
`BOT_TOKEN` — значение из одноразового окна.

```bash
# 1. Создать бота. Ответ один раз содержит token.
curl -X POST "$SOVA_API/workspaces/$WORKSPACE_ID/bots" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Device-Id: $DEVICE_ID" \
  -H "Content-Type: application/json" \
  -d '{"name":"Сова Помощник","scopes":["chat.write"]}'

# 2. Установить его в MANAGED GROUP-канал (chat OWNER/ADMIN).
curl -X POST "$SOVA_API/chats/$CHAT_ID/bots" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Device-Id: $DEVICE_ID" \
  -H "Content-Type: application/json" \
  -d '{"bot_id":"'$BOT_ID'"}'

# 3. Отправить сообщение от имени бота. JWT и X-Device-Id не нужны:
#    Authorization — только bot token, Idempotency-Key обязателен.
curl -X POST "$SOVA_API/bots/$BOT_ID/messages" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"chat_id":"'$CHAT_ID'","text":"Привет от бота"}'
```

Повтор с тем же `Idempotency-Key` и тем же телом возвращает исходное сообщение
и `Idempotent-Replay: true`; другое тело даёт `409 IDEMPOTENCY_KEY_REUSED`.

## Сообщение бота

Сервер создаёт строку с `type=TEXT`, `sender_type=BOT`, `bot_id`, именем бота
в `sender_display_name` и **без** `sender_id`/`sender_device_id`. UI:

- рисует бейдж по `sender_type`, а не по имени (пользователь с именем бота
  бейдж не получает, переименование бота не переписывает историю);
- не показывает «Вы», редактирование и удаление;
- оставляет реакции, ответы, закрепление и переход в тред.

## Права

| Действие                          | Требование                                    |
| --------------------------------- | --------------------------------------------- |
| `GET /workspaces/{id}/bots`       | ACTIVE-участник пространства                  |
| create / rotate / update / delete | workspace OWNER/ADMIN                         |
| `GET /chats/{id}/bots`            | ACTIVE-участник чата                          |
| install / uninstall               | chat OWNER/ADMIN                              |
| `POST /bots/{id}/messages`        | bot token, scope `chat.write`, бот установлен |

## Ошибки

`BOT_NOT_FOUND`, `BOT_DISABLED`, `BOT_NOT_INSTALLED`, `BOT_SCOPE_FORBIDDEN`,
`BOT_E2EE_UNSUPPORTED`, `BOT_AVATAR_INVALID`; `401` для битого/чужого/старого
токена, `429 RATE_LIMITED` + `Retry-After`.

## Ограничения MVP

Нет чтения истории, `chat.read`, файлов, звонков, DLP/audit для bot-сообщений,
загрузки/раздачи аватара бота и управления `enabled` установки через API. Бот не
является участником чата.

Подписки на события, signing secret, статусы доставок и slash-команды описаны в
[`BOT-EVENTS.md`](./BOT-EVENTS.md).

## MSW

`src/mocks/handlers.ts` покрывает все 9 операций: create/list/update/disable/
rotate, listChat/install/uninstall, send (проверка bot token, установки,
MANAGED-канала, идемпотентности). Токен хранится только в mock-записи как
серверный секрет и вырезается из каждого ответа, кроме одноразового
`BotToken`.

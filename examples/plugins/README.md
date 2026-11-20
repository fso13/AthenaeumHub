# Примеры внешних плагинов Sova

## Standup Timer

Готовый статический плагин: таймер на 5 минут для стендапа.

```
standup-timer/
├── manifest.json
├── index.html
└── assets/
    ├── app.js
    └── style.css
```

Сборка и установка:

```bash
cd examples/plugins/standup-timer
zip -r ../standup-timer.zip . -x '.*' -x '__MACOSX/*'
# Админ → Плагины → Управление пакетами → загрузить standup-timer.zip
```

Плагин не запрашивает permissions, не обращается к сети и не читает данные Sova.
Он общается с хостом только через `postMessage` (`sova.ready`, `sova.log`).

Другие идеи:

- **Poll digest** — экспорт результатов опроса в Markdown/CSV.
- **On-call handoff** — панель дежурств и напоминание о передаче смены.
- **Release checklist** — чек-лист релиза в панели канала.
- **Message highlighter** — подсветка ключевых слов в видимом сообщении (read-only).
- **Meeting notes** — заметки встречи с экспортом в файл.

Полная спецификация: [`docs/PLUGIN-DEVELOPMENT.md`](../../docs/PLUGIN-DEVELOPMENT.md).

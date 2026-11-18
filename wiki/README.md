# Wiki source

Страницы в этой папке — источник для GitHub Wiki. GitHub не даёт API создать первую страницу:
один раз откройте https://github.com/fso13/AthenaeumHub/wiki и нажмите **Create the first page**,
затем опубликуйте:

```bash
./scripts/publish-wiki.sh
```

Скрипт клонирует `AthenaeumHub.wiki.git`, копирует `*.md` и пушит. После этого страницы доступны
по адресам `Home`, `User-Guide`, `Admin-Guide`, `Developer-Guide`, `Architecture`, `API`,
`Security`, `Operations`, `Roadmap`, `Troubleshooting`.

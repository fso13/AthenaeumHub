/* ══════════════════════════════════════════════════════════════
   Сова — Message Dashboard · демо-логика
   Моки данных, рендер, переключение тем/пространств/чатов.
   ══════════════════════════════════════════════════════════════ */

(() => {
  "use strict";

  /* ─────────── данные ─────────── */

  const PEOPLE = {
    me: { name: "Дмитрий Крылов", short: "ДК", pal: "av-me", online: true, title: "Админ канала" },
    anna: { name: "Анна Ким", short: "АК", pal: "p1", online: true, title: "Продакт-лид" },
    igor: { name: "Игорь Власов", short: "ИВ", pal: "p2", online: true, title: "Фронтенд" },
    lena: { name: "Лена Орлова", short: "ЛО", pal: "p3", online: false, title: "Дизайнер" },
    egor: { name: "Егор Титов", short: "ЕТ", pal: "p4", online: true, title: "Бэкенд" },
    pavel: { name: "Павел Гринёв", short: "ПГ", pal: "p6", online: false, title: "Интеграции" },
    timur: { name: "Тимур Ахметов", short: "ТА", pal: "p7", online: false, title: "Гость" },
    maria: { name: "Мария Соколова", short: "МС", pal: "p5", online: true, title: "Дизайн-лид" },
    mama: { name: "Мама", short: "Л", pal: "p9", online: true, title: "Людмила Николаевна" },
    anya: { name: "Аня", short: "А", pal: "p5", online: true, title: "Сестра" },
    papa: { name: "Папа", short: "С", pal: "p7", online: false, title: "Сергей Петрович" },
    olya: { name: "Оля", short: "О", pal: "p3", online: false, title: "Кузина" }
  };

  const ROLE_LABEL = {
    owner: "Владелец",
    admin: "Админ",
    mod: "Модератор",
    member: "Участник",
    guest: "Гость"
  };

  const MEDIA = [
    "assets/media-grid.svg",
    "assets/media-type.svg",
    "assets/media-color.svg",
    "assets/media-chart.svg"
  ];

  const NAV = {
    studio: [
      { icon: "dashboard", label: "Обзор", view: "overview" },
      { icon: "folder", label: "Файлы", view: "files" },
      { icon: "plug", label: "Плагины", view: "plugins" },
      { icon: "shield", label: "Защита", view: "security" },
      { icon: "settings", label: "Настройки", view: "settings" }
    ],
    family: [
      { icon: "dashboard", label: "Обзор", view: "overview" },
      { icon: "folder", label: "Файлы", view: "files" },
      { icon: "plug", label: "Плагины", view: "plugins" },
      { icon: "shield", label: "Защита", view: "security" },
      { icon: "settings", label: "Настройки", view: "settings" }
    ]
  };

  const PAGE_META = {
    overview: "Обзор",
    files: "Файлы",
    plugins: "Плагины",
    security: "Защита",
    settings: "Настройки"
  };

  const PLUGIN_CATALOG = [
    { id: "polls", icon: "poll", name: "Опросы", desc: "Голосования и быстрые решения прямо в переписке.", on: true, perms: ["Сообщения", "Участники"], client: false },
    { id: "tasks", icon: "task", name: "Задачи", desc: "Чек-листы, дедлайны и напоминания в чате.", on: true, perms: ["Сообщения"], client: false },
    { id: "translate", icon: "translate", name: "Перевод", desc: "Перевод входящих сообщений на лету.", on: false, perms: ["Сообщения"], client: false },
    { id: "telegram", icon: "plug", name: "Мост в Telegram", desc: "Двусторонний мост для внешних команд и подрядчиков.", on: true, perms: ["Сообщения", "Участники", "Вебхуки"], client: false },
    { id: "dlp", icon: "shield-check", name: "DLP-подсказки", desc: "Предупреждает об отправке чувствительных данных.", on: true, perms: ["Сообщения", "Файлы"], client: false },
    { id: "stickers", icon: "sticker", name: "Стикеры", desc: "Клиентский набор стикеров, работает и в E2EE.", on: true, perms: [], client: true }
  ];

  const FILES = {
    studio: [
      { name: "atlas-demo-v2.mp4", kind: "video", ext: "MP4", size: "84 МБ", author: "egor", date: "12 ноя", dur: "12:40", sub: "Видео · демо стенда" },
      { name: "tihie-ogni.mp3", kind: "audio", ext: "MP3", size: "8,2 МБ", author: "lena", date: "12 ноя", dur: "3:42", sub: "Аудио · Оля и Оркестр · «Тихие огни»", cover: "assets/album-cover.svg", song: true },
      { name: "interview-team.m4a", kind: "audio", ext: "M4A", size: "12,4 МБ", author: "lena", date: "12 ноя", dur: "18:42", sub: "Аудио · интервью" },
      { name: "call-12-nov.mp3", kind: "audio", ext: "MP3", size: "24 МБ", author: "anna", date: "12 ноя", dur: "42:10", sub: "Аудио · запись созвона" },
      { name: "atlas-final.fig", kind: "doc", ext: "FIG", size: "48,2 МБ", author: "anna", date: "11 ноя", sub: "Документ · макет" },
      { name: "dashboard-grid.png", kind: "image", ext: "PNG", size: "2,1 МБ", author: "me", date: "11 ноя", sub: "Изображение · сетка" },
      { name: "tokens-v3.fig", kind: "doc", ext: "FIG", size: "12,4 МБ", author: "lena", date: "10 ноя", sub: "Документ · токены" },
      { name: "moodboard.jpg", kind: "image", ext: "JPG", size: "4,8 МБ", author: "maria", date: "09 ноя", sub: "Изображение · мудборд" },
      { name: "atlas-api-v2.yaml", kind: "doc", ext: "YAML", size: "86 КБ", author: "me", date: "08 ноя", sub: "Документ · схема API" },
      { name: "release-notes-1.4.md", kind: "doc", ext: "MD", size: "12 КБ", author: "anna", date: "07 ноя", sub: "Документ · заметки" }
    ],
    family: [
      { name: "dacha-subbotnik.mp4", kind: "video", ext: "MP4", size: "36 МБ", author: "papa", date: "10 ноя", dur: "04:12", sub: "Видео · дача" },
      { name: "mama-pirog.m4a", kind: "audio", ext: "M4A", size: "3,2 МБ", author: "mama", date: "09 ноя", dur: "02:18", sub: "Аудио · голосовое" },
      { name: "family-2026.jpg", kind: "image", ext: "JPG", size: "6,4 МБ", author: "anya", date: "06 ноя", sub: "Изображение · семья" },
      { name: "dacha-plan.pdf", kind: "doc", ext: "PDF", size: "1,8 МБ", author: "papa", date: "04 ноя", sub: "Документ · план участка" },
      { name: "recept-piroga.md", kind: "doc", ext: "MD", size: "6 КБ", author: "mama", date: "02 ноя", sub: "Документ · рецепт" }
    ]
  };

  const OVERVIEW = {
    studio: {
      messages: "1 248",
      delta: "+18%",
      files: "128",
      members: "23",
      storage: 18.4,
      quota: 50,
      plan: "Команда",
      online: ["anna", "me", "igor", "egor"],
      activity: [
        { a: "anna", text: "загрузила <b>atlas-final.fig</b> в «Проект «Атлас»»", time: "09:41" },
        { a: "egor", text: "опубликовал видео <b>Демо-стенд «Атлас 2.0»</b>", time: "10:02" },
        { a: "lena", text: "добавила <b>tokens-v3.fig</b> в «Дизайн-систему»", time: "11:07" },
        { a: "pavel", text: "подключил <b>мост в Telegram</b>", time: "14:20" },
        { a: "anna", text: "изменила роль <b>Тимура Ахметова</b> на «Гость»", time: "16:04" }
      ]
    },
    family: {
      messages: "342",
      delta: "+6%",
      files: "18",
      members: "5",
      storage: 2.1,
      quota: 10,
      plan: "Семья",
      online: ["mama", "me", "anya"],
      activity: [
        { a: "anya", text: "отправила стикер в <b>«Семью»</b>", time: "18:46" },
        { a: "papa", text: "загрузил <b>dacha-subbotnik.mp4</b>", time: "17:20" },
        { a: "mama", text: "записала голосовое <b>02:18</b>", time: "15:12" },
        { a: "anya", text: "создала чат <b>«Дача»</b>", time: "12:30" }
      ]
    }
  };

  const SPACES = {
    studio: {
      id: "studio",
      name: "Студия «Восход»",
      short: "В",
      cls: "sp-studio",
      mode: "Управляемый",
      e2ee: false
    },
    family: {
      id: "family",
      name: "Семья",
      short: "С",
      cls: "sp-family",
      mode: "Сквозное шифрование",
      e2ee: true
    }
  };

  const PLUGINS = [
    { icon: "poll", name: "Опросы", desc: "Голосования в чате", on: true },
    { icon: "task", name: "Задачи", desc: "Чек-листы и напоминания", on: true },
    { icon: "translate", name: "Перевод", desc: "Перевод сообщений", on: false },
    { icon: "plug", name: "Мост в Telegram", desc: "Только управляемый контур", on: false }
  ];

  const CHATS = {
    atlas: {
      id: "atlas",
      space: "studio",
      section: "channels",
      name: "Проект «Атлас»",
      short: "Атлас",
      compose: "Написать в «Атлас»…",
      emoji: "🧭",
      kind: "channel",
      avCls: "av-atlas",
      initials: "А",
      cover: "assets/cover-atlas.svg",
      managed: true,
      unread: 0,
      members: [
        { id: "anna", role: "owner" },
        { id: "me", role: "admin" },
        { id: "igor", role: "mod" },
        { id: "lena", role: "member" },
        { id: "egor", role: "member" },
        { id: "pavel", role: "member" },
        { id: "timur", role: "guest" }
      ],
      media: MEDIA,
      plugins: PLUGINS,
      typing: "Анна печатает…",
      reply: "Принято, посмотрю 👀",
      messages: [
        { t: "date", label: "Сегодня" },
        {
          from: "anna",
          time: "09:41",
          text: "Доброе утро! Собрала финальную версию макета — можно смотреть.",
          file: { name: "atlas-final.fig", meta: "48,2 МБ · Figma", kind: "fig" },
          reactions: [
            { e: "🎉", n: 4 },
            { e: "🔥", n: 2 }
          ]
        },
        {
          from: "igor",
          time: "09:44",
          reply: { from: "anna", text: "Собрала финальную версию макета — можно смотреть." },
          text: "На мобильном нижняя панель не конфликтует с композером?"
        },
        {
          from: "me",
          time: "09:46",
          text: "Проверил на 390 px — всё ок. Отступы уменьшил на 4 px, композер больше не перекрывает ленту."
        },
        {
          from: "egor",
          time: "10:02",
          text: "Записал демо нового стенда, 12 минут. Про плагины — с 03:20.",
          video: {
            img: "assets/link-demo.svg",
            title: "Демо-стенд «Атлас 2.0» — запись",
            desc: "Плагины, роли и лимиты файлов",
            dur: "12:40",
            author: "egor",
            source: "Сова · Видео"
          }
        },
        {
          from: "anna",
          time: "10:15",
          text: "Давайте зафиксируем время созвона.",
          poll: {
            q: "Когда созвон?",
            options: [
              { t: "Сегодня, 18:00", n: 5, mine: true },
              { t: "Завтра, 11:00", n: 2 }
            ]
          },
          thread: {
            replies: [
              { from: "igor", time: "10:17", text: "Могу только после 19:00 — до 18:00 не успею." },
              { from: "lena", time: "10:18", text: "Тогда давайте завтра в 11:00, всем удобно?" },
              { from: "me", time: "10:19", text: "Да, завтра в 11:00. Ставлю встречу." }
            ]
          }
        },
        {
          from: "anna",
          time: "10:26",
          voice: {
            dur: "0:24",
            wave: [32, 54, 40, 72, 48, 30, 64, 84, 46, 60, 36, 68, 88, 52, 42, 66, 38, 58, 78, 44]
          }
        },
      ]
    },

    design: {
      id: "design",
      space: "studio",
      section: "channels",
      name: "Дизайн-система",
      short: "Дизайн",
      compose: "Написать в «Дизайн-систему»…",
      emoji: "🎨",
      kind: "channel",
      avCls: "p10",
      initials: "Д",
      cover: "assets/cover-atlas.svg",
      managed: true,
      unread: 4,
      members: [
        { id: "lena", role: "owner" },
        { id: "anna", role: "member" },
        { id: "me", role: "member" },
        { id: "egor", role: "guest" }
      ],
      media: MEDIA,
      plugins: PLUGINS.slice(0, 3),
      typing: "Лена печатает…",
      reply: "Ок, гляну после обеда.",
      messages: [
        { t: "date", label: "Сегодня" },
        { from: "lena", time: "11:02", text: "Обновила токены: радиусы 8 / 10 / 14, тени мягче, зелёный акцент стал спокойнее." },
        {
          from: "me",
          time: "11:05",
          text: "Супер. Проверю на тёмной теме — там активный пункт был слишком близок к фону.",
          reactions: [{ e: "👀", n: 2 }]
        },
        {
          from: "lena",
          time: "11:07",
          text: "Держи исходник. Внутри — таблица токенов и компоненты в двух темах.",
          file: { name: "tokens-v3.fig", meta: "12,4 МБ · Figma", kind: "fig" }
        }
      ]
    },

    general: {
      id: "general",
      space: "studio",
      section: "channels",
      name: "Общий чат",
      short: "Общий",
      compose: "Написать в «Общий чат»…",
      emoji: "💬",
      kind: "channel",
      avCls: "p4",
      initials: "О",
      cover: "assets/cover-atlas.svg",
      managed: true,
      unread: 96,
      members: [
        { id: "anna", role: "owner" },
        { id: "me", role: "admin" },
        { id: "igor", role: "member" },
        { id: "lena", role: "member" },
        { id: "egor", role: "member" },
        { id: "pavel", role: "member" },
        { id: "timur", role: "guest" }
      ],
      media: MEDIA,
      plugins: PLUGINS,
      typing: "Егор печатает…",
      reply: "Спасибо, посмотрю.",
      messages: [
        { t: "date", label: "Сегодня" },
        { from: "anna", time: "08:30", text: "Всем привет! Дайджест недели — в закрепе. Коротко: релиз 1.4, плагины и лимиты файлов.", reactions: [{ e: "👍", n: 5 }] },
        { from: "egor", time: "08:35", text: "Спасибо, почитал. По интеграциям всё зелёное." },
        {
          from: "me",
          time: "08:40",
          text: "Закинул заметки по релизу в файлы, ссылка в описании канала.",
          file: { name: "release-notes-1.4.md", meta: "12 КБ · Markdown", kind: "yaml" }
        }
      ]
    },

    integrations: {
      id: "integrations",
      space: "studio",
      section: "channels",
      name: "Интеграции",
      short: "Интеграции",
      compose: "Написать в «Интеграции»…",
      emoji: "🔌",
      kind: "channel",
      avCls: "p6",
      initials: "И",
      cover: "assets/cover-atlas.svg",
      managed: true,
      unread: 2,
      members: [
        { id: "pavel", role: "owner" },
        { id: "me", role: "admin" },
        { id: "egor", role: "member" }
      ],
      media: MEDIA.slice(1),
      plugins: PLUGINS.slice(2),
      typing: "Павел печатает…",
      reply: "Понял, проверю.",
      messages: [
        { t: "date", label: "Сегодня" },
        { from: "pavel", time: "14:20", text: "Мост в Telegram подключён, тестовый канал работает. В E2EE-контуре его не включаем." },
        { from: "me", time: "14:26", text: "Отлично. Добавь в описание канала ограничения по лимитам." },
        { from: "pavel", time: "14:28", text: "Само собой. Сделаю до вечера.", reactions: [{ e: "✅", n: 1 }] }
      ]
    },

    media: {
      id: "media",
      space: "studio",
      section: "channels",
      name: "Медиа и голосовые",
      short: "Медиа",
      compose: "Написать в «Медиа»…",
      emoji: "🎙️",
      kind: "channel",
      avCls: "p8",
      initials: "М",
      cover: "assets/cover-atlas.svg",
      managed: true,
      unread: 0,
      members: [
        { id: "anna", role: "owner" },
        { id: "me", role: "admin" },
        { id: "egor", role: "member" },
        { id: "lena", role: "member" }
      ],
      media: MEDIA,
      plugins: PLUGINS.slice(0, 3),
      typing: "Лена печатает…",
      reply: "Ок, послушаю вечером.",
      messages: [
        { t: "date", label: "Сегодня" },
        {
          from: "anna",
          time: "11:02",
          voice: {
            dur: "0:38",
            wave: [34, 58, 42, 74, 52, 30, 66, 88, 46, 62, 36, 70, 92, 54, 44, 68, 38, 60, 82, 48, 64, 40, 56, 72],
            text: "Привет! Записала голосом, чтобы не набирать. Посмотри правки по макету: композер и панель чата.",
            expanded: true
          },
          thread: {
            replies: [
              { from: "lena", time: "11:04", text: "Послушала, композер в тёмной теме действительно лучше. Спасибо!" },
              { from: "anna", time: "11:05", text: "Тогда переношу правки в макет и пришлю финал." }
            ]
          }
        },
        {
          from: "egor",
          time: "11:05",
          text: "Скинул аудио с интервью — про плагины с 12:30.",
          audio: {
            name: "interview-team.m4a",
            meta: "M4A · 12,4 МБ · 18:42",
            dur: "18:42",
            wave: [22, 40, 58, 30, 46, 64, 34, 52, 26, 44, 60, 32, 48, 24, 38, 54]
          }
        },
        {
          from: "lena",
          time: "11:07",
          text: "И видео с демо-стенда, версия 2. Там уже новые лимиты файлов.",
          videoFile: {
            name: "atlas-demo-v2.mp4",
            meta: "MP4 · 84 МБ · 12:40",
            img: "assets/link-demo.svg",
            dur: "12:40"
          }
        },
        {
          from: "lena",
          time: "11:09",
          text: "И трек, который обсуждали. Обложка и теги подтянулись сами.",
          song: {
            title: "Тихие огни",
            artist: "Оля и Оркестр",
            album: "Тихие огни",
            year: "2026",
            genre: "Indie",
            dur: "3:42",
            cover: "assets/album-cover.svg",
            source: "ID3"
          },
          thread: {
            replies: [
              { from: "egor", time: "11:10", text: "Обложка очень в тему. Добавил в плейлист команды." }
            ]
          }
        },
        {
          from: "me",
          time: "11:10",
          voice: { dur: "0:12", wave: [28, 44, 60, 36, 52, 68, 42, 58, 34, 48, 64, 40] }
        },
        {
          from: "lena",
          time: "11:12",
          text: "Продублировала всё в «Файлы» — там есть фильтры по аудио и видео.",
          reactions: [{ e: "🎧", n: 2 }]
        }
      ]
    },

    maria: {
      id: "maria",
      space: "studio",
      section: "dms",
      name: "Мария Соколова",
      short: "Марии",
      kind: "dm",
      person: "maria",
      cover: "assets/cover-dm.svg",
      unread: 2,
      secure: true,
      fingerprint: "4C11 9A07 E3B2 6D58",
      media: MEDIA,
      typing: "Мария печатает…",
      reply: "Согласна, так лучше.",
      messages: [
        { t: "date", label: "Сегодня" },
        { from: "maria", time: "09:12", text: "Привет! Посмотрела новую сетку — стало воздушнее." },
        { from: "me", time: "09:14", text: "Спасибо. Хочу ещё развести типографику: 14/20 в списках, 15/22 в сообщениях." },
        { from: "maria", time: "09:16", text: "Согласна. Только не потеряй плотность в правой панели — там и так много строк." },
        {
          from: "me",
          time: "09:17",
          text: "Вот текущая сетка, посмотри отступы.",
          file: { name: "dashboard-grid.png", meta: "2,1 МБ · PNG", kind: "png" }
        },
        { from: "maria", time: "09:20", text: "И ещё: в тёмной теме активный пункт слишком близок к фону. Давай +6% светлоты." },
        { from: "me", time: "09:21", text: "Поймал. Поправлю в токенах.", reactions: [{ e: "✅", n: 1 }] },
        { from: "maria", time: "09:22", text: "И ещё: бейджи непрочитанных серые. Может, сделать их зелёными?" },
        { from: "me", time: "09:24", text: "Серые лучше — не конкурируют с акцентом. Зелёный оставим для активного состояния." },
        { from: "maria", time: "09:25", text: "Принято. Тогда фиксирую макет.", reactions: [{ e: "🙌", n: 2, mine: true }] },
        { from: "me", time: "09:26", text: "Спасибо! Скину финальные токены, когда соберу." },
        { from: "maria", time: "09:27", text: "Жду 🙂" }
      ]
    },

    egor: {
      id: "egor",
      space: "studio",
      section: "dms",
      name: "Егор Титов",
      short: "Егору",
      kind: "dm",
      person: "egor",
      cover: "assets/cover-dm.svg",
      unread: 0,
      secure: false,
      media: MEDIA.slice(2),
      typing: "Егор печатает…",
      reply: "Ок, на связи.",
      messages: [
        { t: "date", label: "Сегодня" },
        { from: "egor", time: "12:02", text: "Скинул доступ к стенду, проверь почту." },
        { from: "me", time: "12:05", text: "Уже смотрю, спасибо." },
        { from: "egor", time: "12:06", text: "Если что — я на созвоне до 13:00." }
      ]
    },

    anna: {
      id: "anna",
      space: "studio",
      section: "dms",
      name: "Анна Ким",
      short: "Анне",
      kind: "dm",
      person: "anna",
      cover: "assets/cover-dm.svg",
      unread: 0,
      secure: false,
      media: MEDIA.slice(1, 3),
      typing: "Анна печатает…",
      reply: "Хорошо, договорились.",
      messages: [
        { t: "date", label: "Сегодня" },
        { from: "anna", time: "10:40", text: "Привет! Добавила тебя в канал «Атлас» админом." },
        { from: "me", time: "10:42", text: "Спасибо, вижу. Настрою роли." },
        { from: "anna", time: "10:43", text: "Только не раздавай модератора без меня 🙂" }
      ]
    },

    igor: {
      id: "igor",
      space: "studio",
      section: "dms",
      name: "Игорь Власов",
      short: "Игорю",
      kind: "dm",
      person: "igor",
      cover: "assets/cover-dm.svg",
      unread: 0,
      secure: false,
      media: MEDIA.slice(0, 3),
      typing: "Игорь печатает…",
      reply: "Понял, спасибо.",
      messages: [
        { t: "date", label: "Сегодня" },
        { from: "igor", time: "09:50", text: "Макет в фигме обновил, посмотри слой с композером." },
        { from: "me", time: "09:52", text: "Ок, гляну после созвона." }
      ]
    },

    lena: {
      id: "lena",
      space: "studio",
      section: "dms",
      name: "Лена Орлова",
      short: "Лене",
      kind: "dm",
      person: "lena",
      cover: "assets/cover-dm.svg",
      unread: 0,
      secure: false,
      media: MEDIA.slice(3),
      typing: "Лена печатает…",
      reply: "Спасибо!",
      messages: [
        { t: "date", label: "Сегодня" },
        { from: "lena", time: "08:15", text: "Доброе утро! Тёмную тему докрутила." },
        { from: "me", time: "08:20", text: "Вижу, контраст стал лучше." }
      ]
    },

    family: {
      id: "family",
      space: "family",
      section: "channels",
      name: "Семья",
      short: "Семья",
      compose: "Написать в «Семью»…",
      emoji: "🏡",
      kind: "channel",
      avCls: "av-family",
      initials: "С",
      cover: "assets/cover-family.svg",
      managed: false,
      e2ee: true,
      fingerprint: "8F2A 91C4 77D0 5B3E",
      unread: 0,
      members: [
        { id: "mama", role: "owner" },
        { id: "me", role: "admin" },
        { id: "anya", role: "member" },
        { id: "papa", role: "member" },
        { id: "olya", role: "guest" }
      ],
      media: MEDIA,
      plugins: [{ icon: "sticker", name: "Стикеры", desc: "Клиентский плагин", on: true }],
      typing: "Мама печатает…",
      reply: "Хорошо, родной.",
      messages: [
        { t: "date", label: "Вчера" },
        { from: "papa", time: "18:10", text: "В субботу обещают дождь. Всё ещё едем?" },
        { from: "olya", time: "18:12", text: "Я простудилась, останусь дома." },
        { from: "mama", time: "18:14", text: "Выздоравливай, Оля. Передадим гостинцы." },
        { from: "papa", time: "18:20", text: "Кто тогда едет на дачу?" },
        { from: "anya", time: "18:22", text: "Мы с Димой 🚗", reactions: [{ e: "❤️", n: 2 }] },
        { from: "mama", time: "18:25", text: "Купите хлеб и молоко, пожалуйста." },
        { from: "me", time: "18:27", text: "Хорошо, возьму." },
        { from: "anya", time: "18:40", text: "Мама, мы в субботу приедем к обеду 🥒" },
        { from: "mama", time: "18:42", text: "Отлично, напеку пирог." },
        { from: "me", time: "18:45", text: "Возьму с собой банку маринованных." },
        { from: "anya", time: "18:46", sticker: "assets/sticker-wave.svg" },
        { from: "mama", time: "18:50", text: "Не забудьте про дачу — там уже холодно.", reactions: [{ e: "❤️", n: 3 }] }
      ]
    },

    dacha: {
      id: "dacha",
      space: "family",
      section: "channels",
      name: "Дача",
      short: "Дача",
      compose: "Написать в «Дачу»…",
      emoji: "🌿",
      kind: "channel",
      avCls: "p6",
      initials: "Д",
      cover: "assets/cover-family.svg",
      managed: false,
      e2ee: true,
      fingerprint: "7B3C 2201 AF91 8E4D",
      unread: 2,
      members: [
        { id: "mama", role: "owner" },
        { id: "me", role: "member" },
        { id: "anya", role: "member" },
        { id: "papa", role: "member" }
      ],
      media: MEDIA.slice(1),
      plugins: [{ icon: "sticker", name: "Стикеры", desc: "Клиентский плагин", on: true }],
      typing: "Аня печатает…",
      reply: "Ок!",
      messages: [
        { t: "date", label: "Вчера" },
        { from: "mama", time: "12:10", text: "На даче отключили воду до пятницы." },
        { from: "me", time: "12:14", text: "Понял. Привезу канистры в субботу." },
        { from: "anya", time: "12:16", text: "И возьми секатор 🌿", reactions: [{ e: "🌿", n: 2 }] }
      ]
    },

    mama: {
      id: "mama",
      space: "family",
      section: "dms",
      name: "Мама",
      short: "Маме",
      kind: "dm",
      person: "mama",
      cover: "assets/cover-dm.svg",
      unread: 1,
      secure: true,
      fingerprint: "2D8F 44A1 90C7 13B5",
      media: MEDIA.slice(0, 2),
      typing: "Мама печатает…",
      reply: "Хорошо, сынок.",
      messages: [
        { t: "date", label: "Вчера" },
        { from: "mama", time: "19:02", text: "Не забудь про пирог, я напекла." },
        { from: "me", time: "19:05", text: "Уже еду 🙂" }
      ]
    },

    anya: {
      id: "anya",
      space: "family",
      section: "dms",
      name: "Аня",
      short: "Ане",
      kind: "dm",
      person: "anya",
      cover: "assets/cover-dm.svg",
      unread: 0,
      secure: true,
      fingerprint: "9A02 7C31 55DE 4B10",
      media: MEDIA.slice(2, 4),
      typing: "Аня печатает…",
      reply: "Ага 😄",
      messages: [
        { t: "date", label: "Вчера" },
        { from: "anya", time: "17:30", text: "Скинь стикер с огурцом, тот самый" },
        { from: "me", time: "17:31", sticker: "assets/sticker-wave.svg" },
        { from: "anya", time: "17:32", text: "Обожаю 😻", reactions: [{ e: "😻", n: 1 }] }
      ]
    }
  };

  const state = {
    space: "studio",
    chat: "atlas",
    theme: "light",
    details: true,
    search: "",
    secure: { maria: true },
    mobileSidebar: false,
    view: "chat",
    pageFilter: "all",
    fileQuery: "",
    settingsTab: "profile",
    modalTab: "main",
    thread: null,
    recording: false,
    recStart: 0,
    recTimer: null
  };

  /* ─────────── утилиты ─────────── */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const plural = (n, forms) => {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  };

  const icon = (name, cls = "i") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;

  const personOf = (id) => PEOPLE[id] || PEOPLE.me;

  const chatOf = (id) => CHATS[id] || CHATS.atlas;

  const currentChat = () => chatOf(state.chat);

  const spaceChats = (space) =>
    Object.values(CHATS).filter((c) => c.space === space);

  const isE2EE = (chat) => {
    if (chat.kind === "dm") {
      return state.secure[chat.id] !== undefined ? !!state.secure[chat.id] : !!chat.secure;
    }
    return !!chat.e2ee;
  };

  const unreadOf = (space) =>
    spaceChats(space).reduce((sum, c) => sum + (c.unread || 0), 0);

  const onlineCount = (chat) =>
    (chat.members || []).filter((m) => personOf(m.id).online).length;

  const subtitleOf = (chat) => {
    if (chat.kind === "dm") {
      const p = personOf(chat.person);
      return p.online ? "В сети" : "Не в сети";
    }
    const total = chat.members.length;
    const online = onlineCount(chat);
    return `${total} ${plural(total, ["участник", "участника", "участников"])} · ${online} в сети`;
  };

  const avatarHTML = (person, cls = "av-28", withPresence = true) =>
    `<span class="av ${cls} ${person.pal}">${person.short}${
      withPresence && person.online ? '<span class="presence is-online"></span>' : ""
    }</span>`;

  const chatAvatar = (chat, cls = "av-38") => {
    if (chat.kind === "dm") return avatarHTML(personOf(chat.person), cls);
    return `<span class="av ${cls} ${chat.avCls}">${chat.initials}</span>`;
  };

  const fingerprintOf = (chat) =>
    chat.fingerprint || "5A31 08C2 B7E4 9D66";

  const nowTime = () =>
    new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

  /* ─────────── рендер: рейл ─────────── */

  function renderRail() {
    $("#rail-spaces").innerHTML = Object.values(SPACES)
      .map((s) => {
        const unread = unreadOf(s.id);
        const badge = unread ? `<span class="sp-badge" aria-hidden="true">${unread > 99 ? "99+" : unread}</span>` : "";
        return `<button class="rail-space ${s.cls} ${state.space === s.id ? "is-active" : ""}"
          data-space="${s.id}" aria-label="${esc(s.name)}${unread ? `, ${unread} непрочитанных` : ""}" title="${esc(s.name)}${unread ? ` · ${unread} непрочитанных` : ""}">${s.short}${badge}</button>`;
      })
      .join("");
  }

  /* ─────────── рендер: сайдбар ─────────── */

  function renderSidebar() {
    const space = SPACES[state.space];
    $("#ws-name").textContent = space.name;

    const filesCount = (FILES[state.space] || []).length;
    const pluginsOn = PLUGIN_CATALOG.filter((p) => p.on && (!SPACES[state.space].e2ee || p.client)).length;
    $("#nav").innerHTML = NAV[state.space]
      .map((n) => {
        const badge = n.view === "files" ? String(filesCount) : n.view === "plugins" ? String(pluginsOn) : "";
        return `<button class="nav-item${state.view === n.view ? " is-on" : ""}" data-nav-view="${n.view}">
          ${icon(n.icon)}
          <span>${n.label}</span>
          ${badge ? `<span class="nav-badge">${badge}</span>` : ""}
        </button>`;
      })
      .join("");

    const chats = spaceChats(state.space);
    const channels = chats.filter((c) => c.section === "channels");
    const dms = chats.filter((c) => c.section === "dms");

    const sections = [
      {
        id: "channels",
        label: state.space === "family" ? "Чаты" : "Каналы",
        chats: channels
      },
      { id: "dms", label: "Личные сообщения", chats: dms }
    ];

    $("#side-scroll").innerHTML = sections
      .map(
        (sec) => `<section class="section" data-section="${sec.id}">
          <div class="section-head">
            <button class="section-toggle" data-collapse="${sec.id}">
              ${icon("chevron-down", "i chev")}
              <span>${sec.label}</span>
            </button>
            <button class="section-add" data-add="${sec.id}" aria-label="Добавить">${icon("plus")}</button>
          </div>
          <div class="rows">
            ${sec.chats.map((c) => chatRow(c)).join("")}
          </div>
        </section>`
      )
      .join("");
  }

  function chatRow(chat) {
    const active = state.view === "chat" && chat.id === state.chat;
    const av =
      chat.kind === "dm"
        ? avatarHTML(personOf(chat.person), "av-28")
        : `<span class="channel-ic">${chat.emoji || "💬"}</span>`;
    const badge = chat.unread ? `<span class="badge">${chat.unread > 99 ? "99+" : chat.unread}</span>` : "";
    return `<button class="row${active ? " is-active" : ""}" data-chat="${chat.id}">
      ${av}
      <span class="row-name">${esc(chat.name)}</span>
      ${badge}
    </button>`;
  }

  /* ─────────── рендер: шапка чата ─────────── */

  function renderHeader() {
    const chat = currentChat();
    const sub = subtitleOf(chat);
    const isDM = chat.kind === "dm";
    const p = isDM ? personOf(chat.person) : null;
    const dotCls = isDM && !p.online ? " is-off" : "";

    $("#chat-id").innerHTML = `
      ${chatAvatar(chat, "av-38")}
      <span class="chat-meta">
        <span class="chat-title">${esc(chat.name)}</span>
        <span class="chat-sub"><i class="sub-dot${dotCls}"></i>${esc(sub)}</span>
      </span>`;
  }

  /* ─────────── рендер: сообщения ─────────── */

  function renderMessages() {
    const chat = currentChat();
    const box = $("#messages");
    box.innerHTML = chat.messages.map((m, i) => messageHTML(m, i)).join("");
    box.scrollTop = box.scrollHeight;
    applySearch();
  }

  function messageHTML(m, i) {
    if (m.t === "date") return `<div class="date"><span>${esc(m.label)}</span></div>`;
    if (m.t === "system") {
      return `<div class="system">${icon(m.icon || "sparkles")}<span>${esc(m.text)}</span></div>`;
    }

    const p = personOf(m.from);
    const own = m.from === "me";
    const parts = [];

    if (m.reply) {
      parts.push(`<div class="reply"><b>${esc(personOf(m.reply.from).name)}</b><span>${esc(m.reply.text)}</span></div>`);
    }
    if (m.text) parts.push(`<p class="msg-text">${esc(m.text)}</p>`);
    if (m.file) parts.push(fileHTML(m.file));
    if (m.voice) parts.push(voiceHTML(m.voice, own));
    if (m.audio) parts.push(audioHTML(m.audio));
    if (m.videoFile) parts.push(videoFileHTML(m.videoFile));
    if (m.song) parts.push(songHTML(m.song));
    if (m.video) parts.push(videoHTML(m.video));
    if (m.poll) parts.push(pollHTML(m.poll));
    if (m.sticker) {
      parts.push(
        m.sticker.startsWith("assets/")
          ? `<div class="sticker-msg"><img src="${m.sticker}" alt="Стикер" loading="lazy"></div>`
          : `<div class="sticker-msg" style="font-size:52px;line-height:1.1">${m.sticker}</div>`
      );
    }
    if (m.reactions && m.reactions.length) {
      parts.push(
        `<div class="reactions">${m.reactions
          .map(
            (r, ri) =>
              `<button class="reaction${r.mine ? " is-mine" : ""}" data-react="${i}:${ri}">${r.e} <b>${r.n}</b></button>`
          )
          .join("")}</div>`
      );
    }
    if (m.thread && m.thread.replies.length) {
      const n = m.thread.replies.length;
      const last = m.thread.replies[n - 1];
      parts.push(`<button class="thread-link" data-thread="${i}">${icon("thread")}<b>${n}</b> ${plural(n, ["ответ", "ответа", "ответов"])}<span class="last">· ${esc(personOf(last.from).name.split(" ")[0])}: ${esc(last.text)}</span></button>`);
    }

    return `<div class="msg" data-msg="${i}">
      ${avatarHTML(p, "av-38", false)}
      <div class="msg-body">
        <div class="msg-head">
          <span class="msg-author">${esc(p.name)}</span>
          ${own ? '<span class="msg-you">вы</span>' : ""}
          <span class="msg-time">${esc(m.time)}</span>
          ${!m.thread ? `<button class="msg-thread" data-thread="${i}" aria-label="Создать тред" title="Обсудить в треде">${icon("thread")}</button>` : ""}
        </div>
        ${parts.join("")}
      </div>
      <div class="msg-tools">
        <button data-thread="${i}" aria-label="Открыть тред" title="Тред">${icon("thread")}</button>
        <button data-toast="Ответ на сообщение — в полной версии" aria-label="Ответить">${icon("reply")}</button>
        <button data-toast="Реакции — выберите эмодзи" aria-label="Реакция">${icon("smile")}</button>
        <button data-toast="Действия с сообщением" aria-label="Ещё">${icon("more")}</button>
      </div>
    </div>`;
  }

  function fileHTML(f) {
    const label = (f.kind || "file").toUpperCase();
    return `<div class="file-card">
      <span class="file-tile" data-kind="${esc(f.kind || "file")}">${esc(label)}</span>
      <span class="file-body"><b>${esc(f.name)}</b><small>${esc(f.meta)}</small></span>
      <button class="file-dl" data-toast="Файл сохранён в «Файлы»" aria-label="Скачать">${icon("download")}</button>
    </div>`;
  }

  function videoHTML(v) {
    return `<div class="video-card">
      <div class="video-thumb">
        <img src="${v.img}" alt="" loading="lazy">
        <span class="video-dur">${esc(v.dur)}</span>
        <button class="video-play" data-toast="Воспроизведение — в полной версии" aria-label="Смотреть">${icon("play")}</button>
      </div>
      <div class="video-body">
        <div class="video-title">${esc(v.title)}</div>
        <div class="video-desc">${esc(v.desc)}</div>
        <div class="video-meta">
          ${avatarHTML(personOf(v.author), "av", false)}
          <span>${esc(personOf(v.author).name)}</span>
          <span class="video-source">${icon("play", "i yt")}${esc(v.source)}</span>
        </div>
      </div>
    </div>`;
  }

  function waveBars(wave) {
    return (wave || []).map((h) => `<i style="height:${Math.max(6, Math.min(96, h))}%"></i>`).join("");
  }

  function voiceHTML(v, own) {
    const transcript = v.text
      ? `<button class="voice-more" data-transcript aria-expanded="${v.expanded ? "true" : "false"}">${icon("sparkles")}${
          v.expanded ? "Скрыть расшифровку" : "Расшифровка"
        }</button>
        <p class="voice-transcript"${v.expanded ? "" : " hidden"}>${esc(v.text)}</p>`
      : "";
    return `<div class="voice${own ? " is-own" : ""}">
      <button class="voice-play" data-toast="Воспроизведение голосового — в полной версии" aria-label="Воспроизвести голосовое">${icon("play")}</button>
      <span class="voice-wave">${waveBars(v.wave)}</span>
      <span class="voice-dur">${esc(v.dur)}</span>
      <button class="voice-rate" data-toast="Скорость 1× — демо">1×</button>
    </div>${transcript}`;
  }

  function songHTML(s) {
    const meta = s.source === "ID3" ? "ID3 · метаданные прочитаны" : "Файл · теги не найдены";
    return `<figure class="song-card">
      <span class="song-cover">
        <img src="${esc(s.cover)}" alt="Обложка: ${esc(s.album || s.title)}">
        <button class="song-play" data-toast="Плеер — в полной версии" aria-label="Воспроизвести трек">${icon("play")}</button>
      </span>
      <span class="song-body">
        <b>${esc(s.title)}</b>
        <span class="song-artist">${esc(s.artist)}</span>
        <span class="song-album">${esc(s.album)}${s.year ? ` · ${esc(s.year)}` : ""}${s.genre ? ` · ${esc(s.genre)}` : ""}</span>
        <span class="song-meta">${icon("music")}<span class="song-tag">${s.source === "ID3" ? "ID3" : "FILE"}</span>${meta}</span>
      </span>
      <span class="song-side">
        <span class="song-dur">${esc(s.dur || "")}</span>
        <button class="file-dl" data-toast="Трек сохранён в «Файлы»" aria-label="Скачать">${icon("download")}</button>
      </span>
    </figure>`;
  }

  function audioHTML(a) {
    return `<div class="media-file audio-file">
      <button class="media-file-play" data-toast="Аудиоплеер — в полной версии" aria-label="Воспроизвести аудио">${icon("play")}</button>
      <span class="media-file-body">
        <b>${esc(a.name)}</b>
        <small>${esc(a.meta)}</small>
        <span class="mini-wave">${waveBars(a.wave)}</span>
      </span>
      <span class="file-kind">${esc((a.name.split(".").pop() || "audio").toUpperCase())}</span>
      <button class="file-dl" data-toast="Аудиофайл сохранён в «Файлы»" aria-label="Скачать">${icon("download")}</button>
    </div>`;
  }

  function videoFileHTML(v) {
    return `<div class="media-file video-file">
      <span class="vf-thumb">
        <img src="${v.img}" alt="" loading="lazy">
        <span class="vf-dur">${esc(v.dur)}</span>
        <button class="vf-play" data-toast="Видеоплеер — в полной версии" aria-label="Смотреть видео">${icon("play")}</button>
      </span>
      <span class="media-file-body">
        <b>${esc(v.name)}</b>
        <small>${esc(v.meta)}</small>
      </span>
      <span class="file-kind">MP4</span>
      <button class="file-dl" data-toast="Видеофайл сохранён в «Файлы»" aria-label="Скачать">${icon("download")}</button>
    </div>`;
  }

  function pollHTML(poll) {
    const total = poll.options.reduce((s, o) => s + o.n, 0);
    return `<div class="poll-card">
      <div class="poll-head">${icon("poll")}<span>${esc(poll.q)}</span><span class="poll-tag">опрос</span></div>
      ${poll.options
        .map((o) => {
          const pct = Math.round((o.n / total) * 100);
          return `<div class="poll-opt${o.mine ? " is-mine" : ""}">
            <div class="poll-opt-head"><span>${esc(o.t)}</span><span>${pct}% · ${o.n}</span></div>
            <div class="poll-bar"><i style="width:${pct}%"></i></div>
          </div>`;
        })
        .join("")}
      <div class="poll-foot"><span>${total} голосов</span><span>плагин «Опросы»</span></div>
    </div>`;
  }

  /* ─────────── композер ─────────── */

  function renderComposer() {
    const chat = currentChat();
    const e2ee = isE2EE(chat);
    const input = $("#input");
    input.placeholder = chat.kind === "dm" ? `Написать ${chat.short}…` : (chat.compose || "Написать сообщение…");

    const note = $("#composer-note");
    note.classList.toggle("is-e2ee", e2ee);
    note.innerHTML = e2ee
      ? `${icon("lock")}<span>Сквозное шифрование · ключи только у участников</span>`
      : `${icon("shield-check")}<span>Управляемый контур · DLP и аудит включены</span>`;

    $("#typing-name").textContent = chat.typing || "Кто-то печатает…";
    $("#typing").hidden = true;
  }

  /* ─────────── правая панель ─────────── */

  function renderDetails() {
    const chat = currentChat();
    const dm = chat.kind === "dm";
    const person = dm ? personOf(chat.person) : null;
    const e2ee = isE2EE(chat);
    const space = SPACES[chat.space];

    const name = dm ? person.name : chat.name;
    const sub = dm
      ? `${person.online ? "В сети" : "Не в сети"} · ${person.title || "контакт"}`
      : subtitleOf(chat);

    const chips = dm
      ? `<span class="chip">Личный чат</span>
         <span class="chip${e2ee ? " chip--accent" : ""}">${icon(e2ee ? "lock" : "globe")}${
          e2ee ? "Секретный" : "Серверное шифрование"
        }</span>`
      : `<span class="chip${e2ee ? " chip--accent" : ""}">${icon(e2ee ? "lock" : "shield-check")}${
          e2ee ? "Сквозное шифрование" : "Управляемый"
        }</span>
         <span class="chip">${chat.space === "studio" ? "Канал" : "Чат"}</span>`;

    const html = `
      <div class="profile-cover"><img src="${chat.cover}" alt=""></div>
      <div class="profile-main">
        ${
          dm
            ? `<span class="av av-76 profile-av ${person.pal}">${person.short}</span>`
            : `<span class="av av-76 profile-av ${chat.avCls}">${chat.initials}</span>`
        }
        <h2 class="profile-name">${esc(name)}</h2>
        <p class="profile-sub">${esc(sub)}</p>
        <div class="chips">${chips}</div>
      </div>

      <label class="panel-search">
        ${icon("search")}
        <input id="panel-search" type="search" placeholder="Поиск в переписке" autocomplete="off" value="${esc(state.search)}">
      </label>

      <div class="panel-rows">
        ${
          dm
            ? dmRows(chat, person, e2ee)
            : channelRows(chat, e2ee, space)
        }
      </div>

      <div class="panel-foot">
        <button class="danger-row" data-toast="${dm ? "Контакт заблокирован (демо)" : "Вы покинули канал (демо)"}">
          ${icon(dm ? "flag" : "logout")} ${dm ? "Заблокировать" : "Покинуть канал"}
        </button>
      </div>`;

    $("#details-inner").innerHTML = html;
  }

  function channelRows(chat, e2ee, space) {
    const members = chat.members;
    const online = onlineCount(chat);
    const plugins = chat.plugins || [];

    return `
      <button class="panel-row" data-chat-settings="1">
        ${icon("settings")}<span>Настроить чат</span>
        ${icon("chevron-right", "i chev")}
      </button>

      <button class="panel-row${e2ee ? " is-open" : ""}" data-expand="keys">
        ${icon("lock")}<span>Приватность и ключи</span>
        ${icon("chevron-down", "i chev")}
      </button>
      <div class="panel-expand" id="exp-keys"${e2ee ? "" : " hidden"}>
        ${
          e2ee
            ? secureCard(chat)
            : `${icon("shield-check")} <b style="font-weight:600">Управляемый контур</b>
               <p>Сервер расшифровывает сообщения для DLP и аудита. Ключи хранятся на сервере, E2EE отключён политикой пространства.</p>
               ${switchLine("Логирование действий", true)}
               ${switchLine("Экспорт переписки", false)}`
        }
      </div>

      <button class="panel-row" data-switch="notifications" aria-pressed="true">
        ${icon("bell")}<span>Уведомления</span>
        <span class="switch is-on" aria-hidden="true"></span>
      </button>

      ${
        !e2ee
          ? `<button class="panel-row" data-expand="audit">
              ${icon("shield-check")}<span>Аудит и DLP</span>
              ${icon("chevron-down", "i chev")}
            </button>
            <div class="panel-expand" id="exp-audit" hidden>
              <p>DLP-политики: 4 · события за неделю: 1 248 · инцидентов: 0.</p>
              <button class="btn-sm" data-toast="Журнал аудита — в полной версии">Открыть журнал</button>
            </div>`
          : ""
      }

      <button class="panel-row" data-expand="members">
        ${icon("users")}<span>Участники</span>
        <span class="count">${members.length}</span>
        ${icon("chevron-down", "i chev")}
      </button>
      <div class="panel-expand" id="exp-members" hidden>
        ${members.map(memberHTML).join("")}
        <button class="btn-sm mt-6" data-invite="1">${icon("user-plus")} Пригласить по ссылке</button>
      </div>

      <button class="panel-row" data-expand="plugins">
        ${icon("plug")}<span>Плагины</span>
        <span class="count">${plugins.length}</span>
        ${icon("chevron-down", "i chev")}
      </button>
      <div class="panel-expand" id="exp-plugins" hidden>
        ${plugins.map(pluginLine).join("")}
        ${
          e2ee
            ? `<p class="hint">Серверные плагины недоступны в E2EE. Работают только клиентские.</p>`
            : `<p class="hint">Плагины получают доступ к сообщениям в рамках разрешений.</p>`
        }
        <button class="btn-sm" data-toast="Каталог плагинов — в полной версии">Все плагины</button>
      </div>

      <button class="panel-row${e2ee ? "" : " is-open"}" data-expand="media">
        ${icon("image")}<span>Вложения</span>
        <span class="count">${e2ee ? 18 : 24}</span>
        ${icon("chevron-down", "i chev")}
      </button>
      <div class="panel-expand" id="exp-media"${e2ee ? " hidden" : ""}>
        ${mediaGrid(chat)}
      </div>`;
  }

  function dmRows(chat, person, e2ee) {
    return `
      <button class="panel-row" data-chat-settings="1">
        ${icon("settings")}<span>Настроить чат</span>
        ${icon("chevron-right", "i chev")}
      </button>

      <button class="panel-row" data-expand="keys">
        ${icon("lock")}<span>Приватность и ключи</span>
        ${icon("chevron-down", "i chev")}
      </button>
      <div class="panel-expand" id="exp-keys" hidden>
        ${e2ee ? secureCard(chat) : `${icon("globe")} <b style="font-weight:600">Серверное шифрование</b>
          <p>Сообщения доступны серверу для поиска и DLP. Включите секретный чат, чтобы перейти на E2EE.</p>
          <button class="btn-sm btn-sm--accent" data-act="secure">${icon("lock")} Включить E2EE</button>`}
      </div>

      <button class="panel-row" data-switch="notifications" aria-pressed="true">
        ${icon("bell")}<span>Уведомления</span>
        <span class="switch is-on" aria-hidden="true"></span>
      </button>

      <button class="panel-row" data-act="secure">
        ${icon("key")}<span>Секретный чат</span>
        <span class="state">${e2ee ? "Вкл" : "Выкл"}</span>
      </button>

      <button class="panel-row is-open" data-expand="media">
        ${icon("image")}<span>Общие файлы</span>
        <span class="count">${(chat.media || []).length * 2}</span>
        ${icon("chevron-down", "i chev")}
      </button>
      <div class="panel-expand" id="exp-media">
        ${mediaGrid(chat)}
      </div>

      <button class="panel-row" data-toast="Звонок — в полной версии">
        ${icon("phone")}<span>Позвонить</span>
      </button>`;
  }

  function memberHTML(m) {
    const p = personOf(m.id);
    const role = m.role || "member";
    return `<div class="member">
      ${avatarHTML(p, "av-26")}
      <span class="member-name">${esc(p.name)}${m.id === "me" ? ' <span class="member-me">(вы)</span>' : ""}</span>
      <span class="role role--${role}">${ROLE_LABEL[role]}</span>
    </div>`;
  }

  function pluginLine(pl) {
    return `<div class="switch-line">
      <span class="plug-ic">${icon(pl.icon)}</span>
      <span class="plug-body"><b>${esc(pl.name)}</b><small>${esc(pl.desc)}</small></span>
      <button class="switch${pl.on ? " is-on" : ""}" data-switch-plugin="${esc(pl.name)}" role="switch" aria-checked="${pl.on}"></button>
    </div>`;
  }

  function switchLine(label, on) {
    return `<div class="switch-line">
      <span class="plug-body"><b>${esc(label)}</b></span>
      <button class="switch${on ? " is-on" : ""}" data-switch-inline role="switch" aria-checked="${on}"></button>
    </div>`;
  }

  function secureCard(chat) {
    return `<div class="secure">
      <div class="secure-head">${icon("shield-check")} Сквозное шифрование</div>
      <div class="fingerprint">${fingerprintOf(chat)}</div>
      <div class="secure-actions">
        <button class="btn-sm btn-sm--accent" data-toast="Ключи совпадают у 4 из 5 устройств">Проверить ключи</button>
        <button class="btn-sm" data-toast="QR-код для сверки ключей">QR</button>
      </div>
    </div>
    <p class="hint">Сервер не хранит ключи и не может прочитать переписку.</p>`;
  }

  function mediaGrid(chat) {
    const media = chat.media && chat.media.length ? chat.media : MEDIA;
    return `<div class="media-grid">
      ${media
        .map(
          (src, i) => `<button class="media-tile" data-toast="Просмотр вложения">
            <img src="${src}" alt="Вложение ${i + 1}" loading="lazy">
            ${i === media.length - 1 ? '<span class="more">+20</span>' : ""}
          </button>`
        )
        .join("")}
    </div>`;
  }

  /* ─────────── поиск ─────────── */

  function applySearch() {
    const q = state.search.trim().toLowerCase();
    const box = $("#messages");
    const msgs = $$(".msg", box);
    let found = 0;

    msgs.forEach((m) => {
      const hit = !q || m.textContent.toLowerCase().includes(q);
      m.hidden = !hit;
      if (hit) found += 1;
    });

    $$(".date, .system", box).forEach((d) => (d.hidden = !!q));

    const old = $(".empty-search", box);
    if (old) old.remove();
    if (q && found === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-search";
      empty.innerHTML = `<b>Ничего не найдено</b>Попробуйте другой запрос`;
      box.appendChild(empty);
    }

    $("#search-count").textContent = q ? String(found) : "";
    const panel = $("#panel-search");
    if (panel && panel.value !== state.search) panel.value = state.search;
    const header = $("#search-input");
    if (header && header.value !== state.search) header.value = state.search;
  }

  function setSearch(q) {
    state.search = q;
    applySearch();
  }

  function openSearch() {
    const bar = $("#chat-search");
    bar.hidden = false;
    $("#search-input").value = state.search;
    $("#search-input").focus();
    applySearch();
  }

  function closeSearch() {
    $("#chat-search").hidden = true;
    state.search = "";
    applySearch();
  }

  /* ─────────── уведомления ─────────── */

  let toastTimer = null;
  function toast(text) {
    const t = $("#toast");
    t.innerHTML = `${icon("check")}<span>${esc(text)}</span>`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2400);
  }

  /* ─────────── действия ─────────── */

  function selectChat(id) {
    const chat = CHATS[id];
    if (!chat) return;
    if (chat.space !== state.space) {
      state.space = chat.space;
      state.pageFilter = "all";
      state.fileQuery = "";
    }
    state.chat = id;
    chat.unread = 0;
    state.search = "";
    state.view = "chat";
    state.thread = null;
    cancelRecording();
    closeModal();
    closeSearch();
    closePops();
    $("#typing").hidden = true;

    if (state.details && window.innerWidth < 1180) {
      state.details = false;
      $("#app").classList.remove("details-open");
    }
    if (window.innerWidth <= 760) {
      state.mobileSidebar = false;
      $("#app").classList.remove("sidebar-open");
    }
    renderAll();
    hideScrim();
  }

  function selectSpace(id) {
    if (!SPACES[id] || state.space === id) return;
    state.space = id;
    state.search = "";
    state.view = "chat";
    state.thread = null;
    state.pageFilter = "all";
    state.fileQuery = "";
    cancelRecording();
    closeModal();
    const first = spaceChats(id)[0];
    state.chat = first ? first.id : "atlas";
    const chat = CHATS[state.chat];
    if (chat) chat.unread = 0;
    closeWsMenu();
    closeSearch();
    closePops();
    renderAll();
    hideScrim();
  }

  function renderAll() {
    renderRail();
    renderSidebar();
    renderHeader();
    renderMessages();
    renderComposer();
    renderDetails();
    renderPage();
    const app = $("#app");
    app.classList.toggle("page-open", state.view !== "chat");
    app.classList.toggle("details-open", state.view === "chat" && state.details);
    app.classList.toggle("thread-open", !!state.thread && state.view === "chat");
    $("#page").hidden = state.view === "chat";
    renderThread();
  }

  function openWsMenu() {
    closePops();
    const menu = $("#ws-menu");
    menu.hidden = !menu.hidden;
    $("#ws-btn").setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) {
      $("#ws-menu-list").innerHTML = Object.values(SPACES)
        .map(
          (s) => `<button class="ws-menu-item ${s.id === state.space ? "is-active" : ""}" data-space="${s.id}">
            <span class="av ${s.id === "studio" ? "sp-studio" : "sp-family"}" style="display:grid;place-items:center;color:#fff">${s.short}</span>
            <span>${esc(s.name)}</span>
            <span class="role">${s.e2ee ? "E2EE" : "Управляемый"}</span>
          </button>`
        )
        .join("");
    }
  }
  function closeWsMenu() {
    $("#ws-menu").hidden = true;
    $("#ws-btn").setAttribute("aria-expanded", "false");
  }

  function closePops() {
    ["#attach-pop", "#sticker-pop", "#emoji-pop"].forEach((s) => ($(s).hidden = true));
  }

  function showScrim(show) {
    $("#scrim").hidden = !show;
  }
  function hideScrim() {
    showScrim(false);
  }

  function toggleTheme() {
    applyTheme(state.theme === "dark" ? "light" : "dark");
    if (state.view === "settings") $("#page-body").innerHTML = settingsPage();
  }

  function sendMessage() {
    const input = $("#input");
    const text = input.value.trim();
    if (!text) return;
    const chat = currentChat();
    chat.messages.push({ from: "me", time: nowTime(), text });
    input.value = "";
    input.style.height = "auto";
    $("#typing").hidden = true;
    renderMessages();
    applySearch();

    const typing = $("#typing");
    typing.hidden = false;
    const box = $("#messages");
    box.scrollTop = box.scrollHeight;

    setTimeout(() => {
      typing.hidden = true;
      if (chat.id !== state.chat) return;
      chat.messages.push({ from: chat.kind === "dm" ? chat.person : chat.members[0].id, time: nowTime(), text: chat.reply || "Хорошо." });
      renderMessages();
    }, 1900);
  }

  function addMessage(entry) {
    const chat = currentChat();
    chat.messages.push(entry);
    renderMessages();
    const box = $("#messages");
    box.scrollTop = box.scrollHeight;
  }

  function toggleSecure() {
    const chat = currentChat();
    if (chat.kind !== "dm") return;
    state.secure[chat.id] = !isE2EE(chat);
    renderDetails();
    renderComposer();
    toast(isE2EE(chat) ? "Секретный чат включён · E2EE" : "Секретный чат выключен");
  }

  /* ─────────── события ─────────── */

  document.addEventListener("click", (e) => {
    const target = e.target;

    /* модальные окна и страницы */
    if (target.closest("[data-close-modal]")) return closeModal();
    if (target.closest("#thread-close")) return closeThread();
    const threadBtn = target.closest("[data-thread]");
    if (threadBtn) return openThread(Number(threadBtn.dataset.thread));
    if (target.closest("[data-save-chat]")) {
      closeModal();
      return toast("Настройки чата сохранены");
    }
    if (target.id === "modal-layer") return closeModal();
    if (target.closest("[data-profile]")) return openProfile();
    if (target.closest("[data-chat-settings]")) return openChatSettings();
    if (target.closest("#page-back")) return setView("chat");

    const modalTab = target.closest("[data-modal-tab]");
    if (modalTab) {
      state.modalTab = modalTab.dataset.modalTab;
      return renderChatSettings();
    }

    const navView = target.closest("[data-nav-view]");
    if (navView) return setView(navView.dataset.navView);
    const pageBtn = target.closest("[data-page]");
    if (pageBtn) return setView(pageBtn.dataset.page);

    const fileTab = target.closest("[data-file-tab]");
    if (fileTab) {
      state.pageFilter = fileTab.dataset.fileTab;
      state.fileQuery = "";
      return renderPage();
    }

    const settingsTab = target.closest("[data-settings-tab]");
    if (settingsTab) {
      state.settingsTab = settingsTab.dataset.settingsTab;
      return renderPage();
    }

    const themeBtn = target.closest("[data-set-theme]");
    if (themeBtn) {
      applyTheme(themeBtn.dataset.setTheme);
      return renderPage();
    }

    const pluginBtn = target.closest("[data-plugin-id]");
    if (pluginBtn) {
      if (pluginBtn.disabled) return;
      const plugin = PLUGIN_CATALOG.find((p) => p.id === pluginBtn.dataset.pluginId);
      if (plugin) {
        plugin.on = !plugin.on;
        renderPage();
        toast(`${plugin.name}: ${plugin.on ? "включён" : "выключен"}`);
      }
      return;
    }

    const transcript = target.closest("[data-transcript]");
    if (transcript) {
      const note = transcript.nextElementSibling;
      if (note) {
        note.hidden = !note.hidden;
        transcript.setAttribute("aria-expanded", String(!note.hidden));
        transcript.innerHTML = `${icon("sparkles")}${note.hidden ? "Расшифровка" : "Скрыть расшифровку"}`;
      }
      return;
    }

    const spaceBtn = target.closest("[data-space]");
    if (spaceBtn) {
      if (target.closest("#ws-menu-list")) closeWsMenu();
      selectSpace(spaceBtn.dataset.space);
      return;
    }

    const chatBtn = target.closest("[data-chat]");
    if (chatBtn) {
      selectChat(chatBtn.dataset.chat);
      return;
    }

    const collapse = target.closest("[data-collapse]");
    if (collapse) {
      const sec = collapse.closest(".section");
      sec.classList.toggle("is-collapsed");
      return;
    }

    if (target.closest("#ws-btn")) {
      openWsMenu();
      return;
    }
    if (!target.closest("#ws-menu") && !$("#ws-menu").hidden) closeWsMenu();

    if (target.closest("#new-chat")) return toast("Создание чата — в полной версии");
    if (target.closest("[data-add]")) return toast("Добавление раздела — в полной версии");
    if (target.closest("[data-nav]")) return toast(`${target.closest("[data-nav]").dataset.nav} — в полной версии`);
    if (target.closest("#ws-create")) return toast("Создание пространства — в полной версии");
    if (target.closest("#logout")) return toast("Выход из аккаунта — демо");
    if (target.closest("#me-btn")) return openProfile();
    if (target.closest("#rail-add")) return toast("Создание пространства — в полной версии");
    if (target.closest("#theme-toggle")) return toggleTheme();
    if (target.closest("#call-btn") || target.closest("#video-btn")) return toast("Звонки появятся в v1.5");
    if (target.closest("#mobile-back")) {
      state.mobileSidebar = true;
      $("#app").classList.add("sidebar-open");
      showScrim(true);
      return;
    }
    if (target.closest("#scrim")) {
      if (state.thread) {
        closeThread();
        return;
      }
      state.mobileSidebar = false;
      $("#app").classList.remove("sidebar-open");
      if (state.details && window.innerWidth < 1180) {
        state.details = false;
        $("#app").classList.remove("details-open");
      }
      hideScrim();
      return;
    }

    const toastTarget = target.closest("[data-toast]");
    if (toastTarget) {
      toast(toastTarget.dataset.toast);
      return;
    }

    const react = target.closest("[data-react]");
    if (react) {
      const [mi, ri] = react.dataset.react.split(":").map(Number);
      const r = currentChat().messages[mi].reactions[ri];
      r.mine = !r.mine;
      r.n += r.mine ? 1 : -1;
      renderMessages();
      return;
    }

    const invite = target.closest("[data-invite]");
    if (invite) {
      toast("Ссылка-приглашение скопирована");
      return;
    }

    if (target.closest("#search-toggle")) return openSearch();
    if (target.closest("#search-close")) return closeSearch();

    if (target.closest("#details-toggle") || target.closest("#chat-id")) {
      if (state.thread) {
        closeThread();
        return;
      }
      state.details = !state.details;
      $("#app").classList.toggle("details-open", state.details);
      if (state.details) showScrim(window.innerWidth < 1180);
      else hideScrim();
      return;
    }
    if (target.closest("#details-close")) {
      state.details = false;
      $("#app").classList.remove("details-open");
      hideScrim();
      return;
    }

    if (target.closest("#attach")) {
      closeWsMenu();
      const pop = $("#attach-pop");
      const willOpen = pop.hidden;
      closePops();
      pop.hidden = !willOpen;
      return;
    }
    if (target.closest("#sticker-btn")) {
      closeWsMenu();
      const pop = $("#sticker-pop");
      const willOpen = pop.hidden;
      closePops();
      pop.hidden = !willOpen;
      return;
    }
    if (target.closest("#emoji-btn")) {
      closeWsMenu();
      const pop = $("#emoji-pop");
      const willOpen = pop.hidden;
      closePops();
      pop.hidden = !willOpen;
      return;
    }

    const attach = target.closest("[data-attach]");
    if (attach) {
      const kind = attach.dataset.attach;
      closePops();
      if (kind === "audio") {
        const input = $("#audio-input");
        input.value = "";
        input.click();
        return;
      }
      if (kind === "file") {
        addMessage({
          from: "me",
          time: nowTime(),
          text: "Приложил заметки по каналу.",
          file: { name: "atlas-notes.pdf", meta: "240 КБ · PDF", kind: "file" }
        });
      } else if (kind === "image") {
        addMessage({
          from: "me",
          time: nowTime(),
          file: { name: "screen-1440.png", meta: "1,8 МБ · PNG", kind: "png" }
        });
      } else if (kind === "poll") {
        addMessage({
          from: "me",
          time: nowTime(),
          poll: {
            q: "Когда удобно созвониться?",
            options: [
              { t: "Сегодня, 18:00", n: 1, mine: true },
              { t: "Завтра, 11:00", n: 0 }
            ]
          }
        });
      } else {
        addMessage({ t: "system", icon: "task", text: "Задача создана: «Проверить композер на 390 px»" });
        toast("Задача создана плагином «Задачи»");
      }
      return;
    }

    const sticker = target.closest("[data-sticker]");
    if (sticker) {
      closePops();
      addMessage({ from: "me", time: nowTime(), sticker: sticker.dataset.sticker });
      return;
    }

    const emoji = target.closest("[data-emoji]");
    if (emoji) {
      const input = $("#input");
      input.value += emoji.dataset.emoji;
      input.focus();
      return;
    }

    if (!target.closest(".pop") && !target.closest("#attach") && !target.closest("#sticker-btn") && !target.closest("#emoji-btn")) {
      closePops();
    }
  });

  /* панель «О чате» */
  document.addEventListener("click", (e) => {
    const panel = e.target.closest("#details-inner");
    if (!panel) return;

    const expander = e.target.closest("[data-expand]");
    if (expander) {
      const box = $("#exp-" + expander.dataset.expand);
      if (box) {
        box.hidden = !box.hidden;
        expander.classList.toggle("is-open", !box.hidden);
      }
      return;
    }

    const sw = e.target.closest("[data-switch], [data-switch-plugin], [data-switch-inline]");
    if (sw) {
      const visual = sw.classList.contains("switch") ? sw : sw.querySelector(".switch");
      if (!visual) return;
      const on = !visual.classList.contains("is-on");
      visual.classList.toggle("is-on", on);
      if (sw.getAttribute("role") === "switch") sw.setAttribute("aria-checked", String(on));
      if (sw.hasAttribute("aria-pressed")) sw.setAttribute("aria-pressed", String(on));
      toast(on ? "Включено" : "Выключено");
      return;
    }

    if (e.target.closest("[data-act='secure']")) {
      toggleSecure();
      return;
    }
  });

  document.addEventListener("input", (e) => {
    if (e.target.id === "search-input" || e.target.id === "panel-search") {
      setSearch(e.target.value);
    }
    if (e.target.id === "files-search") {
      state.fileQuery = e.target.value;
      filterFileRows();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#modal-layer").hidden) closeModal();
      else if (state.thread) closeThread();
      else if (state.recording) cancelRecording();
      else if (!$("#chat-search").hidden) closeSearch();
      else {
        closePops();
        closeWsMenu();
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (state.view !== "chat") setView("chat");
      openSearch();
    }
  });

  /* composer */
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage();
  });

  $("#input").addEventListener("input", (e) => {
    const t = e.target;
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 116) + "px";
  });

  $("#input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  $("#mic-btn").addEventListener("click", () => startRecording(0));
  $("#rec-cancel").addEventListener("click", () => cancelRecording());
  $("#rec-send").addEventListener("click", () => stopRecording(true));

  $("#thread-composer").addEventListener("submit", (e) => {
    e.preventDefault();
    sendThreadReply();
  });
  $("#thread-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendThreadReply();
    }
  });
  $("#thread-input").addEventListener("input", (e) => {
    const t = e.target;
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 120) + "px";
  });

  $("#audio-input").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    await addSongFile(file);
  });

  /* галерея стикеров и эмодзи */
  const STICKERS = ["assets/sticker-wave.svg", "😻", "😄", "🎉", "💚", "🔥", "👍", "🥒"];
  const EMOJIS = ["😀", "😄", "😊", "😍", "😻", "🤔", "🙃", "😴", "😎", "🥳", "😢", "😡", "👍", "👎", "👏", "🙏", "💚", "🔥", "🎉", "✅", "👀", "🚀", "🥒", "❤️"];

  $("#sticker-grid").innerHTML = STICKERS.map(
    (s) =>
      `<button type="button" data-sticker="${s}" aria-label="Стикер">${
        s.startsWith("assets/") ? `<img src="${s}" alt="">` : s
      }</button>`
  ).join("");

  $("#emoji-grid").innerHTML = EMOJIS.map(
    (e) => `<button type="button" data-emoji="${e}" aria-label="${e}">${e}</button>`
  ).join("");

  /* ─────────── треды ─────────── */

  function currentThreadMessage() {
    if (!state.thread) return null;
    const chat = CHATS[state.thread.chatId];
    if (!chat) return null;
    return chat.messages[state.thread.index] || null;
  }

  function openThread(index) {
    const chat = currentChat();
    const m = chat.messages[index];
    if (!m || m.t) return;
    state.thread = { chatId: state.chat, index };
    closePops();
    closeSearch();
    cancelRecording();
    renderAll();
    $("#thread").hidden = false;
    if (window.innerWidth < 1180) showScrim(true);
    const body = $("#thread-body");
    body.scrollTop = body.scrollHeight;
    setTimeout(() => $("#thread-input").focus(), 60);
  }

  function closeThread() {
    if (!state.thread) return;
    state.thread = null;
    renderAll();
    if (!(state.details && window.innerWidth < 1180) && !state.mobileSidebar) hideScrim();
  }

  function attachmentSummary(m) {
    if (m.file) return `<span class="thread-attachment">${icon("file")}${esc(m.file.name)}</span>`;
    if (m.song) return `<span class="thread-attachment">${icon("music")}${esc(m.song.title)} — ${esc(m.song.artist)}</span>`;
    if (m.voice) return `<span class="thread-attachment">${icon("mic")}Голосовое · ${esc(m.voice.dur)}</span>`;
    if (m.audio) return `<span class="thread-attachment">${icon("music")}${esc(m.audio.name)}</span>`;
    if (m.videoFile) return `<span class="thread-attachment">${icon("film")}${esc(m.videoFile.name)}</span>`;
    if (m.video) return `<span class="thread-attachment">${icon("play")}${esc(m.video.title)}</span>`;
    if (m.poll) return `<span class="thread-attachment">${icon("poll")}Опрос · ${esc(m.poll.q)}</span>`;
    if (m.sticker) return `<span class="thread-attachment">${icon("sticker")}Стикер</span>`;
    return "";
  }

  function renderThread() {
    const panel = $("#thread");
    if (!state.thread || state.view !== "chat") {
      panel.hidden = true;
      return;
    }
    const chat = CHATS[state.thread.chatId];
    const m = currentThreadMessage();
    if (!chat || !m || m.t) {
      state.thread = null;
      panel.hidden = true;
      $("#app").classList.remove("thread-open");
      return;
    }
    panel.hidden = false;
    $("#thread-title").textContent = chat.name;
    const replies = (m.thread && m.thread.replies) || [];
    const author = personOf(m.from);
    const n = replies.length;

    $("#thread-body").innerHTML = `
      <div class="thread-parent">
        ${avatarHTML(author, "av-28", false)}
        <div class="thread-parent-body">
          <div class="thread-parent-head"><b>${esc(author.name)}</b><span>${esc(m.time || "")}</span></div>
          ${m.text ? `<p class="thread-parent-text">${esc(m.text)}</p>` : ""}
          ${attachmentSummary(m)}
        </div>
      </div>
      <div class="thread-divider">${n ? `${n} ${plural(n, ["ответ", "ответа", "ответов"])}` : "Начните обсуждение"}</div>
      ${n ? replies.map((r) => {
        const p = personOf(r.from);
        return `<div class="thread-reply">
          ${avatarHTML(p, "av-28", false)}
          <div class="thread-reply-body">
            <div class="thread-reply-head"><b>${esc(p.name)}</b><span>${esc(r.time)}</span></div>
            <p class="thread-reply-text">${esc(r.text)}</p>
            <div class="thread-reply-actions"><button data-toast="Реакция в треде — в полной версии">Ответить</button></div>
          </div>
        </div>`;
      }).join("") : `<div class="thread-empty"><b>Пока нет ответов</b>Ответьте первым — обсуждение появится здесь.</div>`}
    `;
    const body = $("#thread-body");
    body.scrollTop = body.scrollHeight;
  }

  function sendThreadReply() {
    const chat = currentChat();
    if (!state.thread || state.thread.chatId !== chat.id) return;
    const m = currentThreadMessage();
    if (!m) return;
    const input = $("#thread-input");
    const text = input.value.trim();
    if (!text) return;
    if (!m.thread) m.thread = { replies: [] };
    m.thread.replies.push({ from: "me", time: nowTime(), text });
    input.value = "";
    input.style.height = "auto";
    renderMessages();
    renderThread();
    const idx = state.thread.index;
    const responder = m.from !== "me" ? m.from : (chat.members && chat.members[0] ? chat.members[0].id : "anna");
    setTimeout(() => {
      if (!state.thread || state.thread.chatId !== chat.id || state.thread.index !== idx) return;
      m.thread.replies.push({ from: responder, time: nowTime(), text: "Спасибо, зафиксировал." });
      renderMessages();
      renderThread();
    }, 1700);
  }

  /* ─────────── страницы пространства ─────────── */

  let lastPageKey = "";

  function pageKey() {
    return `${state.space}:${state.view}`;
  }

  function setView(view) {
    if (view !== "chat" && !PAGE_META[view]) return;
    state.view = view;
    state.fileQuery = "";
    state.thread = null;
    closeSearch();
    closePops();
    closeWsMenu();
    cancelRecording();
    closeModal();
    renderAll();
    if (view !== "chat" && window.innerWidth <= 760) {
      state.mobileSidebar = false;
      $("#app").classList.remove("sidebar-open");
    }
    if (!state.mobileSidebar && !(state.details && window.innerWidth < 1180)) hideScrim();
  }

  function renderPage() {
    const page = $("#page");
    if (state.view === "chat") {
      page.hidden = true;
      return;
    }
    page.hidden = false;
    const space = SPACES[state.space];
    $("#page-title").textContent = PAGE_META[state.view];
    $("#page-eyebrow").textContent = `${space.name} · ${space.mode}`;
    $("#page-actions").innerHTML = pageActions();
    $("#page-body").innerHTML = pageBody();

    if (lastPageKey !== pageKey()) {
      lastPageKey = pageKey();
      $("#page-body").scrollTop = 0;
    }
    if (state.view === "files") filterFileRows();
  }

  function pageActions() {
    if (state.view === "overview") {
      return `<button class="btn" data-page="files">${icon("folder")}<span>Файлы</span></button>
        <button class="btn btn--accent" data-toast="Приглашение в пространство — демо">${icon("user-plus")}<span>Пригласить</span></button>`;
    }
    if (state.view === "files") {
      return `<button class="btn btn--accent" data-toast="Загрузка файла — в полной версии">${icon("plus")}<span>Загрузить</span></button>`;
    }
    if (state.view === "plugins") {
      return `<button class="btn" data-toast="Каталог плагинов — в полной версии">${icon("plus")}<span>Каталог</span></button>`;
    }
    if (state.view === "security") {
      return `<button class="btn" data-toast="Экспорт журнала аудита">${icon("download")}<span>Экспорт</span></button>`;
    }
    if (state.view === "settings") return "";
    return "";
  }

  function pageBody() {
    switch (state.view) {
      case "overview": return overviewPage();
      case "files": return filesPage();
      case "plugins": return pluginsPage();
      case "security": return securityPage();
      case "settings": return settingsPage();
      default: return "";
    }
  }

  function todayLabel() {
    const raw = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  function overviewPage() {
    const o = OVERVIEW[state.space];
    const space = SPACES[state.space];
    const pct = Math.min(100, Math.round((o.storage / o.quota) * 100));
    const unreadChats = spaceChats(state.space).filter((c) => c.unread > 0).slice(0, 4);
    const quick = unreadChats.length ? unreadChats : spaceChats(state.space).slice(0, 4);
    const online = o.online.map((id) => avatarHTML(personOf(id), "av-26", false)).join("");
    const safeTitle = space.e2ee ? "Ключи и устройства" : "Контроль и аудит";
    const safeText = space.e2ee
      ? "Сквозное шифрование включено. Ключи проверены на 4 из 5 устройств."
      : "DLP включён · 0 инцидентов за неделю · 4 политики.";
    const safeChip = space.e2ee ? "E2EE" : "DLP";

    return `
      <div class="ov-hero">
        <div>
          <p class="page-eyebrow">${todayLabel()}</p>
          <h2>Добрый день, Дмитрий</h2>
          <p>${space.name}: ${o.members} ${plural(+o.members, ["участник", "участника", "участников"])}, ${spaceChats(state.space).length} ${plural(spaceChats(state.space).length, ["чат", "чата", "чатов"])} и ${o.files} файлов.</p>
        </div>
        <div class="ov-actions">
          <button class="btn" data-chat="${state.space === "studio" ? "atlas" : "family"}">${icon("hash")}<span>Открыть «${state.space === "studio" ? "Атлас" : "Семью"}»</span></button>
        </div>
      </div>

      <div class="stat-grid">
        <div class="stat">
          <span class="stat-ic">${icon("hash")}</span>
          <div><b>${o.messages}</b><span>сообщений за неделю</span></div>
          <small>${o.delta}</small>
        </div>
        <div class="stat">
          <span class="stat-ic">${icon("folder")}</span>
          <div><b>${o.files}</b><span>файлов в пространстве</span></div>
        </div>
        <div class="stat">
          <span class="stat-ic">${icon("users")}</span>
          <div><b>${o.members}</b><span>участников, ${o.online.length} в сети</span></div>
        </div>
        <div class="stat">
          <span class="stat-ic">${icon("shield-check")}</span>
          <div><b>${space.e2ee ? "4/5" : "0"}</b><span>${space.e2ee ? "ключей проверено" : "DLP-инцидентов"}</span></div>
        </div>
      </div>

      <div class="ov-grid">
        <div class="card">
          <div class="card-head"><span class="card-title">Активность</span><button class="card-link" data-page="security">Все события</button></div>
          <div class="activity">
            ${o.activity.map((a) => `<div class="activity-row">
              ${avatarHTML(personOf(a.a), "av-26", false)}
              <div class="activity-text"><b>${esc(personOf(a.a).name)}</b> ${a.text}</div>
              <span class="activity-time">${a.time}</span>
            </div>`).join("")}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">Быстрый доступ</span><button class="card-link" data-toast="Все чаты — в сайдбаре">Все чаты</button></div>
          ${quick.map((c) => `<button class="quick-row" data-chat="${c.id}">
            ${c.kind === "dm" ? avatarHTML(personOf(c.person), "av-26") : `<span class="channel-ic">${c.emoji || "💬"}</span>`}
            <span class="name">${esc(c.name)}</span>
            ${c.unread ? `<span class="badge">${c.unread}</span>` : ""}
          </button>`).join("")}
        </div>
      </div>

      <div class="ov-grid ov-grid--3">
        <div class="card">
          <div class="card-head"><span class="card-title">Хранилище</span><span class="chip">${esc(o.plan)}</span></div>
          <div class="meter"><i style="width:${pct}%"></i></div>
          <div class="meter-row"><span>${String(o.storage).replace(".", ",")} ГБ из ${o.quota} ГБ</span><span>${pct}%</span></div>
          <div class="limits">
            <span class="limit">200 МБ</span><span class="limit">1 ГБ</span><span class="limit is-current">2 ГБ</span><span class="limit">до 10 ГБ</span>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">${safeTitle}</span><span class="chip${space.e2ee ? " chip--accent" : ""}">${safeChip}</span></div>
          <p class="pane-sub" style="margin-bottom:10px">${safeText}</p>
          <button class="btn btn--sm" data-page="security">${icon("shield")} Открыть защиту</button>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">Команда</span><span class="muted">${o.online.length} в сети</span></div>
          <div class="team-row">${online}<span class="team-count">и ещё ${Math.max(0, +o.members - o.online.length)}</span></div>
          <p class="pane-sub" style="margin:10px 0 10px">Пригласите коллег по ссылке — роль «Участник» по умолчанию.</p>
          <button class="btn btn--sm" data-toast="Ссылка-приглашение скопирована">${icon("link")} Пригласить</button>
        </div>
      </div>

      <div class="card" style="margin-top:12px">
        <div class="card-head"><span class="card-title">Недавние вложения</span><button class="card-link" data-page="files">Все файлы</button></div>
        <div class="recent-media">${recentMedia()}</div>
      </div>`;
  }

  function recentMedia() {
    const files = FILES[state.space] || [];
    const pick = [
      files.find((f) => f.kind === "video"),
      files.find((f) => f.kind === "audio" && f.cover) || files.find((f) => f.kind === "audio"),
      files.find((f) => f.kind === "image"),
      files.find((f) => f.kind === "doc")
    ].filter(Boolean);
    return pick.map((f) => {
      let thumb = "";
      if (f.kind === "video") {
        thumb = `<span class="recent-thumb"><img src="assets/link-demo.svg" alt=""><span class="dur">${esc(f.dur || "")}</span></span>`;
      } else if (f.kind === "audio") {
        thumb = f.cover
          ? `<span class="recent-thumb"><img src="${esc(f.cover)}" alt=""></span>`
          : `<span class="recent-thumb">${icon("music")}</span>`;
      } else if (f.kind === "image") {
        thumb = `<span class="recent-thumb"><img src="${f.name.includes("moodboard") ? "assets/media-color.svg" : "assets/media-grid.svg"}" alt=""></span>`;
      } else {
        thumb = `<span class="recent-thumb">${icon("file")}</span>`;
      }
      return `<button class="recent-item" data-page="files">
        ${thumb}
        <span class="recent-name"><b>${esc(f.name)}</b><small>${esc(f.sub || "")} · ${esc(f.size)}</small></span>
      </button>`;
    }).join("");
  }

  function filesPage() {
    const files = FILES[state.space];
    const filter = state.pageFilter;
    const tabs = [
      ["all", "Все"],
      ["image", "Изображения"],
      ["doc", "Документы"],
      ["audio", "Аудио"],
      ["video", "Видео"]
    ];
    const list = filter === "all" ? files : files.filter((f) => f.kind === filter);
    const o = OVERVIEW[state.space];
    const pct = Math.min(100, Math.round((o.storage / o.quota) * 100));

    return `
      <div class="page-tools">
        <div class="tab-pills">
          ${tabs.map(([id, label]) => `<button class="tab-pill${filter === id ? " is-active" : ""}" data-file-tab="${id}">${label}</button>`).join("")}
        </div>
        <label class="page-search">${icon("search")}<input id="files-search" type="search" placeholder="Поиск по файлам" value="${esc(state.fileQuery)}" autocomplete="off"></label>
        <span class="files-count" id="files-count">${list.length} ${plural(list.length, ["файл", "файла", "файлов"])}</span>
      </div>

      <div class="files-summary card">
        <span class="stat-ic">${icon("folder")}</span>
        <div class="grow">
          <b>${String(o.storage).replace(".", ",")} ГБ из ${o.quota} ГБ</b>
          <small>Хранилище пространства · ${o.files} файлов · тариф «${o.plan}»</small>
          <div class="meter"><i style="width:${pct}%"></i></div>
        </div>
        <div class="limits">
          <span class="limit">200 МБ</span><span class="limit">1 ГБ</span><span class="limit is-current">2 ГБ</span><span class="limit">до 10 ГБ</span>
        </div>
      </div>

      <div class="files-table">
        <div class="file-head"><span></span><span>Название</span><span>Тип</span><span>Размер</span><span>Автор</span><span>Дата</span><span></span></div>
        ${list.map(fileRow).join("") || `<div class="file-empty">В этой категории пока нет файлов</div>`}
      </div>

      <div class="ov-grid" style="margin-top:12px">
        <div class="card limits-card">
          <div class="card-head"><span class="card-title">Лимиты по тарифам</span><span class="chip">демо</span></div>
          <div class="policy-row">${icon("check")}<span class="plan">Бесплатный</span><span>Базовый чат и файлы</span><span class="size">200 МБ</span></div>
          <div class="policy-row">${icon("check")}<span class="plan">Команда</span><span>Роли, плагины, аудит</span><span class="size">2 ГБ</span></div>
          <div class="policy-row">${icon("check")}<span class="plan">Бизнес</span><span>DLP, SSO, экспорт</span><span class="size">10 ГБ</span></div>
          <div class="policy-row">${icon("info")}<span class="plan">Гость</span><span>Только в приглашённых чатах</span><span class="size">50 МБ</span></div>
        </div>
        <div class="card limits-card">
          <div class="card-head"><span class="card-title">Правила загрузки</span><button class="card-link" data-toast="Правила пространства — демо">Изменить</button></div>
          <div class="policy-row">${icon("check")}<span>До 10 файлов в одном сообщении</span><span class="size">10</span></div>
          <div class="policy-row">${icon("check")}<span>Проверка антивирусом ClamAV</span><span class="size">вкл</span></div>
          <div class="policy-row">${icon("check")}<span>Шифрование при передаче</span><span class="size">TLS 1.3</span></div>
          <div class="policy-row">${icon("check")}<span>Хранение медиа</span><span class="size">30 дней</span></div>
        </div>
      </div>`;
  }

  function fileRow(f) {
    const media = f.kind === "audio" || f.kind === "video";
    return `<div class="file-row" data-name="${esc(f.name)}">
      ${f.cover ? `<span class="file-icon file-cover"><img src="${esc(f.cover)}" alt=""></span>` : `<span class="file-icon" data-kind="${f.kind}">${esc(f.ext)}</span>`}
      <span class="file-name"><b>${esc(f.name)}</b><small>${esc(f.sub || "Файл")}${f.dur ? ` · ${f.dur}` : ""}</small></span>
      <span class="file-type">${f.kind === "video" ? "Видео" : f.kind === "audio" ? "Аудио" : f.kind === "image" ? "Фото" : "Документ"}</span>
      <span class="file-size">${esc(f.size)}</span>
      <span class="file-author">${esc(personOf(f.author).name.split(" ")[0])}</span>
      <span class="file-date">${esc(f.date)}</span>
      <span class="file-actions">
        ${media ? `<button class="file-play" data-toast="${f.kind === "audio" ? "Аудиоплеер" : "Видеоплеер"} — в полной версии" aria-label="Воспроизвести">${icon("play")}</button>` : ""}
        <button class="file-dl" data-toast="Скачивание — в полной версии" aria-label="Скачать">${icon("download")}</button>
      </span>
    </div>`;
  }

  function filterFileRows() {
    const q = state.fileQuery.trim().toLowerCase();
    let n = 0;
    $$(".file-row").forEach((row) => {
      const hit = !q || (row.dataset.name || "").toLowerCase().includes(q);
      row.hidden = !hit;
      if (hit) n += 1;
    });
    const count = $("#files-count");
    if (count) count.textContent = `${n} ${plural(n, ["файл", "файла", "файлов"])}`;
  }

  function pluginsPage() {
    const e2ee = SPACES[state.space].e2ee;
    return `
      <div class="plugin-grid">
        ${PLUGIN_CATALOG.map((p) => pluginCard(p, e2ee)).join("")}
      </div>
      <div class="plugin-note">${icon("lock")}
        <span>${e2ee
          ? "В E2EE-пространстве доступны только клиентские плагины. Серверные интеграции отключены, потому что требуют доступа к расшифрованным сообщениям."
          : "Плагины получают доступ к сообщениям только в рамках указанных разрешений. Включение и отключение фиксируется в журнале аудита."}</span>
      </div>`;
  }

  function pluginCard(p, e2ee) {
    const blocked = e2ee && !p.client;
    const on = p.on && !blocked;
    return `<div class="plugin-card card">
      <div class="plugin-head">
        <span class="plugin-ic">${icon(p.icon)}</span>
        <div><h3>${esc(p.name)}</h3><p>${esc(p.desc)}</p></div>
      </div>
      <div class="plugin-foot">
        ${blocked ? `<span class="perm">недоступно в E2EE</span>` : p.perms.map((x) => `<span class="perm">${esc(x)}</span>`).join("")}
        <button class="switch${on ? " is-on" : ""}" data-plugin-id="${p.id}" role="switch" aria-checked="${on}" ${blocked ? "disabled" : ""} aria-label="${esc(p.name)}"></button>
      </div>
    </div>`;
  }

  function securityPage() {
    const space = SPACES[state.space];
    const e2ee = space.e2ee;
    return `
      <div class="mode-card">
        <span class="mode-ic">${icon(e2ee ? "lock" : "shield-check")}</span>
        <div>
          <h3>${e2ee ? "Сквозное шифрование" : "Управляемый контур"}</h3>
          <p>${e2ee
            ? "Сервер не хранит ключи и не может прочитать переписку. Ключи есть только у участников и устройств."
            : "Сервер расшифровывает сообщения для DLP и аудита. Ключи — в KMS, экспорт — по политике пространства."}</p>
        </div>
        <span class="chip${e2ee ? " chip--accent" : ""}">${e2ee ? "E2EE" : "DLP"}</span>
        <button class="btn" data-toast="Смена режима — в полной версии">Изменить</button>
      </div>

      <div class="security-grid">
        <div class="card">
          <div class="card-head"><span class="card-title">${e2ee ? "Ключи и проверка" : "Ключи и устройства"}</span>
            <button class="card-link" data-toast="${e2ee ? "Ключи совпадают у 4 из 5 устройств" : "Ключи обновлены"}">Проверить</button></div>
          ${e2ee
            ? `<div class="fingerprint">8F2A 91C4 77D0 5B3E</div>
               <p class="pane-sub" style="margin:0 0 8px">Отпечаток ключа чата «Семья»</p>
               <button class="btn btn--sm btn--accent" data-toast="QR-код для сверки ключей">Проверить ключи</button>`
            : `<div class="device-row">${icon("monitor")}<span class="name"><b>MacBook Pro</b><small>Это устройство · Москва</small></span><span class="state">сейчас</span></div>
               <div class="device-row">${icon("smartphone")}<span class="name"><b>iPhone 15</b><small>Был 2 часа назад</small></span></div>
               <div class="device-row">${icon("monitor")}<span class="name"><b>Windows · офис</b><small>Был вчера</small></span></div>`}
        </div>

        <div class="card">
          <div class="card-head"><span class="card-title">${e2ee ? "История ключей" : "Политики DLP"}</span>
            <button class="card-link" data-toast="Подробнее — в полной версии">Подробнее</button></div>
          ${e2ee
            ? `<div class="audit-row"><span class="audit-time">18:12</span><span>Ключ устройства <b>iPhone 15</b> подтверждён</span></div>
               <div class="audit-row"><span class="audit-time">17:40</span><span>Новое устройство <b>iPad</b> ожидает проверки</span></div>
               <div class="audit-row"><span class="audit-time">12:05</span><span>Ключи сверены с <b>Аней</b></span></div>`
            : `<div class="policy-row">${icon("shield-check")}<span>Карты и паспортные данные</span><span class="count">блок</span></div>
               <div class="policy-row">${icon("shield-check")}<span>Внешние ссылки</span><span class="count">предупреждение</span></div>
               <div class="policy-row">${icon("shield-check")}<span>Экспорт переписки</span><span class="count">только админ</span></div>
               <div class="policy-row">${icon("shield-check")}<span>Файлы > 200 МБ</span><span class="count">запрет</span></div>`}
        </div>

        <div class="card">
          <div class="card-head"><span class="card-title">Журнал аудита</span><span class="chip">24 часа</span></div>
          ${e2ee
            ? `<div class="audit-row"><span class="audit-time">18:46</span><span>Устройство <b>Ани</b> подтверждено</span></div>
               <div class="audit-row"><span class="audit-time">18:40</span><span>Ключ чата <b>«Семья»</b> обновлён</span></div>
               <div class="audit-row"><span class="audit-time">18:12</span><span>Новое устройство <b>iPad</b> в семье</span></div>
               <div class="audit-row"><span class="audit-time">17:30</span><span>Ключи сверены с <b>Марией</b></span></div>`
            : `<div class="audit-row"><span class="audit-time">16:04</span><span>Роль <b>Тимура</b> изменена на «Гость»</span></div>
               <div class="audit-row"><span class="audit-time">14:20</span><span>Подключён <b>мост в Telegram</b></span></div>
               <div class="audit-row"><span class="audit-time">11:07</span><span>Лена загрузила <b>tokens-v3.fig</b></span></div>
               <div class="audit-row"><span class="audit-time">09:41</span><span>Анна загрузила <b>atlas-final.fig</b></span></div>`}
        </div>

        <div class="card">
          <div class="card-head"><span class="card-title">Сеансы</span><button class="card-link" data-toast="Все сеансы, кроме текущего, завершены">Завершить</button></div>
          <div class="device-row">${icon("monitor")}<span class="name"><b>MacBook Pro</b><small>Chrome · Москва</small></span><span class="state">сейчас</span></div>
          <div class="device-row">${icon("smartphone")}<span class="name"><b>iPhone 15</b><small>Приложение · Москва</small></span></div>
          <div class="device-row">${icon("monitor")}<span class="name"><b>Windows · офис</b><small>Chrome · Санкт-Петербург</small></span></div>
          <button class="btn btn--sm" data-toast="Выйти на всех устройствах, кроме текущего">${icon("logout")} Выйти везде</button>
        </div>
      </div>`;
  }

  function settingsPage() {
    const tabs = [
      ["profile", "Профиль", "users"],
      ["appearance", "Внешний вид", "sun"],
      ["notifications", "Уведомления", "bell"],
      ["workspace", "Пространство", "shield"],
      ["devices", "Устройства", "monitor"]
    ];
    const active = tabs.some(([id]) => id === state.settingsTab) ? state.settingsTab : "profile";
    return `<div class="settings">
      <nav class="settings-nav" aria-label="Разделы настроек">
        ${tabs.map(([id, label, ic]) => `<button class="${active === id ? "is-active" : ""}" data-settings-tab="${id}">${icon(ic)}${label}</button>`).join("")}
      </nav>
      <div class="settings-pane">${settingsPane(active)}</div>
    </div>`;
  }

  function settingsPane(tab) {
    if (tab === "appearance") {
      return `<div class="card">
        <h3>Внешний вид</h3>
        <p class="pane-sub">Тема применяется ко всем пространствам на этом устройстве.</p>
        <div class="setting-row">
          <div class="text"><b>Тема</b><small>Светлая или тёмная палитра</small></div>
          <div class="seg">
            <button class="${state.theme === "light" ? "is-active" : ""}" data-set-theme="light">Светлая</button>
            <button class="${state.theme === "dark" ? "is-active" : ""}" data-set-theme="dark">Тёмная</button>
          </div>
        </div>
        <div class="setting-row">
          <div class="text"><b>Плотность</b><small>Расстояние между сообщениями</small></div>
          <div class="seg"><button class="is-active">Свободно</button><button data-toast="Плотный режим — в полной версии">Плотно</button></div>
        </div>
        <div class="setting-row">
          <div class="text"><b>Превью ссылок</b><small>Показывать карточки для ссылок</small></div>
          <button class="switch is-on" data-switch-inline aria-checked="true"></button>
        </div>
        <div class="setting-row">
          <div class="text"><b>Аватары в ленте</b><small>Скрывать аватары у своих сообщений</small></div>
          <button class="switch" data-switch-inline aria-checked="false"></button>
        </div>
        <div class="setting-row">
          <div class="text"><b>Акцент</b><small>Фирменный бирюзовый Совы</small></div>
          <div class="swatches"><span class="swatch is-active" style="background:#65BD45"></span><span class="swatch" style="background:#D9A441"></span><span class="swatch" style="background:#E85D4A"></span><span class="swatch" style="background:#2F7A38"></span></div>
        </div>
      </div>`;
    }
    if (tab === "notifications") {
      return `<div class="card">
        <h3>Уведомления</h3>
        <p class="pane-sub">Выберите, когда Сова может вас отвлекать.</p>
        ${switchSetting("Все уведомления", "Сообщения, упоминания и звонки", true)}
        ${switchSetting("Только упоминания", "Отключить шум в каналах", false)}
        ${switchSetting("Личные сообщения", "Всегда показывать превью", true)}
        ${switchSetting("Звук", "Короткий сигнал для новых сообщений", false)}
        ${switchSetting("Дайджест на почту", "Раз в день, в 09:00", true)}
      </div>`;
    }
    if (tab === "workspace") {
      const space = SPACES[state.space];
      return `<div class="card">
        <h3>Пространство</h3>
        <p class="pane-sub">Настройки контура и правила для участников.</p>
        <div class="form-row"><label>Название</label><input class="input" value="${esc(space.name)}"></div>
        <div class="form-row"><label>Режим</label>
          <select class="select"><option>${space.e2ee ? "Сквозное шифрование (E2EE)" : "Управляемый контур (DLP)"}</option><option>Сменить режим…</option></select>
        </div>
        <div class="setting-row">
          <div class="text"><b>Приглашения по ссылке</b><small>Роль «Участник» по умолчанию</small></div>
          <button class="switch is-on" data-switch-inline aria-checked="true"></button>
        </div>
        <div class="setting-row">
          <div class="text"><b>История для новых</b><small>Показывать последние 30 дней</small></div>
          <button class="switch is-on" data-switch-inline aria-checked="true"></button>
        </div>
        <div class="setting-row">
          <div class="text"><b>Лимит файла</b><small>Демо-тариф «Команда»</small></div>
          <select class="select"><option>200 МБ</option><option>1 ГБ</option><option>2 ГБ</option><option>до 10 ГБ</option></select>
        </div>
        <div class="form-actions"><button class="btn" data-toast="Изменения отменены">Отмена</button><button class="btn btn--accent" data-toast="Настройки пространства сохранены">Сохранить</button></div>
      </div>`;
    }
    if (tab === "devices") {
      return `<div class="card">
        <h3>Устройства и сеансы</h3>
        <p class="pane-sub">Ключи E2EE привязаны к устройствам. Проверяйте новые сеансы.</p>
        <div class="device-row">${icon("monitor")}<span class="name"><b>MacBook Pro · Chrome</b><small>Москва · это устройство</small></span><span class="state">сейчас</span></div>
        <div class="device-row">${icon("smartphone")}<span class="name"><b>iPhone 15 · приложение</b><small>Москва · 2 часа назад</small></span><button class="btn btn--sm" data-toast="Сеанс завершён">Выйти</button></div>
        <div class="device-row">${icon("monitor")}<span class="name"><b>Windows · Chrome</b><small>Санкт-Петербург · вчера</small></span><button class="btn btn--sm" data-toast="Сеанс завершён">Выйти</button></div>
        <div class="form-actions"><button class="btn" data-toast="Выйти на всех устройствах, кроме текущего">${icon("logout")} Выйти везде</button></div>
      </div>`;
    }
    return `<div class="card">
      <h3>Профиль</h3>
      <p class="pane-sub">Как вас видят участники пространств.</p>
      <div class="chat-settings-head">
        ${avatarHTML(PEOPLE.me, "av-76")}
        <div><div class="cs-name">${esc(PEOPLE.me.name)}</div><small>@dkrylov · ${esc(PEOPLE.me.title)}</small></div>
        <button class="btn btn--sm" data-toast="Загрузка аватара — в полной версии">Сменить</button>
      </div>
      <div class="form-grid">
        <div class="form-row"><label>Имя</label><input class="input" value="${esc(PEOPLE.me.name)}"></div>
        <div class="form-row"><label>Имя пользователя</label><input class="input" value="@dkrylov"></div>
      </div>
      <div class="form-row"><label>Статус</label><input class="input" value="Проектирую интерфейсы и слушаю голосовые"></div>
      <div class="form-row"><label>О себе</label><textarea class="input">Продуктовый дизайнер. Отвечаю за «Атлас» и дизайн-систему.</textarea></div>
      <div class="form-grid">
        <div class="form-row"><label>Почта</label><input class="input" value="d.krylov@voskhod.team"></div>
        <div class="form-row"><label>Телефон</label><input class="input" value="+7 999 120-44-18"></div>
      </div>
      <div class="form-actions">
        <button class="btn" data-profile>${icon("eye")} Открыть профиль</button>
        <button class="btn btn--accent" data-toast="Профиль сохранён">Сохранить</button>
      </div>
      </div>
      <div class="card" style="margin-top:12px">
        <div class="card-head"><span class="card-title">Безопасность</span><button class="card-link" data-page="security">Открыть защиту</button></div>
        <div class="setting-row"><div class="text"><b>Двухфакторная аутентификация</b><small>Приложение-аутентификатор</small></div><span class="chip chip--accent">включена</span></div>
        <div class="setting-row"><div class="text"><b>Ключи E2EE</b><small>Доверенные устройства</small></div><span class="chip">4 устройства</span></div>
        <div class="setting-row"><div class="text"><b>Активные сеансы</b><small>MacBook Pro, iPhone 15, Windows</small></div><button class="btn btn--sm" data-toast="Все сеансы, кроме текущего, завершены">Завершить</button></div>
      </div>
    `;
  }

  function switchSetting(title, sub, on) {
    return `<div class="setting-row">
      <div class="text"><b>${esc(title)}</b><small>${esc(sub)}</small></div>
      <button class="switch${on ? " is-on" : ""}" data-switch-inline aria-checked="${on}"></button>
    </div>`;
  }

  /* ─────────── окна профиля и настроек чата ─────────── */

  function openModal(html, size) {
    const layer = $("#modal-layer");
    const modal = $("#modal");
    modal.className = "modal" + (size ? " " + size : "");
    modal.innerHTML = html;
    layer.hidden = false;
  }

  function closeModal() {
    const layer = $("#modal-layer");
    if (!layer || layer.hidden) return;
    layer.hidden = true;
    $("#modal").innerHTML = "";
  }

  function openProfile() {
    cancelRecording();
    openModal(profileModal(), "modal--sm");
  }

  function profileModal() {
    return `<div class="modal-head">
      <h2 class="modal-title" id="modal-title">Профиль</h2>
      <span class="modal-sub">@dkrylov</span>
      <button class="modal-x" data-close-modal aria-label="Закрыть">${icon("x")}</button>
    </div>
    <div class="modal-body">
      <div class="profile-hero">
        ${avatarHTML(PEOPLE.me, "av-76")}
        <div><h3>${esc(PEOPLE.me.name)}</h3><p>В сети · ${esc(PEOPLE.me.title)} · Студия «Восход»</p></div>
        <button class="btn btn--sm" data-toast="Редактирование профиля — в настройках">Редактировать</button>
      </div>
      <div class="profile-cards">
        <div class="mini-card">
          <h4>О себе</h4>
          <p style="margin:0">Продуктовый дизайнер. Отвечаю за «Атлас», дизайн-систему и голосовые сообщения.</p>
        </div>
        <div class="mini-card">
          <h4>Контакты</h4>
          <div class="row"><span>Почта</span><span>d.krylov@voskhod.team</span></div>
          <div class="row"><span>Телефон</span><span>+7 999 120-44-18</span></div>
          <div class="row"><span>Часовой пояс</span><span>Москва</span></div>
        </div>
        <div class="mini-card">
          <h4>Устройства</h4>
          <div class="row"><span>MacBook Pro · Chrome</span><span>сейчас</span></div>
          <div class="row"><span>iPhone 15</span><span>2 часа назад</span></div>
          <div class="row"><span>Windows · офис</span><span>вчера</span></div>
        </div>
        <div class="mini-card">
          <h4>Безопасность</h4>
          <div class="row"><span>2FA</span><span>включена</span></div>
          <div class="row"><span>Ключи E2EE</span><span>4 устройства</span></div>
          <div class="row"><span>Сеансы</span><span>3 активных</span></div>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-toast="Выход из аккаунта — демо">${icon("logout")} Выйти</button>
      <button class="btn btn--accent" data-close-modal>Готово</button>
    </div>`;
  }

  function openChatSettings() {
    cancelRecording();
    state.modalTab = "main";
    openModal(chatSettingsModal(), "modal--lg");
  }

  function renderChatSettings() {
    const layer = $("#modal-layer");
    if (layer.hidden) return;
    openModal(chatSettingsModal(), "modal--lg");
  }

  function chatSettingsModal() {
    const chat = currentChat();
    const dm = chat.kind === "dm";
    const tabs = dm
      ? [["main", "Основное"], ["privacy", "Приватность"], ["danger", "Опасная зона"]]
      : [["main", "Основное"], ["members", "Участники"], ["rights", "Права"], ["danger", "Опасная зона"]];
    if (!tabs.some(([id]) => id === state.modalTab)) state.modalTab = "main";
    return `<div class="modal-head">
      <h2 class="modal-title" id="modal-title">Настройки чата</h2>
      <span class="modal-sub">${esc(chat.name)}</span>
      <button class="modal-x" data-close-modal aria-label="Закрыть">${icon("x")}</button>
    </div>
    <div class="modal-tabs">
      ${tabs.map(([id, label]) => `<button class="modal-tab${state.modalTab === id ? " is-active" : ""}" data-modal-tab="${id}">${label}</button>`).join("")}
    </div>
    <div class="modal-body">${chatSettingsBody(chat, dm)}</div>
    <div class="modal-foot">
      ${state.modalTab === "danger"
        ? `<button class="btn" data-close-modal>Закрыть</button>`
        : `<button class="btn" data-close-modal>Отмена</button><button class="btn btn--accent" data-save-chat="1">Сохранить</button>`}
    </div>`;
  }

  function chatSettingsBody(chat, dm) {
    if (state.modalTab === "members") {
      return `<div class="form-row"><label>Ссылка-приглашение</label>
        <div class="invite-row"><input class="input" readonly value="krug.im/s/atlas-1838"><button class="btn btn--sm" data-toast="Ссылка скопирована">Копировать</button></div>
      </div>
      <div class="setting-row" style="border-top:0">
        <div class="text"><b>Приглашения по ссылке</b><small>Новые участники получают роль «Участник»</small></div>
        <button class="switch is-on" data-switch-inline aria-checked="true"></button>
      </div>
      ${chat.members.map((m) => {
        const p = personOf(m.id);
        return `<div class="member-row">
          ${avatarHTML(p, "av-28")}
          <span class="name">${esc(p.name)}${m.id === "me" ? ' <span class="member-me">(вы)</span>' : ""}<small>${esc(p.title || "Участник")}</small></span>
          <select class="role-select" ${m.role === "owner" ? "disabled" : ""}>
            ${["owner", "admin", "mod"].map((r) => `<option value="${r}"${m.role === r ? " selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}
            <option value="member"${m.role === "member" ? " selected" : ""}>Участник</option>
            <option value="guest"${m.role === "guest" ? " selected" : ""}>Гость</option>
          </select>
        </div>`;
      }).join("")}`;
    }

    if (state.modalTab === "rights") {
      return `${switchSetting("Отправка сообщений", "Участники могут писать в канал", true)}
        ${switchSetting("Приглашения", "Модераторы и выше могут приглашать", true)}
        ${switchSetting("Закрепление", "Только админы", false)}
        ${switchSetting("Плагины", "Разрешить включение плагинов", true)}
        ${switchSetting("Экспорт переписки", "Только владелец, с записью в аудит", false)}`;
    }

    if (state.modalTab === "privacy") {
      return `${switchSetting("Секретный чат", "Сквозное шифрование для этой переписки", true)}
        ${switchSetting("Отчёты о прочтении", "Показывать, что вы прочитали", true)}
        ${switchSetting("Индикатор набора", "Показывать «печатает…»", true)}
        <div class="form-row" style="margin-top:10px"><label>Отпечаток ключа</label><input class="input" readonly value="4C11 9A07 E3B2 6D58"></div>
        <button class="btn btn--sm btn--accent" data-toast="Ключи совпадают у 4 из 5 устройств">${icon("shield-check")} Проверить ключи</button>`;
    }

    if (state.modalTab === "danger") {
      return `<div class="danger-card">
        <h4>Архивировать чат</h4>
        <p>Чат исчезнет из списка, история и файлы сохранятся.</p>
        <button class="btn btn--sm" data-toast="Чат архивирован (демо)">Архивировать</button>
      </div>
      <div class="danger-card" style="margin-top:10px">
        <h4>${dm ? "Заблокировать контакт" : "Покинуть канал"}</h4>
        <p>${dm ? "Контакт не сможет писать вам и звонить." : "Вы потеряете доступ к истории и участникам канала."}</p>
        <button class="btn btn--sm" data-toast="${dm ? "Контакт заблокирован" : "Вы покинули канал"} (демо)">${dm ? "Заблокировать" : "Покинуть"}</button>
      </div>
      <div class="danger-card" style="margin-top:10px">
        <h4>Удалить чат</h4>
        <p>Действие необратимо. Медиа и файлы будут удалены у всех участников.</p>
        <button class="btn btn--sm" data-toast="Удаление — только владелец пространства">Удалить</button>
      </div>`;
    }

    return `<div class="chat-settings-head">
      <span class="chat-settings-cover"><img src="${chat.cover}" alt=""></span>
      <div><div class="cs-name">${esc(chat.name)}</div><small>${dm ? "Личный чат" : `${chat.members.length} участников`} · ${isE2EE(chat) ? "сквозное шифрование" : "управляемый контур"}</small></div>
      <button class="btn btn--sm" data-toast="Смена обложки — в полной версии">Заменить обложку</button>
    </div>
    <div class="form-row"><label>Название</label><input class="input" value="${esc(chat.name)}"></div>
    <div class="form-row"><label>Описание</label><textarea class="input">${dm ? "Личная переписка. Ключи только у участников." : chat.id === "atlas" ? "Финальная сборка «Атласа»: макеты, API, демо и решения по релизу." : `Канал «${chat.name}»: обсуждение, файлы и решения команды.`}</textarea></div>
    <div class="form-grid">
      <div class="form-row"><label>Тип</label><select class="select"><option>${dm ? "Личный чат" : chat.e2ee ? "Групповой чат" : "Канал"}</option></select></div>
      <div class="form-row"><label>Тема</label><input class="input" value="Продукт"></div>
    </div>
    <div class="form-row" style="margin-bottom:0"><label>${dm ? "Ссылка на профиль" : "Ссылка-приглашение"}</label>
      <div class="invite-row"><input class="input" readonly value="${dm ? "krug.im/u/" + chat.person : "krug.im/s/" + chat.id + "-1838"}"><button class="btn btn--sm" data-toast="Ссылка скопирована">Копировать</button></div>
    </div>`;
  }

  /* ─────────── голосовые: запись ─────────── */

  const REC_WAVE = [30, 52, 40, 68, 46, 28, 60, 78, 44, 58, 34, 64, 82, 50, 42, 62, 36, 56, 74, 46, 60, 38];

  function formatDur(sec) {
    const s = Math.max(0, Math.round(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function startRecording(seedMs) {
    if (state.recording) return;
    closePops();
    closeWsMenu();
    closeSearch();
    state.recording = true;
    state.recStart = Date.now() - (seedMs || 0);
    $("#composer").hidden = true;
    $("#recording").hidden = false;
    $("#typing").hidden = true;
    $("#rec-time").textContent = formatDur((Date.now() - state.recStart) / 1000);
    $("#rec-wave").innerHTML = REC_WAVE.map(
      (h, i) => `<i style="height:${h}%;animation-delay:${(i % 7) * 0.09}s"></i>`
    ).join("");
    clearInterval(state.recTimer);
    state.recTimer = setInterval(() => {
      $("#rec-time").textContent = formatDur((Date.now() - state.recStart) / 1000);
    }, 500);
  }

  function stopRecording(send) {
    if (!state.recording) return;
    const sec = Math.max(3, Math.round((Date.now() - state.recStart) / 1000));
    state.recording = false;
    clearInterval(state.recTimer);
    state.recTimer = null;
    $("#recording").hidden = true;
    $("#composer").hidden = false;
    if (send) {
      const chat = currentChat();
      chat.messages.push({
        from: "me",
        time: nowTime(),
        voice: { dur: formatDur(sec), wave: REC_WAVE.slice(0, 16) }
      });
      renderMessages();
      toast("Голосовое сообщение отправлено");
    }
  }

  function cancelRecording() {
    if (state.recording) stopRecording(false);
  }

  function applyTheme(theme) {
    state.theme = theme === "dark" ? "dark" : "light";
    document.body.dataset.theme = state.theme;
    document.documentElement.dataset.theme = state.theme;
    try {
      localStorage.setItem("sova-theme", state.theme);
    } catch (e) {
      /* file:// */
    }
  }

  /* ─────────── метаданные песен (ID3) ─────────── */

  function syncsafe(u, o) {
    return ((u[o] & 0x7f) << 21) | ((u[o + 1] & 0x7f) << 14) | ((u[o + 2] & 0x7f) << 7) | (u[o + 3] & 0x7f);
  }

  function decodeID3Text(data) {
    if (!data || !data.length) return "";
    const enc = data[0];
    let bytes = data.subarray(1);
    let label = "windows-1251";
    if (enc === 3) label = "utf-8";
    else if (enc === 2) label = "utf-16be";
    else if (enc === 1) {
      label = "utf-16le";
      if (bytes[0] === 0xfe && bytes[1] === 0xff) {
        label = "utf-16be";
        bytes = bytes.subarray(2);
      } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
        bytes = bytes.subarray(2);
      }
    }
    try {
      return new TextDecoder(label).decode(bytes).replace(/\0+$/, "").trim();
    } catch (e) {
      return "";
    }
  }

  function parseAPIC(data) {
    if (!data || data.length < 32) return null;
    const enc = data[0];
    let i = 1;
    let mime = "";
    while (i < data.length && data[i] !== 0) mime += String.fromCharCode(data[i++]);
    i += 1;
    i += 1; // picture type
    if (enc === 1 || enc === 2) {
      while (i + 1 < data.length && !(data[i] === 0 && data[i + 1] === 0)) i += 2;
      i += 2;
    } else {
      while (i < data.length && data[i] !== 0) i += 1;
      i += 1;
    }
    const image = data.subarray(i);
    if (image.length < 100) return null;
    return new Blob([image], { type: mime || "image/jpeg" });
  }

  function parseID3(buffer) {
    const u = new Uint8Array(buffer);
    if (u.length < 10 || u[0] !== 0x49 || u[1] !== 0x44 || u[2] !== 0x33) return null;
    const ver = u[3];
    const flags = u[5];
    const size = syncsafe(u, 6);
    let off = 10;
    if (flags & 0x40) {
      if (ver === 4) off = 10 + syncsafe(u, 10);
      else off = 10 + 4 + (((u[10] << 24) | (u[11] << 16) | (u[12] << 8) | u[13]) >>> 0);
    }
    const end = Math.min(u.length, 10 + size);
    const out = {};

    while (off + 10 <= end) {
      const id = String.fromCharCode(u[off], u[off + 1], u[off + 2], u[off + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const fsize = ver >= 4
        ? syncsafe(u, off + 4)
        : ((u[off + 4] << 24) | (u[off + 5] << 16) | (u[off + 6] << 8) | u[off + 7]) >>> 0;
      if (fsize <= 0 || off + 10 + fsize > end) break;
      const data = u.subarray(off + 10, off + 10 + fsize);
      if (id === "TIT2") out.title = decodeID3Text(data);
      else if (id === "TPE1") out.artist = decodeID3Text(data);
      else if (id === "TALB") out.album = decodeID3Text(data);
      else if (id === "TYER" || id === "TDRC") out.year = decodeID3Text(data);
      else if (id === "TCON") out.genre = decodeID3Text(data).replace(/^\((\d+)\)/, "$1");
      else if (id === "APIC") {
        const blob = parseAPIC(data);
        if (blob) out.cover = URL.createObjectURL(blob);
      }
      off += 10 + fsize;
    }

    if (!out.title && !out.artist && !out.album && !out.cover) return null;
    return out;
  }

  function getAudioDuration(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const audio = new Audio();
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        URL.revokeObjectURL(url);
        resolve(value);
      };
      audio.preload = "metadata";
      audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? audio.duration : 0);
      audio.onerror = () => finish(0);
      audio.src = url;
      setTimeout(() => finish(0), 5000);
    });
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 КБ";
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
    return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`;
  }

  async function addSongFile(file) {
    toast("Читаем метаданные…");
    let tags = null;
    try {
      tags = parseID3(await file.arrayBuffer());
    } catch (e) {
      tags = null;
    }
    const dur = await getAudioDuration(file);
    const base = file.name.replace(/\.[^.]+$/, "");
    const source = tags && (tags.title || tags.artist || tags.album || tags.cover) ? "ID3" : "FILE";
    const song = {
      title: (tags && tags.title) || base || "Без названия",
      artist: (tags && tags.artist) || "Неизвестный исполнитель",
      album: (tags && tags.album) || "Сингл",
      year: (tags && tags.year) || "",
      genre: (tags && tags.genre) || "",
      dur: formatDur(dur || 0),
      cover: (tags && tags.cover) || "assets/album-cover.svg",
      source
    };
    addMessage({
      from: "me",
      time: nowTime(),
      text: source === "ID3" ? "Метаданные прочитаны из ID3." : "Теги не найдены — показываю имя файла.",
      song
    });
    const list = FILES[state.space];
    if (list) {
      list.unshift({
        name: file.name,
        kind: "audio",
        ext: (file.name.split(".").pop() || "mp3").toUpperCase(),
        size: formatBytes(file.size),
        author: "me",
        date: "сегодня",
        dur: song.dur,
        sub: `Аудио · ${song.artist} · «${song.album}»`,
        cover: song.cover,
        song: true
      });
      renderSidebar();
    }
    toast(source === "ID3" ? "Метаданные прочитаны" : "Метаданные не найдены");
  }

  /* ─────────── старт ─────────── */

  function init() {
    const params = new URLSearchParams(location.search);
    const theme = params.get("theme") || localStorage.getItem("sova-theme") || "light";
    state.theme = theme === "dark" ? "dark" : "light";
    document.body.dataset.theme = state.theme;
    document.documentElement.dataset.theme = state.theme;

    const space = params.get("space");
    if (space && SPACES[space]) state.space = space;

    const chat = params.get("chat");
    if (chat && CHATS[chat] && CHATS[chat].space === state.space) {
      state.chat = chat;
    } else {
      const first = spaceChats(state.space)[0];
      state.chat = first ? first.id : "atlas";
    }

    const viewParam = params.get("view");
    if (viewParam && PAGE_META[viewParam]) state.view = viewParam;

    const settingsParam = params.get("settings");
    if (settingsParam) state.settingsTab = settingsParam;

    const fileTabParam = params.get("filetab");
    if (fileTabParam) state.pageFilter = fileTabParam;

    const detailsParam = params.get("details");
    state.details = detailsParam === null ? window.innerWidth >= 1180 : detailsParam !== "0";

    if (params.get("clean") === "1") {
      const style = document.createElement("style");
      style.textContent = ".toast{display:none!important}";
      document.head.appendChild(style);
    }

    renderAll();
    if (window.innerWidth < 1180 && state.details) {
      state.details = false;
      $("#app").classList.remove("details-open");
      hideScrim();
    }

    const modalParam = params.get("modal");
    if (modalParam === "profile") openProfile();
    if (modalParam === "chat") openChatSettings();

    const threadParam = params.get("thread");
    if (threadParam !== null && CHATS[state.chat].messages[Number(threadParam)]) {
      openThread(Number(threadParam));
    }

    if (params.get("recording")) startRecording(7000);
  }

  init();
})();

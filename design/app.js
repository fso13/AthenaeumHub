'use strict';

/* ═══════════════════════════════════════════════════════════════
   Сова — интерактивный прототип (моки, без бэкенда)
   ═══════════════════════════════════════════════════════════════ */

/* ─────────── Утилиты ─────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const icon = (name, cls = '') =>
  `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function esc(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(text = '') {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
  return s;
}

let uidCounter = 0;
const uid = () => `m${Date.now()}${++uidCounter}`;

/* Демо-часы: новые сообщения продолжают таймлайн моков, а не системное время */
let demoMinutes = 12 * 60 + 41;
function nowTime() {
  demoMinutes = (demoMinutes + 1) % (24 * 60);
  const h = String(Math.floor(demoMinutes / 60)).padStart(2, '0');
  const m = String(demoMinutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function hashString(str = '') {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function initials(name = '') {
  const words = name.replace(/[«»"']/g, '').split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map(w => w[0]).join('').toUpperCase() || '—';
}

function formatBytes(bytes = 0) {
  if (!bytes) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i ? 1 : 0).replace('.', ',')} ${units[i]}`;
}

function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

const extOf = name => (name.split('.').pop() || '').toUpperCase();

function fileVisual(file) {
  const ext = extOf(file.name);
  if (['PDF'].includes(ext)) return { cls: 'is-pdf', icon: 'file' };
  if (['PNG', 'JPG', 'JPEG', 'SVG', 'WEBP', 'GIF'].includes(ext)) return { cls: 'is-img', icon: 'image' };
  if (['YAML', 'YML', 'JSON', 'JS', 'TS', 'JAVA', 'SQL'].includes(ext)) return { cls: 'is-amber', icon: 'file' };
  if (['FIG', 'SKETCH', 'ZIP'].includes(ext)) return { cls: 'is-plum', icon: 'file' };
  return { cls: '', icon: 'file' };
}

const avatarFor = name => `av-${(hashString(name) % 10) + 1}`;

/* ─────────── Данные ─────────── */
const PEOPLE = {
  me:    { name: 'Дмитрий Крылов', short: 'ДК', av: 'av-me', online: true, status: 'В сети', title: 'Product lead' },
  anna:  { name: 'Анна Ким', short: 'АК', av: 'av-1', online: true, status: 'В сети', title: 'Операционный директор' },
  maria: { name: 'Мария Соколова', short: 'МС', av: 'av-2', online: true, status: 'В сети', title: 'Product designer' },
  igor:  { name: 'Игорь Власов', short: 'ИВ', av: 'av-3', online: true, status: 'В сети', title: 'CTO' },
  lena:  { name: 'Лена Орлова', short: 'ЛО', av: 'av-4', online: false, status: 'Была 20 мин назад', title: 'Design lead' },
  egor:  { name: 'Егор Титов', short: 'ЕТ', av: 'av-5', online: true, status: 'В сети', title: 'Backend' },
  pavel: { name: 'Павел Гринёв', short: 'ПГ', av: 'av-9', online: false, status: 'Был вчера', title: 'Frontend' },
  timur: { name: 'Тимур Ахметов', short: 'ТА', av: 'av-10', online: false, status: 'Был 3 ч назад', title: 'Интеграции' },
  olya:  { name: 'Оля Крылова', short: 'ОК', av: 'av-6', online: true, status: 'В сети', title: '' },
  mom:   { name: 'Мама', short: 'М', av: 'av-7', online: false, status: 'Была 2 ч назад', title: '' },
  anya:  { name: 'Аня Крылова', short: 'А', av: 'av-8', online: true, status: 'В сети', title: '' }
};

const WORKSPACES = [
  {
    id: 'studio', name: 'Студия «Восход»', av: 'ws-studio', mode: 'managed',
    plan: 'Team · 8 участников',
    installed: ['polls', 'tasks', 'translate', 'bridge', 'dlp']
  },
  {
    id: 'family', name: 'Семья', av: 'ws-family', mode: 'e2ee',
    plan: 'Family · 5 участников',
    installed: ['polls', 'tasks', 'translate']
  }
];

const PLUGINS = [
  {
    id: 'polls', name: 'Опросы', icon: 'poll', color: '', version: '1.4.0',
    author: 'Krug Labs', desc: 'Быстрые голосования в чате: варианты, срок, один голос на участника.',
    perms: ['chat.messages.send', 'chat.members.read']
  },
  {
    id: 'tasks', name: 'Задачи', icon: 'task', color: 'is-amber', version: '0.9.2',
    author: 'Krug Labs', desc: 'Превращает сообщение в задачу с исполнителем, сроком и статусом.',
    perms: ['chat.messages.send', 'chat.members.read', 'ui.panel']
  },
  {
    id: 'translate', name: 'Перевод', icon: 'translate', color: 'is-blue', version: '2.1.0',
    author: 'Krug Labs', desc: 'Переводит сообщения на лету. В E2EE-чатах работает только на устройстве.',
    perms: ['ui.message', 'storage.workspace']
  },
  {
    id: 'reminders', name: 'Напоминания', icon: 'clock', color: 'is-plum', version: '1.0.3',
    author: 'Third-party', desc: 'Создаёт напоминания из сообщений и дней рождения участников.',
    perms: ['chat.messages.read', 'storage.workspace']
  },
  {
    id: 'bridge', name: 'Мост в Telegram', icon: 'bot', color: 'is-blue', version: '0.6.1',
    author: 'Krug Labs', desc: 'Синхронизирует выбранный чат с Telegram-группой через серверный коннектор.',
    perms: ['chat.messages.read', 'http.request'], managedOnly: true
  },
  {
    id: 'dlp', name: 'DLP-подсказки', icon: 'shield-check', color: 'is-plum', version: '1.2.0',
    author: 'Krug Labs', desc: 'Предупреждает об отправке паспортных данных, ключей и номеров карт.',
    perms: ['chat.messages.read', 'admin.policy'], managedOnly: true, enterprise: true
  }
];

const PLUGIN_BY_ID = Object.fromEntries(PLUGINS.map(p => [p.id, p]));

const STICKER_PACKS = [
  {
    id: 'krug', name: 'Сова',
    stickers: [
      { id: 'krug-heart', emoji: '🫶', label: 'Обнимаю' },
      { id: 'krug-rocket', emoji: '🚀', label: 'Погнали' },
      { id: 'krug-coffee', emoji: '☕', label: 'На связи' },
      { id: 'krug-done', emoji: '✅', label: 'Готово' },
      { id: 'krug-deal', emoji: '🤝', label: 'Договорились' },
      { id: 'krug-party', emoji: '🎉', label: 'Ура!' },
      { id: 'krug-idea', emoji: '💡', label: 'Идея' },
      { id: 'krug-fire', emoji: '🔥', label: 'Огонь' }
    ]
  },
  {
    id: 'cats', name: 'Коты',
    stickers: [
      { id: 'cats-heart', emoji: '😻', label: 'Влюблённый кот' },
      { id: 'cats-laugh', emoji: '😹', label: 'Хохот' },
      { id: 'cats-kiss', emoji: '😽', label: 'Воздушный поцелуй' },
      { id: 'cats-shock', emoji: '🙀', label: 'Шок' },
      { id: 'cats-sly', emoji: '😼', label: 'Хитрый' },
      { id: 'cats-grumpy', emoji: '😾', label: 'Недоволен' },
      { id: 'cats-cry', emoji: '😿', label: 'Слёзы' },
      { id: 'cats-happy', emoji: '😺', label: 'Довольный' }
    ]
  },
  {
    id: 'family', name: 'Семья',
    stickers: [
      { id: 'family-love', emoji: '❤️', label: 'Любовь' },
      { id: 'family-pie', emoji: '🥧', label: 'Пирог' },
      { id: 'family-garden', emoji: '🌿', label: 'Дача' },
      { id: 'family-bbq', emoji: '🍖', label: 'Шашлыки' },
      { id: 'family-home', emoji: '🏡', label: 'Дом' },
      { id: 'family-kiss', emoji: '😘', label: 'Поцелуй' },
      { id: 'family-hug', emoji: '🫂', label: 'Обнимашки' },
      { id: 'family-sun', emoji: '☀️', label: 'Утро' }
    ]
  },
  {
    id: 'work', name: 'Работа',
    stickers: [
      { id: 'work-launch', emoji: '🚀', label: 'Запуск' },
      { id: 'work-pin', emoji: '📌', label: 'Закрепить' },
      { id: 'work-report', emoji: '📊', label: 'Отчёт' },
      { id: 'work-brain', emoji: '🧠', label: 'Мозг' },
      { id: 'work-deadline', emoji: '⏰', label: 'Дедлайн' },
      { id: 'work-yes', emoji: '🫡', label: 'Есть' },
      { id: 'work-power', emoji: '💪', label: 'Сможем' },
      { id: 'work-integration', emoji: '🧩', label: 'Интеграция' }
    ]
  }
];

const STICKER_BY_ID = Object.fromEntries(
  STICKER_PACKS.flatMap(pack => pack.stickers.map(sticker => [sticker.id, { ...sticker, pack: pack.name }]))
);

const MAX_FILE_MB = 200;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const MAX_FILES_PER_MESSAGE = 10;

const chats = [
  /* ── Студия «Восход» ── */
  {
    id: 'atlas', ws: 'studio', type: 'group', name: 'Проект «Атлас»',
    avatarText: 'АТ', av: 'av-1', unread: 0, muted: false, time: '12:40',
    preview: 'Анна: демо в четверг, 16:00',
    pinned: 'Демо — четверг, 16:00. Ссылка появится здесь.',
    members: [
      { id: 'anna', role: 'Владелец' }, { id: 'me', role: 'Админ' },
      { id: 'igor', role: 'Модератор' }, { id: 'lena', role: 'Участник' },
      { id: 'egor', role: 'Участник' }, { id: 'pavel', role: 'Участник' },
      { id: 'timur', role: 'Гость' }
    ],
    plugins: ['polls', 'tasks', 'translate'],
    messages: [
      {
        id: 'a1', author: 'anna', date: 'Вчера', time: '09:12',
        text: 'Коллеги, доброе утро. Собрала финальную версию брифа по «Атласу» — во вложении. Нужны комментарии до 18:00.',
        file: { name: 'atlas-brief-v3.pdf', size: '2,4 МБ' },
        reactions: [{ emoji: '👀', count: 4 }, { emoji: '🔥', count: 2 }]
      },
      {
        id: 'a2', author: 'me', date: 'Вчера', time: '09:18',
        text: 'Посмотрел. Раздел с ролями сильный, но не хватает сценария с гостевым доступом.',
        reply: { author: 'Анна Ким', text: 'Собрала финальную версию брифа по «Атласу»…' }
      },
      { id: 'a3', author: 'igor', date: 'Вчера', time: '09:24', text: 'Добавлю до обеда. Ещё предлагаю зафиксировать SLA на доставку — 150 мс p95.' },
      { id: 'a4', author: 'lena', date: 'Вчера', time: '09:31', text: 'Плюсую. И офлайн-очередь: половина команды в поездках.' },
      {
        id: 'a5', author: 'anna', date: 'Вчера', time: '10:02',
        poll: {
          question: 'Когда созвон по финалу?',
          options: [
            { label: 'Сегодня, 17:00', votes: 4 },
            { label: 'Завтра, 11:00', votes: 2 },
            { label: 'Пятница, 16:00', votes: 1 }
          ],
          votedIndex: 0,
          deadline: 'до 18:00'
        }
      },
      {
        id: 'a6', author: 'lena', date: 'Вчера', time: '10:15',
        image: { src: 'assets/moodboard.svg', alt: 'Мудборд с тёплой терракотовой и зелёной палитрой', caption: 'Мудборд для онбординга. Нравится направление?' },
        reactions: [{ emoji: '❤️', count: 3, me: true }, { emoji: '👍', count: 2 }]
      },
      { id: 'a7', author: 'me', date: 'Вчера', time: '10:22', text: 'Да, тёплое и спокойное — то, что нужно. Берём за основу.' },
      {
        id: 'a8', author: 'igor', date: 'Вчера', time: '11:40',
        text: 'Схема API, можно начинать интеграцию.',
        file: { name: 'atlas-api-v2.yaml', size: '86 КБ' }
      },
      { id: 'a9', author: 'anna', date: 'Сегодня', time: '09:05', text: 'Напоминаю: демо в четверг, 16:00. Ссылка будет здесь.' },
      { id: 'a10', author: 'egor', date: 'Сегодня', time: '09:20', text: 'Бэкенд готов к нагрузочному тесту. Стенд — в описании чата.' },
      { id: 'a11', author: 'me', date: 'Сегодня', time: '09:32', text: 'Отлично. Подключусь после обеда.' },
      { id: 'a12', system: true, date: 'Сегодня', time: '12:38', text: 'Анна добавила Тимура в чат · роль «Гость»' },
      { id: 'a13', author: 'anna', date: 'Сегодня', time: '12:40', text: 'Коллеги, Тимур поможет с интеграцией. Демо в четверг, 16:00 — ссылка появится здесь.' }
    ]
  },
  {
    id: 'maria', ws: 'studio', type: 'dm', name: 'Мария Соколова',
    avatarText: 'МС', av: 'av-2', unread: 2, muted: false, time: '10:26',
    preview: 'Мария: Обновила. Теперь кнопка заметная',
    members: [{ id: 'me', role: 'Участник' }, { id: 'maria', role: 'Участник' }],
    plugins: ['translate'],
    messages: [
      { id: 'b1', author: 'maria', date: 'Вчера', time: '16:20', text: 'Привет! Скинула финальные макеты онбординга, посмотри, пожалуйста.' },
      { id: 'b2', author: 'maria', date: 'Вчера', time: '16:21', file: { name: 'onboarding-final.fig', size: '18,7 МБ' } },
      { id: 'b3', author: 'me', date: 'Вчера', time: '16:40', text: 'Смотрю. Первый экран нравится, но CTA потерялся на фоне.' },
      { id: 'b4', author: 'maria', date: 'Вчера', time: '16:52', text: 'Согласна. Сделаю контрастнее и пришлю до вечера.' },
      { id: 'b5', author: 'maria', date: 'Сегодня', time: '10:14', text: 'Обновила. Теперь кнопка заметная, но не кричит 🙂' },
      {
        id: 'b6', author: 'maria', date: 'Сегодня', time: '10:14',
        image: { src: 'assets/onboarding.svg', alt: 'Экран онбординга с крупной кнопкой «Начать»', caption: 'Вариант с тёплым акцентом' }
      },
      { id: 'b7', author: 'me', date: 'Сегодня', time: '10:26', text: 'Вот это другое дело. Отправляю на ревью.' }
    ]
  },
  {
    id: 'design', ws: 'studio', type: 'group', name: 'Дизайн-система',
    avatarText: 'ДС', av: 'av-4', unread: 0, muted: false, time: '14:30',
    preview: 'Лена: Обновила токены в Figma',
    members: [
      { id: 'lena', role: 'Владелец' }, { id: 'maria', role: 'Админ' },
      { id: 'me', role: 'Участник' }, { id: 'pavel', role: 'Участник' }
    ],
    plugins: ['tasks'],
    messages: [
      { id: 'c1', author: 'lena', date: 'Вчера', time: '14:02', text: 'Обновила токены: акцент теперь #1E6B57, радиусы 8 / 14 / 20. Всё в Figma-библиотеке.' },
      { id: 'c2', author: 'lena', date: 'Вчера', time: '14:03', file: { name: 'tokens.json', size: '12 КБ' } },
      { id: 'c3', author: 'maria', date: 'Вчера', time: '14:15', text: 'Проверила контраст — AA проходит, кроме вторичного текста на тёплом фоне.' },
      { id: 'c4', author: 'me', date: 'Вчера', time: '14:22', text: 'Поправлю. Предлагаю `#6B7470` вместо `#8A918C`.' },
      { id: 'c5', author: 'lena', date: 'Вчера', time: '14:30', text: 'Согласна, так лучше. Обновила.', reactions: [{ emoji: '✅', count: 2 }] }
    ]
  },
  {
    id: 'egor', ws: 'studio', type: 'dm', name: 'Егор Титов',
    avatarText: 'ЕТ', av: 'av-5', unread: 0, muted: false, time: '09:10',
    preview: 'Егор: Готово, закинул в ветку',
    members: [{ id: 'me', role: 'Участник' }, { id: 'egor', role: 'Участник' }],
    plugins: [],
    messages: [
      { id: 'd1', author: 'me', date: 'Вчера', time: '18:02', text: 'Привет! Глянь, пожалуйста, схему ретраев в «Атласе».' },
      { id: 'd2', author: 'egor', date: 'Вчера', time: '18:20', text: 'Глянул. Мне кажется, стоит добавить джиттер и лимит в 5 попыток.' },
      { id: 'd3', author: 'me', date: 'Вчера', time: '18:24', text: 'Согласен. Обновишь?' },
      { id: 'd4', author: 'egor', date: 'Сегодня', time: '09:10', text: 'Готово, закинул в ветку `feature/retry`. Схема — в задаче.' }
    ]
  },
  {
    id: 'general', ws: 'studio', type: 'group', name: 'Общий чат',
    avatarText: 'ОЧ', av: 'av-3', unread: 12, muted: true, time: '09:06',
    preview: 'Анна: Добавила в повестку',
    members: [
      { id: 'anna', role: 'Владелец' }, { id: 'me', role: 'Админ' },
      { id: 'igor', role: 'Участник' }, { id: 'lena', role: 'Участник' },
      { id: 'egor', role: 'Участник' }, { id: 'pavel', role: 'Участник' },
      { id: 'timur', role: 'Гость' }, { id: 'maria', role: 'Участник' }
    ],
    plugins: ['polls'],
    messages: [
      { id: 'e1', author: 'anna', date: 'Сегодня', time: '09:00', text: 'Доброе утро! Напоминаю про общий созвон в пятницу.' },
      { id: 'e2', author: 'igor', date: 'Сегодня', time: '09:05', text: 'Буду. Можно добавить пункт про доступы к проду?' },
      { id: 'e3', author: 'anna', date: 'Сегодня', time: '09:06', text: 'Добавила в повестку.' }
    ]
  },

  /* ── Семья ── */
  {
    id: 'family', ws: 'family', type: 'group', name: 'Семья',
    avatarText: 'С', av: 'av-6', unread: 2, muted: false, time: '08:38',
    preview: 'Аня: Стикер 😻',
    pinned: 'Дача в субботу · угли и маршмеллоу берёт Дима',
    members: [
      { id: 'olya', role: 'Владелец' }, { id: 'me', role: 'Админ' },
      { id: 'mom', role: 'Участник' }, { id: 'anya', role: 'Участник' },
      { id: 'pavel', role: 'Участник' }
    ],
    plugins: ['polls', 'tasks'],
    messages: [
      { id: 'f1', system: true, date: 'Вчера', time: '18:30', text: 'Оля включила сквозное шифрование в этом чате' },
      {
        id: 'f2', author: 'olya', date: 'Вчера', time: '18:42', text: 'Смотрите, какое утро на даче ☀️',
        image: { src: 'assets/dacha-morning.svg', alt: 'Туманное утро на даче: холмы, домик и солнце', caption: 'Снято в 7:10, пока все спали' },
        reactions: [{ emoji: '❤️', count: 3, me: true }, { emoji: '😍', count: 2 }]
      },
      { id: 'f3', author: 'mom', date: 'Вчера', time: '18:50', text: 'Какая красота. Прямо как в детстве.' },
      { id: 'f4', author: 'anya', date: 'Вчера', time: '18:52', text: 'Мам, ты когда приедешь? Соскучилась!' },
      {
        id: 'f5', author: 'olya', date: 'Вчера', time: '19:10',
        poll: {
          question: 'Куда поедем на выходных?',
          options: [
            { label: 'На дачу — шашлыки', votes: 3 },
            { label: 'В Суздаль', votes: 1 },
            { label: 'Остаёмся дома', votes: 0 }
          ],
          votedIndex: 0,
          deadline: 'до пятницы'
        }
      },
      { id: 'f6', author: 'mom', date: 'Вчера', time: '19:15', voice: { duration: '0:23' } },
      { id: 'f7', author: 'pavel', date: 'Сегодня', time: '08:12', text: 'Всем привет! Я за дачу 🍖' },
      { id: 'f8', author: 'olya', date: 'Сегодня', time: '08:30', text: 'Тогда решено. Дима, купи угли?' },
      { id: 'f9', author: 'me', date: 'Сегодня', time: '08:35', text: 'Уже в списке. Возьму ещё маршмеллоу для Ани.' },
      { id: 'f10', author: 'anya', date: 'Сегодня', time: '08:36', text: '🔥🔥', reactions: [{ emoji: '❤️', count: 2 }] },
      { id: 'f11', author: 'anya', date: 'Сегодня', time: '08:38', sticker: { id: 'cats-heart', emoji: '😻', label: 'Влюблённый кот', pack: 'Коты' } }
    ]
  },
  {
    id: 'mom', ws: 'family', type: 'dm', name: 'Мама',
    avatarText: 'М', av: 'av-7', unread: 1, muted: false, time: '11:02',
    preview: 'Мама: Позвони, когда сможешь',
    members: [{ id: 'me', role: 'Участник' }, { id: 'mom', role: 'Участник' }],
    plugins: [],
    messages: [
      { id: 'g1', author: 'mom', date: 'Вчера', time: '20:10', text: 'Сынок, ты обещал заехать на выходных.' },
      { id: 'g2', author: 'me', date: 'Вчера', time: '20:15', text: 'Заеду, мам. В субботу после обеда.' },
      { id: 'g3', author: 'mom', date: 'Вчера', time: '20:17', text: 'Хорошо. Испеку пирог с яблоками 🥧' },
      { id: 'g4', author: 'mom', date: 'Сегодня', time: '11:02', text: 'Позвони, когда сможешь. Хочу про дачу спросить.' }
    ]
  },
  {
    id: 'dacha', ws: 'family', type: 'group', name: 'Дача',
    avatarText: 'Д', av: 'av-8', unread: 0, muted: false, time: 'Вчера',
    preview: 'Оля: Дима берёт, он уже в списке',
    members: [
      { id: 'olya', role: 'Владелец' }, { id: 'me', role: 'Админ' },
      { id: 'mom', role: 'Участник' }, { id: 'pavel', role: 'Участник' }
    ],
    plugins: ['tasks'],
    messages: [
      { id: 'h1', system: true, date: 'Вчера', time: '11:58', text: 'Оля создала чат «Дача»' },
      { id: 'h2', author: 'me', date: 'Вчера', time: '12:00', text: 'Создал чат для дачных дел. Здесь только по существу.' },
      { id: 'h3', author: 'pavel', date: 'Вчера', time: '12:10', text: 'Понял. Кто берёт инструменты?' },
      { id: 'h4', author: 'olya', date: 'Вчера', time: '12:15', text: 'Дима берёт, он уже в списке.' }
    ]
  }
];

/* ─────────── Состояние ─────────── */
function readStoredTheme() {
  try { return localStorage.getItem('krug-theme') || 'light'; } catch { return 'light'; }
}

const state = {
  wsId: 'studio',
  chatId: 'atlas',
  filter: 'all',
  query: '',
  detailsTab: 'people',
  detailsOpen: window.innerWidth > 1280,
  sidebarOpen: false,
  replyTo: null,
  typing: null,
  theme: readStoredTheme(),
  stickerPack: 'krug',
  recentStickerIds: ['krug-heart', 'cats-heart', 'family-love']
};

let lastReplyAt = 0;
const pendingReplies = new Set();
const uploadTimers = new Map();

/* ─────────── Хелперы данных ─────────── */
const wsById = id => WORKSPACES.find(w => w.id === id);
const currentWs = () => wsById(state.wsId);
const chatsFor = wsId => chats.filter(c => c.ws === wsId);
const currentChat = () => chats.find(c => c.id === state.chatId) || chatsFor(state.wsId)[0];
const persona = id => PEOPLE[id] || { name: id, short: '?', av: 'av-9', online: false, status: '' };
const isE2EE = chat => wsById(chat.ws)?.mode === 'e2ee';
const myRole = chat => chat.members.find(m => m.id === 'me')?.role || 'Участник';
const canManage = chat => ['Владелец', 'Админ'].includes(myRole(chat));
const onlineCount = chat => chat.members.filter(m => persona(m.id).online).length;
const memberIds = wsId => [...new Set(chatsFor(wsId).flatMap(c => c.members.map(m => m.id)))];
const workspacePeople = wsId => memberIds(wsId).filter(id => id !== 'me').map(id => ({ id, ...persona(id) }));

function modeChip(chat) {
  return isE2EE(chat)
    ? `<span class="chip chip--e2ee">${icon('lock')}E2EE</span>`
    : `<span class="chip chip--managed">${icon('shield')}Управляемый</span>`;
}

function fingerprint(seed) {
  let h = hashString(seed);
  const parts = [];
  for (let i = 0; i < 4; i++) {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    parts.push(h.toString(16).toUpperCase().padStart(8, '0').slice(0, 4));
  }
  return parts.join(' ');
}

function safetyNumber(seed) {
  let h = hashString(seed);
  const parts = [];
  for (let i = 0; i < 4; i++) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    parts.push(String(h % 10000).padStart(4, '0'));
  }
  return parts;
}

function previewText(msg) {
  if (msg.text) return msg.text;
  if (msg.sticker) return `Стикер ${msg.sticker.emoji}`;
  if (msg.file) return `Файл: ${msg.file.name}`;
  if (msg.poll) return `Опрос: ${msg.poll.question}`;
  if (msg.image) return msg.image.caption || 'Фото';
  if (msg.task) return `Задача: ${msg.task.title}`;
  if (msg.voice) return 'Голосовое сообщение';
  return 'Сообщение';
}

function previewAuthor(msg) {
  return msg.author === 'me' ? 'Вы' : persona(msg.author).name.split(' ')[0];
}

function updateChatPreview(chat, msg) {
  chat.preview = `${previewAuthor(msg)}: ${previewText(msg)}`;
  chat.time = msg.time;
}

/* ─────────── Рендер: сайдбар ─────────── */
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', state.theme === 'dark' ? '#0D1110' : '#F3F1EC');
}

function renderWorkspace() {
  const ws = currentWs();
  $('#brand-ws').textContent = ws.name;
  renderWsList();
}

function renderWsList() {
  $('#ws-list').innerHTML = WORKSPACES.map(ws => {
    const active = ws.id === state.wsId;
    return `
      <button class="ws-option ${active ? 'is-active' : ''}" data-action="switch-ws" data-id="${ws.id}">
        <span class="avatar ${ws.av}">${initials(ws.name)}</span>
        <span class="ws-option-text">
          <span class="ws-name">${esc(ws.name)}</span>
          <span class="ws-meta">${ws.mode === 'e2ee' ? 'E2EE' : 'Управляемый'} · ${esc(ws.plan.split('·').pop().trim())}</span>
        </span>
        ${active ? `<span class="ws-check">${icon('check')}</span>` : ''}
      </button>`;
  }).join('');
}

function filteredChats() {
  let list = chatsFor(state.wsId);
  if (state.filter === 'unread') list = list.filter(c => c.unread > 0);
  if (state.filter === 'groups') list = list.filter(c => c.type === 'group');
  if (state.query.trim()) {
    const q = state.query.trim().toLowerCase();
    list = list.filter(c => {
      const names = c.members.map(m => persona(m.id).name).join(' ');
      return `${c.name} ${c.preview} ${names}`.toLowerCase().includes(q);
    });
  }
  return list;
}

function renderChatList() {
  const list = filteredChats();
  const totalOnline = chatsFor(state.wsId)
    .flatMap(c => c.members.map(m => m.id))
    .filter((id, i, arr) => arr.indexOf(id) === i)
    .filter(id => persona(id).online).length;
  $('#online-count').textContent = `${totalOnline} онлайн`;

  if (!list.length) {
    $('#chat-list').innerHTML = `
      <div class="empty-chat" style="padding: 28px 12px;">
        ${icon('search')}
        <div class="empty-chat-title">Ничего не найдено</div>
        <div class="empty-chat-text">Попробуйте другой запрос или фильтр</div>
      </div>`;
  } else {
    $('#chat-list').innerHTML = list.map(chat => {
      const e2ee = isE2EE(chat);
      const badge = chat.unread
        ? `<span class="ci-badge ${chat.muted ? 'is-muted' : ''}">${chat.unread}</span>`
        : '';
      const muteIcon = chat.muted ? icon('bell-off') : '';
      const presence = chat.type === 'dm' && persona(chat.members.find(m => m.id !== 'me')?.id).online
        ? '<span class="presence is-online"></span>' : '';
      return `
        <button class="chat-item ${chat.id === state.chatId ? 'is-active' : ''} ${chat.muted ? 'is-muted' : ''}"
          data-action="select-chat" data-id="${chat.id}">
          <span class="avatar ${chat.av}">${esc(chat.avatarText)}${presence}</span>
          <span class="ci-main">
            <span class="ci-top">
              <span class="ci-name">${esc(chat.name)}</span>
              <span class="ci-time">${muteIcon}${esc(chat.time)}</span>
            </span>
            <span class="ci-bottom">
              <span class="ci-preview">${e2ee ? icon('lock') : ''}<span class="ci-preview-text">${esc(chat.preview)}</span></span>
              ${badge}
            </span>
          </span>
        </button>`;
    }).join('');
  }

  $$('#filters .filter').forEach(btn => {
    const active = btn.dataset.filter === state.filter;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  });
}

/* ─────────── Рендер: шапка чата ─────────── */
function renderHeader() {
  const chat = currentChat();
  if (!chat) {
    $('#chat-id').innerHTML = '';
    return;
  }
  const dm = chat.type === 'dm';
  const otherId = chat.members.find(m => m.id !== 'me')?.id;
  const other = dm ? persona(otherId) : null;
  const meta = dm
    ? (other.online
        ? `<span class="meta-online">В сети</span><span class="dot"></span><span>${esc(other.title || 'Личный чат')}</span>`
        : `<span>${esc(other.status)}</span><span class="dot"></span><span>${esc(other.title || 'Личный чат')}</span>`)
    : `<span>${chat.members.length} ${plural(chat.members.length, ['участник', 'участника', 'участников'])}</span>
       <span class="dot"></span>
       <span class="meta-online">${onlineCount(chat)} онлайн</span>`;
  const presence = dm && other.online ? '<span class="presence is-online"></span>' : '';
  const title = dm ? other.name : chat.name;
  $('#chat-id').innerHTML = `
    <span class="avatar ${dm ? other.av : chat.av}">${esc(dm ? other.short : chat.avatarText)}${presence}</span>
    <span class="chat-id-text">
      <span class="chat-title"><span class="chat-title-name">${esc(title)}</span>${modeChip(chat)}</span>
      <span class="chat-meta">${meta}</span>
    </span>`;
}

/* ─────────── Рендер: закреплённое ─────────── */
function renderPinned() {
  const chat = currentChat();
  const el = $('#pinned');
  if (!chat || !chat.pinned || chat.pinnedClosed) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  $('#pinned-text').textContent = chat.pinned;
}

/* ─────────── Рендер: сообщения ─────────── */
function quoteHTML(reply) {
  return `
    <div class="quote">
      <span class="quote-author">${esc(reply.author)}</span>
      <span class="quote-text">${esc(reply.text)}</span>
    </div>`;
}

function fileHTML(file, e2ee, uploading, progress) {
  const visual = fileVisual(file);
  return `
    <div class="file-card ${uploading ? 'uploading' : ''}" ${uploading ? `data-upload="${file.id || ''}"` : ''}>
      <div class="file-ico ${visual.cls}">${icon(visual.icon)}</div>
      <div class="file-info">
        <span class="file-name">${esc(file.name)}</span>
        <div class="file-meta">
          <span>${esc(file.size)}</span>
          ${e2ee ? `<span class="sep"></span>${icon('lock')}<span>зашифрован</span>` : ''}
          ${uploading ? `<span class="sep"></span><span class="upload-pct">${progress || 0}%</span>` : ''}
        </div>
        ${uploading ? `<div class="upload-track"><div class="upload-fill" style="width:${progress || 0}%"></div></div>` : ''}
      </div>
      ${uploading ? '' : `<button class="icon-btn file-action" data-action="toast" data-text="Скачивание начнётся в полной версии" aria-label="Скачать файл">${icon('download')}</button>`}
    </div>`;
}

function pollHTML(poll) {
  const total = poll.options.reduce((s, o) => s + o.votes, 0);
  return `
    <div class="poll-card">
      <div class="poll-q">${fmt(poll.question)}</div>
      <div class="poll-options">
        ${poll.options.map((opt, i) => {
          const pct = total ? Math.round((opt.votes / total) * 100) : 0;
          return `
            <button class="poll-opt ${poll.votedIndex === i ? 'is-voted' : ''}" data-action="vote" data-message="${poll.messageId}" data-option="${i}">
              <span class="poll-fill" style="width:${pct}%"></span>
              <span class="poll-label"><span class="poll-radio"></span>${esc(opt.label)}</span>
              <span class="poll-count">${opt.votes}</span>
            </button>`;
        }).join('')}
      </div>
      <div class="poll-foot">${icon('users')} ${total} ${plural(total, ['голос', 'голоса', 'голосов'])} <span>·</span> ${esc(poll.deadline || 'Опрос')}</div>
    </div>`;
}

function taskHTML(task, msgId) {
  const assignee = persona(task.assignee);
  return `
    <div class="task-card ${task.done ? 'is-done' : ''}">
      <button class="task-check" data-action="toggle-task" data-message="${msgId}" aria-label="Отметить задачу выполненной">${icon('check')}</button>
      <div>
        <div class="task-title">${esc(task.title)}</div>
        <div class="task-meta">
          <span class="task-assignee">${icon('users')} ${esc(assignee.name.split(' ')[0])}</span>
          <span>${icon('clock')} ${esc(task.due)}</span>
          ${task.priority ? `<span class="task-prio">${esc(task.priority)}</span>` : ''}
        </div>
      </div>
    </div>`;
}

function voiceHTML(v) {
  const heights = [36, 62, 44, 78, 52, 38, 70, 46, 84, 58, 34, 66, 50, 76, 42, 60, 82, 48, 36, 68, 54, 74, 44, 58, 80, 40, 64, 50];
  return `
    <div class="voice-card">
      <button class="voice-play" data-action="play-voice" aria-label="Прослушать голосовое">${icon('play')}</button>
      <div class="wave">${heights.map((h, i) => `<span style="height:${h}%; animation-delay:${(i % 7) * 0.08}s"></span>`).join('')}</div>
      <span class="voice-time">${esc(v.duration)}</span>
    </div>`;
}

function reactionsHTML(msg) {
  if (!msg.reactions || !msg.reactions.length) return '';
  return `<div class="reactions">${msg.reactions.map(r => `
    <button class="reaction ${r.me ? 'is-mine' : ''}" data-action="react" data-message="${msg.id}" data-emoji="${esc(r.emoji)}">
      <span class="emoji">${esc(r.emoji)}</span><span>${r.count}</span>
    </button>`).join('')}</div>`;
}

function messageHTML(msg, chat, showAuthor) {
  if (msg.system) {
    return `<div class="msg-system">${icon('users')} ${esc(msg.text)}</div>`;
  }
  const mine = msg.author === 'me';
  const p = persona(msg.author);
  const e2ee = isE2EE(chat);
  const rich = Boolean(msg.file || msg.image || msg.poll || msg.task || msg.voice || msg.sticker);
  const bubbleClass = `bubble ${rich ? 'bubble--rich' : ''} ${msg.sticker ? 'bubble--sticker' : ''}`;
  const foot = `
    <div class="bubble-foot">
      <span>${esc(msg.time)}</span>
      ${mine ? icon('check-double') : ''}
      ${e2ee ? icon('lock') : ''}
    </div>`;

  let content = '';
  if (msg.reply) content += quoteHTML(msg.reply);
  if (msg.text) content += `<div class="bubble-text">${fmt(msg.text)}</div>`;

  if (msg.sticker) {
    content += `
      <div class="sticker-art" role="img" aria-label="Стикер: ${esc(msg.sticker.label)}">${msg.sticker.emoji}</div>
      <div class="sticker-caption">${esc(msg.sticker.label)} · ${esc(msg.sticker.pack)}</div>`;
  }
  if (msg.file) content += fileHTML({ ...msg.file, id: msg.id }, e2ee, msg.uploading, msg.progress);
  if (msg.image) {
    content += `
      <div class="msg-photo">
        <img src="${msg.image.src}" alt="${esc(msg.image.alt || '')}" loading="lazy" />
        ${e2ee ? `<span class="photo-badge">${icon('lock')} E2EE</span>` : ''}
      </div>
      ${msg.image.caption ? `<div class="photo-caption">${esc(msg.image.caption)}</div>` : ''}`;
  }
  if (msg.poll) content += pollHTML({ ...msg.poll, messageId: msg.id });
  if (msg.task) content += taskHTML(msg.task, msg.id);
  if (msg.voice) content += voiceHTML(msg.voice);

  return `
    <div class="msg-row ${mine ? 'mine' : ''} ${msg.fresh ? 'is-fresh' : ''}" id="msg-${msg.id}" data-row="${msg.id}">
      ${mine ? '' : `<span class="avatar ${p.av}" title="${esc(p.name)}">${esc(p.short)}</span>`}
      <div class="msg-stack">
        ${!mine && showAuthor ? `<div class="msg-author">${esc(p.name)}</div>` : ''}
        <div class="${bubbleClass}">
          ${content}
          ${foot}
        </div>
        ${reactionsHTML(msg)}
        <div class="msg-actions">
          <button class="icon-btn" data-action="quick-react" data-message="${msg.id}" title="Поставить ❤️" aria-label="Поставить реакцию">❤️</button>
          <button class="icon-btn" data-action="reply" data-message="${msg.id}" title="Ответить" aria-label="Ответить">${icon('reply')}</button>
          <button class="icon-btn" data-action="message-more" data-message="${msg.id}" title="Ещё" aria-label="Ещё действия">${icon('more')}</button>
        </div>
      </div>
    </div>`;
}

function renderMessages(scroll = true) {
  const chat = currentChat();
  const el = $('#messages');
  if (!chat) {
    el.innerHTML = `<div class="empty-chat">${icon('search')}<div class="empty-chat-title">Выберите чат</div></div>`;
    return;
  }
  let html = '';
  let prev = null;
  if (chat.messages.length === 1 && chat.messages[0].system) {
    const dm = chat.type === 'dm';
    const other = dm ? persona(chat.members.find(m => m.id !== 'me')?.id) : null;
    const introAv = dm ? other.av : chat.av;
    const introText = dm
      ? 'Это начало вашей личной переписки. Сообщения, файлы и звонки защищены по умолчанию.'
      : 'Группа создана. Пригласите участников по ссылке и начните обсуждение.';
    const link = `sova.im/s/${chat.id}-${1000 + (hashString(chat.id) % 8999)}`;
    html += `
      <div class="chat-intro">
        <span class="avatar avatar--xl ${introAv}">${esc(dm ? other.short : chat.avatarText)}</span>
        <div class="chat-intro-title">${esc(dm ? other.name : chat.name)}</div>
        <div class="chat-intro-text">${esc(introText)}</div>
        <button class="btn btn--soft btn--sm" data-action="copy" data-copy="${esc(link)}">${icon('link')} Скопировать ссылку</button>
      </div>`;
  }
  for (const msg of chat.messages) {
    if (!prev || prev.date !== msg.date) {
      html += `<div class="day-divider">${esc(msg.date)}</div>`;
    }
    if (msg.system) {
      html += messageHTML(msg, chat, false);
    } else {
      const showAuthor = chat.type === 'group' && !prev?.system && prev?.author !== msg.author;
      html += messageHTML(msg, chat, showAuthor);
    }
    prev = msg;
  }

  if (state.typing && state.typing.chatId === chat.id) {
    const p = persona(state.typing.author);
    html += `
      <div class="typing-row">
        <span class="avatar ${p.av}">${esc(p.short)}</span>
        <div class="typing-bubble"><i></i><i></i><i></i></div>
        <span class="typing-label">${esc(p.name.split(' ')[0])} печатает…</span>
      </div>`;
  }

  el.innerHTML = html;
  $$('.msg-row.is-fresh', el).forEach(row => {
    setTimeout(() => row.classList.remove('is-fresh'), 260);
  });
  if (scroll) {
    const toBottom = () => { el.scrollTop = el.scrollHeight; };
    requestAnimationFrame(() => requestAnimationFrame(toBottom));
    setTimeout(toBottom, 60);
    el.querySelectorAll('img').forEach(img => {
      if (!img.complete) img.addEventListener('load', toBottom, { once: true });
    });
  }
}

/* ─────────── Рендер: панель деталей ─────────── */
function roleBadge(role) {
  const cls = role === 'Владелец' ? 'is-owner' : role === 'Админ' ? 'is-admin' : role === 'Гость' ? 'is-guest' : '';
  return `<span class="role-badge ${cls}">${role === 'Владелец' ? icon('crown') : ''}${esc(role)}</span>`;
}

function roleControl(chat, member) {
  if (member.id === 'me' || member.role === 'Владелец' || !canManage(chat)) {
    return roleBadge(member.role);
  }
  const roles = ['Админ', 'Модератор', 'Участник', 'Гость'];
  return `
    <select class="role-select" data-role-select data-chat="${chat.id}" data-user="${member.id}" aria-label="Роль участника ${esc(persona(member.id).name)}">
      ${roles.map(r => `<option value="${r}" ${r === member.role ? 'selected' : ''}>${r}</option>`).join('')}
    </select>`;
}

function renderPeoplePanel(chat) {
  const dm = chat.type === 'dm';
  const otherId = chat.members.find(m => m.id !== 'me')?.id;
  const other = dm ? persona(otherId) : null;

  if (dm) {
    const files = sharedFiles(chat);
    return `
      <div class="panel-profile">
        <span class="avatar avatar--xl ${other.av}">${esc(other.short)}${other.online ? '<span class="presence is-online"></span>' : ''}</span>
        <div class="panel-name">${esc(other.name)}</div>
        <div class="panel-status">${other.online ? '<span class="meta-online">В сети</span>' : esc(other.status)} · ${esc(other.title || 'Личный чат')}</div>
        <div class="panel-mode">${modeChip(chat)}<span class="chip chip--plain">Личный чат</span></div>
        <div class="panel-actions">
          <button class="btn btn--soft" data-action="toast" data-text="Звонки появятся в v1.5">${icon('phone')} Позвонить</button>
          <button class="btn btn--ghost" data-action="open-files">${icon('folder')} Файлы</button>
        </div>
      </div>
      <div class="section-label">О переписке</div>
      <div class="check-list">
        <div class="check-row">${icon(isE2EE(chat) ? 'lock' : 'shield')}<span>${isE2EE(chat) ? 'Сквозное шифрование, ключи на устройствах' : 'Шифрование на сервере, доступ по политике'}</span></div>
        <div class="check-row">${icon('folder')}<span>${files.length} ${plural(files.length, ['общий файл', 'общих файла', 'общих файлов'])}</span></div>
        <div class="check-row">${icon('clock')}<span>История хранится 12 месяцев</span></div>
      </div>
      <div class="note-card">
        ${icon('info')} В демо-прототипе данные не отправляются на сервер. ${isE2EE(chat) ? 'Ключи генерируются локально.' : 'Все действия попадают в журнал аудита.'}
      </div>`;
  }

  const memberRows = chat.members.map(m => {
    const p = persona(m.id);
    return `
      <div class="member">
        <span class="avatar ${p.av}">${esc(p.short)}${p.online ? '<span class="presence is-online"></span>' : ''}</span>
        <div class="member-main">
          <div class="member-name">${esc(p.name)}${m.id === 'me' ? '<span class="you">вы</span>' : ''}</div>
          <div class="member-sub">${p.online ? '<span class="is-online">В сети</span>' : esc(p.status)}</div>
        </div>
        ${roleControl(chat, m)}
      </div>`;
  }).join('');

  const link = `sova.im/s/${chat.id}-${1000 + (hashString(chat.id) % 8999)}`;
  return `
    <div class="panel-profile">
      <span class="avatar avatar--lg ${chat.av}">${esc(chat.avatarText)}</span>
      <div class="panel-name">${esc(chat.name)}</div>
      <div class="panel-status">${chat.members.length} ${plural(chat.members.length, ['участник', 'участника', 'участников'])} · ${onlineCount(chat)} онлайн</div>
      <div class="panel-mode">${modeChip(chat)}<span class="chip chip--plain">${isE2EE(chat) ? 'Приватный' : 'Командный'}</span></div>
    </div>
    <div class="section-label">Участники <span class="count">${chat.members.length}</span></div>
    <div class="member-list">${memberRows}</div>
    <div class="invite-card">
      <div class="invite-title">${icon('link')} Пригласить в чат</div>
      <div class="invite-text">Ссылка действует 7 дней, роль — «Участник». Гостевой доступ можно ограничить.</div>
      <div class="invite-link">
        <code>${esc(link)}</code>
        <button class="icon-btn" data-action="copy" data-copy="${esc(link)}" aria-label="Скопировать ссылку" title="Скопировать">${icon('copy')}</button>
      </div>
    </div>
    <div class="note-card">${icon('shield')} Менять роли могут владелец и администраторы. Каждое изменение попадает в аудит.</div>`;
}

function sharedFiles(chat) {
  return chat.messages.filter(m => m.file || m.image);
}

function pluginSwitch(chat, plugin) {
  const unavailable = plugin.managedOnly && isE2EE(chat);
  const checked = chat.plugins.includes(plugin.id) && !unavailable;
  return `
    <label class="switch" title="${unavailable ? 'Недоступно в конфиденциальном чате' : 'Включить в чате'}">
      <input type="checkbox" data-plugin-switch data-plugin="${plugin.id}" ${checked ? 'checked' : ''} ${unavailable ? 'disabled' : ''} aria-label="Плагин ${esc(plugin.name)}" />
      <span class="switch-track"></span>
    </label>`;
}

function renderPluginsPanel(chat) {
  const ws = currentWs();
  const installed = ws.installed.map(id => PLUGIN_BY_ID[id]).filter(Boolean);
  return `
    <div class="plugin-intro">Плагины расширяют чат, но получают только явно выданные права. Сервер проверяет каждое действие.</div>
    <div class="section-label">В пространстве <span class="count">${installed.length}</span></div>
    ${installed.map(p => {
      const unavailable = p.managedOnly && isE2EE(chat);
      return `
        <div class="plugin-item">
          <span class="plugin-ico ${p.color}">${icon(p.icon)}</span>
          <div class="plugin-main">
            <div class="plugin-name">${esc(p.name)}${p.enterprise ? ' <span style="color:var(--amber);font-weight:600;font-size:9px">ENT</span>' : ''}</div>
            <div class="plugin-desc">${unavailable ? 'Недоступно в конфиденциальном чате: нужен управляемый контур.' : esc(p.desc)}</div>
          </div>
          ${pluginSwitch(chat, p)}
        </div>`;
    }).join('')}
    <button class="btn btn--ghost btn--block" style="margin-top:9px" data-action="open-plugins">${icon('plus')} Каталог плагинов</button>
    ${isE2EE(chat) ? `
      <div class="note-card">${icon('lock')} <b>Конфиденциальный чат.</b> Плагины работают на устройстве и получают доступ к расшифрованным сообщениям только с вашего согласия. Серверные коннекторы отключены.</div>` : `
      <div class="note-card">${icon('shield')} <b>Управляемый чат.</b> Действия плагинов журналируются. Администратор может отключить плагин для всего пространства.</div>`}
  `;
}

function devicesHTML() {
  return `
    <div class="device">
      <span class="device-ico">${icon('monitor')}</span>
      <div class="device-main"><div class="device-name">MacBook Pro · Safari</div><div class="device-sub">Москва · сейчас</div></div>
      <span class="device-tag">это устройство</span>
    </div>
    <div class="device">
      <span class="device-ico">${icon('smartphone')}</span>
      <div class="device-main"><div class="device-name">iPhone 15 · приложение</div><div class="device-sub">Москва · 2 часа назад</div></div>
    </div>
    <div class="device">
      <span class="device-ico">${icon('monitor')}</span>
      <div class="device-main"><div class="device-name">Chrome · Windows</div><div class="device-sub">Санкт-Петербург · вчера</div></div>
    </div>`;
}

function renderSecurityPanel(chat) {
  const e2ee = isE2EE(chat);
  const fp = fingerprint(chat.id);
  const hero = e2ee ? `
      <div class="sec-hero">
        <span class="sec-hero-icon">${icon('shield-check')}</span>
        <div class="sec-hero-main">
          <div class="sec-title">Сквозное шифрование</div>
          <div class="sec-sub">Ключи хранятся только на устройствах участников. Сервер не видит открытый текст.</div>
          <span class="status-pill"><i></i>${chat.verified ? 'Ключи сверены' : 'Активно'}</span>
        </div>
      </div>
      <div class="fingerprint">
        <div class="fp-head">
          <span class="fp-label">Отпечаток ключа чата</span>
          <button class="icon-btn icon-btn--tiny" data-action="copy" data-copy="${fp}" aria-label="Скопировать отпечаток" title="Скопировать">${icon('copy')}</button>
        </div>
        <div class="fp-value">${fp}</div>
        <div class="fp-note">Сверьте отпечаток с собеседником, чтобы исключить подмену ключа.</div>
      </div>
      <div class="check-list">
        <div class="check-row">${icon('check')}<span>Файлы и превью шифруются до загрузки</span></div>
        <div class="check-row">${icon('check')}<span>Ключи хранятся в защищённом хранилище устройства</span></div>
        <div class="check-row is-warn">${icon('alert')}<span>Сервер видит метаданные: кто, когда и с кем</span></div>
      </div>
      <button class="btn btn--soft btn--block" style="margin-top:10px" data-action="verify">${icon('key')} Проверить ключи</button>`
    : `
      <div class="sec-hero is-managed">
        <span class="sec-hero-icon">${icon('shield')}</span>
        <div class="sec-hero-main">
          <div class="sec-title">Управляемый контур</div>
          <div class="sec-sub">TLS 1.3 и шифрование на сервере. DLP, поиск и аудит включены администратором.</div>
          <span class="status-pill"><i></i>DLP активен</span>
        </div>
      </div>
      <div class="fingerprint">
        <div class="fp-head"><span class="fp-label">Ключ пространства</span>${icon('key')}</div>
        <div class="fp-value">KMS · tenant-studio · rotated 12.11</div>
        <div class="fp-note">Доступ к ключу — только break-glass с двумя подтверждениями и записью в аудите.</div>
      </div>
      <div class="check-list">
        <div class="check-row">${icon('check')}<span>Шифрование на диске и в резервных копиях</span></div>
        <div class="check-row">${icon('check')}<span>Антивирусная проверка файлов и DLP-правила</span></div>
        <div class="check-row is-warn">${icon('alert')}<span>Администратор может экспортировать переписку по политике</span></div>
      </div>
      <button class="btn btn--soft btn--block" style="margin-top:10px" data-action="open-audit">${icon('clock')} Журнал аудита</button>`;

  return `
    ${hero}
    <div class="section-label">Устройства <span class="count">3</span></div>
    ${devicesHTML()}
    <button class="btn btn--ghost btn--block" style="margin-top:8px" data-action="toast" data-text="Управление устройствами — в полной версии">Управление устройствами</button>
    <div class="note-card">${icon('info')} ${e2ee
      ? 'Резервная копия ключей не включена. При потере всех устройств история будет недоступна — это цена приватности.'
      : 'Журнал хранится 12 месяцев и доступен для экспорта в SIEM. Политика хранения настраивается в админке.'}</div>`;
}

function renderDetails() {
  const chat = currentChat();
  if (!chat) return;
  $$('#details-tabs .dtab').forEach(tab => {
    const active = tab.dataset.tab === state.detailsTab;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  const body = $('#details-body');
  if (state.detailsTab === 'people') body.innerHTML = renderPeoplePanel(chat);
  else if (state.detailsTab === 'plugins') body.innerHTML = renderPluginsPanel(chat);
  else body.innerHTML = renderSecurityPanel(chat);
  body.scrollTop = 0;
}

/* ─────────── Рендер: композер ─────────── */
function renderComposerNote() {
  const chat = currentChat();
  if (!chat) return;
  const note = $('#composer-note');
  if (isE2EE(chat)) {
    note.classList.remove('is-managed');
    note.innerHTML = `${icon('lock')}<span>Сообщения защищены сквозным шифрованием</span>`;
  } else {
    note.classList.add('is-managed');
    note.innerHTML = `${icon('shield')}<span>Защищено серверным шифрованием · DLP включён</span>`;
  }
  const input = $('#message-input');
  input.placeholder = 'Написать сообщение…';
}

function renderPluginPop() {
  const chat = currentChat();
  const composerPlugins = new Set(['polls', 'tasks', 'translate']);
  const enabled = (chat?.plugins || [])
    .filter(id => composerPlugins.has(id))
    .map(id => PLUGIN_BY_ID[id])
    .filter(Boolean);
  const list = $('#plugin-pop-list');
  if (!enabled.length) {
    list.innerHTML = `<div class="pop-empty">В этом чате пока нет плагинов. Включите их в панели «Плагины».</div>`;
    return;
  }
  list.innerHTML = enabled.map(p => {
    const action = p.id === 'polls' ? 'create-poll' : p.id === 'tasks' ? 'create-task' : 'translate-last';
    const sub = p.id === 'polls' ? 'Собрать мнения в один клик' : p.id === 'tasks' ? 'Поставить задачу из чата' : 'Перевести последнее сообщение';
    return `
      <button class="pop-item" data-action="${action}">
        <span class="p-ico">${icon(p.icon)}</span>
        <span>${esc(p.name)}<small>${esc(sub)}</small></span>
      </button>`;
  }).join('');
}


/* ─────────── Стикеры ─────────── */
function stickerPacksForPicker() {
  const recent = state.recentStickerIds
    .map(id => STICKER_BY_ID[id])
    .filter(Boolean);
  return recent.length
    ? [{ id: 'recent', name: 'Недавние', stickers: recent }, ...STICKER_PACKS]
    : [...STICKER_PACKS];
}

function renderStickerPicker() {
  const packs = stickerPacksForPicker();
  if (!packs.some(pack => pack.id === state.stickerPack)) state.stickerPack = packs[0]?.id;
  const active = packs.find(pack => pack.id === state.stickerPack) || packs[0];

  $('#sticker-tabs').innerHTML = packs.map(pack => `
    <button class="sticker-tab ${pack.id === active?.id ? 'is-active' : ''}" role="tab"
      aria-selected="${pack.id === active?.id}" data-action="sticker-pack" data-pack="${pack.id}">${esc(pack.name)}</button>`).join('');

  $('#sticker-grid').innerHTML = (active?.stickers || []).map(sticker => `
    <button class="sticker-btn" data-action="send-sticker" data-sticker="${sticker.id}"
      title="${esc(sticker.label)}" aria-label="Отправить стикер: ${esc(sticker.label)}">${sticker.emoji}</button>`).join('');

  const count = active?.stickers.length || 0;
  $('#sticker-pack-caption').textContent = `${active?.name || 'Стикеры'} · ${count} ${plural(count, ['стикер', 'стикера', 'стикеров'])}`;
}

function closeStickers() {
  const pop = $('#sticker-pop');
  if (pop) pop.hidden = true;
  $('[data-action="toggle-stickers"]')?.classList.remove('is-active');
}

function toggleStickers() {
  const pop = $('#sticker-pop');
  const willOpen = pop.hidden;
  pop.hidden = !willOpen;
  $('[data-action="toggle-stickers"]')?.classList.toggle('is-active', willOpen);
  if (willOpen) {
    closeEmoji();
    closePluginPop();
    closeWsMenu();
    renderStickerPicker();
  }
}

function sendSticker(id) {
  const sticker = STICKER_BY_ID[id];
  const chat = currentChat();
  if (!sticker || !chat) return;
  const msg = {
    id: uid(), author: 'me', date: 'Сегодня', time: nowTime(),
    sticker: { id: sticker.id, emoji: sticker.emoji, label: sticker.label, pack: sticker.pack }
  };
  chat.messages.push(msg);
  updateChatPreview(chat, msg);
  state.recentStickerIds = [id, ...state.recentStickerIds.filter(value => value !== id)].slice(0, 8);
  closeStickers();
  renderMessages(true);
  renderChatList();
  toast(`Стикер «${sticker.label}» отправлен`);
}

/* ─────────── Общий рендер ─────────── */
function applyLayout() {
  const app = $('#app');
  app.classList.toggle('sidebar-open', state.sidebarOpen);
  app.classList.toggle('details-open', state.detailsOpen);
  app.classList.toggle('details-closed', !state.detailsOpen);
  $('#details-toggle')?.classList.toggle('is-active', state.detailsOpen);
  const pop = $('#ws-pop');
  $('#brand')?.setAttribute('aria-expanded', String(!pop.hidden));
  $('#brand-chevron')?.classList.toggle('is-open', !pop.hidden);
}

function renderChat(options = {}) {
  const chat = currentChat();
  if (!chat) return;
  if (state.chatId !== chat.id) state.chatId = chat.id;
  renderHeader();
  renderPinned();
  renderMessages(options.scroll !== false);
  renderComposerNote();
  renderDetails();
  renderChatList();
  renderWorkspace();
  applyLayout();
  updateComposerState();
  document.title = `${chat.name} · Сова`;
}

function selectChat(id) {
  const chat = chats.find(c => c.id === id);
  if (!chat) return;
  state.chatId = chat.id;
  state.replyTo = null;
  hideReplyBar();
  chat.unread = 0;
  state.sidebarOpen = false;
  closeEmoji();
  closePluginPop();
  closeStickers();
  renderChat();
}

function switchWorkspace(id) {
  if (!WORKSPACES.some(w => w.id === id)) return;
  state.wsId = id;
  state.filter = 'all';
  state.query = '';
  state.replyTo = null;
  state.detailsTab = 'people';
  $('#chat-search').value = '';
  hideReplyBar();
  const first = chatsFor(id)[0];
  state.chatId = first ? first.id : null;
  if (first) first.unread = 0;
  closeWsMenu();
  closeStickers();
  state.sidebarOpen = false;
  renderChat();
  toast(`Пространство «${currentWs().name}»`);
}

/* ─────────── Композер ─────────── */
function autosizeInput() {
  const el = $('#message-input');
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
}

function updateComposerState() {
  const input = $('#message-input');
  if (!input) return;
  const len = input.value.trim().length;
  $('#send-btn').disabled = len === 0;
  $('#char-count').textContent = len > 600 ? `${len} / 8000` : '';
}

function showReplyBar() {
  const bar = $('#reply-bar');
  if (!state.replyTo) { bar.hidden = true; return; }
  bar.hidden = false;
  $('#reply-label').textContent = `Ответ · ${state.replyTo.author}`;
  $('#reply-text').textContent = state.replyTo.text;
}

function hideReplyBar() {
  $('#reply-bar').hidden = true;
}

function setReply(msg) {
  state.replyTo = {
    author: msg.author === 'me' ? 'Вы' : persona(msg.author).name,
    text: previewText(msg).slice(0, 110)
  };
  showReplyBar();
  $('#message-input').focus();
}

function sendMessage() {
  const input = $('#message-input');
  const text = input.value.trim();
  if (!text) return;
  const chat = currentChat();
  const msg = {
    id: uid(), author: 'me', date: 'Сегодня', time: nowTime(), text,
    ...(state.replyTo ? { reply: { ...state.replyTo } } : {})
  };
  chat.messages.push(msg);
  updateChatPreview(chat, msg);
  state.replyTo = null;
  hideReplyBar();
  input.value = '';
  autosizeInput();
  updateComposerState();
  closeEmoji();
  closePluginPop();
  closeStickers();
  renderMessages(true);
  renderChatList();
  simulateReply(chat);
}

function simulateReply(chat) {
  if (pendingReplies.has(chat.id)) return;
  const candidates = chat.members.map(m => m.id).filter(id => id !== 'me' && PEOPLE[id]);
  if (!candidates.length) return;
  const lastIncoming = [...chat.messages].reverse().find(m => !m.system && m.author !== 'me');
  const responder = lastIncoming && candidates.includes(lastIncoming.author) ? lastIncoming.author : candidates[0];
  const pools = {
    studio: [
      'Принято, посмотрю после обеда.',
      'Согласен. Давай зафиксируем это в задаче.',
      'Спасибо! Обновлю документ и пришлю.',
      'Ок, я в контексте 👍',
      'Хорошая мысль. Добавлю в повестку демо.'
    ],
    family: [
      'Хорошо, солнышко ❤️',
      'Договорились!',
      'Я тоже так думаю 😊',
      'Не забудь про угли 😄',
      'Обнимаю!'
    ]
  };
  const pool = pools[chat.ws] || pools.studio;
  const text = pool[(lastReplyAt++) % pool.length];
  pendingReplies.add(chat.id);

  setTimeout(() => {
    if (chat.id === state.chatId) {
      state.typing = { chatId: chat.id, author: responder };
      renderMessages(true);
    }
  }, 700);

  setTimeout(() => {
    const msg = { id: uid(), author: responder, date: 'Сегодня', time: nowTime(), text, fresh: true };
    chat.messages.push(msg);
    state.typing = null;
    pendingReplies.delete(chat.id);
    updateChatPreview(chat, msg);
    if (chat.id === state.chatId) {
      renderMessages(true);
    } else {
      chat.unread += 1;
    }
    renderChatList();
  }, 2800);
}

/* ─────────── Вложения ─────────── */
function attachFile(file) {
  const chat = currentChat();
  if (!chat) return;
  if (file.size > MAX_FILE_BYTES) {
    const plan = planFileLimit();
    toast(`«${file.name}» — ${formatBytes(file.size)}. В демо лимит ${MAX_FILE_MB} МБ; на ${plan.name} — ${plan.label}.`, 'warn');
    return;
  }
  const msg = {
    id: uid(), author: 'me', date: 'Сегодня', time: nowTime(),
    file: { name: file.name, size: formatBytes(file.size) },
    uploading: true, progress: 0
  };
  chat.messages.push(msg);
  updateChatPreview(chat, msg);
  renderMessages(true);
  renderChatList();

  const timer = setInterval(() => {
    msg.progress = Math.min(100, (msg.progress || 0) + 7 + Math.floor(Math.random() * 9));
    const card = document.querySelector(`[data-upload="${msg.id}"]`);
    if (card) {
      const fill = card.querySelector('.upload-fill');
      const pct = card.querySelector('.upload-pct');
      if (fill) fill.style.width = `${msg.progress}%`;
      if (pct) pct.textContent = `${msg.progress}%`;
    }
    if (msg.progress >= 100) {
      clearInterval(timer);
      uploadTimers.delete(msg.id);
      msg.uploading = false;
      msg.fresh = true;
      if (chat.id === state.chatId) renderMessages(true);
      renderChatList();
      toast(isE2EE(chat) ? 'Файл зашифрован на устройстве и отправлен' : 'Файл загружен и проверен антивирусом');
    }
  }, 180);
  uploadTimers.set(msg.id, timer);
}

/* ─────────── Реакции, опросы, задачи ─────────── */
function toggleReaction(msg, emoji, forceAdd = false) {
  msg.reactions = msg.reactions || [];
  const existing = msg.reactions.find(r => r.emoji === emoji);
  if (!existing) {
    msg.reactions.push({ emoji, count: 1, me: true });
  } else if (existing.me && !forceAdd) {
    existing.me = false;
    existing.count -= 1;
    if (existing.count <= 0) msg.reactions = msg.reactions.filter(r => r !== existing);
  } else if (!existing.me) {
    existing.me = true;
    existing.count += 1;
  }
  renderMessages(false);
}

function votePoll(msg, index) {
  const poll = msg.poll;
  if (!poll) return;
  if (poll.votedIndex === index) {
    poll.options[index].votes = Math.max(0, poll.options[index].votes - 1);
    poll.votedIndex = null;
    toast('Голос отозван');
  } else {
    if (poll.votedIndex !== null) {
      poll.options[poll.votedIndex].votes = Math.max(0, poll.options[poll.votedIndex].votes - 1);
    }
    poll.options[index].votes += 1;
    poll.votedIndex = index;
    toast('Голос учтён · результаты обновлены');
  }
  renderMessages(false);
}

/* ─────────── Модальные окна ─────────── */
function openModal(html) {
  const root = $('#modal-root');
  root.innerHTML = html;
  root.hidden = false;
  closeWsMenu();
  closeEmoji();
  closePluginPop();
  closeStickers();
  const focusable = root.querySelector('input:not([type="checkbox"]), textarea, select');
  if (focusable) setTimeout(() => focusable.focus(), 40);
}

function closeModal() {
  $('#modal-root').hidden = true;
  $('#modal-root').innerHTML = '';
}

function modalHeader(title, sub) {
  return `
    <div class="modal-head">
      <div class="modal-title-wrap">
        <div class="modal-title">${esc(title)}</div>
        ${sub ? `<div class="modal-sub">${sub}</div>` : ''}
      </div>
      <button class="icon-btn modal-close" data-action="close-modal" aria-label="Закрыть">${icon('x')}</button>
    </div>`;
}

function groupFormHTML() {
  const people = workspacePeople(state.wsId);
  return `
    <form id="group-form">
      <div class="field">
        <label for="group-name">Название</label>
        <input class="input" id="group-name" name="name" maxlength="60" placeholder="Например, «Запуск продукта»" autocomplete="off" required />
      </div>
      <div class="field">
        <label for="group-topic">Описание <span style="color:var(--faint);font-weight:400">— необязательно</span></label>
        <input class="input" id="group-topic" name="topic" maxlength="120" placeholder="О чём этот чат" autocomplete="off" />
      </div>
      <div class="field">
        <label>Участники</label>
        <div class="member-pick">${people.map((p, i) => `
          <label class="pick-row">
            <span class="avatar ${p.av}">${esc(p.short)}${p.online ? '<span class="presence is-online"></span>' : ''}</span>
            <span class="pick-text"><span class="pick-name">${esc(p.name)}</span><span class="pick-sub">${esc(p.title || p.status)}</span></span>
            <input type="checkbox" name="members" value="${p.id}" ${i < 2 ? 'checked' : ''} />
          </label>`).join('')}</div>
      </div>
      <div class="mode-hint">
        ${icon(isE2EE({ ws: state.wsId }) ? 'lock' : 'shield')}
        <span>${isE2EE({ ws: state.wsId })
          ? '<b>Конфиденциальное пространство.</b> Новый чат получит сквозное шифрование. История не будет доступна администратору.'
          : '<b>Управляемое пространство.</b> Чат получит серверное шифрование, DLP и запись действий в аудит.'}</span>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn--ghost" data-action="close-modal">Отмена</button>
        <button type="submit" class="btn btn--primary">Создать группу</button>
      </div>
    </form>`;
}

function openNewChatModal() {
  openModal(`
    <div class="modal" role="dialog" aria-modal="true" aria-label="Новый чат">
      ${modalHeader('Новый чат', 'Создайте группу или напишите человеку напрямую')}
      <div class="modal-body">
        <div class="segmented" id="new-chat-tabs">
          <button type="button" class="is-active" data-action="new-chat-tab" data-tab="group">Группа</button>
          <button type="button" data-action="new-chat-tab" data-tab="dm">Личный чат</button>
        </div>
        <div id="new-chat-body">${groupFormHTML()}</div>
      </div>
    </div>`);
}

function renderNewChatBody(tab) {
  $$('#new-chat-tabs button').forEach(b => b.classList.toggle('is-active', b.dataset.tab === tab));
  const body = $('#new-chat-body');
  if (!body) return;
  if (tab === 'group') {
    body.innerHTML = groupFormHTML();
    setTimeout(() => $('#group-name')?.focus(), 30);
  } else {
    const people = workspacePeople(state.wsId);
    body.innerHTML = `
      <div class="member-pick" style="max-height:340px">
        ${people.map(p => {
          const existing = chats.find(c => c.ws === state.wsId && c.type === 'dm' && c.members.some(m => m.id === p.id));
          return `
            <button type="button" class="pick-row" data-action="open-dm" data-id="${p.id}" style="border:0;background:transparent;width:100%;text-align:left">
              <span class="avatar ${p.av}">${esc(p.short)}${p.online ? '<span class="presence is-online"></span>' : ''}</span>
              <span class="pick-text"><span class="pick-name">${esc(p.name)}</span><span class="pick-sub">${p.online ? 'В сети' : esc(p.status)}</span></span>
              <span class="icon-btn icon-btn--tiny" style="pointer-events:none">${icon(existing ? 'chevron-right' : 'plus')}</span>
            </button>`;
        }).join('')}
      </div>
      <div class="note-card" style="margin-top:10px">${icon('lock')} Личная переписка наследует режим безопасности пространства.</div>`;
  }
}

function openDm(personId) {
  const existing = chats.find(c => c.ws === state.wsId && c.type === 'dm' && c.members.some(m => m.id === personId));
  closeModal();
  if (existing) { selectChat(existing.id); return; }
  const p = persona(personId);
  const chat = {
    id: `dm-${personId}-${Date.now()}`, ws: state.wsId, type: 'dm', name: p.name,
    avatarText: p.short, av: p.av, unread: 0, muted: false, time: nowTime(),
    preview: 'Личная переписка', members: [{ id: 'me', role: 'Участник' }, { id: personId, role: 'Участник' }],
    plugins: [], messages: [
      { id: uid(), system: true, date: 'Сегодня', time: nowTime(), text: `Это начало вашей переписки с ${p.name}` }
    ]
  };
  chats.push(chat);
  state.chatId = chat.id;
  state.detailsTab = 'people';
  renderChat();
  toast(`Личный чат с ${p.name.split(' ')[0]} создан`);
}

function createGroup(form) {
  const data = new FormData(form);
  const name = String(data.get('name') || '').trim();
  const topic = String(data.get('topic') || '').trim();
  if (!name) { toast('Дайте группе название', 'warn'); return; }
  const selected = data.getAll('members');
  const av = avatarFor(name);
  const id = `group-${Date.now()}`;
  const chat = {
    id, ws: state.wsId, type: 'group', name, avatarText: initials(name), av,
    unread: 0, muted: false, time: nowTime(), preview: 'Группа создана · пригласите участников',
    members: [{ id: 'me', role: 'Владелец' }, ...selected.map(pid => ({ id: pid, role: 'Участник' }))],
    plugins: [],
    messages: [
      { id: uid(), system: true, date: 'Сегодня', time: nowTime(), text: `Вы создали группу «${name}»${topic ? ` · ${topic}` : ''}` }
    ]
  };
  chats.push(chat);
  closeModal();
  state.chatId = id;
  state.detailsTab = 'people';
  renderChat();
  toast('Группа создана. Пригласите участников по ссылке.');
}

/* ─────────── Каталог плагинов ─────────── */
function openPluginsModal() {
  const ws = currentWs();
  const e2eeWs = ws.mode === 'e2ee';
  const cards = PLUGINS.map(p => {
    const installed = ws.installed.includes(p.id);
    const unavailable = p.managedOnly && e2eeWs;
    return `
      <div class="p-card">
        <span class="plugin-ico ${p.color}">${icon(p.icon)}</span>
        <div class="plugin-main">
          <div class="plugin-name">${esc(p.name)}${p.enterprise ? ' <span class="chip chip--amber">ENT</span>' : ''}</div>
          <div class="p-author">${esc(p.author)} · v${esc(p.version)}</div>
          <div class="plugin-desc">${esc(p.desc)}</div>
          <div class="plugin-perms">${p.perms.map(perm => `<span class="perm">${esc(perm)}</span>`).join('')}</div>
        </div>
        <div class="p-card-side">
          ${installed
            ? `<span class="p-installed">${icon('check')} Установлено</span>`
            : `<button class="btn btn--soft btn--sm" data-action="install-plugin" data-id="${p.id}" ${unavailable ? 'disabled' : ''}>${unavailable ? 'Недоступно' : 'Установить'}</button>`}
        </div>
      </div>`;
  }).join('');

  openModal(`
    <div class="modal modal--wide" role="dialog" aria-modal="true" aria-label="Каталог плагинов">
      ${modalHeader('Каталог плагинов', `Расширения для пространства «${esc(ws.name)}». Установка — только администратором.`)}
      <div class="modal-body">
        <div class="plugin-cards">${cards}</div>
        <div class="note-card">${icon('shield')} Плагины работают в песочнице и получают только заявленные права. ${e2eeWs
          ? 'В конфиденциальном пространстве серверные коннекторы недоступны — только клиентские плагины с согласием пользователя.'
          : 'Действия плагинов журналируются, администратор может отключить их в любой момент.'}</div>
      </div>
    </div>`);
}

function installPlugin(id) {
  const plugin = PLUGIN_BY_ID[id];
  const ws = currentWs();
  if (!plugin || ws.installed.includes(id)) return;
  if (plugin.managedOnly && ws.mode === 'e2ee') {
    toast('Этот плагин доступен только в управляемом контуре', 'warn');
    return;
  }
  ws.installed.push(id);
  renderDetails();
  openPluginsModal();
  toast(`Плагин «${plugin.name}» установлен. Включите его в нужном чате.`);
}

/* ─────────── Опрос и задача ─────────── */
function openPollModal() {
  closePluginPop();
  openModal(`
    <div class="modal" role="dialog" aria-modal="true" aria-label="Новый опрос">
      ${modalHeader('Новый опрос', 'Плагин «Опросы» · результат появится в чате')}
      <div class="modal-body">
        <form id="poll-form">
          <div class="field">
            <label for="poll-question">Вопрос</label>
            <input class="input" id="poll-question" name="question" maxlength="120" placeholder="Что обсудим?" required />
          </div>
          <div class="field">
            <label>Варианты ответа</label>
            <div id="poll-options" style="display:flex;flex-direction:column;gap:7px">
              <input class="input poll-option" name="option" placeholder="Вариант 1" maxlength="60" />
              <input class="input poll-option" name="option" placeholder="Вариант 2" maxlength="60" />
              <input class="input poll-option" name="option" placeholder="Вариант 3 — необязательно" maxlength="60" />
            </div>
            <button type="button" class="btn btn--ghost btn--sm" style="margin-top:7px" data-action="add-poll-option">${icon('plus')} Добавить вариант</button>
          </div>
          <div class="mode-hint">${icon('poll')} Один участник — один голос. Опрос будет доступен всем участникам чата.</div>
          <div class="modal-actions">
            <button type="button" class="btn btn--ghost" data-action="close-modal">Отмена</button>
            <button type="submit" class="btn btn--primary">Опубликовать опрос</button>
          </div>
        </form>
      </div>
    </div>`);
}

function createPoll(form) {
  const chat = currentChat();
  const question = String(new FormData(form).get('question') || '').trim();
  const options = $$('.poll-option', form).map(i => i.value.trim()).filter(Boolean);
  if (!question) { toast('Введите вопрос', 'warn'); return; }
  if (options.length < 2) { toast('Нужно минимум два варианта', 'warn'); return; }
  const msg = {
    id: uid(), author: 'me', date: 'Сегодня', time: nowTime(),
    poll: {
      question,
      options: options.map(label => ({ label, votes: 0 })),
      votedIndex: null,
      deadline: 'новый опрос'
    }
  };
  chat.messages.push(msg);
  updateChatPreview(chat, msg);
  closeModal();
  renderMessages(true);
  renderChatList();
  toast('Опрос опубликован');
}

function openTaskModal() {
  closePluginPop();
  const chat = currentChat();
  const options = chat.members.map(m => `<option value="${m.id}" ${m.id === 'me' ? 'selected' : ''}>${esc(persona(m.id).name)}</option>`).join('');
  const due = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  openModal(`
    <div class="modal" role="dialog" aria-modal="true" aria-label="Новая задача">
      ${modalHeader('Новая задача', 'Плагин «Задачи» · появится в чате и в панели')}
      <div class="modal-body">
        <form id="task-form">
          <div class="field">
            <label for="task-title">Что нужно сделать</label>
            <input class="input" id="task-title" name="title" maxlength="120" placeholder="Например, «Подготовить демо к четвергу»" required />
          </div>
          <div class="field-row">
            <div class="field">
              <label for="task-assignee">Исполнитель</label>
              <select class="select" id="task-assignee" name="assignee">${options}</select>
            </div>
            <div class="field">
              <label for="task-due">Срок</label>
              <input class="input" id="task-due" name="due" type="date" value="${due}" />
            </div>
          </div>
          <div class="field">
            <label for="task-priority">Приоритет</label>
            <select class="select" id="task-priority" name="priority">
              <option value="">Без приоритета</option>
              <option value="важно">Важно</option>
              <option value="срочно">Срочно</option>
            </select>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn--ghost" data-action="close-modal">Отмена</button>
            <button type="submit" class="btn btn--primary">Создать задачу</button>
          </div>
        </form>
      </div>
    </div>`);
}

function createTask(form) {
  const chat = currentChat();
  const data = new FormData(form);
  const title = String(data.get('title') || '').trim();
  if (!title) { toast('Введите название задачи', 'warn'); return; }
  const rawDue = String(data.get('due') || '');
  const due = rawDue ? rawDue.split('-').reverse().slice(0, 2).join('.') : 'без срока';
  const msg = {
    id: uid(), author: 'me', date: 'Сегодня', time: nowTime(),
    task: { title, assignee: String(data.get('assignee') || 'me'), due, priority: String(data.get('priority') || ''), done: false }
  };
  chat.messages.push(msg);
  updateChatPreview(chat, msg);
  closeModal();
  renderMessages(true);
  renderChatList();
  toast('Задача создана и добавлена в чат');
}

/* ─────────── Поиск ─────────── */
function snippet(text, q) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(text.slice(0, 110));
  const start = Math.max(0, i - 34);
  const end = Math.min(text.length, i + q.length + 56);
  return `${start > 0 ? '…' : ''}${esc(text.slice(start, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length, end))}${end < text.length ? '…' : ''}`;
}

function openSearchModal() {
  const chat = currentChat();
  openModal(`
    <div class="modal" role="dialog" aria-modal="true" aria-label="Поиск в чате">
      ${modalHeader('Поиск в чате', `«${esc(chat.name)}» · ${isE2EE(chat) ? 'локальный индекс на устройстве' : 'поиск по серверу'}`)}
      <div class="modal-body">
        <div class="search-field">
          ${icon('search')}
          <input class="input" id="modal-search" placeholder="Слово, файл или фраза…" autocomplete="off" />
        </div>
        <div class="search-results" id="search-results">
          <div class="search-hint">${icon('search')} Начните вводить запрос — поиск идёт по этому чату.</div>
        </div>
      </div>
    </div>`);
}

function renderSearchResults(q) {
  const box = $('#search-results');
  if (!box) return;
  const chat = currentChat();
  const query = String(q || '').trim();
  if (!query) {
    box.innerHTML = `<div class="search-hint">${icon('search')} Начните вводить запрос — поиск идёт по этому чату.</div>`;
    return;
  }
  const matches = chat.messages.filter(m => !m.system && (
    (m.text && m.text.toLowerCase().includes(query.toLowerCase())) ||
    (m.file && m.file.name.toLowerCase().includes(query.toLowerCase())) ||
    (m.poll && m.poll.question.toLowerCase().includes(query.toLowerCase())) ||
    (m.image?.caption && m.image.caption.toLowerCase().includes(query.toLowerCase())) ||
    (m.task && m.task.title.toLowerCase().includes(query.toLowerCase()))
  )).slice(-8).reverse();

  if (!matches.length) {
    box.innerHTML = `<div class="search-hint">Ничего не найдено. Попробуйте другое слово.</div>`;
    return;
  }
  box.innerHTML = matches.map(m => {
    const p = persona(m.author);
    const raw = m.text || m.file?.name || m.poll?.question || m.image?.caption || m.task?.title || '';
    return `
      <button class="search-result" data-action="go-to-message" data-id="${m.id}">
        <span class="avatar avatar--xs ${p.av}">${esc(p.short)}</span>
        <span class="sr-main">
          <span class="sr-top">${esc(p.name)} · ${esc(m.date)}, ${esc(m.time)}</span>
          <span class="sr-text">${snippet(raw, query)}</span>
        </span>
      </button>`;
  }).join('');
}

/* ─────────── Проверка ключей / аудит / файлы ─────────── */
function qrMarkup(seed) {
  let h = hashString(seed);
  const cells = [];
  const finder = (r, c, top, left) => {
    const dr = r - top, dc = c - left;
    if (dr < 0 || dr > 6 || dc < 0 || dc > 6) return null;
    if (dr === 0 || dr === 6 || dc === 0 || dc === 6) return true;
    if (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4) return true;
    return false;
  };
  for (let r = 0; r < 21; r++) {
    for (let c = 0; c < 21; c++) {
      const f = finder(r, c, 0, 0) ?? finder(r, c, 0, 14) ?? finder(r, c, 14, 0);
      let on;
      if (f !== null) {
        on = f;
      } else {
        h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
        on = ((h >>> 18) & 1) === 1;
      }
      cells.push(`<i style="background:${on ? '#141917' : 'transparent'}"></i>`);
    }
  }
  return cells.join('');
}

function openVerifyModal() {
  const chat = currentChat();
  const other = chat.type === 'dm' ? persona(chat.members.find(m => m.id !== 'me')?.id) : null;
  const nums = safetyNumber(chat.id);
  openModal(`
    <div class="modal modal--narrow" role="dialog" aria-modal="true" aria-label="Проверка ключей">
      ${modalHeader('Проверка ключей', 'Сравните отпечаток с собеседником по другому каналу')}
      <div class="modal-body">
        <div class="verify-box">
          <div class="qr" aria-hidden="true">${qrMarkup(chat.id)}</div>
          <div class="safety-number">${nums.map(n => `<span>${n}</span>`).join('')}</div>
          <p class="verify-caption">Откройте «Защита → Проверить ключи» на устройстве собеседника и сравните номер. Если номера совпадают, канал защищён от подмены ключа.</p>
          <div class="verify-actions">
            <button class="btn btn--ghost" data-action="verify-fail">Не совпадает</button>
            <button class="btn btn--primary" data-action="verify-ok">Совпадает</button>
          </div>
        </div>
        <div class="note-card">${icon('info')} QR-код и номер сгенерированы для демонстрации. В продукте — на основе реальных ключей устройств.</div>
      </div>
    </div>`);
}

function openAuditModal() {
  const rows = [
    ['12:38', 'Анна Ким', 'Добавила участника Тимура Ахметова · роль «Гость»', '10.0.12.44'],
    ['12:20', 'Дмитрий Крылов', 'Включил плагин «Задачи» в чате «Проект Атлас»', '10.0.12.18'],
    ['11:02', 'Система', 'Ротация ключа пространства · KMS rotate', '—'],
    ['09:41', 'Игорь Власов', 'Экспорт журнала аудита за октябрь · CSV', '10.0.12.31'],
    ['09:14', 'Мария Соколова', 'Вход с нового устройства · Chrome / Windows', '95.24.18.7'],
    ['Вчера 18:40', 'Анна Ким', 'Сменила роль Лены Орловой: «Участник» → «Модератор»', '10.0.12.44']
  ];
  openModal(`
    <div class="modal modal--wide" role="dialog" aria-modal="true" aria-label="Журнал аудита">
      ${modalHeader('Журнал аудита', `«${esc(currentWs().name)}» · управляемый контур · хранение 12 месяцев`)}
      <div class="modal-body">
        <table class="audit-table">
          <thead><tr><th>Время</th><th>Событие</th><th>IP</th></tr></thead>
          <tbody>
            ${rows.map(r => `<tr><td>${r[0]}</td><td><span class="audit-actor">${esc(r[1])}</span><br /><span class="audit-action">${esc(r[2])}</span></td><td><span class="audit-ip">${esc(r[3])}</span></td></tr>`).join('')}
          </tbody>
        </table>
        <div class="note-card">${icon('shield')} Журнал защищён от изменения (hash chain) и может выгружаться в SIEM. Break-glass доступ требует двух подтверждений.</div>
        <div class="modal-actions">
          <button class="btn btn--ghost" data-action="toast" data-text="Экспорт CSV начнётся в полной версии">${icon('download')} Экспорт CSV</button>
          <button class="btn btn--primary" data-action="close-modal">Готово</button>
        </div>
      </div>
    </div>`);
}

function planFileLimit() {
  return currentWs().mode === 'e2ee'
    ? { name: 'Family', label: '1 ГБ' }
    : { name: 'Team', label: '2 ГБ' };
}

function openFilesModal() {
  const wsChats = chatsFor(state.wsId);
  const planLimit = planFileLimit();
  const items = [];
  wsChats.forEach(chat => {
    chat.messages.forEach(m => {
      if (m.file) items.push({ type: 'file', name: m.file.name, meta: `${m.file.size} · ${chat.name}`, chat: chat.id });
      if (m.image) items.push({ type: 'image', name: m.image.alt || 'Изображение', meta: `Фото · ${chat.name}`, src: m.image.src, chat: chat.id });
    });
  });
  items.push(
    { type: 'file', name: 'brand-book-2026.pdf', meta: '4,1 МБ · Дизайн-система' },
    { type: 'file', name: 'roadmap-q4.xlsx', meta: '128 КБ · Проект «Атлас»' },
    { type: 'file', name: 'contract-final.pdf', meta: '780 КБ · Общий чат' }
  );

  openModal(`
    <div class="modal modal--files" role="dialog" aria-modal="true" aria-label="Файлы пространства">
      ${modalHeader('Файлы пространства', `${esc(currentWs().name)} · ${items.length} ${plural(items.length, ['вложение', 'вложения', 'вложений'])} · демо-лимит ${MAX_FILE_MB} МБ на файл`)}
      <div class="modal-body">
        <div class="file-limits">
          <div class="file-limit is-accent"><span>Демо-лимит</span><b>${MAX_FILE_MB} МБ</b></div>
          <div class="file-limit"><span>На ${planLimit.name}</span><b>${planLimit.label}</b></div>
          <div class="file-limit"><span>В сообщении</span><b>до ${MAX_FILES_PER_MESSAGE}</b></div>
        </div>
        <div class="note-card" style="margin:0 0 12px">${icon('info')} Лимит зависит от тарифа: Community — 200 МБ, Family — 1 ГБ, Team — 2 ГБ, Enterprise — до 10 ГБ. Стикеры — до 512 КБ. Квота — по тарифу: Family — 100 ГБ, Team — 1 ТБ.</div>
        <div class="file-grid">
          ${items.map(item => `
            <button class="file-tile" data-action="toast" data-text="Скачивание начнётся в полной версии">
              <span class="file-thumb">${item.type === 'image' ? `<img src="${item.src}" alt="" />` : icon('file')}</span>
              <span class="file-tile-name">${esc(item.name)}</span>
              <span class="file-tile-meta">${esc(item.meta)}</span>
            </button>`).join('')}
        </div>
        <div class="note-card">${icon('lock')} В конфиденциальных чатах файлы расшифровываются только на устройстве получателя. Сервер хранит зашифрованные блобы.</div>
      </div>
    </div>`);
}

/* ─────────── Тосты / копирование ─────────── */
function toast(text, kind = 'ok') {
  const stack = $('#toasts');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast ${kind === 'warn' ? 'is-warn' : ''}`;
  el.innerHTML = `${icon(kind === 'warn' ? 'alert' : 'check')}<span>${esc(text)}</span>`;
  stack.appendChild(el);
  while (stack.children.length > 3) stack.removeChild(stack.firstElementChild);
  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 200);
  }, 3800);
}

function copyText(text) {
  const done = () => toast('Скопировано в буфер обмена');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { toast('Не удалось скопировать', 'warn'); }
  ta.remove();
}

/* ─────────── Поповеры ─────────── */
function closeWsMenu() {
  const pop = $('#ws-pop');
  if (pop) pop.hidden = true;
  $('#brand-chevron')?.classList.remove('is-open');
  $('#brand')?.setAttribute('aria-expanded', 'false');
}

function toggleWsMenu() {
  const pop = $('#ws-pop');
  const willOpen = pop.hidden;
  pop.hidden = !willOpen;
  $('#brand-chevron')?.classList.toggle('is-open', willOpen);
  $('#brand')?.setAttribute('aria-expanded', String(willOpen));
  if (willOpen) { closeEmoji(); closePluginPop(); closeStickers(); }
}

function closeEmoji() {
  const pop = $('#emoji-pop');
  if (pop) pop.hidden = true;
  $('[data-action="toggle-emoji"]')?.classList.remove('is-active');
}

function closePluginPop() {
  const pop = $('#plugin-pop');
  if (pop) pop.hidden = true;
  $('[data-action="toggle-plugin-menu"]')?.classList.remove('is-active');
}

function toggleEmoji() {
  const pop = $('#emoji-pop');
  const open = pop.hidden;
  pop.hidden = !open;
  $('[data-action="toggle-emoji"]')?.classList.toggle('is-active', open);
  if (open) { closePluginPop(); closeStickers(); closeWsMenu(); }
}

function togglePluginPop() {
  const pop = $('#plugin-pop');
  const open = pop.hidden;
  pop.hidden = !open;
  $('[data-action="toggle-plugin-menu"]')?.classList.toggle('is-active', open);
  if (open) {
    closeEmoji();
    closeStickers();
    closeWsMenu();
    renderPluginPop();
  }
}

/* ─────────── Действия ─────────── */
function handleAction(action, el) {
  const chat = currentChat();
  switch (action) {
    case 'select-chat':
      selectChat(el.dataset.id);
      break;
    case 'switch-ws':
      switchWorkspace(el.dataset.id);
      break;
    case 'toggle-ws-menu':
      toggleWsMenu();
      break;
    case 'new-chat':
      openNewChatModal();
      break;
    case 'new-chat-tab':
      renderNewChatBody(el.dataset.tab);
      break;
    case 'open-dm':
      openDm(el.dataset.id);
      break;
    case 'filter':
      state.filter = el.dataset.filter;
      renderChatList();
      break;
    case 'details-tab':
      state.detailsTab = el.dataset.tab;
      renderDetails();
      break;
    case 'toggle-details':
      state.detailsOpen = !state.detailsOpen;
      state.sidebarOpen = false;
      applyLayout();
      break;
    case 'close-details':
      state.detailsOpen = false;
      applyLayout();
      break;
    case 'toggle-sidebar':
      state.sidebarOpen = true;
      applyLayout();
      break;
    case 'close-overlays':
      state.sidebarOpen = false;
      state.detailsOpen = false;
      applyLayout();
      break;
    case 'toggle-theme':
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('krug-theme', state.theme); } catch { /* приватный режим */ }
      applyTheme();
      break;
    case 'toggle-emoji':
      toggleEmoji();
      break;
    case 'toggle-stickers':
      toggleStickers();
      break;
    case 'sticker-pack':
      state.stickerPack = el.dataset.pack || 'recent';
      renderStickerPicker();
      break;
    case 'send-sticker':
      sendSticker(el.dataset.sticker);
      break;
    case 'insert-emoji': {
      const input = $('#message-input');
      const emoji = el.dataset.emoji || '';
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
      input.focus();
      input.selectionStart = input.selectionEnd = start + emoji.length;
      autosizeInput();
      updateComposerState();
      closeEmoji();
      break;
    }
    case 'toggle-plugin-menu':
      togglePluginPop();
      break;
    case 'attach':
      closeEmoji();
      closeStickers();
      closePluginPop();
      $('#file-input').click();
      break;
    case 'send':
      sendMessage();
      break;
    case 'reply':
      if (chat) {
        const msg = chat.messages.find(m => m.id === el.dataset.message);
        if (msg) setReply(msg);
      }
      break;
    case 'cancel-reply':
      state.replyTo = null;
      hideReplyBar();
      break;
    case 'quick-react': {
      const msg = chat?.messages.find(m => m.id === el.dataset.message);
      if (msg) toggleReaction(msg, '❤️', true);
      break;
    }
    case 'react': {
      const msg = chat?.messages.find(m => m.id === el.dataset.message);
      if (msg) toggleReaction(msg, el.dataset.emoji);
      break;
    }
    case 'vote': {
      const msg = chat?.messages.find(m => m.id === el.dataset.message);
      if (msg) votePoll(msg, Number(el.dataset.option));
      break;
    }
    case 'toggle-task': {
      const msg = chat?.messages.find(m => m.id === el.dataset.message);
      if (msg?.task) {
        msg.task.done = !msg.task.done;
        renderMessages(false);
        toast(msg.task.done ? 'Задача выполнена' : 'Задача возвращена в работу');
      }
      break;
    }
    case 'play-voice': {
      const wave = el.closest('.voice-card')?.querySelector('.wave');
      if (wave) {
        wave.classList.add('is-playing');
        setTimeout(() => wave.classList.remove('is-playing'), 3200);
      }
      break;
    }
    case 'open-plugins':
      openPluginsModal();
      break;
    case 'install-plugin':
      installPlugin(el.dataset.id);
      break;
    case 'open-files':
      openFilesModal();
      break;
    case 'open-security':
      state.detailsTab = 'security';
      state.detailsOpen = true;
      state.sidebarOpen = false;
      renderDetails();
      applyLayout();
      break;
    case 'open-audit':
      openAuditModal();
      break;
    case 'search-in-chat':
      openSearchModal();
      break;
    case 'go-to-message': {
      const id = el.dataset.id;
      closeModal();
      setTimeout(() => {
        const row = document.getElementById(`msg-${id}`);
        if (row) {
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          row.classList.add('is-flash');
          setTimeout(() => row.classList.remove('is-flash'), 1600);
        }
      }, 120);
      break;
    }
    case 'create-poll':
      openPollModal();
      break;
    case 'create-task':
      openTaskModal();
      break;
    case 'translate-last':
      closePluginPop();
      toast('Перевод на устройстве: «Сообщение уже переведено» (демо)');
      break;
    case 'add-poll-option': {
      const box = $('#poll-options');
      if (box && box.querySelectorAll('.poll-option').length < 6) {
        const input = document.createElement('input');
        input.className = 'input poll-option';
        input.name = 'option';
        input.maxLength = 60;
        input.placeholder = `Вариант ${box.querySelectorAll('.poll-option').length + 1}`;
        box.appendChild(input);
        input.focus();
      }
      break;
    }
    case 'verify':
      openVerifyModal();
      break;
    case 'verify-ok':
      if (chat) {
        chat.verified = true;
        closeModal();
        renderDetails();
        toast('Ключи сверены. Чат помечен как доверенный.');
      }
      break;
    case 'verify-fail':
      closeModal();
      toast('Ключи не совпали. Не отправляйте чувствительные данные и свяжитесь с собеседником.', 'warn');
      break;
    case 'close-pinned':
      if (chat) chat.pinnedClosed = true;
      renderPinned();
      break;
    case 'copy':
      copyText(el.dataset.copy || '');
      break;
    case 'toast':
      toast(el.dataset.text || 'Демо');
      break;
    case 'message-more':
      toast('Ещё: закрепить, переслать, удалить — в полной версии');
      break;
    case 'close-modal':
      closeModal();
      break;
    default:
      break;
  }
}

/* ─────────── Слушатели ─────────── */
document.addEventListener('click', e => {
  // Запоминаем попадания до обработки: часть DOM перерисовывается внутри action.
  const insideWs = Boolean(e.target.closest('#ws-pop'));
  const insideBrand = Boolean(e.target.closest('#brand'));
  const insideEmoji = Boolean(e.target.closest('#emoji-pop'));
  const insideSticker = Boolean(e.target.closest('#sticker-pop'));
  const insidePlugin = Boolean(e.target.closest('#plugin-pop'));
  const onEmojiToggle = Boolean(e.target.closest('[data-action="toggle-emoji"]'));
  const onStickerToggle = Boolean(e.target.closest('[data-action="toggle-stickers"]'));
  const onPluginToggle = Boolean(e.target.closest('[data-action="toggle-plugin-menu"]'));

  const actionEl = e.target.closest('[data-action]');
  if (actionEl) {
    if (actionEl.tagName === 'A') e.preventDefault();
    handleAction(actionEl.dataset.action, actionEl);
  }

  if (!insideWs && !insideBrand) closeWsMenu();
  if (!insideEmoji && !onEmojiToggle) closeEmoji();
  if (!insideSticker && !onStickerToggle) closeStickers();
  if (!insidePlugin && !onPluginToggle) closePluginPop();
});

$('#modal-root').addEventListener('click', e => {
  if (e.target === $('#modal-root')) closeModal();
});

document.addEventListener('input', e => {
  if (e.target.id === 'chat-search') {
    state.query = e.target.value;
    renderChatList();
  }
  if (e.target.id === 'message-input') {
    autosizeInput();
    updateComposerState();
  }
  if (e.target.id === 'modal-search') {
    renderSearchResults(e.target.value);
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!$('#modal-root').hidden) { closeModal(); return; }
    if (!$('#emoji-pop').hidden) { closeEmoji(); return; }
    if (!$('#sticker-pop').hidden) { closeStickers(); return; }
    if (!$('#plugin-pop').hidden) { closePluginPop(); return; }
    if (!$('#ws-pop').hidden) { closeWsMenu(); return; }
    if (state.sidebarOpen || (state.detailsOpen && window.innerWidth <= 1280)) {
      state.sidebarOpen = false;
      state.detailsOpen = false;
      applyLayout();
    }
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('#chat-search').focus();
    return;
  }
  if (e.target.id === 'message-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});

document.addEventListener('submit', e => {
  if (e.target.id === 'group-form') {
    e.preventDefault();
    createGroup(e.target);
  }
  if (e.target.id === 'poll-form') {
    e.preventDefault();
    createPoll(e.target);
  }
  if (e.target.id === 'task-form') {
    e.preventDefault();
    createTask(e.target);
  }
});

document.addEventListener('change', e => {
  if (e.target.matches('[data-role-select]')) {
    const chat = currentChat();
    const member = chat?.members.find(m => m.id === e.target.dataset.user);
    if (member && member.role !== 'Владелец') {
      member.role = e.target.value;
      renderDetails();
      toast(`${persona(member.id).name} — роль «${member.role}»`);
    }
  }
  if (e.target.matches('[data-plugin-switch]')) {
    const chat = currentChat();
    const id = e.target.dataset.plugin;
    if (!chat) return;
    if (e.target.checked) {
      if (!chat.plugins.includes(id)) chat.plugins.push(id);
      toast(`Плагин «${PLUGIN_BY_ID[id]?.name}» включён в чате`);
    } else {
      chat.plugins = chat.plugins.filter(p => p !== id);
      toast(`Плагин «${PLUGIN_BY_ID[id]?.name}» выключен в чате`);
    }
    renderDetails();
  }
});

$('#file-input').addEventListener('change', e => {
  const files = [...e.target.files];
  if (files.length > MAX_FILES_PER_MESSAGE) {
    toast(`Не больше ${MAX_FILES_PER_MESSAGE} файлов за раз. Выберите меньше — или отправьте ссылку.`, 'warn');
  } else {
    files.forEach(attachFile);
  }
  e.target.value = '';
});

/* ─────────── Инициализация ─────────── */
function init() {
  applyTheme();
  state.detailsOpen = window.innerWidth > 1280;
  if (!chats.some(c => c.id === state.chatId)) state.chatId = chatsFor(state.wsId)[0]?.id;
  renderChat();
  updateComposerState();
}

let wasWide = window.innerWidth > 1280;
window.addEventListener('resize', () => {
  const isWide = window.innerWidth > 1280;
  if (wasWide !== isWide) {
    state.detailsOpen = isWide;
    state.sidebarOpen = false;
    applyLayout();
    wasWide = isWide;
  }
});

init();

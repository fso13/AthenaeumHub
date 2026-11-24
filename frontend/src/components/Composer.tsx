import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { ApiMessage } from '../api/types';
import {
  findBotCommand,
  matchBotCommands,
  parseSlashCommand,
  slashCommandQuery,
  type BotCommandOption,
} from '../bots/commands';
import type { MentionMemberLike } from '../domain/mentions';
import { replyPreview } from '../domain/messages';
import { useMentionAutocomplete } from '../hooks/useMentionAutocomplete';
import { t } from '../i18n/ru';
import {
  CloseIcon,
  CodeBlockIcon,
  CodeIcon,
  BulletListIcon,
  EmojiIcon,
  NumberListIcon,
  LockIcon,
  MicIcon,
  PlusIcon,
  SendIcon,
  ShieldIcon,
  StickerIcon,
} from './Icons';
import { CommandPalette } from './bots/CommandPalette';
import { MentionPopover } from './MentionPopover';
import { MentionText } from './MentionText';

export type SendBlockedReason = 'offline' | 'rate_limit' | 'read_only' | 'e2ee_blocked' | null;
export type ComposerCommandStatus = 'idle' | 'sending' | 'accepted' | 'error';

interface ComposerProps {
  value: string;
  /** D1 UX fidelity 2: placeholder addresses the active chat by name. */
  chatName?: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
  sendBlockedReason: SendBlockedReason;
  rateLimitSeconds: number;
  replyTo: ApiMessage | null;
  /** E7-F5G P2-33: E2EE context; server reply text is never rendered. */
  e2eeChat?: boolean;
  /** Decrypted reply text for the E2EE reply bar (null = unavailable). */
  replyText?: string | null;
  onCancelReply: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** E4-F: ready attachments make text optional. */
  attachmentCount: number;
  attachDisabled: boolean;
  attachHint: string;
  onAttach: () => void;
  /** E5-F: sticker picker trigger. */
  stickersOpen: boolean;
  onToggleStickers: () => void;
  stickerButtonRef: RefObject<HTMLButtonElement | null>;
  /** D1-FE2: voice recording is managed-only and never auto-starts. */
  voiceButtonRef: RefObject<HTMLButtonElement | null>;
  voiceDisabled: boolean;
  voiceHint: string;
  voiceActive: boolean;
  onStartVoice: () => void;
  /** Inline RecordingBar; rendered only while a take is active. */
  voiceBar?: ReactNode;
  /** Managed-only @mention directory and lazy loader. */
  mentionMembers?: readonly MentionMemberLike[];
  mentionsEnabled?: boolean;
  /** #83: only chat OWNER/ADMIN get the `@all` broadcast candidate. */
  allowMentionAll?: boolean;
  mentionDirectoryLoading?: boolean;
  onMentionDirectoryNeeded?: () => void;
  /**
   * #98: slash commands registered by installed/enabled bots of the active
   * chat. Empty in E2EE/other chats, where a leading `/` stays ordinary text.
   */
  botCommands?: readonly BotCommandOption[];
  commandStatus?: ComposerCommandStatus;
  /** `202` acknowledgement text; no fake message is inserted anywhere. */
  commandNotice?: string | null;
  /** Honest failure copy (`404/409/422/429/...`). */
  commandErrorMessage?: string | null;
  onInvokeCommand?: (command: string, args: string) => void;
}

const MAX_LENGTH = 8000;
const COUNTER_VISIBLE_FROM = 1;
const COUNTER_WARN_FROM = 7600;
const EMOJI_GROUPS = {
  smileys: [
    '😀',
    '😃',
    '😄',
    '😁',
    '😆',
    '😅',
    '😂',
    '🤣',
    '😊',
    '😇',
    '🙂',
    '🙃',
    '😉',
    '😌',
    '😍',
    '🥰',
    '😘',
    '😗',
    '😙',
    '😚',
    '😋',
    '😛',
    '😝',
    '😜',
    '🤪',
    '🤨',
    '🧐',
    '🤓',
    '😎',
    '🥳',
    '😏',
    '😒',
    '😞',
    '😔',
    '😟',
    '😕',
    '🙁',
    '☹️',
    '😣',
    '😖',
    '😫',
    '😩',
    '🥺',
    '😢',
    '😭',
    '😤',
    '😠',
    '😡',
    '🤬',
    '🤯',
    '😳',
    '🥵',
    '🥶',
    '😱',
    '😨',
    '😰',
    '😥',
    '😓',
    '🤗',
    '🤔',
    '🤭',
    '🤫',
    '🤥',
    '😶',
    '😐',
    '😑',
    '😬',
    '🙄',
    '😯',
    '😦',
    '😧',
    '😮',
    '😲',
    '🥱',
    '😴',
    '🤤',
    '😪',
    '😵',
    '🤐',
    '🥴',
    '🤢',
    '🤮',
    '🤧',
    '😷',
    '🤒',
    '🤕',
  ],
  animals: [
    '🐶',
    '🐱',
    '🐭',
    '🐹',
    '🐰',
    '🦊',
    '🐻',
    '🐼',
    '🐨',
    '🐯',
    '🦁',
    '🐮',
    '🐷',
    '🐸',
    '🐵',
    '🐔',
    '🐧',
    '🐦',
    '🐤',
    '🦆',
    '🦅',
    '🦉',
    '🦇',
    '🐺',
    '🐗',
    '🐴',
    '🦄',
    '🐝',
    '🦋',
    '🐌',
    '🐞',
    '🐜',
    '🐢',
    '🐍',
    '🦎',
    '🦂',
    '🦀',
    '🦞',
    '🦐',
    '🦑',
    '🐙',
    '🐠',
    '🐟',
    '🐡',
    '🐬',
    '🐳',
    '🐋',
    '🦈',
    '🐊',
    '🐅',
    '🐆',
    '🦓',
    '🦍',
    '🐘',
    '🦛',
    '🦏',
    '🐪',
    '🐫',
    '🦒',
    '🦘',
    '🐃',
    '🐂',
    '🐄',
    '🐎',
    '🐖',
    '🐏',
    '🐑',
    '🦙',
    '🐐',
    '🦌',
    '🐕',
    '🐩',
    '🦮',
    '🐈',
    '🐓',
    '🦃',
    '🦚',
    '🦜',
    '🦢',
    '🦩',
    '🕊️',
    '🐇',
    '🦝',
    '🦨',
    '🦡',
    '🦦',
    '🦥',
    '🐁',
    '🐀',
    '🐿️',
    '🦔',
  ],
  food: [
    '🍏',
    '🍎',
    '🍐',
    '🍊',
    '🍋',
    '🍌',
    '🍉',
    '🍇',
    '🍓',
    '🫐',
    '🍈',
    '🍒',
    '🍑',
    '🥭',
    '🍍',
    '🥥',
    '🥝',
    '🍅',
    '🍆',
    '🥑',
    '🥦',
    '🥬',
    '🥒',
    '🌶️',
    '🫑',
    '🌽',
    '🥕',
    '🫒',
    '🧄',
    '🧅',
    '🥔',
    '🍠',
    '🥐',
    '🥯',
    '🍞',
    '🥖',
    '🥨',
    '🧇',
    '🥞',
    '🧈',
    '🍳',
    '🧀',
    '🥓',
    '🥩',
    '🍗',
    '🍖',
    '🌭',
    '🍔',
    '🍟',
    '🍕',
    '🥪',
    '🥙',
    '🧆',
    '🌮',
    '🌯',
    '🫔',
    '🥗',
    '🥘',
    '🫕',
    '🍝',
    '🍜',
    '🍲',
    '🍛',
    '🍣',
    '🍱',
    '🥟',
    '🦪',
    '🍤',
    '🍙',
    '🍚',
    '🍘',
    '🍥',
    '🥠',
    '🥮',
    '🍢',
    '🍡',
    '🍧',
    '🍨',
    '🍦',
    '🥧',
    '🧁',
    '🍰',
    '🎂',
    '🍮',
    '🍭',
    '🍬',
    '🍫',
    '🍿',
    '🍩',
    '🍪',
    '🌰',
    '🥜',
    '🍯',
    '🥛',
    '🍼',
    '☕',
    '🍵',
    '🧃',
    '🥤',
    '🧋',
    '🍶',
    '🍺',
    '🍻',
    '🥂',
    '🍷',
    '🥃',
    '🍸',
    '🍹',
    '🧉',
    '🍾',
  ],
  activity: [
    '⚽',
    '🏀',
    '🏈',
    '⚾',
    '🥎',
    '🎾',
    '🏐',
    '🏉',
    '🥏',
    '🎱',
    '🪀',
    '🏓',
    '🏸',
    '🏒',
    '🏑',
    '🥍',
    '🏏',
    '🪃',
    '🥅',
    '⛳',
    '🪁',
    '🏹',
    '🎣',
    '🤿',
    '🥊',
    '🥋',
    '🎽',
    '🛹',
    '🛼',
    '🛷',
    '🥌',
    '🎿',
    '⛸️',
    '🥁',
    '🪘',
    '🎷',
    '🎺',
    '🪗',
    '🎸',
    '🪕',
    '🎻',
    '🎲',
    '♟️',
    '🎯',
    '🎳',
    '🎮',
    '🎰',
    '🧩',
  ],
  travel: [
    '🚗',
    '🚕',
    '🚙',
    '🚌',
    '🚎',
    '🏎️',
    '🚓',
    '🚑',
    '🚒',
    '🚐',
    '🛻',
    '🚚',
    '🚛',
    '🚜',
    '🦯',
    '🦽',
    '🦼',
    '🛴',
    '🚲',
    '🛵',
    '🛺',
    '🚨',
    '🚔',
    '🚍',
    '🚘',
    '🚖',
    '🚡',
    '🚠',
    '🚟',
    '🚃',
    '🚋',
    '🚞',
    '🚝',
    '🚄',
    '🚅',
    '🚈',
    '🚂',
    '🚆',
    '🚇',
    '🚊',
    '🚉',
    '✈️',
    '🛫',
    '🛬',
    '🛩️',
    '💺',
    '🛰️',
    '🚀',
    '🛸',
    '🚁',
    '🛶',
    '⛵',
    '🚤',
    '🛥️',
    '🛳️',
    '⛴️',
    '🚢',
    '⚓',
    '🪝',
    '⛽',
    '🚧',
    '🚦',
    '🚥',
    '🚏',
    '🗺️',
    '🗿',
    '🗽',
    '🗼',
    '🏰',
    '🏯',
    '🏟️',
    '🎡',
    '🎢',
    '🎠',
    '⛲',
    '⛱️',
    '🏖️',
    '🏝️',
    '🏜️',
    '🌋',
    '⛰️',
    '🏔️',
    '🗻',
    '🏕️',
    '⛺',
  ],
  objects: [
    '⌚',
    '📱',
    '💻',
    '⌨️',
    '🖥️',
    '🖨️',
    '🖱️',
    '🖲️',
    '🕹️',
    '🗜️',
    '💽',
    '💾',
    '💿',
    '📀',
    '📼',
    '📷',
    '📸',
    '📹',
    '🎥',
    '📽️',
    '🎞️',
    '📞',
    '☎️',
    '📟',
    '📠',
    '📺',
    '📻',
    '🎙️',
    '🎚️',
    '🎛️',
    '🧭',
    '⏱️',
    '⏲️',
    '⏰',
    '🕰️',
    '⌛',
    '⏳',
    '📡',
    '🔋',
    '🪫',
    '🔌',
    '💡',
    '🔦',
    '🕯️',
    '🪔',
    '🧯',
    '🛢️',
    '💸',
    '💵',
    '💰',
    '🪙',
    '💳',
    '🧾',
    '💎',
    '⚖️',
    '🪜',
    '🧰',
    '🪛',
    '🔧',
    '🔨',
    '⚒️',
    '🛠️',
    '⛏️',
    '🔩',
    '⚙️',
    '🧱',
    '⛓️',
    '🧲',
    '🔫',
    '💣',
    '🧨',
    '🪓',
    '🔪',
    '🗡️',
    '⚔️',
    '🛡️',
    '🚬',
    '⚰️',
    '🪦',
    '⚱️',
    '🏺',
    '🔮',
    '📿',
    '🧿',
    '💈',
    '⚗️',
    '🔭',
    '🔬',
    '🕳️',
    '🩹',
    '🩺',
    '💊',
    '💉',
    '🩸',
    '🧬',
    '🦠',
    '🧫',
    '🧪',
    '🌡️',
    '🧹',
    '🧺',
    '🧻',
    '🚽',
    '🚰',
    '🚿',
    '🛁',
    '🛀',
    '🧼',
    '🪥',
    '🪒',
    '🧽',
    '🪣',
    '🧴',
  ],
  symbols: [
    '❤️',
    '🧡',
    '💛',
    '💚',
    '💙',
    '💜',
    '🖤',
    '🤍',
    '🤎',
    '💔',
    '❣️',
    '💕',
    '💞',
    '💓',
    '💗',
    '💖',
    '💘',
    '💝',
    '💟',
    '☮️',
    '✝️',
    '☪️',
    '🕉️',
    '☸️',
    '✡️',
    '🔯',
    '🕎',
    '☯️',
    '☦️',
    '🛐',
    '⛎',
    '♈',
    '♉',
    '♊',
    '♋',
    '♌',
    '♍',
    '♎',
    '♏',
    '♐',
    '♑',
    '♒',
    '♓',
    '🆔',
    '⚛️',
    '🉑',
    '☢️',
    '☣️',
    '📴',
    '📳',
    '🈶',
    '🈚',
    '🈸',
    '🈺',
    '🈷️',
    '✴️',
    '🆚',
    '💮',
    '🉐',
    '㊙️',
    '㊗️',
    '🈴',
    '🈵',
    '🈹',
    '🈲',
    '🅰️',
    '🅱️',
    '🆎',
    '🆑',
    '🅾️',
    '🆘',
    '❌',
    '⭕',
    '🛑',
    '⛔',
    '📛',
    '🚫',
    '💯',
    '💢',
    '♨️',
    '🚷',
    '🚯',
    '🚳',
    '🚱',
    '🔞',
    '📵',
    '🚭',
    '❗',
    '❕',
    '❓',
    '❔',
    '‼️',
    '⁉️',
    '🔅',
    '🔆',
    '〽️',
    '⚠️',
    '🚸',
    '🔱',
    '⚜️',
    '🔰',
    '♻️',
    '✅',
    '🈯',
    '💹',
    '❇️',
    '✳️',
    '❎',
    '🌐',
    '💠',
    'Ⓜ️',
    '🌀',
    '💤',
    '🏧',
    '🚾',
    '♿',
    '🅿️',
    '🈳',
    '🈂️',
  ],
  flags: [
    '🏳️',
    '🏴',
    '🏁',
    '🚩',
    '🏳️\u200d🌈',
    '🏳️\u200d⚧️',
    '🏴\u200d☠️',
    '🇷🇺',
    '🇺🇸',
    '🇬🇧',
    '🇩🇪',
    '🇫🇷',
    '🇮🇹',
    '🇪🇸',
    '🇵🇹',
    '🇳🇱',
    '🇧🇪',
    '🇨🇭',
    '🇦🇹',
    '🇸🇪',
    '🇳🇴',
    '🇩🇰',
    '🇫🇮',
    '🇵🇱',
    '🇨🇿',
    '🇺🇦',
    '🇹🇷',
    '🇬🇷',
    '🇮🇱',
    '🇮🇳',
    '🇨🇳',
    '🇯🇵',
    '🇰🇷',
    '🇦🇺',
    '🇨🇦',
    '🇧🇷',
    '🇦🇷',
    '🇲🇽',
    '🇿🇦',
    '🇪🇬',
  ],
} as const;
type EmojiCategory = keyof typeof EMOJI_GROUPS;
const EMOJI_CATEGORIES: readonly EmojiCategory[] = [
  'smileys',
  'animals',
  'food',
  'activity',
  'travel',
  'objects',
  'symbols',
  'flags',
];
const EMOJI_CATEGORY_LABEL: Record<EmojiCategory, string> = {
  smileys: 'Смайлы',
  animals: 'Животные и природа',
  food: 'Еда и напитки',
  activity: 'Активность',
  travel: 'Путешествия и места',
  objects: 'Предметы',
  symbols: 'Символы',
  flags: 'Флаги',
};
const NO_MENTION_MEMBERS: readonly MentionMemberLike[] = [];
const NO_BOT_COMMANDS: readonly BotCommandOption[] = [];

export function Composer({
  value,
  chatName,
  onChange,
  onSend,
  disabled,
  sendBlockedReason,
  rateLimitSeconds,
  replyTo,
  e2eeChat = false,
  replyText = null,
  onCancelReply,
  textareaRef,
  attachmentCount,
  attachDisabled,
  attachHint,
  onAttach,
  stickersOpen,
  onToggleStickers,
  stickerButtonRef,
  voiceButtonRef,
  voiceDisabled,
  voiceHint,
  voiceActive,
  onStartVoice,
  voiceBar,
  mentionMembers = NO_MENTION_MEMBERS,
  mentionsEnabled = false,
  allowMentionAll = false,
  mentionDirectoryLoading = false,
  onMentionDirectoryNeeded,
  botCommands = NO_BOT_COMMANDS,
  commandStatus = 'idle',
  commandNotice = null,
  commandErrorMessage = null,
  onInvokeCommand,
}: ComposerProps) {
  const length = value.length;
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiCategory, setEmojiCategory] = useState<EmojiCategory>('smileys');
  const emojiRef = useRef<HTMLDivElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const commandListboxId = useId();
  const [commandActiveIndex, setCommandActiveIndex] = useState(0);
  const [commandDismissed, setCommandDismissed] = useState(false);
  const mentionNames = useMemo(
    () => mentionMembers.map((member) => member.display_name),
    [mentionMembers],
  );
  const mentions = useMentionAutocomplete({
    value,
    onChange,
    textareaRef,
    members: mentionMembers,
    enabled: mentionsEnabled,
    allowAll: allowMentionAll,
    onDirectoryNeeded: onMentionDirectoryNeeded,
  });
  const canSend =
    !disabled &&
    sendBlockedReason === null &&
    commandStatus !== 'sending' &&
    (value.trim().length > 0 || attachmentCount > 0) &&
    length <= MAX_LENGTH;

  const commandQuery = slashCommandQuery(value);
  const commandMatches = useMemo(
    () => (commandQuery === null ? [] : matchBotCommands(botCommands, commandQuery)),
    [botCommands, commandQuery],
  );
  const commandPaletteOpen = commandQuery !== null && botCommands.length > 0 && !commandDismissed;
  const safeCommandIndex =
    commandMatches.length === 0 ? 0 : Math.min(commandActiveIndex, commandMatches.length - 1);
  const commandOptionId =
    commandPaletteOpen && commandMatches.length > 0
      ? `${commandListboxId}-option-${safeCommandIndex}`
      : null;

  useEffect(() => {
    setCommandActiveIndex(0);
  }, [commandQuery]);

  useEffect(() => {
    setCommandDismissed(false);
  }, [value]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    if (element.scrollHeight > 0) {
      element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
    }
  }, [value, textareaRef]);

  useEffect(() => {
    if (!emojiOpen) return;
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setEmojiOpen(false);
        emojiButtonRef.current?.focus();
      }
    };
    const handlePointer = (event: MouseEvent) => {
      if (emojiRef.current && !emojiRef.current.contains(event.target as Node)) {
        setEmojiOpen(false);
      }
    };
    document.addEventListener('keydown', handle);
    document.addEventListener('mousedown', handlePointer);
    return () => {
      document.removeEventListener('keydown', handle);
      document.removeEventListener('mousedown', handlePointer);
    };
  }, [emojiOpen]);

  // The mention listbox and the emoji tray occupy the same anchor; only one
  // picker is useful at a time.
  useEffect(() => {
    if (mentions.open) setEmojiOpen(false);
  }, [mentions.open]);

  const insertCommand = (option: BotCommandOption) => {
    onChange(`/${option.command} `);
    setCommandDismissed(true);
    textareaRef.current?.focus();
  };

  const submit = () => {
    // A leading `/` invokes the command only when an installed bot registered
    // it; unknown names remain ordinary messages (the server would 404 them).
    if (
      !disabled &&
      sendBlockedReason === null &&
      commandStatus !== 'sending' &&
      attachmentCount === 0 &&
      onInvokeCommand !== undefined
    ) {
      const parsed = parseSlashCommand(value);
      if (parsed !== null && findBotCommand(botCommands, parsed.command) !== null) {
        setCommandDismissed(true);
        onInvokeCommand(parsed.command, parsed.args);
        textareaRef.current?.focus();
        return;
      }
    }
    if (!canSend) return;
    onSend();
    textareaRef.current?.focus();
  };

  const wrapSelection = (before: string, after: string) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const selected = value.slice(start, end);
    const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
    onChange(next);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      const caret = start + before.length + selected.length;
      textarea?.setSelectionRange(caret, caret);
    });
  };

  // Grow with the content up to the CSS max-height, then scroll.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 32), 180)}px`;
  }, [value, textareaRef]);

  // Prefix each selected line (lists, quotes, fenced code).
  const prefixLines = (prefix: string) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const selected = value.slice(start, end);
    const prefixed = (selected.length > 0 ? selected.split('\n') : [''])
      .map((line) => `${prefix}${line}`)
      .join('\n');
    const next = `${value.slice(0, start)}${prefixed}${value.slice(end)}`;
    onChange(next);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      const caret = start + prefixed.length;
      textarea?.setSelectionRange(caret, caret);
    });
  };

  const insertEmoji = (emoji: string) => {
    onChange(`${value}${emoji}`);
    setEmojiOpen(false);
    textareaRef.current?.focus();
  };

  const statusNote = disabled
    ? t('composer.unavailable')
    : sendBlockedReason === 'offline'
      ? t('composer.offline')
      : sendBlockedReason === 'rate_limit'
        ? t('composer.rateLimited', { seconds: rateLimitSeconds })
        : sendBlockedReason === 'read_only'
          ? t('composer.readOnly')
          : sendBlockedReason === 'e2ee_blocked'
            ? t('composer.e2eeBlocked')
            : null;
  const contextNote = e2eeChat ? t('chat.e2eeNote') : t('chat.managedNote');
  const autocompleteEnabled = mentionsEnabled || botCommands.length > 0;
  const autocompleteOpen = mentions.open || commandPaletteOpen;

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {replyTo ? (
        <div className="reply-bar">
          <div className="reply-bar__body">
            <span className="reply-bar__label">
              {t('chat.replyTo')}: {replyTo.sender_display_name?.trim() || t('chat.unknownAuthor')}
            </span>
            <span className="reply-bar__text">
              {e2eeChat ? (
                (replyText ??
                (replyTo.deleted_at ? t('chat.deletedMessage') : t('chat.replyUnavailable')))
              ) : (
                <MentionText text={replyPreview(replyTo.text)} mentions={mentionNames} />
              )}
            </span>
          </div>
          <button
            type="button"
            className="icon-button icon-button--small"
            onClick={onCancelReply}
            aria-label={t('chat.cancelReply')}
            title={t('chat.cancelReply')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {voiceBar}

      {commandStatus === 'sending' ? (
        <p className="composer__command-state" role="status" aria-live="polite">
          {t('composer.command.sending')}
        </p>
      ) : commandStatus === 'error' && commandErrorMessage ? (
        <p className="composer__command-state composer__command-state--error" role="alert">
          {commandErrorMessage}
        </p>
      ) : commandStatus === 'accepted' && commandNotice ? (
        <p className="composer__command-state" role="status" aria-live="polite">
          {commandNotice}
        </p>
      ) : null}

      <div className="composer__row">
        <label className="visually-hidden" htmlFor="composer-input">
          {t('composer.label')}
        </label>
        <button
          type="button"
          className="round-btn composer__attach"
          onClick={onAttach}
          disabled={attachDisabled || disabled}
          aria-label={t('files.attach')}
          title={attachHint}
        >
          <PlusIcon aria-hidden="true" />
        </button>
        <button
          type="button"
          className="round-btn composer__mention"
          onClick={() => {
            onChange(`${value}@`);
            textareaRef.current?.focus();
          }}
          disabled={disabled}
          aria-label={t('composer.mention')}
          title={t('composer.mention')}
        >
          @
        </button>
        <button
          type="button"
          ref={stickerButtonRef}
          className={`round-btn composer__sticker${stickersOpen ? ' is-on' : ''}`}
          onClick={onToggleStickers}
          disabled={disabled}
          aria-label={t('stickers.open')}
          aria-expanded={stickersOpen}
          aria-controls={stickersOpen ? 'sticker-picker' : undefined}
          title={t('stickers.open')}
        >
          <StickerIcon aria-hidden="true" />
        </button>

        <div className="field composer__field">
          <div className="composer-format" role="toolbar" aria-label={t('composer.formatting')}>
            {[
              { label: 'B', before: '**', after: '**', title: t('composer.bold') },
              { label: 'I', before: '*', after: '*', title: t('composer.italic') },
              { label: 'S', before: '~~', after: '~~', title: t('composer.strike') },
              {
                label: '`',
                icon: <CodeIcon />,
                before: '`',
                after: '`',
                title: t('composer.code'),
              },
            ].map((item) => (
              <button
                key={item.title}
                type="button"
                className="composer-format__button"
                disabled={disabled}
                aria-label={item.title}
                title={item.title}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => wrapSelection(item.before, item.after)}
              >
                {item.icon ?? item.label}
              </button>
            ))}
            <span className="composer-format__sep" aria-hidden="true" />
            <button
              type="button"
              className="composer-format__button"
              disabled={disabled}
              aria-label={t('composer.codeBlock')}
              title={t('composer.codeBlock')}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => wrapSelection('```\n', '\n```')}
            >
              <CodeBlockIcon />
            </button>
            <button
              type="button"
              className="composer-format__button"
              disabled={disabled}
              aria-label={t('composer.orderedList')}
              title={t('composer.orderedList')}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => prefixLines('1. ')}
            >
              <NumberListIcon />
            </button>
            <button
              type="button"
              className="composer-format__button"
              disabled={disabled}
              aria-label={t('composer.bulletList')}
              title={t('composer.bulletList')}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => prefixLines('- ')}
            >
              <BulletListIcon />
            </button>
            <button
              type="button"
              className="composer-format__button"
              disabled={disabled}
              aria-label={t('composer.link')}
              title={t('composer.link')}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => wrapSelection('[', ']()')}
            >
              🔗
            </button>
          </div>
          <textarea
            id="composer-input"
            ref={textareaRef}
            className="composer__textarea"
            rows={1}
            maxLength={MAX_LENGTH}
            placeholder={
              chatName
                ? t('composer.placeholderInChat', { chat: chatName })
                : t('composer.placeholder')
            }
            aria-describedby="composer-hint composer-note"
            aria-autocomplete={autocompleteEnabled ? 'list' : undefined}
            aria-expanded={autocompleteEnabled ? autocompleteOpen : undefined}
            aria-controls={
              mentions.open ? mentions.listboxId : commandPaletteOpen ? commandListboxId : undefined
            }
            aria-activedescendant={
              mentions.open
                ? (mentions.activeOptionId ?? undefined)
                : commandPaletteOpen
                  ? (commandOptionId ?? undefined)
                  : undefined
            }
            aria-haspopup={autocompleteEnabled ? 'listbox' : undefined}
            role={autocompleteEnabled ? 'combobox' : undefined}
            readOnly={disabled}
            value={value}
            onChange={mentions.handleChange}
            onClick={mentions.syncCaret}
            onBlur={() => {
              mentions.close();
              setCommandDismissed(true);
            }}
            onKeyDown={(event) => {
              if (mentions.handleKeyDown(event)) return;
              if (commandPaletteOpen && !mentions.open) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  if (commandMatches.length > 0) {
                    const delta = event.key === 'ArrowDown' ? 1 : -1;
                    setCommandActiveIndex(
                      (safeCommandIndex + delta + commandMatches.length) % commandMatches.length,
                    );
                  }
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setCommandDismissed(true);
                  return;
                }
                if (
                  (event.key === 'Enter' || event.key === 'Tab') &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  commandMatches.length > 0
                ) {
                  event.preventDefault();
                  const active = commandMatches[safeCommandIndex]!;
                  // Enter on the fully typed name submits; Enter/Tab on a
                  // partial name completes it (Slack-like, no double Enter).
                  if (event.key === 'Enter' && active.command === value.slice(1).toLowerCase()) {
                    submit();
                    return;
                  }
                  insertCommand(active);
                  return;
                }
              }
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
          {mentions.open ? (
            <MentionPopover
              listboxId={mentions.listboxId}
              candidates={mentions.candidates}
              activeIndex={mentions.activeIndex}
              loading={mentionDirectoryLoading}
              onSelect={mentions.select}
              onActive={mentions.setActive}
            />
          ) : null}
          {commandPaletteOpen && !mentions.open ? (
            <CommandPalette
              listboxId={commandListboxId}
              options={commandMatches}
              activeIndex={safeCommandIndex}
              onSelect={insertCommand}
              onActive={setCommandActiveIndex}
            />
          ) : null}
          <button
            type="button"
            ref={emojiButtonRef}
            className={`field-emoji composer__emoji${emojiOpen ? ' is-on' : ''}`}
            onClick={() => setEmojiOpen((open) => !open)}
            aria-label={t('composer.emoji')}
            aria-expanded={emojiOpen}
            title={t('composer.emojiTitle')}
          >
            <EmojiIcon aria-hidden="true" />
          </button>
          {emojiOpen ? (
            <div
              className="emoji-pop"
              role="dialog"
              aria-label={t('composer.emoji')}
              ref={emojiRef}
            >
              <div className="emoji-pop__tabs" role="tablist" aria-label="Категории эмодзи">
                {EMOJI_CATEGORIES.map((category) => (
                  <button
                    key={category}
                    type="button"
                    role="tab"
                    aria-selected={emojiCategory === category}
                    className={`emoji-pop__tab${emojiCategory === category ? ' is-active' : ''}`}
                    onClick={() => setEmojiCategory(category)}
                    title={EMOJI_CATEGORY_LABEL[category]}
                    aria-label={EMOJI_CATEGORY_LABEL[category]}
                  >
                    {EMOJI_GROUPS[category][0]}
                  </button>
                ))}
              </div>
              <div className="emoji-pop__grid">
                {EMOJI_GROUPS[emojiCategory].map((emoji) => (
                  <button
                    type="button"
                    key={emoji}
                    className="emoji-pop__item"
                    aria-label={emoji}
                    onClick={() => insertEmoji(emoji)}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          ref={voiceButtonRef}
          className={`round-btn composer__voice${voiceActive ? ' composer__voice--active' : ''}`}
          onClick={onStartVoice}
          disabled={voiceDisabled || disabled}
          aria-label={t('voice.record')}
          aria-pressed={voiceActive}
          title={voiceHint}
        >
          <MicIcon aria-hidden="true" />
        </button>
        <button
          type="submit"
          className="send-btn"
          aria-label={t('composer.send')}
          title={t('composer.send')}
          disabled={!canSend}
        >
          <SendIcon aria-hidden="true" />
        </button>
      </div>

      <div className="composer__bar">
        <p
          className={`composer__note${e2eeChat ? ' composer__note--e2ee' : ''}`}
          id="composer-note"
          role="status"
          aria-live="polite"
        >
          {statusNote ?? (
            <>
              {e2eeChat ? <LockIcon aria-hidden="true" /> : <ShieldIcon aria-hidden="true" />}
              {contextNote}
            </>
          )}
        </p>
        <div className="composer__right">
          <p className="composer__hint" id="composer-hint">
            {t('composer.hint')}
          </p>
          {length >= COUNTER_VISIBLE_FROM ? (
            <span
              className={`composer__counter${length >= COUNTER_WARN_FROM ? ' composer__counter--warn' : ''}`}
              aria-label={t('composer.counterLabel', { count: length })}
            >
              {t('composer.counter', { count: length })}
            </span>
          ) : null}
        </div>
      </div>
    </form>
  );
}

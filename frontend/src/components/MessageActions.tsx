import { createPortal } from 'react-dom';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import type { ApiMessage } from '../api/types';
import { describeError } from '../domain/errors';
import { chatDisplayName } from '../domain/chatLabel';
import { formatDateTime } from './admin/format';
import { t } from '../i18n/ru';
import { usePluginGate } from '../plugins/gate';
import { useChatState, useChatStore, usePluginActionsStore } from '../store/ChatProvider';
import {
  BookmarkIcon,
  CloseIcon,
  EditIcon,
  EmojiIcon,
  ForwardIcon,
  MoreIcon,
  PinIcon,
  ReplyIcon,
  ThreadIcon,
  TranslateIcon,
  TrashIcon,
} from './Icons';

/** Fixed common set (#61): the contract allows any 1..32-char emoji sequence. */
export const COMMON_REACTIONS = [
  '👍',
  '👎',
  '❤️',
  '🔥',
  '😂',
  '🎉',
  '😮',
  '😢',
  '🙏',
  '✅',
  '👀',
  '🤔',
  '😍',
  '😡',
  '🥳',
  '🤝',
  '💯',
  '🚀',
  '⚡',
  '💡',
  '📌',
  '⭐',
  '🏆',
  '🎯',
  '☕',
  '🍕',
  '🎂',
  '🌮',
  '🍻',
  '☀️',
  '🌙',
  '🌈',
  '🙌',
  '👏',
  '💪',
  '🫶',
  '🤯',
  '😴',
  '🤣',
  '😭',
] as const;

const MAX_EDIT_LENGTH = 8000;
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusAfterRowChange(messageId: string): void {
  requestAnimationFrame(() => {
    const row = document.getElementById(`message-${messageId}`);
    if (row) {
      row.focus({ preventScroll: true });
      return;
    }
    document.querySelector<HTMLElement>('.messages')?.focus({ preventScroll: true });
  });
}

/** Escape/outside-click dismissal for the lightweight popovers. */
function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Capture + stopPropagation: a thread panel also listens for Escape and
      // must not close when only this popover is dismissed.
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    const handlePointer = (event: MouseEvent) => {
      const element = ref.current;
      if (!element) return;
      if (event.target instanceof Node && !element.contains(event.target)) closeRef.current();
    };
    document.addEventListener('keydown', handleKey, true);
    document.addEventListener('mousedown', handlePointer);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      document.removeEventListener('mousedown', handlePointer);
    };
  }, [open, ref]);
}

/** Modal focus trap + Escape + focus return to the control that opened it. */
function useModal(
  open: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  initialRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  fallbackRef?: RefObject<HTMLElement | null>,
): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const fallback = fallbackRef?.current ?? null;
    initialRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      // Keep the thread panel's own focus trap out of the nested dialog.
      event.stopPropagation();
      const dialog = dialogRef.current;
      if (!dialog) return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      // A dialog opened from the «…» menu has no surviving trigger (the menu
      // item is unmounted); fall back to the primary overflow control.
      if (previous?.isConnected) previous.focus();
      else fallback?.focus();
    };
  }, [open, dialogRef, initialRef, fallbackRef]);
}

/**
 * Arrow/Home/End roving focus for the non-modal action popup. The popup keeps
 * normal button semantics (Tab also works); this only makes the compact list
 * feel like a menu for keyboard users.
 */
function moveMenuFocus(event: ReactKeyboardEvent<HTMLElement>): void {
  const key = event.key;
  if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])')];
  if (items.length === 0) return;
  event.preventDefault();
  const active = document.activeElement;
  const index = items.findIndex((item) => item === active);
  let next = 0;
  if (key === 'End') next = items.length - 1;
  else if (key === 'ArrowUp') next = index <= 0 ? items.length - 1 : index - 1;
  else if (key === 'ArrowDown') next = index === items.length - 1 ? 0 : index + 1;
  items[next]?.focus();
}

interface ReactionBarProps {
  message: ApiMessage;
  e2eeChat: boolean;
}

/**
 * #61: aggregate chips under the message. Clicking a chip toggles only the
 * viewer's reaction; the store replaces counts from the server aggregate.
 */
export function ReactionBar({ message, e2eeChat }: ReactionBarProps) {
  const store = useChatStore();
  const state = useChatState();
  const slice = state.slices[message.chat_id];
  const reactions = message.reactions ?? [];
  const pending = new Set(slice?.pendingReactions ?? []);
  const actionError = slice?.actionError ?? null;
  const error =
    actionError?.kind === 'reaction' && actionError.messageId === message.id
      ? actionError.error
      : null;

  if (e2eeChat || message.deleted_at) return null;
  if (reactions.length === 0 && error === null) return null;

  return (
    <div className="msg-reactions" role="group" aria-label={t('message.reactionsLabel')}>
      {reactions.map((reaction) => {
        const mine = reaction.me;
        const label = `${t('message.reactionsCount', {
          emoji: reaction.emoji,
          count: reaction.count,
        })}${mine ? `, ${t('message.reactionsMine')}` : ''}`;
        const busy = pending.has(`${message.id}:${reaction.emoji}`);
        return (
          <button
            type="button"
            key={reaction.emoji}
            className={`reaction-chip${mine ? ' is-mine' : ''}`}
            aria-pressed={mine}
            aria-label={label}
            title={label}
            disabled={busy}
            onClick={() => void store.toggleReaction(message.chat_id, message.id, reaction.emoji)}
          >
            <span className="reaction-chip__emoji" aria-hidden="true">
              {reaction.emoji}
            </span>
            <span className="reaction-chip__count">{reaction.count}</span>
          </button>
        );
      })}
      {error ? (
        <p className="msg-action-error" role="alert">
          {describeError(error).message}
        </p>
      ) : null}
    </div>
  );
}

export interface MessageActionsProps {
  message: ApiMessage;
  author: string;
  mine: boolean;
  e2eeChat: boolean;
  allowReply: boolean;
  onReply?: (message: ApiMessage) => void;
  /** #95: structured poll/task cards have no thread entry point. */
  allowThread?: boolean;
  /** #95: never offer delete-for-all on a poll/task card (it would orphan the object). */
  structured?: boolean;
  threadsAvailable: boolean;
  threadDisabledReason: string | null;
  threadReplyCount: number;
  onOpenThread?: (message: ApiMessage) => void;
}

/**
 * #61–#63 hover/focus action bar. Managed metadata actions become honestly
 * disabled in an E2EE chat; delete stays available (the contract deletes E2EE
 * messages through the same tombstone path).
 */
export function MessageActions({
  message,
  author,
  mine,
  e2eeChat,
  allowReply,
  onReply,
  allowThread = true,
  structured = false,
  threadsAvailable,
  threadDisabledReason,
  threadReplyCount,
  onOpenThread,
}: MessageActionsProps) {
  const store = useChatStore();
  const state = useChatState();
  const pluginActions = usePluginActionsStore();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPosition, setPickerPosition] = useState({ top: 0, left: 0 });
  const pickerRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteMenuOpen, setDeleteMenuOpen] = useState(false);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [forwardTarget, setForwardTarget] = useState('');
  const [forwardError, setForwardError] = useState<string | null>(null);
  const [forwardBusy, setForwardBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [editConflict, setEditConflict] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [favoriteBusy, setFavoriteBusy] = useState(false);

  const pinsState = state.chatPins;
  const pinned =
    pinsState.chatId === message.chat_id &&
    pinsState.items.some((pin) => pin.message_id === message.id);
  const pinAllowed = store.canPinMessages(message.chat_id);
  const pinPending = pinsState.pendingMessageId === message.id;
  const togglePin = async () => {
    setActionFailure(null);
    if (pinned) {
      await store.unpinMessage(message.chat_id, message.id);
      return;
    }
    const ok = await store.pinMessage(message.chat_id, message.id);
    if (!ok) {
      const failure = store.getSnapshot().chatPins.actionError;
      if (failure?.messageId === message.id) {
        setActionFailure(
          failure.error.code === 'CHAT_PIN_LIMIT'
            ? t('message.pinLimit')
            : describeError(failure.error).message,
        );
      }
    }
  };

  const toolsId = useId();
  const editTitleId = useId();
  const editInputId = useId();
  const editErrorId = useId();
  const confirmTitleId = useId();
  const confirmTextId = useId();

  const toolsRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const editDialogRef = useRef<HTMLDivElement>(null);
  const confirmDialogRef = useRef<HTMLDivElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editTriggerRef = useRef<HTMLButtonElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const reactTriggerRef = useRef<HTMLButtonElement>(null);
  const firstReactionRef = useRef<HTMLButtonElement>(null);
  const firstDeleteItemRef = useRef<HTMLButtonElement>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);

  const closePicker = () => {
    setPickerOpen(false);
    reactTriggerRef.current?.focus();
  };
  const closeMenu = () => {
    setMenuOpen(false);
    moreTriggerRef.current?.focus();
  };
  const closeDeleteMenu = () => {
    setDeleteMenuOpen(false);
    moreTriggerRef.current?.focus();
  };
  const closeEdit = () => {
    if (busy) return;
    setEditOpen(false);
  };
  const closeConfirm = () => {
    if (busy) return;
    setConfirmOpen(false);
  };

  // Dismiss on a click anywhere outside the toolbar. Using the shared toolbar
  // container keeps a second click on «…» / the reaction button a true toggle
  // instead of close-on-mousedown followed by re-open.
  useDismiss(pickerOpen, pickerRef, closePicker);
  useDismiss(menuOpen, toolsRef, closeMenu);
  useDismiss(deleteMenuOpen, toolsRef, closeDeleteMenu);
  useModal(editOpen, editDialogRef, editTextareaRef, closeEdit, moreTriggerRef);
  useModal(confirmOpen, confirmDialogRef, confirmCancelRef, closeConfirm, moreTriggerRef);

  // Keyboard users land inside the opened popover, not on the next toolbar
  // button; closing returns focus to the trigger (see closePicker/closeMenu).
  useEffect(() => {
    if (pickerOpen) firstReactionRef.current?.focus();
  }, [pickerOpen]);
  // Land on the first enabled advanced action, skipping a disabled edit item.
  useEffect(() => {
    if (!menuOpen) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
    items?.[0]?.focus();
  }, [menuOpen]);
  useEffect(() => {
    if (deleteMenuOpen) firstDeleteItemRef.current?.focus();
  }, [deleteMenuOpen]);

  // A WS tombstone while the dialog is open must not leave an editor over a
  // deleted row (and an E2EE switch must disable it too).
  useEffect(() => {
    if (editOpen && (message.deleted_at || e2eeChat)) setEditOpen(false);
  }, [editOpen, message.deleted_at, e2eeChat]);

  // D1.1 (#76): translate is a plugin action, so it exists only while the
  // server says `translate` is enabled+available for this managed chat, and
  // only for a live TEXT row. E2EE never gets the affordance.
  const pluginGate = usePluginGate(message.chat_id, e2eeChat);
  const translateAvailable =
    !e2eeChat && message.type === 'TEXT' && !message.deleted_at && pluginGate.enabled('translate');

  if (message.deleted_at) return null;

  // #96: bot messages are authored by a bot, not by the viewer. Reactions,
  // replies and pinning stay available, but edit/delete affordances would be
  // impersonation and are not rendered at all.
  const botMessage = message.sender_type === 'BOT';
  const canThread = !message.thread_root_id;
  const editDisabledReason = e2eeChat
    ? t('message.editE2ee')
    : message.type !== 'TEXT'
      ? t('message.editNotText')
      : null;

  const openEdit = () => {
    if (editDisabledReason !== null) return;
    setDraft(message.text ?? '');
    setEditError(null);
    setEditConflict(false);
    setActionFailure(null);
    setEditOpen(true);
  };

  const saveEdit = async () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      setEditError(t('message.editEmpty'));
      return;
    }
    if (draft.length > MAX_EDIT_LENGTH) {
      setEditError(t('message.editTooLong'));
      return;
    }
    setBusy(true);
    setEditError(null);
    setEditConflict(false);
    const ok = await store.editMessage(message.chat_id, message.id, trimmed, message.version);
    setBusy(false);
    if (ok) {
      setEditOpen(false);
      return;
    }
    const failure = store.getSnapshot().slices[message.chat_id]?.actionError ?? null;
    if (failure?.kind === 'edit' && failure.messageId === message.id) {
      setEditError(describeError(failure.error).message);
      setEditConflict(failure.error.code === 'VERSION_CONFLICT');
    } else {
      setEditError(t('message.actionFailed'));
    }
  };

  const removeForMe = async () => {
    setDeleteMenuOpen(false);
    setActionFailure(null);
    const ok = await store.deleteMessage(message.chat_id, message.id, 'me');
    if (!ok) {
      const failure = store.getSnapshot().slices[message.chat_id]?.actionError ?? null;
      setActionFailure(
        failure?.kind === 'delete' && failure.messageId === message.id
          ? describeError(failure.error).message
          : t('message.actionFailed'),
      );
      moreTriggerRef.current?.focus();
      return;
    }
    focusAfterRowChange(message.id);
  };

  const removeForAll = async () => {
    setBusy(true);
    setConfirmError(null);
    const ok = await store.deleteMessage(message.chat_id, message.id, 'all');
    setBusy(false);
    if (ok) {
      setConfirmOpen(false);
      focusAfterRowChange(message.id);
      return;
    }
    const failure = store.getSnapshot().slices[message.chat_id]?.actionError ?? null;
    setConfirmError(
      failure?.kind === 'delete' && failure.messageId === message.id
        ? describeError(failure.error).message
        : t('message.actionFailed'),
    );
  };

  const chooseReaction = (emoji: string) => {
    setPickerOpen(false);
    reactTriggerRef.current?.focus();
    void store.toggleReaction(message.chat_id, message.id, emoji);
  };

  const chooseTranslation = (target: 'ru' | 'en') => {
    setMenuOpen(false);
    moreTriggerRef.current?.focus();
    void pluginActions.translateMessage(message.chat_id, message.id, target);
  };

  const replyAction =
    allowReply && onReply ? (
      <button
        type="button"
        className="msg-tool"
        onClick={() => {
          setPickerOpen(false);
          setMenuOpen(false);
          setDeleteMenuOpen(false);
          onReply(message);
        }}
        aria-label={`${t('chat.reply')}: ${author}`}
        title={t('chat.reply')}
      >
        <ReplyIcon aria-hidden="true" />
      </button>
    ) : null;

  // #61/#63 + Chat UI polish: only the three primary actions (reaction, reply,
  // «…») stay on the hover toolbar. Every mutating/advanced action lives in the
  // accessible overflow popup below. With replies the always-visible ThreadLink
  // is the single thread entry point; the popup only creates an empty thread.
  const pinAvailable = !e2eeChat && pinAllowed;
  const threadAvailable =
    allowThread && canThread && threadsAvailable && Boolean(onOpenThread) && threadReplyCount === 0;
  const threadDisabled =
    allowThread && canThread && !threadsAvailable && threadDisabledReason !== null;
  const editAvailable = mine && !botMessage;
  const deleteAvailable = !botMessage;
  const hasMoreActions =
    editAvailable ||
    translateAvailable ||
    pinAvailable ||
    threadAvailable ||
    threadDisabled ||
    deleteAvailable;

  const openEditFromMenu = () => {
    setMenuOpen(false);
    moreTriggerRef.current?.focus();
    openEdit();
  };
  const openDeleteMenu = () => {
    setMenuOpen(false);
    moreTriggerRef.current?.focus();
    setDeleteMenuOpen(true);
  };
  const pinFromMenu = () => {
    setMenuOpen(false);
    moreTriggerRef.current?.focus();
    void togglePin();
  };
  const threadFromMenu = () => {
    setMenuOpen(false);
    moreTriggerRef.current?.focus();
    onOpenThread?.(message);
  };

  const togglePicker = () => {
    if (pickerOpen) {
      setPickerOpen(false);
      return;
    }
    const rect = toolsRef.current?.getBoundingClientRect();
    if (!rect) {
      setPickerOpen(true);
      return;
    }
    const width = Math.min(300, window.innerWidth - 16);
    const height = 218;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight ? Math.max(8, rect.top - height - 6) : below;
    setPickerPosition({ top, left });
    setPickerOpen(true);
  };

  const picker = pickerOpen
    ? createPortal(
        <div
          ref={pickerRef}
          className="msg-popover reaction-picker"
          role="dialog"
          aria-label={t('message.reactionsPicker')}
          style={{
            position: 'fixed',
            top: pickerPosition.top,
            left: pickerPosition.left,
            right: 'auto',
          }}
        >
          <p className="msg-popover__title">{t('message.reactionsPicker')}</p>
          <div className="reaction-picker__grid">
            {COMMON_REACTIONS.map((emoji, index) => (
              <button
                type="button"
                key={emoji}
                ref={index === 0 ? firstReactionRef : undefined}
                className="reaction-picker__item"
                aria-label={emoji}
                onClick={() => chooseReaction(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )
    : null;

  const menu = menuOpen ? (
    <div
      className="msg-popover msg-menu"
      role="dialog"
      aria-label={t('message.actions')}
      ref={menuRef}
      onKeyDown={moveMenuFocus}
    >
      <p className="msg-popover__title">{t('message.actions')}</p>
      {editAvailable ? (
        <button
          type="button"
          ref={editTriggerRef}
          className="msg-menu__item"
          disabled={editDisabledReason !== null}
          aria-label={t('message.edit')}
          title={editDisabledReason ?? t('message.edit')}
          onClick={openEditFromMenu}
        >
          <EditIcon aria-hidden="true" />
          <span className="msg-menu__text">{t('message.edit')}</span>
          {editDisabledReason ? <span className="msg-menu__hint">{editDisabledReason}</span> : null}
        </button>
      ) : null}
      {translateAvailable ? (
        <>
          <span className="msg-menu__section">{t('pluginActions.translateMenuTitle')}</span>
          <button type="button" className="msg-menu__item" onClick={() => chooseTranslation('ru')}>
            <TranslateIcon aria-hidden="true" />
            <span className="msg-menu__text">{t('message.translateRu')}</span>
          </button>
          <button type="button" className="msg-menu__item" onClick={() => chooseTranslation('en')}>
            <TranslateIcon aria-hidden="true" />
            <span className="msg-menu__text">{t('message.translateEn')}</span>
          </button>
        </>
      ) : null}
      {pinAvailable ? (
        <button
          type="button"
          className="msg-menu__item"
          disabled={pinPending}
          aria-pressed={pinned}
          aria-label={pinned ? t('message.unpin') : t('message.pin')}
          title={
            pinned
              ? t('message.unpin')
              : pinsState.limitReached
                ? t('message.pinLimit')
                : t('message.pin')
          }
          onClick={pinFromMenu}
        >
          <PinIcon aria-hidden="true" />
          <span className="msg-menu__text">{pinned ? t('message.unpin') : t('message.pin')}</span>
          {!pinned && pinsState.limitReached ? (
            <span className="msg-menu__hint">{t('message.pinLimit')}</span>
          ) : null}
        </button>
      ) : null}
      {threadAvailable ? (
        <button
          type="button"
          className="msg-menu__item"
          onClick={threadFromMenu}
          aria-label={t('thread.startLabel', { author })}
          title={t('thread.start')}
        >
          <ThreadIcon aria-hidden="true" />
          <span className="msg-menu__text">{t('thread.start')}</span>
        </button>
      ) : threadDisabled && threadDisabledReason ? (
        <button
          type="button"
          className="msg-menu__item"
          disabled
          aria-label={threadDisabledReason}
          title={threadDisabledReason}
        >
          <ThreadIcon aria-hidden="true" />
          <span className="msg-menu__text">{t('thread.start')}</span>
          <span className="msg-menu__hint">{threadDisabledReason}</span>
        </button>
      ) : null}
      {!e2eeChat && !message.deleted_at ? (
        <button
          type="button"
          className="msg-menu__item"
          disabled={favoriteBusy}
          onClick={() => {
            setMenuOpen(false);
            setFavoriteBusy(true);
            void store
              .saveToFavorites(message)
              .then((ok) => {
                if (!ok) setActionFailure(t('message.favoriteError'));
              })
              .finally(() => setFavoriteBusy(false));
          }}
        >
          <BookmarkIcon aria-hidden="true" />
          <span className="msg-menu__text">
            {favoriteBusy ? t('message.favoriteSaving') : t('message.favorite')}
          </span>
        </button>
      ) : null}
      {!e2eeChat &&
      !message.deleted_at &&
      ((message.type === 'TEXT' && (message.text ?? '').trim()) ||
        (message.type === 'STICKER' && message.sticker)) ? (
        <button
          type="button"
          className="msg-menu__item"
          onClick={() => {
            setMenuOpen(false);
            setDeleteMenuOpen(false);
            setForwardTarget('');
            setForwardError(null);
            setForwardOpen(true);
          }}
        >
          <ForwardIcon aria-hidden="true" />
          <span className="msg-menu__text">{t('message.forward')}</span>
        </button>
      ) : null}
      {deleteAvailable ? (
        <>
          <span className="msg-menu__sep" aria-hidden="true" />
          <button
            type="button"
            className="msg-menu__item msg-menu__item--danger"
            aria-haspopup="dialog"
            aria-expanded={deleteMenuOpen}
            aria-label={t('message.delete')}
            title={t('message.delete')}
            onClick={openDeleteMenu}
          >
            <TrashIcon aria-hidden="true" />
            <span className="msg-menu__text">{t('message.delete')}</span>
          </button>
        </>
      ) : null}
    </div>
  ) : null;

  const deleteMenu = deleteMenuOpen ? (
    <div
      className="msg-popover delete-menu"
      role="dialog"
      aria-label={t('message.deleteTitle')}
      onKeyDown={moveMenuFocus}
    >
      <p className="msg-popover__title">{t('message.deleteTitle')}</p>
      <button
        type="button"
        ref={firstDeleteItemRef}
        className="delete-menu__item"
        onClick={() => void removeForMe()}
      >
        <span className="delete-menu__label">{t('message.deleteMe')}</span>
        <span className="delete-menu__hint">{t('message.deleteMeHint')}</span>
      </button>
      {mine && !structured ? (
        <button
          type="button"
          className="delete-menu__item delete-menu__item--danger"
          onClick={() => {
            setDeleteMenuOpen(false);
            setConfirmError(null);
            // Capture a stable return target for the confirm dialog.
            moreTriggerRef.current?.focus();
            setConfirmOpen(true);
          }}
        >
          <span className="delete-menu__label">{t('message.deleteAll')}</span>
          <span className="delete-menu__hint">{t('message.deleteAllHint')}</span>
        </button>
      ) : null}
      {structured ? <p className="delete-menu__hint">{t('message.deleteStructuredHint')}</p> : null}
    </div>
  ) : null;

  const forwardDialog = forwardOpen ? (
    <div
      className="modal-layer"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) setForwardOpen(false);
      }}
    >
      <div
        className="modal modal--sm"
        role="dialog"
        aria-modal="true"
        aria-label={t('message.forwardTitle')}
      >
        <div className="modal-head">
          <h2 className="modal-title">{t('message.forwardTitle')}</h2>
          <button
            type="button"
            className="modal-x"
            onClick={() => setForwardOpen(false)}
            aria-label={t('common.close')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span className="field__label">{t('message.forwardTo')}</span>
            <select
              className="input"
              value={forwardTarget}
              onChange={(event) => setForwardTarget(event.target.value)}
            >
              <option value="">{t('message.forwardChoose')}</option>
              {state.chats
                .filter((chat) => chat.id !== message.chat_id)
                .map((chat) => (
                  <option key={chat.id} value={chat.id}>
                    {chat.name ?? chatDisplayName(chat, state.workspaceMembers.items)}
                  </option>
                ))}
            </select>
          </label>
          {forwardError ? (
            <p className="msg-edit-error" role="alert">
              {forwardError}
            </p>
          ) : null}
        </div>
        <div className="modal-foot">
          <button type="button" className="button" onClick={() => setForwardOpen(false)}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={!forwardTarget || forwardBusy}
            onClick={async () => {
              if (!forwardTarget) return;
              setForwardBusy(true);
              setForwardError(null);
              try {
                if (message.sticker && !message.text) {
                  await store.sendSticker(forwardTarget, message.sticker);
                  setForwardOpen(false);
                  return;
                }
                const author =
                  message.sender_display_name?.trim() || t('message.forwardUnknownAuthor');
                const sourceChat = state.chats.find((chat) => chat.id === message.chat_id) ?? null;
                const meta = {
                  chatId: message.chat_id,
                  messageId: message.id,
                  senderId: message.sender_id ?? null,
                  author,
                  createdAt: message.created_at,
                  chatType: sourceChat?.type ?? null,
                  chatName: sourceChat?.name ?? null,
                };
                const marker = `sova-forward:${encodeURIComponent(JSON.stringify(meta))}`;
                const forwarded = `↪ ${t('message.forwardedFrom', {
                  author,
                  date: formatDateTime(message.created_at),
                })}\n${marker}\n\n${message.text ?? ''}`;
                await store.send(forwardTarget, forwarded);
                setForwardOpen(false);
              } catch {
                setForwardError(t('message.forwardError'));
              } finally {
                setForwardBusy(false);
              }
            }}
          >
            {t('message.forwardAction')}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const editDialog = editOpen ? (
    <div
      className="modal-layer"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeEdit();
      }}
    >
      <div
        className="modal modal--sm msg-edit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={editTitleId}
        ref={editDialogRef}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2 className="modal-title" id={editTitleId}>
            {t('message.editTitle')}
          </h2>
          <button
            type="button"
            className="modal-x"
            onClick={closeEdit}
            disabled={busy}
            aria-label={t('message.editClose')}
            title={t('message.editClose')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>
        <div className="modal-body">
          <label className="visually-hidden" htmlFor={editInputId}>
            {t('message.editTitle')}
          </label>
          <textarea
            id={editInputId}
            ref={editTextareaRef}
            className="msg-edit-input"
            value={draft}
            maxLength={MAX_EDIT_LENGTH}
            rows={5}
            aria-invalid={editError !== null}
            aria-describedby={editError ? editErrorId : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              if (editError) setEditError(null);
            }}
          />
          <div className="msg-edit-meta">
            <span className="msg-edit-counter" aria-hidden="true">
              {t('composer.counter', { count: draft.length })}
            </span>
          </div>
          {editConflict ? (
            <button
              type="button"
              className="button button--small"
              onClick={() => {
                setDraft(message.text ?? '');
                setEditError(null);
                setEditConflict(false);
                editTextareaRef.current?.focus();
              }}
            >
              {t('message.editRefresh')}
            </button>
          ) : null}
          {editError ? (
            <p className="msg-edit-error" id={editErrorId} role="alert">
              {editError}
            </p>
          ) : null}
        </div>
        <div className="modal-foot">
          <button type="button" className="button" onClick={closeEdit} disabled={busy}>
            {t('message.editCancel')}
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => void saveEdit()}
            disabled={busy || draft.trim().length === 0}
          >
            {busy ? t('message.editSaving') : t('message.editSave')}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const confirmDialog = confirmOpen ? (
    <div
      className="modal-layer"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeConfirm();
      }}
    >
      <div
        className="modal modal--sm msg-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={confirmTitleId}
        aria-describedby={confirmTextId}
        ref={confirmDialogRef}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2 className="modal-title" id={confirmTitleId}>
            {t('message.deleteAllTitle')}
          </h2>
          <button
            type="button"
            className="modal-x"
            onClick={closeConfirm}
            disabled={busy}
            aria-label={t('message.deleteClose')}
            title={t('message.deleteClose')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>
        <div className="modal-body">
          <p id={confirmTextId}>{t('message.deleteAllText')}</p>
          {confirmError ? (
            <p className="msg-edit-error" role="alert">
              {confirmError}
            </p>
          ) : null}
        </div>
        <div className="modal-foot">
          <button
            type="button"
            className="button"
            ref={confirmCancelRef}
            onClick={closeConfirm}
            disabled={busy}
          >
            {t('message.deleteCancel')}
          </button>
          <button
            type="button"
            className="button button--danger"
            onClick={() => void removeForAll()}
            disabled={busy}
          >
            {busy ? t('message.deleteBusy') : t('message.deleteConfirm')}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        className="msg-actions-toggle"
        aria-expanded={toolsOpen}
        aria-controls={toolsId}
        aria-label={t('message.actions')}
        title={t('message.actions')}
        onClick={() => setToolsOpen((open) => !open)}
      >
        <MoreIcon aria-hidden="true" />
      </button>
      <div className={`msg-tools${toolsOpen ? ' is-open' : ''}`} id={toolsId} ref={toolsRef}>
        <button
          type="button"
          ref={reactTriggerRef}
          className="msg-tool"
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          disabled={e2eeChat}
          aria-label={e2eeChat ? t('message.reactionE2ee') : t('message.addReaction')}
          title={e2eeChat ? t('message.reactionE2ee') : t('message.addReaction')}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            setMenuOpen(false);
            setDeleteMenuOpen(false);
            togglePicker();
          }}
        >
          <EmojiIcon aria-hidden="true" />
        </button>
        {replyAction}
        {hasMoreActions ? (
          <button
            type="button"
            ref={moreTriggerRef}
            className="msg-tool"
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            aria-label={t('message.actionsMore')}
            title={t('message.actionsMore')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              setPickerOpen(false);
              setDeleteMenuOpen(false);
              setMenuOpen((open) => !open);
            }}
          >
            <MoreIcon aria-hidden="true" />
          </button>
        ) : null}
        {picker}
        {menu}
        {deleteMenu}
      </div>
      {actionFailure ? (
        <p className="msg-action-error" role="alert">
          {actionFailure}
        </p>
      ) : null}
      {forwardDialog ? createPortal(forwardDialog, document.body) : null}
      {editDialog ? createPortal(editDialog, document.body) : null}
      {confirmDialog ? createPortal(confirmDialog, document.body) : null}
    </>
  );
}

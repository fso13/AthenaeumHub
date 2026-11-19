import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { ApiMessage } from '../api/types';
import { describeError } from '../domain/errors';
import { t } from '../i18n/ru';
import { usePluginGate } from '../plugins/gate';
import { useChatState, useChatStore, usePluginActionsStore } from '../store/ChatProvider';
import {
  CloseIcon,
  EditIcon,
  EmojiIcon,
  MoreIcon,
  ReplyIcon,
  ThreadIcon,
  TranslateIcon,
  TrashIcon,
} from './Icons';

/** Fixed common set (#61): the contract allows any 1..32-char emoji sequence. */
export const COMMON_REACTIONS = [
  '👍',
  '❤️',
  '🔥',
  '😂',
  '🎉',
  '😮',
  '😢',
  '🙏',
  '✅',
  '👀',
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
): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
      if (previous?.isConnected) previous.focus();
    };
  }, [open, dialogRef, initialRef]);
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
  threadsAvailable,
  threadDisabledReason,
  threadReplyCount,
  onOpenThread,
}: MessageActionsProps) {
  const store = useChatStore();
  const pluginActions = usePluginActionsStore();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [translateMenuOpen, setTranslateMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [editConflict, setEditConflict] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toolsId = useId();
  const editTitleId = useId();
  const editInputId = useId();
  const editErrorId = useId();
  const confirmTitleId = useId();
  const confirmTextId = useId();

  const pickerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const translateMenuRef = useRef<HTMLDivElement>(null);
  const editDialogRef = useRef<HTMLDivElement>(null);
  const confirmDialogRef = useRef<HTMLDivElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const reactTriggerRef = useRef<HTMLButtonElement>(null);
  const translateTriggerRef = useRef<HTMLButtonElement>(null);
  const firstTranslateRef = useRef<HTMLButtonElement>(null);
  const firstReactionRef = useRef<HTMLButtonElement>(null);
  const firstMenuItemRef = useRef<HTMLButtonElement>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);

  const closePicker = () => {
    setPickerOpen(false);
    reactTriggerRef.current?.focus();
  };
  const closeMenu = () => {
    setMenuOpen(false);
    deleteTriggerRef.current?.focus();
  };
  const closeTranslateMenu = () => {
    setTranslateMenuOpen(false);
    translateTriggerRef.current?.focus();
  };
  const closeEdit = () => {
    if (busy) return;
    setEditOpen(false);
  };
  const closeConfirm = () => {
    if (busy) return;
    setConfirmOpen(false);
  };

  useDismiss(pickerOpen, pickerRef, closePicker);
  useDismiss(menuOpen, menuRef, closeMenu);
  useDismiss(translateMenuOpen, translateMenuRef, closeTranslateMenu);
  useModal(editOpen, editDialogRef, editTextareaRef, closeEdit);
  useModal(confirmOpen, confirmDialogRef, confirmCancelRef, closeConfirm);

  // Keyboard users land inside the opened popover, not on the next toolbar
  // button; closing returns focus to the trigger (see closePicker/closeMenu).
  useEffect(() => {
    if (pickerOpen) firstReactionRef.current?.focus();
  }, [pickerOpen]);
  useEffect(() => {
    if (menuOpen) firstMenuItemRef.current?.focus();
  }, [menuOpen]);
  useEffect(() => {
    if (translateMenuOpen) firstTranslateRef.current?.focus();
  }, [translateMenuOpen]);

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

  useEffect(() => {
    if (translateMenuOpen && !translateAvailable) setTranslateMenuOpen(false);
  }, [translateMenuOpen, translateAvailable]);

  if (message.deleted_at) return null;

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
    setMenuOpen(false);
    setActionFailure(null);
    const ok = await store.deleteMessage(message.chat_id, message.id, 'me');
    if (!ok) {
      const failure = store.getSnapshot().slices[message.chat_id]?.actionError ?? null;
      setActionFailure(
        failure?.kind === 'delete' && failure.messageId === message.id
          ? describeError(failure.error).message
          : t('message.actionFailed'),
      );
      deleteTriggerRef.current?.focus();
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
    setTranslateMenuOpen(false);
    translateTriggerRef.current?.focus();
    void pluginActions.translateMessage(message.chat_id, message.id, target);
  };

  const replyAction =
    allowReply && onReply ? (
      <button
        type="button"
        className="msg-tool"
        onClick={() => onReply(message)}
        aria-label={`${t('chat.reply')}: ${author}`}
        title={t('chat.reply')}
      >
        <ReplyIcon aria-hidden="true" />
      </button>
    ) : null;

  // With replies the always-visible ThreadLink is the single entry point; the
  // hover action only creates an empty thread (no duplicate accessible name).
  const threadAction =
    canThread && threadsAvailable && onOpenThread && threadReplyCount === 0 ? (
      <button
        type="button"
        className="msg-tool"
        onClick={() => onOpenThread(message)}
        aria-label={t('thread.startLabel', { author })}
        title={t('thread.start')}
      >
        <ThreadIcon aria-hidden="true" />
      </button>
    ) : canThread && !threadsAvailable && threadDisabledReason ? (
      <button
        type="button"
        className="msg-tool"
        disabled
        aria-label={threadDisabledReason}
        title={threadDisabledReason}
      >
        <ThreadIcon aria-hidden="true" />
      </button>
    ) : null;

  const picker = pickerOpen ? (
    <div
      className="msg-popover reaction-picker"
      role="dialog"
      aria-label={t('message.reactionsPicker')}
      ref={pickerRef}
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
    </div>
  ) : null;

  const translateMenu = translateMenuOpen ? (
    <div
      className="msg-popover translate-menu"
      role="dialog"
      aria-label={t('pluginActions.translateMenuTitle')}
      ref={translateMenuRef}
    >
      <p className="msg-popover__title">{t('pluginActions.translateMenuTitle')}</p>
      <button
        type="button"
        ref={firstTranslateRef}
        className="translate-menu__item"
        onClick={() => chooseTranslation('ru')}
      >
        {t('pluginActions.langRu')}
      </button>
      <button
        type="button"
        className="translate-menu__item"
        onClick={() => chooseTranslation('en')}
      >
        {t('pluginActions.langEn')}
      </button>
    </div>
  ) : null;

  const menu = menuOpen ? (
    <div
      className="msg-popover delete-menu"
      role="dialog"
      aria-label={t('message.deleteTitle')}
      ref={menuRef}
    >
      <p className="msg-popover__title">{t('message.deleteTitle')}</p>
      <button
        type="button"
        ref={firstMenuItemRef}
        className="delete-menu__item"
        onClick={() => void removeForMe()}
      >
        <span className="delete-menu__label">{t('message.deleteMe')}</span>
        <span className="delete-menu__hint">{t('message.deleteMeHint')}</span>
      </button>
      {mine ? (
        <button
          type="button"
          className="delete-menu__item delete-menu__item--danger"
          onClick={() => {
            setMenuOpen(false);
            setConfirmError(null);
            // Capture a stable return target for the confirm dialog; the menu
            // item that was clicked is unmounted in this same render.
            deleteTriggerRef.current?.focus();
            setConfirmOpen(true);
          }}
        >
          <span className="delete-menu__label">{t('message.deleteAll')}</span>
          <span className="delete-menu__hint">{t('message.deleteAllHint')}</span>
        </button>
      ) : null}
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
        aria-label={t('message.actionsMore')}
        title={t('message.actions')}
        onClick={() => setToolsOpen((open) => !open)}
      >
        <MoreIcon aria-hidden="true" />
      </button>
      <div className={`msg-tools${toolsOpen ? ' is-open' : ''}`} id={toolsId}>
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
            setTranslateMenuOpen(false);
            setPickerOpen((open) => !open);
          }}
        >
          <EmojiIcon aria-hidden="true" />
        </button>
        {mine ? (
          <button
            type="button"
            ref={editTriggerRef}
            className="msg-tool"
            disabled={editDisabledReason !== null}
            aria-label={t('message.edit')}
            title={editDisabledReason ?? t('message.edit')}
            onClick={openEdit}
          >
            <EditIcon aria-hidden="true" />
          </button>
        ) : null}
        {translateAvailable ? (
          <button
            type="button"
            ref={translateTriggerRef}
            className="msg-tool"
            aria-haspopup="dialog"
            aria-expanded={translateMenuOpen}
            aria-label={t('pluginActions.translateLabel', { author })}
            title={t('pluginActions.translate')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              setPickerOpen(false);
              setMenuOpen(false);
              setTranslateMenuOpen((open) => !open);
            }}
          >
            <TranslateIcon aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          ref={deleteTriggerRef}
          className="msg-tool"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          aria-label={t('message.delete')}
          title={t('message.delete')}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            setPickerOpen(false);
            setTranslateMenuOpen(false);
            setMenuOpen((open) => !open);
          }}
        >
          <TrashIcon aria-hidden="true" />
        </button>
        {replyAction}
        {threadAction}
        {picker}
        {translateMenu}
        {menu}
      </div>
      {actionFailure ? (
        <p className="msg-action-error" role="alert">
          {actionFailure}
        </p>
      ) : null}
      {editDialog ? createPortal(editDialog, document.body) : null}
      {confirmDialog ? createPortal(confirmDialog, document.body) : null}
    </>
  );
}

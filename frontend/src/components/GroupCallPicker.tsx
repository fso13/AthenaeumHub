import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { t } from '../i18n/ru';
import { useChatState, useChatStore } from '../store/ChatProvider';
import { Avatar } from './Avatar';
import { CloseIcon, PhoneIcon, RefreshIcon, VideoIcon } from './Icons';

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export interface GroupCallPickerProps {
  chatId: string;
  chatName: string;
  /** Initial kind chosen by the header button (audio/video). */
  initialVideo: boolean;
  onClose: () => void;
}

/**
 * #77 GROUP call participant picker.
 *
 * Opens from the header call/video buttons (or the details call row), lists the
 * workspace's ACTIVE members except the caller, and requires at least one
 * checkbox. "Выбрать всех" selects the whole directory; the audio/video toggle
 * can still be changed before "Позвонить". DIRECT chats never open this modal.
 */
export function GroupCallPicker({ chatId, chatName, initialVideo, onClose }: GroupCallPickerProps) {
  const store = useChatStore();
  const state = useChatState();
  const [video, setVideo] = useState(initialVideo);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [chatMemberIds, setChatMemberIds] = useState<ReadonlySet<string> | null>(null);
  const [membersFailed, setMembersFailed] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const leadId = useId();
  const countId = useId();
  const viewerId = state.user?.id ?? state.session?.user.id ?? null;
  const members = state.workspaceMembers.items.filter(
    (member) =>
      member.user_id !== viewerId && chatMemberIds !== null && chatMemberIds.has(member.user_id),
  );
  const membership = state.workspaceMembers;
  const memberIds = useMemo(() => members.map((member) => member.user_id), [members]);
  const allSelected = memberIds.length > 0 && memberIds.every((id) => selected.has(id));
  const selectedCount = selected.size;
  const canCall = selectedCount > 0;
  const loading =
    chatMemberIds === null || membership.status === 'idle' || membership.status === 'loading';
  const failed = membersFailed || (membership.status === 'error' && members.length === 0);

  // Load the directory when the modal opens; restore focus on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    store.clearWorkspaceMembers();
    void store.loadWorkspaceMembers({ force: true });
    let active = true;
    void store
      .listChatMembers(chatId)
      .then((ids) => {
        if (!active) return;
        setChatMemberIds(new Set(ids));
        setMembersFailed(false);
      })
      .catch(() => {
        if (active) setMembersFailed(true);
      });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => dialogRef.current?.focus(), 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
      document.body.style.overflow = previousOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [chatId, store]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
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
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const toggle = (userId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(memberIds));
  };

  const call = () => {
    if (!canCall) return;
    const started = store.startGroupCall(chatId, [...selected], video);
    if (started) onClose();
  };

  return (
    <div
      className="call-picker-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="call-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={leadId}
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="call-picker__head">
          <div>
            <h2 id={titleId} className="call-picker__title">
              {t('calls.pickerTitle')}
            </h2>
            <p id={leadId} className="call-picker__lead">
              {t('calls.pickerLead', { name: chatName })}
            </p>
          </div>
          <button
            type="button"
            className="icon-button icon-button--small"
            onClick={onClose}
            aria-label={t('calls.pickerClose')}
            title={t('calls.close')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </header>

        <div className="call-picker__kind" role="group" aria-label={t('calls.pickerTitle')}>
          <button
            type="button"
            className={`call-picker__kind-button${video ? '' : ' is-active'}`}
            aria-pressed={!video}
            onClick={() => setVideo(false)}
          >
            <PhoneIcon aria-hidden="true" />
            {t('calls.pickerAudio')}
          </button>
          <button
            type="button"
            className={`call-picker__kind-button${video ? ' is-active' : ''}`}
            aria-pressed={video}
            onClick={() => setVideo(true)}
          >
            <VideoIcon aria-hidden="true" />
            {t('calls.pickerVideo')}
          </button>
        </div>

        <div className="call-picker__toolbar">
          <button
            type="button"
            className="call-picker__select-all"
            onClick={toggleAll}
            disabled={memberIds.length === 0}
          >
            {allSelected ? t('calls.pickerClearAll') : t('calls.pickerSelectAll')}
          </button>
          <span id={countId} className="call-picker__count" aria-live="polite">
            {t('calls.pickerSelected', { count: selectedCount, total: memberIds.length })}
          </span>
        </div>

        <fieldset className="call-picker__list" aria-describedby={countId}>
          <legend className="visually-hidden">{t('calls.pickerTitle')}</legend>
          {loading && members.length === 0 ? (
            <p className="call-picker__state" role="status">
              {t('calls.pickerLoading')}
            </p>
          ) : failed ? (
            <div className="call-picker__state" role="alert">
              <p>{t('calls.pickerError')}</p>
              <button
                type="button"
                className="call-picker__retry"
                onClick={() => void store.loadWorkspaceMembers({ force: true })}
              >
                <RefreshIcon aria-hidden="true" />
                {t('calls.pickerRetry')}
              </button>
            </div>
          ) : members.length === 0 ? (
            <p className="call-picker__state">{t('calls.pickerEmpty')}</p>
          ) : (
            members.map((member) => {
              const checked = selected.has(member.user_id);
              return (
                <label
                  key={member.user_id}
                  className={`call-picker__row${checked ? ' is-selected' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(member.user_id)}
                  />
                  <Avatar name={member.display_name} seed={member.user_id} size="md" />
                  <span className="call-picker__name">{member.display_name}</span>
                </label>
              );
            })
          )}
          {membership.hasMore ? (
            <button
              type="button"
              className="call-picker__more"
              disabled={membership.loadMoreStatus === 'loading'}
              onClick={() => void store.loadMoreWorkspaceMembers()}
            >
              {membership.loadMoreStatus === 'loading'
                ? t('calls.pickerLoading')
                : t('calls.pickerMore')}
            </button>
          ) : null}
        </fieldset>

        <footer className="call-picker__foot">
          <span className="call-picker__hint">{canCall ? '' : t('calls.pickerMin')}</span>
          <div className="call-picker__actions">
            <button type="button" className="call-picker__cancel" onClick={onClose}>
              {t('calls.pickerCancel')}
            </button>
            <button
              type="button"
              className="call-picker__submit"
              disabled={!canCall}
              onClick={call}
            >
              {video ? <VideoIcon aria-hidden="true" /> : <PhoneIcon aria-hidden="true" />}
              {t('calls.pickerCall')}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

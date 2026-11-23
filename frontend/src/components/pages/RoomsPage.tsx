import { useEffect, useState, type FormEvent } from 'react';
import type { ApiError } from '../../api/problem';
import type { Room } from '../../api/types';
import { describeError } from '../../domain/errors';
import { t, type MessageKey } from '../../i18n/ru';
import {
  ROOMS_POLL_INTERVAL_MS,
  type RoomsActionKind,
  type RoomsState,
} from '../../rooms/roomsStore';
import { useChatState, useChatStore, useRoomsState, useRoomsStore } from '../../store/ChatProvider';
import { Avatar } from '../Avatar';
import { CloseIcon, PlusIcon, VideoIcon } from '../Icons';
import { PageShell } from './PageShell';

interface RoomsPageProps {
  onBack: () => void;
}

const CALL_ISSUE_KEYS: Record<NonNullable<RoomsState['callIssue']>['reason'], MessageKey> = {
  offline: 'rooms.call.offline',
  busy: 'rooms.call.busy',
  unavailable: 'rooms.call.unavailable',
};

/** 1..120 code points after trim; the server owns the same rule. */
function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return t('rooms.create.empty');
  if ([...trimmed].length > 120) return t('rooms.create.tooLong');
  return null;
}

/**
 * #105 error copy. Contract codes are mapped to their exact cause instead of a
 * generic failure: the room list is the only server read, so the UI never
 * invents a participant, a room or a call result.
 */
function roomErrorText(error: ApiError, kind: RoomsActionKind): string {
  if (error.code === 'E2EE_GROUP_NOT_SUPPORTED') return t('rooms.create.e2ee');
  if (error.code === 'CHAT_LIMIT_REACHED') {
    const scope =
      error.details?.scope === 'WORKSPACE'
        ? t('rooms.create.limitScopeWorkspace')
        : t('rooms.create.limitScopeUser');
    return t('rooms.create.limit', { scope });
  }
  if (error.code === 'ROOM_CLOSED') return t('rooms.presence.closed');
  if (error.code === 'VALIDATION_FAILED') return t('rooms.error.invalidName');
  if (error.status === 403) return t('rooms.error.forbidden');
  if (error.status === 404) return t('rooms.error.notFound');
  if (error.status === 400 || error.status === 422) return t('rooms.error.invalidName');
  switch (kind) {
    case 'create':
      return t('rooms.create.error');
    case 'rename':
      return t('rooms.rename.error');
    case 'close':
      return t('rooms.close.error');
    case 'join':
      return t('rooms.join.error');
    case 'leave':
      return t('rooms.leave.error');
  }
}

function presenceErrorText(error: ApiError): string {
  if (error.code === 'ROOM_CLOSED') return t('rooms.presence.closed');
  if (error.status === 404) return t('rooms.error.notFound');
  return describeError(error).message || t('rooms.presence.lost');
}

function countLabel(room: Room): string {
  if (room.participant_count === 0) return t('rooms.count.none');
  if (room.participant_count === 1) return t('rooms.count.one');
  return t('rooms.count.many', { count: room.participant_count });
}

/**
 * #105 «Комнаты» section.
 *
 * The page owns only view state; the store owns polling (every 5 s),
 * heartbeat (every 5 s while present), presence DELETE on leave/unmount and the
 * mesh-call bridge. Participants shown here are exactly the rows the server
 * returned inside its 30 s TTL — there are no placeholder or demo people.
 */
export function RoomsPage({ onBack }: RoomsPageProps) {
  const store = useRoomsStore();
  const chatStore = useChatStore();
  const rooms = useRoomsState();
  const state = useChatState();
  const workspaceId = state.activeWorkspaceId ?? state.session?.workspace.id ?? null;
  const workspaceName = state.activeWorkspace?.name ?? state.session?.workspace.name ?? '';
  const selfId = state.user?.id ?? state.session?.user.id ?? null;
  // Dev sessions carry no workspace role in `Session`; `/me` is the contract
  // projection that does. BFF sessions already have `activeWorkspace`.
  const role =
    state.activeWorkspace?.role ??
    state.me?.workspaces.find((workspace) => workspace.id === workspaceId)?.role ??
    null;
  const call = state.call;

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{
    roomId: string;
    name: string;
    error: string | null;
  } | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);

  // `GET /me` is the only contract source of the caller's workspace role. It
  // is read once when the session projection lacks it (dev mode).
  useEffect(() => {
    if (state.activeWorkspace === null && state.me === null) void chatStore.loadProfile();
  }, [chatStore, state.activeWorkspace, state.me]);

  // Bind the read model to the active workspace and perform the first read.
  useEffect(() => {
    store.setWorkspace(workspaceId);
    // A re-entry refreshes immediately instead of showing a stale cached list
    // until the first poll tick.
    void store.load(true);
  }, [store, workspaceId]);

  // Contract §4: poll the list every 5 s; a hidden tab skips the read and
  // catches up when it becomes visible again.
  useEffect(() => {
    if (!workspaceId) return;
    const interval = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void store.load(true);
    }, ROOMS_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [store, workspaceId]);

  // Leaving the section stops the heartbeat, hangs up a room call and DELETEs
  // presence; the server TTL is only the fallback when the DELETE loses a race.
  useEffect(() => {
    return () => store.detach();
  }, [store]);

  const pending = rooms.pending;
  const busy = pending !== null;
  const canRename = (room: Room): boolean =>
    role === 'OWNER' || role === 'ADMIN' || (selfId !== null && room.created_by === selfId);
  const canClose = (room: Room): boolean =>
    role === 'OWNER' || (selfId !== null && room.created_by === selfId);
  const isPresent = (room: Room): boolean => store.isPresent(room);
  const callForRoom = (room: Room): boolean =>
    call.phase !== 'idle' && call.chatId !== null && call.chatId === room.chat_id;
  const activeCallRoom = rooms.items.find((room) => callForRoom(room)) ?? null;
  const actionError = rooms.actionError;
  const actionErrorText =
    actionError !== null ? roomErrorText(actionError.error, actionError.kind) : null;

  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const error = validateName(createName);
    setCreateError(error);
    if (error) return;
    const ok = await store.createRoom(createName);
    if (!ok) return;
    setCreateOpen(false);
    setCreateName('');
    setCreateError(null);
  };

  const submitRename = async (event: FormEvent<HTMLFormElement>, room: Room) => {
    event.preventDefault();
    if (!renaming) return;
    const error = validateName(renaming.name);
    if (error) {
      setRenaming({ ...renaming, error });
      return;
    }
    const ok = await store.renameRoom(room.id, renaming.name);
    if (ok) setRenaming(null);
  };

  const join = async (room: Room) => {
    await store.joinRoom(room.id);
  };

  const leave = async () => {
    await store.leaveRoom();
  };

  const confirmClose = async (room: Room) => {
    const ok = await store.closeRoom(room.id);
    if (ok) setClosingId(null);
  };

  return (
    <PageShell
      title={t('rooms.title')}
      eyebrow={workspaceName}
      subtitle={t('rooms.subtitle')}
      onBack={onBack}
      actions={
        <button
          type="button"
          className="btn btn--accent"
          onClick={() => {
            setCreateError(null);
            setCreateOpen((open) => !open);
          }}
          aria-expanded={createOpen}
          aria-controls="rooms-create"
        >
          <PlusIcon aria-hidden="true" />
          <span>{t('rooms.create.open')}</span>
        </button>
      }
    >
      <p className="visually-hidden" role="status" aria-live="polite">
        {activeCallRoom !== null ? t('rooms.call.announce', { name: activeCallRoom.name }) : ''}
      </p>

      {createOpen ? (
        <form
          id="rooms-create"
          className="room-create"
          onSubmit={(event) => void submitCreate(event)}
          aria-labelledby="rooms-create-title"
        >
          <h2 className="room-create__title" id="rooms-create-title">
            {t('rooms.create.heading')}
          </h2>
          <label className="field">
            <span className="field__label">{t('rooms.create.label')}</span>
            <input
              className="input"
              type="text"
              value={createName}
              autoFocus
              placeholder={t('rooms.create.placeholder')}
              onChange={(event) => {
                setCreateName(event.target.value);
                if (createError) setCreateError(null);
              }}
              aria-invalid={createError !== null}
              aria-describedby={createError ? 'rooms-create-error' : undefined}
            />
          </label>
          {createError ? (
            <p className="field__error" id="rooms-create-error" role="alert">
              {createError}
            </p>
          ) : null}
          <div className="room-create__actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setCreateOpen(false);
                setCreateName('');
                setCreateError(null);
                store.clearActionError();
              }}
            >
              {t('rooms.create.cancel')}
            </button>
            <button type="submit" className="btn btn--accent" disabled={busy}>
              {pending?.kind === 'create' ? t('rooms.create.submitting') : t('rooms.create.submit')}
            </button>
          </div>
        </form>
      ) : null}

      {rooms.status === 'error' ? (
        <div className="card pg-error" role="alert">
          <p>{t('rooms.error')}</p>
          <button type="button" className="btn btn--sm" onClick={() => void store.load(true)}>
            {t('rooms.retry')}
          </button>
        </div>
      ) : null}

      {rooms.refreshError !== null && rooms.status === 'ready' ? (
        <div className="pg-inline-error" role="status">
          <p>{t('rooms.refreshError')}</p>
          <button type="button" className="btn btn--sm" onClick={() => void store.load(true)}>
            {t('rooms.retry')}
          </button>
        </div>
      ) : null}

      {rooms.presenceStatus === 'error' && rooms.presenceError !== null ? (
        <div className="pg-inline-error" role="alert">
          <p>{presenceErrorText(rooms.presenceError)}</p>
        </div>
      ) : null}

      {actionError !== null && actionError.roomId === null ? (
        <div className="pg-inline-error" role="alert">
          <p>{actionErrorText}</p>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => store.clearActionError()}
            aria-label={t('rooms.dismiss')}
            title={t('rooms.dismiss')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {rooms.status === 'loading' && rooms.items.length === 0 ? (
        <p className="rooms-loading" role="status">
          {t('rooms.loading')}
        </p>
      ) : null}

      {rooms.status === 'ready' && rooms.items.length === 0 ? (
        <div className="rooms-empty">
          <h2>{t('rooms.empty')}</h2>
          <p>{t('rooms.emptyHint')}</p>
          <button
            type="button"
            className="btn btn--accent"
            onClick={() => {
              setCreateError(null);
              setCreateOpen(true);
            }}
          >
            <PlusIcon aria-hidden="true" />
            <span>{t('rooms.create.open')}</span>
          </button>
        </div>
      ) : null}

      {rooms.items.length > 0 ? (
        <ul className="room-grid" aria-label={t('rooms.title')}>
          {rooms.items.map((room) => {
            const present = isPresent(room);
            const inCall = callForRoom(room);
            const joining = pending?.kind === 'join' && pending.roomId === room.id;
            const leaving = pending?.kind === 'leave' && pending.roomId === room.id;
            const renamingThis = pending?.kind === 'rename' && pending.roomId === room.id;
            const closingThis = pending?.kind === 'close' && pending.roomId === room.id;
            const issue = rooms.callIssue?.roomId === room.id ? rooms.callIssue.reason : null;
            const errorHere =
              actionError !== null && actionError.roomId === room.id ? actionErrorText : null;
            const nameId = `room-name-${room.id}`;
            return (
              <li className="room-card" key={room.id}>
                <div className="room-card__head">
                  <div className="room-card__titles">
                    <h2 className="room-card__name" id={nameId}>
                      {room.name}
                    </h2>
                    <div className="room-card__chips">
                      {present ? (
                        <span className="chip chip--accent">{t('rooms.present')}</span>
                      ) : null}
                      {inCall ? (
                        <span className="chip room-call-chip">
                          <VideoIcon aria-hidden="true" />
                          {call.phase === 'incoming'
                            ? t('rooms.call.incoming')
                            : call.mediaPending || call.phase !== 'connected'
                              ? t('rooms.call.connecting')
                              : t('rooms.call.active')}
                        </span>
                      ) : null}
                      {room.created_by === selfId ? (
                        <span className="chip">{t('rooms.createdByYou')}</span>
                      ) : null}
                    </div>
                  </div>
                  <span className="room-card__count">{countLabel(room)}</span>
                </div>

                {room.participants.length > 0 ? (
                  <ul
                    className="room-people"
                    aria-label={t('rooms.participants.label', { name: room.name })}
                  >
                    {room.participants.map((participant) => (
                      <li className="room-person" key={participant.user_id}>
                        <Avatar
                          name={participant.display_name}
                          seed={participant.user_id}
                          size="xs"
                        />
                        <span className="room-person__name">
                          {participant.display_name}
                          {participant.user_id === selfId ? (
                            <span className="room-person__you">
                              {' '}
                              · {t('rooms.participants.you')}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="room-card__empty">{t('rooms.participants.empty')}</p>
                )}

                {issue !== null ? (
                  <p className="room-card__issue" role="status">
                    {t(CALL_ISSUE_KEYS[issue])}
                  </p>
                ) : null}
                {errorHere !== null ? (
                  <p className="room-card__issue room-card__issue--error" role="alert">
                    {errorHere}
                  </p>
                ) : null}

                {renaming?.roomId === room.id ? (
                  <form
                    className="room-rename"
                    onSubmit={(event) => void submitRename(event, room)}
                    aria-label={t('rooms.rename.form', { name: room.name })}
                  >
                    <label className="field">
                      <span className="field__label">
                        {t('rooms.rename.label', { name: room.name })}
                      </span>
                      <input
                        className="input"
                        type="text"
                        value={renaming.name}
                        autoFocus
                        onChange={(event) =>
                          setRenaming({ ...renaming, name: event.target.value, error: null })
                        }
                        aria-invalid={renaming.error !== null}
                      />
                    </label>
                    {renaming.error ? (
                      <p className="field__error" role="alert">
                        {renaming.error}
                      </p>
                    ) : null}
                    <div className="room-create__actions">
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          setRenaming(null);
                          store.clearActionError();
                        }}
                      >
                        {t('rooms.rename.cancel')}
                      </button>
                      <button
                        type="submit"
                        className="btn btn--accent"
                        disabled={busy}
                        aria-describedby={nameId}
                      >
                        {renamingThis ? t('rooms.rename.saving') : t('rooms.rename.save')}
                      </button>
                    </div>
                  </form>
                ) : null}

                {closingId === room.id ? (
                  <div
                    className="room-close"
                    role="group"
                    aria-label={t('rooms.close.question', { name: room.name })}
                  >
                    <p className="room-close__question">
                      {t('rooms.close.question', { name: room.name })}
                    </p>
                    <p className="room-close__hint">{t('rooms.close.hint')}</p>
                    <div className="room-create__actions">
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          setClosingId(null);
                          store.clearActionError();
                        }}
                      >
                        {t('rooms.close.cancel')}
                      </button>
                      <button
                        type="button"
                        className="btn btn--danger"
                        disabled={busy}
                        onClick={() => void confirmClose(room)}
                      >
                        {closingThis ? t('rooms.close.closing') : t('rooms.close.confirm')}
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="room-card__actions">
                  {present ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      aria-label={t('rooms.leaveAction', { name: room.name })}
                      aria-busy={leaving}
                      onClick={() => void leave()}
                    >
                      {leaving ? t('rooms.leaving') : t('rooms.leave')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--accent"
                      disabled={busy}
                      aria-label={t('rooms.joinAction', { name: room.name })}
                      aria-busy={joining}
                      onClick={() => void join(room)}
                    >
                      {joining ? t('rooms.joining') : t('rooms.join')}
                    </button>
                  )}
                  {canRename(room) ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy || closingId === room.id}
                      aria-label={t('rooms.renameAction', { name: room.name })}
                      onClick={() => {
                        store.clearActionError();
                        setClosingId(null);
                        setRenaming({ roomId: room.id, name: room.name, error: null });
                      }}
                    >
                      {t('rooms.rename')}
                    </button>
                  ) : null}
                  {canClose(room) ? (
                    <button
                      type="button"
                      className="btn btn--danger"
                      disabled={busy || renaming?.roomId === room.id}
                      aria-label={t('rooms.closeAction', { name: room.name })}
                      onClick={() => {
                        store.clearActionError();
                        setRenaming(null);
                        setClosingId(room.id);
                      }}
                    >
                      {t('rooms.close')}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </PageShell>
  );
}

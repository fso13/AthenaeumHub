import { useEffect, useId, useState, type FormEvent } from 'react';
import type {
  ChatInvite,
  ChatInviteCreated,
  ChatInviteRole,
  ChatInviteStatus,
  ChatMemberRole,
} from '../../api/types';
import { t, type MessageKey } from '../../i18n/ru';
import { createEmptyChatInvitesState, isChatManagerRole } from '../../store/chatStore';
import { useChatState, useChatStore } from '../../store/ChatProvider';
import { AdminConfirmDialog } from '../admin/AdminConfirmDialog';
import type { AdminActionErrorInfo } from '../admin/actionErrors';
import { formatDateTime } from '../admin/format';
import { CopyIcon, LinkIcon, RefreshIcon } from '../Icons';
import { chatInviteErrorText } from './errors';

const STATUS_LABEL: Record<ChatInviteStatus, MessageKey> = {
  ACTIVE: 'chatInvites.status.ACTIVE',
  EXPIRED: 'chatInvites.status.EXPIRED',
  EXHAUSTED: 'chatInvites.status.EXHAUSTED',
  REVOKED: 'chatInvites.status.REVOKED',
};

const ROLE_LABEL: Record<ChatInviteRole, MessageKey> = {
  ADMIN: 'chatMembers.role.ADMIN',
  MODERATOR: 'chatMembers.role.MODERATOR',
  MEMBER: 'chatMembers.role.MEMBER',
  GUEST: 'chatMembers.role.GUEST',
};

/** Contract bounds: 300…2592000 seconds; the default is 7 days. */
const EXPIRY_OPTIONS = [
  { value: '3600', label: 'chatInvites.expiry.1h' },
  { value: '86400', label: 'chatInvites.expiry.1d' },
  { value: '604800', label: 'chatInvites.expiry.7d' },
  { value: '2592000', label: 'chatInvites.expiry.30d' },
] as const satisfies ReadonlyArray<{ value: string; label: MessageKey }>;

const MAX_USES_OPTIONS = [
  { value: 'unlimited', label: 'chatInvites.maxUses.unlimited' },
  { value: '1', label: 'chatInvites.maxUses.one' },
  { value: '5', label: 'chatInvites.maxUses.five' },
  { value: '10', label: 'chatInvites.maxUses.ten' },
  { value: '25', label: 'chatInvites.maxUses.twentyFive' },
  { value: '100', label: 'chatInvites.maxUses.hundred' },
] as const satisfies ReadonlyArray<{ value: string; label: MessageKey }>;

type ExpiryValue = (typeof EXPIRY_OPTIONS)[number]['value'];
type MaxUsesValue = (typeof MAX_USES_OPTIONS)[number]['value'];

/** OWNER cannot be granted by a link; ADMIN cannot mint ADMIN links. */
function assignableInviteRoles(actorRole: ChatMemberRole | null): ChatInviteRole[] {
  if (actorRole === 'OWNER') return ['ADMIN', 'MODERATOR', 'MEMBER', 'GUEST'];
  if (actorRole === 'ADMIN') return ['MODERATOR', 'MEMBER', 'GUEST'];
  return [];
}

/** The accept route is client-side; the raw token is the only path segment. */
function inviteUrl(token: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin.replace(/\/$/, '');
  return `${origin}/invite/${token}`;
}

function revokeErrorInfo(error: Parameters<typeof chatInviteErrorText>[0]): AdminActionErrorInfo {
  return {
    text: chatInviteErrorText(error),
    tone: 'error',
    retryable: error.isNetwork || error.status >= 500,
    closeOnError: false,
  };
}

export interface ChatInvitesPanelProps {
  chatId: string;
  /** Viewer's channel role, not the workspace role. */
  actorRole: ChatMemberRole | null;
  /** `main` is the compact link row; `members` is the full manager panel. */
  variant?: 'main' | 'members';
  /** Main-tab shortcut to the members tab where the full form lives. */
  onOpenMembers?: () => void;
  /** Keeps the parent Escape/focus trap out of a nested confirm dialog. */
  onNestedModalChange?: (open: boolean) => void;
}

type CopyState = 'idle' | 'copied' | 'error';

/**
 * #79 invite links.
 *
 * - The metadata list comes from `GET /chats/{id}/invites`; the raw token is
 *   shown exactly once from `POST` (`created`) and never appears in the list.
 * - Role/expiry/max-uses values are constrained by the contract; OWNER is not
 *   assignable through a link and ADMIN cannot mint ADMIN links.
 * - Revoke asks for confirmation and only marks `REVOKED` after a `204`.
 * - No email invitation exists anywhere in this flow.
 */
export function ChatInvitesPanel({
  chatId,
  actorRole,
  variant = 'members',
  onOpenMembers,
  onNestedModalChange,
}: ChatInvitesPanelProps) {
  const store = useChatStore();
  const state = useChatState();
  const invitesState = state.chatInvites.chatId === chatId ? state.chatInvites : null;
  const invites = invitesState ?? createEmptyChatInvitesState();
  const canManage = isChatManagerRole(actorRole);
  const roleOptions = assignableInviteRoles(actorRole);

  const [role, setRole] = useState<ChatInviteRole>('MEMBER');
  const [expiry, setExpiry] = useState<ExpiryValue>('604800');
  const [maxUses, setMaxUses] = useState<MaxUsesValue>('unlimited');
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [revokeTarget, setRevokeTarget] = useState<ChatInvite | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const titleId = useId();
  const roleId = useId();
  const expiryId = useId();
  const maxUsesId = useId();
  const linkId = useId();

  useEffect(() => {
    if (variant !== 'members' || !canManage) return;
    if (invites.chatId === chatId && invites.status !== 'idle') return;
    void store.loadChatInvites(chatId);
  }, [chatId, canManage, invites.chatId, invites.status, store, variant]);

  useEffect(() => {
    if (roleOptions.includes(role)) return;
    setRole(roleOptions[0] ?? 'MEMBER');
  }, [role, roleOptions]);

  useEffect(() => {
    // A new token is a new copy target: reset the previous copy feedback.
    setCopyState('idle');
  }, [invites.created?.id]);

  useEffect(() => {
    onNestedModalChange?.(revokeTarget !== null);
  }, [onNestedModalChange, revokeTarget]);

  const url = invites.created ? inviteUrl(invites.created.token) : '';
  const createError = invites.createStatus === 'error' ? invites.createError : null;
  const listError = invites.status === 'error' ? invites.error : null;
  const revokeError =
    revokeTarget && invites.revokeError?.inviteId === revokeTarget.id
      ? invites.revokeError.error
      : null;
  const creating = invites.createStatus === 'creating';
  const revoking = revokeTarget !== null && invites.revokePendingId === revokeTarget.id;

  async function handleCopy(value: string): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  }

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage || creating) return;
    setNotice(null);
    await store.createChatInvite(chatId, {
      role,
      expires_in_seconds: Number(expiry),
      ...(maxUses === 'unlimited' ? {} : { max_uses: Number(maxUses) }),
    });
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    const ok = await store.revokeChatInvite(chatId, revokeTarget.id);
    if (ok) {
      setRevokeTarget(null);
      setNotice(t('chatInvites.revoked'));
    }
  };

  const createdBlock = (created: ChatInviteCreated) => {
    const createdUrl = inviteUrl(created.token);
    return (
      <div className="invite-created" role="status">
        <p className="invite-created__note">{t('chatInvites.created')}</p>
        <div className="invite-row">
          <input
            id={linkId}
            className="input"
            readOnly
            value={createdUrl}
            aria-label={t('chatInvites.linkLabel')}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button type="button" className="btn btn--sm" onClick={() => void handleCopy(createdUrl)}>
            <CopyIcon aria-hidden="true" />
            {t('chatInvites.copy')}
          </button>
        </div>
        <p className="field__meta">
          {copyState === 'copied'
            ? t('chatInvites.copied')
            : copyState === 'error'
              ? t('chatInvites.copyError')
              : t('chatInvites.hint')}
        </p>
      </div>
    );
  };

  if (variant === 'main') {
    return (
      <div className="form-row">
        <label htmlFor={`${linkId}-main`}>{t('chatInvites.linkLabel')}</label>
        {!canManage ? (
          <p className="pane-sub">{t('chatInvites.manageReadOnly')}</p>
        ) : invites.created ? (
          <>
            <div className="invite-row">
              <input
                id={`${linkId}-main`}
                className="input"
                readOnly
                value={url}
                aria-label={t('chatInvites.linkLabel')}
                onFocus={(event) => event.currentTarget.select()}
              />
              <button type="button" className="btn btn--sm" onClick={() => void handleCopy(url)}>
                <CopyIcon aria-hidden="true" />
                {t('chatInvites.copy')}
              </button>
            </div>
            <p className="field__meta">
              {copyState === 'copied'
                ? t('chatInvites.copied')
                : copyState === 'error'
                  ? t('chatInvites.copyError')
                  : t('chatInvites.created')}
            </p>
          </>
        ) : (
          <>
            <p className="pane-sub">{t('chatInvites.mainHint')}</p>
            {onOpenMembers ? (
              <button type="button" className="btn btn--sm" onClick={onOpenMembers}>
                <LinkIcon aria-hidden="true" />
                {t('chatInvites.open')}
              </button>
            ) : null}
          </>
        )}
      </div>
    );
  }

  return (
    <section className="chat-settings-section" aria-labelledby={titleId}>
      <h3 className="chat-settings-section__title" id={titleId}>
        {t('chatInvites.title')}
      </h3>
      <p className="pane-sub">{t('chatInvites.hint')}</p>

      {notice ? (
        <p className="chat-settings-notice" role="status">
          {notice}
        </p>
      ) : null}

      {!canManage ? (
        <p className="chat-settings-readonly">{t('chatInvites.manageReadOnly')}</p>
      ) : (
        <form className="chat-invites__form" onSubmit={(event) => void handleCreate(event)}>
          <div className="form-grid">
            <div className="form-row">
              <label htmlFor={roleId}>{t('chatInvites.role')}</label>
              <select
                id={roleId}
                className="select"
                value={role}
                disabled={creating}
                onChange={(event) => {
                  if (roleOptions.includes(event.target.value as ChatInviteRole)) {
                    setRole(event.target.value as ChatInviteRole);
                  }
                }}
              >
                {roleOptions.map((option) => (
                  <option key={option} value={option}>
                    {t(ROLE_LABEL[option])}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label htmlFor={expiryId}>{t('chatInvites.expiry')}</label>
              <select
                id={expiryId}
                className="select"
                value={expiry}
                disabled={creating}
                onChange={(event) => setExpiry(event.target.value as ExpiryValue)}
              >
                {EXPIRY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.label)}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label htmlFor={maxUsesId}>{t('chatInvites.maxUses')}</label>
              <select
                id={maxUsesId}
                className="select"
                value={maxUses}
                disabled={creating}
                onChange={(event) => setMaxUses(event.target.value as MaxUsesValue)}
              >
                {MAX_USES_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.label)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {createError ? (
            <p className="chat-settings-error" role="alert">
              {chatInviteErrorText(createError)}
            </p>
          ) : null}
          <div className="form-actions">
            <button type="submit" className="btn btn--accent" disabled={creating}>
              <LinkIcon aria-hidden="true" />
              {creating ? t('chatInvites.creating') : t('chatInvites.create')}
            </button>
          </div>
        </form>
      )}

      {invites.created ? createdBlock(invites.created) : null}

      {canManage ? (
        <div className="chat-invites__list">
          <div className="chat-invites__list-head">
            <h4>{t('chatInvites.listTitle')}</h4>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void store.loadChatInvites(chatId, true)}
              disabled={invites.status === 'loading'}
            >
              <RefreshIcon aria-hidden="true" />
              {t('blocked.refresh')}
            </button>
          </div>

          {invites.status === 'loading' && invites.items.length === 0 ? (
            <p className="card-empty" role="status">
              {t('chatInvites.loading')}
            </p>
          ) : null}

          {listError ? (
            <div className="members-list__state" role="alert">
              <p>{chatInviteErrorText(listError)}</p>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void store.loadChatInvites(chatId, true)}
              >
                {t('common.retry')}
              </button>
            </div>
          ) : null}

          {invites.status === 'ready' && invites.items.length === 0 ? (
            <p className="card-empty" role="status">
              {t('chatInvites.empty')}
            </p>
          ) : null}

          {invites.items.length > 0 ? (
            <ul className="chat-invites__items">
              {invites.items.map((invite) => {
                const isActive = invite.status === 'ACTIVE';
                return (
                  <li className="chat-invite" key={invite.id}>
                    <div className="chat-invite__body">
                      <span className="chat-invite__role">{t(ROLE_LABEL[invite.role])}</span>
                      <span className={`members-row__role members-row__role--${invite.status}`}>
                        {t(STATUS_LABEL[invite.status])}
                      </span>
                      <span className="chat-invite__meta">
                        {invite.max_uses === null
                          ? t('chatInvites.usesUnlimited', { used: invite.used_count })
                          : t('chatInvites.uses', {
                              used: invite.used_count,
                              max: invite.max_uses,
                            })}
                        {' · '}
                        {t('chatInvites.expires', {
                          date: formatDateTime(invite.expires_at),
                        })}
                      </span>
                      <span className="chat-invite__meta">
                        {t('chatInvites.createdAt', {
                          date: formatDateTime(invite.created_at),
                        })}
                      </span>
                    </div>
                    {isActive ? (
                      <button
                        type="button"
                        className="btn btn--danger btn--sm"
                        disabled={invites.revokePendingId !== null}
                        onClick={() => setRevokeTarget(invite)}
                        aria-label={`${t('chatInvites.revokeLabel', {
                          date: formatDateTime(invite.created_at),
                        })}`}
                      >
                        {t('chatInvites.revoke')}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}

      {revokeTarget ? (
        <AdminConfirmDialog
          title={t('chatInvites.revokeConfirmTitle')}
          description={
            <>
              <p className="admin-confirm__lead">{t('chatInvites.revokeConfirmLead')}</p>
              <ul className="admin-confirm__list">
                <li>
                  {t('chatInvites.createdAt', {
                    date: formatDateTime(revokeTarget.created_at),
                  })}
                </li>
                <li>
                  {t(ROLE_LABEL[revokeTarget.role])} · {t(STATUS_LABEL[revokeTarget.status])}
                </li>
                <li>{t('chatInvites.revokeConfirmNote')}</li>
              </ul>
            </>
          }
          confirmLabel={t('chatInvites.revoke')}
          busyLabel={t('chatInvites.revoking')}
          cancelLabel={t('common.cancel')}
          destructive
          busy={revoking}
          error={revokeError ? revokeErrorInfo(revokeError) : null}
          errorDetails={revokeError}
          onConfirm={() => void handleRevoke()}
          onClose={() => {
            if (revoking) return;
            setRevokeTarget(null);
          }}
        />
      ) : null}
    </section>
  );
}

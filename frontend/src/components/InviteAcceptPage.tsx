import { useEffect, useState } from 'react';
import type { ApiError } from '../api/problem';
import { describeError } from '../domain/errors';
import { t } from '../i18n/ru';
import { useNavigate } from '../router/router';
import { createEmptyInviteAcceptState } from '../store/chatStore';
import { useChatState, useChatStore } from '../store/ChatProvider';
import { PageShell } from './pages/PageShell';

/** Contract pattern for `InviteToken` (`^[A-Za-z0-9_-]{20,128}$`). */
const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

const ROLE_LABEL = {
  OWNER: 'chatMembers.role.OWNER',
  ADMIN: 'chatMembers.role.ADMIN',
  MODERATOR: 'chatMembers.role.MODERATOR',
  MEMBER: 'chatMembers.role.MEMBER',
  GUEST: 'chatMembers.role.GUEST',
} as const;

/** `410` has three distinct contract codes; they must not collapse into one. */
function inviteAcceptErrorText(error: ApiError): string {
  if (error.status === 410) {
    if (error.code === 'INVITE_EXPIRED') return t('inviteAccept.expired');
    if (error.code === 'INVITE_REVOKED') return t('inviteAccept.revoked');
    if (error.code === 'INVITE_EXHAUSTED') return t('inviteAccept.exhausted');
    return t('inviteAccept.invalidToken');
  }
  if (error.status === 404) return t('inviteAccept.notFound');
  if (error.status === 403) return t('inviteAccept.forbidden');
  if (error.status === 429) return t('inviteAccept.rateLimited');
  if (error.isNetwork || error.status >= 500) return describeError(error).message;
  return t('inviteAccept.error');
}

export interface InviteAcceptPageProps {
  /** Parsed `/invite/:token` segment; `null` means the URL is malformed. */
  token: string | null;
}

/**
 * #79 `/invite/:token` accept screen.
 *
 * It is rendered by `App` for both auth contours before the chat workspace, so
 * the authenticated user can join with the channel role carried by the link.
 * The button is explicit (no silent join); expired/revoked/exhausted links are
 * explained from their server codes and the server stays authoritative.
 */
export function InviteAcceptPage({ token }: InviteAcceptPageProps) {
  const store = useChatStore();
  const state = useChatState();
  const navigate = useNavigate();
  const [openFailed, setOpenFailed] = useState(false);

  const validToken = token !== null && INVITE_TOKEN_RE.test(token);
  const current =
    validToken && state.inviteAccept.token === token
      ? state.inviteAccept
      : createEmptyInviteAcceptState();
  const accepting = current.status === 'accepting';
  const accepted = current.status === 'accepted' ? current.result : null;
  const error = current.status === 'error' ? current.error : null;
  const sessionReady = state.sessionStatus === 'ready';

  useEffect(() => {
    if (!validToken) return;
    if (state.inviteAccept.token !== null && state.inviteAccept.token !== token) {
      store.resetInviteAccept();
    }
  }, [state.inviteAccept.token, store, token, validToken]);

  const handleAccept = async () => {
    if (!validToken || token === null || accepting) return;
    setOpenFailed(false);
    await store.acceptChatInvite(token);
  };

  const handleOpen = async () => {
    if (!accepted) return;
    const ok = await store.openInviteTarget(accepted);
    if (ok) {
      navigate('/');
    } else {
      setOpenFailed(true);
    }
  };

  const tokenPreview =
    token && token.length > 16 ? `${token.slice(0, 8)}…${token.slice(-4)}` : token;

  return (
    <PageShell
      title={t('inviteAccept.title')}
      eyebrow={t('app.name')}
      subtitle={t('inviteAccept.lead')}
      onBack={() => navigate('/')}
    >
      <div className="invite-accept">
        <section className="card invite-accept__card" aria-labelledby="invite-accept-state">
          <h2 className="card-title" id="invite-accept-state">
            {t('inviteAccept.details')}
          </h2>

          {!validToken ? (
            <p className="chat-settings-error" role="alert">
              {t('inviteAccept.invalidToken')}
            </p>
          ) : (
            <>
              <div className="invite-accept__token">
                <span>{t('inviteAccept.token')}</span>
                <code>{tokenPreview}</code>
              </div>

              {accepted ? (
                <div className="invite-accept__result" role="status">
                  <p className="chat-settings-notice">
                    {accepted.already_member
                      ? t('inviteAccept.already')
                      : t('inviteAccept.success')}
                  </p>
                  <p className="pane-sub">
                    {t('inviteAccept.role', {
                      role: t(ROLE_LABEL[accepted.role]),
                    })}
                  </p>
                  {openFailed ? (
                    <p className="chat-settings-error" role="alert">
                      {t('inviteAccept.openFailed')}
                    </p>
                  ) : null}
                  <div className="form-actions">
                    <button
                      type="button"
                      className="btn btn--accent"
                      onClick={() => void handleOpen()}
                    >
                      {t('inviteAccept.open')}
                    </button>
                    <button type="button" className="btn" onClick={() => navigate('/')}>
                      {t('inviteAccept.toChats')}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {error ? (
                    <p className="chat-settings-error" role="alert">
                      {inviteAcceptErrorText(error)}
                    </p>
                  ) : null}
                  {!sessionReady ? (
                    <p className="card-empty" role="status">
                      {t('inviteAccept.waiting')}
                    </p>
                  ) : null}
                  <div className="form-actions">
                    <button
                      type="button"
                      className="btn btn--accent"
                      disabled={!sessionReady || accepting}
                      aria-busy={accepting}
                      onClick={() => void handleAccept()}
                    >
                      {accepting ? t('inviteAccept.accepting') : t('inviteAccept.cta')}
                    </button>
                    {error ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={!sessionReady || accepting}
                        onClick={() => void handleAccept()}
                      >
                        {t('inviteAccept.retry')}
                      </button>
                    ) : (
                      <button type="button" className="btn" onClick={() => navigate('/')}>
                        {t('inviteAccept.toChats')}
                      </button>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </section>
      </div>
    </PageShell>
  );
}

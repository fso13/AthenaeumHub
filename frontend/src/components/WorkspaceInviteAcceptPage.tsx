import { useState } from 'react';
import type { ApiError } from '../api/problem';
import type { WorkspaceInviteAcceptance } from '../api/types';
import { describeError } from '../domain/errors';
import { t } from '../i18n/ru';
import { useNavigate } from '../router/router';
import { useChatStore } from '../store/ChatProvider';
import { PageShell } from './pages/PageShell';

/** Contract pattern for `InviteToken` (`^[A-Za-z0-9_-]{20,128}$`). */
const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

const ROLE_LABEL = {
  OWNER: 'members.role.OWNER',
  ADMIN: 'members.role.ADMIN',
  MEMBER: 'members.role.MEMBER',
  GUEST: 'members.role.GUEST',
} as const;

/** `410` has three distinct contract codes; they are never collapsed. */
function acceptErrorText(error: ApiError): string {
  if (error.status === 410) {
    if (error.code === 'WORKSPACE_INVITE_EXPIRED') return t('workspaceAccept.expired');
    if (error.code === 'WORKSPACE_INVITE_REVOKED') return t('workspaceAccept.revoked');
    if (error.code === 'WORKSPACE_INVITE_EXHAUSTED') return t('workspaceAccept.exhausted');
    return t('workspaceAccept.invalidToken');
  }
  if (error.status === 404) return t('workspaceAccept.notFound');
  if (error.status === 403) return t('workspaceAccept.forbidden');
  if (error.status === 429) return t('workspaceAccept.rateLimited');
  if (error.isNetwork || error.status >= 500) return describeError(error).message;
  return t('workspaceAccept.error');
}

export interface WorkspaceInviteAcceptPageProps {
  /** Parsed `/workspace-invite/:token` segment; `null` means a malformed URL. */
  token: string | null;
}

/**
 * P0-4 (#82) `/workspace-invite/:token` accept screen.
 *
 * The inviter copies this client-side link (no email is sent). Accepting is an
 * explicit action: the server atomically enforces expiry/usage/revocation and
 * answers an existing ACTIVE member idempotently. The workspace is then opened
 * so the joined space is visible immediately.
 */
export function WorkspaceInviteAcceptPage({ token }: WorkspaceInviteAcceptPageProps) {
  const store = useChatStore();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'idle' | 'accepting' | 'accepted' | 'error'>('idle');
  const [acceptance, setAcceptance] = useState<WorkspaceInviteAcceptance | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const validToken = token !== null && INVITE_TOKEN_RE.test(token);
  const tokenPreview =
    token && token.length > 16 ? `${token.slice(0, 8)}…${token.slice(-4)}` : token;

  const handleAccept = async () => {
    if (!validToken || token === null || status === 'accepting') return;
    setStatus('accepting');
    setError(null);
    const result = await store.acceptWorkspaceInvite(token);
    if (result.acceptance) {
      setAcceptance(result.acceptance);
      setStatus('accepted');
      return;
    }
    setError(result.error);
    setStatus('error');
  };

  return (
    <PageShell
      title={t('workspaceAccept.title')}
      eyebrow={t('app.name')}
      subtitle={t('workspaceAccept.lead')}
      onBack={() => navigate('/')}
    >
      <div className="invite-accept">
        <section className="card invite-accept__card" aria-labelledby="workspace-invite-state">
          <h2 className="card-title" id="workspace-invite-state">
            {t('workspaceAccept.details')}
          </h2>

          {!validToken ? (
            <p className="chat-settings-error" role="alert">
              {t('workspaceAccept.invalidToken')}
            </p>
          ) : (
            <>
              <div className="invite-accept__token">
                <span>{t('workspaceAccept.token')}</span>
                <code>{tokenPreview}</code>
              </div>

              {status === 'accepted' && acceptance ? (
                <div className="invite-accept__result" role="status">
                  <p className="chat-settings-notice">
                    {acceptance.already_member
                      ? t('workspaceAccept.already', { name: acceptance.name })
                      : t('workspaceAccept.success', { name: acceptance.name })}
                  </p>
                  <p className="pane-sub">
                    {t('workspaceAccept.role', {
                      role: t(ROLE_LABEL[acceptance.role]),
                    })}
                  </p>
                  <div className="form-actions">
                    <button type="button" className="btn btn--accent" onClick={() => navigate('/')}>
                      {t('workspaceAccept.open')}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {status === 'error' && error ? (
                    <p className="chat-settings-error" role="alert">
                      {acceptErrorText(error)}
                    </p>
                  ) : null}
                  <p className="pane-sub">{t('workspaceAccept.joinHint')}</p>
                  <div className="form-actions">
                    <button
                      type="button"
                      className="btn btn--accent"
                      disabled={status === 'accepting'}
                      onClick={() => void handleAccept()}
                    >
                      {status === 'accepting'
                        ? t('workspaceAccept.joining')
                        : t('workspaceAccept.join')}
                    </button>
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

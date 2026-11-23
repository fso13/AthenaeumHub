import { useEffect, useState } from 'react';
import type { ApiError } from '../api/problem';
import type { WorkspaceInviteAcceptance, WorkspaceInvitePreview } from '../api/types';
import { describeError } from '../domain/errors';
import { t } from '../i18n/ru';
import { INVITE_TOKEN_RE, withInviteToken } from '../router/inviteRoutes';
import { useNavigate } from '../router/router';
import { useChatStore } from '../store/ChatProvider';
import { formatDateTime } from './admin/format';
import { PageShell } from './pages/PageShell';

const ROLE_LABEL = {
  OWNER: 'members.role.OWNER',
  ADMIN: 'members.role.ADMIN',
  MEMBER: 'members.role.MEMBER',
  GUEST: 'members.role.GUEST',
} as const;

/** `410` has three distinct contract codes; they are never collapsed. */
function inviteErrorText(error: ApiError | null, fallback: string): string {
  if (!error) return fallback;
  if (error.status === 410) {
    if (error.code === 'WORKSPACE_INVITE_EXPIRED') return t('workspaceAccept.expired');
    if (error.code === 'WORKSPACE_INVITE_REVOKED') return t('workspaceAccept.revoked');
    if (error.code === 'WORKSPACE_INVITE_EXHAUSTED') return t('workspaceAccept.exhausted');
    return t('workspaceAccept.invalidToken');
  }
  if (error.status === 404) return t('workspaceAccept.notFound');
  if (error.status === 403) {
    return error.code === 'WORKSPACE_INVITE_EMAIL_MISMATCH'
      ? t('workspaceAccept.emailMismatch')
      : t('workspaceAccept.forbidden');
  }
  if (error.status === 429) return t('workspaceAccept.rateLimited');
  if (error.isNetwork || error.status >= 500) return describeError(error).message;
  return fallback;
}

export interface WorkspaceInviteAcceptPageProps {
  /** Parsed `/workspace-invite/:token` segment; `null` means a malformed URL. */
  token: string | null;
  /**
   * #100: anonymous visitors see the public preview plus sign-in/register
   * actions. The same page renders the accept action after authentication.
   */
  anonymous?: boolean;
}

/**
 * #79/#100 `/workspace-invite/:token` screen.
 *
 * The preview is a public, display-only read (`GET /workspace-invites/{token}`):
 * workspace name/slug, role, `email_bound` and expiry — no token, hash or
 * invited address. Accepting is an explicit authenticated action; the server
 * atomically enforces expiry/usage/revocation, binds email invites to the
 * matching account and answers an existing ACTIVE member idempotently.
 */
export function WorkspaceInviteAcceptPage({
  token,
  anonymous = false,
}: WorkspaceInviteAcceptPageProps) {
  const store = useChatStore();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<WorkspaceInvitePreview | null>(null);
  const [previewStatus, setPreviewStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState<'idle' | 'accepting' | 'accepted' | 'error'>('idle');
  const [acceptance, setAcceptance] = useState<WorkspaceInviteAcceptance | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const validToken = token !== null && INVITE_TOKEN_RE.test(token);
  const signInPath = token ? withInviteToken('/login', token) : '/login';
  const registerPath = token ? withInviteToken('/register', token) : '/register';

  useEffect(() => {
    if (!validToken || token === null) {
      setPreview(null);
      setPreviewError(null);
      setPreviewStatus('error');
      return;
    }
    let cancelled = false;
    setPreviewStatus('loading');
    setPreviewError(null);
    void store.previewWorkspaceInvite(token).then((result) => {
      if (cancelled) return;
      if (result.preview) {
        setPreview(result.preview);
        setPreviewStatus('ready');
        return;
      }
      setPreview(null);
      setPreviewError(result.error);
      setPreviewStatus('error');
    });
    return () => {
      cancelled = true;
    };
  }, [store, token, validToken]);

  const handleAccept = async () => {
    if (!validToken || token === null || status === 'accepting' || previewStatus !== 'ready') {
      return;
    }
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
          ) : previewStatus === 'loading' || previewStatus === 'idle' ? (
            <p className="pane-sub" role="status">
              {t('workspaceAccept.previewLoading')}
            </p>
          ) : previewStatus === 'error' ? (
            <p className="chat-settings-error" role="alert">
              {inviteErrorText(previewError, t('workspaceAccept.previewError'))}
            </p>
          ) : preview ? (
            <>
              <div className="invite-accept__workspace">
                <b>{preview.workspace_name}</b>
                <small>/{preview.workspace_slug}</small>
              </div>
              <p className="pane-sub">
                {t('workspaceAccept.role', {
                  role: t(ROLE_LABEL[preview.role]),
                })}
                {' · '}
                {t('workspaceAccept.expires', { date: formatDateTime(preview.expires_at) })}
              </p>
              <p className="field__meta">
                {preview.email_bound
                  ? t('workspaceAccept.singleUse')
                  : t('workspaceAccept.linkInvite')}
              </p>

              {preview.email_bound ? (
                <div className="chat-settings-notice" role="note">
                  <p>
                    <b>{t('workspaceAccept.emailBound')}</b>
                  </p>
                  <p className="pg-footnote">{t('workspaceAccept.emailBoundHint')}</p>
                </div>
              ) : null}

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
              ) : anonymous ? (
                <>
                  <p className="pane-sub">{t('workspaceAccept.anonymousHint')}</p>
                  <div className="form-actions">
                    <button
                      type="button"
                      className="btn btn--accent"
                      onClick={() => navigate(signInPath)}
                    >
                      {t('workspaceAccept.login')}
                    </button>
                    <button type="button" className="btn" onClick={() => navigate(registerPath)}>
                      {t('workspaceAccept.register')}
                    </button>
                  </div>
                  <p className="pg-footnote">{t('workspaceAccept.secureHint')}</p>
                </>
              ) : (
                <>
                  {status === 'error' && error ? (
                    <p className="chat-settings-error" role="alert">
                      {inviteErrorText(error, t('workspaceAccept.error'))}
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
          ) : null}
        </section>
      </div>
    </PageShell>
  );
}

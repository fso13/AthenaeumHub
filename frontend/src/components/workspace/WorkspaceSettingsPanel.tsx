import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ApiError } from '../../api/problem';
import type {
  WorkspaceInvite,
  WorkspaceInviteCreateRequest,
  WorkspaceInviteRole,
  WorkspaceInviteStatus,
  WorkspacePermissionEntry,
  WorkspacePermissionKey,
  WorkspacePermissionMatrix,
  WorkspacePermissionRole,
  WorkspaceSummary,
  WorkspaceUpdate,
} from '../../api/types';
import { describeError } from '../../domain/errors';
import { safeHttpUrl } from '../../files/format';
import { t, type MessageKey } from '../../i18n/ru';
import { permissionAllowed, WORKSPACE_PERMISSION_KEYS } from '../../profile/profileWorkspaceStore';
import { useProfileWorkspaceState, useProfileWorkspaceStore } from '../../store/ChatProvider';
import { formatDateTime } from '../admin/format';
import { AdminConfirmDialog } from '../admin/AdminConfirmDialog';
import type { AdminActionErrorInfo } from '../admin/actionErrors';
import { ImageFilePicker } from '../ImageFilePicker';
import { CopyIcon, LinkIcon, PeopleIcon, RefreshIcon, ShieldIcon } from '../Icons';

const STATUS_LABEL: Record<WorkspaceInviteStatus, MessageKey> = {
  ACTIVE: 'workspace.invites.status.ACTIVE',
  EXPIRED: 'workspace.invites.status.EXPIRED',
  EXHAUSTED: 'workspace.invites.status.EXHAUSTED',
  REVOKED: 'workspace.invites.status.REVOKED',
};

const ROLE_LABEL: Record<WorkspaceInviteRole | WorkspacePermissionRole, MessageKey> = {
  OWNER: 'members.role.OWNER',
  ADMIN: 'members.role.ADMIN',
  MEMBER: 'members.role.MEMBER',
  GUEST: 'members.role.GUEST',
};

const PERMISSION_LABEL: Record<WorkspacePermissionKey, MessageKey> = {
  manage_workspace: 'workspace.permissions.column.manage_workspace',
  manage_members: 'workspace.permissions.column.manage_members',
  manage_invites: 'workspace.permissions.column.manage_invites',
  manage_permissions: 'workspace.permissions.column.manage_permissions',
  view_audit: 'workspace.permissions.column.view_audit',
  manage_security: 'workspace.permissions.column.manage_security',
};

const EXPIRY_OPTIONS = [
  { value: '86400', label: 'workspace.invites.expiry.oneDay' },
  { value: '604800', label: 'workspace.invites.expiry.sevenDays' },
  { value: '2592000', label: 'workspace.invites.expiry.thirtyDays' },
] as const satisfies ReadonlyArray<{ value: string; label: MessageKey }>;

type ExpiryValue = (typeof EXPIRY_OPTIONS)[number]['value'];

/** OWNER can invite ADMIN/MEMBER/GUEST; ADMIN only MEMBER/GUEST. */
function inviteRoles(actorRole: WorkspacePermissionRole | 'GUEST' | null): WorkspaceInviteRole[] {
  if (actorRole === 'OWNER') return ['ADMIN', 'MEMBER', 'GUEST'];
  if (actorRole === 'ADMIN') return ['MEMBER', 'GUEST'];
  return [];
}

/** The accept route is client-side; the raw token is the only path segment. */
function inviteUrl(token: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin.replace(/\/$/, '');
  return `${origin}/workspace-invite/${token}`;
}

function settingsErrorText(error: ApiError): string {
  if (error.status === 403) return t('workspace.settings.readOnly');
  if (error.status === 429) return t('workspace.invites.error.rateLimited');
  if (error.status === 503 || error.isNetwork) return t('workspace.settings.unavailable');
  if (error.status === 400 || error.status === 422) {
    return error.details?.field === 'name'
      ? t('workspace.settings.validation.nameRequired')
      : error.details?.field === 'description'
        ? t('workspace.settings.validation.descriptionTooLong')
        : t('workspace.permissions.error.validation');
  }
  return t('workspace.settings.error');
}

function logoErrorText(error: ApiError): string {
  if (error.status === 403) return t('workspace.permissions.error.forbidden');
  if (error.status === 404) return t('workspace.logo.notFound');
  if (error.status === 409) return t('workspace.logo.notReady');
  if (error.status === 422) return t('workspace.logo.invalid');
  if (error.status === 423) return t('workspace.logo.quarantined');
  if (error.status === 503 || error.isNetwork) return t('workspace.settings.unavailable');
  return t('workspace.logo.error');
}

function invitesErrorText(error: ApiError, fallback: MessageKey): string {
  if (error.status === 403) {
    return error.code === 'WORKSPACE_INVITE_ROLE_FORBIDDEN'
      ? t('workspace.invites.roleForbidden')
      : t('workspace.invites.error.forbidden');
  }
  if (error.status === 404) return t('workspace.invites.error.notFound');
  if (error.status === 429) return t('workspace.invites.error.rateLimited');
  if (error.status === 400 || error.status === 422) return t('workspace.invites.createError');
  if (error.status === 503 || error.isNetwork) return describeError(error).message;
  return t(fallback);
}

function permissionsErrorText(error: ApiError): string {
  if (error.status === 403) return t('workspace.permissions.error.forbidden');
  if (error.status === 422) {
    return error.code === 'OWNER_PERMISSIONS_IMMUTABLE'
      ? t('workspace.permissions.error.ownerImmutable')
      : t('workspace.permissions.error.validation');
  }
  if (error.status === 429) return t('workspace.invites.error.rateLimited');
  if (error.status === 503 || error.isNetwork) return describeError(error).message;
  return t('workspace.permissions.saveError');
}

function revokeErrorInfo(error: ApiError): AdminActionErrorInfo {
  return {
    text: invitesErrorText(error, 'workspace.invites.revokeError'),
    tone: 'error',
    retryable: error.isNetwork || error.status >= 500,
    closeOnError: false,
  };
}

export interface WorkspaceSettingsPanelProps {
  workspace: WorkspaceSummary;
  /** Caller's workspace role; the server still enforces every guard. */
  actorRole: WorkspacePermissionRole | 'GUEST' | null;
  onOpenMembers: () => void;
}

/**
 * P0-4 (#82) workspace settings pane.
 *
 * - Name/description/logo come from `PATCH /workspaces/{id}` and the avatar
 *   endpoint; the returned `WorkspaceSummary` replaces the app row.
 * - Invite links are metadata-only in the list; the raw token is shown once
 *   and copied as a client-side `/workspace-invite/<token>` URL. No email is
 *   sent anywhere in this flow.
 * - The permission matrix is the server's effective one. OWNER cells are
 *   immutable; an ADMIN may only edit MEMBER cells, an OWNER also ADMIN cells.
 * - Rights are read from the matrix, so a role gate mirrors the server instead
 *   of assuming OWNER/ADMIN by name.
 */
export function WorkspaceSettingsPanel({
  workspace,
  actorRole,
  onOpenMembers,
}: WorkspaceSettingsPanelProps) {
  const store = useProfileWorkspaceStore();
  const state = useProfileWorkspaceState();
  const workspaceState = state.workspace.workspaceId === workspace.id ? state.workspace : null;
  const matrix = workspaceState?.permissions.matrix ?? null;
  const permissionsLoading =
    workspaceState === null ||
    workspaceState.permissions.status === 'idle' ||
    workspaceState.permissions.status === 'loading';

  const permission = (key: WorkspacePermissionKey): boolean | null =>
    permissionAllowed(matrix, actorRole === 'GUEST' ? null : actorRole, key);
  const canManageWorkspace = permission('manage_workspace') === true;
  const canManageInvites = permission('manage_invites') === true;
  const canManagePermissions = permission('manage_permissions') === true;

  useEffect(() => {
    void store.loadWorkspaceAdmin(workspace.id);
  }, [store, workspace.id]);

  useEffect(() => {
    void store.loadWorkspaceLogoPreview(workspace.logo_file_id ?? null);
  }, [store, workspace.logo_file_id]);

  return (
    <div className="workspace-settings">
      <WorkspaceProfileCard
        workspace={workspace}
        canManage={canManageWorkspace}
        permissionsLoading={permissionsLoading}
      />
      <WorkspaceLogoCard
        workspace={workspace}
        canManage={canManageWorkspace}
        permissionsLoading={permissionsLoading}
      />
      <WorkspaceInvitesCard
        workspace={workspace}
        actorRole={actorRole}
        canManage={canManageInvites}
        permissionsLoading={permissionsLoading}
      />
      <WorkspacePermissionsCard
        workspace={workspace}
        actorRole={actorRole}
        canManage={canManagePermissions}
        permissionsLoading={permissionsLoading}
        onOpenMembers={onOpenMembers}
      />
    </div>
  );
}

function WorkspaceProfileCard({
  workspace,
  canManage,
  permissionsLoading,
}: {
  workspace: WorkspaceSummary;
  canManage: boolean;
  permissionsLoading: boolean;
}) {
  const store = useProfileWorkspaceStore();
  const state = useProfileWorkspaceState();
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description ?? '');
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; description?: string }>({});
  const [notice, setNotice] = useState<string | null>(null);
  const titleId = useId();
  const nameId = useId();
  const descriptionId = useId();

  const workspaceState = state.workspace.workspaceId === workspace.id ? state.workspace : null;
  const saving = workspaceState?.saveStatus === 'saving';
  const saveError = workspaceState?.saveStatus === 'error' ? workspaceState.saveError : null;
  const saved = workspaceState?.saveStatus === 'saved';

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage || saving) return;
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    const errors: { name?: string; description?: string } = {};
    if (!trimmedName) errors.name = t('workspace.settings.validation.nameRequired');
    else if (trimmedName.length > 120) {
      errors.name = t('workspace.settings.validation.nameTooLong');
    }
    if (trimmedDescription.length > 500) {
      errors.description = t('workspace.settings.validation.descriptionTooLong');
    }
    setFieldErrors(errors);
    setNotice(null);
    if (Object.keys(errors).length > 0) return;

    const patch: WorkspaceUpdate = {};
    if (trimmedName !== workspace.name) patch.name = trimmedName;
    if (trimmedDescription !== (workspace.description ?? '')) {
      patch.description = trimmedDescription || null;
    }
    if (Object.keys(patch).length === 0) return;
    const updated = await store.updateWorkspaceSettings(workspace.id, patch);
    if (updated) setNotice(t('workspace.settings.saved'));
  };

  return (
    <section className="card" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t('workspace.settings.title')}</h3>
      <p className="pane-sub">{t('workspace.settings.hint')}</p>

      {!canManage && !permissionsLoading ? (
        <p className="chat-settings-readonly">{t('workspace.settings.readOnly')}</p>
      ) : null}

      <form
        className="workspace-settings__form"
        onSubmit={(event) => void handleSubmit(event)}
        noValidate
      >
        <div className="form-grid">
          <div className="form-row">
            <label htmlFor={nameId}>{t('workspace.settings.name')}</label>
            <input
              id={nameId}
              className="input"
              type="text"
              value={name}
              maxLength={120}
              disabled={!canManage || saving}
              aria-invalid={Boolean(fieldErrors.name)}
              aria-describedby={`${nameId}-hint`}
              onChange={(event) => setName(event.target.value)}
            />
            <div className="field__meta">
              <span id={`${nameId}-hint`}>
                {fieldErrors.name ??
                  t('workspace.settings.nameHint', { count: name.trim().length })}
              </span>
            </div>
          </div>
          <div className="form-row">
            <label htmlFor={descriptionId}>{t('workspace.settings.description')}</label>
            <textarea
              id={descriptionId}
              className="input workspace-settings__description"
              rows={3}
              value={description}
              maxLength={500}
              disabled={!canManage || saving}
              aria-invalid={Boolean(fieldErrors.description)}
              aria-describedby={`${descriptionId}-hint`}
              onChange={(event) => setDescription(event.target.value)}
            />
            <div className="field__meta">
              <span id={`${descriptionId}-hint`}>
                {fieldErrors.description ??
                  t('workspace.settings.descriptionHint', { count: description.trim().length })}
              </span>
            </div>
          </div>
        </div>

        {saveError ? (
          <p className="chat-settings-error" role="alert">
            {settingsErrorText(saveError)}
          </p>
        ) : null}
        {notice && saved ? (
          <p className="chat-settings-notice" role="status">
            {notice}
          </p>
        ) : null}

        {canManage ? (
          <div className="form-actions">
            <button type="submit" className="btn btn--accent" disabled={saving}>
              {saving ? t('workspace.settings.saving') : t('workspace.settings.save')}
            </button>
          </div>
        ) : null}
      </form>
    </section>
  );
}

function WorkspaceLogoCard({
  workspace,
  canManage,
  permissionsLoading,
}: {
  workspace: WorkspaceSummary;
  canManage: boolean;
  permissionsLoading: boolean;
}) {
  const store = useProfileWorkspaceStore();
  const state = useProfileWorkspaceState();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const titleId = useId();

  const workspaceState = state.workspace.workspaceId === workspace.id ? state.workspace : null;
  const avatar = state.avatar.target === 'WORKSPACE' ? state.avatar : null;
  const busy = avatar?.actionStatus === 'saving' || avatar?.actionStatus === 'removing';
  const actionError = avatar?.actionError ?? null;
  const logoUrl = safeHttpUrl(workspaceState?.logoUrl ?? null);

  const handleSelect = async (fileId: string) => {
    setNotice(null);
    const ok = await store.setAvatar('WORKSPACE', fileId, workspace.id);
    if (ok) {
      setPickerOpen(false);
      setNotice(t('workspace.logo.updated'));
    }
  };

  const handleRemove = async () => {
    setNotice(null);
    const ok = await store.removeAvatar('WORKSPACE', workspace.id);
    if (ok) setNotice(t('workspace.logo.removed'));
  };

  return (
    <section className="card" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t('workspace.logo.title')}</h3>
      <div className="chat-settings-head">
        <span className="workspace-logo" aria-hidden={logoUrl ? undefined : 'true'}>
          {logoUrl ? (
            <img src={logoUrl} alt={t('workspace.logo.current')} />
          ) : (
            <span className="workspace-logo__fallback">
              {workspace.name.trim().slice(0, 1).toUpperCase()}
            </span>
          )}
        </span>
        <div>
          <div className="cs-name">
            {workspace.logo_file_id ? t('workspace.logo.current') : t('workspace.logo.none')}
          </div>
          <small>{t('workspace.settings.hint')}</small>
        </div>
        <div className="chat-settings-head__cover-actions">
          <button
            type="button"
            className="btn btn--sm"
            disabled={!canManage || busy}
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
          >
            {avatar?.actionStatus === 'saving'
              ? t('workspace.settings.saving')
              : t('workspace.logo.change')}
          </button>
          {workspace.logo_file_id ? (
            <button
              type="button"
              className="btn btn--sm"
              disabled={!canManage || busy}
              onClick={() => void handleRemove()}
            >
              {avatar?.actionStatus === 'removing'
                ? t('workspace.logo.removing')
                : t('workspace.logo.remove')}
            </button>
          ) : null}
        </div>
      </div>

      {!canManage && !permissionsLoading ? (
        <p className="chat-settings-readonly">{t('workspace.settings.readOnly')}</p>
      ) : null}

      {actionError ? (
        <p className="chat-settings-error" role="alert">
          {logoErrorText(actionError)}
        </p>
      ) : null}
      {notice ? (
        <p className="chat-settings-notice" role="status">
          {notice}
        </p>
      ) : null}

      {pickerOpen && canManage ? (
        <ImageFilePicker
          target="WORKSPACE"
          workspaceId={workspace.id}
          currentFileId={workspace.logo_file_id ?? null}
          pending={busy}
          onSelect={(fileId) => void handleSelect(fileId)}
        />
      ) : null}
    </section>
  );
}

function WorkspaceInvitesCard({
  workspace,
  actorRole,
  canManage,
  permissionsLoading,
}: {
  workspace: WorkspaceSummary;
  actorRole: WorkspacePermissionRole | 'GUEST' | null;
  canManage: boolean;
  permissionsLoading: boolean;
}) {
  const store = useProfileWorkspaceStore();
  const state = useProfileWorkspaceState();
  const workspaceState = state.workspace.workspaceId === workspace.id ? state.workspace : null;
  const invites = workspaceState?.invites;
  const roles = useMemo(() => inviteRoles(actorRole), [actorRole]);

  const [role, setRole] = useState<WorkspaceInviteRole>(roles[0] ?? 'MEMBER');
  const [expiry, setExpiry] = useState<ExpiryValue>('604800');
  const [maxUses, setMaxUses] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [revokeTarget, setRevokeTarget] = useState<WorkspaceInvite | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const titleId = useId();
  const roleId = useId();
  const expiryId = useId();
  const maxUsesId = useId();
  const createdLinkId = useId();

  const creating = invites?.createStatus === 'creating';
  const revoking = revokeTarget !== null && invites?.revokePendingId === revokeTarget.id;
  const createError = invites?.createStatus === 'error' ? invites.createError : null;
  const listError = invites?.status === 'error' ? invites.error : null;
  const revokeError = invites?.revokeError ?? null;
  const createdUrl = invites?.created ? inviteUrl(invites.created.token) : '';

  useEffect(() => {
    if (roles.includes(role)) return;
    setRole(roles[0] ?? 'MEMBER');
  }, [role, roles]);

  useEffect(() => {
    setCopyState('idle');
  }, [invites?.created?.invite.id]);

  const handleCopy = async (value: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  };

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage || creating) return;
    setNotice(null);
    const anyUses = Number.parseInt(maxUses, 10);
    const body: WorkspaceInviteCreateRequest = {
      role,
      expires_in_seconds: Number(expiry),
      max_uses: Number.isFinite(anyUses) && anyUses > 0 ? Math.min(anyUses, 1000) : null,
    };
    const created = await store.createWorkspaceInvite(workspace.id, body);
    if (created) setCopyState('idle');
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    const ok = await store.revokeWorkspaceInvite(workspace.id, revokeTarget.id);
    if (ok) {
      setRevokeTarget(null);
      setNotice(t('workspace.invites.revoked'));
    }
  };

  return (
    <section className="card" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t('workspace.invites.title')}</h3>
      <p className="pane-sub">{t('workspace.invites.hint')}</p>

      {notice ? (
        <p className="chat-settings-notice" role="status">
          {notice}
        </p>
      ) : null}

      {!canManage && !permissionsLoading ? (
        <p className="chat-settings-readonly">{t('workspace.invites.noAccess')}</p>
      ) : null}

      {canManage ? (
        <form className="workspace-invites__form" onSubmit={(event) => void handleCreate(event)}>
          <div className="form-grid form-grid--three">
            <div className="form-row">
              <label htmlFor={roleId}>{t('workspace.invites.role')}</label>
              <select
                id={roleId}
                className="select"
                value={role}
                disabled={creating}
                onChange={(event) => {
                  const next = event.target.value as WorkspaceInviteRole;
                  if (roles.includes(next)) setRole(next);
                }}
              >
                {roles.map((option) => (
                  <option key={option} value={option}>
                    {t(ROLE_LABEL[option])}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label htmlFor={expiryId}>{t('workspace.invites.expiry')}</label>
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
              <label htmlFor={maxUsesId}>{t('workspace.invites.maxUses')}</label>
              <input
                id={maxUsesId}
                className="input"
                type="number"
                inputMode="numeric"
                min={1}
                max={1000}
                value={maxUses}
                placeholder={t('workspace.invites.maxUsesHint')}
                disabled={creating}
                onChange={(event) => setMaxUses(event.target.value.replace(/[^0-9]/g, ''))}
              />
            </div>
          </div>
          {createError ? (
            <p className="chat-settings-error" role="alert">
              {invitesErrorText(createError, 'workspace.invites.createError')}
            </p>
          ) : null}
          <div className="form-actions">
            <button type="submit" className="btn btn--accent" disabled={creating}>
              <LinkIcon aria-hidden="true" />
              {creating ? t('workspace.invites.creating') : t('workspace.invites.create')}
            </button>
          </div>
        </form>
      ) : null}

      {invites?.created ? (
        <div className="invite-created" role="status">
          <p className="invite-created__note">{t('workspace.invites.createdTitle')}</p>
          <p className="mini-card__note">{t('workspace.invites.createdHint')}</p>
          <div className="invite-row">
            <input
              id={createdLinkId}
              className="input"
              readOnly
              value={createdUrl}
              aria-label={t('workspace.invites.copy')}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void handleCopy(createdUrl)}
            >
              <CopyIcon aria-hidden="true" />
              {t('workspace.invites.copy')}
            </button>
          </div>
          <p className="field__meta" role="status">
            {copyState === 'copied'
              ? t('workspace.invites.copied')
              : copyState === 'error'
                ? t('workspace.invites.copyError')
                : t('workspace.invites.hint')}
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => store.clearCreatedInvite()}
            >
              {t('workspace.invites.dismiss')}
            </button>
          </div>
        </div>
      ) : null}

      {canManage ? (
        <div className="chat-invites__list">
          <div className="chat-invites__list-head">
            <h4>{t('workspace.invites.title')}</h4>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void store.loadWorkspaceInvites(workspace.id, true)}
              disabled={invites?.status === 'loading'}
            >
              <RefreshIcon aria-hidden="true" />
              {t('common.refresh')}
            </button>
          </div>

          {invites &&
          (invites.status === 'loading' || invites.status === 'idle') &&
          invites.items.length === 0 ? (
            <p className="card-empty" role="status">
              {t('workspace.invites.loading')}
            </p>
          ) : null}

          {listError ? (
            <div className="members-list__state" role="alert">
              <p>{invitesErrorText(listError, 'workspace.invites.loadError')}</p>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void store.loadWorkspaceInvites(workspace.id, true)}
              >
                {t('common.retry')}
              </button>
            </div>
          ) : null}

          {invites?.status === 'ready' && invites.items.length === 0 ? (
            <p className="card-empty" role="status">
              {t('workspace.invites.empty')}
            </p>
          ) : null}

          {invites && invites.items.length > 0 ? (
            <ul className="chat-invites__items">
              {invites.items.map((invite) => (
                <li className="chat-invite" key={invite.id}>
                  <div className="chat-invite__body">
                    <span className="chat-invite__role">{t(ROLE_LABEL[invite.role])}</span>
                    <span className={`members-row__role members-row__role--${invite.status}`}>
                      {t(STATUS_LABEL[invite.status])}
                    </span>
                    <span className="chat-invite__meta">
                      {invite.max_uses === null || invite.max_uses === undefined
                        ? t('workspace.invites.usedUnlimited', { used: invite.used_count })
                        : t('workspace.invites.used', {
                            used: invite.used_count,
                            max: invite.max_uses,
                          })}
                      {' · '}
                      {t('workspace.invites.expires', { date: formatDateTime(invite.expires_at) })}
                    </span>
                  </div>
                  {invite.status === 'ACTIVE' ? (
                    <button
                      type="button"
                      className="btn btn--sm btn--danger"
                      disabled={revoking}
                      onClick={() => {
                        setNotice(null);
                        setRevokeTarget(invite);
                      }}
                    >
                      {t('workspace.invites.revoke')}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {revokeTarget ? (
        <AdminConfirmDialog
          title={t('workspace.invites.revokeTitle')}
          description={
            <>
              <p className="admin-confirm__lead">
                {t('workspace.invites.revokeLead', { role: t(ROLE_LABEL[revokeTarget.role]) })}
              </p>
              <ul className="admin-confirm__list">
                <li>{t('workspace.invites.revokeEffect')}</li>
              </ul>
            </>
          }
          confirmLabel={t('workspace.invites.revoke')}
          busyLabel={t('workspace.invites.revoking')}
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

function WorkspacePermissionsCard({
  workspace,
  actorRole,
  canManage,
  permissionsLoading,
  onOpenMembers,
}: {
  workspace: WorkspaceSummary;
  actorRole: WorkspacePermissionRole | 'GUEST' | null;
  canManage: boolean;
  permissionsLoading: boolean;
  onOpenMembers: () => void;
}) {
  const store = useProfileWorkspaceStore();
  const state = useProfileWorkspaceState();
  const workspaceState = state.workspace.workspaceId === workspace.id ? state.workspace : null;
  const permissions = workspaceState?.permissions;
  const base = permissions?.matrix ?? null;
  const [draft, setDraft] = useState<WorkspacePermissionMatrix | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const titleId = useId();
  const initializedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!base) return;
    const key = `${workspace.id}:${base.roles.map((row) => row.role).join(',')}`;
    if (initializedFor.current === key) return;
    initializedFor.current = key;
    setDraft(null);
    setNotice(null);
  }, [base, workspace.id]);

  const matrix = useMemo(() => {
    if (!base) return null;
    if (!draft) return base;
    return {
      ...base,
      roles: base.roles.map((row) => {
        const next = draft.roles.find((item) => item.role === row.role);
        return next ?? row;
      }),
    };
  }, [base, draft]);

  const canEditRow = (role: WorkspacePermissionRole): boolean => {
    if (!canManage) return false;
    if (role === 'OWNER') return false;
    if (actorRole === 'OWNER') return true;
    if (actorRole === 'ADMIN') return role === 'MEMBER';
    return false;
  };

  const toggle = (role: WorkspacePermissionRole, key: WorkspacePermissionKey, allowed: boolean) => {
    if (!matrix || !canEditRow(role)) return;
    setNotice(null);
    setDraft((current) => {
      const source = current ?? matrix;
      return {
        ...source,
        roles: source.roles.map((row) => (row.role === role ? { ...row, [key]: allowed } : row)),
      };
    });
  };

  const changedEntries = useMemo<WorkspacePermissionEntry[]>(() => {
    if (!base || !matrix) return [];
    const entries: WorkspacePermissionEntry[] = [];
    for (const row of matrix.roles) {
      const original = base.roles.find((item) => item.role === row.role);
      if (!original) continue;
      for (const key of WORKSPACE_PERMISSION_KEYS) {
        if (original[key] !== row[key]) {
          entries.push({ role: row.role, permission: key, allowed: row[key] });
        }
      }
    }
    return entries;
  }, [base, matrix]);

  const saving = permissions?.saveStatus === 'saving';
  const saveError = permissions?.saveStatus === 'error' ? permissions.saveError : null;
  const loadError = permissions?.status === 'error' ? permissions.error : null;

  const handleSave = async () => {
    if (!canManage || changedEntries.length === 0) return;
    setNotice(null);
    const ok = await store.updateWorkspacePermissions(workspace.id, changedEntries);
    if (ok) {
      setDraft(null);
      setNotice(t('workspace.permissions.saved'));
    }
  };

  return (
    <section className="card" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t('workspace.permissions.title')}</h3>
      <p className="pane-sub">{t('workspace.permissions.hint')}</p>

      {permissionsLoading ? (
        <p className="pane-sub" role="status">
          {t('workspace.permissions.loading')}
        </p>
      ) : null}

      {loadError ? (
        <div className="members-list__state" role="alert">
          <p>{permissionsErrorText(loadError)}</p>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void store.loadWorkspacePermissions(workspace.id, true)}
          >
            {t('common.retry')}
          </button>
        </div>
      ) : null}

      {matrix ? (
        <>
          <p className="chat-settings-readonly">{t('workspace.permissions.ownerImmutable')}</p>
          {actorRole === 'ADMIN' ? (
            <p className="pane-sub">{t('workspace.permissions.adminLimited')}</p>
          ) : null}
          <div className="ws-permissions" role="group" aria-labelledby={`${titleId}-table`}>
            <h4 className="visually-hidden" id={`${titleId}-table`}>
              {t('workspace.permissions.title')}
            </h4>
            <table className="ws-permissions__table">
              <thead>
                <tr>
                  <th scope="col">{t('workspace.invites.role')}</th>
                  {WORKSPACE_PERMISSION_KEYS.map((key) => (
                    <th scope="col" key={key}>
                      {t(PERMISSION_LABEL[key])}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(['OWNER', 'ADMIN', 'MEMBER'] as const).map((role) => {
                  const row = matrix.roles.find((item) => item.role === role);
                  if (!row) return null;
                  const editable = canEditRow(role);
                  return (
                    <tr key={role}>
                      <th scope="row">{t(ROLE_LABEL[role])}</th>
                      {WORKSPACE_PERMISSION_KEYS.map((key) => {
                        const checked = role === 'OWNER' ? true : row[key];
                        return (
                          <td key={key}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!editable || saving}
                              aria-label={t('workspace.permissions.cell', {
                                permission: t(PERMISSION_LABEL[key]),
                                role: t(ROLE_LABEL[role]),
                              })}
                              onChange={(event) => toggle(role, key, event.target.checked)}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {!canManage && !permissionsLoading ? (
            <p className="chat-settings-readonly">{t('workspace.permissions.readOnly')}</p>
          ) : null}

          {saveError ? (
            <p className="chat-settings-error" role="alert">
              {permissionsErrorText(saveError)}
            </p>
          ) : null}
          {notice ? (
            <p className="chat-settings-notice" role="status">
              {notice}
            </p>
          ) : null}

          <div className="form-actions">
            <button type="button" className="btn" onClick={onOpenMembers}>
              <PeopleIcon aria-hidden="true" />
              {t('settings.workspaceMembers')}
            </button>
            {canManage ? (
              <button
                type="button"
                className="btn btn--accent"
                disabled={saving || changedEntries.length === 0}
                onClick={() => void handleSave()}
              >
                <ShieldIcon aria-hidden="true" />
                {saving ? t('workspace.permissions.saving') : t('workspace.permissions.save')}
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

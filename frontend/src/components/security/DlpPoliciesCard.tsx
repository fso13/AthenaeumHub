import { useId, useState, type FormEvent } from 'react';
import type { ApiError } from '../../api/problem';
import type { DlpAction, DlpPatternType, DlpPolicy } from '../../api/types';
import { t, type MessageKey } from '../../i18n/ru';
import {
  DLP_NAME_MAX,
  DLP_PATTERN_MAX,
  DLP_WILDCARD_MAX,
  draftFromPolicy,
  emptyDlpDraft,
  hasDlpErrors,
  toCreateDlpBody,
  toUpdateDlpBody,
  validateDlpDraft,
  type DlpPolicyDraft,
  type DlpPolicyFieldErrors,
} from '../../security/model';
import { describeSecurityActionError, securityErrorMessage } from '../../security/errors';
import { useSecurityState, useSecurityStore } from '../../store/ChatProvider';
import { AdminConfirmDialog } from '../admin/AdminConfirmDialog';
import { formatDateTime } from '../admin/format';
import { ErrorDetails } from '../ErrorDetails';
import { KeyIcon, PlusIcon, RefreshIcon } from '../Icons';
import { SectionEmpty, SectionError, SectionLoading } from './SecurityUi';

const ACTION_OPTIONS: ReadonlyArray<{ value: DlpAction; label: MessageKey }> = [
  { value: 'WARN', label: 'security.dlp.action.WARN' },
  { value: 'BLOCK', label: 'security.dlp.action.BLOCK' },
];

const TYPE_OPTIONS: ReadonlyArray<{ value: DlpPatternType; label: MessageKey }> = [
  { value: 'KEYWORD', label: 'security.dlp.type.KEYWORD' },
  { value: 'PATTERN', label: 'security.dlp.type.PATTERN' },
];

interface PolicyFormProps {
  initial: DlpPolicyDraft;
  policyId: string | null;
  busy: boolean;
  serverError: ApiError | null;
  onCancel: () => void;
  onSubmit: (draft: DlpPolicyDraft) => Promise<boolean>;
}

/** Inline editor: every contract field, field-level validation, honest hints. */
function PolicyForm({ initial, policyId, busy, serverError, onCancel, onSubmit }: PolicyFormProps) {
  const [draft, setDraft] = useState<DlpPolicyDraft>(initial);
  const [errors, setErrors] = useState<DlpPolicyFieldErrors>({});
  const nameId = useId();
  const actionId = useId();
  const typeId = useId();
  const patternId = useId();
  const enabledId = useId();
  const nameErrorId = useId();
  const patternErrorId = useId();

  const wildcards = draft.pattern.match(/\*/g)?.length ?? 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextErrors = validateDlpDraft(draft);
    setErrors(nextErrors);
    if (hasDlpErrors(nextErrors)) return;
    await onSubmit(draft);
  };

  return (
    <form className="sec-form" onSubmit={(event) => void submit(event)} noValidate>
      <h3 className="sec-form__title">
        {policyId ? t('security.dlp.form.editTitle') : t('security.dlp.form.createTitle')}
      </h3>
      <div className="form-grid">
        <div className="form-row">
          <label htmlFor={nameId}>{t('security.dlp.field.name')}</label>
          <input
            id={nameId}
            className="input"
            value={draft.name}
            maxLength={DLP_NAME_MAX}
            placeholder={t('security.dlp.namePlaceholder')}
            aria-invalid={errors.name !== undefined}
            aria-describedby={errors.name ? nameErrorId : undefined}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          />
          {errors.name ? (
            <p className="sec-field-error" id={nameErrorId}>
              {t(errors.name as MessageKey)}
            </p>
          ) : null}
        </div>
        <div className="form-row">
          <label htmlFor={actionId}>{t('security.dlp.field.action')}</label>
          <select
            id={actionId}
            className="select"
            value={draft.action}
            onChange={(event) =>
              setDraft((current) => ({ ...current, action: event.target.value as DlpAction }))
            }
          >
            {ACTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor={typeId}>{t('security.dlp.field.type')}</label>
          <select
            id={typeId}
            className="select"
            value={draft.patternType}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                patternType: event.target.value as DlpPatternType,
              }))
            }
          >
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor={enabledId}>{t('security.dlp.field.enabled')}</label>
          <label className="sec-switch" htmlFor={enabledId}>
            <input
              id={enabledId}
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) =>
                setDraft((current) => ({ ...current, enabled: event.target.checked }))
              }
            />
            <span>{draft.enabled ? t('security.dlp.enabled') : t('security.dlp.disabled')}</span>
          </label>
        </div>
      </div>

      <div className="form-row">
        <label htmlFor={patternId}>{t('security.dlp.field.pattern')}</label>
        <input
          id={patternId}
          className="input mono"
          value={draft.pattern}
          maxLength={DLP_PATTERN_MAX}
          placeholder={t('security.dlp.patternPlaceholder')}
          aria-invalid={errors.pattern !== undefined}
          aria-describedby={`${patternId}-hint${errors.pattern ? ` ${patternErrorId}` : ''}`}
          onChange={(event) => setDraft((current) => ({ ...current, pattern: event.target.value }))}
        />
        <p className="field__meta" id={`${patternId}-hint`}>
          {draft.patternType === 'PATTERN'
            ? t('security.dlp.patternHintPattern')
            : t('security.dlp.patternHintKeyword')}
          {draft.patternType === 'PATTERN' ? ` (${wildcards}/${DLP_WILDCARD_MAX})` : ''}
        </p>
        {errors.pattern ? (
          <p className="sec-field-error" id={patternErrorId}>
            {t(errors.pattern as MessageKey)}
          </p>
        ) : null}
      </div>

      <p className="pg-footnote">{t('security.dlp.noRegex')}</p>

      {serverError ? (
        <div className="pg-inline-error" role="alert">
          <div>
            <p>{securityErrorMessage(serverError, 'security.dlp.saveError')}</p>
            <ErrorDetails error={serverError} />
          </div>
        </div>
      ) : null}

      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          {t('security.dlp.cancel')}
        </button>
        <button type="submit" className="btn btn--accent" disabled={busy} aria-busy={busy}>
          {busy ? t('security.dlp.saving') : t('security.dlp.save')}
        </button>
      </div>
    </form>
  );
}

/**
 * DLP CRUD. The list/rows come only from the API; E2EE never reaches this
 * card (the page renders an honest E2EE explanation instead). A deleted rule
 * keeps historical event snapshots, so the UI never rewrites events locally.
 */
export function DlpPoliciesCard() {
  const store = useSecurityStore();
  const { policies } = useSecurityState();
  const [editor, setEditor] = useState<{ policyId: string | null; draft: DlpPolicyDraft } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<DlpPolicy | null>(null);
  const count = policies.items.length;
  const loaded = policies.status === 'ready';

  const openCreate = () => {
    store.clearPolicySaveError();
    setEditor({ policyId: null, draft: emptyDlpDraft() });
  };

  const openEdit = (policy: DlpPolicy) => {
    store.clearPolicySaveError();
    setEditor({ policyId: policy.id, draft: draftFromPolicy(policy) });
  };

  const closeEditor = () => {
    store.clearPolicySaveError();
    setEditor(null);
  };

  const submit = async (draft: DlpPolicyDraft): Promise<boolean> => {
    if (!editor) return false;
    const saved =
      editor.policyId === null
        ? await store.createPolicy(toCreateDlpBody(draft))
        : await store.updatePolicy(editor.policyId, toUpdateDlpBody(draft));
    if (!saved) return false;
    setEditor(null);
    return true;
  };

  const deleteError = policies.deleteError;
  const deleteErrorInfo = deleteError ? describeSecurityActionError(deleteError) : null;

  return (
    <section className="card card--wide" aria-labelledby="security-policies">
      <div className="card-head">
        <div className="sec-head">
          <h2 className="card-title" id="security-policies">
            {t('security.dlp.title')}
          </h2>
          <span className="chip" aria-label={`${t('security.dlp.title')}: ${count}`}>
            {count}
          </span>
        </div>
        <div className="sec-head-actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void store.loadPolicies(true)}
            disabled={policies.status === 'loading'}
          >
            <RefreshIcon aria-hidden="true" />
            {t('security.refresh')}
          </button>
          <button type="button" className="btn btn--sm btn--accent" onClick={openCreate}>
            <PlusIcon aria-hidden="true" />
            {t('security.dlp.add')}
          </button>
        </div>
      </div>
      <p className="pane-sub">{t('security.dlp.lead')}</p>

      {policies.status === 'loading' && !loaded ? (
        <SectionLoading label={t('security.dlp.loading')} />
      ) : null}

      {policies.error ? (
        <SectionError
          text={t('security.dlp.error')}
          error={policies.error}
          onRetry={() => void store.loadPolicies(true)}
          retryLabel={t('security.dlp.retry')}
        />
      ) : null}

      {loaded && policies.items.length === 0 ? (
        <SectionEmpty title={t('security.dlp.emptyTitle')} text={t('security.dlp.emptyText')}>
          <button type="button" className="btn btn--sm" onClick={openCreate}>
            <PlusIcon aria-hidden="true" />
            {t('security.dlp.add')}
          </button>
        </SectionEmpty>
      ) : null}

      {policies.items.length > 0 ? (
        <div className="sec-table-wrap">
          <table className="sec-table">
            <caption className="visually-hidden">{t('security.dlp.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('security.dlp.column.name')}</th>
                <th scope="col">{t('security.dlp.column.action')}</th>
                <th scope="col">{t('security.dlp.column.type')}</th>
                <th scope="col">{t('security.dlp.column.pattern')}</th>
                <th scope="col">{t('security.dlp.column.enabled')}</th>
                <th scope="col">{t('security.dlp.column.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {policies.items.map((policy) => (
                <tr key={policy.id}>
                  <td>
                    <b>{policy.name}</b>
                    <small className="sec-cell-meta">{formatDateTime(policy.created_at)}</small>
                  </td>
                  <td>
                    <span
                      className={`chip ${policy.action === 'BLOCK' ? 'chip--danger' : 'chip--warn'}`}
                    >
                      {t(
                        policy.action === 'BLOCK'
                          ? 'security.dlp.action.BLOCK'
                          : 'security.dlp.action.WARN',
                      )}
                    </span>
                  </td>
                  <td>
                    <code>{policy.pattern_type}</code>
                  </td>
                  <td>
                    <code className="sec-pattern" title={policy.pattern}>
                      {policy.pattern}
                    </code>
                  </td>
                  <td>
                    <span className={`chip${policy.enabled ? '' : ' chip--muted'}`}>
                      {policy.enabled ? t('security.dlp.enabled') : t('security.dlp.disabled')}
                    </span>
                  </td>
                  <td>
                    <div className="sec-row-actions">
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => openEdit(policy)}
                        aria-label={`${t('security.dlp.edit')}: ${policy.name}`}
                      >
                        <KeyIcon aria-hidden="true" />
                        {t('security.dlp.edit')}
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--danger"
                        onClick={() => {
                          store.clearPolicyDeleteError();
                          setDeleting(policy);
                        }}
                        aria-label={`${t('security.dlp.delete')}: ${policy.name}`}
                      >
                        {t('security.dlp.delete')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="pg-footnote">{t('security.dlp.limitHint')}</p>

      {editor ? (
        <PolicyForm
          key={editor.policyId ?? 'new'}
          initial={editor.draft}
          policyId={editor.policyId}
          busy={policies.saveStatus === 'saving'}
          serverError={policies.saveStatus === 'error' ? policies.saveError : null}
          onCancel={closeEditor}
          onSubmit={submit}
        />
      ) : null}

      {deleting ? (
        <AdminConfirmDialog
          title={t('security.dlp.deleteTitle')}
          description={
            <p className="admin-confirm__lead">
              {t('security.dlp.deleteText', { name: deleting.name })}
            </p>
          }
          confirmLabel={t('security.dlp.deleteConfirm')}
          busyLabel={t('security.dlp.deleting')}
          destructive
          busy={policies.deleteStatus === 'deleting'}
          error={deleteErrorInfo}
          errorDetails={deleteError}
          onConfirm={() => {
            void (async () => {
              const ok = await store.deletePolicy(deleting.id);
              const current = store.getSnapshot().policies.deleteError;
              if (ok || current?.status === 404) setDeleting(null);
            })();
          }}
          onClose={() => {
            if (policies.deleteStatus === 'deleting') return;
            store.clearPolicyDeleteError();
            setDeleting(null);
          }}
        />
      ) : null}
    </section>
  );
}

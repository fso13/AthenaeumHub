import { describeError } from '../domain/errors';
import { formatBytes } from '../files/format';
import { t, type MessageKey } from '../i18n/ru';
import type { UploadTask, UploadTaskStatus } from '../store/filesStore';
import { ErrorDetails } from './ErrorDetails';
import {
  AlertIcon,
  CheckIcon,
  CloseIcon,
  FileIcon,
  PauseIcon,
  PlayIcon,
  RetryIcon,
  TrashIcon,
} from './Icons';

interface UploadTrayProps {
  tasks: UploadTask[];
  onPause: (localId: string) => void;
  onResume: (localId: string) => void;
  onCancel: (localId: string) => void;
  onRetry: (localId: string) => void;
  onRemove: (localId: string) => void;
}

const STATUS_KEY: Record<UploadTaskStatus, MessageKey> = {
  queued: 'files.queued',
  preflighting: 'files.preflighting',
  denied: 'files.denied',
  initializing: 'files.initializing',
  uploading: 'files.uploading',
  paused: 'files.paused',
  completing: 'files.hashing',
  scanning: 'files.scanning',
  ready: 'files.ready',
  quarantined: 'files.quarantined',
  error: 'files.failed',
  canceled: 'files.canceled',
  expired: 'files.expired',
};

function statusText(task: UploadTask): string {
  if (task.status === 'uploading') {
    return t('files.uploading', { percent: Math.round(task.progress * 100) });
  }
  return t(STATUS_KEY[task.status]);
}

function isBusy(task: UploadTask): boolean {
  return (
    task.status === 'queued' ||
    task.status === 'preflighting' ||
    task.status === 'initializing' ||
    task.status === 'uploading' ||
    task.status === 'completing' ||
    task.status === 'scanning'
  );
}

function showProgress(task: UploadTask): boolean {
  return (
    task.status === 'uploading' ||
    task.status === 'paused' ||
    task.status === 'completing' ||
    task.status === 'scanning'
  );
}

function canRetry(task: UploadTask): boolean {
  return task.status === 'expired' || (task.status === 'error' && task.retryable);
}

export function UploadTray({
  tasks,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onRemove,
}: UploadTrayProps) {
  if (tasks.length === 0) return null;

  return (
    <ul className="upload-tray" aria-label={t('attachments.label')}>
      {tasks.map((task) => {
        const percent = Math.round(task.progress * 100);
        const described = task.error ? describeError(task.error) : null;
        return (
          <li
            key={task.localId}
            className={`upload-card upload-card--${task.status}`}
            data-upload-status={task.status}
          >
            <span className="upload-card__icon" aria-hidden="true">
              <FileIcon />
            </span>

            <div className="upload-card__body">
              <span className="upload-card__name" title={task.name}>
                {task.name}
              </span>
              <span className="upload-card__meta">
                {formatBytes(task.size)}
                {task.status !== 'ready' ? ` · ${statusText(task)}` : ''}
                {task.totalParts && task.status !== 'ready'
                  ? ` · ${t('files.uploadingParts', {
                      part: Math.min(task.receivedParts.length + 1, task.totalParts),
                      total: task.totalParts,
                    })}`
                  : ''}
              </span>

              {showProgress(task) ? (
                <div
                  className="upload-card__progress"
                  role="progressbar"
                  aria-label={t('files.uploading', { percent })}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                >
                  <span style={{ width: `${percent}%` }} />
                </div>
              ) : null}

              {described ? (
                <div className="upload-card__error" role="alert">
                  <p className="upload-card__error-title">{described.title}</p>
                  <p className="upload-card__error-text">{described.message}</p>
                  <ErrorDetails error={task.error} />
                </div>
              ) : null}
            </div>

            <div className="upload-card__actions">
              {task.status === 'uploading' ? (
                <button
                  type="button"
                  className="icon-button icon-button--small"
                  onClick={() => onPause(task.localId)}
                  aria-label={`${t('files.pause')}: ${task.name}`}
                  title={t('files.pause')}
                >
                  <PauseIcon aria-hidden="true" />
                </button>
              ) : null}

              {task.status === 'paused' ? (
                <button
                  type="button"
                  className="icon-button icon-button--small"
                  onClick={() => onResume(task.localId)}
                  aria-label={`${t('files.resume')}: ${task.name}`}
                  title={t('files.resume')}
                >
                  <PlayIcon aria-hidden="true" />
                </button>
              ) : null}

              {task.status === 'ready' ? (
                <span className="upload-card__ready" role="status">
                  <CheckIcon aria-hidden="true" />
                  {t('files.ready')}
                </span>
              ) : null}

              {canRetry(task) ? (
                <button
                  type="button"
                  className="button button--small"
                  onClick={() => onRetry(task.localId)}
                  aria-label={`${t(task.status === 'expired' ? 'files.restart' : 'files.retry')}: ${task.name}`}
                >
                  <RetryIcon aria-hidden="true" />
                  {t(task.status === 'expired' ? 'files.restart' : 'files.retry')}
                </button>
              ) : null}

              {isBusy(task) ? (
                <button
                  type="button"
                  className="icon-button icon-button--small"
                  onClick={() => onCancel(task.localId)}
                  aria-label={`${t('files.cancel')}: ${task.name}`}
                  title={t('files.cancel')}
                >
                  <CloseIcon aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  className="icon-button icon-button--small"
                  onClick={() => onRemove(task.localId)}
                  aria-label={`${t('files.remove')}: ${task.name}`}
                  title={t('files.remove')}
                >
                  <TrashIcon aria-hidden="true" />
                </button>
              )}

              {task.status === 'quarantined' ? (
                <span className="upload-card__badge" aria-hidden="true">
                  <AlertIcon />
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

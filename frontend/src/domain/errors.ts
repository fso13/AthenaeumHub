import { isApiError } from '../api/problem';
import { formatBytes } from '../files/format';
import { t, type Translator } from '../i18n/ru';

export type ErrorKind =
  | 'session'
  | 'no_access'
  | 'rate_limit'
  | 'conflict'
  | 'limit'
  | 'validation'
  | 'too_long'
  | 'attachment'
  | 'expired'
  | 'sticker'
  | 'server'
  | 'network'
  | 'timeout'
  | 'generic';

export interface DescribedError {
  kind: ErrorKind;
  title: string;
  message: string;
  retryable: boolean;
  /** Only meaningful for a failed outgoing message. */
  canRestoreText: boolean;
  retryAfterSeconds?: number;
  code?: string;
  requestId?: string;
  status?: number;
}

const DEFAULT_RATE_LIMIT_SECONDS = 5;

export function describeError(error: unknown, translator: Translator = t): DescribedError {
  const translate = translator;

  if (!isApiError(error)) {
    return {
      kind: 'generic',
      title: translate('errors.generic.title'),
      message: translate('errors.generic.text'),
      retryable: false,
      canRestoreText: false,
    };
  }

  const meta = {
    code: error.code,
    requestId: error.requestId,
    status: error.status,
    retryAfterSeconds: error.retryAfterSeconds,
  };

  if (error.source === 'network') {
    return {
      ...meta,
      kind: 'network',
      title: translate('errors.network.title'),
      message: translate('errors.network.text'),
      retryable: true,
      canRestoreText: false,
    };
  }

  if (error.source === 'timeout') {
    return {
      ...meta,
      kind: 'timeout',
      title: translate('errors.timeout.title'),
      message: translate('errors.timeout.text'),
      retryable: true,
      canRestoreText: false,
    };
  }

  if (error.code === 'MENTION_ALL_FORBIDDEN') {
    return {
      ...meta,
      kind: 'no_access',
      title: translate('errors.mentionAllForbidden.title'),
      message: translate('errors.mentionAllForbidden.text'),
      retryable: false,
      canRestoreText: true,
    };
  }

  if (error.code === 'MENTION_INVALID') {
    return {
      ...meta,
      kind: 'validation',
      title: translate('errors.mentionInvalid.title'),
      message: translate('errors.mentionInvalid.text'),
      retryable: false,
      canRestoreText: true,
    };
  }

  if (error.code === 'E2EE_METADATA_FORBIDDEN') {
    return {
      ...meta,
      kind: 'no_access',
      title: translate('errors.e2eeMetadata.title'),
      message: translate('errors.e2eeMetadata.text'),
      retryable: false,
      canRestoreText: false,
    };
  }

  if (error.code === 'MESSAGE_NOT_EDITABLE') {
    return {
      ...meta,
      kind: 'validation',
      title: translate('errors.messageNotEditable.title'),
      message: translate('errors.messageNotEditable.text'),
      retryable: false,
      canRestoreText: false,
    };
  }

  if (error.code === 'VERSION_CONFLICT') {
    return {
      ...meta,
      kind: 'conflict',
      title: translate('errors.versionConflict.title'),
      message: translate('errors.versionConflict.text'),
      retryable: false,
      canRestoreText: false,
    };
  }

  if (error.status === 401) {
    return {
      ...meta,
      kind: 'session',
      title: translate('errors.session.title'),
      message: translate('errors.session.text'),
      retryable: true,
      canRestoreText: false,
    };
  }

  if (error.code === 'STICKER_NOT_FOUND') {
    return {
      ...meta,
      kind: 'sticker',
      title: translate('errors.stickerNotFound.title'),
      message: translate('errors.stickerNotFound.text'),
      retryable: false,
      canRestoreText: false,
    };
  }

  if (error.code === 'STICKER_PACK_DISABLED') {
    return {
      ...meta,
      kind: 'sticker',
      title: translate('errors.stickerPackDisabled.title'),
      message: translate('errors.stickerPackDisabled.text'),
      retryable: false,
      canRestoreText: false,
    };
  }

  if (error.code === 'INVALID_STICKER_MESSAGE') {
    return {
      ...meta,
      kind: 'sticker',
      title: translate('errors.invalidSticker.title'),
      message: translate('errors.invalidSticker.text'),
      retryable: false,
      canRestoreText: false,
    };
  }

  if (error.code === 'THREAD_ROOT_DELETED') {
    return {
      ...meta,
      kind: 'conflict',
      title: translate('errors.threadRootDeleted.title'),
      message: translate('errors.threadRootDeleted.text'),
      retryable: false,
      canRestoreText: true,
    };
  }

  if (error.code === 'THREAD_ROOT_NOT_FOUND') {
    return {
      ...meta,
      kind: 'no_access',
      title: translate('errors.threadRootNotFound.title'),
      message: translate('errors.threadRootNotFound.text'),
      retryable: false,
      canRestoreText: true,
    };
  }

  if (error.code === 'THREAD_NESTING_UNSUPPORTED') {
    return {
      ...meta,
      kind: 'validation',
      title: translate('errors.threadNesting.title'),
      message: translate('errors.threadNesting.text'),
      retryable: false,
      canRestoreText: false,
    };
  }

  if (error.code === 'THREADS_E2EE_UNSUPPORTED') {
    return {
      ...meta,
      kind: 'no_access',
      title: translate('errors.threadsE2ee.title'),
      message: translate('errors.threadsE2ee.text'),
      retryable: false,
      canRestoreText: false,
    };
  }

  if (error.status === 403 || error.status === 404) {
    return {
      ...meta,
      kind: 'no_access',
      title: translate('errors.noAccess.title'),
      message: translate('errors.noAccess.text'),
      retryable: false,
      canRestoreText: false,
    };
  }

  const details = error.details ?? {};
  const detailLimit = typeof details.limit === 'number' ? details.limit : undefined;
  const detailActual = typeof details.actual === 'number' ? details.actual : undefined;
  const detailUsed = typeof details.used === 'number' ? details.used : undefined;
  const sizeVars = {
    limit: formatBytes(detailLimit),
    actual: formatBytes(detailActual),
    used: formatBytes(detailUsed),
  };

  if (error.code === 'FILE_TOO_LARGE' || error.status === 413) {
    return {
      ...meta,
      kind: 'limit',
      title: translate('errors.fileTooLarge.title'),
      message: translate('errors.fileTooLarge.text', sizeVars),
      retryable: false,
      canRestoreText: true,
    };
  }

  if (error.code === 'UNSUPPORTED_TYPE' || error.status === 415) {
    return {
      ...meta,
      kind: 'validation',
      title: translate('errors.unsupportedType.title'),
      message: translate('errors.unsupportedType.text'),
      retryable: false,
      canRestoreText: true,
    };
  }

  if (error.code === 'DANGEROUS_TYPE_BLOCKED') {
    return {
      ...meta,
      kind: 'validation',
      title: translate('errors.dangerousType.title'),
      message: translate('errors.dangerousType.text'),
      retryable: false,
      canRestoreText: true,
    };
  }

  if (error.code === 'QUOTA_EXCEEDED') {
    return {
      ...meta,
      kind: 'limit',
      title: translate('errors.quota.title'),
      message: translate('errors.quota.text', {
        used: formatBytes(detailUsed ?? 0),
        limit: formatBytes(detailLimit ?? 0),
      }),
      retryable: false,
      canRestoreText: true,
    };
  }

  if (error.code === 'TOO_MANY_FILES') {
    return {
      ...meta,
      kind: 'limit',
      title: translate('errors.tooManyFiles.title'),
      message: translate('errors.tooManyFiles.text', {
        limit: detailLimit ?? 10,
      }),
      retryable: false,
      canRestoreText: true,
    };
  }

  if (error.code === 'CHUNK_CONFLICT') {
    return {
      ...meta,
      kind: 'conflict',
      title: translate('errors.chunkConflict.title'),
      message: translate('errors.chunkConflict.text'),
      retryable: true,
      canRestoreText: true,
    };
  }

  if (error.code === 'CHUNK_HASH_MISMATCH') {
    return {
      ...meta,
      kind: 'conflict',
      title: translate('errors.chunkHash.title'),
      message: translate('errors.chunkHash.text'),
      retryable: true,
      canRestoreText: true,
    };
  }

  if (error.code === 'UPLOAD_EXPIRED' || error.code === 'PRECHECK_EXPIRED') {
    return {
      ...meta,
      kind: 'expired',
      title: translate('errors.uploadExpired.title'),
      message: translate('errors.uploadExpired.text'),
      retryable: false,
      canRestoreText: true,
    };
  }

  if (error.code === 'ATTACHMENT_NOT_READY') {
    return {
      ...meta,
      kind: 'conflict',
      title: translate('errors.attachmentNotReady.title'),
      message: translate('errors.attachmentNotReady.text'),
      retryable: true,
      canRestoreText: true,
    };
  }

  if (error.code === 'ATTACHMENT_QUARANTINED' || error.status === 423) {
    return {
      ...meta,
      kind: 'attachment',
      title: translate('errors.attachmentQuarantined.title'),
      message: translate('errors.attachmentQuarantined.text'),
      retryable: false,
      canRestoreText: true,
    };
  }

  if (error.code === 'SCAN_PENDING') {
    return {
      ...meta,
      kind: 'attachment',
      title: translate('errors.scanPending.title'),
      message: translate('errors.scanPending.text'),
      retryable: true,
      canRestoreText: false,
    };
  }

  if (error.code === 'ATTACHMENT_DELETED') {
    return {
      ...meta,
      kind: 'expired',
      title: translate('errors.attachmentDeleted.title'),
      message: translate('errors.attachmentDeleted.text'),
      retryable: false,
      canRestoreText: false,
    };
  }

  if (
    error.code === 'SCAN_TIMEOUT' ||
    error.code === 'SCAN_FAILED' ||
    error.code === 'ATTACHMENT_ID_MISSING' ||
    error.code === 'CHUNK_UPLOAD_FAILED' ||
    error.code === 'CHUNK_UPLOAD_REJECTED'
  ) {
    return {
      ...meta,
      kind: 'server',
      title: translate('errors.scanFailed.title'),
      message: translate('errors.scanFailed.text'),
      retryable: true,
      canRestoreText: false,
    };
  }

  if (error.status === 429) {
    const seconds = error.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_SECONDS;
    return {
      ...meta,
      retryAfterSeconds: seconds,
      kind: 'rate_limit',
      title: translate('errors.rateLimit.title'),
      message: translate('errors.rateLimit.text', { seconds }),
      retryable: true,
      canRestoreText: false,
    };
  }

  if (error.status === 409) {
    if (error.code === 'DEVICE_LIMIT_REACHED') {
      return {
        ...meta,
        kind: 'limit',
        title: translate('auth.deviceLimit.title'),
        message: translate('auth.deviceLimit.text'),
        retryable: false,
        canRestoreText: false,
      };
    }
    if (error.code === 'IDEMPOTENCY_IN_PROGRESS') {
      const seconds = error.retryAfterSeconds ?? 1;
      return {
        ...meta,
        retryAfterSeconds: seconds,
        kind: 'conflict',
        title: translate('errors.inProgress.title'),
        message: translate('errors.inProgress.text', { seconds }),
        retryable: true,
        canRestoreText: false,
      };
    }
    if (error.code === 'IDEMPOTENCY_KEY_REUSED') {
      return {
        ...meta,
        kind: 'conflict',
        title: translate('errors.keyReused.title'),
        message: translate('errors.keyReused.text'),
        retryable: false,
        canRestoreText: true,
      };
    }
    if (error.code === 'CLIENT_MESSAGE_ID_CONFLICT') {
      return {
        ...meta,
        kind: 'conflict',
        title: translate('errors.clientMessageConflict.title'),
        message: translate('errors.clientMessageConflict.text'),
        retryable: false,
        canRestoreText: true,
      };
    }
    return {
      ...meta,
      kind: 'conflict',
      title: translate('errors.conflict.title'),
      message: translate('errors.conflict.text'),
      retryable: false,
      canRestoreText: true,
    };
  }

  if (error.status === 422) {
    if (error.code === 'MESSAGE_TOO_LONG') {
      return {
        ...meta,
        kind: 'too_long',
        title: translate('errors.tooLong.title'),
        message: translate('errors.tooLong.text'),
        retryable: false,
        canRestoreText: true,
      };
    }
    return {
      ...meta,
      kind: 'validation',
      title: translate('errors.validation.title'),
      message: translate('errors.validation.text'),
      retryable: false,
      canRestoreText: true,
    };
  }

  if (error.status === 400) {
    return {
      ...meta,
      kind: 'validation',
      title: translate('errors.validation.title'),
      message: translate('errors.validation.text'),
      retryable: false,
      canRestoreText: true,
    };
  }

  if (error.status >= 500) {
    return {
      ...meta,
      kind: 'server',
      title: translate('errors.server.title'),
      message: translate('errors.server.text'),
      retryable: true,
      canRestoreText: false,
    };
  }

  if (error.code === 'NO_SESSION') {
    return {
      ...meta,
      kind: 'session',
      title: translate('errors.session.title'),
      message: translate('errors.session.text'),
      retryable: true,
      canRestoreText: false,
    };
  }

  return {
    ...meta,
    kind: 'generic',
    title: translate('errors.generic.title'),
    message: translate('errors.generic.text'),
    retryable: error.isRetryable,
    canRestoreText: false,
  };
}

import { useState, type FormEvent } from 'react';
import type { Room } from '../api/types';
import { t } from '../i18n/ru';
import { useRoomsState, useRoomsStore } from '../store/ChatProvider';
import { DeviceImageUpload } from './DeviceImageUpload';

export function RoomCreateDialog({ onClose }: { onClose: () => void }) {
  const store = useRoomsStore();
  const state = useRoomsState();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const busy = state.pending?.kind === 'create';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('rooms.create.empty'));
      return;
    }
    const ok = await store.createRoom(trimmed);
    if (ok) onClose();
    else setError(t('rooms.create.error'));
  };
  return (
    <div className="modal-layer">
      <form
        className="modal modal--sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="room-create-title"
        onSubmit={(event) => void submit(event)}
      >
        <div className="modal-head">
          <h2 className="modal-title" id="room-create-title">
            {t('rooms.create.heading')}
          </h2>
          <button
            type="button"
            className="modal-x"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span className="field__label">{t('rooms.create.label')}</span>
            <input
              className="input"
              autoFocus
              value={name}
              placeholder={t('rooms.create.placeholder')}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              aria-invalid={error !== null}
            />
          </label>
          {error ? (
            <p className="field__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="modal-foot">
          <button type="button" className="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="button button--primary" disabled={busy}>
            {busy ? t('rooms.create.submitting') : t('rooms.create.submit')}
          </button>
        </div>
      </form>
    </div>
  );
}

export function RoomEditDialog({ room, onClose }: { room: Room; onClose: () => void }) {
  const store = useRoomsStore();
  const state = useRoomsState();
  const [name, setName] = useState(room.name);
  const [confirmClose, setConfirmClose] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = state.pending?.roomId === room.id;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('rooms.create.empty'));
      return;
    }
    if (trimmed === room.name) {
      onClose();
      return;
    }
    if (await store.renameRoom(room.id, trimmed)) onClose();
    else setError(t('rooms.rename.error'));
  };
  return (
    <div className="modal-layer">
      <div
        className="modal modal--sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="room-edit-title"
      >
        <div className="modal-head">
          <h2 className="modal-title" id="room-edit-title">
            {t('rooms.rename')}
          </h2>
          <button
            type="button"
            className="modal-x"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </div>
        <form className="modal-body" onSubmit={(event) => void save(event)}>
          <label className="field">
            <span className="field__label">{t('rooms.create.label')}</span>
            <input
              className="input"
              autoFocus
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
            />
          </label>
          {error ? (
            <p className="field__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="setting-row">
            <div className="text">
              <b>{t('rooms.avatar.change')}</b>
            </div>
            <button type="button" className="button" onClick={() => setAvatarOpen((open) => !open)}>
              {t('rooms.avatar.change')}
            </button>
          </div>
          {avatarOpen ? (
            <DeviceImageUpload
              chatId={room.chat_id}
              aspect={1}
              onUploaded={() => {
                setAvatarOpen(false);
                onClose();
              }}
            />
          ) : null}
          {confirmClose ? (
            <div
              className="room-close"
              role="group"
              aria-label={t('rooms.close.question', { name: room.name })}
            >
              <p>{t('rooms.close.question', { name: room.name })}</p>
              <div className="room-create__actions">
                <button type="button" className="button" onClick={() => setConfirmClose(false)}>
                  {t('rooms.close.cancel')}
                </button>
                <button
                  type="button"
                  className="button button--danger"
                  disabled={busy}
                  onClick={async () => {
                    if (await store.closeRoom(room.id)) onClose();
                  }}
                >
                  {t('rooms.close.confirm')}
                </button>
              </div>
            </div>
          ) : null}
        </form>
        <div className="modal-foot">
          {!confirmClose ? (
            <button
              type="button"
              className="button button--danger"
              onClick={() => setConfirmClose(true)}
            >
              {t('rooms.close')}
            </button>
          ) : null}
          <button type="button" className="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={busy}
            onClick={(event) => void save(event)}
          >
            {t('rooms.rename.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useId, useState } from 'react';
import { t } from '../i18n/ru';
import { readCallPreferences, writeCallPreferences } from '../prefs/callPreferences';

export interface CallLobbyProps {
  title: string;
  onCancel: () => void;
  onConnect: () => void;
}

/**
 * #193: pre-join device settings. No media is requested here; the call asks for
 * the camera/microphone only after the user presses "Подключиться".
 */
export function CallLobby({ title, onCancel, onConnect }: CallLobbyProps) {
  const titleId = useId();
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [microphoneId, setMicrophoneId] = useState('');

  useEffect(() => {
    const prefs = readCallPreferences();
    setCameraOn(prefs.cameraOnByDefault);
    setMicOn(prefs.microphoneOnByDefault);
    setCameraId(prefs.cameraDeviceId ?? '');
    setMicrophoneId(prefs.microphoneDeviceId ?? '');
    if (!navigator.mediaDevices?.enumerateDevices) {
      setDevices([]);
      return;
    }
    void navigator.mediaDevices
      .enumerateDevices()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);

  const connect = () => {
    writeCallPreferences({
      microphoneOnByDefault: micOn,
      cameraOnByDefault: cameraOn,
      microphoneDeviceId: microphoneId || null,
      cameraDeviceId: cameraId || null,
    });
    onConnect();
  };

  return (
    <div className="modal-layer call-lobby">
      <div className="modal modal--sm" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-head">
          <h2 className="modal-title" id={titleId}>
            {title}
          </h2>
          <button
            type="button"
            className="modal-x"
            onClick={onCancel}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="call-lobby__preview">
            <span>{t('calls.lobby.previewHint')}</span>
          </div>
          <div className="call-lobby__buttons">
            <button
              type="button"
              className={`call-button call-button--round${micOn ? '' : ' is-active'}`}
              aria-pressed={micOn}
              onClick={() => setMicOn((on) => !on)}
            >
              {micOn ? t('calls.mute') : t('calls.unmute')}
            </button>
            <button
              type="button"
              className={`call-button call-button--round${cameraOn ? '' : ' is-active'}`}
              aria-pressed={cameraOn}
              onClick={() => setCameraOn((on) => !on)}
            >
              {cameraOn ? t('calls.cameraOff') : t('calls.cameraOn')}
            </button>
          </div>
          <label className="field">
            <span className="field__label">{t('calls.microphone')}</span>
            <select
              className="input"
              value={microphoneId}
              onChange={(event) => setMicrophoneId(event.target.value)}
            >
              <option value="">{t('calls.deviceDefault')}</option>
              {devices
                .filter((device) => device.kind === 'audioinput')
                .map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || t('calls.microphone')}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{t('calls.camera')}</span>
            <select
              className="input"
              value={cameraId}
              onChange={(event) => setCameraId(event.target.value)}
            >
              <option value="">{t('calls.deviceDefault')}</option>
              {devices
                .filter((device) => device.kind === 'videoinput')
                .map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || t('calls.camera')}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <div className="modal-foot">
          <button type="button" className="button" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" className="button button--primary" onClick={connect}>
            {t('calls.lobby.connect')}
          </button>
        </div>
      </div>
    </div>
  );
}

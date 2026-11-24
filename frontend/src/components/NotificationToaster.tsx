import { useEffect, useState } from 'react';
import { t } from '../i18n/ru';
import { useChatStore } from '../store/ChatProvider';
import { CloseIcon } from './Icons';

interface IncomingToast {
  id: number;
  chatId: string;
  chatName: string;
  author: string;
  text: string;
}

/** Short WebAudio chime; no asset request and no autoplay before a user gesture. */
function playChime(): void {
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  try {
    const context = new Ctx();
    const now = context.currentTime;
    for (const [index, frequency] of [660, 880].entries()) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + index * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.08, now + index * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.12 + 0.16);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(now + index * 0.12);
      oscillator.stop(now + index * 0.12 + 0.18);
    }
    window.setTimeout(() => void context.close().catch(() => undefined), 600);
  } catch {
    // Audio unavailable; the toast remains.
  }
}

/** #183: small in-app notification toasts with sound. */
export function NotificationToaster() {
  const store = useChatStore();
  const [items, setItems] = useState<IncomingToast[]>([]);

  useEffect(() => {
    let counter = 0;
    const onIncoming = (event: Event) => {
      const detail = (event as CustomEvent<Omit<IncomingToast, 'id'>>).detail;
      if (!detail) return;
      const id = ++counter;
      setItems((current) => [...current.slice(-3), { ...detail, id }]);
      playChime();
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification(detail.chatName, {
            body: `${detail.author}: ${detail.text}`.slice(0, 160),
            tag: `sova-${detail.chatId}`,
          });
        } catch {
          // Desktop notifications can be blocked by the OS; toast is enough.
        }
      }
      window.setTimeout(() => {
        setItems((current) => current.filter((item) => item.id !== id));
      }, 6000);
    };
    window.addEventListener('sova:incoming-message', onIncoming);
    return () => window.removeEventListener('sova:incoming-message', onIncoming);
  }, []);

  if (items.length === 0) return null;
  return (
    <div className="notification-toasts" role="region" aria-label={t('notifications.toasts')}>
      {items.map((item) => (
        <button
          type="button"
          key={item.id}
          className="notification-toast"
          onClick={() => {
            void store.setActiveChat(item.chatId);
            setItems((current) => current.filter((entry) => entry.id !== item.id));
          }}
        >
          <span className="notification-toast__body">
            <strong>{item.chatName}</strong>
            <span>
              {item.author ? `${item.author}: ` : ''}
              {item.text}
            </span>
          </span>
          <span
            className="notification-toast__close"
            role="button"
            tabIndex={0}
            aria-label={t('common.close')}
            onClick={(event) => {
              event.stopPropagation();
              setItems((current) => current.filter((entry) => entry.id !== item.id));
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.stopPropagation();
              setItems((current) => current.filter((entry) => entry.id !== item.id));
            }}
          >
            <CloseIcon aria-hidden="true" />
          </span>
        </button>
      ))}
    </div>
  );
}

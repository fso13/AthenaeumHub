import { t } from '../i18n/ru';
import { formatDateTime } from './admin/format';
import { Avatar } from './Avatar';
import { PhoneIcon, PlusIcon } from './Icons';
import { useChatState, useProfileWorkspaceState } from '../store/ChatProvider';

const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Владелец',
  ADMIN: 'Администратор',
  MEMBER: 'Участник',
  GUEST: 'Гость',
};

export function UserProfilePanel({
  userId,
  name,
  onClose,
  onWrite,
  onCall,
}: {
  userId: string;
  name: string;
  onClose: () => void;
  onWrite: () => void;
  onCall: () => void;
}) {
  const state = useChatState();
  const profile = useProfileWorkspaceState();
  const member = state.workspaceMembers.items.find((item) => item.user_id === userId) ?? null;
  const isMe = (state.user?.id ?? state.session?.user.id ?? null) === userId;
  const displayName = member?.display_name ?? name;
  return (
    <aside className="user-panel" aria-label={t('userPanel.title')}>
      <div className="user-panel__head">
        <h2>{t('userPanel.title')}</h2>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label={t('common.close')}
        >
          ×
        </button>
      </div>
      <div className="user-panel__identity">
        <Avatar
          name={displayName}
          seed={userId}
          size="profile"
          src={isMe ? profile.avatar.previewUrl : null}
        />
        <strong>{displayName}</strong>
        <span>{member ? (ROLE_LABELS[member.role] ?? member.role) : t('userPanel.member')}</span>
      </div>
      {member?.joined_at ? (
        <div className="user-panel__row">
          <span>{t('userPanel.joined')}</span>
          <b>{formatDateTime(member.joined_at)}</b>
        </div>
      ) : null}
      <div className="user-panel__actions">
        <button type="button" className="btn btn--accent" onClick={onWrite}>
          <PlusIcon aria-hidden="true" />
          {t('userPanel.write')}
        </button>
        <button type="button" className="btn" onClick={onCall}>
          <PhoneIcon aria-hidden="true" />
          {t('userPanel.call')}
        </button>
      </div>
    </aside>
  );
}

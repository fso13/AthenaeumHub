import type { ReactNode, SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'>;

function IconBase({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 19V5" />
      <path d="m6 11 6-6 6 6" />
    </IconBase>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </IconBase>
  );
}

export function RetryIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 13a8 8 0 1 1 2.3 5.7" />
      <path d="M4 20v-7h7" />
    </IconBase>
  );
}

export function ReplyIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9 17H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2" />
      <path d="m9 17 4 4" />
      <path d="M9 17 7 21" />
      <path d="M15 13h6" />
      <path d="m18 10 3 3-3 3" />
    </IconBase>
  );
}

/** D1-FE3: flat thread branch (one root, depth 1). */
export function ThreadIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 4v7a3 3 0 0 0 3 3h7" />
      <path d="m12 11 3 3-3 3" />
      <path d="M9 20h4" />
    </IconBase>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </IconBase>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </IconBase>
  );
}

/** D1 UX: header search and the in-chat filter bar. */
export function SearchIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.4-3.4" />
    </IconBase>
  );
}

/** D1 UX: header call action (honestly disabled until the calls API lands). */
export function PhoneIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6.5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2Z" />
    </IconBase>
  );
}

/** D1 UX: header video-call action (honestly disabled until the calls API lands). */
export function VideoIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="2.5" y="6" width="13" height="12" rx="2.5" />
      <path d="m15.5 10.5 6-3v9l-6-3" />
    </IconBase>
  );
}

/** §9 call controls: camera off. */
export function VideoOffIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M10.7 6H13a2.5 2.5 0 0 1 2.5 2.5v2.2" />
      <path d="M15.5 13.7V15a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 15V9A2.5 2.5 0 0 1 5 6.5h.8" />
      <path d="m21.5 7.5-6 3v3l6 3Z" />
      <path d="M3 3l18 18" />
    </IconBase>
  );
}

/** §9 call controls: hang up. */
export function PhoneOffIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6.5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2Z" />
      <path d="M3 3l18 18" />
    </IconBase>
  );
}

/** #107 call output controls: speaker on. */
export function SpeakerIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 9v6h4l5 4V5L8 9H4Z" />
      <path d="M16.5 8.5a5 5 0 0 1 0 7" />
      <path d="M19 6a8.5 8.5 0 0 1 0 12" />
    </IconBase>
  );
}

/** #107 call output controls: output muted. */
export function SpeakerOffIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 9v6h4l5 4V5L8 9H4Z" />
      <path d="m16 9 5 6" />
      <path d="m21 9-5 6" />
    </IconBase>
  );
}

/** D1 UX: details-panel toggle in the chat header. */
export function InfoIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6" />
      <path d="M12 7.5h.01" />
    </IconBase>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m6 9 6 6 6-6" />
    </IconBase>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m9 6 6 6-6 6" />
    </IconBase>
  );
}

export function EmojiIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
      <path d="M9 9.5h.01" />
      <path d="M15 9.5h.01" />
    </IconBase>
  );
}

export function ChevronUpIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m6 15 6-6 6 6" />
    </IconBase>
  );
}

export function WifiOffIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M2 2l20 20" />
      <path d="M8.5 16.5a5 5 0 0 1 7 0" />
      <path d="M5 12.9a10 10 0 0 1 3.5-2.2" />
      <path d="M15.5 10.7A10 10 0 0 1 19 12.9" />
      <path d="M2 8.8a15 15 0 0 1 4.3-2.6" />
      <path d="M17.7 6.2A15 15 0 0 1 22 8.8" />
      <path d="M12 20h.01" />
    </IconBase>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 9v5" />
      <path d="M12 17.5h.01" />
    </IconBase>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="4" y="10" width="16" height="11" rx="2.5" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </IconBase>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m4 12 5 5L20 6" />
    </IconBase>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </IconBase>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.5 9.5 0 0 1-4-.9L3 21l1.9-4.6A8.4 8.4 0 1 1 21 11.5Z" />
    </IconBase>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3 4 6v6c0 4.4 3.4 7.6 8 9 4.6-1.4 8-4.6 8-9V6l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </IconBase>
  );
}

export function LogoutIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </IconBase>
  );
}

export function WorkspaceIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 21V8l8-4 8 4v13" />
      <path d="M9 21v-6h6v6" />
      <path d="M4 21h16" />
    </IconBase>
  );
}

/** D1-FE1: workspace section icons. */
export function OverviewIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </IconBase>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M3 11h18" />
    </IconBase>
  );
}

export function PlugIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9 3v5" />
      <path d="M15 3v5" />
      <path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6Z" />
      <path d="M12 17v4" />
    </IconBase>
  );
}

/** #96: bot identity (workspace bots and the BOT sender badge). */
export function BotIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="4" y="8" width="16" height="12" rx="4" />
      <path d="M12 8V4" />
      <circle cx="12" cy="3" r="1" />
      <path d="M9 13v1.5M15 13v1.5" />
      <path d="M9.5 17h5" />
    </IconBase>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </IconBase>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M20 12H4" />
      <path d="m10 6-6 6 6 6" />
    </IconBase>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.9 4.9 1.4 1.4" />
      <path d="m17.7 17.7 1.4 1.4" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m4.9 19.1 1.4-1.4" />
      <path d="m17.7 6.3 1.4-1.4" />
    </IconBase>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M20 15.5A8 8 0 0 1 9.5 4 7 7 0 1 0 20 15.5Z" />
    </IconBase>
  );
}

export function PeopleIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" />
      <circle cx="9" cy="7.5" r="3.5" />
      <path d="M22 20v-1.5a4 4 0 0 0-3-3.87" />
      <path d="M16 4.13a3.5 3.5 0 0 1 0 6.74" />
    </IconBase>
  );
}

export function PaperclipIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m21 11.5-8.6 8.6a5.2 5.2 0 0 1-7.4-7.4l8.2-8.2a3.6 3.6 0 1 1 5.1 5.1l-8.3 8.3a2 2 0 0 1-2.8-2.8l7.6-7.6" />
    </IconBase>
  );
}

export function StickerIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M20 12a8 8 0 1 0-8 8h4l4-4v-4Z" />
      <path d="M20 12h-4a4 4 0 0 0-4 4v4" />
      <path d="M8 9h.01" />
      <path d="M13 9h.01" />
      <path d="M9 13a4 4 0 0 0 5 0" />
    </IconBase>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M18 9a6 6 0 1 0-12 0c0 4-2 5-2 6h16c0-1-2-2-2-6Z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </IconBase>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 6h9" />
      <path d="M17 6h3" />
      <circle cx="15" cy="6" r="2" />
      <path d="M4 12h3" />
      <path d="M11 12h9" />
      <circle cx="9" cy="12" r="2" />
      <path d="M4 18h9" />
      <path d="M17 18h3" />
      <circle cx="15" cy="18" r="2" />
    </IconBase>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </IconBase>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
    </IconBase>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9 4v16" />
      <path d="M15 4v16" />
    </IconBase>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m7 4 13 8-13 8Z" />
    </IconBase>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v5" />
      <path d="M8 22h8" />
    </IconBase>
  );
}

/** §9 call controls: muted microphone. */
export function MicOffIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9 9v2a3 3 0 0 0 4.6 2.5" />
      <path d="M15 10V5a3 3 0 0 0-5.7-1.3" />
      <path d="M5 10a7 7 0 0 0 11.4 5.5" />
      <path d="M19 10a7 7 0 0 1-.8 3.3" />
      <path d="M12 17v5" />
      <path d="M8 22h8" />
      <path d="M3 3l18 18" />
    </IconBase>
  );
}

export function MusicIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </IconBase>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="m5 6 1 15h12l1-15" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </IconBase>
  );
}

/** #62: edit own managed text (pencil). */
export function EditIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
      <path d="m14 6 4 4" />
    </IconBase>
  );
}

/** #61/#63: compact "more actions" trigger on touch layouts. */
export function MoreIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

/* D1 UX fidelity 2: section-page and details icons from design/dashboard. */

export function HashIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9.4 3.8 7.9 20.2M16.2 3.8l-1.5 16.4M3.8 8.4h16.4M3.2 15.6h16.4" />
    </IconBase>
  );
}

export function UserPlusIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="9.4" cy="8.4" r="3.5" />
      <path d="M3.4 20.2c.4-3.4 2.8-5.3 6-5.3 1.2 0 2.3.3 3.2.8" />
      <path d="M18.4 13.6v6M15.4 16.6h6" />
    </IconBase>
  );
}

export function ImageIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3.4" y="4.4" width="17.2" height="15.2" rx="3" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m5 17.4 4.6-4.6 4.6 4.6 2.6-2.6 3.7 3.7" />
    </IconBase>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M2.6 12S6.1 5.6 12 5.6 21.4 12 21.4 12 17.9 18.4 12 18.4 2.6 12 2.6 12Z" />
      <circle cx="12" cy="12" r="3" />
    </IconBase>
  );
}

export function EyeOffIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m3 3 18 18" />
      <path d="M10.6 6.1A9.7 9.7 0 0 1 12 5.6c5.9 0 9.4 6.4 9.4 6.4a15.4 15.4 0 0 1-3.2 3.7" />
      <path d="M6.4 6.7C3.9 8.3 2.6 12 2.6 12s3.5 6.4 9.4 6.4c1.8 0 3.3-.6 4.6-1.4" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </IconBase>
  );
}

export function MonitorIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="4.4" width="18" height="12.4" rx="2.6" />
      <path d="M9 20h6M12 16.8V20" />
    </IconBase>
  );
}

/** Chat UI polish: expand an inline video into the full-screen lightbox. */
export function ExpandIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9.2 4H4v5.2M14.8 4H20v5.2M20 14.8V20h-5.2M4 14.8V20h5.2" />
    </IconBase>
  );
}

export function SmartphoneIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="7" y="2.6" width="10" height="18.8" rx="2.6" />
      <path d="M11 18.4h2" />
    </IconBase>
  );
}

export function KeyIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="8" cy="12" r="4.2" />
      <path d="M12.2 12h8.6M18.2 12v3.1M15.7 12v2.1" />
    </IconBase>
  );
}

export function LinkIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M10 14a4.5 4.5 0 0 0 6.4 0l2.6-2.6a4.5 4.5 0 0 0-6.4-6.4L11 6.6" />
      <path d="M14 10a4.5 4.5 0 0 0-6.4 0L5 12.6a4.5 4.5 0 0 0 6.4 6.4l1.6-1.6" />
    </IconBase>
  );
}

export function FlagIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6 20.4V4.2c4.2-2 6 2.2 11 0v9.4c-5 2.2-6.8-2-11 0" />
    </IconBase>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="8.4" y="8.4" width="11.4" height="11.4" rx="3" />
      <path d="M15.6 8.4V6.2a2 2 0 0 0-2-2H6.2a2 2 0 0 0-2 2v7.4a2 2 0 0 0 2 2h2.2" />
    </IconBase>
  );
}

export function PollIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5.2 19.4V9.6M12 19.4V4.8M18.8 19.4v-6.8" />
      <path d="M2.6 19.4h18.8" />
    </IconBase>
  );
}

export function TaskIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3.8" y="3.8" width="16.4" height="16.4" rx="4.4" />
      <path d="m8.3 12 2.4 2.4 5.1-5.2" />
    </IconBase>
  );
}

export function TranslateIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3.6 5.6h8.2M7.7 3.6v2c0 4-2 7.1-5 8.6" />
      <path d="M4.8 10.6c1.3 2.6 3.3 4.1 6.1 4.6" />
      <path d="m11.8 20.4 4.1-10.2 4.1 10.2M13.4 16.9h5.1" />
    </IconBase>
  );
}

export function SparklesIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
      <path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" />
    </IconBase>
  );
}

/** #80: pin/unpin a channel message. */
export function PinIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9.4 3.8h5.2l-.8 5.4 3 3v1.4H7.2v-1.4l3-3-.8-5.4Z" />
      <path d="M12 13.6v6.6" />
    </IconBase>
  );
}

/** Collapse an active call into the non-modal mini bar. */
export function MinimizeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9.2 4H4v5.2M14.8 4H20v5.2M20 14.8V20h-5.2M4 14.8V20h5.2" />
    </IconBase>
  );
}

export function ForwardIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M14 5.5 21 12l-7 6.5v-4.2C8 14.3 5 16.5 3 20c.4-5.6 3.4-8.8 11-9.2V5.5Z" />
    </IconBase>
  );
}

/** Slack-style inline code glyph (provided by the design). */
export function CodeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 18 15" fill="none" aria-hidden="true" {...props}>
      <path
        d="M10.7827 0.834227C10.8248 0.65998 10.7958 0.476181 10.7023 0.323264C10.6088 0.170347 10.4584 0.0608376 10.2841 0.0188273C10.1099 -0.023183 9.9261 0.00574673 9.77318 0.0992524C9.62026 0.192758 9.51075 0.34318 9.46874 0.517427L6.31874 13.5674C6.27673 13.7417 6.30566 13.9255 6.39917 14.0784C6.49268 14.2313 6.6431 14.3408 6.81734 14.3828C6.99159 14.4248 7.17539 14.3959 7.32831 14.3024C7.48122 14.2089 7.59073 14.0585 7.63274 13.8842L10.7827 0.834227ZM4.73744 2.88443C4.6071 2.76177 4.43338 2.69589 4.25448 2.70129C4.07558 2.70669 3.90615 2.78293 3.78344 2.91323L0.183445 6.73823C0.0656117 6.86344 0 7.02889 0 7.20083C0 7.37276 0.0656117 7.53822 0.183445 7.66343L3.78344 11.4884C3.90702 11.615 4.07534 11.688 4.25219 11.6917C4.42903 11.6954 4.60027 11.6296 4.72906 11.5083C4.85786 11.3871 4.93391 11.2201 4.94086 11.0434C4.94782 10.8666 4.88511 10.6942 4.76624 10.5632L1.60274 7.20083L4.76714 3.83843C4.88981 3.70809 4.95568 3.53436 4.95028 3.35546C4.94488 3.17656 4.86774 3.00713 4.73744 2.88443ZM12.3622 2.88443C12.4926 2.76177 12.6663 2.69589 12.8452 2.70129C13.0241 2.70669 13.1935 2.78293 13.3162 2.91323L16.9162 6.73823C17.0341 6.86344 17.0997 7.02889 17.0997 7.20083C17.0997 7.37276 17.0341 7.53822 16.9162 7.66343L13.3162 11.4884C13.1927 11.615 13.0243 11.688 12.8475 11.6917C12.6707 11.6954 12.4994 11.6296 12.3706 11.5083C12.2418 11.3871 12.1658 11.2201 12.1588 11.0434C12.1519 10.8666 12.2146 10.6942 12.3334 10.5632L15.4987 7.20083L12.3343 3.83843C12.2117 3.70809 12.1458 3.53436 12.1512 3.35546C12.1566 3.17656 12.2328 3.00713 12.3631 2.88443H12.3622Z"
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function CodeBlockIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 18 15" fill="none" aria-hidden="true" {...props}>
      <path
        d="M10.7827 0.834227C10.8248 0.65998 10.7958 0.476181 10.7023 0.323264C10.6088 0.170347 10.4584 0.0608376 10.2841 0.0188273C10.1099 -0.023183 9.9261 0.00574673 9.77318 0.0992524C9.62026 0.192758 9.51075 0.34318 9.46874 0.517427L6.31874 13.5674C6.27673 13.7417 6.30566 13.9255 6.39917 14.0784C6.49268 14.2313 6.6431 14.3408 6.81734 14.3828C6.99159 14.4248 7.17539 14.3959 7.32831 14.3024C7.48122 14.2089 7.59073 14.0585 7.63274 13.8842L10.7827 0.834227ZM4.73744 2.88443C4.6071 2.76177 4.43338 2.69589 4.25448 2.70129C4.07558 2.70669 3.90615 2.78293 3.78344 2.91323L0.183445 6.73823C0.0656117 6.86344 0 7.02889 0 7.20083C0 7.37276 0.0656117 7.53822 0.183445 7.66343L3.78344 11.4884C3.90702 11.615 4.07534 11.688 4.25219 11.6917C4.42903 11.6954 4.60027 11.6296 4.72906 11.5083C4.85786 11.3871 4.93391 11.2201 4.94086 11.0434C4.94782 10.8666 4.88511 10.6942 4.76624 10.5632L1.60274 7.20083L4.76714 3.83843C4.88981 3.70809 4.95568 3.53436 4.95028 3.35546C4.94488 3.17656 4.86774 3.00713 4.73744 2.88443ZM12.3622 2.88443C12.4926 2.76177 12.6663 2.69589 12.8452 2.70129C13.0241 2.70669 13.1935 2.78293 13.3162 2.91323L16.9162 6.73823C17.0341 6.86344 17.0997 7.02889 17.0997 7.20083C17.0997 7.37276 17.0341 7.53822 16.9162 7.66343L13.3162 11.4884C13.1927 11.615 13.0243 11.688 12.8475 11.6917C12.6707 11.6954 12.4994 11.6296 12.3706 11.5083C12.2418 11.3871 12.1658 11.2201 12.1588 11.0434C12.1519 10.8666 12.2146 10.6942 12.3334 10.5632L15.4987 7.20083L12.3343 3.83843C12.2117 3.70809 12.1458 3.53436 12.1512 3.35546C12.1566 3.17656 12.2328 3.00713 12.3631 2.88443H12.3622Z"
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function NumberListIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 15" fill="none" aria-hidden="true" {...props}>
      <path
        d="M2.0628 0.084402C2.12075 0.126093 2.16795 0.180973 2.2005 0.244509C2.23305 0.308045 2.25002 0.378413 2.25 0.449802V3.5998H3.15C3.26935 3.5998 3.38381 3.64721 3.4682 3.7316C3.55259 3.81599 3.6 3.93045 3.6 4.0498C3.6 4.16915 3.55259 4.28361 3.4682 4.368C3.38381 4.45239 3.26935 4.4998 3.15 4.4998H0.45C0.330653 4.4998 0.216193 4.45239 0.131802 4.368C0.0474106 4.28361 0 4.16915 0 4.0498C0 3.93045 0.0474106 3.81599 0.131802 3.7316C0.216193 3.64721 0.330653 3.5998 0.45 3.5998H1.35V1.0744L0.5922 1.3264C0.480465 1.35899 0.360449 1.34702 0.257352 1.293C0.154255 1.23898 0.0760985 1.14712 0.0392925 1.0367C0.00248653 0.926286 0.0098946 0.805902 0.0599612 0.70083C0.110028 0.595758 0.198858 0.514171 0.3078 0.473202L1.6578 0.0232019C1.72533 0.000632862 1.79726 -0.00558768 1.86767 0.00505149C1.93807 0.0156907 2.00495 0.0428859 2.0628 0.084402ZM5.625 1.3498C5.44598 1.3498 5.27429 1.42092 5.1477 1.5475C5.02112 1.67409 4.95 1.84578 4.95 2.0248C4.95 2.20382 5.02112 2.37551 5.1477 2.5021C5.27429 2.62869 5.44598 2.6998 5.625 2.6998H14.625C14.804 2.6998 14.9757 2.62869 15.1023 2.5021C15.2289 2.37551 15.3 2.20382 15.3 2.0248C15.3 1.84578 15.2289 1.67409 15.1023 1.5475C14.9757 1.42092 14.804 1.3498 14.625 1.3498H5.625ZM4.95 7.8748C4.95 7.69578 5.02112 7.52409 5.1477 7.3975C5.27429 7.27092 5.44598 7.1998 5.625 7.1998H14.625C14.804 7.1998 14.9757 7.27092 15.1023 7.3975C15.2289 7.52409 15.3 7.69578 15.3 7.8748C15.3 8.05382 15.2289 8.22551 15.1023 8.3521C14.9757 8.47868 14.804 8.5498 14.625 8.5498H5.625C5.44598 8.5498 5.27429 8.47868 5.1477 8.3521C5.02112 8.22551 4.95 8.05382 4.95 7.8748ZM4.95 13.7248C4.95 13.5458 5.02112 13.3741 5.1477 13.2475C5.27429 13.1209 5.44598 13.0498 5.625 13.0498H14.625C14.804 13.0498 14.9757 13.1209 15.1023 13.2475C15.2289 13.3741 15.3 13.5458 15.3 13.7248C15.3 13.9038 15.2289 14.0755 15.1023 14.2021C14.9757 14.3287 14.804 14.3998 14.625 14.3998H5.625C5.44598 14.3998 5.27429 14.3287 5.1477 14.2021C5.02112 14.0755 4.95 13.9038 4.95 13.7248ZM1.0863 10.7008C1.17028 10.5914 1.27836 10.5028 1.40214 10.4419C1.52592 10.381 1.66206 10.3495 1.8 10.3498C2.241 10.3498 2.475 10.6918 2.475 11.0248C2.475 11.0824 2.4453 11.1994 2.3193 11.3929C2.1607 11.6218 1.98178 11.836 1.7847 12.0328C1.5543 12.2731 1.2879 12.526 1.0017 12.796L0.9225 12.8716C0.655099 13.1212 0.391371 13.3747 0.1314 13.6321C0.0686129 13.6951 0.0258963 13.7753 0.0086439 13.8625C-0.00860847 13.9497 0.000377132 14.0401 0.0344661 14.1223C0.068555 14.2044 0.126219 14.2746 0.200176 14.324C0.274133 14.3734 0.361066 14.3998 0.45 14.3998H3.15C3.26935 14.3998 3.38381 14.3524 3.4682 14.268C3.55259 14.1836 3.6 14.0691 3.6 13.9498C3.6 13.8305 3.55259 13.716 3.4682 13.6316C3.38381 13.5472 3.26935 13.4998 3.15 13.4998H1.5678L1.62 13.4503C1.9044 13.1821 2.1861 12.9148 2.4336 12.6565C2.67006 12.4189 2.88425 12.1601 3.0735 11.8834C3.2355 11.6341 3.375 11.3398 3.375 11.0248C3.375 10.3165 2.8512 9.4498 1.8 9.4498C1.45847 9.44941 1.12389 9.54629 0.835407 9.7291C0.546923 9.91191 0.316467 10.1731 0.171 10.4821C0.145767 10.5356 0.131314 10.5935 0.128467 10.6526C0.125621 10.7116 0.134436 10.7707 0.15441 10.8263C0.174384 10.882 0.205125 10.9332 0.244879 10.977C0.284632 11.0207 0.332619 11.0563 0.3861 11.0815C0.439581 11.1067 0.497508 11.1212 0.556574 11.124C0.615641 11.1269 0.674689 11.1181 0.730348 11.0981C0.786008 11.0781 0.837188 11.0474 0.880967 11.0076C0.924746 10.9679 0.960266 10.9199 0.9855 10.8664C1.01301 10.8077 1.04681 10.7522 1.0863 10.7008Z"
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function BulletListIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 15 15" fill="none" aria-hidden="true" {...props}>
      <path
        d="M1.8 0.9C1.8 1.13869 1.70518 1.36761 1.5364 1.5364C1.36761 1.70518 1.13869 1.8 0.9 1.8C0.661305 1.8 0.432387 1.70518 0.263604 1.5364C0.0948211 1.36761 0 1.13869 0 0.9C0 0.661305 0.0948211 0.432387 0.263604 0.263604C0.432387 0.0948211 0.661305 0 0.9 0C1.13869 0 1.36761 0.0948211 1.5364 0.263604C1.70518 0.432387 1.8 0.661305 1.8 0.9ZM4.5 0.9C4.5 0.720979 4.57112 0.54929 4.6977 0.422703C4.82429 0.296116 4.99598 0.225 5.175 0.225H14.175C14.354 0.225 14.5257 0.296116 14.6523 0.422703C14.7789 0.54929 14.85 0.720979 14.85 0.9C14.85 1.07902 14.7789 1.25071 14.6523 1.3773C14.5257 1.50388 14.354 1.575 14.175 1.575H5.175C4.99598 1.575 4.82429 1.50388 4.6977 1.3773C4.57112 1.25071 4.5 1.07902 4.5 0.9ZM5.175 6.525C4.99598 6.525 4.82429 6.59612 4.6977 6.7227C4.57112 6.84929 4.5 7.02098 4.5 7.2C4.5 7.37902 4.57112 7.55071 4.6977 7.6773C4.82429 7.80388 4.99598 7.875 5.175 7.875H14.175C14.354 7.875 14.5257 7.80388 14.6523 7.6773C14.7789 7.55071 14.85 7.37902 14.85 7.2C14.85 7.02098 14.7789 6.84929 14.6523 6.7227C14.5257 6.59612 14.354 6.525 14.175 6.525H5.175ZM5.175 12.825C4.99598 12.825 4.82429 12.8961 4.6977 13.0227C4.57112 13.1493 4.5 13.321 4.5 13.5C4.5 13.679 4.57112 13.8507 4.6977 13.9773C4.82429 14.1039 4.99598 14.175 5.175 14.175H14.175C14.354 14.175 14.5257 14.1039 14.6523 13.9773C14.7789 13.8507 14.85 13.679 14.85 13.5C14.85 13.321 14.7789 13.1493 14.6523 13.0227C14.5257 12.8961 14.354 12.825 14.175 12.825H5.175ZM0.9 8.1C1.13869 8.1 1.36761 8.00518 1.5364 7.8364C1.70518 7.66761 1.8 7.43869 1.8 7.2C1.8 6.9613 1.70518 6.73239 1.5364 6.5636C1.36761 6.39482 1.13869 6.3 0.9 6.3C0.661305 6.3 0.432387 6.39482 0.263604 6.5636C0.0948211 6.73239 0 6.9613 0 7.2C0 7.43869 0.0948211 7.66761 0.263604 7.8364C0.432387 8.00518 0.661305 8.1 0.9 8.1ZM0.9 14.4C1.13869 14.4 1.36761 14.3052 1.5364 14.1364C1.70518 13.9676 1.8 13.7387 1.8 13.5C1.8 13.2613 1.70518 13.0324 1.5364 12.8636C1.36761 12.6948 1.13869 12.6 0.9 12.6C0.661305 12.6 0.432387 12.6948 0.263604 12.8636C0.0948211 13.0324 0 13.2613 0 13.5C0 13.7387 0.0948211 13.9676 0.263604 14.1364C0.432387 14.3052 0.661305 14.4 0.9 14.4Z"
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
      />
    </svg>
  );
}

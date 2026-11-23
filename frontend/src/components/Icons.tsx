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

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 20, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...rest,
  };
}

export const MicIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);

export const MicOffIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M9 9v3a3 3 0 0 0 4.5 2.6M15 10.5V6a3 3 0 0 0-5.9-.7" />
    <path d="M5 11a7 7 0 0 0 10.5 6.1M12 18v3M4 4l16 16" />
  </svg>
);

export const VideoIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="2.5" y="6" width="13" height="12" rx="2.5" />
    <path d="M15.5 10.5 21 7.5v9l-5.5-3z" />
  </svg>
);

export const VideoOffIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M15.5 10.5 21 7.5v9l-3.2-1.8" />
    <path d="M13.5 18H5a2.5 2.5 0 0 1-2.5-2.5v-7A2.5 2.5 0 0 1 5 6h1.5M4 4l16 16" />
  </svg>
);

export const ScreenIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="2.5" y="4" width="19" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </svg>
);

export const HandIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 12V4.5a1.5 1.5 0 0 1 3 0V12M14 12V6.5a1.5 1.5 0 0 1 3 0V14" />
    <path d="M8 13v-1a1.5 1.5 0 0 0-3 0v3a6 6 0 0 0 6 6h2a6 6 0 0 0 6-6v-3" />
  </svg>
);

export const ChatIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M21 11.5a8 8 0 0 1-8 8H8l-4 3v-5.5a8 8 0 0 1 8-8h1a8 8 0 0 1 8 2.5z" />
  </svg>
);

export const UsersIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="9" cy="8" r="3.4" />
    <path d="M2.8 20a6.2 6.2 0 0 1 12.4 0" />
    <path d="M16.5 5.2a3.4 3.4 0 0 1 0 6.6M18 14.4A6.2 6.2 0 0 1 21.5 20" />
  </svg>
);

export const LogoutIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
    <path d="M10 8 6 12l4 4M6 12h9" />
  </svg>
);

export const PlusIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const CopyIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 6.5V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h1.5" />
  </svg>
);

export const EndIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3.5 14.5c5-4 12-4 17 0l-2.5 3-3.5-1.5v-2.4a9 9 0 0 0-5 0V16L6 17.5z" />
  </svg>
);

export const SendIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 12 20 4l-7 16-2.5-6.5z" />
  </svg>
);

export const ShieldIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3 4.5 6v6c0 4.2 3 7.6 7.5 9 4.5-1.4 7.5-4.8 7.5-9V6z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </svg>
);

export const BoardIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="13" rx="2" />
    <path d="M12 17v4M8.5 21h7" />
  </svg>
);

export const UserIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="8" r="3.6" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </svg>
);

export const MenuIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

export const BellIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
    <path d="M10 19a2.2 2.2 0 0 0 4 0" />
  </svg>
);

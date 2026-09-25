const PATHS: Record<string, string> = {
  home: 'm3 11 9-8 9 8v9a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
  inbox: 'M4 4h16v16H4zM4 14h5l2 3h2l2-3h5',
  chat: 'M21 15a4 4 0 0 1-4 4H8l-5 3 1.7-5A7 7 0 0 1 3 12V9a5 5 0 0 1 5-5h8a5 5 0 0 1 5 5z',
  check: 'm5 12 4 4L19 6',
  folder: 'M3 6h7l2 2h9v11H3z',
  book: 'M4 5a3 3 0 0 1 3-3h5v19H7a3 3 0 0 0-3 1zm16 0a3 3 0 0 0-3-3h-5v19h5a3 3 0 0 1 3 1z',
  video: 'M3 6h13v12H3zM16 10l5-3v10l-5-3z',
  users: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20v-2a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2m1-9a3 3 0 0 0 0-6m2 8a4 4 0 0 1 3 4v3',
  plus: 'M12 5v14M5 12h14',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM16 16l5 5',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.7 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1.2.9-1.2 1.7m0 4h.01',
  bell: 'M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 12h4',
  chevronDown: 'm8 10 4 4 4-4',
  chevronRight: 'm10 8 4 4-4 4',
  chevronLeft: 'm14 8-4 4 4 4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  spark: 'm12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z',
  file: 'M6 2h8l4 4v16H6zM14 2v5h5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  hash: 'M5 9h14M5 15h14M10 3 8 21M16 3l-2 18',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  megaphone: 'M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zm12-3a5 5 0 0 1 0 8m3-11a9 9 0 0 1 0 14',
  x: 'M6 6l12 12M18 6 6 18',
  send: 'M4 12 20 4l-5 16-3-7z',
  paperclip: 'M20 11.5 12.5 19a5 5 0 0 1-7-7L13 4.5a3.5 3.5 0 0 1 5 5l-7.5 7.5a2 2 0 0 1-3-3L14 7.5',
  smile: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01',
  thread: 'M4 5h16v10H9l-5 4z',
  pin: 'M9 3h6l-1 6 4 4H6l4-4zM12 13v8',
  bookmark: 'M6 3h12v18l-6-4-6 4z',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  trash: 'M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13',
  flag: 'M5 21V4h11l-1 4 1 4H5',
  task: 'M9 11l2 2 4-4M5 4h14v16H5z',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 1.2 14H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.6 7a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 7 2.6H7A1.7 1.7 0 0 0 8 1.1V1a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 2.6a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 19.4 7v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  upload: 'M12 16V4m-5 5 5-5 5 5M4 20h16',
  download: 'M12 4v12m-5-5 5 5 5-5M4 20h16',
  gavel: 'm14 4 6 6M11 7l6 6M8 10l6-6 6 6-6 6zM3 21l7-7',
  alert: 'M12 3 2 21h20zM12 10v4m0 3h.01',
  board: 'M4 4h5v16H4zM10 4h5v10h-5zM16 4h4v7h-4z',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  inboxCheck: 'M4 4h16v16H4zM9 11l2 2 4-4',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M1 12h2m18 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7L20 8M20 3v5h-5',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className, label }: { name: IconName | string; size?: number; className?: string; label?: string }) {
  return (
    <svg
      className={`icon ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 3 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <path d={PATHS[name] ?? PATHS.spark} />
    </svg>
  );
}

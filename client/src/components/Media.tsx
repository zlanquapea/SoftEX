import { useState } from 'react';
import { useApi } from '../hooks';
import { Icon } from './Icon';

/** Uploaded video or audio, played in place. `#t=0.1` makes browsers (notably Safari) show the first frame as a preview. */
export function MediaAttachment({ file }: { file: { id: string; name: string; mime?: string | null } }) {
  const src = `/api/files/${file.id}/download?inline=1`;
  if (file.mime?.startsWith('audio/')) {
    return (
      <figure className="audio-attachment">
        <audio controls preload="metadata" src={src} aria-label={file.name} />
        <figcaption className="muted small">{file.name}</figcaption>
      </figure>
    );
  }
  return (
    <figure className="video-attachment">
      <video controls playsInline preload="metadata" src={`${src}#t=0.1`} aria-label={file.name} />
      <figcaption className="muted small">{file.name}</figcaption>
    </figure>
  );
}

export const isPlayable = (mime?: string | null) => !!mime && (mime.startsWith('video/') || mime.startsWith('audio/'));

type Provider = 'youtube' | 'vimeo' | 'loom' | 'tiktok' | 'facebook';
type VideoLink = { url: string; provider: Provider; youtubeId?: string } | { url: string; provider: 'file' };

const PROVIDER_NAME: Record<Provider, string> = { youtube: 'YouTube', vimeo: 'Vimeo', loom: 'Loom', tiktok: 'TikTok', facebook: 'Facebook' };

function classify(raw: string): VideoLink | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  const path = u.pathname;
  if (host === 'youtu.be' || host === 'youtube.com' || host === 'music.youtube.com') {
    const id = host === 'youtu.be' ? path.slice(1).split('/')[0] : path === '/watch' ? u.searchParams.get('v') : /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(path)?.[1];
    return id && /^[\w-]{11}$/.test(id) ? { url: raw, provider: 'youtube', youtubeId: id } : null;
  }
  if ((host === 'vimeo.com' || host === 'player.vimeo.com') && /^\/(?:video\/)?\d{5,12}(?:\/|$)/.test(path)) return { url: raw, provider: 'vimeo' };
  if (host === 'loom.com' && /^\/(?:share|embed)\/[0-9a-f]{32}/.test(path)) return { url: raw, provider: 'loom' };
  if (host === 'tiktok.com' && /^\/@[\w.-]+\/video\/\d{8,25}/.test(path)) return { url: raw, provider: 'tiktok' };
  if ((host === 'facebook.com' && /\/(videos|watch|reel)\b/.test(path)) || host === 'fb.watch') return { url: raw, provider: 'facebook' };
  if (u.protocol === 'https:' && /\.(mp4|m4v|webm|mov|ogv)$/i.test(path)) return { url: raw, provider: 'file' };
  return null;
}

/** Video links in a message's text (at most three previews per message). */
export function videoLinks(text: string): VideoLink[] {
  const found = new Map<string, VideoLink>();
  for (const m of text.matchAll(/https?:\/\/[^\s<>()[\]"'`]+/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    const link = classify(url);
    if (link && !found.has(url)) found.set(url, link);
    if (found.size >= 3) break;
  }
  return [...found.values()];
}

interface EmbedInfo {
  provider: Provider;
  url: string;
  embedUrl: string;
  title: string | null;
  thumbnail: string | null;
}

/** A thumbnail card for a video link that turns into the provider's player when pressed. */
function VideoLinkCard({ link }: { link: Extract<VideoLink, { provider: Provider }> }) {
  const { data } = useApi<EmbedInfo>(`/embeds/video?url=${encodeURIComponent(link.url)}`);
  const [playing, setPlaying] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumbnail = data?.thumbnail ?? (link.youtubeId ? `https://i.ytimg.com/vi/${link.youtubeId}/hqdefault.jpg` : null);
  const vertical = link.provider === 'tiktok';
  const title = data?.title ?? `${PROVIDER_NAME[link.provider]} video`;
  if (playing && data?.embedUrl) {
    return (
      <div className={`video-embed ${vertical ? 'vertical' : ''}`}>
        <iframe
          src={data.embedUrl}
          title={title}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
        />
      </div>
    );
  }
  return (
    <div className="video-card">
      <button type="button" className={`video-thumb ${vertical ? 'vertical' : ''}`} onClick={() => setPlaying(true)} disabled={!data?.embedUrl} aria-label={`Play ${title}`}>
        {thumbnail && !thumbFailed ? (
          <img src={thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setThumbFailed(true)} />
        ) : (
          <span className={`video-thumb-blank ${link.provider}`} />
        )}
        <span className="play-badge" aria-hidden="true">
          <Icon name="play" size={22} />
        </span>
      </button>
      <a className="video-meta" href={link.url} target="_blank" rel="noopener noreferrer">
        <strong>{title}</strong>
        <small className="muted">{PROVIDER_NAME[link.provider]}</small>
      </a>
    </div>
  );
}

/** Previews for every video link in a message. */
export function VideoLinks({ text }: { text: string }) {
  const links = videoLinks(text);
  if (!links.length) return null;
  return (
    <div className="video-links">
      {links.map((link) =>
        link.provider === 'file' ? (
          <figure key={link.url} className="video-attachment">
            <video controls playsInline preload="metadata" src={`${link.url}#t=0.1`} />
          </figure>
        ) : (
          <VideoLinkCard key={link.url} link={link} />
        ),
      )}
    </div>
  );
}

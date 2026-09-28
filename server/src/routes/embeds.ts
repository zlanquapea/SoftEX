import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { badRequest, parse } from '../util.js';

/**
 * Video link previews for messages: YouTube, Vimeo, Loom, TikTok and Facebook links get a
 * title and thumbnail. Only each provider's fixed oEmbed address is ever contacted (the
 * link is passed to it as a parameter), so this can't be used to reach arbitrary or
 * internal addresses. Thumbnails are only returned from the providers' own image hosts,
 * which the web app's Content Security Policy allows.
 */

export interface VideoEmbed {
  provider: 'youtube' | 'vimeo' | 'loom' | 'tiktok' | 'facebook';
  id: string;
  url: string;
  embedUrl: string;
  title: string | null;
  thumbnail: string | null;
}

type Match = Omit<VideoEmbed, 'title' | 'thumbnail'> & { oembed?: string; thumbnail?: string };

export function matchVideoUrl(raw: string): Match | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  const path = u.pathname;

  let m: RegExpExecArray | null;
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com' || host === 'music.youtube.com') {
    let id: string | null = null;
    if (host === 'youtu.be') id = path.slice(1).split('/')[0];
    else if (path === '/watch') id = u.searchParams.get('v');
    else if ((m = /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(path))) id = m[1];
    if (!id || !/^[\w-]{11}$/.test(id)) return null;
    const canonical = `https://www.youtube.com/watch?v=${id}`;
    return {
      provider: 'youtube',
      id,
      url: canonical,
      embedUrl: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`,
      oembed: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(canonical)}`,
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
  }
  if ((host === 'vimeo.com' || host === 'player.vimeo.com') && (m = /^\/(?:video\/)?(\d{5,12})(?:\/|$)/.exec(path))) {
    const canonical = `https://vimeo.com/${m[1]}`;
    return {
      provider: 'vimeo',
      id: m[1],
      url: canonical,
      embedUrl: `https://player.vimeo.com/video/${m[1]}?autoplay=1`,
      oembed: `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(canonical)}`,
    };
  }
  if (host === 'loom.com' && (m = /^\/(?:share|embed)\/([0-9a-f]{32})/.exec(path))) {
    const canonical = `https://www.loom.com/share/${m[1]}`;
    return {
      provider: 'loom',
      id: m[1],
      url: canonical,
      embedUrl: `https://www.loom.com/embed/${m[1]}?autoplay=1`,
      oembed: `https://www.loom.com/v1/oembed?url=${encodeURIComponent(canonical)}`,
    };
  }
  if (host === 'tiktok.com' && (m = /^\/@([\w.-]+)\/video\/(\d{8,25})/.exec(path))) {
    const canonical = `https://www.tiktok.com/@${m[1]}/video/${m[2]}`;
    return {
      provider: 'tiktok',
      id: m[2],
      url: canonical,
      embedUrl: `https://www.tiktok.com/embed/v2/${m[2]}`,
      oembed: `https://www.tiktok.com/oembed?url=${encodeURIComponent(canonical)}`,
    };
  }
  if ((host === 'facebook.com' && /\/(videos|watch|reel)\b/.test(path)) || host === 'fb.watch') {
    const canonical = u.toString();
    return {
      provider: 'facebook',
      id: canonical,
      url: canonical,
      embedUrl: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(canonical)}&show_text=false&autoplay=1`,
    };
  }
  return null;
}

const THUMB_HOSTS = [/(^|\.)ytimg\.com$/, /(^|\.)vimeocdn\.com$/, /(^|\.)loom\.com$/, /(^|\.)loomcdn\.com$/, /(^|\.)tiktokcdn\.com$/, /(^|\.)tiktokcdn-us\.com$/];
const safeThumb = (value: unknown) => {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && THUMB_HOSTS.some((re) => re.test(u.hostname)) ? u.toString() : null;
  } catch {
    return null;
  }
};

const cache = new Map<string, { at: number; value: VideoEmbed }>();
const DAY = 86_400_000;

export async function describeVideo(raw: string): Promise<VideoEmbed | null> {
  const match = matchVideoUrl(raw);
  if (!match) return null;
  const { oembed, thumbnail, ...base } = match;
  const key = `${base.provider}:${base.id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < DAY) return hit.value;
  let title: string | null = null;
  let thumb: string | null = thumbnail ?? null;
  if (oembed) {
    try {
      const res = await fetch(oembed, { signal: AbortSignal.timeout(5000), redirect: 'error', headers: { Accept: 'application/json' } });
      if (res.ok) {
        const data = (await res.json()) as { title?: unknown; thumbnail_url?: unknown };
        if (typeof data.title === 'string') title = data.title.slice(0, 200);
        thumb = safeThumb(data.thumbnail_url) ?? thumb;
      }
    } catch {
      /* the preview still works without a title */
    }
  }
  const value: VideoEmbed = { ...base, title, thumbnail: thumb };
  if (cache.size > 1000) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function embedsRouter(_ctx: Ctx) {
  const r = Router();
  r.get('/embeds/video', async (req, res) => {
    const { url } = parse(z.object({ url: z.string().url().max(2000) }), req.query);
    const embed = await describeVideo(url);
    if (!embed) throw badRequest('Not a supported video link');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.json(embed);
  });
  return r;
}

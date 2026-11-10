import { useEffect, useState } from 'react';

/** point: the album's accent, ground: a near-black tint of it, soft: a pale tint for text. */
export type Palette = { point: string; ground: string; soft: string };

export const NEUTRAL: Palette = { point: '#F4F2EC', ground: '#0B0B0E', soft: '#F4F2EC' };

const STORAGE_PREFIX = 'palette:';
const pending = new Map<string, Promise<Palette>>();
const resolved = new Map<string, Palette>();

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return '#' + f(0) + f(8) + f(4);
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h < 0 ? h + 1 : h, s, l];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Finds the most prominent vivid hue in the cover and normalises it to sit on a dark ground. */
function paletteFromPixels(data: Uint8ClampedArray): Palette {
  const BUCKETS = 18;
  const acc = Array.from({ length: BUCKETS }, () => ({ w: 0, x: 0, y: 0, s: 0, l: 0 }));
  for (let i = 0; i < data.length; i += 4) {
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (s < 0.18 || l < 0.1 || l > 0.92) continue;
    const w = s * Math.max(0, 1 - Math.abs(l - 0.5) * 1.6);
    const b = acc[Math.floor(h * BUCKETS) % BUCKETS];
    b.w += w;
    b.x += Math.cos(h * 2 * Math.PI) * w;
    b.y += Math.sin(h * 2 * Math.PI) * w;
    b.s += s * w;
    b.l += l * w;
  }
  const best = acc.reduce((a, b) => (b.w > a.w ? b : a));
  if (best.w < (data.length / 4) * 0.012) {
    // Effectively monochrome artwork.
    return { point: '#E6E4DE', ground: '#101012', soft: '#F4F2EC' };
  }
  let h = Math.atan2(best.y, best.x) / (2 * Math.PI);
  if (h < 0) h += 1;
  const s = clamp(best.s / best.w, 0.55, 0.95);
  const l = clamp(best.l / best.w, 0.56, 0.68);
  return {
    point: hslToHex(h, s, l),
    ground: hslToHex(h, Math.min(s, 0.6), 0.085),
    soft: hslToHex(h, 0.7, 0.9),
  };
}

function extract(url: string): Promise<Palette> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const size = 32;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0, size, size);
        resolve(paletteFromPixels(ctx.getImageData(0, 0, size, size).data));
      } catch {
        resolve(NEUTRAL);
      }
    };
    img.onerror = () => resolve(NEUTRAL);
    img.src = url;
  });
}

export function getPalette(url: string): Promise<Palette> {
  let p = pending.get(url);
  if (!p) {
    let stored: Palette | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + url);
      if (raw) stored = JSON.parse(raw) as Palette;
    } catch { /* storage unavailable */ }
    p = stored ? Promise.resolve(stored) : extract(url);
    pending.set(url, p);
    void p.then((pal) => {
      resolved.set(url, pal);
      if (!stored && pal !== NEUTRAL) {
        try { localStorage.setItem(STORAGE_PREFIX + url, JSON.stringify(pal)); } catch { /* ignore */ }
      }
    });
  }
  return p;
}

/** Palette for one cover. Keeps the previous palette until the new one is ready, so colours cross-fade. */
export function usePalette(url: string | null | undefined): Palette {
  const [palette, setPalette] = useState<Palette>(() => (url && resolved.get(url)) || NEUTRAL);
  useEffect(() => {
    if (!url) { setPalette(NEUTRAL); return; }
    let live = true;
    void getPalette(url).then((p) => { if (live) setPalette(p); });
    return () => { live = false; };
  }, [url]);
  return palette;
}

/** Point colours for many covers at once, keyed by url. */
export function usePoints(urls: string[]): Record<string, string> {
  const key = urls.join('|');
  const [points, setPoints] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    void Promise.all(urls.map(async (u) => [u, (await getPalette(u)).point] as const)).then((entries) => {
      if (live) setPoints(Object.fromEntries(entries));
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return points;
}

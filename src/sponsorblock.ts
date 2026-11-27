// SponsorBlock: community-submitted segments of YouTube videos (sponsors, self-promotion, ...),
// from the public SponsorBlock API, skipped or shown by StreamHub's player.

export type SbAction = "skip" | "show" | "off";

export const CATEGORIES: { id: string; name: string; color: string }[] = [
  { id: "sponsor", name: "Sponsor", color: "#00d400" },
  { id: "selfpromo", name: "Self-promotion", color: "#ffff00" },
  { id: "interaction", name: "Like/subscribe reminder", color: "#cc00ff" },
  { id: "intro", name: "Intro", color: "#00ffff" },
  { id: "outro", name: "Outro / end cards", color: "#0202ed" },
  { id: "preview", name: "Preview / recap", color: "#008fd6" },
  { id: "filler", name: "Filler / tangent", color: "#7300ff" },
  { id: "music_offtopic", name: "Non-music part of a music video", color: "#ff9900" },
];

export const DEFAULT_ACTIONS: Record<string, SbAction> = {
  sponsor: "skip",
  selfpromo: "skip",
  interaction: "skip",
  intro: "show",
  outro: "show",
  preview: "off",
  filler: "off",
  music_offtopic: "off",
};

export interface Segment {
  start: number;
  end: number;
  category: string;
  uuid: string;
}

const CACHE_PREFIX = "streamhub.sb.";
const CACHE_HOURS = 6;

type ApiSegment = { segment: [number, number]; category: string; UUID: string; actionType?: string };

function tidy(data: ApiSegment[], wanted: string[]): Segment[] {
  return data
    .filter((s) => wanted.includes(s.category) && (s.actionType ?? "skip") === "skip" && s.segment[1] > s.segment[0])
    .map((s) => ({ start: s.segment[0], end: s.segment[1], category: s.category, uuid: s.UUID }))
    .sort((a, b) => a.start - b.start);
}

async function fetchJson(url: string, ms: number): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  try {
    return await fetch(url, { signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The video's segments for the categories that aren't off (none if the video has none).
 * Fast path: SponsorBlock's hash-prefix lookup (the one its own extension uses, well cached), with
 * a short time limit, then the plain lookup; answers are remembered for a few hours.
 */
export async function segments(videoId: string, actions: Record<string, SbAction>): Promise<Segment[]> {
  const wanted = CATEGORIES.map((c) => c.id).filter((id) => (actions[id] ?? "off") !== "off");
  if (!wanted.length) return [];
  const cacheKey = CACHE_PREFIX + videoId;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) ?? "null") as { at: number; data: ApiSegment[] } | null;
    if (cached && Date.now() - cached.at < CACHE_HOURS * 3600_000) return tidy(cached.data, wanted);
  } catch {
    // no cache
  }
  const all = JSON.stringify(CATEGORIES.map((c) => c.id));
  let data: ApiSegment[] | null = null;
  try {
    const prefix = (await sha256Hex(videoId)).slice(0, 4);
    const res = await fetchJson(`https://sponsor.ajay.app/api/skipSegments/${prefix}?categories=${encodeURIComponent(all)}`, 4000);
    if (res.status === 404) data = [];
    else if (res.ok) {
      const videos = (await res.json()) as { videoID: string; segments: ApiSegment[] }[];
      data = videos.find((v) => v.videoID === videoId)?.segments ?? [];
    }
  } catch {
    // slow or down: the plain lookup below
  }
  if (data === null) {
    const res = await fetchJson(`https://sponsor.ajay.app/api/skipSegments?videoID=${encodeURIComponent(videoId)}&categories=${encodeURIComponent(all)}`, 8000);
    if (res.status === 404) data = [];
    else if (!res.ok) throw new Error(`SponsorBlock returned ${res.status}`);
    else data = (await res.json()) as ApiSegment[];
  }
  try {
    localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // storage full: fine
  }
  return tidy(data, wanted);
}

export function categoryName(id: string): string {
  return CATEGORIES.find((c) => c.id === id)?.name ?? id;
}

export function categoryColor(id: string): string {
  return CATEGORIES.find((c) => c.id === id)?.color ?? "#999";
}

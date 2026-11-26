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

/** The video's segments for the categories that aren't off (none if the video has none). */
export async function segments(videoId: string, actions: Record<string, SbAction>): Promise<Segment[]> {
  const wanted = CATEGORIES.map((c) => c.id).filter((id) => (actions[id] ?? "off") !== "off");
  if (!wanted.length) return [];
  const url = new URL("https://sponsor.ajay.app/api/skipSegments");
  url.searchParams.set("videoID", videoId);
  url.searchParams.set("categories", JSON.stringify(wanted));
  const res = await fetch(url);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`SponsorBlock returned ${res.status}`);
  const data = (await res.json()) as { segment: [number, number]; category: string; UUID: string; actionType?: string }[];
  return data
    .filter((s) => (s.actionType ?? "skip") === "skip" && s.segment[1] > s.segment[0])
    .map((s) => ({ start: s.segment[0], end: s.segment[1], category: s.category, uuid: s.UUID }))
    .sort((a, b) => a.start - b.start);
}

export function categoryName(id: string): string {
  return CATEGORIES.find((c) => c.id === id)?.name ?? id;
}

export function categoryColor(id: string): string {
  return CATEGORIES.find((c) => c.id === id)?.color ?? "#999";
}

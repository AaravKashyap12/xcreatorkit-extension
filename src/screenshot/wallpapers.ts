/**
 * Every background the editor offers. The lists are plain data: the Background panel, the renderer and the
 * verifier all read them from here.
 *
 * To add a wallpaper, put a WebP of at least 1600 × 900 native pixels in static/backgrounds/ and add one line to
 * ARTWORK. `tone` is the colour painted while the file loads and behind any transparent edge; pick the
 * artwork's dominant colour. Artwork shows in the order listed, and the first entry is the default.
 */
export type Artwork = { id: string; name: string; file: string; tone: string };
export type Gradient = { id: string; name: string; angle: number; stops: readonly string[] };

declare const PERSONAL_ARTWORK: readonly Artwork[] | undefined;
export const ARTWORK: readonly Artwork[] = typeof PERSONAL_ARTWORK === 'undefined' ? [
  { id: 'indigo-moon', name: 'Indigo Moon', file: 'backgrounds/indigo-moon.webp', tone: '#3f405a' },
  { id: 'coral-evening', name: 'Coral Evening', file: 'backgrounds/coral-evening.webp', tone: '#c69388' },
  { id: 'daylight-blue', name: 'Daylight Blue', file: 'backgrounds/daylight-blue.webp', tone: '#aec9ea' },
  { id: 'peach-haze', name: 'Peach Haze', file: 'backgrounds/peach-haze.webp', tone: '#d1bd9e' },
  { id: 'silver-lining', name: 'Silver Lining', file: 'backgrounds/silver-lining.webp', tone: '#a7afa8' },
  { id: 'rose-hour', name: 'Rose Hour', file: 'backgrounds/rose-hour.webp', tone: '#ae7682' },
  { id: 'rain-wash', name: 'Rain Wash', file: 'backgrounds/rain-wash.webp', tone: '#a2acb0' },
] : PERSONAL_ARTWORK;

/** Quiet grounds for when artwork would compete with the screenshot. */
export const GRADIENTS: readonly Gradient[] = [
  { id: 'mist', name: 'Mist', angle: 160, stops: ['#f3f5f7', '#d8dfe7'] },
  { id: 'sage', name: 'Sage', angle: 155, stops: ['#eef2e9', '#c9d6c1'] },
  { id: 'dune', name: 'Dune', angle: 150, stops: ['#f6efe6', '#e0ccb4'] },
  { id: 'dusk', name: 'Dusk', angle: 165, stops: ['#e6e3ee', '#b9bdd6'] },
  { id: 'clay', name: 'Clay', angle: 145, stops: ['#f2e1d8', '#d6a892'] },
  { id: 'graphite', name: 'Graphite', angle: 160, stops: ['#45474c', '#141517'] },
];

export const SOLIDS: readonly { name: string; color: string }[] = [
  { name: 'Paper', color: '#f4f4f1' },
  { name: 'White', color: '#ffffff' },
  { name: 'Stone', color: '#dcdcd5' },
  { name: 'Pale sage', color: '#dde4d9' },
  { name: 'Sand', color: '#ecdfcc' },
  { name: 'Ink', color: '#131313' },
];

/** Colours offered for marks. Blue ink stays reserved for figures read from X. */
export const MARK_COLORS: readonly { name: string; color: string }[] = [
  { name: 'Signal red', color: '#de4932' },
  { name: 'Ink', color: '#131313' },
  { name: 'White', color: '#ffffff' },
  { name: 'Amber', color: '#f0a524' },
  { name: 'Green', color: '#1f8a4c' },
];

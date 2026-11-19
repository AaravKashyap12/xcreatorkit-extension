// Receipt data model, the metric catalogue, scenes and their colourways. Shared by the extension
// page and the website. Pure data: no DOM.

export const BRAND = 'X Creator Kit';
export const DOMAIN = 'xcreatorkit.com';

export type MetricKey = 'followers' | 'posts' | 'replies' | 'impressionsDelta' | 'impressions' | 'likes' | 'profileVisits' | 'engagementRate' | 'bestDay' | 'daysPosted' | 'streak';

export const METRICS: { key: MetricKey; label: string; short: string }[] = [
  { key: 'followers', label: 'NEW FOLLOWERS', short: 'New followers' },
  { key: 'posts', label: 'POSTS', short: 'Posts' },
  { key: 'replies', label: 'REPLIES', short: 'Replies' },
  { key: 'impressionsDelta', label: 'IMPRESSIONS VS YDAY', short: 'Impressions vs yesterday' },
  { key: 'impressions', label: 'IMPRESSIONS TODAY', short: 'Impressions today' },
  { key: 'likes', label: 'LIKES', short: 'Likes' },
  { key: 'profileVisits', label: 'PROFILE VISITS', short: 'Profile visits' },
  { key: 'engagementRate', label: 'ENGAGEMENT RATE', short: 'Engagement rate' },
  { key: 'bestDay', label: 'BEST DAY · IMPRESSIONS', short: 'Best day' },
  { key: 'daysPosted', label: 'DAYS POSTED', short: 'Days posted' },
  { key: 'streak', label: 'LONGEST POST STREAK', short: 'Posting streak' },
];
export const RECAP_METRICS = METRICS.filter((m) => m.key !== 'impressionsDelta');
export const DEFAULT_METRICS: MetricKey[] = ['followers', 'posts', 'replies', 'impressionsDelta'];
export const MAX_ROWS = 4;

export interface ReceiptData {
  handle: string;
  no: string; // order code; daily receipts use a zero-padded Day number
  day: number;
  /** Explicit UTC window and completeness for Week/Month; absent on daily receipts. */
  period?: { kind: 'week' | 'month'; title: string; dates: string; dayRange: string | null; coverage: string };
  date: string; // "25 OCT 2026"
  stampDate: string; // "25.10.26"
  time: string; // "14:02 UTC"
  /** Rows in display order; value already formatted ("+24", "6", "+29,100"). */
  rows: { key: MetricKey; label: string; value: string }[];
  /** Rewards window total, when a reading exists. */
  total: { value: number; text: string; target: string; pct: number; eta: string | null } | null;
  /** Fallback headline number when there is no rewards reading. */
  followersTotal: string | null;
  /** True only when the numbers were read from X's own pages by the extension. */
  captured: boolean;
  /** Show the NEW RECORD sticker (scenes that have one); only set when it is actually true. */
  record: boolean;
}

export const SAMPLE: ReceiptData = {
  handle: 'byaarav', no: '0043', day: 43, date: '25 OCT 2026', stampDate: '25.10.26', time: '14:02 UTC',
  rows: [
    { key: 'followers', label: 'NEW FOLLOWERS', value: '+24' },
    { key: 'posts', label: 'POSTS', value: '6' },
    { key: 'replies', label: 'REPLIES', value: '87' },
    { key: 'impressionsDelta', label: 'IMPRESSIONS VS YDAY', value: '+29,100' },
  ],
  total: { value: 450_800, text: '450,800', target: '500K', pct: 90, eta: '~3 DAYS' },
  followersTotal: '1,096',
  captured: false,
  record: true,
};

/** Sample values for every metric, so any combination can be previewed before the first capture. */
const SAMPLE_VALUES: Record<MetricKey, string> = {
  followers: '+24', posts: '6', replies: '87', impressionsDelta: '+29,100',
  impressions: '38,420', likes: '1,212', profileVisits: '310', engagementRate: '4.2%',
  bestDay: '23 OCT', daysPosted: '5', streak: '3 DAYS',
};

/** The sample receipt with exactly the chosen lines, in the chosen order. */
export function sampleFor(metrics: MetricKey[]): ReceiptData {
  return { ...SAMPLE, rows: metrics.map((key) => ({ key, label: METRICS.find((m) => m.key === key)!.label, value: SAMPLE_VALUES[key] })) };
}

/** Colour roles a colourway may change. Layout, fonts, sizes and textures never change. */
export interface Colourway {
  name: string;
  field: string; // background
  paper?: string;
  ink?: string;
  accent: string; // hero / progress / headline colour on the paper
  stamp: string;
  ref: string; // referral line colour
  refBg?: string; // referral pill background, when the scene uses a pill
  extra?: string; // scene-specific second colour (gingham check, carbon sheet, poster pattern tint, diner rule)
}

export interface Scene {
  id: number;
  key: 'receiptify' | 'printer' | 'diner' | 'clipped' | 'carbon' | 'poster';
  name: string;
  colourways: Colourway[];
}

export const SCENES: Scene[] = [
  {
    id: 1, key: 'receiptify', name: 'Receiptify',
    colourways: [
      { name: 'Cobalt', field: '#2b3ed8', accent: '#161616', stamp: '#c81d14', ref: '#ffffff' },
      { name: 'Midnight', field: '#151515', accent: '#161616', stamp: '#c81d14', ref: '#f3f2ee' },
      { name: 'Bubblegum', field: '#ff5aa5', accent: '#161616', stamp: '#2140c9', ref: '#ffffff' },
      { name: 'Forest', field: '#1f5a3d', accent: '#161616', stamp: '#d9531e', ref: '#ffffff' },
      { name: 'Sunflower', field: '#f2c230', accent: '#161616', stamp: '#2140c9', ref: '#161616' },
      { name: 'Lilac', field: '#b6a4ff', accent: '#161616', stamp: '#c81d14', ref: '#161616' },
    ],
  },
  {
    id: 2, key: 'printer', name: 'Printer',
    colourways: [
      { name: 'Cherry', field: '#df3e2c', accent: '#c92f22', stamp: '#2140c9', ref: '#ffffff' },
      { name: 'Royal', field: '#2443c4', accent: '#1f3bb3', stamp: '#c92f22', ref: '#ffffff' },
      { name: 'Mint', field: '#3db58a', accent: '#138a5c', stamp: '#2140c9', ref: '#0f2a20' },
      { name: 'Graphite', field: '#262626', accent: '#161616', stamp: '#c92f22', ref: '#f7f4ec' },
      { name: 'Tangerine', field: '#ff7a1a', accent: '#d4560a', stamp: '#2140c9', ref: '#ffffff' },
      { name: 'Flamingo', field: '#ea6aa2', accent: '#c2266f', stamp: '#2140c9', ref: '#ffffff' },
    ],
  },
  {
    id: 3, key: 'diner', name: 'Diner check',
    colourways: [
      { name: 'Booth green', field: '#1f4a3a', paper: '#e9f1e2', ink: '#1f2a24', accent: '#c7332b', stamp: '#2a47b8', ref: '#ffffff', extra: '#9db5a3' },
      { name: 'Night shift', field: '#1b2a4a', paper: '#f3ead6', ink: '#1f2430', accent: '#c7332b', stamp: '#2a47b8', ref: '#ffffff', extra: '#c9b88f' },
      { name: 'Merlot', field: '#5a1620', paper: '#f6e4e2', ink: '#2a1a1c', accent: '#2a47b8', stamp: '#5a1620', ref: '#ffffff', extra: '#d7b3b0' },
      { name: 'Ledger', field: '#161616', paper: '#f7f6f1', ink: '#161616', accent: '#c7332b', stamp: '#2a47b8', ref: '#ffffff', extra: '#c9c7bd' },
      { name: 'Seaside', field: '#1d5c63', paper: '#f1ebd8', ink: '#1f2a2b', accent: '#d9531e', stamp: '#1d5c63', ref: '#ffffff', extra: '#c6bd9f' },
      { name: 'Mustard', field: '#e3b52a', paper: '#fbfaf6', ink: '#1f1f1f', accent: '#2a47b8', stamp: '#c7332b', ref: '#1f1f1f', extra: '#cfcab8' },
    ],
  },
  {
    id: 4, key: 'clipped', name: 'Clipped',
    colourways: [
      { name: 'Picnic blue', field: '#f4f6ff', accent: '#1f3bb3', stamp: '#1f3bb3', ref: '#ffffff', refBg: '#1f3bb3', extra: 'rgba(47, 75, 216, .55)' },
      { name: 'Trattoria', field: '#fff6f4', accent: '#c4271c', stamp: '#c4271c', ref: '#ffffff', refBg: '#c4271c', extra: 'rgba(217, 58, 43, .55)' },
      { name: 'Garden', field: '#f3fbf5', accent: '#1f7a49', stamp: '#1f7a49', ref: '#ffffff', refBg: '#1f7a49', extra: 'rgba(47, 143, 91, .5)' },
      { name: 'Strawberry', field: '#fff4f8', accent: '#c2266f', stamp: '#c2266f', ref: '#ffffff', refBg: '#c2266f', extra: 'rgba(228, 106, 160, .55)' },
      { name: 'Diner', field: '#f6f6f6', accent: '#191714', stamp: '#191714', ref: '#ffffff', refBg: '#191714', extra: 'rgba(34, 34, 34, .5)' },
      { name: 'Citrus', field: '#fff8ef', accent: '#c75a06', stamp: '#c75a06', ref: '#ffffff', refBg: '#c75a06', extra: 'rgba(240, 122, 26, .5)' },
    ],
  },
  {
    id: 5, key: 'carbon', name: 'Carbon copy',
    colourways: [
      { name: 'Kraft', field: '#b78a5c', ink: '#23347f', accent: '#23347f', stamp: '#c22a1f', ref: '#ffffff', refBg: '#23347f', extra: '#f2b8c6' },
      { name: 'Slate', field: '#3d4450', ink: '#23347f', accent: '#23347f', stamp: '#c22a1f', ref: '#ffffff', refBg: '#23347f', extra: '#f4d35e' },
      { name: 'Olive', field: '#77744a', ink: '#23347f', accent: '#23347f', stamp: '#c22a1f', ref: '#ffffff', refBg: '#23347f', extra: '#b9e3c6' },
      { name: 'Linen', field: '#e4dccb', ink: '#23347f', accent: '#23347f', stamp: '#c22a1f', ref: '#ffffff', refBg: '#23347f', extra: '#f2b8c6' },
      { name: 'Navy desk', field: '#22305a', ink: '#1a1a1a', accent: '#1a1a1a', stamp: '#c22a1f', ref: '#22305a', refBg: '#f2b8c6', extra: '#f2b8c6' },
      { name: 'Terracotta', field: '#b5543a', ink: '#23347f', accent: '#23347f', stamp: '#23347f', ref: '#ffffff', refBg: '#23347f', extra: '#cfe2f3' },
    ],
  },
  {
    id: 6, key: 'poster', name: 'Poster',
    colourways: [
      { name: 'Signal', field: '#f0ebe2', accent: '#ff4f1a', stamp: '#ff4f1a', ref: '#ffffff', refBg: '#161616', extra: '#ffb08f' },
      { name: 'Cobalt', field: '#eef0fb', accent: '#2b3ed8', stamp: '#2b3ed8', ref: '#ffffff', refBg: '#161616', extra: '#a9b4f2' },
      { name: 'Ink', field: '#161616', accent: '#e8322c', stamp: '#e8322c', ref: '#161616', refBg: '#f0ebe2', extra: '#4a4a4a' },
      { name: 'Tomato', field: '#fbeae6', accent: '#e8322c', stamp: '#e8322c', ref: '#ffffff', refBg: '#161616', extra: '#f4a59f' },
      { name: 'Pine', field: '#eaf3ec', accent: '#1f8a4c', stamp: '#1f8a4c', ref: '#ffffff', refBg: '#161616', extra: '#a6d8b7' },
      { name: 'Grape', field: '#f1ecfb', accent: '#6b3fd4', stamp: '#6b3fd4', ref: '#ffffff', refBg: '#161616', extra: '#c8b8f2' },
    ],
  },
];

export const sceneById = (id: number) => SCENES.find((s) => s.id === id) ?? SCENES[0]!;

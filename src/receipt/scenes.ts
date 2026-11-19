// Renders a receipt scene to an HTML string (no DOM), so the same markup serves the extension page,
// the website, the PNG export and the test renders.
import { BRAND, DOMAIN, sceneById, type Colourway, type ReceiptData } from './data';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function tornClip(w: number, top: boolean, bottom: boolean, tooth = 22, depth = 10): string {
  const p: string[] = [];
  if (top) {
    p.push(`0 ${depth}px`);
    for (let x = 0; x < w; x += tooth) p.push(`${x + tooth / 2}px 0`, `${Math.min(x + tooth, w)}px ${depth}px`);
  } else p.push('0 0', `${w}px 0`);
  if (bottom) {
    p.push(`${w}px calc(100% - ${depth}px)`);
    for (let x = w; x > 0; x -= tooth) p.push(`${x - tooth / 2}px 100%`, `${Math.max(x - tooth, 0)}px calc(100% - ${depth}px)`);
  } else p.push(`${w}px 100%`, '0 100%');
  return `clip-path:polygon(${p.join(',')})`;
}

/** Deterministic decorative barcode from the receipt code. */
export function barcode(seed: string, bars = 46, unit = 3): string {
  let h = 2166136261;
  let html = '';
  for (let i = 0; i < bars; i++) {
    h ^= seed.charCodeAt(i % seed.length) + i;
    h = Math.imul(h, 16777619) >>> 0;
    html += `<i class="${i % 2 ? 'gap' : ''}" style="width:${(1 + (h % 3)) * unit}px"></i>`;
  }
  return `<div class="barcode" aria-hidden="true">${html}</div>`;
}

const blocks = (pct: number) => {
  const on = Math.min(25, Math.floor((pct / 100) * 25));
  return `<div class="blocks">${Array.from({ length: 25 }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</div>`;
};

const stamp = (d: ReceiptData, round = false) =>
  `<div class="slot${d.captured ? '' : ' empty'}"><div class="stamp${round ? ' round' : ''}"><b>CAPTURED</b><b>FROM X</b><span>${esc(d.stampDate)} · ${esc(d.time)}</span></div></div>`;

const code = (d: ReceiptData) => `*${d.no}*${d.handle.toUpperCase()}*`;

function itemsTable(d: ReceiptData): string {
  const rows = d.rows.map((r, i) => `<tr data-row="${i}"><td>${String(i + 1).padStart(2, '0')}</td><td>${esc(r.label)}</td><td class="num" data-value="${esc(r.value)}">${esc(r.value)}</td></tr>`).join('');
  return `<table class="items"><thead><tr><th></th><th>ITEM</th><th>${d.period ? 'PERIOD' : 'TODAY'}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const periodNote = (d: ReceiptData) => d.period
  ? `<div class="period-detail">${esc(d.period.dates)}${d.period.dayRange ? ` · ${esc(d.period.dayRange)}` : ''}<br>${esc(d.period.coverage)}</div>` : '';

function totals(d: ReceiptData): string {
  if (d.total) {
    const t = d.total;
    return `<div class="total"><span class="lbl">TOTAL<small>VERIFIED · 90D</small></span><span class="val"><span class="num" data-value="${esc(t.text)}">${esc(t.text)}</span><small>/ ${esc(t.target)}</small></span></div>
      <div class="bar">${blocks(t.pct)}<b>${t.pct}%</b></div>
      <div class="eta">→ ${esc(t.target)} ${t.eta === 'REACHED' ? 'REACHED ✓' : t.eta ? `IN ${esc(t.eta)}` : 'TARGET'}</div>`;
  }
  return `<div class="total"><span class="lbl">FOLLOWERS<small>TOTAL ON X</small></span><span class="val"><span class="num" data-value="${esc(d.followersTotal ?? '—')}">${esc(d.followersTotal ?? '—')}</span></span></div>`;
}

function thermal(d: ReceiptData, o: { hero?: string; kicker?: string } = {}): string {
  return `<div class="light"></div>
  <div class="k">${esc(o.kicker ?? `${BRAND} · GROWTH RECEIPT`)}</div>
  <div class="hero">${esc(d.period?.title ?? o.hero ?? `DAY ${d.day}`)}</div>
  <div class="meta">ORDER #${esc(d.no)} · @${esc(d.handle.toUpperCase())} · ${esc(d.date)}</div>
  ${periodNote(d)}<hr class="sep">${itemsTable(d)}<hr class="sep">${d.period ? '' : `${totals(d)}<hr class="sep">`}
  <div class="foot"><div class="code">${barcode(d.handle + d.no)}<small>${esc(code(d))}</small></div>${stamp(d)}</div>
  <div class="thanks">THANK YOU FOR SHOWING UP!</div>`;
}

const CLIP_SVG = `<svg class="clip" viewBox="0 0 230 190" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="clipm" x1="0" x2="1"><stop offset="0" stop-color="#8e949b"/><stop offset=".5" stop-color="#f1f3f5"/><stop offset="1" stop-color="#8e949b"/></linearGradient><linearGradient id="clipk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3a3a"/><stop offset="1" stop-color="#101010"/></linearGradient></defs><path d="M70 104 C52 36, 84 8, 115 8 C146 8, 178 36, 160 104" fill="none" stroke="url(#clipm)" stroke-width="10" stroke-linecap="round"/><path d="M82 104 C70 52, 94 28, 115 28 C136 28, 160 52, 148 104" fill="none" stroke="url(#clipm)" stroke-width="7" stroke-linecap="round"/><path d="M22 104 L208 104 L190 182 L40 182 Z" fill="url(#clipk)"/><path d="M22 104 L208 104 L204 116 L26 116 Z" fill="#fff" fill-opacity=".22"/></svg>`;

function sticker(): string {
  const pts = Array.from({ length: 36 }, (_, i) => {
    const a = (Math.PI * i) / 18 - Math.PI / 2;
    const r = i % 2 ? 88 : 108;
    return `${(110 + r * Math.cos(a)).toFixed(1)},${(110 + r * Math.sin(a)).toFixed(1)}`;
  }).join(' ');
  return `<svg class="sticker" viewBox="0 0 220 220" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><polygon points="${pts}" fill="#ffd84a" stroke="#191714" stroke-width="4" stroke-linejoin="round"/><text x="110" y="104" text-anchor="middle" style="font:900 38px Archivo;font-stretch:62%" fill="#191714">NEW</text><text x="110" y="146" text-anchor="middle" style="font:900 40px Archivo;font-stretch:62%" fill="#191714">RECORD!</text></svg>`;
}

function vars(c: Colourway): string {
  const v: Record<string, string | undefined> = { '--field': c.field, '--paper': c.paper, '--ink': c.ink, '--accent': c.accent, '--stamp': c.stamp, '--ref': c.ref, '--ref-bg': c.refBg, '--extra': c.extra };
  return Object.entries(v).filter(([, x]) => x).map(([k, x]) => `${k}:${x}`).join(';');
}

const refLine = (pill: boolean) => `<div class="ref${pill ? ' pill' : ''}">print yours → ${DOMAIN}</div>`;

/** Full artboard HTML for a scene id (1–6) and colourway index (0–5). */
export function renderScene(sceneId: number, colourway: number, d: ReceiptData): string {
  const scene = sceneById(sceneId);
  const c = scene.colourways[colourway] ?? scene.colourways[0]!;
  const open = (cls: string) => `<div class="art s${scene.id} ${d.period ? `recap ${d.period.kind}` : ''} ${cls}" data-scene="${scene.key}" style="${vars(c)}">`;
  switch (scene.key) {
    case 'receiptify':
      return `${open('')}<div class="drop"><div class="paper crumple" style="${tornClip(720, true, true)}">${thermal(d)}</div></div>${refLine(false)}</div>`;
    case 'printer':
      return `${open('')}<div class="printer"><span class="brand">${esc(BRAND)} · TP-80</span></div><div class="drop"><div class="paper crumple" style="${tornClip(780, false, true)}"><div class="slotshade"></div>${thermal(d)}</div></div>${refLine(false)}</div>`;
    case 'diner':
      return `${open('')}<div class="drop"><div class="paper crumple"><div class="perf"></div><div class="light"></div>
        <div class="top"><b>GUEST CHECK</b><span>Nº ${esc(d.no)}</span></div><div class="redrule"></div>
        <div class="hero">${esc(d.period?.title ?? `DAY ${d.day}`)}</div>
        ${periodNote(d)}
        <table class="check"><tr><th>@${esc(d.handle)} · ${esc(d.date)}</th><th>${d.period ? 'PERIOD' : 'TODAY'}</th></tr>
          ${d.rows.map((r, i) => `<tr data-row="${i}"><td>${esc(r.label[0] + r.label.slice(1).toLowerCase())}</td><td class="num" data-value="${esc(r.value)}">${esc(r.value)}</td></tr>`).join('')}
          ${d.period ? '' : d.total
            ? `<tr class="tot"><td>TOTAL<small>verified · 90 days · of ${esc(d.total.target)}</small></td><td><span class="num" data-value="${esc(d.total.text)}">${esc(d.total.text)}</span></td></tr>`
            : `<tr class="tot"><td>FOLLOWERS<small>total on X</small></td><td><span class="num" data-value="${esc(d.followersTotal ?? '—')}">${esc(d.followersTotal ?? '—')}</span></td></tr>`}
        </table>
        ${!d.period && d.total ? `<div class="eta">→ ${esc(d.total.target)} ${d.total.eta === 'REACHED' ? 'reached ✓' : d.total.eta ? `in ${esc(d.total.eta.toLowerCase())} · ${d.total.pct}% there` : `target · ${d.total.pct}% there`}</div>` : ''}
        <div class="foot"><div class="script">Thank you!</div>${stamp(d, true)}</div></div></div>${refLine(false)}</div>`;
    case 'clipped':
      return `${open('')}${CLIP_SVG}${d.record ? sticker() : ''}<div class="drop"><div class="paper crumple" style="${tornClip(740, false, true)}">${thermal(d, { hero: `Day ${d.day}` })}</div></div>${refLine(true)}</div>`;
    case 'carbon':
      return `${open('')}<div class="stack"><div class="under" style="${tornClip(740, false, true)}"></div><div class="drop"><div class="paper crumple" style="${tornClip(740, false, true)}">${thermal(d, { kicker: `${BRAND} · GROWTH RECEIPT · ORIGINAL` })}</div></div></div>${refLine(true)}</div>`;
    case 'poster':
      return `${open('')}<div class="pattern" aria-hidden="true">${Array.from({ length: 13 }, () => `<div>${'SHOWED UP. '.repeat(6)}</div>`).join('')}</div><div class="drop"><div class="paper crumple" style="${tornClip(700, true, true)}">${thermal(d)}</div></div>${refLine(true)}</div>`;
  }
}

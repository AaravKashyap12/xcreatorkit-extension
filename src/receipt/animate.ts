// Receipt loading choreography on a GSAP timeline, with rolling digits from NumberFlow.
// Order: paper arrives (or prints out of the printer) → lines type in → numbers roll up → progress
// blocks fill → barcode scans → stamp slams with a paper thud → sticker pops. Every tween clears its
// inline styles when done, so the end state is exactly the static design (what the PNG export draws).
// With reduced motion nothing moves and the final state shows at once.
import 'number-flow';
import type NumberFlow from 'number-flow';
import { gsap } from 'gsap';
import { CustomEase } from 'gsap/CustomEase';
import { parseFigure } from './figure';

gsap.registerPlugin(CustomEase);
/** The house curve: heavy, settles softly (cubic-bezier(.32,.72,0,1)). */
export const EASE = CustomEase.create('receipt', '.32,.72,0,1');
const NF_EASE = 'cubic-bezier(.2, 0, 0, 1)';
export const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Viewport y of the baseline inside `el`, found with a zero-size inline-block probe. */
function baselineY(el: HTMLElement): number {
  const probe = document.createElement('i');
  probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
  el.append(probe);
  const y = probe.getBoundingClientRect().top;
  probe.remove();
  return y;
}

/** Swap each `.num` text for a NumberFlow element that starts at zero. Returns the elements with their targets. */
function mountFlows(art: HTMLElement): { el: NumberFlow; target: number; row: number }[] {
  const out: { el: NumberFlow; target: number; row: number }[] = [];
  for (const span of art.querySelectorAll<HTMLElement>('.num')) {
    const p = parseFigure(span.dataset.value ?? span.textContent ?? '');
    if (!p) continue;
    const nf = document.createElement('number-flow') as NumberFlow;
    nf.numberPrefix = p.prefix;
    nf.numberSuffix = p.suffix;
    nf.format = { minimumFractionDigits: p.decimals, maximumFractionDigits: p.decimals, useGrouping: p.grouping };
    nf.transformTiming = { duration: 900, easing: 'linear(0, .0033 .8%, .0263 2.4%, .0896 4.8%, .2023 7.8%, .3637 11.4%, .5536 15.6%, .7254 20.2%, .8513 25.2%, .9339 30.8%, .9786 37.2%, .9978 45.2%, 1.0037 56.6%, 1.0011 74.2%, 1)' };
    nf.spinTiming = { duration: 900, easing: NF_EASE };
    nf.update(0);
    // NumberFlow's box is taller than the text (it pads for its roll mask) and its baseline sits lower. Pin the
    // slot to the static text's line, then shift the digits so their baseline lands exactly where the static
    // text's did. Rows and totals keep the static layout, which is what the PNG export draws.
    // The marker may be a table cell, so the pinned slot is always an inner inline span.
    const slot = document.createElement('span');
    slot.textContent = span.textContent;
    span.replaceChildren(slot);
    const k = art.getBoundingClientRect().width / (art.offsetWidth || 1);
    const before = k ? baselineY(slot) : 0;
    const lh = parseFloat(getComputedStyle(slot).lineHeight); // NaN for 'normal'
    const h = Math.min(slot.offsetHeight, Number.isNaN(lh) ? Infinity : lh);
    slot.replaceChildren(nf);
    if (h && k) {
      Object.assign(slot.style, { display: 'inline-block', height: `${h}px`, verticalAlign: 'top' });
      nf.style.position = 'relative';
      nf.style.top = `${(before - baselineY(slot)) / k}px`;
    }
    const tr = span.closest('[data-row]') as HTMLElement | null;
    out.push({ el: nf, target: p.value, row: tr ? Number(tr.dataset.row) : -1 });
  }
  return out;
}

export interface Playback { finished: Promise<void>; cancel(): void }

export interface ReceiptMotion {
  /** 'auto': the scene's own entrance (printer feed or paper drop). 'none': the caller moves the paper. */
  entrance?: 'auto' | 'none';
  /** Type-in effects (lines wipe in, blocks fill, barcode scans). Off when the paper is fed out of a printer:
   *  the print is already on it, so only the numbers roll and the stamp slams. */
  lines?: boolean;
}

/** Builds the receipt's timeline (paused). Mounts the rolling digits immediately, so call it once the art is in the DOM. */
export function receiptTimeline(art: HTMLElement, opts: ReceiptMotion = {}): gsap.core.Timeline {
  const { entrance = 'auto', lines: wipeLines = true } = opts;
  const tl = gsap.timeline({ paused: true, defaults: { ease: EASE, duration: 0.42 } });
  const scene = art.dataset.scene;
  const paper = art.querySelector<HTMLElement>('.paper');
  const drop = art.querySelector<HTMLElement>('.drop');
  const clear = { clearProps: 'all' };

  // 1. Paper arrives.
  if (entrance === 'auto' && paper) {
    if (scene === 'printer') tl.from(paper, { yPercent: -104, duration: 1.1, ease: 'power2.inOut', ...clear }, 0);
    else tl.from(paper, { y: 46, autoAlpha: 0, duration: 0.55, ...clear }, 0);
  }
  const under = art.querySelector('.under');
  if (under && entrance === 'auto') tl.from(under, { autoAlpha: 0, duration: 0.4, ...clear }, 0.2);

  // 2. Lines type in (left-to-right wipe), top to bottom; then the item rows.
  if (wipeLines && paper) {
    const lines = [...paper.children].filter((c) => !c.matches('.light, .perf, .slotshade'));
    if (lines.length) tl.fromTo(lines, { autoAlpha: 0, y: 10, clipPath: 'inset(0% 100% 0% 0%)' }, { autoAlpha: 1, y: 0, clipPath: 'inset(0% 0% 0% 0%)', stagger: 0.07, ...clear }, 0.38);
    const rows = art.querySelectorAll('[data-row]');
    if (rows.length) tl.fromTo(rows, { autoAlpha: 0, clipPath: 'inset(0% 100% 0% 0%)' }, { autoAlpha: 1, clipPath: 'inset(0% 0% 0% 0%)', duration: 0.4, stagger: 0.11, ...clear }, 0.7);
  }

  // 3. Numbers roll: each row's value as its line lands; the total last.
  for (const f of mountFlows(art)) tl.call(() => void f.el.update(f.target), [], f.row >= 0 ? 0.76 + f.row * 0.11 : 1.15);

  // 4. Progress blocks fill one by one; barcode scans.
  const barcode = wipeLines ? art.querySelector('.barcode') : null;
  const blocks = art.querySelectorAll('.blocks i');
  if (wipeLines && blocks.length) tl.from(blocks, { scaleY: 0, transformOrigin: '50% 100%', duration: 0.22, stagger: 0.026, ...clear }, 1.25);
  if (barcode) tl.fromTo(barcode, { clipPath: 'inset(0% 100% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: 0.45, ease: 'none', ...clear }, 1.75);

  // 5. Stamp slams down (overshoot), then the paper takes the hit.
  const stamp = art.querySelector<HTMLElement>('.slot:not(.empty) .stamp');
  if (stamp) {
    tl.addLabel('stamp', 2.15)
      .fromTo(stamp, { autoAlpha: 0, scale: 1.9, rotation: '-=8', filter: 'blur(3px)' }, { autoAlpha: 1, scale: 0.94, rotation: '+=9', filter: 'blur(0px)', duration: 0.31, ease: 'power3.in' }, 'stamp')
      .to(stamp, { scale: 1, rotation: '-=1', duration: 0.19, ease: 'back.out(3)', clearProps: 'all' })
      .to(drop ?? paper, { keyframes: { x: [0, 2, -1, 0], y: [0, 3, -1, 0] }, duration: 0.22, ease: 'power1.out', clearProps: 'x,y' }, 'stamp+=0.31');
  }

  // 6. Sticker pops (only present when the record is real).
  const sticker = art.querySelector('.sticker');
  if (sticker) tl.from(sticker, { autoAlpha: 0, scale: 0, duration: 0.45, ease: 'back.out(2.4)', ...clear }, 2.7);
  return tl;
}

export function playReceipt(art: HTMLElement, opts?: ReceiptMotion): Playback {
  if (reduceMotion()) return { finished: Promise.resolve(), cancel() {} };
  const tl = receiptTimeline(art, opts);
  const finished = new Promise<void>((resolve) => tl.eventCallback('onComplete', () => resolve()));
  tl.play();
  return {
    finished,
    // Jump to the end with callbacks, so every number lands on its value and every style is cleared.
    cancel: () => void tl.progress(1, false).kill(),
  };
}

/** Update rows by their data-row identity; text rows and reduced motion stay in the static renderer's form. */
export function rollTo(art: HTMLElement, rows: readonly string[], total: string): void {
  for (const span of art.querySelectorAll<HTMLElement>('.num')) {
    const row = span.closest<HTMLElement>('[data-row]');
    const value = row ? rows[Number(row.dataset.row)] : total;
    if (value == null) continue;
    span.dataset.value = value;
    const nf = span.querySelector<NumberFlow>('number-flow');
    const parsed = parseFigure(value);
    if (!nf || !parsed || reduceMotion()) {
      span.textContent = value;
      continue;
    }
    nf.numberPrefix = parsed.prefix;
    nf.numberSuffix = parsed.suffix;
    nf.format = { minimumFractionDigits: parsed.decimals, maximumFractionDigits: parsed.decimals, useGrouping: parsed.grouping };
    nf.update(parsed.value);
  }
}

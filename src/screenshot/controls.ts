import { h } from '../ui/dom';
import { clamp } from './model';

export type RangeSpec = {
  id: string; label: string; min: number; max: number; step: number; unit: string;
  get: () => number;
  /** Called on every movement. */
  set: (v: number) => void;
  /** Called when the value settles. `run` is true for slider steps, which join into one undo step. */
  commit: (run: boolean) => void;
};

/** A slider with the same value as a typed number beside it. `sync` shows the current value again. */
export function fillRange(el: HTMLElement, spec: RangeSpec) {
  const bounds = { min: String(spec.min), max: String(spec.max), step: String(spec.step) };
  const range = h('input', { type: 'range', id: spec.id, 'data-key': spec.id, ...bounds });
  const num = h('input', { type: 'number', id: `${spec.id}-n`, class: 'ss-num', 'data-key': `${spec.id}-n`, 'aria-label': `${spec.label}, exact value`, inputmode: 'decimal', ...bounds });
  const show = (v: number) => { const t = String(+v.toFixed(1)); if (range.value !== t) range.value = t; if (document.activeElement !== num) num.value = t; };
  const sync = () => show(spec.get());
  range.addEventListener('input', () => { spec.set(range.valueAsNumber); num.value = range.value; });
  range.addEventListener('change', () => spec.commit(true));
  num.addEventListener('input', () => {
    const v = num.valueAsNumber;
    if (Number.isFinite(v) && v >= spec.min && v <= spec.max) { spec.set(v); range.value = String(v); }
  });
  num.addEventListener('change', () => {
    const v = num.valueAsNumber;
    if (Number.isFinite(v)) spec.set(clamp(v, spec.min, spec.max));
    num.value = String(+spec.get().toFixed(1));
    range.value = num.value;
    spec.commit(false);
  });
  el.classList.add('ss-slider');
  el.replaceChildren(h('label', { for: spec.id }, spec.label), h('span', { class: 'ss-num-wrap' }, num, h('span', { class: 'ss-unit', 'aria-hidden': 'true' }, spec.unit)), range);
  sync();
  return { sync, disable: (off: boolean) => { range.disabled = num.disabled = off; } };
}

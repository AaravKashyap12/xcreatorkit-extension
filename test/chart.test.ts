import { describe, expect, it } from 'vitest';
import { compact, sparkline, valuesTable, xyChart, type Category, type Series } from '../src/chart/xy';

// SYNTHETIC data only.
const days = (n: number): Category[] => Array.from({ length: n }, (_, i) => ({ label: `D${i + 1}` }));
const sparse = (n: number, at: number[]): (number | null)[] => Array.from({ length: n }, (_, i) => (at.includes(i) ? 1000 + i : null));

describe('xyChart sparse readings', () => {
  it('draws isolated readings as points on long ranges without joining the gaps', () => {
    const measured: Series = { name: 'Measured', color: '#000', type: 'line', values: sparse(120, [0, 7, 14, 30]) };
    const svg = xyChart(days(120), [measured], { ariaLabel: 'Progress' });
    expect(svg.querySelectorAll('circle')).toHaveLength(4);
    expect(svg.querySelectorAll('polyline')).toHaveLength(0);
    expect(svg.querySelector('circle title')?.textContent).toBe('D1\nMeasured: 1,000');
  });

  it('keeps long connected runs as lines only, and marks a lone reading beside them', () => {
    const values = sparse(120, [...Array.from({ length: 30 }, (_, i) => i), 60]);
    const svg = xyChart(days(120), [{ name: 'Measured', color: '#000', type: 'line', values }], { ariaLabel: 'Progress' });
    expect(svg.querySelectorAll('polyline')).toHaveLength(1);
    expect(svg.querySelectorAll('circle')).toHaveLength(1);
  });

  it('keeps connected dashed projections as lines without point clutter', () => {
    const projection: Series = { name: 'Projection', color: '#888', type: 'line', dashed: true, values: Array.from({ length: 120 }, (_, i) => i) };
    expect(xyChart(days(120), [projection], { ariaLabel: 'Projection' }).querySelectorAll('circle')).toHaveLength(0);
  });

  it('shows the lone trailing average in a seven-day window', () => {
    const svg = xyChart(days(7), [{ name: '7-day average', color: '#2758ce', type: 'line', dashed: true, values: [null, null, null, null, null, null, 400] }], { ariaLabel: 'Impressions' });
    expect(svg.querySelectorAll('polyline')).toHaveLength(0);
    expect(svg.querySelectorAll('circle')).toHaveLength(1);
    expect(svg.querySelector('circle title')?.textContent).toBe('D7\n7-day average: 400');
  });

  it('thins x labels to the plot width', () => {
    const labels = (width: number) => [...xyChart(days(90), [{ name: 'A', color: '#000', type: 'bar', values: Array(90).fill(1) }], { ariaLabel: 'A', width }).querySelectorAll('text.axis')].filter((t) => /^D/.test(t.textContent ?? '')).length;
    expect(labels(1180)).toBeLessThanOrEqual(11);
    expect(labels(340)).toBeLessThanOrEqual(6);
  });
});

describe('valuesTable', () => {
  it('lists every category with exact values and a dash for gaps', () => {
    const table = valuesTable([{ label: '1 Oct', title: '1 Oct 2026' }, { label: '2 Oct', partial: true }], [
      { name: 'Impressions', color: '#000', type: 'bar', values: [12345, null] },
      { name: 'Rate', color: '#000', type: 'line', values: [0.0234, 0.05], format: (v) => `${(v * 100).toFixed(1)}%` },
    ]);
    const rows = [...table.querySelectorAll('tbody tr')].map((r) => [...r.children].map((c) => c.textContent));
    expect([...table.querySelectorAll('th')].map((t) => t.textContent)).toEqual(['Period (UTC)', 'Impressions', 'Rate']);
    expect(rows).toEqual([['1 Oct 2026', '12,345', '2.3%'], ['2 Oct (partial)', '—', '5.0%']]);
  });
});

describe('negative chart axes', () => {
  it('keeps small nonzero rate ticks distinct from zero', () => {
    expect([0, 0.003, 0.006, 0.009, 0.012].map(compact)).toEqual(['0', '0.003', '0.006', '0.009', '0.012']);
  });
  it('labels zero with even readable steps and keeps both signs inside the plot', () => {
    const svg = xyChart(days(3), [{ name: 'Net follows', color: '#000', type: 'bar', values: [-5, 0, 3] }], { ariaLabel: 'Net follows' });
    const ticks = [...svg.querySelectorAll('text.axis[text-anchor="end"]')].map(t => Number(t.textContent));
    expect(ticks).toEqual([-6, -4, -2, 0, 2, 4]);
    expect(svg.querySelectorAll('line.zero')).toHaveLength(1);
    const [ , top, , height] = svg.dataset.plot!.split(' ').map(Number);
    for (const bar of svg.querySelectorAll('rect[rx]')) {
      expect(Number(bar.getAttribute('y'))).toBeGreaterThanOrEqual(top!);
      expect(Number(bar.getAttribute('y')) + Number(bar.getAttribute('height'))).toBeLessThanOrEqual(top! + height! + 0.001);
    }
  });
  it('also includes zero on a mixed-sign secondary axis', () => {
    const svg = xyChart(days(2), [{ name: 'Right', color: '#000', type: 'line', axis: 'right', values: [-3, 2] }], { ariaLabel: 'Right axis' });
    const labels = [...svg.querySelectorAll('text.axis:not([text-anchor])')].map(t => t.textContent);
    expect(labels).toContain('0');
  });
});

describe('token colours, gaps and the readout', () => {
  it('series colours given as CSS variables are applied through style', () => {
    const svg = xyChart(days(3), [{ name: 'A', color: 'var(--xck-accent)', type: 'bar', values: [1, 2, 3] }], { ariaLabel: 'A' });
    const bar = svg.querySelector('rect[rx]')!;
    expect(bar.getAttribute('style')).toBe('fill:var(--xck-accent)');
    const mixed = xyChart(days(1), [{ name: 'B', color: 'color-mix(in srgb, var(--xck-accent) 45%, white)', type: 'bar', values: [1] }], { ariaLabel: 'B' });
    expect(mixed.querySelector('rect[rx]')!.getAttribute('style')).toBe('fill:color-mix(in srgb, var(--xck-accent) 45%, white)');
  });
  it('a missing period gets a baseline mark and no bar; a captured zero gets a bar slot', () => {
    const cats: Category[] = [{ label: 'a' }, { label: 'b', missing: true }, { label: 'c' }];
    const svg = xyChart(cats, [{ name: 'A', color: '#000', type: 'bar', values: [5, null, 0] }], { ariaLabel: 'A' });
    expect(svg.querySelectorAll('.missing-mark')).toHaveLength(1);
    expect(svg.querySelectorAll('rect[rx]')).toHaveLength(2);
  });
  it('readout names the UTC period, its qualifier and every series', async () => {
    const { readoutText } = await import('../src/chart/xy');
    const series: Series[] = [
      { name: 'Impressions', color: '#000', type: 'bar', values: [18402, null, 600] },
      { name: '7-day average', color: '#000', type: 'line', values: [15210.4, null, null] },
    ];
    expect(readoutText({ label: '21 Oct', title: 'Tue 21 Oct 2026' }, series, 0)).toBe('Tue 21 Oct 2026 (UTC) · Impressions 18,402 · 7-day average 15,210.4');
    expect(readoutText({ label: '22 Oct', title: 'Wed 22 Oct 2026', missing: true }, series, 1)).toBe('Wed 22 Oct 2026 (UTC) · not captured');
    expect(readoutText({ label: '30 Oct', title: 'Fri 30 Oct 2026', partial: true, note: 'in progress' }, series, 2)).toBe('Fri 30 Oct 2026 (UTC, in progress) · Impressions 600 · 7-day average —');
    expect(readoutText({ label: '30 Oct', missing: true }, [
      { name: 'Impressions', color: '#000', type: 'bar', values: [null] },
      { name: 'Previous 7 days', color: '#888', type: 'line', values: [100] },
    ], 0)).toBe('30 Oct (UTC) · current period not captured · Impressions — · Previous 7 days 100');
  });
});

describe('opt-in light look (Analytics)', () => {
  const xs = (el: Element) => el.getAttribute('points')!.trim().split(/\s+/).map((p) => Number(p.split(',')[0]));
  it('defaults are unchanged: plain bars stay solid and plain lines get no shading', () => {
    const svg = xyChart(days(4), [{ name: 'A', color: '#123', type: 'bar', values: [1, 2, 3, 4] }, { name: 'B', color: '#456', type: 'line', values: [1, 2, 3, 4] }], { ariaLabel: 'A' });
    expect(svg.querySelectorAll('polygon')).toHaveLength(0);
    expect([...svg.querySelectorAll('rect[rx]')].every((r) => r.getAttribute('fill') === '#123' && !r.hasAttribute('stroke'))).toBe(true);
    expect(svg.querySelectorAll('circle')).toHaveLength(4);
  });
  it('a shaded line breaks its line and shading at a gap, and never shades or settles an in-progress point', () => {
    const cats = days(7); cats[3] = { label: 'D4', missing: true }; cats[6] = { label: 'D7', partial: true };
    const svg = xyChart(cats, [{ name: 'A', color: '#4a6fb5', type: 'line', area: true, values: [5, 6, 7, null, -2, 4, 9] }], { ariaLabel: 'A' });
    const [plotL, , plotW, , n] = svg.dataset.plot!.split(' ').map(Number);
    const gap = plotL! + (plotW! / n!) * 3.5, partialX = plotL! + (plotW! / n!) * 6.5;
    const areas = [...svg.querySelectorAll('polygon.area')];
    expect(areas).toHaveLength(2);
    for (const el of [...areas, ...svg.querySelectorAll('polyline:not(.partial-link)')]) {
      expect(Math.min(...xs(el)) < gap && Math.max(...xs(el)) > gap).toBe(false);
      expect(Math.max(...xs(el))).toBeLessThan(partialX);
    }
    expect(svg.querySelectorAll('polyline.partial-link')).toHaveLength(1);
    expect(svg.querySelectorAll('circle.pt-partial')).toHaveLength(1);
    // The negative value is drawn below the zero line, inside the shaded run.
    const zero = Number(svg.querySelector('line.zero')!.getAttribute('y1'));
    expect(Math.max(...areas[1]!.getAttribute('points')!.trim().split(/\s+/).map((p) => Number(p.split(',')[1])))).toBeGreaterThan(zero);
    expect(svg.querySelectorAll('.missing-mark')).toHaveLength(1);
  });
  it('a lone settled reading on a shaded line keeps a visible point; others wait for the readout', () => {
    const svg = xyChart(days(5), [{ name: 'A', color: '#000', type: 'line', area: true, values: [1, null, 3, null, 5] }], { ariaLabel: 'A' });
    expect(svg.querySelectorAll('circle.pt-lone')).toHaveLength(3);
    expect(svg.querySelectorAll('polygon.area')).toHaveLength(0);
    const run = xyChart(days(3), [{ name: 'A', color: '#000', type: 'line', area: true, values: [1, 2, 3] }], { ariaLabel: 'A' });
    expect([...run.querySelectorAll('circle.pt')].every((c) => c.getAttribute('visibility') === 'hidden')).toBe(true);
  });
  it('pale bars are outlined in their series colour, dashed when in progress, and solid when too narrow', () => {
    const cats = days(3); cats[2] = { label: 'D3', partial: true };
    const svg = xyChart(cats, [{ name: 'A', color: 'var(--xck-an-line)', fill: 'var(--xck-an-fill)', type: 'bar', values: [1, 2, 3] }], { ariaLabel: 'A' });
    const bars = [...svg.querySelectorAll('rect[rx]')];
    expect(bars.every((r) => r.getAttribute('style') === 'fill:var(--xck-an-fill);stroke:var(--xck-an-line)')).toBe(true);
    expect(bars.map((r) => r.getAttribute('stroke-dasharray'))).toEqual([null, null, '3 2']);
    const narrow = xyChart(days(200), [{ name: 'A', color: '#4a6fb5', fill: '#cfdbf1', type: 'bar', values: Array(200).fill(1) }], { ariaLabel: 'A' });
    expect([...narrow.querySelectorAll('rect[rx]')].every((r) => r.getAttribute('fill') === '#4a6fb5' && !r.hasAttribute('stroke'))).toBe(true);
  });
  it('a quiet reference line drops its per-point markers but keeps a lone reading', () => {
    const svg = xyChart(days(5), [{ name: 'Prev', color: '#888', type: 'line', markers: false, values: [1, 2, 3, null, 5] }], { ariaLabel: 'A' });
    expect(svg.querySelectorAll('circle')).toHaveLength(1);
  });
});

describe('sparkline', () => {
  it('draws real values only: gaps break it, in-progress joins dashed, fewer than two values draw nothing', () => {
    expect(sparkline([null, 4, null], [false, false, false], '#000')).toBeNull();
    const svg = sparkline([1, 2, null, 3, 4, 5], [false, false, false, false, false, true], '#000')!;
    const lines = [...svg.querySelectorAll('polyline')];
    expect(lines.filter((l) => !l.hasAttribute('stroke-dasharray')).map((l) => l.getAttribute('points')!.split(' ').length)).toEqual([2, 2]);
    expect(lines.filter((l) => l.getAttribute('stroke-dasharray'))).toHaveLength(1);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });
  it('shows a zero line only when the values cross zero, and a lone reading as a dot', () => {
    expect(sparkline([-2, 3], [false, false], '#000')!.querySelector('line.spark-zero')).not.toBeNull();
    expect(sparkline([2, 3], [false, false], '#000')!.querySelector('line.spark-zero')).toBeNull();
    const lone = sparkline([1, null, 5, 6], [false, false, false, false], '#000')!;
    expect([...lone.querySelectorAll('polyline')].map((l) => l.getAttribute('stroke-width'))).toEqual(['4', '1.75']);
  });
});

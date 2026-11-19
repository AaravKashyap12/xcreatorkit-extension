import { SYSTEM } from './core';
export type Session = { prompt(text: string, options: { signal: AbortSignal; responseConstraint: unknown }): Promise<string>; destroy(): void };
type Options = { expectedInputs: { type: string; languages: string[] }[]; expectedOutputs: { type: string; languages: string[] }[] };
type Model = { availability(options: Options): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>; create(options: Options & { signal: AbortSignal; initialPrompts: { role: string; content: string }[]; monitor(m: EventTarget): void }): Promise<Session> };
const options = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };
export function model(): Model | undefined { return (globalThis as typeof globalThis & { LanguageModel?: Model }).LanguageModel; }
export async function availability() { return model()?.availability(options) ?? 'unavailable'; }
export function create(signal: AbortSignal, progress: (value: number) => void): Promise<Session> {
  const api = model();
  if (!api) return Promise.reject(new Error('Chrome on-device AI is unavailable.'));
  return api.create({ ...options, signal, initialPrompts: [{ role: 'system', content: SYSTEM }], monitor(m) {
    m.addEventListener('downloadprogress', event => {
      const loaded = (event as Event & { loaded: number }).loaded;
      if (Number.isFinite(loaded)) progress(Math.round(Math.max(0, Math.min(1, loaded)) * 100));
    });
  } });
}
export const schema = { anyOf: [
  { type: 'object', properties: { drafts: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 1 } }, required: ['drafts'], additionalProperties: false },
  { type: 'object', properties: { needsDetail: { type: 'string' }, factKey: { type: 'string', enum: ['project', 'role', 'other'] } }, required: ['needsDetail'], additionalProperties: false },
] };

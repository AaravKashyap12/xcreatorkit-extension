import { SYSTEM } from './core';
import type { Session } from './model';
export const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com/*';
const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite';
export class CloudError extends Error {}
export const validKey = (key: string) => /^[A-Za-z0-9_.-]{20,200}$/.test(key);
async function request(key: string, signal: AbortSignal, body?: unknown): Promise<any> {
  if (!validKey(key)) throw new CloudError('Enter a valid Gemini API key.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 30_000);
  try {
    const response = await fetch(endpoint + (body ? ':generateContent' : ''), {
      method: body ? 'POST' : 'GET', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal,
      credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    });
    if (!response.ok) {
      void response.body?.cancel();
      throw new CloudError(response.status === 429 ? 'Gemini quota or rate limit reached. Check your project limits in AI Studio, then retry later.'
        : response.status === 400 ? 'Gemini rejected the key or request. Check the key and that your project and region are eligible.'
        : [401, 403].includes(response.status) ? 'Gemini rejected access. Check your key, project eligibility and billing in AI Studio.'
        : response.status === 404 ? 'This Gemini model is unavailable to your project. Choose the local model or try again later.'
        : 'Gemini is unavailable. Your edits are kept. Try again later.');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new CloudError('Gemini returned an empty response.');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 32_768) throw new CloudError('Gemini returned too much data. Your edits are kept.');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const all = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(all));
  } catch (error) {
    if (error instanceof CloudError) throw error;
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    throw new CloudError(controller.signal.aborted ? 'Gemini timed out. Your edits are kept. Retry when ready.' : 'Could not reach Gemini or read its response. Check your connection and retry.');
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
export async function testKey(key: string, signal: AbortSignal) { await request(key, signal); }
export function gemini(key: string): Session {
  const lifetime = new AbortController();
  return {
    destroy() { key = ''; lifetime.abort(); },
    async prompt(text, options) {
      if (text.length > 12_000) throw new CloudError('Reply context is too long. Shorten the post or writing examples.');
      const data = await request(key, AbortSignal.any([options.signal, lifetime.signal]), {
        systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'low' }, responseMimeType: 'application/json', responseJsonSchema: options.responseConstraint },
      });
      const candidate = data?.candidates?.[0];
      if (candidate?.finishReason !== 'STOP' || !Array.isArray(candidate?.content?.parts)) throw new CloudError('Gemini did not return a complete draft. Try a different take.');
      const raw = candidate.content.parts.filter((p: any) => !p.thought && typeof p.text === 'string').map((p: any) => p.text).join('');
      if (!raw || raw.length > 2000) throw new CloudError('Gemini returned an invalid draft. Your edits are kept.');
      return raw;
    },
  };
}

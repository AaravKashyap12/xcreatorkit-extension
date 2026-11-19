import { describe, it, expect, vi, afterEach } from 'vitest';
import { gemini, testKey, validKey, CloudError } from '../src/reply/cloud';
const key = 'synthetic-key-for-local-tests';
const signal = new AbortController().signal;
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('Gemini request boundary', () => {
  it('accepts dotted authorization keys while rejecting whitespace and header controls', () => {
    expect(validKey('synthetic.authorization-key-for-tests')).toBe(true);
    expect(validKey('synthetic key with spaces')).toBe(false);
    expect(validKey('synthetic\r\nheader-key')).toBe(false);
  });
  it('tests a key without sending post or profile data', async () => {
    const f = vi.fn(async (_url: string, _options?: RequestInit) => new Response('{}')); vi.stubGlobal('fetch', f);
    await testKey(key, signal);
    expect(f.mock.calls[0]![0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite');
    expect(f.mock.calls[0]![1]).not.toHaveProperty('body');
  });
  it('sends only to the fixed endpoint, in headers, without credentials or redirects', async () => {
    const f = vi.fn(async (_url: string, _options?: RequestInit) => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"drafts":["A","B"]}' }] } }] })); vi.stubGlobal('fetch', f);
    const s = gemini(key);
    expect(await s.prompt('synthetic post', { signal, responseConstraint: {} })).toContain('drafts');
    const [url, options] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).not.toContain(key); expect(options.headers).toMatchObject({ 'x-goog-api-key': key });
    expect(options.credentials).toBe('omit'); expect(options.redirect).toBe('error');
    expect(JSON.parse(options.body as string).contents[0].parts[0].text).toBe('synthetic post');
    s.destroy(); await expect(s.prompt('again', { signal, responseConstraint: {} })).rejects.toThrow();
  });
  it.each([400, 401, 403, 429, 503])('redacts provider errors (%s) and never retries automatically', async code => {
    const f = vi.fn(async (_url: string, _options?: RequestInit) => new Response(key, { status: code })); vi.stubGlobal('fetch', f);
    await expect(testKey(key, signal)).rejects.toBeInstanceOf(CloudError);
    try { await testKey(key, signal); } catch(e) {
      expect(String(e)).not.toContain(key);
      if (code === 400) expect(String(e)).toContain('Check the key and that your project and region are eligible');
    }
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid keys, oversized input and responses without leaking them', async () => {
    const f = vi.fn(async (_url: string, _options?: RequestInit) => Response.json({ padding: 'x'.repeat(40000) })); vi.stubGlobal('fetch', f);
    await expect(testKey('bad\nkey', signal)).rejects.toThrow(); expect(f).not.toHaveBeenCalled();
    await expect(gemini(key).prompt('x'.repeat(15000), { signal, responseConstraint: {} })).rejects.toThrow('too long');
    expect(f).not.toHaveBeenCalled();
    await expect(testKey(key, signal)).rejects.toThrow('too much data');
  });
  it('times out a stalled request without exposing its key', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_url: string, options: RequestInit) => new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error(key)))));
    const result = expect(testKey(key, signal)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_001); await result;
  });
  it.each([{ candidates: [] }, { candidates: [{ finishReason: 'MAX_TOKENS' }] }, {}])('rejects incomplete provider responses', async body => {
    vi.stubGlobal('fetch', async () => Response.json(body));
    await expect(gemini(key).prompt('post', { signal, responseConstraint: {} })).rejects.toThrow('complete draft');
  });
  it('honors cancellation before sending', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    await expect(testKey(key, AbortSignal.abort())).rejects.toThrow(); expect(f).not.toHaveBeenCalled();
  });
});

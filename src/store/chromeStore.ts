import type { StoreState } from '../model/types';
import { defaultSettings } from '../model/types';
import { emptyState } from './state';

const KEY = 'xgd:v1';
const PRE_IMPORT_KEY = 'xgd:v1:pre-import-backup';

export async function loadState(): Promise<StoreState> {
  const got = await chrome.storage.local.get(KEY);
  const s = got[KEY] as StoreState | undefined;
  if (!s) return emptyState();
  // Reporting follows X's UTC clock, including stores with an inconsistent legacy utcOnly flag.
  const settings = { ...defaultSettings(), ...s.settings, reportingTimeZone: 'UTC', cycleCutoffHour: 0, utcOnly: true };
  // Legacy builds saved enabled=true by default, so it cannot establish a user choice.
  settings.followBackEnabled = settings.followBackEnabled === true && settings.followBackOptIn === true;
  return { ...s, settings };
}

export async function saveState(state: StoreState): Promise<void> {
  await chrome.storage.local.set({ [KEY]: state });
}

/** Keep a copy of the current state before an import mutates it. */
export async function snapshotBeforeImport(state: StoreState): Promise<void> {
  await chrome.storage.local.set({ [PRE_IMPORT_KEY]: { at: new Date().toISOString(), state } });
}

/** Read-modify-write helper. Keeps the service worker and extension pages from clobbering each other's edits. */
export async function updateState<T>(fn: (s: StoreState) => T): Promise<{ state: StoreState; result: T }> {
  const state = await loadState();
  const result = fn(state);
  await saveState(state);
  return { state, result };
}

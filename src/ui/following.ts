// The chooser's Following switch needs x.com access and a valid account before it turns on.
import type { Settings } from '../model/types';
import { X_ORIGINS } from '../capture/run';
import { updateState } from '../store/chromeStore';
import { normalizeHandle } from '../store/state';

/** Highlighting is actually on only with the saved preference, x.com access and a valid account. */
export const followingOn = (settings: Settings, stored: boolean, allowed: boolean) =>
  stored && settings.followBackEnabled === true && settings.followBackOptIn === true && allowed && !!normalizeHandle(settings.expectedHandle);

/**
 * Save the checkbox's new state. Call it straight from the change handler: Chrome only shows its
 * x.com prompt inside the user's gesture, so the request comes before anything else is awaited.
 * Throws a message naming the problem and the fix; nothing is saved in that case.
 */
export async function setFollowing(enabled: boolean, account: () => Promise<string | null> | string | null, missing: string): Promise<string | null> {
  if (!enabled) {
    await updateState((state) => { state.settings.followBackEnabled = false; });
    return null;
  }
  if (!(await chrome.permissions.request({ origins: X_ORIGINS }))) throw new Error('Allow x.com access to enable highlighting.');
  const handle = await account();
  if (!handle) throw new Error(missing);
  await updateState((state) => { state.settings.expectedHandle = handle; state.settings.followBackEnabled = true; state.settings.followBackOptIn = true; });
  return handle;
}

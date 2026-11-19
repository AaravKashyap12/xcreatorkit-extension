// Runs in the extension's isolated world on https://x.com/<handle>, only as part of a capture the
// user started. Reads the follower link X renders in the profile header ("1,030 Followers").
// Self-contained (serialized by chrome.scripting). Reads text only; no network, no cookies.

export type ProfileResult =
  | { ok: true; account: string; followersText: string }
  | { ok: false; code: 'not_own_profile' | 'not_found'; message: string; account: string | null };

export async function xProfileFollowersInPage(handle: string): Promise<ProfileResult> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const signedIn = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href') ?? '')?.[1]?.toLowerCase() ?? null;
  const pageHandle = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(location.pathname)?.[1]?.toLowerCase() ?? null;
  for (let i = 0; i < 60; i++) {
    const me = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href') ?? '')?.[1]?.toLowerCase() ?? signedIn;
    if (me && pageHandle && me !== pageHandle) return { ok: false, code: 'not_own_profile', message: `profile is @${pageHandle}, signed in as @${me}`, account: me };
    const link = document.querySelector(`a[href="/${handle}/verified_followers" i], a[href="/${handle}/followers" i]`);
    const m = link && /([\d.,]+\s*[KMB]?)\s*Followers/i.exec(link.textContent ?? '');
    if (m && me && me === handle.toLowerCase()) return { ok: true, account: me, followersText: m[1]!.replace(/\s+/g, '') };
    await sleep(250);
  }
  return { ok: false, code: 'not_found', message: 'follower count not found on the profile page', account: signedIn };
}

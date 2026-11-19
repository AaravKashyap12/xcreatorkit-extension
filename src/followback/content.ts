// Reads only visible Following rows. Account names and relationship state never enter storage.
type Config = { allowed: boolean; enabled: boolean; handle: string | null };

const root = globalThis as typeof globalThis & { __xckFollowBack?: boolean };
if (!root.__xckFollowBack) {
  root.__xckFollowBack = true;
  start();
}

function start() {
  const CLASS = 'xck-nofollowback';
  const STYLE_ID = 'xck-followback-style';
  const PROFILE = '[data-testid="AppTabBar_Profile_Link"]';
  const PRIMARY = '[data-testid="primaryColumn"]';
  const CELL = '[data-testid="cellInnerDiv"]';
  const USER = '[data-testid="UserCell"]';
  const AVATAR = '[data-testid^="UserAvatar-Container-"]';
  const INDICATOR = '[data-testid="userFollowIndicator"]';
  const handleFromPath = (path: string): string | null => {
    const match = /^\/([a-z0-9_]{1,15})\/?$/i.exec(path);
    return match ? match[1]!.toLowerCase() : null;
  };
  const linkHandle = (link: Element): string | null => {
    if (!(link instanceof HTMLAnchorElement)) return null;
    try {
      const url = new URL(link.href);
      return url.origin === location.origin ? handleFromPath(url.pathname) : null;
    } catch { return null; }
  };

  let config: Config = { allowed: false, enabled: false, handle: null };
  let observed: Element | null = null;
  let observer: MutationObserver | null = null;
  let frame = 0;
  let poll = 0;
  let configRequest = 0;
  const active = () => config.allowed && config.enabled && !!config.handle;
  let lastUrl = '';
  let lastProfile = '';
  let lastPrimary: Element | null = null;
  let lastRegions: Element[] = [];

  const regionsIn = (primary: Element | null) => primary
    ? [...primary.querySelectorAll('section[aria-labelledby], section[role="region"]')]
      .filter((region) => region.querySelector(`${CELL} ${USER}`))
    : [];

  function clear() {
    document.querySelectorAll(`.${CLASS}`).forEach((row) => row.classList.remove(CLASS));
  }

  function ownFollowing(): boolean {
    if (!config.allowed || !config.enabled || !config.handle || location.hostname !== 'x.com') return false;
    const route = /^\/([a-z0-9_]{1,15})\/following\/?$/i.exec(location.pathname);
    if (!route || route[1]!.toLowerCase() !== config.handle) return false;
    const profileLinks = [...document.querySelectorAll(PROFILE)];
    return profileLinks.length === 1 && linkHandle(profileLinks[0]!) === config.handle;
  }

  function scan() {
    frame = 0;
    if (!active()) return;
    const primary = document.querySelector(PRIMARY);
    const regions = ownFollowing() ? regionsIn(primary) : [];
    const region = regions.length === 1 ? regions[0]! : null;
    if (region !== observed) {
      observer?.disconnect();
      observed = region;
      observer = region ? new MutationObserver(schedule) : null;
      observer?.observe(region!, { subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'data-testid'] });
    }
    if (!region) { clear(); return; }

    // A single region and a single user cell per row are required; unknown layouts stay untinted.
    const validRows = new Set<Element>();
    for (const row of region.querySelectorAll(CELL)) {
      const users = row.querySelectorAll(USER);
      if (users.length !== 1 || row.closest('section[aria-labelledby], section[role="region"]') !== region) continue;
      const user = users[0]!;
      // Bio mentions link to other accounts; the avatar identifies the row's owner.
      const avatars = user.querySelectorAll(AVATAR);
      if (avatars.length > 1) continue;
      const identity = avatars[0] ?? user;
      const handles = new Set([...identity.querySelectorAll('a[href]')].map(linkHandle).filter((h): h is string => h !== null));
      if (handles.size !== 1) continue;
      const indicators = user.querySelectorAll(INDICATOR);
      if (indicators.length > 1 || row.querySelectorAll(INDICATOR).length !== indicators.length) continue;
      validRows.add(row);
      row.classList.toggle(CLASS, indicators.length === 0);
    }
    for (const tinted of document.querySelectorAll(`.${CLASS}`)) if (!validRows.has(tinted)) tinted.classList.remove(CLASS);
  }

  function schedule() {
    if (active() && !frame) frame = requestAnimationFrame(scan);
  }

  function suspend() {
    if (frame) cancelAnimationFrame(frame);
    if (poll) clearInterval(poll);
    frame = poll = 0;
    observer?.disconnect();
    observer = null;
    observed = null;
    lastUrl = lastProfile = '';
    lastPrimary = null;
    lastRegions = [];
    clear(); // Remove only our decoration when access or the local switch turns off.
  }

  async function refreshConfig() {
    const request = ++configRequest;
    let next: Config;
    try {
      next = await chrome.runtime.sendMessage({ type: 'xck:followback:config' }) as Config;
    } catch {
      next = { allowed: false, enabled: false, handle: null };
    }
    if (request !== configRequest) return;
    config = next;
    if (!active()) { suspend(); return; }
    if (!poll) poll = window.setInterval(pollPage, 750);
    schedule();
  }

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `.${CLASS} { background: rgba(224, 64, 64, .08) !important; }`;
  (document.head ?? document.documentElement).append(style);
  chrome.runtime.onMessage.addListener((message: { type?: string }) => {
    if (message?.type === 'xck:followback:refresh') void refreshConfig();
  });
  chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'local') void refreshConfig(); });
  addEventListener('popstate', schedule);
  addEventListener('hashchange', schedule);
  function pollPage() {
    if (!active()) return;
    if (document.hidden) return;
    // X uses SPA navigation. Outside Following, check only the route, not its analytics DOM.
    if (!new RegExp(`^/${config.handle}/following/?$`, 'i').test(location.pathname)) {
      if (location.href !== lastUrl) { lastUrl = location.href; schedule(); }
      return;
    }
    const profile = [...document.querySelectorAll(PROFILE)].map((link) => (link as HTMLAnchorElement).href).join('|');
    const primary = document.querySelector(PRIMARY);
    const regions = regionsIn(primary);
    if (location.href !== lastUrl || profile !== lastProfile || primary !== lastPrimary ||
      regions.length !== lastRegions.length || regions.some((region, index) => region !== lastRegions[index])) {
      lastUrl = location.href;
      lastProfile = profile;
      lastPrimary = primary;
      lastRegions = regions;
      schedule(); // Rebind after a SPA replaces the primary column or profile link.
    }
  }
  void refreshConfig();
}

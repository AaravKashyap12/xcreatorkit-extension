// Synthetic built-extension checks. The fake LanguageModel is installed only in this harness.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const dist = mkdtempSync(join(tmpdir(), 'xck-reply-dist-'));
cpSync('dist', dist, { recursive: true });
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json')));
manifest.host_permissions = ['https://x.com/*', 'https://generativelanguage.googleapis.com/*'];
writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest));
const executablePath = [process.env.CHROMIUM_PATH, chromium.executablePath()].find(p => p && existsSync(p));
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'xck-reply-')), { executablePath, headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`], viewport: { width: 1000, height: 900 } });
const requests = [];
ctx.on('request', r => { if (/^https?:/.test(r.url()) && !(r.isNavigationRequest() && r.url() === 'https://x.com/home') && !(r.resourceType() === 'image' && r.url().startsWith('https://pbs.twimg.com/'))) requests.push(r.url()); });
const fixture = readFileSync('test/fixtures/postcard.html', 'utf8');
await ctx.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
await ctx.route('https://pbs.twimg.com/**', route => route.abort());
const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
const base = worker.url().replace(/\/background\.js$/, '');
async function fake(page) {
  await page.addInitScript(() => {
    globalThis.fakeMode = 'downloadable'; globalThis.lastPrompt = '';
    globalThis.LanguageModel = {
      availability: async () => globalThis.fakeMode === 'unsupported' ? 'unavailable' : globalThis.fakeMode,
      create: async options => {
        if (globalThis.fakeMode === 'error') throw new Error('synthetic failure');
        if (globalThis.fakeMode === 'downloadable') {
          const monitor = new EventTarget(); options.monitor(monitor);
          const event = new Event('downloadprogress'); event.loaded = .5; monitor.dispatchEvent(event);
          await new Promise(r => setTimeout(r, globalThis.fakeInitializeDelay ?? 200)); globalThis.fakeMode = 'available';
        }
        return { destroy() {}, async prompt(input) {
          globalThis.lastPrompt = input;
          await globalThis.holdModelReply;
          await new Promise(r => setTimeout(r, globalThis.fakeDelay ?? 50));
          if (globalThis.fakeMode === 'error') throw new Error('synthetic failure');
          return globalThis.fakeResponse ?? JSON.stringify({ drafts: ['Which feedback changed your next release?'] });
        } };
      },
    };
    Object.defineProperty(navigator, 'clipboard', { value: { async writeText(text) { if (globalThis.copyFails) throw new Error('denied'); globalThis.copied = text; } } });
  });
}
await fake(ctx);
try {
  const x = await ctx.newPage(); await x.goto('https://x.com/home');
  const editor = await ctx.newPage(); await fake(editor); await editor.goto(`${base}/reply.html`);
  await editor.getByRole('button', { name: 'Enable reply drafting', exact: true }).click();
  await editor.getByText('Model downloadable.', { exact: false }).waitFor();
  const isolation = await editor.evaluate(async () => ({ local: await chrome.storage.local.get(null), scripts: await chrome.scripting.getRegisteredContentScripts() }));
  assert.equal(isolation.local['xck:reply-consent'], 1);
  assert.equal(isolation.local['xck:postcard-consent'], undefined);
  assert.equal(isolation.local['xgd:v1'], undefined);
  assert(!isolation.scripts.some(s => s.id === 'xck-postcard-target'));
  const tabId = await editor.evaluate(async () => (await chrome.tabs.query({ url: 'https://x.com/home' }))[0].id);
  await editor.evaluate(async id => chrome.scripting.executeScript({ target: { tabId: id }, files: ['reply-target.js'] }), tabId);
  const collect = () => editor.evaluate(id => chrome.tabs.sendMessage(id, { type: 'xck:reply:collect' }), tabId);
  await x.locator('#second [data-testid="quote"] [data-testid="tweetText"]').dispatchEvent('contextmenu');
  assert.equal((await collect()).ok, false);
  await x.locator('#second > [data-testid="tweetText"]').dispatchEvent('contextmenu');
  assert.equal((await collect()).ok, false); // whole quoted context needs paste
  await x.locator('#first [data-testid="tweetText"]').dispatchEvent('contextmenu');
  const chosen = await collect(); assert.equal(chosen.source.url, 'https://x.com/firstuser/status/111');
  assert.deepEqual(Object.keys(chosen.source).sort(), ['author', 'text', 'url']);
  await x.locator('#first [data-testid="tweetText"]').dispatchEvent('contextmenu');
  await x.locator('#first [data-testid="tweetText"]').evaluate(el => { el.textContent = 'Changed'; });
  assert.equal((await collect()).ok, false);
  // Open the real Chrome side-panel surface through its extension link. CDP attaches
  // to that native target because Playwright does not list side panels as tabs.
  const launcher = await ctx.newPage(); await launcher.goto(`${base}/launcher.html`);
  const cdp = await ctx.newCDPSession(launcher);
  const panelIds = new Set();
  let commandId = 0;
  async function panelIn(page) {
    const before = ctx.pages().length;
    await page.getByRole('link', { name: 'Reply drafter', exact: true }).first().click();
    let target;
    for (let n = 0; n < 100; n++) {
      target = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.url === `${base}/reply.html?panel` && !panelIds.has(t.targetId));
      if (target) break;
      await page.waitForTimeout(30);
    }
    assert(target, 'toolbar entry opens a native side panel');
    assert.equal(ctx.pages().length, before, 'opening the reply panel creates no tab');
    panelIds.add(target.targetId);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
    async function command(method, params) {
      const id = ++commandId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', listener); reject(new Error(`Panel ${method} timed out`)); }, 10000);
        const listener = event => {
          if (event.sessionId !== sessionId) return;
          const data = JSON.parse(event.message); if (data.id !== id) return;
          clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', listener);
          data.error ? reject(new Error(data.error.message)) : resolve(data.result);
        };
        cdp.on('Target.receivedMessageFromTarget', listener);
        cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
      });
    }
    const evaluate = async expression => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    };
    const wait = async expression => {
      for (let n=0;n<100;n++) { if (await evaluate(expression)) return; await page.waitForTimeout(30); }
      assert.fail(`Panel state never reached: ${expression}`);
    };
    await wait(`!!document.querySelector('#post')`);
    const windowId = await evaluate('(async()=> (await chrome.windows.getCurrent()).id)()');
    const native = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }));
    assert(native.some(c => c.documentUrl === `${base}/reply.html?panel`));
    return { evaluate, wait, command, windowId, targetId: target.targetId };
  }
  const panel = await panelIn(launcher);
  // Synthetic context-menu dispatch has no OS gesture. Only open() is stubbed here;
  // actual opening was just verified through a real click, and capture/messages stay real.
  await worker.evaluate(() => { globalThis.realPanelOpen=chrome.sidePanel.open; globalThis.panelOpens=[]; chrome.sidePanel.open=async options=>{ panelOpens.push(options); }; });
  const choose = async id => worker.evaluate(async id => {
    const tab = await chrome.tabs.get(id);
    chrome.contextMenus.onClicked.dispatch({ menuItemId:'reply', pageUrl:tab.url, frameId:0 },tab);
  }, id);
  await choose(tabId);
  await launcher.waitForTimeout(250);
  await panel.wait(`document.querySelector('#source-context').textContent.includes('could not be captured')`);
  assert(await panel.evaluate(`!document.querySelector('#post').disabled`));
  await x.reload();
  await editor.evaluate(async id => chrome.scripting.executeScript({ target: { tabId:id }, files:['reply-target.js'] }),tabId);
  await x.locator('#first [data-testid="tweetText"]').evaluate(el=>{el.textContent='Collapsed text…';});
  await x.locator('#first [data-testid="tweetText"]').dispatchEvent('contextmenu'); assert.equal((await collect()).ok,false);
  await x.locator('#first [data-testid="tweetText"]').evaluate(el=>{el.textContent='x'.repeat(3001);});
  await x.locator('#first [data-testid="tweetText"]').dispatchEvent('contextmenu'); assert.equal((await collect()).ok,false);
  await x.reload();
  await editor.evaluate(async id => chrome.scripting.executeScript({ target: { tabId:id }, files:['reply-target.js'] }),tabId);
  await x.evaluate(()=>{globalThis.xWrites=0;document.addEventListener('click',()=>xWrites++);});
  await x.locator('#first [data-testid="tweetText"]').dispatchEvent('contextmenu'); await choose(tabId);
  await panel.wait(`document.querySelector('#post').value.includes('First post')`);
  assert.equal(await panel.evaluate(`document.querySelector('#source-context a').href`),'https://x.com/firstuser/status/111');
  assert.equal(await editor.locator('#post').inputValue(),'');
  // Keep a hand edit when another post arrives; replacement is an explicit action.
  await panel.evaluate(`document.querySelector('#post').value='My current post';document.querySelector('#post').dispatchEvent(new Event('input'))`);
  await x.locator('#first [data-testid="tweetText"]').evaluate(el=>{el.textContent='A second independently selected post.';});
  await x.locator('#first [data-testid="tweetText"]').dispatchEvent('contextmenu'); await choose(tabId);
  await panel.wait(`!document.querySelector('.reply-incoming').hidden`);
  assert.equal(await panel.evaluate(`document.querySelector('#post').value`),'My current post');
  await panel.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Keep current').click()`);
  assert.equal(await panel.evaluate(`document.querySelector('#post').value`),'My current post');
  assert.equal(await panel.evaluate(`document.activeElement.id`),'post');
  await x.locator('#first [data-testid="tweetText"]').dispatchEvent('contextmenu'); await choose(tabId);
  await panel.wait(`!document.querySelector('.reply-incoming').hidden`);
  await panel.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Use this post').click()`);
  assert.equal(await panel.evaluate(`document.querySelector('#post').value`),'A second independently selected post.');
  assert.equal(await x.evaluate(()=>xWrites),0);
  assert.equal(await panel.evaluate(`document.querySelector('#draft-0').value`),'');
  // Exercise the native panel with a controllable synthetic model and clipboard.
  // Each answer can arrive immediately, after a preference change, or after cancellation.
  mkdirSync('verification/_reply-motion', { recursive: true });
  const frame = async (name) => {
    const { data } = await panel.command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`verification/_reply-motion/${name}.png`, Buffer.from(data, 'base64'));
  };
  const panelMotion = (value) => panel.command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] });
  const act = (name) => panel.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(name)} && b.getClientRects().length);
    button.focus(); button.click();
  })()`);
  const finishDraft = result => panel.evaluate(`(() => {
    const completed = settlePrompt; settlePrompt = null;
    completed.resolve(${JSON.stringify(JSON.stringify(result))});
  })()`);
  const inline = sel => `document.querySelector(${JSON.stringify(sel)}).style`;
  await panelMotion('no-preference');
  await panel.evaluate(`
    globalThis.settlePrompt = null;
    globalThis.settleCopy = null;
    globalThis.LanguageModel = {
      availability: async () => 'available',
      create: async () => ({ destroy() {}, prompt: () => new Promise((resolve, reject) => { settlePrompt = { resolve, reject }; }) }),
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: text => new Promise(resolve => { settleCopy = resolve; globalThis.copiedText = text; }),
    } });
  `);
  await act('Initialize model');
  await panel.wait(`!document.querySelector('#draft-reply').disabled`);
  assert(await panel.evaluate(`!!${inline('#draft-reply')}.transform`), 'the enabled key settles into place on ready');
  await frame('ready');
  await act('Draft reply');
  await panel.wait('!!settlePrompt');
  assert(await panel.evaluate(`document.activeElement.textContent === 'Cancel' && !!${inline('.reply-work-ink')}.transform`));
  assert.equal(await panel.evaluate(`document.querySelector('.reply-work').textContent`), 'Writing your reply…');
  await frame('writing');
  await finishDraft({ drafts: ['First motion sample.'] });
  await panel.wait(`!!${inline('.reply-results')}.transform`);
  assert(await panel.evaluate(`document.activeElement.id === 'draft-0' && document.querySelector('#draft-0').value === 'First motion sample.' && !document.querySelector('.reply-results section button').disabled`), 'first draft is ready for editing and copying during its reveal');
  await frame('draft-reveal');
  await act('Try another');
  await panel.wait('!!settlePrompt');
  assert(await panel.evaluate(`!!${inline('.reply-work-ink')}.transform`));
  await panelMotion('reduce');
  await panel.wait(`matchMedia('(prefers-reduced-motion: reduce)').matches && !${inline('.reply-work-ink')}.transform`);
  assert.equal(await panel.evaluate(`document.activeElement.textContent`), 'Cancel');
  await finishDraft({ drafts: ['Synthetic first reply.'] });
  await panel.wait(`document.querySelector('#draft-0').value === 'Synthetic first reply.'`);
  assert(await panel.evaluate(`document.activeElement.id === 'draft-0' && !${inline('.reply-results')}.transform && !${inline('#draft-0')}.backgroundColor && document.querySelector('.reply-work').hidden`), 'reduced motion still completes drafting and places focus on the draft');
  await frame('draft-reduced');
  await panelMotion('no-preference');
  await act('Copy');
  await panel.evaluate('settleCopy()');
  await panel.wait(`document.querySelector('.reply-results section button').textContent === 'Copied'`);
  const copyMotion = await panel.evaluate(`({ transform: ${inline('.reply-results section button span')}.transform, hidden: document.hidden, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches })`);
  assert(copyMotion.transform, JSON.stringify(copyMotion));
  assert(await panel.evaluate(`document.activeElement.textContent === 'Copied' && copiedText === 'Synthetic first reply.'`));
  await frame('copied');
  // A clipboard promise completing after an edit must leave the Copy key and draft alone.
  await act('Copied');
  await panel.evaluate(`{
    const draft = document.querySelector('#draft-0');
    draft.value = 'Edited reply kept while revising.';
    draft.dispatchEvent(new Event('input'));
    settleCopy();
  }`);
  assert(await panel.evaluate(`document.querySelector('.reply-results section button').textContent === 'Copy' && !${inline('.reply-results section button span')}.transform`));
  await act('Shorter');
  await panel.wait('!!settlePrompt');
  assert.equal(await panel.evaluate(`document.querySelector('.reply-work').textContent`), 'Shortening your reply…');
  assert(await panel.evaluate(`document.querySelector('#draft-0').value === 'Edited reply kept while revising.' && !document.querySelector('#draft-0').disabled`));
  await frame('revising');
  await finishDraft({ drafts: ['Edited reply.'] });
  await panel.wait(`!!${inline('#draft-0')}.backgroundColor`);
  await frame('revision');
  await act('Undo');
  assert(await panel.evaluate(`document.querySelector('#draft-0').value === 'Edited reply kept while revising.' && !${inline('#draft-0')}.backgroundColor && !!${inline('label[for="draft-0"]')}.transform`));
  await frame('undo');
  await act('Redo');
  assert.equal(await panel.evaluate(`document.querySelector('#draft-0').value`), 'Edited reply.');
  await act('Try another');
  await panel.wait('!!settlePrompt');
  await act('Cancel');
  await finishDraft({ drafts: ['Late draft after cancellation.'] });
  assert(await panel.evaluate(`document.querySelector('#draft-0').value === 'Edited reply.' && document.activeElement.textContent === 'Try another' && !${inline('.reply-work-ink')}.transform && document.querySelector('#reply-status').dataset.tone === 'cancel'`));
  await frame('cancelled');
  await act('Try another');
  await panel.wait('!!settlePrompt');
  await finishDraft({ needsDetail: 'What changed after the first test?', factKey: 'other' });
  await panel.wait(`!!${inline('.reply-question')}.transform`);
  assert(await panel.evaluate(`document.activeElement.id === 'personal-answer' && document.querySelector('.reply-results').hidden`));
  await frame('needs-detail');
  await act('Skip for now');
  await act('Try another');
  await panel.wait('!!settlePrompt');
  await finishDraft({ drafts: [] });
  await panel.wait(`document.querySelector('#reply-status').dataset.tone === 'error'`);
  assert(await panel.evaluate(`!!${inline('#reply-status')}.transform && document.querySelector('#draft-0').value === 'Edited reply.' && document.activeElement.textContent === 'Try another'`));
  await frame('error');
  await act('Try another');
  await panel.wait('!!settlePrompt');
  assert(await panel.evaluate(`(() => {
    const wasMoving = !!${inline('.reply-work-ink')}.transform;
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    return wasMoving && !${inline('.reply-work-ink')}.transform;
  })()`), 'hiding settles a running working cue');
  // Finish while hidden, with focus intentionally moved off Cancel.
  await panel.evaluate(`document.querySelector('#post').focus()`);
  await finishDraft({ drafts: ['Arrived while hidden.'] });
  await panel.wait(`document.querySelector('#draft-0').value === 'Arrived while hidden.'`);
  assert(await panel.evaluate(`!${inline('#draft-0')}.backgroundColor && document.activeElement.id === 'post'`));
  await panel.evaluate(`delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));`);
  assert(await panel.evaluate(`!${inline('#draft-0')}.backgroundColor`), 'returning does not replay a draft transition');
  console.log('PASS native panel ready, work, revision, copy race, undo/redo, cancellation, detail and error; reduced motion and visibility settle immediately');
  // Two real browser windows have independent panels and source handoffs.
  await worker.evaluate(()=>{chrome.sidePanel.open=realPanelOpen;});
  const secondWindowPage=ctx.waitForEvent('page');
  const secondWindow=await worker.evaluate(url=>chrome.windows.create({url}),`${base}/launcher.html`);
  const secondLauncher=await secondWindowPage;await secondLauncher.waitForLoadState();
  const panel2=await panelIn(secondLauncher);
  assert.notEqual(panel2.windowId,panel.windowId);
  await worker.evaluate(()=>{chrome.sidePanel.open=async options=>{panelOpens.push(options);};});
  await secondLauncher.goto('https://x.com/home');
  const secondTab=await worker.evaluate(async id=>(await chrome.tabs.query({windowId:id}))[0].id,secondWindow.id);
  await worker.evaluate(async id=>chrome.scripting.executeScript({target:{tabId:id},files:['reply-target.js']}),secondTab);
  await secondLauncher.locator('#first [data-testid="tweetText"]').evaluate(el=>{el.textContent='Only the second browser window.';});
  await secondLauncher.locator('#first [data-testid="tweetText"]').dispatchEvent('contextmenu');await choose(secondTab);
  await panel2.wait(`document.querySelector('#post').value==='Only the second browser window.'`);
  assert.equal(await panel.evaluate(`document.querySelector('#post').value`),'A second independently selected post.');
  assert.equal(await panel.evaluate(`document.querySelector('.reply-incoming').hidden`),true);
  // Expired sources are consumed without replacing current work; replay gets nothing.
  await worker.evaluate(async id=>chrome.storage.session.set({['xck:reply-panel:'+id]:{source:{text:'Expired source'},at:Date.now()-60001}}),panel2.windowId);
  await secondLauncher.waitForTimeout(100);
  assert.equal(await panel2.evaluate(`document.querySelector('#post').value`),'Only the second browser window.');
  assert.equal(await panel2.evaluate(`document.querySelector('.reply-incoming').hidden`),true,'expired capture must not offer replacement');
  assert.equal(await panel2.evaluate(`(async()=> (await chrome.runtime.sendMessage({type:'xck:reply:panel-get',windowId:(await chrome.windows.getCurrent()).id})).ok)()`),false);
  // No real credential or network: connect a synthetic model response in the native
  // panel, then close it through Chrome. A retained document must forget its key.
  await panel2.evaluate(`
    window.fetch=async()=>new Response('{}',{status:200});
    chrome.permissions.request=async()=>true;
    const provider=document.querySelector('#provider');provider.value='gemini';provider.dispatchEvent(new Event('change'));
    document.querySelector('#gemini-key').value='synthetic-key-for-panel-lifetime';
    const consent=document.querySelector('#cloud-consent');consent.checked=true;consent.dispatchEvent(new Event('change'));
    Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Connect Gemini').click();
  `);
  await panel2.wait(`document.querySelector('#reply-status').textContent.startsWith('Gemini connected')`);
  await secondLauncher.locator('#first [data-testid="tweetText"]').evaluate(el=>{el.textContent='Next post, same Gemini connection.';});
  await secondLauncher.locator('#first [data-testid="tweetText"]').dispatchEvent('contextmenu');await choose(secondTab);
  await panel2.wait(`!document.querySelector('.reply-incoming').hidden`);
  await panel2.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Use this post').click()`);
  assert.equal(await panel2.evaluate(`document.querySelector('#post').value`),'Next post, same Gemini connection.');
  assert.equal(await panel2.evaluate(`document.querySelector('#draft-reply').disabled`),false,'connection survives explicit post replacement');
  // Observe the panel while its document is alive. Chrome can detach its CDP
  // session before removing the target from getTargets() during native close.
  // Only a boolean test result crosses to the surviving extension tab.
  const closeResultKey = 'test:reply-panel-close:' + panel2.targetId;
  await panel2.evaluate(`document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      const cleared = document.querySelector('#draft-reply').disabled
        && !document.querySelector('#cloud-consent').checked
        && document.querySelector('#gemini-key').value === ''
        && document.querySelector('#reply-status').textContent.includes('panel was hidden');
      localStorage.setItem(${JSON.stringify(closeResultKey)}, String(cleared));
    }
  })`);
  await worker.evaluate(id=>chrome.sidePanel.close({windowId:id}),secondWindow.id);
  let closedSafely = false;
  for (let n = 0; n < 100; n++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const result = await editor.evaluate(key => localStorage.getItem(key), closeResultKey);
    assert.notEqual(result, 'false', 'a hidden panel must clear the Gemini connection');
    if (result === 'true' || !targetInfos.some(t => t.targetId === panel2.targetId)) {
      closedSafely = true;
      break;
    }
    await editor.waitForTimeout(30);
  }
  assert(closedSafely, 'native close must destroy the panel or clear its Gemini connection');
  await editor.evaluate(key => localStorage.removeItem(key), closeResultKey);
  console.log('PASS native panel close clears or destroys connected editor; replacement retains connection');
  await worker.evaluate(id=>chrome.windows.remove(id),secondWindow.id);
  // A lookalike extension tab cannot claim a pending panel capture.
  const impostorPage=ctx.waitForEvent('page');
  const thirdWindow=await worker.evaluate(url=>chrome.windows.create({url}),`${base}/reply.html?panel`);
  const impostor=await impostorPage;await impostor.waitForLoadState();
  const panelKey=`xck:reply-panel:${thirdWindow.id}`;
  // Real window, no panel. Removing sender.tab would now allow this claim.
  await worker.evaluate(async key=>chrome.storage.session.set({[key]:{source:{text:'Window-bound',author:'Synthetic',url:'https://x.com/a/status/1'},at:Date.now()}}),panelKey);
  assert.equal((await impostor.evaluate(windowId=>chrome.runtime.sendMessage({type:'xck:reply:panel-get',windowId}),thirdWindow.id)).ok,false);
  assert((await worker.evaluate(async key=>(await chrome.storage.session.get(key))[key],panelKey)), 'denied tab leaves handoff untouched');
  await worker.evaluate(async key=>chrome.storage.session.remove(key),panelKey);
  await worker.evaluate(id=>chrome.windows.remove(id),thirdWindow.id);await launcher.close();
  await worker.evaluate(()=>{chrome.sidePanel.open=realPanelOpen;});

  // Host access is pregranted by this headless harness. Simulate revocation at
  // Chrome's permission boundary, then exercise the real listener/reconciler.
  await worker.evaluate(() => {
    globalThis.originalContains = chrome.permissions.contains;
    globalThis.originalSend = chrome.tabs.sendMessage;
    globalThis.disabledTabs = [];
    chrome.permissions.contains = async () => false;
    chrome.tabs.sendMessage = async (id, message, ...rest) => {
      const result = await originalSend(id, message, ...rest);
      if (message.type === 'xck:reply:disable') disabledTabs.push(id);
      return result;
    };
    chrome.permissions.onRemoved.dispatch({ origins: ['https://x.com/*'] });
  });
  await editor.waitForFunction(async () => !(await chrome.scripting.getRegisteredContentScripts()).some(s => s.id === 'xck-reply-target'));
  // Wait for the notification rather than assuming unregister also cleared the target.
  for (let attempt = 0; attempt < 100 && !await worker.evaluate(id => disabledTabs.includes(id), tabId); attempt++) await editor.waitForTimeout(20);
  assert(await worker.evaluate(id => disabledTabs.includes(id), tabId));
  await x.locator('#first [data-testid="tweetText"]').dispatchEvent('contextmenu');
  assert.equal((await collect()).ok, false, 'permission removal stops collection on already-open X tabs');
  await worker.evaluate(() => {
    chrome.permissions.contains = originalContains;
    chrome.permissions.onAdded.dispatch({ origins: ['https://x.com/*'] });
  });
  await editor.waitForFunction(async () => (await chrome.scripting.getRegisteredContentScripts()).some(s => s.id === 'xck-reply-target'));

  const setupRace=await ctx.newPage();await setupRace.goto(`${base}/reply.html`);
  await setupRace.evaluate(()=>{fakeInitializeDelay=500;});
  await setupRace.getByRole('button',{name:'Initialize model',exact:true}).click();
  await setupRace.getByRole('button',{name:'Edit my voice',exact:true}).click();
  await setupRace.getByText('Model ready.',{exact:true}).waitFor();
  assert(await setupRace.getByRole('button',{name:'Finish later',exact:true}).isVisible(),'model readiness must not hide an open voice interview');
  await setupRace.getByRole('button',{name:'Finish later',exact:true}).click();await setupRace.close();
  // Approved workflow replaces two simultaneous drafts and angle/language forms:
  // one draft with Undo; ten saved voice steps; explicit personal-fact answers.
  const openSettings=async page=>{if(!await page.locator('.reply-setup').evaluate(el=>el.open))await page.locator('.reply-setup > summary').click();};
  await editor.locator('#post').fill('I shipped a small update today and asked three people for feedback.');
  await editor.getByRole('button',{name:'Edit my voice',exact:true}).click();
  await editor.getByLabel('Tech',{exact:true}).check();
  assert(await editor.locator('#profile-topic').isHidden(), 'custom topics stay behind an optional disclosure');
  await editor.getByText('Add another topic', { exact: true }).click();
  assert(await editor.locator('#profile-topic').isVisible());
  await editor.getByRole('button',{name:'Continue',exact:true}).click();
  assert(await editor.locator('#profile-audience').isHidden(), 'preset audiences require no typing');
  await editor.getByRole('button',{name:'Builders',exact:true}).click();
  assert.equal(await editor.getByRole('button',{name:'Builders',exact:true}).getAttribute('aria-pressed'),'true');
  await editor.getByText('Write my own', { exact: true }).click();
  await editor.locator('#profile-audience').fill('Gardeners');
  assert.equal(await editor.getByRole('button',{name:'Builders',exact:true}).getAttribute('aria-pressed'),'false');
  await editor.getByRole('button',{name:'Finish later',exact:true}).click();
  await editor.waitForFunction(async()=> (await chrome.storage.local.get('xck:reply-profile-draft'))['xck:reply-profile-draft']?.value.background.audience==='Gardeners');
  await editor.getByRole('button',{name:'Edit my voice',exact:true}).click();
  await editor.getByRole('heading',{name:'Who do you reply to?',exact:true}).waitFor();
  assert(await editor.locator('#profile-audience').isVisible(), 'saved custom audience reopens its input');
  assert.equal(await editor.locator('#profile-audience').inputValue(),'Gardeners');
  await editor.getByRole('button',{name:'Builders',exact:true}).click();
  assert(await editor.locator('#profile-audience').isHidden());
  await editor.getByRole('button',{name:'Continue',exact:true}).click();
  await editor.getByRole('radio',{name:'Small releases make feedback easier to use.',exact:true}).check();
  await editor.getByRole('button',{name:'Back',exact:true}).click();
  assert.equal(await editor.locator('#profile-audience').inputValue(),'Builders');
  await editor.getByRole('button',{name:'Continue',exact:true}).click();
  await editor.waitForFunction(async()=> (await chrome.storage.local.get('xck:reply-profile-draft'))['xck:reply-profile-draft']?.step===2);
  await editor.reload();
  await editor.getByRole('button',{name:'Edit my voice',exact:true}).click();
  await editor.getByRole('heading',{name:'Which sounds like you?',exact:true}).waitFor();
  assert.equal(await editor.locator('#voice-question').textContent(),'Which sounds like you?');
  assert(await editor.getByRole('radio',{name:'Small releases make feedback easier to use.',exact:true}).isChecked());
  await editor.getByRole('button',{name:'Continue',exact:true}).click();
  await editor.getByRole('radio',{name:'Which bit ate your weekend?',exact:true}).check();
  await editor.getByRole('button',{name:'Continue',exact:true}).click();
  await editor.getByRole('radio',{name:/Direct counterpoint/}).check();
  await editor.getByRole('button',{name:'Continue',exact:true}).click();
  await editor.getByRole('radio',{name:/Dry ·/}).check();
  await editor.getByRole('button',{name:'Continue',exact:true}).click();
  await editor.locator('#profile-casing').selectOption('lowercase');
  await editor.locator('#profile-length').selectOption('short');
  await editor.getByRole('button',{name:'Continue',exact:true}).click();
  await editor.getByRole('button',{name:'Great insight',exact:true}).click();
  await editor.getByRole('button',{name:'Continue',exact:true}).click();
  await editor.locator('#profile-example-0').fill('small changes. clearer feedback.');
  await editor.getByRole('button',{name:'Continue',exact:true}).click();
  await editor.locator('#profile-calibration').fill('small releases, clearer feedback.');
  await editor.waitForFunction(async()=> (await chrome.storage.local.get('xck:reply-profile-draft'))['xck:reply-profile-draft']?.value.preferences.calibration==='small releases, clearer feedback.');
  await editor.evaluate(()=>{globalThis.restoreStorageSet=chrome.storage.local.set;chrome.storage.local.set=async()=>{throw new Error('synthetic storage failure');};});
  await editor.getByRole('button',{name:'Save my voice',exact:true}).click();
  await editor.getByText('Profile could not be saved.',{exact:false}).waitFor();
  assert(await editor.locator('#profile-calibration').isVisible());
  await editor.evaluate(()=>{chrome.storage.local.set=restoreStorageSet;});
  await editor.getByRole('button',{name:'Save my voice',exact:true}).click();
  await editor.getByText('Your voice is saved.',{exact:true}).waitFor();
  assert.equal(await editor.evaluate(async()=> (await chrome.storage.local.get('xck:reply-profile-draft'))['xck:reply-profile-draft']),undefined);
  const downloaded=editor.waitForEvent('download');await editor.getByRole('button',{name:'Download voice.md',exact:true}).click();
  const file=await downloaded;assert.equal(file.suggestedFilename(),'voice.md');
  const voiceFile=readFileSync(await file.path(),'utf8');assert(voiceFile.includes('small releases, clearer feedback.'));assert(!voiceFile.includes('Gemini'));
  await editor.locator('#post').fill('I shipped a small update today and asked three people for feedback.');
  await editor.evaluate(()=>{fakeMode='error';});
  await editor.getByRole('button',{name:'Initialize model',exact:true}).click();
  await editor.getByText('Model initialization failed.',{exact:false}).waitFor();
  await editor.evaluate(()=>{fakeMode='downloadable';});
  await editor.getByRole('button',{name:'Initialize model',exact:true}).click();
  await editor.getByText('Downloading Chrome model · 50%').waitFor();
  await editor.getByRole('button',{name:'Cancel',exact:true}).click();
  await editor.waitForTimeout(250);
  await editor.getByRole('button',{name:'Initialize model',exact:true}).click();
  await editor.getByText('Model ready.',{exact:true}).waitFor();
  await editor.getByRole('button',{name:'Draft reply',exact:true}).click();
  await editor.getByText('Reply ready.',{exact:true}).waitFor();
  assert.equal(await editor.locator('#draft-1').count(),0);
  assert.equal(await editor.locator('#draft-0').inputValue(),'Which feedback changed your next release?');
  const input=JSON.parse(await editor.evaluate(()=>lastPrompt));
  assert.equal(input.styleRules.voice,'direct');assert.deepEqual(input.interests,['Tech']);
  assert.equal(input.voicePreferences.disagreement,'direct counterpoint');assert.equal(input.voicePreferences.personality,'dry');
  assert.equal(input.voicePreferences.comparison,'Which bit ate your weekend?');assert.equal(input.voicePreferences.calibration,'small releases, clearer feedback.');
  assert.equal(input.audience,'Builders');assert.equal(input.explicitBackground,undefined);
  await editor.locator('#draft-0').fill('My carefully edited words.');
  await editor.getByRole('button',{name:'Copy',exact:true}).click();
  await editor.getByRole('button',{name:'Copied',exact:true}).waitFor();assert.equal(await editor.evaluate(()=>copied),'My carefully edited words.');
  await editor.evaluate(()=>{copyFails=true;});
  await editor.getByRole('button',{name:'Copied',exact:true}).click();await editor.getByText('Copy failed.',{exact:false}).waitFor();
  await editor.getByRole('button',{name:'Shorter',exact:true}).click();await editor.getByText('Reply ready.',{exact:true}).waitFor();
  assert.equal(JSON.parse(await editor.evaluate(()=>lastPrompt)).currentDraft,'My carefully edited words.');
  await editor.locator('#draft-0').fill('My edited replacement.');
  await editor.getByRole('button',{name:'Undo',exact:true}).click();assert.equal(await editor.locator('#draft-0').inputValue(),'My carefully edited words.');
  await editor.getByRole('button',{name:'Redo',exact:true}).click();assert.equal(await editor.locator('#draft-0').inputValue(),'My edited replacement.');
  await editor.locator('#draft-0').fill('');await editor.getByRole('button',{name:'Undo',exact:true}).click();assert.equal(await editor.locator('#draft-0').inputValue(),'My carefully edited words.');
  await editor.evaluate(()=>{fakeDelay=400;});
  await editor.getByRole('button',{name:'Try another',exact:true}).click();assert(await editor.getByRole('button',{name:'Try another',exact:true}).isDisabled());
  await editor.locator('#draft-0').fill('Keep this edit through late completion.');await editor.waitForTimeout(500);
  assert.equal(await editor.locator('#draft-0').inputValue(),'Keep this edit through late completion.');
  await editor.getByRole('button',{name:'Try another',exact:true}).click();await editor.getByRole('button',{name:'Cancel',exact:true}).click();await editor.waitForTimeout(500);
  assert.equal(await editor.locator('#draft-0').inputValue(),'Keep this edit through late completion.');
  // Fast personal question, no model call; remembered answers require confirmation.
  await editor.evaluate(()=>{fakeDelay=10;lastPrompt='untouched';});
  await editor.locator('#post').fill('Which keyboard shortcut do you use most?');
  await editor.getByRole('button',{name:'Try another',exact:true}).click();
  assert.equal(await editor.evaluate(()=>lastPrompt),'untouched');
  assert.equal(await editor.locator('#needs-detail').textContent(),'Which keyboard shortcut do you use most?');
  await editor.getByRole('button',{name:'Skip for now',exact:true}).click();
  await editor.locator('#post').fill('What are you building?');
  await editor.getByRole('button',{name:'Try another',exact:true}).click();
  assert.equal(await editor.evaluate(()=>lastPrompt),'untouched');
  assert.equal(await editor.locator('#personal-answer').evaluate(el=>el===document.activeElement),true);
  assert.equal(await editor.locator('#personal-answer').getAttribute('aria-describedby'),'needs-detail');
  assert.equal(await editor.locator('#reply-status').textContent(), '', 'the personal question is shown once and described by the focused answer');
  await editor.locator('#personal-answer').fill('A tiny calendar for gardeners.');
  await editor.locator('#remember-answer').check();
  await editor.getByRole('button',{name:'Use answer & draft',exact:true}).click();await editor.getByText('Reply ready.',{exact:true}).waitFor();
  assert.equal(JSON.parse(await editor.evaluate(()=>lastPrompt)).confirmedAnswers[0].answer,'A tiny calendar for gardeners.');
  const remembered=await editor.evaluate(async()=> (await chrome.storage.local.get('xck:reply-facts'))['xck:reply-facts']);assert.equal(remembered.length,1);
  await editor.locator('#post').fill('What are you working on this week?');await editor.getByRole('button',{name:'Try another',exact:true}).click();
  assert(await editor.getByText('Still accurate?',{exact:true}).isVisible());assert.equal(await editor.locator('#personal-answer').inputValue(),'');
  await editor.getByRole('button',{name:'Something else',exact:true}).click();await editor.locator('#personal-answer').fill('A public reading list.');
  await editor.getByRole('button',{name:'Use answer & draft',exact:true}).click();await editor.getByText('Reply ready.',{exact:true}).waitFor();
  assert.equal((await editor.evaluate(async()=> (await chrome.storage.local.get('xck:reply-facts'))['xck:reply-facts']))[0].answer,'A tiny calendar for gardeners.','unchecked answer stays temporary');
  const replacementPrompt=await editor.evaluate(()=>lastPrompt);
  assert.equal(JSON.parse(replacementPrompt).confirmedAnswers[0].answer,'A public reading list.');assert(!replacementPrompt.includes('gardeners'));
  await editor.locator('#post').fill('A normal post about shipping.');await editor.getByRole('button',{name:'Try another',exact:true}).click();await editor.getByText('Reply ready.',{exact:true}).waitFor();
  assert.deepEqual(JSON.parse(await editor.evaluate(()=>lastPrompt)).confirmedAnswers,[]);assert(!(await editor.evaluate(()=>lastPrompt)).includes('gardeners'));
  await editor.locator('#post').fill('What are you building?');await editor.getByRole('button',{name:'Try another',exact:true}).click();
  await editor.getByRole('button',{name:'Use this answer',exact:true}).click();
  assert.equal(await editor.locator('#personal-answer').inputValue(),'A tiny calendar for gardeners.');
  await editor.getByRole('button',{name:'Use answer & draft',exact:true}).click();await editor.getByText('Reply ready.',{exact:true}).waitFor();
  assert.equal(JSON.parse(await editor.evaluate(()=>lastPrompt)).confirmedAnswers[0].answer,'A tiny calendar for gardeners.');
  // Multiple personal questions retain earlier confirmed facts for this post.
  await editor.locator('#post').fill('What are you building and how many users do you have?');
  await editor.getByRole('button',{name:'Try another',exact:true}).click();await editor.locator('#personal-answer').fill('A bookmark tool.');
  await editor.evaluate(()=>{fakeResponse=JSON.stringify({needsDetail:'How many users does it have?',factKey:'other'});});
  await editor.getByRole('button',{name:'Use answer & draft',exact:true}).click();await editor.getByText('How many users does it have?',{exact:true}).last().waitFor();
  await editor.locator('#personal-answer').fill('42 users.');
  await editor.evaluate(()=>{fakeResponse=JSON.stringify({drafts:['A bookmark tool, with 42 users so far.']});});
  await editor.getByRole('button',{name:'Use answer & draft',exact:true}).click();await editor.getByText('Reply ready.',{exact:true}).waitFor();
  assert.deepEqual(JSON.parse(await editor.evaluate(()=>lastPrompt)).confirmedAnswers.map(a=>a.answer),['A bookmark tool.','42 users.']);
  // Other personal gaps are model questions, never silently populated from memory.
  await editor.locator('#post').fill('First-launch stories welcome.');
  await editor.evaluate(()=>{fakeResponse=JSON.stringify({needsDetail:'What happened at your first launch?',factKey:'other'});});
  await editor.getByRole('button',{name:'Try another',exact:true}).click();await editor.locator('.reply-question').waitFor();
  assert.equal(await editor.locator('#needs-detail').textContent(),'What happened at your first launch?');
  for (const target of ['#draft-0', '#post']) {
    await editor.getByRole('button', { name: 'Skip for now' }).click();
    await editor.evaluate(() => { globalThis.holdModelReply = new Promise(resolve => { globalThis.releaseReply = resolve; }); });
    await editor.getByRole('button', { name: 'Try another', exact: true }).click();
    await editor.locator(target).focus();
    await editor.evaluate(() => globalThis.releaseReply());
    await editor.locator('.reply-question').waitFor();
    const shouldMove = target === '#draft-0';
    assert.equal(await editor.evaluate(() => document.activeElement.id), shouldMove ? 'personal-answer' : 'post');
    assert.equal(await editor.locator('#reply-status').textContent(), shouldMove ? '' : 'What happened at your first launch?');
  }
  const beforeSkip=await editor.evaluate(()=>lastPrompt);await editor.getByRole('button',{name:'Skip for now',exact:true}).click();assert(await editor.locator('.reply-question').isHidden());assert.equal(await editor.evaluate(()=>lastPrompt),beforeSkip);
  await editor.evaluate(()=>{fakeMode='error';fakeResponse=undefined;});
  await editor.getByRole('button',{name:'Try another',exact:true}).click();await editor.getByText('Generation failed',{exact:false}).waitFor();
  const local=await editor.evaluate(async()=>chrome.storage.local.get(null));assert(!JSON.stringify(local).includes('carefully edited'));
  assert(!JSON.stringify(local).includes('A public reading list.'));
  const second=await ctx.newPage();await fake(second);await second.goto(`${base}/reply.html`);
  await second.evaluate(()=>{LanguageModel.availability=async()=> 'unavailable';});
  await second.getByText('Capture & privacy settings',{exact:true}).click();await worker.evaluate(()=>{disabledTabs=[];});
  await second.getByRole('button',{name:'Disable reply drafting',exact:true}).click();
  await editor.getByText('Reply drafting was disabled. This editor’s temporary text was cleared.',{exact:true}).waitFor();
  assert.equal(await editor.locator('#post').inputValue(),'');assert.equal(await editor.locator('#draft-0').inputValue(),'');
  await editor.waitForFunction(async()=>!(await chrome.scripting.getRegisteredContentScripts()).some(s=>s.id==='xck-reply-target'));
  for(let attempt=0;attempt<100&&!await worker.evaluate(id=>disabledTabs.includes(id),tabId);attempt++)await editor.waitForTimeout(20);
  assert(await worker.evaluate(id=>disabledTabs.includes(id),tabId));await worker.evaluate(()=>{chrome.tabs.sendMessage=originalSend;});
  await x.locator('#first [data-testid="tweetText"]').dispatchEvent('contextmenu');assert.equal((await collect()).ok,false);
  await second.getByRole('button',{name:'Enable reply drafting',exact:true}).click();await second.getByText('On-device AI is unavailable',{exact:false}).waitFor();
  assert(await second.getByRole('button',{name:'Draft reply',exact:true}).isDisabled());
  await editor.goto(`${base}/reply.html?panel`);
  await editor.locator('#post').fill('I shipped a small update today.');
  await editor.getByRole('button',{name:'Initialize model',exact:true}).click();await editor.getByText('Model ready.',{exact:true}).waitFor();
  await editor.getByRole('button',{name:'Draft reply',exact:true}).click();await editor.getByText('Reply ready.',{exact:true}).waitFor();
  mkdirSync('verification',{recursive:true});
  for(const width of [320,390,768]){
    await editor.setViewportSize({width,height:900});assert(await editor.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.equal(await editor.locator('.xck-shell').count(),0);assert.equal(await editor.locator('.reply-setup').evaluate(el=>el.open),false);
    assert(await editor.locator('.reply-results').evaluate(el=>el.getBoundingClientRect().bottom<800),'everyday reply fits a compact panel');
    await editor.screenshot({path:`verification/reply-editor-${width}.png`,fullPage:true});
  }
  await openSettings(editor);await editor.getByRole('button',{name:'Edit my voice',exact:true}).click();
  await editor.getByRole('heading',{name:'What do you talk about?',exact:true}).waitFor();
  for(let step=0;step<10;step++){
    for(const width of [320,390]) {await editor.setViewportSize({width,height:900});assert(await editor.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
    assert.equal(await editor.locator('.reply-profile > section:visible').count(),1);
    if(step<9)await editor.getByRole('button',{name:'Continue',exact:true}).click();
  }
  await editor.screenshot({path:'verification/reply-voice-390.png',fullPage:true});
  await editor.getByRole('button',{name:'Finish later',exact:true}).click();
  assert.equal(await editor.getByRole('button',{name:'Edit my voice',exact:true}).evaluate(el=>el===document.activeElement),true);
  await editor.getByRole('button',{name:'Edit my voice',exact:true}).click();
  for(let n=0;n<7;n++)await editor.getByRole('button',{name:'Back',exact:true}).click();
  await editor.getByRole('radio',{name:'Small releases. Bite-size feedback. Much less chaos.',exact:true}).check();
  const voicePeer=await ctx.newPage();await voicePeer.goto(`${base}/reply.html`);
  await voicePeer.getByRole('button',{name:'Edit my voice',exact:true}).click();
  await voicePeer.getByText('Your voice is being edited in another panel.',{exact:false}).waitFor();
  assert(await editor.getByRole('radio',{name:'Small releases. Bite-size feedback. Much less chaos.',exact:true}).isChecked());await voicePeer.close();
  await editor.getByRole('button',{name:'Finish later',exact:true}).click();await editor.locator('.reply-setup > summary').click();
  await editor.getByRole('button',{name:'Try another',exact:true}).click();await editor.getByText('Reply ready.',{exact:true}).waitFor();
  assert.equal(JSON.parse(await editor.evaluate(()=>lastPrompt)).styleRules.voice,'direct','unfinished playful answer must not reach the model');
  await openSettings(editor);
  // Cross-editor deletion and update reach the active model profile.
  const peer=await ctx.newPage();await peer.goto(`${base}/reply.html`);
  await peer.locator('#post').fill('Small releases.');await peer.getByRole('button',{name:'Initialize model',exact:true}).click();await peer.getByText('Model ready.',{exact:true}).waitFor();
  await peer.getByRole('button',{name:'Draft reply',exact:true}).click();await peer.getByText('Reply ready.',{exact:true}).waitFor();
  assert.equal(JSON.parse(await peer.evaluate(()=>lastPrompt)).styleRules.voice,'direct');
  await editor.getByRole('button',{name:'Edit my voice',exact:true}).click();await editor.getByRole('button',{name:'Delete writing profile',exact:true}).click();await editor.getByText('Writing profile deleted.',{exact:true}).waitFor();
  await peer.getByRole('button',{name:'Try another',exact:true}).click();await peer.getByText('Reply ready.',{exact:true}).waitFor();assert.equal(JSON.parse(await peer.evaluate(()=>lastPrompt)).styleRules.voice,'conversational');
  await editor.evaluate(async()=>chrome.storage.local.set({'xck:reply-profile':{interests:['Tech'],style:{voice:'playful',length:'short',emojis:'none',avoid:''},background:{work:'not sent automatically',audience:''},examples:[]}}));
  await peer.waitForFunction(()=>document.querySelector('#profile-voice input[value="playful"]').checked);
  await peer.getByRole('button',{name:'Try another',exact:true}).click();await peer.getByText('Reply ready.',{exact:true}).waitFor();assert.equal(JSON.parse(await peer.evaluate(()=>lastPrompt)).styleRules.voice,'playful');
  assert(!(await peer.evaluate(()=>lastPrompt)).includes('not sent automatically'));
  await peer.close();
  await editor.locator('.reply-facts > summary').click();await editor.getByRole('button',{name:/Forget What are you working on/}).click();
  await editor.getByText('Remembered answer removed.',{exact:true}).waitFor();
  assert.deepEqual(await editor.evaluate(async()=> (await chrome.storage.local.get('xck:reply-facts'))['xck:reply-facts']),[]);
  const memoryPeers=await Promise.all([ctx.newPage(),ctx.newPage()]);
  await Promise.all(memoryPeers.map(async(p,i)=>{
    await p.goto(`${base}/reply.html`);await p.getByRole('button',{name:'Initialize model',exact:true}).click();await p.getByText('Model ready.',{exact:true}).waitFor();
    await p.locator('#post').fill(i?'What do you do for work?':'What are you building?');await p.getByRole('button',{name:'Draft reply',exact:true}).click();
    await p.locator('#personal-answer').fill(i?'An illustrator.':'A tiny drawing tool.');await p.locator('#remember-answer').check();
  }));
  await Promise.all(memoryPeers.map(p=>p.getByRole('button',{name:'Use answer & draft',exact:true}).click()));
  await Promise.all(memoryPeers.map(p=>p.getByText('Reply ready.',{exact:true}).waitFor()));
  const concurrentFacts=await editor.evaluate(async()=> (await chrome.storage.local.get('xck:reply-facts'))['xck:reply-facts']);
  assert.deepEqual(concurrentFacts.map(f=>f.answer).sort(),['A tiny drawing tool.','An illustrator.'].sort());
  await Promise.all(memoryPeers.map(p=>p.close()));
  assert.deepEqual(requests,[]);
  // Real fetch under the built CSP, fulfilled locally: no provider traffic or real key.
  const cloudCalls = [];
  let cloudStatus = 200, cloudDelay = 0;
  await ctx.route('https://generativelanguage.googleapis.com/**', async route => {
    cloudCalls.push({ url: route.request().url(), headers: route.request().headers(), body: route.request().postData() });
    if (cloudDelay) await new Promise(r => setTimeout(r, cloudDelay));
    await route.fulfill({ status: cloudStatus, contentType: 'application/json', body: cloudStatus === 200 ? JSON.stringify(route.request().method() === 'GET' ? { name: 'models/gemini-3.5-flash-lite' } : { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ drafts: ['Which change helped most?'] }) }] } }] }) : 'provider error containing synthetic-key-for-local-tests' }).catch(() => {});
  });
  const cloud = await ctx.newPage(); await cloud.goto(`${base}/reply.html`);
  assert.equal(await cloud.locator('#provider').inputValue(), 'local');
  await cloud.locator('#provider').selectOption('gemini');
  assert.equal(cloudCalls.length, 0);
  assert(await cloud.getByRole('button', { name: 'Forget key', exact: true }).isHidden());
  assert(await cloud.getByRole('button', { name: 'Connect Gemini', exact: true }).isDisabled());
  const paidProject = cloud.getByRole('checkbox', { name: /paid-tier project with data sharing off/ });
  await cloud.locator('#gemini-key').fill('synthetic-key-before-edit');
  await paidProject.check();
  await cloud.locator('#gemini-key').fill('synthetic-key-for-local-tests');
  assert.equal(await paidProject.isChecked(), false);
  assert(await cloud.getByRole('button', { name: 'Connect Gemini', exact: true }).isDisabled());
  assert.equal(cloudCalls.length, 0);
  await paidProject.check();
  await cloud.evaluate(() => { globalThis.grantCloud = false; chrome.permissions.request = async () => grantCloud; });
  await cloud.getByRole('button', { name: 'Connect Gemini', exact: true }).click();
  await cloud.getByText('Gemini access declined.', { exact: false }).waitFor();
  assert.equal(cloudCalls.length, 0, 'permission denial must not send the key');
  cloudDelay = 500;
  await cloud.evaluate(() => { grantCloud = true; });
  await cloud.getByRole('button', { name: 'Connect Gemini', exact: true }).click();
  await cloud.locator('#post').fill('Pasting a post while Connect is pending.');
  await cloud.getByRole('button',{name:'Edit my voice',exact:true}).click();
  await cloud.getByText('Gemini connected.', { exact: false }).waitFor();
  assert(await cloud.getByRole('button',{name:'Finish later',exact:true}).isVisible());
  await cloud.getByRole('button',{name:'Finish later',exact:true}).click();
  assert(await cloud.getByRole('button', { name: 'Connect Gemini', exact: true }).isHidden());
  assert(await cloud.getByRole('button', { name: 'Forget key', exact: true }).isVisible());
  await cloud.locator('.reply-setup > summary').click();
  cloudDelay = 0;
  assert.equal(cloudCalls.length, 1); assert.equal(cloudCalls[0].body, null);
  assert.equal(cloudCalls[0].headers['x-goog-api-key'], 'synthetic-key-for-local-tests');
  assert.equal(await cloud.locator('#gemini-key').inputValue(), '');
  const storage = await cloud.evaluate(async () => JSON.stringify([await chrome.storage.local.get(null), await chrome.storage.session.get(null), await chrome.storage.sync.get(null)]));
  assert(!storage.includes('synthetic-key'));
  const joke = 'Finally fixed the office printer.\nIt only prints its own error logs 😭';
  await cloud.locator('#post').fill(joke);
  await cloud.getByRole('button', { name: 'Draft reply', exact: true }).click();
  await cloud.getByText('Reply ready.', { exact: false }).waitFor();
  assert.equal(await cloud.locator('#draft-0').inputValue(), 'Which change helped most?');
  const sent = JSON.parse(JSON.parse(cloudCalls[1].body).contents[0].parts[0].text);
  assert.deepEqual(sent.sourceData, { post: joke }, 'preserve the setup and punchline in the same request');
  assert.match(JSON.parse(cloudCalls[1].body).systemInstruction.parts[0].text, /sarcasm/i);
  assert(!cloudCalls[1].body.includes('synthetic-key'));
  await cloud.locator('#draft-0').fill('My own words.');
  await cloud.getByRole('button',{name:'Shorter',exact:true}).click();
  await cloud.getByText('Reply ready.',{exact:true}).waitFor();
  assert.equal(JSON.parse(JSON.parse(cloudCalls[2].body).contents[0].parts[0].text).currentDraft,'My own words.');
  await cloud.getByRole('button',{name:'Undo',exact:true}).click();assert.equal(await cloud.locator('#draft-0').inputValue(),'My own words.');
  cloudStatus = 429;
  await cloud.getByRole('button', { name: 'Try another', exact: true }).click();
  await cloud.getByText('Gemini quota or rate limit reached.', { exact: false }).waitFor();
  assert(!(await cloud.locator('#reply-status').innerText()).includes('synthetic-key'));
  const count = cloudCalls.length; await cloud.waitForTimeout(150); assert.equal(cloudCalls.length, count);
  cloudStatus = 200; cloudDelay = 200;
  await cloud.getByRole('button', { name: 'Try another', exact: true }).click();
  await cloud.locator('#draft-0').fill('Keep this edit during the request.');
  await cloud.waitForTimeout(300); assert.equal(await cloud.locator('#draft-0').inputValue(), 'Keep this edit during the request.');
  await cloud.getByRole('button', { name: 'Shorter', exact: true }).click();
  await cloud.locator('.reply-setup > summary').click();
  await cloud.getByRole('button', { name: 'Forget key', exact: true }).click();
  await cloud.waitForTimeout(300);
  assert(await cloud.getByRole('button', { name: 'Try another', exact: true }).isDisabled());
  assert.equal(await cloud.locator('#draft-0').inputValue(), 'Keep this edit during the request.');
  assert.equal(await cloud.locator('#cloud-consent').isChecked(), false);
  async function reconnectCloud() {
    await cloud.locator('#gemini-key').fill('synthetic-key-for-local-tests');
    await cloud.locator('#cloud-consent').check();
    await cloud.getByRole('button', { name: 'Connect Gemini', exact: true }).click();
    await cloud.getByText('Gemini connected.', { exact: false }).waitFor();
  }
  await reconnectCloud();
  await cloud.getByRole('button', { name: 'Shorter', exact: true }).click();
  await cloud.locator('.reply-setup > summary').click();
  await cloud.locator('#provider').selectOption('local');
  await cloud.waitForTimeout(300);
  assert.equal(await cloud.locator('#draft-0').inputValue(), 'Keep this edit during the request.');
  await cloud.locator('#provider').selectOption('gemini');
  assert.equal(await cloud.locator('#gemini-key').inputValue(), '');
  assert(await cloud.getByRole('button', { name: 'Try another', exact: true }).isDisabled());
  await reconnectCloud();
  await cloud.getByRole('button', { name: 'Shorter', exact: true }).click();
  // Native permission UI is a manual gate; dispatch the real listener in this harness.
  await cloud.evaluate(() => chrome.permissions.onRemoved.dispatch({ origins: ['https://generativelanguage.googleapis.com/*'] }));
  await cloud.getByText('Gemini access removed.', { exact: false }).waitFor();
  await cloud.waitForTimeout(300);
  assert.equal(await cloud.locator('#draft-0').inputValue(), 'Keep this edit during the request.');
  assert.equal(await cloud.locator('#gemini-key').inputValue(), '');
  assert(await cloud.getByRole('button', { name: 'Try another', exact: true }).isDisabled());
  await reconnectCloud();cloudDelay=0;
  await cloud.locator('#post').fill('What are you building?');await cloud.getByRole('button',{name:'Try another',exact:true}).click();
  await cloud.locator('#personal-answer').fill('A tiny planning app.');
  await openSettings(cloud);await cloud.getByRole('button',{name:'Forget key',exact:true}).click();
  await cloud.getByRole('button',{name:'Use answer & draft',exact:true}).click();
  await cloud.getByText('Connect a model in Settings. Your answer is kept.',{exact:true}).waitFor();
  assert(await cloud.locator('.reply-question').isVisible());assert.equal(await cloud.locator('#personal-answer').inputValue(),'A tiny planning app.');
  for (const width of [320, 390, 768]) {
    await cloud.setViewportSize({ width, height: 900 });
    assert(await cloud.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await cloud.reload();
  assert.equal(await cloud.locator('#provider').inputValue(), 'local');
  await cloud.locator('#provider').selectOption('gemini');
  assert.equal(await cloud.locator('#gemini-key').inputValue(), '');
  assert(await cloud.getByRole('button', { name: 'Draft reply', exact: true }).isDisabled());
  await cloud.close();
  assert(requests.every(url => url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite')));
  console.log('PASS Gemini explicit consent, denied permission, key privacy, fixed requests, edits, quota errors, no retry, disconnect, reload and widths');
  console.log('PASS native Chrome side-panel entry, window isolation, safe source replacement, expiry, replay and lookalike-tab rejection');
  console.log('PASS reply built UI, capture isolation, profile choices, drafts, revision, edit race, cancellation, detail, copy, errors, widths and keyboard');
} finally { await ctx.close(); }

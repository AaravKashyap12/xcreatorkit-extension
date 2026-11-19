import { gemini, testKey, validKey, GEMINI_ORIGIN, CloudError } from './cloud';
import { PROFILE, PROFILE_DRAFT, writingProfile } from './profile';
import { h } from '../ui/dom';
import { FACTS, factStore, personalQuestion, type Question } from './facts';
import { mountNavigation } from '../ui/navigation';
import { reader } from '../ui/reader';
import { feedbackMotion } from '../ui/motion';
import { CONSENT, type Source, LIMITS, Operation, drafts, prompt, needsDetail } from './core';
import { availability, create, schema, type Session } from './model';
import css from './editor.css';
// Faces and colours come from static/tokens.css, which reply.html loads.
document.head.append(h('style', {}, css));
const motion = feedbackMotion();
const inPanel = new URLSearchParams(location.search).has('panel');
if (!inPanel) mountNavigation();
document.body.classList.toggle('reply-panel', inPanel);
const app = document.querySelector('#app')!;
const status = h('p', { role: 'status', 'aria-live': 'polite', id: 'reply-status' });
const consent = h('section', { class: 'reply-welcome' }, h('h2', {}, 'A little help finding the words.'),
  h('p', {}, 'Pick a post. Get a reply in your voice. Edit, copy and post it yourself.'),
  h('p', { class: 'reply-muted' }, 'Choose on-device AI or connect your Gemini key. Your voice is saved on this device. Posts, drafts and keys are temporary; closing or reloading the editor can clear them. English for now.'));
const enable = h('button', { type: 'button' }, 'Enable reply drafting');
consent.append(enable);
const revoke = h('button', { type: 'button' }, 'Disable reply drafting');
const access = h('button', { type: 'button' }, 'Allow X text capture');
const context = h('p', { id: 'source-context' }, 'Paste a post, or right-click one on X → Draft a reply to this post.');
const post = h('textarea', { id: 'post', maxlength: String(LIMITS.post), rows: '2', placeholder: 'Paste a post, or select one on X…' });
const intent = h('textarea', { id: 'intent', maxlength: String(LIMITS.intent), rows: '2', placeholder: 'Add a thought or a detail only you know…' });
intent.addEventListener('focus', () => { intent.rows = 3; });

const initialize = h('button', { type: 'button' }, 'Initialize model');
const generate = h('button', { id: 'draft-reply', type: 'button', disabled: true }, 'Draft reply');
const shorter = h('button', { type: 'button', disabled: true }, 'Shorter');
const cancel = h('button', { type: 'button' }, 'Cancel');
const workLine = h('p', { class: 'reply-work', 'aria-hidden': 'true', hidden: true });
const workInk = h('span', { class: 'reply-work-ink' });
const retry = h('button', { type: 'button', disabled: true }, 'Try another');
const undo = h('button', { type: 'button', hidden: true }, 'Undo');
let previousDraft = '';
let copyRequest = 0;
let confirmedAnswers: {question:string;answer:string}[] = [];
const memories = factStore(say, () => refreshSuggestion());
const voice = writingProfile(() => invalidate(), say);
const detail = h('p', { id: 'needs-detail' });
const answer = h('textarea', { id: 'personal-answer', maxlength: '500', rows: '2', placeholder: 'A few words is enough.', 'aria-describedby': 'needs-detail' });
const remember = h('input', { type: 'checkbox', id: 'remember-answer' });
const answerGo = h('button', { type: 'button' }, 'Use answer & draft');
const skipQuestion = h('button', { type: 'button' }, 'Skip for now');
const suggestion = h('div', { class: 'reply-suggestion', hidden: true });
const questionCard = h('section', { class: 'reply-question', hidden: true, 'aria-label': 'One detail from you' }, h('h2', {}, 'One thing only you know'), detail, suggestion, h('label', { for: 'personal-answer' }, 'Your answer'), answer, h('label', { class: 'reply-language' }, remember, ' Remember this on this device'), h('div', {class:'reply-actions'},answerGo, skipQuestion));
let question: Question | null = null;
function refreshSuggestion() {
  suggestion.replaceChildren();const saved=question && memories.find(question);suggestion.hidden=!saved;
  if(!saved)return;
  const yes=h('button',{type:'button'},'Use this answer');
  const other=h('button',{type:'button'},'Something else');
  yes.addEventListener('click',()=>{answer.value=saved.answer;answer.focus();say('Check the answer, then choose Use answer & draft.');});
  other.addEventListener('click',()=>{suggestion.hidden=true;answer.value='';answer.focus();});
  suggestion.append(h('p',{},'Still accurate?'),h('p',{},saved.answer),h('small',{},`Saved ${saved.updated} UTC`),yes,other);
}
function ask(q:Question, focus = true) {
  const focusAnswer = focus || results.contains(document.activeElement);
  ++copyRequest;
  motion.clear();
  question=q;questionCard.hidden=false;detail.textContent=q.question;answer.value='';remember.checked=false;refreshSuggestion();say(focusAnswer ? '' : q.question);
  update();
  if (focusAnswer) answer.focus();
  motion.lift(questionCard, 3);
}
const outputs = [0].map(i => {
  const text = h('textarea', { id: `draft-${i}`, maxlength: '280', rows: '3' });
  const label = h('label', { for: `draft-${i}` }, 'Your reply');
  const copyLabel = h('span', {}, 'Copy');
  const copy = h('button', { type: 'button', disabled: true }, copyLabel);
  function resetCopy() { ++copyRequest; motion.stop(copyLabel); copyLabel.textContent = 'Copy'; copy.disabled = !text.value.trim(); }
  copy.addEventListener('click', () => {
    const request = ++copyRequest;
    void navigator.clipboard.writeText(text.value).then(() => {
      if (request !== copyRequest) return;
      copyLabel.textContent = 'Copied';
      say('Copied.');
      motion.lift(copyLabel, 2);
    }, () => {
      if (request === copyRequest) say('Copy failed. Select the draft and copy it manually.', 'error');
    });
  });
  text.addEventListener('input', () => { resetCopy(); invalidate(); });
  return { text, label, setDraft(value: string) { text.value = value; resetCopy(); }, section: h('section', {}, label, text, copy) };
});

const provider = h('select', { id: 'provider' }, h('option', { value: 'local' }, 'On-device · free'), h('option', { value: 'gemini' }, 'Gemini · paid project'));
const apiKey = h('input', { id: 'gemini-key', type: 'password', autocomplete: 'off', spellcheck: 'false', maxlength: '200' });
const cloudConsent = h('input', { type: 'checkbox', id: 'cloud-consent' });
const connect = h('button', { type: 'button' }, 'Connect Gemini');
const disconnect = h('button', { type: 'button' }, 'Forget key');
const cloudSetup = h('section', { hidden: true },
  h('p', {}, 'Your post, voice and answers you confirm go directly to Google when you draft. Your key stays in this panel’s memory.'),
  h('details', {}, h('summary', {}, 'Data, limits & eligibility'),
    h('p', { class: 'reply-muted' }, 'Gemini 3.5 Flash-Lite. Hiding or closing the panel, reload, or Forget key clears the key. Provider limits and charges apply.'),
    h('p', {}, 'Draft sends this post, your point, saved voice choices and writing samples, and any answer you confirm. Shorter also sends your edited reply. The captured author and link stay here.'),
    h('p', {}, 'Use a paid-tier project with data sharing turned off. Check its billing tier in Google AI Studio. Connect checks model access only. For adults using Gemini professionally.')),
  h('a', { href: 'https://aistudio.google.com/api-keys', target: '_blank', rel: 'noopener noreferrer' }, 'View keys in AI Studio'),
  h('label', { for: 'gemini-key' }, 'Gemini API key'), apiKey,
  h('label', { class: 'reply-language' }, cloudConsent, ' This key belongs to a paid-tier project with data sharing off. I agree to send the reply context to Google and accept API charges.'),
  connect, disconnect);
let connectedKey = '';
const setupSummary = h('summary', {}, 'Settings');
const setup = h('details', { class: 'reply-setup', open: true }, setupSummary,
  h('label', { for: 'provider' }, 'Draft with'), provider, cloudSetup, initialize, voice.element, memories.element,
  h('details', { class: 'reply-settings' }, h('summary', {}, 'Capture & privacy settings'),
    h('p', { class: 'reply-muted' }, 'Allow X access to read only the post you right-click: its visible text, author and link. Paste works without access. X extraction policy remains unresolved. The kit never posts for you.'), access, revoke));
const thought = h('details', { class: 'reply-thought' }, h('summary', {}, 'Add my point'), h('label', { for: 'intent' }, 'What do you want to say?'), intent);
const results = h('section', { class: 'reply-results', hidden: true, 'aria-label': 'Your reply' }, outputs[0]!.section,
  h('div', { class: 'reply-actions reply-refine' }, shorter, retry, undo));
const postExpand = h('button', {type:'button',class:'reply-text-link','aria-expanded':'false'},'Expand post');
postExpand.addEventListener('click',()=>{const expanded=postExpand.getAttribute('aria-expanded')!=='true';post.rows=expanded?8:2;postExpand.setAttribute('aria-expanded',String(expanded));postExpand.textContent=expanded?'Collapse post':'Expand post';});
const editor = h('section', {class:'reply-editor'}, setup,
  h('section', { class: 'reply-post' }, h('label', { for: 'post' }, 'The post'), post, postExpand, context),
  thought, questionCard,
  h('div', { class: 'reply-actions reply-draft-action' }, generate, workLine, cancel), results);
editor.hidden = true;
const incomingText = h('p');
const usePost = h('button', { type: 'button' }, 'Use this post');
const keepPost = h('button', { type: 'button' }, 'Keep current');
const incoming = h('section', { class: 'reply-incoming', hidden: true, 'aria-label': 'New post selected' },
  h('h2', {}, 'New post selected'), incomingText, h('p', { class: 'reply-muted' }, 'Use it to start a fresh reply. Your current text and drafts will be replaced.'), usePost, keepPost);
let pendingSource: Source | null = null;
app.append(h('header', { class: 'reply-heading' }, reader(), h('div', {}, h('h1', {}, 'Reply drafter'), h('p', { class: 'reply-beta' }, 'Reply drafting beta'))), consent, status, incoming, editor);
let busy = false;
let enabled = false;
let ready = false;
let showedReady = false;
let workTrigger: HTMLElement | undefined;
let writing = '';
let session: Session | undefined;
const operation = new Operation();
const connection = new Operation();
function say(message: string, tone?: 'error' | 'cancel') {
  motion.stop(status);
  status.textContent = message;
  status.classList.toggle('reply-quiet-status', message === question?.question || (!!writing && message === writing) || ['Reply ready.', 'Copied.', 'Model ready.', 'Previous wording restored.'].includes(message));
  if (tone) {
    status.dataset.tone = tone;
    motion.lift(status, tone === 'error' ? 2 : 0);
  } else delete status.dataset.tone;
}
function clearSession() { session?.destroy(); session = undefined; }
function invalidate() {
  operation.cancel();
  ++copyRequest;
  clearSession();
  busy = false;
  if (writing && status.textContent === writing) say('');
  motion.clear();
  update();
}
function update() {
  if (!busy) writing = '';
  const hasDraft = !!outputs[0]!.text.value.trim();
  consent.hidden = enabled;
  editor.hidden = !enabled;
  generate.disabled = !enabled || !ready || busy;
  generate.setAttribute('aria-busy', String(busy));
  generate.hidden = hasDraft || !questionCard.hidden || !!writing;
  cancel.hidden = !busy;
  workLine.hidden = !writing;
  results.hidden = (!hasDraft && !previousDraft) || !questionCard.hidden;
  setupSummary.textContent = ready ? 'Settings · Connected' : 'Set up drafting';
  shorter.disabled = retry.disabled = !enabled || !ready || busy || !hasDraft;
  initialize.hidden = ready || provider.value === 'gemini';
  connect.disabled = !cloudConsent.checked || !!connectedKey;
  connect.hidden = !!connectedKey;
  disconnect.hidden = !connectedKey && !apiKey.value;
  apiKey.disabled = !!connectedKey;
  if (ready && !showedReady) motion.lift(generate.hidden ? setupSummary : generate, 2);
  if (!ready) { motion.stop(generate); motion.stop(setupSummary); }
  showedReady = ready;
}
function cancelWork() {
  const restoreFocus = document.activeElement === cancel;
  connection.cancel();
  invalidate();
  say('Cancelled. Your edits are kept.', 'cancel');
  if (restoreFocus) focusTrigger(workTrigger);
}
function focusTrigger(trigger?: HTMLElement) {
  (trigger?.getClientRects().length ? trigger : generate.hidden ? retry : generate).focus();
}
function clearDetail() { motion.stop(questionCard);questionCard.hidden=true;question=null;detail.textContent='';answer.value='';remember.checked=false; }
function disableEditor(message: string) {
  enabled = ready = false; forgetCloud(); provider.value = 'local'; cloudSetup.hidden = true; invalidate();
  post.value = intent.value = ''; confirmedAnswers=[]; pendingSource = null; incoming.hidden = true;
  outputs.forEach(o => o.setDraft('')); previousDraft='';undo.hidden=true; clearDetail();
  context.textContent = 'Paste a post below. Right-click capture requires enabled access and a fresh right-click.';
  generate.textContent = 'Draft reply'; update(); say(message);
}
cancel.addEventListener('click', cancelWork);
window.addEventListener('pagehide', () => { forgetCloud(); invalidate(); });
document.addEventListener('visibilitychange', () => {
  if (inPanel && document.hidden && provider.value === 'gemini') {
    forgetCloud(); setup.open = true; update(); say('Gemini disconnected when the panel was hidden. Reconnect to continue.');
  }
});
for (const input of [post, intent]) input.addEventListener('input', () => { invalidate(); clearDetail(); confirmedAnswers=[];context.hidden=!!post.value.trim() && !context.querySelector('a') && !context.textContent?.includes('could not');update(); });
async function checkModel() {
  if (!enabled || provider.value !== 'local') return;
  ready = false;
  try {
    const state = await availability();
    if (!enabled || provider.value !== 'local') return;
    ready = state === 'available';
    if (ready && !voice.isOpen()) setup.open = false;
    say(state === 'unavailable' ? 'On-device AI is unavailable here. Use a supported desktop Chrome with the Prompt API and sufficient device resources. English only.' : state === 'available' ? '' : state === 'downloading' ? 'Chrome is downloading the model. Click Initialize model to follow progress or cancel this editor’s request.' : 'Model downloadable. Initialize model starts Chrome’s model download.');
  } catch { if (enabled && provider.value === 'local') say('Could not check on-device AI. Retry with Initialize model.'); }
  update();
}
function forgetCloud() { connection.cancel(); connectedKey = ''; apiKey.value = ''; apiKey.disabled = false; cloudConsent.checked = false; ready = false; invalidate(); }
provider.addEventListener('change', () => {
  forgetCloud(); cloudSetup.hidden = provider.value !== 'gemini'; setup.open = true; update();
  if (provider.value === 'local') void checkModel();
  else say('Connect your Gemini key to use cloud drafting. Connecting checks model access without sending your post.');
});
cloudConsent.addEventListener('change', () => { if (!cloudConsent.checked) forgetCloud(); update(); });
disconnect.addEventListener('click', () => { forgetCloud(); setup.open = true; update(); say('Key forgotten. Your text and drafts are kept.'); });
connect.addEventListener('click', () => {
  if (!enabled || provider.value !== 'gemini' || !cloudConsent.checked) return;
  const key = apiKey.value.trim();
  if (!validKey(key)) { say('Enter a valid Gemini API key.'); return; }
  const task = connection.start(); clearSession(); ready = false; update(); say('Checking Gemini access…');
  void chrome.permissions.request({ origins: [GEMINI_ORIGIN] }).then(async granted => {
    if (!connection.current(task.revision)) return;
    if (!granted) throw new CloudError('Gemini access declined. Choose the local model or connect again.');
    await testKey(key, task.signal);
    if (!connection.current(task.revision)) return;
    connectedKey = key; apiKey.value = ''; ready = true; if (!voice.isOpen()) setup.open = false; update(); say('Gemini connected. Generate sends your selected reply context to Google.');
  }).catch(error => { if (connection.current(task.revision)) say(error instanceof CloudError ? error.message : 'Could not connect Gemini. Try again.'); });
});
apiKey.addEventListener('input', () => { cloudConsent.checked = false; connection.cancel(); invalidate(); ready = false; update(); });
chrome.permissions.onRemoved.addListener(permissions => {
  if (permissions.origins?.includes(GEMINI_ORIGIN) && provider.value === 'gemini') { forgetCloud(); setup.open=true;update(); say('Gemini access removed. Reconnect to continue.'); }
});
enable.addEventListener('click', () => { void chrome.storage.local.set({ [CONSENT]: 1 }).then(() => { enabled = true; update(); void checkModel(); }, () => say('Could not save consent. Try again.')); });
revoke.addEventListener('click', () => { void chrome.storage.local.remove(CONSENT).then(() => disableEditor('Reply drafting disabled.'), () => say('Could not disable drafting. Try again.')); });
access.addEventListener('click', () => {
  void chrome.permissions.request({ origins: ['https://x.com/*'] }).then(granted => say(granted ? 'X text access enabled. Reload your X tab, right-click the post again and choose Draft a reply to this post.' : 'X text access was declined. Paste a post to continue.'), () => say('Could not enable X text access. Paste a post to continue.'));
});
initialize.addEventListener('click', () => {
  workTrigger = initialize;
  const task = operation.start(); clearSession(); busy = true; update();
  say('Initializing Chrome model…');
  // create runs directly in this user gesture, including when download is needed.
  void create(task.signal, progress => { if (operation.current(task.revision)) say(`Downloading Chrome model · ${progress}%`); }).then(s => {
    s.destroy();
    if (operation.current(task.revision)) { ready = true; busy = false; if (!voice.isOpen()) setup.open = false; update(); say('Model ready.'); }
  }, error => { if (operation.current(task.revision)) { busy = false; update(); say(error instanceof DOMException && error.name === 'NotSupportedError' ? 'This device or language is unsupported. English only.' : 'Model initialization failed. Retry Initialize model.', 'error'); } });
});
function run(revision = '', trigger: HTMLElement = generate) {
  if (!enabled || !ready) { update();say('Connect a model in Settings to continue.');return; }
  if (!revision && !confirmedAnswers.length && !intent.value.trim()) {
    const missing=personalQuestion(post.value);
    if(missing){ask(missing);return;}
  }
  let input: string;
  try {
    input = prompt(post.value, intent.value, voice.get(), revision, revision ? outputs[0]!.text.value : '', confirmedAnswers);
  } catch (error) { say((error as Error).message, 'error'); return; }
  const focusCancel = document.activeElement === trigger || document.activeElement === document.body;
  const output = outputs[0]!;
  const revising = !!output.text.value.trim();
  const task = operation.start();
  ++copyRequest;
  motion.clear();
  clearSession();
  clearDetail();
  busy = true;
  workTrigger = trigger;
  writing = revision ? 'Shortening your reply…' : revising ? 'Trying another reply…' : 'Writing your reply…';
  workLine.replaceChildren(workInk, writing);
  update();
  say(writing);
  if (focusCancel) cancel.focus({ preventScroll: true });
  motion.play(workInk, { scaleX: .15 }, { scaleX: 1 }, .28);
  const ownsFocus = () => document.activeElement === cancel || document.activeElement === document.body;
  void (async () => {
    let local: Session | undefined;
    try {
      local = provider.value === 'gemini' ? gemini(connectedKey) : await create(task.signal, () => {});
      if (!operation.current(task.revision)) return;
      session = local;
      const raw = await local.prompt(input, { signal: task.signal, responseConstraint: schema });
      if (!operation.current(task.revision)) return;
      const missing = needsDetail(raw);
      const restoreFocus = ownsFocus();
      if (missing) {
        const key=JSON.parse(raw).factKey;
        busy = false;
        ask({key:['project','role'].includes(key)?key:'other',question:missing}, restoreFocus);return;
      }
      const result = drafts(raw);
      busy = false;
      previousDraft=output.text.value;undo.hidden=!previousDraft;undo.textContent='Undo';
      output.setDraft(result[0]);update();say('Reply ready.');
      if (restoreFocus) output.text.focus();
      if (revising) {
        const style = getComputedStyle(output.text);
        motion.play(output.text, { backgroundColor: style.getPropertyValue('--xck-sunken').trim() }, { backgroundColor: style.backgroundColor }, .22);
      } else motion.lift(results, 5);
    } catch (error) {
      if (operation.current(task.revision)) {
        const restoreFocus = ownsFocus();
        busy = false;
        update();
        say(error instanceof CloudError ? error.message : error instanceof DOMException && error.name === 'NotSupportedError' ? 'Unsupported input or language. This MVP supports English.' : 'Generation failed or returned invalid drafts. Your edits are kept. Try again.', 'error');
        if (restoreFocus) focusTrigger(trigger);
      }
    } finally {
      local?.destroy();
      if (session === local) session = undefined;
      if (operation.current(task.revision)) motion.stop(workInk);
    }
  })();
}
generate.addEventListener('click', () => run());
shorter.addEventListener('click', () => run('shorter', shorter));
retry.addEventListener('click', () => run('', retry));
undo.addEventListener('click',()=>{invalidate();const output=outputs[0]!;const current=output.text.value;output.setDraft(previousDraft);previousDraft=current;undo.textContent=undo.textContent==='Undo'?'Redo':'Undo';update();output.text.focus();say('Previous wording restored.');motion.lift(output.label, -2);});
answer.addEventListener('input',()=>{invalidate();});
answerGo.addEventListener('click',()=>{
  if(!enabled || !ready){setup.open=true;update();say('Connect a model in Settings. Your answer is kept.');return;}
  if(!question || !answer.value.trim()){say('Add a short answer first.');answer.focus();return;}
  const q=question, text=answer.value.trim();
  if(confirmedAnswers.length>=3 && !confirmedAnswers.some(a=>a.question===q.question)){thought.open=true;intent.focus();say('Add the remaining details under My point, then draft again.');return;}
  const task=operation.start();
  answerGo.disabled=true;
  void (async()=>{
    try{if(remember.checked)await memories.remember(q,text);if(!operation.current(task.revision))return;confirmedAnswers=[...confirmedAnswers.filter(a=>a.question!==q.question),{question:q.question,answer:text}];run('', answerGo);}
    catch{say('Could not remember this answer. Uncheck Remember to use it once, or try again.');}
    finally{answerGo.disabled=false;}
  })();
});
skipQuestion.addEventListener('click',()=>{invalidate();clearDetail();update();(outputs[0]!.text.value.trim()?outputs[0]!.text:generate).focus();say('Skipped. Add your point whenever you want to reply.');});
function applySource(source: Source | null) {
  invalidate(); clearDetail(); post.value = source?.text ?? ''; intent.value = ''; confirmedAnswers=[];
  outputs.forEach(o => o.setDraft('')); previousDraft='';undo.hidden=true; generate.textContent = 'Draft reply';
  context.hidden=false;
  if (source) context.replaceChildren(source.author + ' · ', h('a', { href: source.url, target: '_blank', rel: 'noopener' }, 'Return to original post'));
  else context.textContent = 'The chosen post could not be captured completely. Paste the post here instead.';
  incoming.hidden = true; pendingSource = null; update(); post.focus();
}
usePost.addEventListener('click', () => applySource(pendingSource));
keepPost.addEventListener('click', () => { pendingSource = null; incoming.hidden = true; say('Current reply kept.'); post.focus(); });
async function receivePost() {
  if (!inPanel || !enabled) return;
  const window = await chrome.windows.getCurrent();
  const result = await chrome.runtime.sendMessage({ type: 'xck:reply:panel-get', windowId: window.id });
  if (!result?.ok || !enabled) return;
  const source = result.source ?? null;
  if (!post.value.trim() && !intent.value.trim() && !outputs.some(o => o.text.value.trim())) { applySource(source); return; }
  pendingSource = source;
  incomingText.textContent = source ? source.text.slice(0,180) : 'This post needs pasted text.';
  incoming.hidden = false; say('New post selected. Use it or keep your current reply.');
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && Object.keys(changes).some(k => k.startsWith('xck:reply-panel:') && changes[k]?.newValue)) void receivePost().catch(() => say('Could not load the post. Paste its text to continue.'));
  if (area !== 'local') return;
  if (changes[CONSENT] && changes[CONSENT].newValue !== 1) disableEditor('Reply drafting was disabled. This editor’s temporary text was cleared.');
  if(changes[FACTS])memories.load(changes[FACTS].newValue);
  if (changes[PROFILE]) { invalidate(); voice.load(changes[PROFILE].newValue); }
});
async function init() {
  const saved = await chrome.storage.local.get([CONSENT, PROFILE, PROFILE_DRAFT, FACTS]);
  enabled = saved[CONSENT] === 1;
  voice.load(saved[PROFILE]);voice.loadProgress(saved[PROFILE_DRAFT]);memories.load(saved[FACTS]);
  update();
  if (enabled) { await receivePost(); await checkModel(); }
}
void init().catch(() => say('Could not load local settings. Reopen the editor to retry.'));

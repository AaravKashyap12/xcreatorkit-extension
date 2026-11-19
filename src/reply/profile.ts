import { h, download } from '../ui/dom';
export const PROFILE = 'xck:reply-profile';
export const PROFILE_DRAFT = 'xck:reply-profile-draft';
export type Profile = {
  interests: string[];
  background: { work: string; audience: string };
  style: { voice: string; length: string; emojis: string; avoid: string };
  examples: string[];
  preferences?: { comparison: string; disagreement: string; personality: string; casing: string; calibration: string };
};
export const DEFAULT_PROFILE: Profile = { interests: [], background: { work: '', audience: '' }, style: { voice: 'conversational', length: 'short', emojis: 'none', avoid: '' }, examples: [] };
const prefDefault = { comparison: '', disagreement: 'gentle question', personality: 'warm', casing: 'natural', calibration: '' };
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
export function profile(value: unknown): Profile {
  const p = value as Profile | null;
  if (!p || !Array.isArray(p.interests) || p.interests.length > 5 || p.interests.some(v => !bounded(v, 60)) || !p.background || !p.style || !bounded(p.background.work, 300) || !bounded(p.background.audience, 200) || !['direct', 'conversational', 'playful'].includes(p.style.voice) || !['short', 'balanced'].includes(p.style.length) || !['none', 'occasional'].includes(p.style.emojis) || !bounded(p.style.avoid, 200) || !Array.isArray(p.examples) || p.examples.length > 5 || p.examples.some(e => !bounded(e, 400))) return structuredClone(DEFAULT_PROFILE);
  const pref = p.preferences;
  if (pref && (!bounded(pref.comparison, 200) || !['gentle question', 'direct counterpoint', 'light humour'].includes(pref.disagreement) || !['dry', 'warm', 'playful', 'blunt'].includes(pref.personality) || !['natural', 'lowercase', 'standard punctuation'].includes(pref.casing) || !bounded(pref.calibration, 400))) return structuredClone(DEFAULT_PROFILE);
  return { interests: [...p.interests], background: { work: p.background.work, audience: p.background.audience }, style: { voice: p.style.voice, length: p.style.length, emojis: p.style.emojis, avoid: p.style.avoid }, examples: [...p.examples], ...(pref ? { preferences: { comparison: pref.comparison, disagreement: pref.disagreement, personality: pref.personality, casing: pref.casing, calibration: pref.calibration } } : {}) };
}
export function voiceSummary(p: Profile) { return `${p.style.voice} · ${p.style.length} · ${p.style.emojis === 'none' ? 'no emojis' : 'occasional emojis'}`; }
export function voiceMarkdown(p: Profile) {
  return ['# My voice', '', 'Style guidance only. Examples are not personal facts or opinions for another post.', '',
    `Topics: ${p.interests.join(', ') || 'Not specified'}`, `Audience: ${p.background.audience || 'Not specified'}`,
    `Voice: ${p.style.voice}`, `Length: ${p.style.length}`, `Emojis: ${p.style.emojis}`, `Avoid: ${p.style.avoid || 'Not specified'}`,
    ...(p.preferences ? [`Second example: ${p.preferences.comparison}`, `Disagreement: ${p.preferences.disagreement}`, `Personality: ${p.preferences.personality}`, `Writing: ${p.preferences.casing}`, '', '## Practice reply', p.preferences.calibration] : []),
    '', '## My writing samples', ...p.examples.map(e => `> ${e.replace(/\n/g, '\n> ')}`), ''].join('\n');
}
export function writingProfile(changed: () => void, say: (message: string) => void) {
  let current = profile(null), step = 0, writeQueue = Promise.resolve(), epoch = 0;
  let progress: { value: Profile; step: number } | undefined;
  let releaseEdit: (()=>void)|undefined;
  function finish(){card.hidden=true;compact.hidden=false;edit.focus();void writeQueue.finally(()=>{releaseEdit?.();releaseEdit=undefined;});}
  const summary = h('span', {}, voiceSummary(current));
  const edit = h('button', { type: 'button' }, 'Edit my voice');
  const exportButton = h('button', { type: 'button' }, 'Download voice.md');
  const compact = h('div', { class: 'reply-voice' }, summary, edit, exportButton);
  const heading = h('h2', { tabindex: '-1' });
  const progressText = h('p', { class: 'reply-muted', 'aria-live': 'polite' });
  const saveState = h('p', { class: 'reply-muted', role: 'status' });
  const choice = (id: string, options: [string, string][]) => {
    const inputs = options.map(([value]) => h('input', { type: 'radio', name: id, value }));
    return { element: h('div', { id, class: 'reply-voice-options', role: 'group', 'aria-labelledby': 'voice-question' }, ...inputs.map((input, i) => h('label', {}, input, h('span', {}, options[i]![1])))), get: () => inputs.find(e => e.checked)?.value ?? options[0]![0], set: (value: string) => inputs.forEach(e => { e.checked = e.value === value; }) };
  };
  const topics = ['Building products', 'Design', 'Tech', 'Marketing', 'General'].map(value => h('label', { class: 'reply-chip' }, h('input', { type: 'checkbox', value }), value));
  const custom = h('input', { id: 'profile-topic', maxlength: '60', placeholder: 'Another topic (optional)' });
  const audience = h('input', { id: 'profile-audience', maxlength: '200', placeholder: 'Or describe who you reply to' });
  const audienceButtons = ['Builders', 'Customers', 'Friends', 'Experts'].map(value => h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => { audience.value = value; audienceCustom.open = false; syncAudience(); persist(); } }, value));
  const audiences = h('div', { class: 'reply-topics' }, ...audienceButtons);
  const audienceCustom = h('details', {}, h('summary', {}, 'Write my own'), h('label', { for: 'profile-audience' }, 'Who you reply to'), audience);
  function syncAudience() { audienceButtons.forEach(button => button.setAttribute('aria-pressed', String(button.textContent === audience.value))); }
  audience.addEventListener('input', syncAudience);
  const voice = choice('profile-voice', [['direct', 'Small releases make feedback easier to use.'], ['conversational', 'Small releases make it easier to use that feedback.'], ['playful', 'Small releases. Bite-size feedback. Much less chaos.']]);
  const comparison = choice('profile-comparison', [['Which part took the longest?', 'Which part took the longest?'], ['Curious—which part took you the longest?', 'Curious—which part took you the longest?'], ['Which bit ate your weekend?', 'Which bit ate your weekend?']]);
  const disagreement = choice('profile-disagreement', [['gentle question', 'Gentle question · “Would that still work for a small team?”'], ['direct counterpoint', 'Direct counterpoint · “That depends on the team size.”'], ['light humour', 'Light humour · “My two-person team might have questions.”']]);
  const personality = choice('profile-personality', [['dry', 'Dry · “One less thing to debug.”'], ['warm', 'Warm · “That should make the next release easier.”'], ['playful', 'Playful · “One bug down. The others are hiding.”'], ['blunt', 'Blunt · “Fix the bug before adding features.”']]);
  const length = h('select', { id: 'profile-length' }, h('option', { value: 'short' }, 'One short sentence'), h('option', { value: 'balanced' }, 'A little more detail'));
  const casing = h('select', { id: 'profile-casing' }, ...['natural', 'lowercase', 'standard punctuation'].map(value => h('option', { value }, value)));
  const emojis = h('select', { id: 'profile-emojis' }, h('option', { value: 'none' }, 'Without emojis'), h('option', { value: 'occasional' }, 'Occasional emoji'));
  const avoid = h('input', { id: 'profile-avoid', maxlength: '200', placeholder: 'Phrases you never use' });
  const avoidButtons = h('div', { class: 'reply-topics' }, ...['Great insight', 'Game changer', 'Hype', 'Hashtags'].map(value => h('button', { type: 'button', onclick: () => { if (!avoid.value.includes(value)) avoid.value = [avoid.value, value].filter(Boolean).join(', ').slice(0,200); persist(); } }, value)));
  const examples = Array.from({ length: 5 }, (_, i) => h('textarea', { id: `profile-example-${i}`, maxlength: '400', rows: '3', placeholder: i ? 'Another reply you wrote' : 'Paste your own words, or skip this one.' }));
  const calibration = h('textarea', { id: 'profile-calibration', maxlength: '400', rows: '3' });
  const steps = [
    h('section', {}, h('div', { class: 'reply-topics' }, ...topics), h('details', {}, h('summary', {}, 'Add another topic'), h('label', { for: 'profile-topic' }, 'Your own topic'), custom)),
    h('section', {}, audiences, audienceCustom),
    h('section', {}, h('p', { class: 'reply-muted' }, 'Post: “I’m trying smaller releases so I can use feedback sooner.”'), voice.element),
    h('section', {}, h('p', { class: 'reply-muted' }, 'Post: “Finally shipped my first version. It took longer than I expected.”'), comparison.element),
    h('section', {}, disagreement.element), h('section', {}, personality.element),
    h('section', {}, h('label', { for: 'profile-length' }, 'Length'), length, h('label', { for: 'profile-casing' }, 'Casing & punctuation'), casing, h('label', { for: 'profile-emojis' }, 'Emojis'), emojis),
    h('section', {}, avoidButtons, h('label', { for: 'profile-avoid' }, 'Things to avoid'), avoid),
    h('section', {}, h('label', { for: 'profile-example-0' }, 'A reply that sounds like you (optional)'), examples[0]!, h('details', {}, h('summary', {}, 'More writing samples'), ...examples.slice(1).flatMap((e,i) => [h('label', { for: e.id }, `Example ${i+2}`),e]))),
    h('section', {}, h('p', { class: 'reply-muted' }, 'Practice post: “I’m trying smaller releases so I can use feedback sooner.” This local preview uses your choices; edit it into your words.'), h('label', { for: 'profile-calibration' }, 'How would you say this?'), calibration),
  ];
  const titles = ['What do you talk about?', 'Who do you reply to?', 'Which sounds like you?', 'And on a different post?', 'How do you disagree?', 'How much personality?', 'What does your writing look like?', 'What would you never say?', 'Show us your own words.', 'Make this sound like you.'];
  heading.id = 'voice-question';
  const back = h('button', { type: 'button' }, 'Back');
  const close = h('button', { type: 'button' }, 'Finish later');
  const next = h('button', { class: 'reply-primary', type: 'button' }, 'Continue');
  const save = h('button', { class: 'reply-primary', type: 'button' }, 'Save my voice');
  const remove = h('button', { type: 'button', class:'reply-text-link' }, 'Delete writing profile');
  const card = h('section', { class: 'reply-profile', hidden: true, 'aria-label': 'Writing profile setup' }, progressText, heading, ...steps, h('div', { class: 'reply-actions' }, back, next, save, close), saveState, remove);
  function read(): Profile {
    return { interests: [...topics.filter(t => t.querySelector('input')!.checked).map(t => t.querySelector('input')!.value), ...custom.value.trim().split(',').map(s=>s.trim()).filter(Boolean)].slice(0,5), background: { work: current.background.work, audience: audience.value }, style: { voice: voice.get(), length: length.value, emojis: emojis.value, avoid: avoid.value }, examples: examples.map(e=>e.value).filter(Boolean), preferences: { comparison: comparison.get(), disagreement: disagreement.get(), personality: personality.get(), casing: casing.value, calibration: calibration.value } };
  }
  function fill(p: Profile) {
    topics.forEach(t=>{t.querySelector('input')!.checked=p.interests.includes(t.querySelector('input')!.value);});
    custom.value=p.interests.filter(s=>!topics.some(t=>t.querySelector('input')!.value===s)).join(', ');
    custom.closest('details')!.open = !!custom.value;
    audience.value=p.background.audience; syncAudience(); audienceCustom.open=!!audience.value && !audienceButtons.some(button=>button.textContent===audience.value);
    voice.set(p.style.voice); length.value=p.style.length; emojis.value=p.style.emojis; avoid.value=p.style.avoid;
    examples.forEach((e,i)=>{e.value=p.examples[i]??'';});
    const prefs = p.preferences ?? prefDefault;
    comparison.set(prefs.comparison || 'Which part took the longest?'); disagreement.set(prefs.disagreement); personality.set(prefs.personality); casing.value=prefs.casing; calibration.value=prefs.calibration;
  }
  function show() {
    heading.textContent=titles[step]!; progressText.textContent=`YOUR VOICE · ${step+1} / 10`;
    steps.forEach((s,i)=>{s.hidden=i!==step;}); back.hidden=step===0; next.hidden=step===9; save.hidden=step!==9;
    if(step===9 && !calibration.value) { calibration.value=voice.get()==='direct'?'Small releases make feedback easier to use.':voice.get()==='playful'?'Small releases. Bite-size feedback. Much less chaos.':'Small releases make it easier to use that feedback.'; if(casing.value==='lowercase') calibration.value=calibration.value.toLowerCase(); }
    heading.focus();
  }
  function persist() {
    progress={ value:profile(read()), step };
    const snapshot=structuredClone(progress), generation=epoch;
    writeQueue=writeQueue.then(()=>generation===epoch ? chrome.storage.local.set({[PROFILE_DRAFT]:snapshot}) : undefined).then(()=>{saveState.textContent='Progress saved on this device.';},()=>{saveState.textContent='Progress could not be saved. Keep this panel open and retry.';});
  }
  edit.addEventListener('click',()=>{void navigator.locks.request(PROFILE_DRAFT,{ifAvailable:true},async lock=>{
    if(!lock){say('Your voice is being edited in another panel. Finish there, then reopen it here.');return;}
    const saved=await chrome.storage.local.get(PROFILE_DRAFT);
    const draft=saved[PROFILE_DRAFT] as {value:unknown;step:number}|undefined;
    progress=draft && Number.isInteger(draft.step) && draft.step>=0 && draft.step<10 ? {value:profile(draft.value),step:draft.step}:undefined;
    fill(progress?.value??current);step=progress?.step??0;card.hidden=false;compact.hidden=true;show();
    await new Promise<void>(resolve=>{releaseEdit=resolve;});
  }).catch(()=>say('Could not open your voice setup. Try again.'));});
  back.addEventListener('click',()=>{step--;show();persist();}); next.addEventListener('click',()=>{if(step===0 && topics.filter(t=>t.querySelector('input')!.checked).length + custom.value.split(',').filter(s=>s.trim()).length>5){saveState.textContent='Choose up to five topics.';return;}step++;show();persist();});
  card.addEventListener('input',persist);
  close.addEventListener('click',()=>{persist();finish();});
  save.addEventListener('click',()=>{
    const value=profile(read());save.disabled=true;
    writeQueue=writeQueue.then(()=>chrome.storage.local.set({[PROFILE]:value})).then(()=>chrome.storage.local.remove(PROFILE_DRAFT)).then(()=>{current=value;progress=undefined;summary.textContent=voiceSummary(current);finish();changed();say('Your voice is saved.');},()=>{say('Profile could not be saved. Your answers are kept here. Retry Save.');}).finally(()=>{save.disabled=false;});
  });
  remove.addEventListener('click',()=>{
    writeQueue=writeQueue.then(()=>chrome.storage.local.remove([PROFILE,PROFILE_DRAFT])).then(()=>{current=profile(null);progress=undefined;fill(current);summary.textContent=voiceSummary(current);finish();changed();say('Writing profile deleted.');},()=>say('Could not delete profile. Try again.'));
  });
  exportButton.addEventListener('click',()=>download('voice.md',voiceMarkdown(current),'text/markdown'));
  return { element:h('div',{},compact,card), get:()=>current, isOpen:()=>!card.hidden, load(value:unknown) {
    current=profile(value);summary.textContent=voiceSummary(current);
    if(!card.hidden){say('Saved voice changed. Your unfinished answers are kept until you save or finish later.');return;}
    epoch++;progress=undefined;fill(current);
  }, loadProgress(value:unknown) {
    const draft=value as {value:unknown;step:number}|undefined;
    if(draft && Number.isInteger(draft.step) && draft.step>=0 && draft.step<10) progress={value:profile(draft.value),step:draft.step};
    else progress=undefined;
  } };
}

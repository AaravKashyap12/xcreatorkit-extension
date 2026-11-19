import { mountNavigation } from '../ui/navigation';
import css from './editor.css';
import { validPost, type PostcardPost } from './parse';
import { BACKGROUNDS, BACKGROUND_NAMES, CARD_CSS, DIMENSIONS, STYLES, cardPng, fitCard, renderCard, type CardOptions } from './render';

const style = document.createElement('style'); style.textContent = css + CARD_CSS; document.head.append(style);
const app = document.getElementById('app')!;
let post: PostcardPost | null = null;
let options: CardOptions = { style: 'paper', background: BACKGROUNDS[0]!, showCounts: true, format: 'portrait' };
const feedback = document.createElement('p'); feedback.className = 'xck-post-feedback'; feedback.setAttribute('role', 'status');
const preview = document.createElement('div'); preview.className = 'xck-post-preview';
const scale = document.createElement('div'); scale.className = 'postcard-scale'; preview.append(scale);
function refresh() {
  if (!post) return;
  const [w, h] = DIMENSIONS[options.format];
  // Room for the control dock under the preview, so copy and download stay in view with the image.
  const size = Math.min(1, (preview.clientWidth || 700) / w, Math.max(320, window.innerHeight - 340) / h);
  preview.style.height = `${h * size}px`;
  scale.style.width = `${w}px`; scale.style.height = `${h}px`; scale.style.transform = `scale(${size})`;
  scale.innerHTML = renderCard(post, options);
  output.textContent = `PNG · ${w} × ${h}`;
  const fits = fitCard(scale.firstElementChild as HTMLElement);
  app.querySelectorAll<HTMLButtonElement>('button[data-export]').forEach((button) => { button.disabled = !fits; });
  setFeedback(fits ? '' : options.format === 'landscape' ? 'This post is too long for Landscape. Choose Portrait to fit it.' : 'This post is too long to fit one image, even in Portrait.', !fits);
}
window.addEventListener('resize', refresh);
const output = document.createElement('p'); output.className = 'xck-post-output';
const setFeedback = (message: string, error = false) => { feedback.textContent = message; feedback.classList.toggle('error', error); };
async function exportCard(copy: boolean) {
  if (!post) return;
  try {
    const blob = await cardPng(post, options);
    if (copy) { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); setFeedback('Image copied. Paste it into your post on X.'); }
    else { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `post-${post.id}-${options.format}.png`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000); setFeedback('PNG downloaded.'); }
  } catch (error) { setFeedback(copy ? `Could not copy the image (${(error as Error).message}). Use Download PNG instead.` : `Could not export: ${(error as Error).message}`, true); }
}
/** A named group of radio choices: every option visible, arrow keys move between them. */
function choices<T extends string>(legend: string, name: string, items: readonly (readonly [T, string])[], current: T, set: (v: T) => void) {
  const group = document.createElement('fieldset'); group.className = 'xck-post-choices';
  const title = document.createElement('legend'); title.textContent = legend; group.append(title);
  const row = document.createElement('div'); row.className = 'xck-post-segments';
  for (const [value, label] of items) {
    const item = document.createElement('label');
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = name; radio.value = value; radio.checked = value === current;
    radio.onchange = () => { if (radio.checked) { set(value); refresh(); } };
    const text = document.createElement('span'); text.textContent = label;
    item.append(radio, text); row.append(item);
  }
  group.append(row); return group;
}
function editor() {
  const top = document.createElement('header'); top.className = 'xck-post-head'; top.innerHTML = '<h1>Post to image</h1><p>Made on this device from the post you chose.</p>';
  // Say plainly when the card falls back to initials, and how to get the photo.
  if (!post?.avatar) { const note = document.createElement('p'); note.className = 'xck-post-note'; note.textContent = 'The profile photo could not be copied, so initials are shown. To include it, scroll until the author’s photo is fully visible on X, then right-click the post again.'; top.append(note); }
  const stage = document.createElement('section'); stage.className = 'xck-post-stage'; stage.setAttribute('aria-label', 'Preview'); stage.append(preview);
  const controls = document.createElement('div'); controls.className = 'xck-post-controls'; controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', 'Image settings');
  controls.append(choices('Style', 'postcard-style', STYLES, options.style, (v) => { options = { ...options, style: v }; }));
  const swatches = document.createElement('fieldset'); swatches.className = 'xck-post-choices';
  const swatchTitle = document.createElement('legend'); swatchTitle.textContent = 'Background'; swatches.append(swatchTitle);
  const swatchList = document.createElement('div'); swatchList.className = 'xck-post-swatches';
  for (const [i, color] of BACKGROUNDS.entries()) {
    const label = document.createElement('label'); label.title = BACKGROUND_NAMES[color] ?? `Background ${i + 1}`;
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'background'; radio.value = color; radio.checked = color === options.background; radio.setAttribute('aria-label', `${label.title} background`);
    radio.onchange = () => { options = { ...options, background: color }; refresh(); };
    const swatch = document.createElement('span'); swatch.style.background = color; label.append(radio, swatch); swatchList.append(label);
  }
  swatches.append(swatchList); controls.append(swatches);
  const details = document.createElement('fieldset'); details.className = 'xck-post-choices';
  const detailsTitle = document.createElement('legend'); detailsTitle.textContent = 'Details'; details.append(detailsTitle);
  const countsLabel = document.createElement('label'); countsLabel.className = 'xck-post-check'; const counts = document.createElement('input'); counts.id = 'postcard-counts'; counts.type = 'checkbox'; counts.checked = options.showCounts; counts.onchange = () => { options = { ...options, showCounts: counts.checked }; refresh(); }; countsLabel.append(counts, 'Show counts'); details.append(countsLabel); controls.append(details);
  controls.append(choices('Image size', 'postcard-format', [['portrait', 'Portrait · 1080 × 1350'], ['landscape', 'Landscape · 1200 × 675']] as const, options.format, (v) => { options = { ...options, format: v }; }));
  const copy = document.createElement('button'); copy.type = 'button'; copy.dataset.export = 'copy'; copy.textContent = 'Copy image'; copy.className = 'xck-primary'; copy.onclick = () => void exportCard(true);
  const download = document.createElement('button'); download.type = 'button'; download.dataset.export = 'download'; download.textContent = 'Download PNG'; download.onclick = () => void exportCard(false);
  const actions = document.createElement('div'); actions.className = 'xck-post-actions'; actions.append(copy, download, output);
  const dock = document.createElement('section'); dock.className = 'xck-post-dock'; dock.setAttribute('aria-label', 'Settings and export');
  dock.append(controls, actions, feedback);
  app.className = 'xck-post'; app.replaceChildren(top, stage, dock); refresh();
}
function notice(title: string, body: string) {
  const heading = document.createElement('h1'); heading.textContent = title;
  const message = document.createElement('p'); message.className = 'xck-post-message'; message.textContent = body;
  app.className = 'xck-post xck-post-intro'; app.replaceChildren(heading, message);
}
async function init() {
  const token = location.hash.slice(1);
  if (!token) {
    app.className = 'xck-post xck-post-intro';
    app.innerHTML = '<h1>Make an image of a post</h1><p class="xck-post-message">Start from a post on X. The image is made on this device.</p>'
      + '<ol class="xck-post-steps"><li><b>Right-click a post</b><span>On X, right-click a post’s text or image.</span></li><li><b>Choose “Make an image of this post”</b><span>This page opens with the post in place.</span></li><li><b>Pick a style</b><span>Copy the image or download the PNG.</span></li></ol>'
      + '<p class="xck-post-message xck-post-aside">If Chrome asks for x.com access, allow it and right-click the post again.</p>';
    return;
  }
  if (token === 'grant') {
    app.className = 'xck-post xck-post-intro';
    app.innerHTML = '<h1>Enable post images</h1><p class="xck-post-message">Make images from posts you choose on X.</p>'
      + '<p class="xck-post-message" id="post-data-disclosure">When you choose “Make an image of this post”, the extension reads its text, author, date and visible counts. It briefly screenshots the visible tab to crop the author’s photo. Only the post and cropped photo are kept in this browser’s session storage; the full screenshot is discarded. Nothing is sent to a server.</p>'
      + '<p class="xck-post-message">Enabling this allows a post-selection listener on x.com pages. Following highlighting stays off until you turn its switch on. Remove x.com access in Chrome’s extension settings to stop the page listeners.</p>';
    const button = document.createElement('button'); button.className = 'xck-primary'; button.textContent = 'Agree and enable post images';
    button.setAttribute('aria-describedby', 'post-data-disclosure');
    button.onclick = async () => {
      try {
        // Request directly from the gesture, before storage awaits.
        const granted = await chrome.permissions.request({ origins: ['https://x.com/*'] });
        if (granted) await chrome.storage.local.set({ 'xck:postcard-consent': 1 });
        button.textContent = granted ? 'Access enabled. Right-click a post again.' : 'Access was not enabled. Try again.';
      } catch { button.textContent = 'Could not enable post images. Try again.'; }
    }; app.append(button); return;
  }
  if (token === 'error') { notice('The selected post could not be identified', 'Right-click its text or image again after the page finishes loading.'); return; }
  const response = await chrome.runtime.sendMessage({ type: 'xck:postcard:get', token }) as { ok?: boolean; post?: unknown };
  if (!response?.ok || !validPost(response.post)) { notice('This card is unavailable', 'Right-click a post again to make a new image.'); return; }
  post = response.post; editor(); void document.fonts.ready.then(refresh);
}
void init();

mountNavigation();

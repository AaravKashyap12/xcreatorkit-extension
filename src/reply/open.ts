/** Open in the current Chrome window, in the original click gesture. */
export function bindReplyPanelLinks(root: HTMLElement, opened: () => void = () => {}) {
  let windowId: number | undefined;
  void chrome.windows.getCurrent().then(window => { windowId = window.id; }).catch(() => {});
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href="reply.html"]')) {
    link.removeAttribute('target');
    link.setAttribute('aria-description', 'Opens beside this tab');
    link.addEventListener('click', event => {
      event.preventDefault();
      const failure = () => {
        let note = root.querySelector<HTMLElement>('#reply-open-error');
        if (!note) { note = document.createElement('p'); note.id = 'reply-open-error'; note.setAttribute('role', 'status'); root.append(note); }
        note.textContent = 'Could not open the reply panel. Reopen the extension and try again.';
      };
      if (windowId === undefined) { failure(); return; }
      void chrome.sidePanel.open({ windowId }).then(opened, failure);
    });
  }
}

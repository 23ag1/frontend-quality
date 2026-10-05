for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('[role="tab"]')) t.setAttribute('aria-selected', String(t === tab));
    for (const p of document.querySelectorAll('[role="tabpanel"]')) {
      const on = p.id === tab.getAttribute('aria-controls');
      p.toggleAttribute('data-off', !on);
      p.hidden = !on && p.hasAttribute('data-hide');
    }
  });
}

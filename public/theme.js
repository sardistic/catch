// Runs before first paint so a stored light choice never flashes dark first.
// The page's CSP forbids inline scripts, so this has to be its own file and
// must stay out of the deferred bundle.
(() => {
  try {
    const stored = localStorage.getItem('catch-theme');
    if (stored === 'light' || stored === 'dark') {
      document.documentElement.dataset.theme = stored;
    }
  } catch {
    // Private browsing can throw on access; dark is the default either way.
  }
})();

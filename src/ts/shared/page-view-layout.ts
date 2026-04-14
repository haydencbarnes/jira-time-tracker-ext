/**
 * Fluid centered layout when Experimental + Page View (new tab) are on; otherwise fixed
 * width (750px body / table). Uses `pageViewNewTabEnabled` in sync storage.
 * Applies to full-tab pages and to `popup.html` when opened (e.g. menu).
 */
function readPageViewLayoutEnabled(items: Record<string, unknown>): boolean {
  return (
    items.experimentalFeatures === true && items.pageViewNewTabEnabled === true
  );
}

function applyPageViewLayoutClass(enabled: boolean): void {
  document.documentElement.classList.toggle('page-view-layout', enabled);
}

export function initPageViewLayout(): void {
  chrome.storage.sync.get(
    { pageViewNewTabEnabled: false, experimentalFeatures: false },
    (items) => {
      applyPageViewLayoutClass(readPageViewLayoutEnabled(items));
    }
  );

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'sync') return;
    if (!changes.pageViewNewTabEnabled && !changes.experimentalFeatures) return;
    chrome.storage.sync.get(
      { pageViewNewTabEnabled: false, experimentalFeatures: false },
      (items) => {
        applyPageViewLayoutClass(readPageViewLayoutEnabled(items));
      }
    );
  });
}

/**
 * Fluid centered layout when Experimental + Page View are on; otherwise fixed
 * width (750px body / table). Uses `sidePanelEnabled` storage key.
 * Applies to full-tab pages and to `popup.html` when opened (e.g. menu).
 */
function readPageViewLayoutEnabled(items: Record<string, unknown>): boolean {
  return (
    items.experimentalFeatures === true && items.sidePanelEnabled === true
  );
}

function applyPageViewLayoutClass(enabled: boolean): void {
  document.documentElement.classList.toggle('page-view-layout', enabled);
}

export function initPageViewLayout(): void {
  chrome.storage.sync.get(
    { sidePanelEnabled: false, experimentalFeatures: false },
    (items) => {
      applyPageViewLayoutClass(readPageViewLayoutEnabled(items));
    }
  );

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'sync') return;
    if (!changes.sidePanelEnabled && !changes.experimentalFeatures) return;
    chrome.storage.sync.get(
      { sidePanelEnabled: false, experimentalFeatures: false },
      (items) => {
        applyPageViewLayoutClass(readPageViewLayoutEnabled(items));
      }
    );
  });
}

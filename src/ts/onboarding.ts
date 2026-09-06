import { applyStoredTheme } from './shared/theme-sync';

const POPUP_PATH = 'dist/popup.html';
const TIMER_PATH = 'dist/timerFeatureModule/timer.html';

function openExtensionPage(path: string): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL(path) });
}

function openSettings(): void {
  void chrome.runtime.openOptionsPage();
}

function bindClick(id: string, handler: () => void): void {
  document.getElementById(id)?.addEventListener('click', handler);
}

document.addEventListener('DOMContentLoaded', () => {
  void applyStoredTheme();

  bindClick('openSettings', openSettings);
  bindClick('openSettingsFooter', openSettings);
  bindClick('openTimeTable', () => openExtensionPage(POPUP_PATH));
  bindClick('openTimer', () => openExtensionPage(TIMER_PATH));

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (
      namespace === 'sync' &&
      (changes.darkMode || changes.followSystemTheme)
    ) {
      void applyStoredTheme();
    }
  });
});

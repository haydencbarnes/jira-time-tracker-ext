import type { ThemeSettings } from './types';

interface ThemeSyncOptions {
  toggle?: HTMLButtonElement | null;
  afterInitialApply?: () => void;
  onSettingsApplied?: (settings: ThemeSettings) => void;
}

type ThemeStorageResult = {
  followSystemTheme?: boolean;
  darkMode?: boolean;
};

export function updateStandardThemeToggle(
  toggle: HTMLButtonElement | null | undefined,
  isDark: boolean
): void {
  const iconSpan = toggle?.querySelector<HTMLElement>('.icon');
  if (!toggle || !iconSpan) return;

  if (isDark) {
    iconSpan.textContent = '☀️';
    toggle.title = 'Switch to light mode';
  } else {
    iconSpan.textContent = '🌙';
    toggle.title = 'Switch to dark mode';
  }
}

function clearSystemThemeListener(): void {
  if (window._systemThemeListener) {
    window._systemThemeListener.onchange = null;
    window._systemThemeListener = null;
  }
}

function applyDarkMode(
  isDark: boolean,
  toggle?: HTMLButtonElement | null
): void {
  updateStandardThemeToggle(toggle, isDark);
  document.body.classList.toggle('dark-mode', isDark);
}

export function applyThemeSettings(
  settings: ThemeSettings,
  toggle?: HTMLButtonElement | null
): void {
  clearSystemThemeListener();

  if (settings.followSystemTheme) {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    applyDarkMode(mediaQuery.matches, toggle);
    mediaQuery.onchange = (event) => applyDarkMode(event.matches, toggle);
    window._systemThemeListener = mediaQuery;
    return;
  }

  applyDarkMode(settings.darkMode, toggle);
}

export function readStoredThemeSettings(): Promise<ThemeSettings> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      ['followSystemTheme', 'darkMode'],
      (result: ThemeStorageResult) =>
        resolve({
          followSystemTheme: result.followSystemTheme !== false,
          darkMode: result.darkMode === true,
        })
    );
  });
}

export async function applyStoredTheme(
  toggle?: HTMLButtonElement | null,
  onSettingsApplied?: (settings: ThemeSettings) => void
): Promise<void> {
  const settings = await readStoredThemeSettings();
  applyThemeSettings(settings, toggle);
  onSettingsApplied?.(settings);
}

export function initializeStoredThemeControls(
  options: ThemeSyncOptions = {}
): void {
  const { toggle, afterInitialApply, onSettingsApplied } = options;

  void applyStoredTheme(toggle, (settings) => {
    onSettingsApplied?.(settings);
    afterInitialApply?.();
  });

  toggle?.addEventListener('click', () => {
    const nextDarkMode = !document.body.classList.contains('dark-mode');
    const settings: ThemeSettings = {
      followSystemTheme: false,
      darkMode: nextDarkMode,
    };
    applyThemeSettings(settings, toggle);
    onSettingsApplied?.(settings);
    chrome.storage.sync.set({
      darkMode: nextDarkMode,
      followSystemTheme: false,
    });
  });

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (
      namespace === 'sync' &&
      ('followSystemTheme' in changes || 'darkMode' in changes)
    ) {
      void applyStoredTheme(toggle, onSettingsApplied);
    }
  });
}

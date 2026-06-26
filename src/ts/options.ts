import type {
  JiraType,
  OptionsPageSettings,
  SettingsChangedMessage,
} from './shared/types';

import { getRequiredElement } from './shared/dom-utils';
import { initPageViewLayout } from './shared/page-view-layout';
import { initializeStoredThemeControls } from './shared/theme-sync';

initPageViewLayout();

function getRequiredSelector<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element as T;
}

function getSyncStorage<T extends object>(defaults: T): Promise<T> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(defaults, (items) => resolve(items as T));
  });
}

function setSyncStorage(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.sync.set(items, () => resolve());
  });
}

type TextSettingStorageKey =
  | 'apiToken'
  | 'baseUrl'
  | 'frequentWorklogDescription1'
  | 'frequentWorklogDescription2'
  | 'username';

interface TextSettingControl {
  input: HTMLInputElement | HTMLTextAreaElement;
  saveButton: HTMLButtonElement;
  savedValue: string;
  storageKey: TextSettingStorageKey;
}

(function initOptionsPage() {
  const versionInput = getRequiredElement<HTMLInputElement>('version');
  const experimentalFeaturesToggle = getRequiredElement<HTMLInputElement>(
    'experimentalFeatures'
  );
  const issueDetectionToggle = getRequiredElement<HTMLInputElement>(
    'issueDetectionToggle'
  );
  const experimentalSlider = getRequiredSelector<HTMLSpanElement>(
    '#experimentalFeatures + .slider'
  );
  const jiraTypeSelect = getRequiredElement<HTMLSelectElement>('jiraType');
  const urlLabel = getRequiredElement<HTMLElement>('urlLabel');
  const baseUrlInput = getRequiredElement<HTMLInputElement>('baseUrl');
  const systemThemeToggle =
    getRequiredElement<HTMLInputElement>('systemThemeToggle');
  const pageViewToggle = getRequiredElement<HTMLInputElement>('pageViewToggle');
  const pageViewRow = getRequiredElement<HTMLElement>('pageViewRow');
  const floatingTimerWidgetToggle = getRequiredElement<HTMLInputElement>(
    'floatingTimerWidgetToggle'
  );
  const floatingTimerWidgetRow = getRequiredElement<HTMLElement>(
    'floatingTimerWidgetRow'
  );
  const usernameInput = getRequiredElement<HTMLInputElement>('username');
  const usernameVisibilityToggle = getRequiredElement<HTMLButtonElement>(
    'usernameVisibilityToggle'
  );
  const passwordInput = getRequiredElement<HTMLInputElement>('password');
  const frequentWorklogDescription1Input = getRequiredElement<HTMLInputElement>(
    'frequentWorklogDescription1'
  );
  const frequentWorklogDescription2Input = getRequiredElement<HTMLInputElement>(
    'frequentWorklogDescription2'
  );
  const defaultPageSelect =
    getRequiredElement<HTMLSelectElement>('defaultPage');
  const settingsNavButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-settings-page-target]')
  );
  const settingsPages = Array.from(
    document.querySelectorAll<HTMLElement>('[data-settings-page]')
  );
  const textSettingControls: TextSettingControl[] = [
    {
      input: baseUrlInput,
      saveButton: getRequiredSelector<HTMLButtonElement>(
        '[data-save-input="baseUrl"]'
      ),
      savedValue: '',
      storageKey: 'baseUrl',
    },
    {
      input: usernameInput,
      saveButton: getRequiredSelector<HTMLButtonElement>(
        '[data-save-input="username"]'
      ),
      savedValue: '',
      storageKey: 'username',
    },
    {
      input: passwordInput,
      saveButton: getRequiredSelector<HTMLButtonElement>(
        '[data-save-input="password"]'
      ),
      savedValue: '',
      storageKey: 'apiToken',
    },
    {
      input: frequentWorklogDescription1Input,
      saveButton: getRequiredSelector<HTMLButtonElement>(
        '[data-save-input="frequentWorklogDescription1"]'
      ),
      savedValue: '',
      storageKey: 'frequentWorklogDescription1',
    },
    {
      input: frequentWorklogDescription2Input,
      saveButton: getRequiredSelector<HTMLButtonElement>(
        '[data-save-input="frequentWorklogDescription2"]'
      ),
      savedValue: '',
      storageKey: 'frequentWorklogDescription2',
    },
  ];

  document.addEventListener('DOMContentLoaded', restoreOptions);
  document.addEventListener('DOMContentLoaded', () => {
    versionInput.value = chrome.runtime.getManifest().version;
  });

  initThemeControls();
  initSettingsNavigation();
  initEmailVisibilityToggle();
  initAutosaveControls();
  createExperimentalShapes();

  function createExperimentalShapes(): void {
    const shapeCount = 15;
    const shapes = ['circle', 'square', 'triangle'] as const;
    for (let i = 0; i < shapeCount; i += 1) {
      const shape = document.createElement('div');
      shape.className = `shape ${shapes[Math.floor(Math.random() * shapes.length)]}`;
      shape.style.left = `${Math.random() * 130 - 15}%`;
      shape.style.top = `${Math.random() * 130 - 15}%`;
      shape.style.width = `${Math.random() * 5 + 2}px`;
      shape.style.height = shape.style.width;
      shape.style.backgroundColor = `hsl(${Math.random() * 360}, 100%, 75%)`;
      shape.style.animation = `float ${Math.random() * 2 + 1}s infinite ease-in-out`;
      experimentalSlider.appendChild(shape);
    }
  }

  function initThemeControls(): void {
    document.addEventListener('DOMContentLoaded', async () => {
      const themeToggle = getRequiredElement<HTMLButtonElement>('themeToggle');
      initializeStoredThemeControls({
        toggle: themeToggle,
        onSettingsApplied: (settings) => {
          systemThemeToggle.checked = settings.followSystemTheme;
        },
      });

      systemThemeToggle.addEventListener('change', async () => {
        await setSyncStorage({
          followSystemTheme: systemThemeToggle.checked,
        });
      });
    });
  }

  function initSettingsNavigation(): void {
    showSettingsPage(settingsNavButtons[0]?.dataset.settingsPageTarget ?? '');

    settingsNavButtons.forEach((button, index) => {
      button.addEventListener('click', () => {
        showSettingsPage(button.dataset.settingsPageTarget ?? '');
      });

      button.addEventListener('keydown', (event) => {
        if (
          !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(
            event.key
          )
        ) {
          return;
        }

        event.preventDefault();
        const direction =
          event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
        const nextIndex =
          (index + direction + settingsNavButtons.length) %
          settingsNavButtons.length;
        const nextButton = settingsNavButtons[nextIndex];
        nextButton.focus();
        showSettingsPage(nextButton.dataset.settingsPageTarget ?? '');
      });
    });
  }

  function initEmailVisibilityToggle(): void {
    usernameVisibilityToggle.addEventListener('click', () => {
      const isVisible = usernameInput.type === 'text';
      usernameInput.type = isVisible ? 'password' : 'text';
      usernameVisibilityToggle.setAttribute(
        'aria-label',
        isVisible ? 'Show email' : 'Hide email'
      );
      usernameVisibilityToggle.title = isVisible ? 'Show email' : 'Hide email';
      usernameVisibilityToggle
        .querySelector<HTMLElement>('.visibility-icon-show')
        ?.toggleAttribute('hidden', !isVisible);
      usernameVisibilityToggle
        .querySelector<HTMLElement>('.visibility-icon-hide')
        ?.toggleAttribute('hidden', isVisible);
    });
  }

  function showSettingsPage(pageName: string): void {
    settingsNavButtons.forEach((button) => {
      const isSelected = button.dataset.settingsPageTarget === pageName;
      button.setAttribute('aria-selected', String(isSelected));
      button.tabIndex = isSelected ? 0 : -1;
    });

    settingsPages.forEach((page) => {
      const isSelected = page.dataset.settingsPage === pageName;
      page.classList.toggle('is-active', isSelected);
      page.hidden = !isSelected;
    });
  }

  function initAutosaveControls(): void {
    textSettingControls.forEach((control) => {
      control.input.addEventListener('input', () => {
        updateInlineSaveButton(control);
      });

      control.saveButton.addEventListener('click', () => {
        void saveTextSetting(control);
      });
    });

    jiraTypeSelect.addEventListener('change', () => {
      onJiraTypeChange();
      void setSyncStorage({
        jiraType: jiraTypeSelect.value as JiraType,
      });
    });

    defaultPageSelect.addEventListener('change', () => {
      void setSyncStorage({
        defaultPage: defaultPageSelect.value,
      });
    });

    issueDetectionToggle.addEventListener('change', () => {
      void saveFeatureSettings();
    });

    experimentalFeaturesToggle.addEventListener(
      'change',
      onExperimentalToggleChange
    );
    pageViewToggle.addEventListener('change', () => {
      void saveFeatureSettings();
    });
    floatingTimerWidgetToggle.addEventListener('change', () => {
      void saveFeatureSettings();
    });
  }

  function updateInlineSaveButton(control: TextSettingControl): void {
    control.saveButton.hidden = control.input.value === control.savedValue;
  }

  async function saveTextSetting(control: TextSettingControl): Promise<void> {
    control.saveButton.disabled = true;
    await setSyncStorage({
      [control.storageKey]: control.input.value,
    });
    control.savedValue = control.input.value;
    control.saveButton.disabled = false;
    updateInlineSaveButton(control);
  }

  function onExperimentalToggleChange(): void {
    const isEnabled = experimentalFeaturesToggle.checked;
    experimentalSlider
      .querySelectorAll<HTMLElement>('.shape')
      .forEach((shape) => {
        shape.style.opacity = isEnabled ? '1' : '0';
      });
    setExperimentalRowsVisible(isEnabled);

    if (!isEnabled) {
      pageViewToggle.checked = false;
      floatingTimerWidgetToggle.checked = false;
    }

    void saveFeatureSettings();
  }

  function onJiraTypeChange(): void {
    if (jiraTypeSelect.value === 'server') {
      baseUrlInput.placeholder = 'https://your-jira-server.com';
      urlLabel.textContent = 'Jira Server URL';
    } else {
      baseUrlInput.placeholder = 'https://your-domain.atlassian.net';
      urlLabel.textContent = 'Jira Cloud URL';
    }
  }

  function setExperimentalRowsVisible(isVisible: boolean): void {
    const display = isVisible ? '' : 'none';
    pageViewRow.style.display = display;
    floatingTimerWidgetRow.style.display = display;
  }

  function markTextSettingsSaved(): void {
    textSettingControls.forEach((control) => {
      control.savedValue = control.input.value;
      updateInlineSaveButton(control);
    });
  }

  async function notifyTabs(message: SettingsChangedMessage): Promise<void> {
    const tabs = await chrome.tabs.query({});
    tabs.forEach((tab) => {
      if (typeof tab.id !== 'number') {
        return;
      }

      chrome.tabs.sendMessage(tab.id, message, () => {
        if (chrome.runtime.lastError) {
          // Expected for pages without content scripts.
        }
      });
    });
  }

  async function saveFeatureSettings(): Promise<void> {
    const experimentalFeatures = experimentalFeaturesToggle.checked;
    const issueDetectionEnabled = issueDetectionToggle.checked;
    const pageViewNewTabEnabled =
      experimentalFeatures && pageViewToggle.checked;
    const floatingTimerWidgetEnabled =
      experimentalFeatures && floatingTimerWidgetToggle.checked;

    await setSyncStorage({
      experimentalFeatures,
      issueDetectionEnabled,
      pageViewNewTabEnabled,
      floatingTimerWidgetEnabled,
    });

    await notifyTabs({
      type: 'SETTINGS_CHANGED',
      experimentalFeatures,
      issueDetectionEnabled,
      floatingTimerWidgetEnabled,
    });
  }

  async function restoreOptions(): Promise<void> {
    const items = await getSyncStorage<OptionsPageSettings>({
      jiraType: 'cloud',
      username: '',
      apiToken: '',
      baseUrl: '',
      experimentalFeatures: false,
      issueDetectionEnabled: true,
      frequentWorklogDescription1: '',
      frequentWorklogDescription2: '',
      defaultPage: 'popup.html',
      followSystemTheme: true,
      pageViewNewTabEnabled: false,
      floatingTimerWidgetEnabled: false,
      darkMode: false,
    });

    jiraTypeSelect.value = items.jiraType;
    usernameInput.value = items.username;
    passwordInput.value = items.apiToken;
    baseUrlInput.value = items.baseUrl;
    experimentalFeaturesToggle.checked = items.experimentalFeatures ?? false;
    issueDetectionToggle.checked = items.issueDetectionEnabled !== false;
    frequentWorklogDescription1Input.value = items.frequentWorklogDescription1;
    frequentWorklogDescription2Input.value = items.frequentWorklogDescription2;
    defaultPageSelect.value = items.defaultPage;
    systemThemeToggle.checked = items.followSystemTheme;
    setExperimentalRowsVisible(items.experimentalFeatures ?? false);
    pageViewToggle.checked = !!(
      items.experimentalFeatures && items.pageViewNewTabEnabled
    );
    floatingTimerWidgetToggle.checked = !!(
      items.experimentalFeatures && items.floatingTimerWidgetEnabled
    );
    markTextSettingsSaved();
    onJiraTypeChange();
  }
})();

export {};

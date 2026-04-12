import type {
  JiraType,
  OptionsPageSettings,
  SettingsChangedMessage,
} from './shared/types';

import { getRequiredElement } from './shared/dom-utils';
import { initializeStoredThemeControls } from './shared/theme-sync';

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

(function initOptionsPage() {
  const saveButton = getRequiredElement<HTMLButtonElement>('save');
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
  const urlRow = getRequiredElement<HTMLTableRowElement>('urlRow');
  const baseUrlInput = getRequiredElement<HTMLInputElement>('baseUrl');
  const systemThemeToggle =
    getRequiredElement<HTMLInputElement>('systemThemeToggle');
  const sidePanelToggle =
    getRequiredElement<HTMLInputElement>('sidePanelToggle');
  const sidePanelRow = getRequiredElement<HTMLTableRowElement>('sidePanelRow');
  const floatingTimerWidgetToggle = getRequiredElement<HTMLInputElement>(
    'floatingTimerWidgetToggle'
  );
  const floatingTimerWidgetRow = getRequiredElement<HTMLTableRowElement>(
    'floatingTimerWidgetRow'
  );
  const usernameInput = getRequiredElement<HTMLInputElement>('username');
  const passwordInput = getRequiredElement<HTMLInputElement>('password');
  const frequentWorklogDescription1Input = getRequiredElement<HTMLInputElement>(
    'frequentWorklogDescription1'
  );
  const frequentWorklogDescription2Input = getRequiredElement<HTMLInputElement>(
    'frequentWorklogDescription2'
  );
  const defaultPageSelect =
    getRequiredElement<HTMLSelectElement>('defaultPage');
  const statusElement = getRequiredElement<HTMLDivElement>('status');

  document.addEventListener('DOMContentLoaded', restoreOptions);
  document.addEventListener('DOMContentLoaded', () => {
    versionInput.value = chrome.runtime.getManifest().version;
  });
  saveButton.addEventListener('click', saveOptions);

  initThemeControls();
  createExperimentalShapes();

  experimentalFeaturesToggle.addEventListener(
    'change',
    onExperimentalToggleChange
  );
  jiraTypeSelect.addEventListener('change', onJiraTypeChange);

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

  function onExperimentalToggleChange(): void {
    const isEnabled = experimentalFeaturesToggle.checked;
    experimentalSlider
      .querySelectorAll<HTMLElement>('.shape')
      .forEach((shape) => {
        shape.style.opacity = isEnabled ? '1' : '0';
      });
    sidePanelRow.style.display = isEnabled ? 'table-row' : 'none';
    floatingTimerWidgetRow.style.display = isEnabled ? 'table-row' : 'none';

    if (!isEnabled) {
      sidePanelToggle.checked = false;
      floatingTimerWidgetToggle.checked = false;
      chrome.storage.sync.set({
        sidePanelEnabled: false,
        floatingTimerWidgetEnabled: false,
      });
    }
  }

  function onJiraTypeChange(): void {
    const urlLabel = urlRow.querySelector<HTMLElement>('td:first-child b');
    if (jiraTypeSelect.value === 'server') {
      baseUrlInput.placeholder = 'https://your-jira-server.com';
      if (urlLabel) {
        urlLabel.textContent = 'Jira Server URL*';
      }
    } else {
      baseUrlInput.placeholder = 'https://your-domain.atlassian.net';
      if (urlLabel) {
        urlLabel.textContent = 'Jira Cloud URL*';
      }
    }
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

  async function saveOptions(): Promise<void> {
    const experimentalFeatures = experimentalFeaturesToggle.checked;
    const issueDetectionEnabled = issueDetectionToggle.checked;
    const sidePanelEnabled = experimentalFeatures && sidePanelToggle.checked;
    const floatingTimerWidgetEnabled =
      experimentalFeatures && floatingTimerWidgetToggle.checked;

    await setSyncStorage({
      jiraType: jiraTypeSelect.value as JiraType,
      username: usernameInput.value,
      apiToken: passwordInput.value,
      baseUrl: baseUrlInput.value,
      experimentalFeatures,
      issueDetectionEnabled,
      frequentWorklogDescription1: frequentWorklogDescription1Input.value,
      frequentWorklogDescription2: frequentWorklogDescription2Input.value,
      defaultPage: defaultPageSelect.value,
      sidePanelEnabled,
      floatingTimerWidgetEnabled,
    });

    await notifyTabs({
      type: 'SETTINGS_CHANGED',
      experimentalFeatures,
      issueDetectionEnabled,
      floatingTimerWidgetEnabled,
    });

    statusElement.textContent = 'Options saved.';
    window.setTimeout(() => {
      statusElement.textContent = '';
    }, 1000);
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
      sidePanelEnabled: false,
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
    sidePanelRow.style.display = items.experimentalFeatures
      ? 'table-row'
      : 'none';
    sidePanelToggle.checked = !!(
      items.experimentalFeatures && items.sidePanelEnabled
    );
    floatingTimerWidgetRow.style.display = items.experimentalFeatures
      ? 'table-row'
      : 'none';
    floatingTimerWidgetToggle.checked = !!(
      items.experimentalFeatures && items.floatingTimerWidgetEnabled
    );
    jiraTypeSelect.dispatchEvent(new Event('change'));
  }
})();

export {};

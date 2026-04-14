import { JiraAPI } from '../shared/jira-api';
import type {
  BackgroundWorklogRequest,
  BackgroundWorklogResponse,
} from '../shared/types';

const POPUP_PATH = 'dist/popup.html';
const TIMER_PAGE_PATH = 'dist/timerFeatureModule/timer.html';

type BackgroundMessage =
  | { action: 'startTimer'; seconds: number }
  | { action: 'stopTimer' }
  | { action: 'resetTimer' }
  | { action: 'updateBadge'; seconds: number; isRunning: boolean }
  | { action: 'syncTime'; seconds: number; isRunning: boolean }
  | { action: 'openUrl'; url: string }
  | BackgroundWorklogRequest;

let badgeUpdateInterval: number | null = null;
let currentSeconds = 0;
let isRunning = false;

async function applyToolbarActionMode(openTimerPageInNewTab: boolean): Promise<void> {
  try {
    if (openTimerPageInNewTab) {
      await chrome.action.setPopup({ popup: '' });
    } else {
      await chrome.action.setPopup({ popup: POPUP_PATH });
    }
  } catch (error) {
    console.error(error);
  }
}

async function initToolbarActionFromStorage(): Promise<void> {
  const items = await new Promise<{ pageViewNewTabEnabled: boolean }>(
    (resolve) => {
      chrome.storage.sync.get({ pageViewNewTabEnabled: false }, (result) => {
        resolve(result as { pageViewNewTabEnabled: boolean });
      });
    }
  );

  await applyToolbarActionMode(items.pageViewNewTabEnabled === true);
}

void initToolbarActionFromStorage();

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.pageViewNewTabEnabled) {
    void applyToolbarActionMode(changes.pageViewNewTabEnabled.newValue === true);
  }
});

chrome.action.onClicked.addListener((tab) => {
  void focusOrOpenTimerTab(tab);
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const message = request as BackgroundMessage;

  switch (message.action) {
    case 'startTimer':
      startBadgeUpdate(message.seconds);
      return false;
    case 'stopTimer':
      stopBadgeUpdate();
      return false;
    case 'resetTimer':
      resetBadge();
      return false;
    case 'updateBadge':
      updateBadge(message.seconds, message.isRunning);
      return false;
    case 'syncTime':
      syncTime(message.seconds, message.isRunning);
      return false;
    case 'openUrl':
      openUrlInTab(message.url, sender.tab);
      return false;
    case 'logWorklog':
      void handleWorklogRequest(
        message,
        sendResponse as (response: BackgroundWorklogResponse) => void
      );
      return true;
    default:
      return false;
  }
});

/** Timer full-page URL (singleton: focus existing tab instead of opening duplicates). */
function getTimerPageUrl(): string {
  return chrome.runtime.getURL(TIMER_PAGE_PATH);
}

async function focusOrOpenTimerTab(refTab?: chrome.tabs.Tab): Promise<void> {
  const timerUrl = getTimerPageUrl();
  const urlPrefix = timerUrl.split(/[?#]/)[0] ?? timerUrl;

  try {
    const allTabs = await chrome.tabs.query({});
    const matches = allTabs.filter(
      (t) => typeof t.url === 'string' && t.url.startsWith(urlPrefix)
    );
    if (matches.length > 0) {
      const existing = matches.sort(
        (a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)
      )[0];
      if (existing?.id != null) {
        await chrome.tabs.update(existing.id, { active: true });
        if (existing.windowId != null) {
          await chrome.windows.update(existing.windowId, { focused: true });
        }
        return;
      }
    }
  } catch (error) {
    console.error('focusOrOpenTimerTab:', error);
  }

  openUrlInTab(timerUrl, refTab);
}

function openUrlInTab(url: string, refTab?: chrome.tabs.Tab): void {
  if (!url) return;

  const createProperties: chrome.tabs.CreateProperties = { url };
  if (refTab?.windowId != null) {
    createProperties.windowId = refTab.windowId;
    if (typeof refTab.index === 'number') {
      createProperties.index = refTab.index + 1;
    }
  }

  chrome.tabs.create(createProperties, () => {
    if (chrome.runtime.lastError) {
      console.error(
        'Failed to open URL from background:',
        chrome.runtime.lastError.message
      );
    }
  });
}

function getErrorResponse(error: unknown): BackgroundWorklogResponse {
  if (error instanceof Error) {
    const errorWithStatus = error as Error & { status?: number };
    return {
      success: false,
      error: {
        message: error.message,
        status: errorWithStatus.status ?? 0,
      },
    };
  }

  return {
    success: false,
    error: {
      message: 'Unknown background worklog error',
      status: 0,
    },
  };
}

async function handleWorklogRequest(
  request: BackgroundWorklogRequest,
  sendResponse: (response: BackgroundWorklogResponse) => void
): Promise<void> {
  try {
    const jira = await JiraAPI(
      request.settings.jiraType,
      request.settings.baseUrl,
      request.settings.username,
      request.settings.apiToken
    );

    const result = await jira.updateWorklog(
      request.issueId,
      request.timeInSeconds,
      request.startedTime,
      request.comment
    );

    sendResponse({ success: true, result });
  } catch (error) {
    console.error('Background worklog error:', error);
    sendResponse(getErrorResponse(error));
  }
}

function clearBadgeInterval(): void {
  if (badgeUpdateInterval !== null) {
    clearInterval(badgeUpdateInterval);
    badgeUpdateInterval = null;
  }
}

function startBadgeUpdate(seconds: number): void {
  currentSeconds = seconds;
  isRunning = true;
  updateBadge(currentSeconds, isRunning);
  clearBadgeInterval();
  badgeUpdateInterval = setInterval(() => {
    currentSeconds += 1;
    updateBadge(currentSeconds, isRunning);
  }, 1000);
}

function stopBadgeUpdate(): void {
  clearBadgeInterval();
  isRunning = false;
  updateBadge(currentSeconds, isRunning);
}

function resetBadge(): void {
  clearBadgeInterval();
  currentSeconds = 0;
  isRunning = false;
  updateBadge(currentSeconds, isRunning);
}

function syncTime(seconds: number, running: boolean): void {
  currentSeconds = seconds;
  isRunning = running;
  if (isRunning) {
    startBadgeUpdate(currentSeconds);
  } else {
    stopBadgeUpdate();
  }
}

function updateBadge(seconds: number, running: boolean): void {
  if (!running) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  let badgeText = '';
  if (hours > 0) {
    badgeText = `${hours}h${minutes.toString().padStart(2, '0')}`;
  } else if (minutes > 0) {
    badgeText = `${minutes}m`;
  } else {
    badgeText = `${seconds}s`;
  }

  if (badgeText.length > 4) {
    badgeText = badgeText.substring(0, 4);
  }

  chrome.action.setBadgeText({ text: badgeText });
  chrome.action.setBadgeBackgroundColor({ color: '#0052CC' });
}

export {};

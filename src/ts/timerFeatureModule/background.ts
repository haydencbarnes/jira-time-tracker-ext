import { JiraAPI } from '../shared/jira-api';
import type {
  BackgroundWorklogRequest,
  BackgroundWorklogResponse,
} from '../shared/types';

type BackgroundMessage =
  | { action: 'startTimer'; seconds: number }
  | { action: 'stopTimer' }
  | { action: 'resetTimer' }
  | { action: 'updateBadge'; seconds: number; isRunning: boolean }
  | { action: 'syncTime'; seconds: number; isRunning: boolean }
  | { action: 'openSidePanel' }
  | { action: 'openUrl'; url: string }
  | BackgroundWorklogRequest;

let badgeUpdateInterval: number | null = null;
let currentSeconds = 0;
let isRunning = false;

async function initSidePanelBehavior(): Promise<void> {
  const items = await new Promise<{ sidePanelEnabled: boolean }>((resolve) => {
    chrome.storage.sync.get({ sidePanelEnabled: false }, (result) => {
      resolve(result as { sidePanelEnabled: boolean });
    });
  });

  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: items.sidePanelEnabled })
    .catch((error) => console.error(error));
}

void initSidePanelBehavior();

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.sidePanelEnabled) {
    void chrome.sidePanel
      .setPanelBehavior({
        openPanelOnActionClick: changes.sidePanelEnabled.newValue === true,
      })
      .catch((error) => console.error(error));
  }
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
    case 'openSidePanel':
      if (sender.tab?.windowId) {
        void chrome.sidePanel.open({ windowId: sender.tab.windowId });
      }
      return false;
    case 'openUrl':
      openUrlInTab(message.url, sender);
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

function openUrlInTab(
  url: string,
  sender?: chrome.runtime.MessageSender
): void {
  if (!url) return;

  const createProperties: chrome.tabs.CreateProperties = { url };
  if (sender?.tab?.windowId) {
    createProperties.windowId = sender.tab.windowId;
    if (typeof sender.tab.index === 'number') {
      createProperties.index = sender.tab.index + 1;
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
    window.clearInterval(badgeUpdateInterval);
    badgeUpdateInterval = null;
  }
}

function startBadgeUpdate(seconds: number): void {
  currentSeconds = seconds;
  isRunning = true;
  updateBadge(currentSeconds, isRunning);
  clearBadgeInterval();
  badgeUpdateInterval = window.setInterval(() => {
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

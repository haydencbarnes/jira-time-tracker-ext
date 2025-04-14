let badgeUpdateInterval;
let currentSeconds = 0;
let isRunning = false;

// Initialize side panel behavior based on user preference
chrome.storage.sync.get({ sidePanelEnabled: false }, function(items) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: items.sidePanelEnabled })
    .catch((error) => console.error(error));
});

// Listen for changes to side panel setting
chrome.storage.onChanged.addListener(function(changes, namespace) {
  if (namespace === 'sync' && changes.sidePanelEnabled) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: changes.sidePanelEnabled.newValue })
      .catch((error) => console.error(error));
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startTimer') {
    startBadgeUpdate(request.seconds);
  } else if (request.action === 'stopTimer') {
    stopBadgeUpdate();
  } else if (request.action === 'resetTimer') {
    resetBadge();
  } else if (request.action === 'updateBadge') {
    updateBadge(request.seconds, request.isRunning);
  } else if (request.action === 'syncTime') {
    syncTime(request.seconds, request.isRunning);
  } else if (request.action === 'openSidePanel') {
    chrome.sidePanel.open({ windowId: sender.tab.windowId });
  }
});

function startBadgeUpdate(seconds) {
  currentSeconds = seconds;
  isRunning = true;
  updateBadge(currentSeconds, isRunning);
  clearInterval(badgeUpdateInterval);
  badgeUpdateInterval = setInterval(() => {
    currentSeconds++;
    updateBadge(currentSeconds, isRunning);
  }, 1000);
}

function stopBadgeUpdate() {
  clearInterval(badgeUpdateInterval);
  isRunning = false;
  updateBadge(currentSeconds, isRunning);
}

function resetBadge() {
  clearInterval(badgeUpdateInterval);
  currentSeconds = 0;
  isRunning = false;
  updateBadge(currentSeconds, isRunning);
}

function syncTime(seconds, running) {
  currentSeconds = seconds;
  isRunning = running;
  if (isRunning) {
    startBadgeUpdate(currentSeconds);
  } else {
    stopBadgeUpdate();
  }
}

function updateBadge(seconds, isRunning) {
  if (!isRunning) {
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

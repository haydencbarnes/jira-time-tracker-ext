let badgeUpdateInterval;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startTimer') {
    startBadgeUpdate(request.seconds);
  } else if (request.action === 'stopTimer') {
    stopBadgeUpdate();
  } else if (request.action === 'resetTimer') {
    resetBadge();
  } else if (request.action === 'updateBadge') {
    updateBadge(request.seconds, request.isRunning);
  }
});

function startBadgeUpdate(initialSeconds) {
  updateBadge(initialSeconds, true);
  badgeUpdateInterval = setInterval(() => {
    initialSeconds++;
    updateBadge(initialSeconds, true);
  }, 1000);
}

function stopBadgeUpdate() {
  clearInterval(badgeUpdateInterval);
}

function resetBadge() {
  stopBadgeUpdate();
  updateBadge(0, false);
}

function updateBadge(seconds, isRunning) {
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

  // Truncate the badge text if it's too long
  if (badgeText.length > 4) {
    badgeText = badgeText.substring(0, 4);
  }

  chrome.action.setBadgeText({ text: badgeText });
  chrome.action.setBadgeBackgroundColor({ color: isRunning ? '#0052CC' : '#F44336' });
}

let timer;
let isRunning = false;
let seconds = 0;
let JIRA;

document.addEventListener('DOMContentLoaded', onDOMContentLoaded);

async function onDOMContentLoaded() {
  chrome.storage.sync.get({
    apiToken: '',
    baseUrl: '',
    projectId: '',
    issueKey: '',
    username: '',
    jiraType: 'server',
    frequentWorklogDescription1: '',
    frequentWorklogDescription2: ''
  }, async (options) => {
    console.log('Storage options:', options);
    await init(options);

    document.getElementById('startStop').addEventListener('click', toggleTimer);
    document.getElementById('reset').addEventListener('click', resetTimer);
    document.getElementById('logTime').addEventListener('click', logTimeClick);

    // Restore saved project and issue
    if (options.projectId) {
      document.getElementById('projectId').value = options.projectId;
    }
    if (options.issueKey) {
      document.getElementById('issueKey').value = options.issueKey;
    }

    insertFrequentWorklogDescription(options);

    restoreTimerState();
    syncTimeWithBackground();
  });
}

async function init(options) {
  console.log("Options received:", options);

  try {
    JIRA = await JiraAPI(options.jiraType, options.baseUrl, options.username, options.apiToken);
    console.log("JIRA API Object initialized:", JIRA);

    if (!JIRA || typeof JIRA.getProjects !== 'function' || typeof JIRA.getIssues !== 'function') {
      console.error('JIRA API instantiation failed: Methods missing', JIRA);
      displayError('JIRA API instantiation failed.');
      return;
    }

    await setupAutocomplete(JIRA);
  } catch (error) {
    console.error('Error initializing JIRA API:', error);
    displayError('Initialization failed. (Settings may need set up.)');
  }
}

async function setupAutocomplete(JIRA) {
  const projectInput = document.getElementById('projectId');
  const issueInput = document.getElementById('issueKey');
  const projectList = document.getElementById('projectList');
  const issueList = document.getElementById('issueList');

  let projectsResponse = await JIRA.getProjects();
  let projects = projectsResponse.data;
  let projectMap = new Map(projects.map(p => [p.key, p]));

  setupDropdownArrow(projectInput);
  setupDropdownArrow(issueInput);
  setupInputFocus(projectInput);
  setupInputFocus(issueInput);

  autocomplete(projectInput, projects.map(p => `${p.key}: ${p.name}`), projectList, async (selected) => {
    let selectedKey = selected.split(':')[0].trim();
    let selectedProject = projectMap.get(selectedKey);
    if (selectedProject) {
      let jql = `project=${selectedProject.key}`;
      let issuesResponse = await JIRA.getIssues(0, jql);
      let issues = issuesResponse.data;
      autocomplete(issueInput, issues.map(i => `${i.key}: ${i.fields.summary}`), issueList, (selectedIssue) => {
        chrome.storage.sync.set({ issueKey: selectedIssue.split(':')[0].trim() });
        issueInput.value = selectedIssue;
      });
    }
    // Save selected project
    chrome.storage.sync.set({ projectId: selectedKey });
  });
}

function setupDropdownArrow(input) {
  const arrow = input.nextElementSibling;
  arrow.addEventListener('click', (event) => {
    event.stopPropagation();
    input.focus();
    toggleDropdown(input);
  });
}

function toggleDropdown(input) {
  const event = new Event('toggleDropdown', { bubbles: true });
  input.dispatchEvent(event);
}

function autocomplete(inp, arr, listElement, onSelect = null) {
  let currentFocus;
  let isOpen = false;
  
  inp.addEventListener("input", function(e) {
    showDropdown(this.value);
  });

  inp.addEventListener("toggleDropdown", function(e) {
    if (isOpen) {
      closeAllLists();
    } else {
      showDropdown('');
    }
  });

  function showDropdown(val) {
    closeAllLists();
    currentFocus = -1;
    isOpen = true;
    
    let matches = arr.filter(item => item.toLowerCase().includes(val.toLowerCase()));
    if (matches.length === 0 && !val) {
      matches = arr; // Show all options if input is empty
    }
    matches.forEach(item => {
      let li = document.createElement("li");
      li.innerHTML = item;
      li.addEventListener("click", function(e) {
        inp.value = this.innerHTML;
        closeAllLists();
        if (onSelect) onSelect(this.innerHTML);
      });
      listElement.appendChild(li);
    });
  }

  inp.addEventListener("keydown", function(e) {
    let x = listElement.getElementsByTagName("li");
    if (e.keyCode == 40) {
      currentFocus++;
      addActive(x);
    } else if (e.keyCode == 38) {
      currentFocus--;
      addActive(x);
    } else if (e.keyCode == 13) {
      e.preventDefault();
      if (currentFocus > -1) {
        if (x) x[currentFocus].click();
      }
    }
  });

  function addActive(x) {
    if (!x) return false;
    removeActive(x);
    if (currentFocus >= x.length) currentFocus = 0;
    if (currentFocus < 0) currentFocus = (x.length - 1);
    x[currentFocus].classList.add("autocomplete-active");
  }

  function removeActive(x) {
    for (var i = 0; i < x.length; i++) {
      x[i].classList.remove("autocomplete-active");
    }
  }

  function closeAllLists(elmnt) {
    var x = document.getElementsByClassName("autocomplete-list");
    for (var i = 0; i < x.length; i++) {
      if (elmnt != x[i] && elmnt != inp) {
        x[i].innerHTML = '';
      }
    }
    isOpen = false;
  }

  document.addEventListener("click", function (e) {
    if (e.target !== inp && e.target !== inp.nextElementSibling) {
      closeAllLists(e.target);
    }
  });
}

function setupInputFocus(input) {
  input.addEventListener("focus", function(e) {
    if (!this.value) {
      toggleDropdown(this);
    }
  });
}

function toggleTimer() {
  const startStopButton = document.getElementById('startStop');
  const startStopIcon = document.getElementById('startStopIcon');
  const timerAnimation = document.getElementById('timer-animation');

  if (isRunning) {
    clearInterval(timer);
    startStopIcon.textContent = 'play_arrow';
    timerAnimation.style.display = 'none';
    chrome.runtime.sendMessage({ action: 'stopTimer' });
  } else {
    timer = setInterval(updateTimer, 1000);
    startStopIcon.textContent = 'stop';
    timerAnimation.style.display = 'block';
    chrome.runtime.sendMessage({ action: 'startTimer', seconds: seconds });
  }

  isRunning = !isRunning;
  saveTimerState();
}

function updateTimer() {
  seconds++;
  updateTimerDisplay();
  chrome.runtime.sendMessage({ action: 'syncTime', seconds: seconds, isRunning: isRunning });
  if (seconds % 5 === 0) {  // Save every 5 seconds
    saveTimerState();
  }
}

function updateTimerDisplay() {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  document.getElementById('timer').textContent = 
    `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
}

function resetTimer() {
  clearInterval(timer);
  isRunning = false;
  seconds = 0;
  updateTimerDisplay();
  const startStopIcon = document.getElementById('startStopIcon');
  const timerAnimation = document.getElementById('timer-animation');
  startStopIcon.textContent = 'play_arrow';
  timerAnimation.style.display = 'none';
  chrome.runtime.sendMessage({ action: 'resetTimer' });
  chrome.storage.sync.remove(['timerSeconds', 'timerIsRunning', 'timerLastUpdated']);
}

function pad(num) {
  return num.toString().padStart(2, '0');
}

async function logTimeClick() {
  const issueKey = document.getElementById('issueKey').value.split(':')[0].trim();
  const timeSpent = secondsToJiraFormat(seconds);
  const description = document.getElementById('description').value;

  console.log("Logging time with parameters:", { issueKey, timeSpent, description });

  try {
    const startedTime = new Date().toISOString();
    await JIRA.updateWorklog(issueKey, seconds, startedTime, description);
    displaySuccess(`You successfully logged: ${timeSpent} on ${issueKey}`);
    
    document.getElementById('description').value = '';
    resetTimer();
  } catch (error) {
    if (error.message.includes('API request failed: Error 400: Worklog must not be null.')) {
      displayError('Error logging time: API request failed: Please stop the current timer before submitting time.');
    } else {
      console.error('Error logging time:', error);
      displayError(`Error logging time: ${error.message}`);
    }
  }
}

function secondsToJiraFormat(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  let result = '';
  if (hours > 0) result += `${hours}h `;
  if (minutes > 0) result += `${minutes}m `;
  if (seconds > 0) result += `${seconds}s`;

  return result.trim();
}

function displayError(message) {
  const error = document.getElementById('error');
  error.innerText = message;
  error.style.display = 'block';
  document.getElementById('success').style.display = 'none';
}

function displaySuccess(message) {
  const success = document.getElementById('success');
  success.innerText = message;
  success.style.display = 'block';
  document.getElementById('error').style.display = 'none';
}

function saveTimerState() {
  chrome.storage.sync.set({
    timerSeconds: seconds,
    timerIsRunning: isRunning,
    timerLastUpdated: new Date().getTime()
  });
}

function restoreTimerState() {
  chrome.storage.sync.get({
    timerSeconds: 0,
    timerIsRunning: false,
    timerLastUpdated: null
  }, function(items) {
    seconds = items.timerSeconds;
    isRunning = items.timerIsRunning;

    if (isRunning && items.timerLastUpdated) {
      const elapsedSeconds = Math.floor((new Date().getTime() - items.timerLastUpdated) / 1000);
      seconds += elapsedSeconds;
    }

    updateTimerDisplay();
    chrome.runtime.sendMessage({ action: 'updateBadge', seconds: seconds, isRunning: isRunning });
    const startStopIcon = document.getElementById('startStopIcon');
    const timerAnimation = document.getElementById('timer-animation');
    if (isRunning) {
      timer = setInterval(updateTimer, 1000);
      startStopIcon.textContent = 'stop';
      timerAnimation.style.display = 'block';
      chrome.runtime.sendMessage({ action: 'startTimer', seconds: seconds });
    } else {
      startStopIcon.textContent = 'play_arrow';
      timerAnimation.style.display = 'none';
    }
  });
}

document.getElementById('add15min').addEventListener('click', function() {
  addTime(15 * 60);  // Add 15 minutes in seconds
});

document.getElementById('add30min').addEventListener('click', function() {
  addTime(30 * 60);  // Add 30 minutes in seconds
});

document.getElementById('add1hr').addEventListener('click', function() {
  addTime(60 * 60);  // Add 1 hour in seconds
});

document.getElementById('addCustomTime').addEventListener('click', function() {
  const customMinutes = parseInt(document.getElementById('customTime').value, 10);
  if (!isNaN(customMinutes)) {
    addTime(customMinutes * 60);  // Convert custom minutes to seconds and add
  }
});

function addTime(secondsToAdd) {
  seconds += secondsToAdd;
  updateTimerDisplay();
  chrome.runtime.sendMessage({ action: 'syncTime', seconds: seconds, isRunning: isRunning });
  saveTimerState();
}

function insertFrequentWorklogDescription(options) {
  const frequentWorklogDescription1 = document.getElementById('frequentWorklogDescription1');
  const frequentWorklogDescription2 = document.getElementById('frequentWorklogDescription2');
  const descriptionField = document.getElementById('description');
  
  if (!descriptionField) {
    console.error('Description field not found');
    return;
  }
  
  function hideButtons() {
    if (frequentWorklogDescription1) frequentWorklogDescription1.style.display = 'none';
    if (frequentWorklogDescription2) frequentWorklogDescription2.style.display = 'none';
  }
  
  function showButtons() {
    if (frequentWorklogDescription1) frequentWorklogDescription1.style.display = 'block';
    if (frequentWorklogDescription2) frequentWorklogDescription2.style.display = 'block';
  }
  
  if (frequentWorklogDescription1) {
    frequentWorklogDescription1.addEventListener('click', function() {
      descriptionField.value = options.frequentWorklogDescription1;
      console.log('frequentWorklogDescription1 clicked');
      hideButtons();
    });
  } else {
    console.warn('frequentWorklogDescription1 not found');
  }
  
  if (frequentWorklogDescription2) {
    frequentWorklogDescription2.addEventListener('click', function() {
      descriptionField.value = options.frequentWorklogDescription2;
      console.log('frequentWorklogDescription2 clicked');
      hideButtons();
    });
  } else {
    console.warn('frequentWorklogDescription2 not found');
  }
  
  descriptionField.addEventListener('input', function() {
    console.log('User started typing in the description field');
    if (descriptionField.value === '') {
      showButtons();
    } else {
      hideButtons();
    }
  });
}

function syncTimeWithBackground() {
  chrome.runtime.sendMessage({ action: 'syncTime', seconds: seconds, isRunning: isRunning });
}
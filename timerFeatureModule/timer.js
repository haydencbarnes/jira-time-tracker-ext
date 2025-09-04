let timer;
let isRunning = false;
let seconds = 0;
let JIRA;

(function immediateTheme() {
    // Synchronously read theme from storage (best effort, may be async, but runs before DOMContentLoaded)
    chrome.storage && chrome.storage.sync && chrome.storage.sync.get && chrome.storage.sync.get(['followSystemTheme', 'darkMode'], function(result) {
        const followSystem = result && result.followSystemTheme !== false; // default true
        const manualDark = result && result.darkMode === true;
        if (followSystem) {
            const mql = window.matchMedia('(prefers-color-scheme: dark)');
            setTheme(mql.matches);
        } else {
            setTheme(manualDark);
        }
    });
    function setTheme(isDark) {
        if (isDark) {
            document.body.classList.add('dark-mode');
        } else {
            document.body.classList.remove('dark-mode');
        }
    }
})();

document.addEventListener('DOMContentLoaded', onDOMContentLoaded);

async function onDOMContentLoaded() {
  chrome.storage.sync.get({
    apiToken: '',
    baseUrl: '',
    projectId: '',
    projectName: '',
    issueKey: '',
    issueTitle: '',
    username: '',
    jiraType: 'cloud',
    frequentWorklogDescription1: '',
    frequentWorklogDescription2: '',
    darkMode: false,
    experimentalFeatures: false
  }, async (options) => {
    console.log('Storage options:', options);
    await init(options);

    document.getElementById('startStop').addEventListener('click', toggleTimer);
    document.getElementById('reset').addEventListener('click', resetTimer);
    document.getElementById('logTime').addEventListener('click', logTimeClick);
    
    const toggleCommentBtn = document.getElementById('toggleComment');
    if (toggleCommentBtn) {
      toggleCommentBtn.addEventListener('click', toggleCommentVisibility);
    }
    const editTimeBtn = document.getElementById('editTime');
    if (editTimeBtn) {
      editTimeBtn.addEventListener('click', startTimeEditing);
    }

    // Restore saved project and issue
    if (options.projectId && options.projectName) {
      document.getElementById('projectId').value = `${options.projectId}: ${options.projectName}`;
    } else if (options.projectId) {
      document.getElementById('projectId').value = options.projectId;
    }
    if (options.issueKey && options.issueTitle) {
      document.getElementById('issueKey').value = `${options.issueKey}: ${options.issueTitle}`;
    } else if (options.issueKey) {
      document.getElementById('issueKey').value = options.issueKey;
    }

    insertFrequentWorklogDescription(options);

    restoreTimerState();
    syncTimeWithBackground();

    const themeToggle = document.getElementById('themeToggle');
    
    // Unified theme logic
    function applyTheme(followSystem, manualDark) {
        if (followSystem) {
            const mql = window.matchMedia('(prefers-color-scheme: dark)');
            setTheme(mql.matches);
            mql.onchange = (e) => setTheme(e.matches);
            window._systemThemeListener = mql;
        } else {
            if (window._systemThemeListener) {
                window._systemThemeListener.onchange = null;
                window._systemThemeListener = null;
            }
            setTheme(manualDark);
        }
    }
    function setTheme(isDark) {
        updateThemeButton(isDark);
        if (isDark) {
            document.body.classList.add('dark-mode');
        } else {
            document.body.classList.remove('dark-mode');
        }
    }
    // Load settings and apply theme
    chrome.storage.sync.get(['followSystemTheme', 'darkMode'], function(result) {
        const followSystem = result.followSystemTheme !== false; // default true
        const manualDark = result.darkMode === true;
        applyTheme(followSystem, manualDark);
        
        // Initialize worklog suggestions AFTER theme is applied
        const descriptionField = document.getElementById('description');
        if (descriptionField && typeof initializeWorklogSuggestions === 'function') {
          initializeWorklogSuggestions(descriptionField);
        }
    });
    // Theme button disables system-following and sets manual override
    themeToggle.addEventListener('click', function() {
        const isDark = !document.body.classList.contains('dark-mode');
        updateThemeButton(isDark);
        setTheme(isDark);
        chrome.storage.sync.set({ darkMode: isDark, followSystemTheme: false });
    });
    // Listen for changes from other tabs/options
    chrome.storage.onChanged.addListener(function(changes, namespace) {
        if (namespace === 'sync' && ('followSystemTheme' in changes || 'darkMode' in changes)) {
            chrome.storage.sync.get(['followSystemTheme', 'darkMode'], function(result) {
                const followSystem = result.followSystemTheme !== false;
                const manualDark = result.darkMode === true;
                applyTheme(followSystem, manualDark);
            });
        }
        // no-op for experimentalFeatures; suggestions always enabled now
    });
  });
}

async function init(options) {
  console.log("Options received:", options);

  try {
    JIRA = await JiraAPI(options.jiraType, options.baseUrl, options.username, options.apiToken);
    console.log("JIRA API Object initialized:", JIRA);

    if (!JIRA || typeof JIRA.getProjects !== 'function' || typeof JIRA.getIssues !== 'function') {
      console.error('JIRA API instantiation failed: Methods missing', JIRA);
      displayError('JIRA API setup failed. Please check your settings and ensure all required fields (Base URL, Username, API Token) are correctly configured. Go to the main popup Settings to verify your configuration.');
      return;
    }

    await setupAutocomplete(JIRA);
  } catch (error) {
    console.error('Error initializing JIRA API:', error);
    window.JiraErrorHandler.handleJiraError(error, 'Failed to connect to JIRA from timer page', 'timer');
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
      let jql = `project = ${selectedProject.key}`;
      // First page for responsiveness
      let page = await JIRA.getIssuesPage(jql, null, 100);
      let issueItems = page.data.map(i => `${i.key}: ${i.fields.summary}`);
      autocomplete(issueInput, issueItems, issueList, (selectedIssue) => {
        const issueKey = selectedIssue.split(':')[0].trim();
        const issueTitle = selectedIssue.substring(selectedIssue.indexOf(':') + 1).trim();
        chrome.storage.sync.set({ 
          issueKey: issueKey,
          issueTitle: issueTitle
        });
        issueInput.value = selectedIssue;
      });
      // Infinite scroll for more
      let loadingMore = false;
      let nextCursor = page.nextCursor;
      issueList.addEventListener('scroll', async () => {
        if (loadingMore || !nextCursor) return;
        const nearBottom = issueList.scrollTop + issueList.clientHeight >= issueList.scrollHeight - 20;
        if (!nearBottom) return;
        loadingMore = true;
        const nextPage = await JIRA.getIssuesPage(jql, nextCursor, 100);
        nextCursor = nextPage.nextCursor;
        const more = nextPage.data.map(i => `${i.key}: ${i.fields.summary}`);
        issueItems.push(...more);
        // Ask autocomplete to refresh with current input
        const evt = new Event('refreshDropdown', { bubbles: true });
        issueInput.dispatchEvent(evt);
        loadingMore = false;
      });
    }
    // Save selected project with name
    const projectName = selectedProject.name;
    chrome.storage.sync.set({ 
      projectId: selectedKey,
      projectName: projectName
    });
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

  async function showDropdown(val) {
    closeAllLists();
    currentFocus = -1;
    isOpen = true;
    
    let matches = arr.filter(item => item.toLowerCase().includes(val.toLowerCase()));
    if (matches.length === 0 && !val) {
      matches = arr; // Show all options if input is empty
    }
    // If user typed and few matches, query server suggestions for full set
    if (val && matches.length < 5 && typeof JIRA === 'object' && inp.id === 'issueKey') {
      try {
        const projectInput = document.getElementById('projectId');
        const selectedKey = projectInput && projectInput.value ? projectInput.value.split(':')[0].trim() : null;
        const suggestions = await JIRA.getIssueSuggestions(val, selectedKey);
        const suggestionItems = suggestions.data.map(i => `${i.key}: ${i.fields.summary}`);
        const merged = [...suggestionItems, ...matches];
        const seen = new Set();
        matches = merged.filter(x => {
          const k = x.split(':')[0].trim();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      } catch (e) {
        // ignore
      }
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
    timerAnimation.classList.remove('active');
    chrome.runtime.sendMessage({ action: 'stopTimer' });
  } else {
    timer = setInterval(updateTimer, 1000);
    startStopIcon.textContent = 'pause';
    timerAnimation.style.display = 'block';
    timerAnimation.classList.add('active');
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
  const timerInput = document.getElementById('timer');
  if (timerInput) {
    timerInput.value = `${hours}h ${pad(minutes)}m ${pad(secs)}s`;
  }
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
  timerAnimation.classList.remove('active');
  chrome.runtime.sendMessage({ action: 'resetTimer' });
  chrome.storage.sync.remove(['timerSeconds', 'timerIsRunning', 'timerLastUpdated']);
}

function pad(num) {
  return num.toString().padStart(2, '0');
}

// Handle editable time
let _preEditSeconds = 0;
function startTimeEditing() {
  if (isRunning) {
    displayError('Pause the timer before editing time.');
    return;
  }
  const timerInput = document.getElementById('timer');
  if (!timerInput) return;
  _preEditSeconds = seconds;
  timerInput.readOnly = false;
  timerInput.focus();
  timerInput.select();

  const onBlur = () => applyTimeEditCleanup(true);
  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyTimeEditCleanup(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      seconds = _preEditSeconds;
      updateTimerDisplay();
      applyTimeEditCleanup(false);
    }
  };

  function applyTimeEditCleanup(apply) {
    timerInput.removeEventListener('blur', onBlur);
    timerInput.removeEventListener('keydown', onKey);
    if (apply) {
      const parsed = parseTimeString(timerInput.value);
      if (parsed !== null) {
        seconds = parsed;
        updateTimerDisplay();
        saveTimerState();
      } else {
        // revert on invalid
        seconds = _preEditSeconds;
        updateTimerDisplay();
        displayError('Invalid time. Use format like 1h 05m 30s.');
      }
    }
    timerInput.readOnly = true;
  }

  timerInput.addEventListener('blur', onBlur);
  timerInput.addEventListener('keydown', onKey);
}

function parseTimeString(text) {
  if (!text) return null;
  const normalized = text.trim().toLowerCase();
  const regex = /^(?:\s*(\d+)\s*h)?\s*(?:([0-5]?\d)\s*m)?\s*(?:([0-5]?\d)\s*s)?\s*$/i;
  const match = normalized.match(regex);
  if (!match) return null;
  const h = parseInt(match[1] || '0', 10);
  const m = parseInt(match[2] || '0', 10);
  const s = parseInt(match[3] || '0', 10);
  if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s)) return null;
  if (m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}

function toggleCommentVisibility() {
  const container = document.getElementById('commentContainer');
  const button = document.getElementById('toggleComment');
  if (!container) return;
  const showing = !container.classList.contains('show');
  if (showing) {
    container.classList.add('show');
    button.classList.add('active');
  } else {
    container.classList.remove('show');
    button.classList.remove('active');
  }
  document.dispatchEvent(new CustomEvent('commentContainerVisibilityChanged', { detail: { shown: showing } }));
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
    if (frequentWorklogDescription1 && options.frequentWorklogDescription1) {
      frequentWorklogDescription1.style.display = 'block';
    }
    if (frequentWorklogDescription2 && options.frequentWorklogDescription2) {
      frequentWorklogDescription2.style.display = 'block';
    }
  }

  // Attach click handlers
  if (frequentWorklogDescription1 && options.frequentWorklogDescription1) {
    frequentWorklogDescription1.addEventListener('click', function() {
      descriptionField.value = options.frequentWorklogDescription1;
      hideButtons();
    });
  }
  if (frequentWorklogDescription2 && options.frequentWorklogDescription2) {
    frequentWorklogDescription2.addEventListener('click', function() {
      descriptionField.value = options.frequentWorklogDescription2;
      hideButtons();
    });
  }

  descriptionField.addEventListener('input', function() {
    if (descriptionField.value === '') {
      showButtons();
    } else {
      hideButtons();
    }
  });

  // React when the comment container is shown/hidden
  document.addEventListener('commentContainerVisibilityChanged', (e) => {
    if (e.detail && e.detail.shown) {
      if (descriptionField.value === '') {
        showButtons();
      } else {
        hideButtons();
      }
    } else {
      hideButtons();
    }
  });

  // Initialize state only when container is visible at load
  const container = document.getElementById('commentContainer');
  const containerShown = container && container.classList.contains('show');
  if (containerShown) {
    if (descriptionField.value !== '') {
      hideButtons();
    } else {
      showButtons();
    }
  } else {
    hideButtons();
  }
}

async function logTimeClick() {
  const issueKey = document.getElementById('issueKey').value.split(':')[0].trim();
  const timeSpent = secondsToJiraFormat(seconds);
  const description = document.getElementById('description').value;

  // Validation
  if (!issueKey) {
    displayError('Issue Key is required. Please select or enter a valid issue key (e.g., PROJECT-123).');
    return;
  }

  if (seconds <= 0) {
    displayError('No time recorded. Please start the timer, work on your task, then stop the timer before logging time.');
    return;
  }

  console.log("Logging time with parameters:", { issueKey, timeSpent, description });

  try {
    const startedTime = new Date().toISOString();
    await JIRA.updateWorklog(issueKey, seconds, startedTime, description);
    displaySuccess(`You successfully logged: ${timeSpent} on ${issueKey}`);
    
    document.getElementById('description').value = '';
    resetTimer();
  } catch (error) {
    console.error('Error logging time:', error);
    window.JiraErrorHandler.handleJiraError(error, `Failed to log time for issue ${issueKey}`, 'timer');
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
      startStopIcon.textContent = 'pause';
      timerAnimation.style.display = 'block';
      timerAnimation.classList.add('active');
      chrome.runtime.sendMessage({ action: 'startTimer', seconds: seconds });
    } else {
      startStopIcon.textContent = 'play_arrow';
      timerAnimation.style.display = 'none';
      timerAnimation.classList.remove('active');
    }
  });
}


function syncTimeWithBackground() {
  chrome.runtime.sendMessage({ action: 'syncTime', seconds: seconds, isRunning: isRunning });
}

function restartTimerAnimation() {
  const timerAnimation = document.getElementById('timer-animation');
  if (timerAnimation.style.display === 'block') {
    timerAnimation.style.animation = 'none';
    void timerAnimation.offsetWidth;
    timerAnimation.style.animation = 'slide 2s linear infinite';
  }
}

// Function to update the theme button icon
function updateThemeButton(isDark) {
  const themeToggle = document.getElementById('themeToggle');
  const iconSpan = themeToggle.querySelector('.icon');
  if (isDark) {
    iconSpan.textContent = '☀️';
    themeToggle.title = 'Switch to light mode';
  } else {
    iconSpan.textContent = '🌙';
    themeToggle.title = 'Switch to dark mode';
  }
}
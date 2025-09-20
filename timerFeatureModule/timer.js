let timer;
let isRunning = false;
let seconds = 0;
let JIRA;
let _timerSettings = null;

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

function enforceProjectIssueConsistency() {
  try {
    const projectInput = document.getElementById('projectId');
    const issueInput = document.getElementById('issueKey');
    const projectVal = projectInput && projectInput.value ? projectInput.value : '';
    const issueVal = issueInput && issueInput.value ? issueInput.value : '';
    const projectKey = projectVal ? projectVal.split(':')[0].trim().toUpperCase() : '';
    const issueKey = issueVal ? issueVal.split(':')[0].trim().toUpperCase() : '';
    const issuePrefix = issueKey.includes('-') ? issueKey.split('-')[0] : '';

    if (projectKey && issuePrefix && projectKey !== issuePrefix) {
      // Clear mismatched issue and remove saved values
      if (issueInput) issueInput.value = '';
      try { chrome.storage && chrome.storage.sync && chrome.storage.sync.remove && chrome.storage.sync.remove(['issueKey','issueTitle']); } catch(_) {}
    }

    // Track selected key for later change detection
    if (projectInput && projectInput.dataset && projectKey) {
      projectInput.dataset.selectedKey = projectKey;
    }
  } catch (_) {}
}

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
    // Keep a minimal copy of settings for background requests
    _timerSettings = {
      jiraType: options.jiraType,
      baseUrl: options.baseUrl,
      username: options.username,
      apiToken: options.apiToken
    };
    // Restore saved project and issue BEFORE initializing autocomplete so it can bind to the correct project
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

    // Enforce consistency between project and issue from restored values
    enforceProjectIssueConsistency();

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
  let issueInput = document.getElementById('issueKey');
  const projectList = document.getElementById('projectList');
  const issueList = document.getElementById('issueList');

  let projectsResponse = await JIRA.getProjects();
  let projects = projectsResponse.data;
  let projectMap = new Map(projects.map(p => [p.key, p]));

  setupDropdownArrow(projectInput);
  setupDropdownArrow(issueInput);
  setupInputFocus(projectInput);
  setupInputFocus(issueInput);

  function replaceIssueInput() {
    const oldInput = issueInput;
    const oldValue = oldInput.value;
    const newInput = oldInput.cloneNode(true);
    oldInput.parentNode.replaceChild(newInput, oldInput);
    issueInput = newInput;
    issueInput.value = oldValue;
    setupDropdownArrow(issueInput);
    setupInputFocus(issueInput);
    attachIssueDirectHandlers(issueInput, projectInput);
  }

  function clearIssueInputAndStorage() {
    if (issueInput) issueInput.value = '';
    if (issueList) issueList.innerHTML = '';
    try { chrome.storage && chrome.storage.sync && chrome.storage.sync.remove && chrome.storage.sync.remove(['issueKey','issueTitle']); } catch(_) {}
  }

  function getSelectedProjectKey() {
    const val = projectInput && projectInput.value ? projectInput.value : '';
    const key = val ? val.split(':')[0].trim() : '';
    return key.toUpperCase();
  }

  function extractIssueKey(raw) {
    if (typeof JIRA?.extractIssueKey === 'function') return JIRA.extractIssueKey(raw);
    if (!raw) return '';
    const text = String(raw).trim();
    const token = text.split(/\s|:/)[0].trim();
    return token.toUpperCase();
  }

  function isIssueKeyLike(key) {
    if (typeof JIRA?.isIssueKeyLike === 'function') return JIRA.isIssueKeyLike(key);
    return /^[A-Z][A-Z0-9_]*-\d+$/.test(key || '');
  }

  function attachIssueDirectHandlers(inputEl, projectEl) {
    if (!inputEl) return;

    const acceptIfValid = async () => {
      const candidate = extractIssueKey(inputEl.value);
      if (!isIssueKeyLike(candidate)) return;
      const selectedProject = getSelectedProjectKey();
      // Validate project/issue consistency locally and accept without network call
      try {
        if (selectedProject && typeof JIRA?.validateIssueMatchesProject === 'function') {
          const ok = JIRA.validateIssueMatchesProject(candidate, selectedProject);
          if (!ok) {
            clearIssueInputAndStorage();
            displayError('Work item key does not match selected project.');
            return;
          }
        }
      } catch(_) {}
      inputEl.value = candidate;
      try { chrome.storage.sync.set({ issueKey: candidate, issueTitle: '' }); } catch(_) {}
    };

    // Handle paste quickly without triggering suggestions
    inputEl.addEventListener('paste', (e) => {
      // Use clipboard directly if available; otherwise defer to after paste
      const pasted = (e && e.clipboardData && e.clipboardData.getData) ? e.clipboardData.getData('text') : null;
      const candidate = extractIssueKey(pasted || inputEl.value);
      if (isIssueKeyLike(candidate)) {
        // Delay to allow input value to update
        setTimeout(acceptIfValid, 0);
      }
    });

    // Accept on Enter when no dropdown selection
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const candidate = extractIssueKey(inputEl.value);
        if (isIssueKeyLike(candidate)) {
          e.preventDefault();
          acceptIfValid();
        }
      }
    });

    // Accept on blur
    inputEl.addEventListener('blur', () => {
      const candidate = extractIssueKey(inputEl.value);
      if (isIssueKeyLike(candidate)) {
        setTimeout(acceptIfValid, 0);
      }
    });
  }

  autocomplete(projectInput, projects.map(p => `${p.key}: ${p.name}`), projectList, async (selected) => {
    let selectedKey = selected.split(':')[0].trim();
    let selectedProject = projectMap.get(selectedKey);
    if (selectedProject) {
      const previousKey = projectInput && projectInput.dataset ? projectInput.dataset.selectedKey : null;
      // Record the newly selected key
      if (projectInput && projectInput.dataset) projectInput.dataset.selectedKey = selectedKey;
      // If project actually changed, clear any previously selected issue
      if (previousKey && previousKey !== selectedKey) {
        clearIssueInputAndStorage();
      }
      let jql = `project = ${selectedProject.key}`;
      // First page for responsiveness
      // Reset the issue input and listeners for a clean autocomplete rebind
      replaceIssueInput();
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

  // Initialize issue autocomplete from saved project (so users don't have to reselect)
  try {
    const initialVal = projectInput && projectInput.value ? projectInput.value : '';
    const initialKey = initialVal ? initialVal.split(':')[0].trim() : '';
    if (initialKey && projectMap.has(initialKey)) {
      // Track the currently active project key
      if (projectInput && projectInput.dataset) projectInput.dataset.selectedKey = initialKey;

      // If an issue is already filled but mismatched with the project, clear it
      if (issueInput && issueInput.value) {
        const existingIssueKey = issueInput.value.split(':')[0].trim();
        const existingPrefix = existingIssueKey.includes('-') ? existingIssueKey.split('-')[0] : '';
        if (existingPrefix && existingPrefix.toUpperCase() !== initialKey.toUpperCase()) {
          clearIssueInputAndStorage();
        }
      }

      // Preload first page of issues and bind autocomplete
      const selectedProject = projectMap.get(initialKey);
      const jql = `project = ${selectedProject.key}`;
      replaceIssueInput();
      const page = await JIRA.getIssuesPage(jql, null, 100);
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
        const evt = new Event('refreshDropdown', { bubbles: true });
        issueInput.dispatchEvent(evt);
        loadingMore = false;
      });
    }
  } catch (e) {
    // best-effort init
  }

  // If user manually edits the project text (not via dropdown), detect project key change and clear issue
  if (projectInput) {
    projectInput.addEventListener('input', () => {
      const typedKey = projectInput.value ? projectInput.value.split(':')[0].trim() : '';
      const currentKey = projectInput && projectInput.dataset ? projectInput.dataset.selectedKey : '';
      if (typedKey && currentKey && typedKey !== currentKey) {
        clearIssueInputAndStorage();
      }
    });
  }

  // Attach direct handlers initially
  attachIssueDirectHandlers(issueInput, projectInput);
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
    displayError('Work Item Key is required. Please select or enter a valid work item key (e.g., PROJECT-123).');
    return;
  }

  if (seconds <= 0) {
    displayError('No time recorded. Please start the timer, work on your task, then stop the timer before logging time.');
    return;
  }

  console.log("Logging time with parameters:", { issueKey, timeSpent, description });

  try {
    const startedTime = new Date().toISOString();
    // Prefer background worker to avoid CORS/preflight issues
    const response = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({
          action: 'logWorklog',
          settings: _timerSettings,
          issueId: issueKey,
          timeInSeconds: seconds,
          startedTime: startedTime,
          comment: description
        }, (resp) => {
          // Handle runtime send errors gracefully
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve({ success: false, error: { message: chrome.runtime.lastError.message } });
          } else {
            resolve(resp);
          }
        });
      } catch (e) {
        resolve({ success: false, error: { message: e?.message || 'Background request failed' } });
      }
    });

    if (response && response.success) {
      displaySuccess(`You successfully logged: ${timeSpent} on ${issueKey}`);
      document.getElementById('description').value = '';
      resetTimer();
    } else {
      const err = response && response.error ? new Error(response.error.message || 'Failed to log work') : new Error('Failed to log work');
      throw err;
    }
  } catch (error) {
    console.error('Error logging time:', error);
    window.JiraErrorHandler.handleJiraError(error, `Failed to log time for work item ${issueKey}`, 'timer');
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
document.addEventListener('DOMContentLoaded', function() {
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
    });
});

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

document.addEventListener('DOMContentLoaded', onDOMContentLoaded);

async function onDOMContentLoaded() {
  chrome.storage.sync.get({
    jiraType: 'cloud',
    apiToken: '',
    baseUrl: '',
    username: '',
    frequentWorklogDescription1: '',
    frequentWorklogDescription2: '',
    darkMode: false,
    experimentalFeatures: false
  }, async (options) => {
    console.log('Storage options:', options);
    await init(options);

    document.getElementById('search').addEventListener('click', logTimeClick);
    
    insertFrequentWorklogDescription(options);

  // Initialize worklog suggestions for description field
  const descriptionField = document.getElementById('description');
  if (descriptionField) {
    initializeWorklogSuggestions(descriptionField);
  }
  });

  const datePicker = document.getElementById('datePicker');
  datePicker.value = new Date().toISOString().split('T')[0];

  chrome.storage.onChanged.addListener(function(changes, namespace) {
    // no-op for experimentalFeatures; more will be added later
  });
}

async function init(options) {
  console.log("Options received:", options);

  try {    
    // Initialize the JIRA API with the provided options
    const JIRA = await JiraAPI(options.jiraType, options.baseUrl, options.username, options.apiToken);
    // Expose for autocomplete suggestions
    window.JIRA = JIRA;
    console.log("JIRA API Object initialized:", JIRA);

    if (!JIRA || typeof JIRA.getProjects !== 'function' || typeof JIRA.getIssues !== 'function') {
      console.error('JIRA API instantiation failed: Methods missing', JIRA);
      displayError('JIRA API setup failed. Please check your settings and ensure all required fields (Base URL, Username, API Token) are correctly configured. Go to the main popup Settings to verify your configuration.');
      return;
    }

    await setupAutocomplete(JIRA);

    document.getElementById('search').addEventListener('click', logTimeClick);
  } catch (error) {
    console.error('Error initializing JIRA API:', error);
    window.JiraErrorHandler.handleJiraError(error, 'Failed to connect to JIRA from search page', 'search');
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
    attachIssueDirectHandlers(issueInput, projectInput, JIRA);
  }

  function getSelectedProjectKey() {
    const val = projectInput && projectInput.value ? projectInput.value : '';
    const key = val ? val.split(':')[0].trim() : '';
    return key.toUpperCase();
  }

  function attachIssueDirectHandlers(inputEl, projectEl, JIRAInstance) {
    if (!inputEl) return;
    const extractIssueKey = (raw) => (typeof JIRAInstance?.extractIssueKey === 'function') ? JIRAInstance.extractIssueKey(raw) : String(raw || '').trim().split(/\s|:/)[0].toUpperCase();
    const isIssueKeyLike = (key) => (typeof JIRAInstance?.isIssueKeyLike === 'function') ? JIRAInstance.isIssueKeyLike(key) : /^[A-Z][A-Z0-9_]*-\d+$/.test(key || '');

    const acceptIfValid = async () => {
      const candidate = extractIssueKey(inputEl.value);
      if (!isIssueKeyLike(candidate)) return;
      const selectedProject = getSelectedProjectKey();
      try {
        const { key, summary } = await JIRAInstance.resolveIssueKeyFast(candidate, selectedProject || null);
        inputEl.value = summary ? `${key}: ${summary}` : key;
      } catch (err) {
        if (err && err.code === 'ISSUE_PROJECT_MISMATCH') {
          inputEl.value = '';
          displayError('Work item key does not match selected project.');
        } else {
          inputEl.value = candidate; // keep key
        }
      }
    };

    inputEl.addEventListener('paste', (e) => {
      const pasted = (e && e.clipboardData && e.clipboardData.getData) ? e.clipboardData.getData('text') : null;
      const candidate = extractIssueKey(pasted || inputEl.value);
      if (isIssueKeyLike(candidate)) {
        setTimeout(acceptIfValid, 0);
      }
    });
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const candidate = extractIssueKey(inputEl.value);
        if (isIssueKeyLike(candidate)) {
          e.preventDefault();
          acceptIfValid();
        }
      }
    });
    inputEl.addEventListener('blur', () => {
      const candidate = extractIssueKey(inputEl.value);
      if (isIssueKeyLike(candidate)) setTimeout(acceptIfValid, 0);
    });
  }

  autocomplete(projectInput, projects.map(p => `${p.key}: ${p.name}`), projectList, async (selected) => {
    let selectedKey = selected.split(':')[0].trim();
    let selectedProject = projectMap.get(selectedKey);
    if (selectedProject) {
      let jql = `project = ${selectedProject.key}`;
      // Load first page immediately for responsiveness
      // Reset handlers for new project context
      replaceIssueInput();
      let page = await JIRA.getIssuesPage(jql, null, 100);
      let issueItems = page.data.map(i => `${i.key}: ${i.fields.summary || ''}`);
      // Wire autocomplete with a live array reference
      autocomplete(issueInput, issueItems, issueList);
      // Infinite scroll and dynamic refresh
      let loadingMore = false;
      let nextCursor = page.nextCursor;
      issueList.addEventListener('scroll', async () => {
        if (loadingMore || !nextCursor) return;
        const nearBottom = issueList.scrollTop + issueList.clientHeight >= issueList.scrollHeight - 20;
        if (!nearBottom) return;
        loadingMore = true;
        const nextPage = await JIRA.getIssuesPage(jql, nextCursor, 100);
        nextCursor = nextPage.nextCursor;
        const more = nextPage.data.map(i => `${i.key}: ${i.fields.summary || ''}`);
        issueItems.push(...more);
        // Ask autocomplete to refresh with current input
        const evt = new Event('refreshDropdown', { bubbles: true });
        issueInput.dispatchEvent(evt);
        loadingMore = false;
      });
    }
  });
  // Attach direct handlers initially
  attachIssueDirectHandlers(issueInput, projectInput, JIRA);
}

function setupDropdownArrow(input) {
  const arrow = input.nextElementSibling;
  arrow.addEventListener('click', (event) => {
    event.stopPropagation(); // Prevent the click from immediately closing the dropdown
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

  // Allow external trigger to re-render with current input and updated arr
  inp.addEventListener("refreshDropdown", function(e) {
    showDropdown(inp.value || '');
  });

  async function showDropdown(val) {
    closeAllLists();
    currentFocus = -1;
    isOpen = true;
    
    let matches = arr.filter(item => item.toLowerCase().includes(val.toLowerCase()));
    if (matches.length === 0 && !val) {
      matches = arr; // Show all options if input is empty
    }
    // If user typed something and we have few/no local matches, query server suggestions
    if (val && matches.length < 5 && typeof window.JIRA === 'object' && inp.id === 'issueKey') {
      try {
        const projectInput = document.getElementById('projectId');
        const selectedKey = projectInput && projectInput.value ? projectInput.value.split(':')[0].trim() : null;
        const suggestions = await window.JIRA.getIssueSuggestions(val, selectedKey);
        const suggestionItems = suggestions.data.map(i => `${i.key}: ${i.fields.summary || ''}`);
        // Merge, prefer suggestions
        const merged = [...suggestionItems, ...matches];
        // De-dup
        const seen = new Set();
        matches = merged.filter(x => {
          const k = x.split(':')[0].trim();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      } catch (e) {
        // ignore suggestions errors, fall back to local
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

async function logTimeClick(evt) {
  evt.preventDefault();
  
  const projectId = document.getElementById('projectId').value.split(':')[0].trim();
  const issueKey = document.getElementById('issueKey').value.split(':')[0].trim();
  const date = document.getElementById('datePicker').value;
  const timeSpent = document.getElementById('timeSpent').value;
  const description = document.getElementById('description').value;

  // Validation
  if (!issueKey) {
    displayError('Issue Key is required. Please select or enter a valid issue key (e.g., PROJECT-123).');
    return;
  }

  if (!timeSpent) {
    displayError('Time Spent is required. Please enter the time you want to log (e.g., 2h, 30m, 1d).');
    return;
  }

  // Validate time format
  const timeMatches = timeSpent.match(/[0-9]{1,4}[dhm]/g);
  if (!timeMatches) {
    displayError('Invalid time format. Please use:\n• Hours: 2h, 1.5h\n• Minutes: 30m, 45m\n• Days: 1d, 0.5d\n\nExamples: "2h 30m", "1d", "45m"');
    return;
  }

  console.log("Logging time with parameters:", { projectId, issueKey, date, timeSpent, description });

  chrome.storage.sync.get({
    jiraType: 'cloud',
    apiToken: '',
    baseUrl: '',
    username: '',
  }, async (options) => {
    try {
      const JIRA = await JiraAPI(options.jiraType, options.baseUrl, options.username, options.apiToken);
      const startedTime = getStartedTime(date);
      const timeSpentSeconds = convertTimeToSeconds(timeSpent);

      console.log({
        issueKey,
        timeSpentSeconds,
        startedTime,
        description
      });

      await JIRA.updateWorklog(issueKey, timeSpentSeconds, startedTime, description);
      displaySuccess(`You successfully logged: ${timeSpent} on ${issueKey}`);
      
      document.getElementById('timeSpent').value = '';
      document.getElementById('description').value = '';
    } catch (error) {
      console.error('Error logging time:', error);
      window.JiraErrorHandler.handleJiraError(error, `Failed to log time for issue ${issueKey}`, 'search');
    }
  });
}

function getStartedTime(dateString) {
  // Parse the input date string
  const [year, month, day] = dateString.split('-').map(Number);
  
  // Create a date object using the local timezone
  const date = new Date(year, month - 1, day);
  const now = new Date();

  // Combine the input date with the current time
  date.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());

  // Calculate timezone offset
  const tzo = -date.getTimezoneOffset();
  const dif = tzo >= 0 ? '+' : '-';

  // Format the date string
  const formattedDate = 
    `${date.getFullYear()}-` +
    `${pad(date.getMonth() + 1)}-` +
    `${pad(date.getDate())}T` +
    `${pad(date.getHours())}:` +
    `${pad(date.getMinutes())}:` +
    `${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}` +
    `${dif}${pad(Math.abs(Math.floor(tzo / 60)))}:${pad(Math.abs(tzo % 60))}`;

  console.log("Input date string:", dateString);
  console.log("Formatted start time:", formattedDate);
  
  return formattedDate;
}

function pad(num, size = 2) {
  return num.toString().padStart(size, '0');
}

function convertTimeToSeconds(timeStr) {
  const timeUnits = {
      d: 60 * 60 * 24,
      h: 60 * 60,
      m: 60
  };

  const regex = /(\d+)([dhm])/g;
  let match;
  let totalSeconds = 0;

  while ((match = regex.exec(timeStr)) !== null) {
      const value = parseInt(match[1], 10);
      const unit = match[2];
      totalSeconds += value * timeUnits[unit];
  }

  return totalSeconds;
}

function pad(num) {
  return (num < 10 ? '0' : '') + num;
}

function displayError(message) {
  const error = document.getElementById('error');
  if (error) {
    error.innerText = message;
    error.style.display = 'block';
  }

  const success = document.getElementById('success');
  if (success) success.style.display = 'none';
}

function displaySuccess(message) {
  const success = document.getElementById('success');
  if (success) {
    success.innerText = message;
    success.style.display = 'block';
    
    document.getElementById('timeSpent').value = '';
    document.getElementById('description').value = '';
    
    const error = document.getElementById('error');
    if (error) {
      error.innerText = '';
      error.style.display = 'none';
    }
  } else {
    console.warn('Success element not found');
  }
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
  
  // Initially hide buttons if no descriptions are set
  if (!options.frequentWorklogDescription1 && !options.frequentWorklogDescription2) {
    hideButtons();
    return;
  }
  
  if (frequentWorklogDescription1 && options.frequentWorklogDescription1) {
    frequentWorklogDescription1.addEventListener('click', function() {
      descriptionField.value = options.frequentWorklogDescription1;
      console.log('frequentWorklogDescription1 clicked');
      hideButtons();
    });
  }
  
  if (frequentWorklogDescription2 && options.frequentWorklogDescription2) {
    frequentWorklogDescription2.addEventListener('click', function() {
      descriptionField.value = options.frequentWorklogDescription2;
      console.log('frequentWorklogDescription2 clicked');
      hideButtons();
    });
  }
  
  descriptionField.addEventListener('input', function() {
    console.log('User started typing in the description field');
    if (descriptionField.value === '') {
      showButtons();
    } else {
      hideButtons();
    }
  });
  
  // Check initial description field state
  if (descriptionField.value !== '') {
    hideButtons();
  } else {
    showButtons();
  }
}


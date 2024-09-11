document.addEventListener('DOMContentLoaded', onDOMContentLoaded);

async function onDOMContentLoaded() {
  chrome.storage.sync.get({
    jiraType: 'cloud',
    apiToken: '',
    baseUrl: '',
    username: '',
  }, async (options) => {
    console.log('Storage options:', options);
    await init(options);

    document.getElementById('search').addEventListener('click', logTimeClick);
    updateTimerLinkVisibility();
  });

  const datePicker = document.getElementById('datePicker');
  datePicker.value = new Date().toISOString().split('T')[0];

  chrome.storage.onChanged.addListener(function(changes, namespace) {
    if (namespace === 'sync' && 'experimentalFeatures' in changes) {
      updateTimerLinkVisibility();
    }
  });
}

function updateTimerLinkVisibility() {
  const timerLinkContainer = document.getElementById('timerLinkContainer');
  if (timerLinkContainer) {
      chrome.storage.sync.get('experimentalFeatures', function(data) {
          timerLinkContainer.style.display = data.experimentalFeatures ? 'inline' : 'none';
      });
  }
}

async function init(options) {
  console.log("Options received:", options);

  try {
    // Initialize the JIRA API with the provided options
    const JIRA = await JiraAPI(options.jiraType, options.baseUrl, options.username, options.apiToken);
    console.log("JIRA API Object initialized:", JIRA);

    if (!JIRA || typeof JIRA.getProjects !== 'function' || typeof JIRA.getIssues !== 'function') {
      console.error('JIRA API instantiation failed: Methods missing', JIRA);
      displayError('JIRA API instantiation failed.');
      return;
    }

    await setupAutocomplete(JIRA);

    document.getElementById('search').addEventListener('click', logTimeClick);
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
      autocomplete(issueInput, issues.map(i => `${i.key}: ${i.fields.summary || ''}`), issueList);
    }
  });
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

async function logTimeClick(evt) {
  evt.preventDefault();
  
  const projectId = document.getElementById('projectId').value.split(':')[0].trim();
  const issueKey = document.getElementById('issueKey').value.split(':')[0].trim();
  const date = document.getElementById('datePicker').value;
  const timeSpent = document.getElementById('timeSpent').value;
  const description = document.getElementById('description').value;

  console.log("Logging time with parameters:", { projectId, issueKey, date, timeSpent, description });

  chrome.storage.sync.get({
    jiraType: 'cloud',
    apiToken: '',
    baseUrl: '',
    username: '',
  }, async (options) => {
    const JIRA = await JiraAPI(options.jiraType, options.baseUrl, options.username, options.apiToken);

    try {
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
      displayError(`Error logging time: ${error.message}`);
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

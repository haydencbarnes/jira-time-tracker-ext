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

    // Restore timer state
    restoreTimerState();
  });
}

async function init(options) {
  console.log("Options received:", options);

  try {
    JIRA = await JiraAPI(options.baseUrl, '/rest/api/2', '', options.apiToken, options.jql);
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

  let projects = await JIRA.getProjects();
  let projectMap = new Map(projects.map(p => [p.key, p]));

  setupDropdownArrow(projectInput);
  setupDropdownArrow(issueInput);
  setupInputFocus(projectInput);
  setupInputFocus(issueInput);

  autocomplete(projectInput, projects.map(p => `${p.key}: ${p.name}`), projectList, async (selected) => {
    let selectedKey = selected.split(':')[0].trim();
    let selectedProject = projectMap.get(selectedKey);
    if (selectedProject) {
      let issues = await JIRA.getIssues(`project=${selectedProject.key}`);
      autocomplete(issueInput, issues.map(i => `${i.key}: ${i.fields.summary}`), issueList, (selectedIssue) => {
        // Save selected issue
        chrome.storage.sync.set({ issueKey: selectedIssue.split(':')[0].trim() });
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
  if (isRunning) {
    clearInterval(timer);
    startStopButton.textContent = 'Start Timer';
  } else {
    timer = setInterval(updateTimer, 1000);
    startStopButton.textContent = 'Stop Timer';
  }
  isRunning = !isRunning;
  saveTimerState();
}

function updateTimer() {
  seconds++;
  updateTimerDisplay();
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
  document.getElementById('startStop').textContent = 'Start Timer';
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
    console.error('Error logging time:', error);
    displayError(`Error logging time: ${error.message}`);
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
    if (isRunning) {
      timer = setInterval(updateTimer, 1000);
      document.getElementById('startStop').textContent = 'Stop Timer';
    }
  });
}

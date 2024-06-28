document.addEventListener('DOMContentLoaded', onDOMContentLoaded);

async function onDOMContentLoaded() {
  chrome.storage.sync.get({
    apiToken: '',
    baseUrl: '',
  }, async (options) => {
    console.log('Storage options:', options); // Debug storage retrieval
    await init(options);

    // Attach event listener to the submit button
    document.getElementById('search').addEventListener('click', logTimeClick);
  });

  // Set today's date as default
  const datePicker = document.getElementById('datePicker');
  datePicker.value = new Date().toISOString().split('T')[0];
}

async function init(options) {
  console.log("Options received:", options);

  try {
    const JIRA = await JiraAPI(options.baseUrl, '/rest/api/2', '', options.apiToken, options.jql);
    console.log("JIRA API Object initialized:", JIRA);

    if (!JIRA || typeof JIRA.getProjects !== 'function' || typeof JIRA.getIssues !== 'function') {
      console.error('JIRA API instantiation failed: Methods missing', JIRA);
      displayError('JIRA API instantiation failed.');
      return;
    }

    await populateProjects(JIRA);
    document.getElementById('projectId').addEventListener('change', () => {
      const selectedProject = document.getElementById('projectId').value;
      populateIssues(JIRA, selectedProject);
    });

    // Replace the previously inline `onclick` assignment
    document.getElementById('search').addEventListener('click', logTimeClick);
  } catch (error) {
    console.error('Error initializing JIRA API:', error);
    displayError('Initialization failed.');
  }
}

async function populateProjects(JIRA) {
  const projectSelect = document.getElementById('projectId');
  projectSelect.innerHTML = '';

  try {
    const projects = await JIRA.getProjects();
    console.log('Fetched projects:', projects); // Debug project fetching
    projects.forEach(project => {
      const option = document.createElement('option');
      option.value = project.key;
      option.textContent = project.name;
      projectSelect.appendChild(option);
    });

    if (projects.length > 0) {
      populateIssues(JIRA, projects[0].key);
    }
  } catch (error) {
    console.error('Error fetching projects:', error);
    displayError(`Error fetching projects: ${error.message}`);
  }
}

async function populateIssues(JIRA, projectKey) {
  const issueSelect = document.getElementById('issueKey');
  issueSelect.innerHTML = '';

  try {
    // Correct the JQL query to use the proper syntax ("project=...")
    const issues = await JIRA.getIssues(`project=${projectKey}`);
    console.log('Fetched issues for project', projectKey, ':', issues); // Debug issue fetching
    issues.forEach(issue => {
      const option = document.createElement('option');
      option.value = issue.key;  // Use issue.key for the option value
      option.textContent = `${issue.key}: ${issue.fields.summary}`;
      issueSelect.appendChild(option);
    });
  } catch (error) {
    console.error('Error fetching issues:', error);
    displayError(`Error fetching issues: ${error.message}`);
  }
}

// Adjust the function to submit time log
async function logTimeClick(evt) {
  evt.preventDefault();  // Prevent default form submission behavior
  
  const projectId = document.getElementById('projectId').value;
  const issueKey = document.getElementById('issueKey').value;
  const date = document.getElementById('datePicker').value;
  const timeSpent = document.getElementById('timeSpent').value;
  const description = document.getElementById('description').value;

  console.log("Logging time with parameters:", { projectId, issueKey, date, timeSpent, description });

  chrome.storage.sync.get({
    apiToken: '',
    baseUrl: '',
  }, async (options) => {
    const JIRA = await JiraAPI(options.baseUrl, '/rest/api/2', '', options.apiToken);

    try {
      const startedTime = getStartedTime(date);  // Get formatted start time
      const timeSpentSeconds = convertTimeToSeconds(timeSpent);

      console.log({
        issueKey,
        timeSpentSeconds,
        startedTime,
        description
      });  // Log payload for debugging

      await JIRA.updateWorklog(issueKey, timeSpentSeconds, startedTime, description);
      displaySuccess(`You successfully logged: ${timeSpent} on ${issueKey}`);
      
      // Clear the form fields after success
      document.getElementById('timeSpent').value = '';
      document.getElementById('description').value = '';
    } catch (error) {
      console.error('Error logging time:', error);
      displayError(`Error logging time: ${error.message}`);
    }
  });
}

function getStartedTime(dateString) {
  const date = new Date(dateString);
  const time = new Date();
  const tzo = -date.getTimezoneOffset();
  const dif = tzo >= 0 ? '+' : '-';

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}.${pad(time.getMilliseconds())}${dif}${pad(Math.abs(Math.floor(tzo / 60)))}:${pad(Math.abs(tzo % 60))}`;
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
    
    // Clear the form fields after success
    document.getElementById('timeSpent').value = '';
    document.getElementById('description').value = '';
    
    // Clear any existing error message if there is one
    const error = document.getElementById('error');
    if (error) {
      error.innerText = '';
      error.style.display = 'none';
    }
  } else {
    console.warn('Success element not found');
  }
}

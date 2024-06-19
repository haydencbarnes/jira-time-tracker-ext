document.addEventListener('DOMContentLoaded', onDOMContentLoaded);

async function onDOMContentLoaded() {
  chrome.storage.sync.get({
    apiToken: '',
    baseUrl: '',
  }, async (options) => {
    await init(options);
  });
}

async function init(options) {
  console.log("Options received:", options);

  try {
    // Initialize the JIRA API with the provided options
    const JIRA = await JiraAPI(options.baseUrl, '/rest/api/2', '', options.apiToken);
    console.log("JIRA API Object:", JIRA);

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

    document.getElementById('search').addEventListener('click', searchIssues);

    flatpickr("#datePicker", {
      enableTime: true,
      dateFormat: "Y-m-d H:i",
    });
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
  }
}

async function populateIssues(JIRA, projectKey) {
  const issueSelect = document.getElementById('issueKey');
  issueSelect.innerHTML = '';

  try {
    const issues = await JIRA.getIssues(projectKey);
    issues.forEach(issue => {
      const option = document.createElement('option');
      option.value = issue.id;
      option.textContent = `${issue.key}: ${issue.fields.summary}`;
      issueSelect.appendChild(option);
    });
  } catch (error) {
    console.error('Error fetching issues:', error);
  }
}

async function searchIssues() {
  const projectId = document.getElementById('projectId').value;
  const issueKey = document.getElementById('issueKey').value;
  const date = document.getElementById('datePicker').value;
  const timeSpent = document.getElementById('timeSpent').value;
  const description = document.getElementById('description').value;

  console.log("Search parameters:", { projectId, issueKey, date, timeSpent, description });

  chrome.storage.sync.get({
    apiToken: '',
    baseUrl: '',
  }, async (options) => {
    const JIRA = await JiraAPI(options.baseUrl, '/rest/api/2', '', options.apiToken);
    const issues = await JIRA.getIssuesForSearch(`project="${projectId}" AND key="${issueKey}"`);
    displayResults(issues, date, timeSpent, description);
  });
}

function displayResults(issues, date, timeSpent, description) {
  const resultsDiv = document.getElementById('searchResults');
  resultsDiv.innerHTML = '';  // Clear previous results

  if (!issues || issues.length === 0) {
    resultsDiv.innerHTML = '<p>No issues found.</p>';
    return;
  }

  issues.forEach(issue => {
    const { key, fields } = issue;
    const issueDiv = document.createElement('div');
    issueDiv.style.border = '1px solid #ccc';
    issueDiv.style.padding = '10px';
    issueDiv.style.marginBottom = '10px';
    issueDiv.style.borderRadius = '8px';
    issueDiv.style.backgroundColor = '#fff';
    issueDiv.style.color = '#000';

    const title = document.createElement('h3');
    title.textContent = `${key}: ${fields.summary}`;
    issueDiv.appendChild(title);

    const details = document.createElement('p');
    details.innerHTML = `
      <strong>Assignee:</strong> ${fields.assignee ? fields.assignee.displayName : 'Unassigned'}<br>
      <strong>Status:</strong> ${fields.status.name}<br>
      <strong>Description:</strong> ${fields.description || 'No description available'}<br>
      <strong>Date:</strong> ${new Date(date).toLocaleString()}<br>
      <strong>Time Spent:</strong> ${timeSpent}<br>
      <strong>Additional Description:</strong> ${description}
    `;
    issueDiv.appendChild(details);

    resultsDiv.appendChild(issueDiv);
  });
}

async function JiraAPI(baseUrl, apiExtension, username, apiToken) {
  const apiUrl = `${baseUrl}${apiExtension}`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${btoa(username + ':' + apiToken)}`
  };

  async function getProjects() {
    const response = await fetch(`${apiUrl}/project`, { headers });
    return await handleResponse(response);
  }

  async function getIssues(projectKey) {
    const response = await fetch(`${apiUrl}/search?jql=project=${projectKey}`, { headers });
    const data = await handleResponse(response);
    return data.issues;
  }

  async function getIssuesForSearch(jql) {
    const response = await fetch(`${apiUrl}/search?jql=${encodeURIComponent(jql)}`, { headers });
    const data = await handleResponse(response);
    return data.issues;
  }

  async function handleResponse(response) {
    if (!response.ok) {
      const error = await response.text();
      throw new Error(error);
    }
    return await response.json();
  }

  return {
    getProjects,
    getIssues,
    getIssuesForSearch,
  };
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
  } else {
    console.warn('Success element not found');
  }
}

function clearMessages() {
  const error = document.getElementById('error');
  const success = document.getElementById('success');
  if (error) error.style.display = 'none';
  if (success) success.style.display = 'none';
}

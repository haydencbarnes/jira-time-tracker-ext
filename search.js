document.addEventListener('DOMContentLoaded', onDOMContentLoaded);

async function onDOMContentLoaded() {
  chrome.storage.sync.get({
    apiToken: '',
    baseUrl: ''
  }, async (options) => {
    console.log('Storage options:', options); // Debug storage retrieval
    await init(options);
  });

  // Set today's date as default
  const datePicker = document.getElementById('datePicker');
  datePicker.value = new Date().toISOString().split('T')[0];
}

async function init(options) {
  console.log("Options received:", options);

  try {
    const JIRA = await JiraAPI(options.baseUrl, '/rest/api/2', '', options.apiToken);
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

    document.getElementById('search').addEventListener('click', searchIssues);
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
      // Correct the JQL query to use the proper syntax
      const issues = await JIRA.getIssues(`project=${projectKey}`);
      console.log('Fetched issues for project', projectKey, ':', issues); // Debug issue fetching
      issues.forEach(issue => {
        const option = document.createElement('option');
        option.value = issue.id;
        option.textContent = `${issue.key}: ${issue.fields.summary}`;
        issueSelect.appendChild(option);
      });
    } catch (error) {
      console.error('Error fetching issues:', error);
      displayError(`Error fetching issues: ${error.message}`);
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
    baseUrl: ''
  }, async (options) => {
    const JIRA = await JiraAPI(options.baseUrl, '/rest/api/2', '', options.apiToken);
    try {
      const issues = await JIRA.getIssuesForSearch(`project="${projectId}" AND key="${issueKey}"`);
      displayResults(issues, date, timeSpent, description);
    } catch (error) {
      console.error('Error searching issues:', error);
      displayError(`Error searching issues: ${error.message}`);
    }
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

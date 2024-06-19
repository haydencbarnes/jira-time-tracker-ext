
(async function () {
    document.addEventListener('DOMContentLoaded', () => {
        populateProjectAndIssueKeys();
        document.getElementById('search').addEventListener('click', searchIssues);

        flatpickr("#datePicker", {
            enableTime: true,
            dateFormat: "Y-m-d H:i",
        });
    });

    function openDatePicker() {
        document.querySelector("#datePicker")._flatpickr.open();
    }

    async function populateProjectAndIssueKeys() {
        // Simulate fetching project IDs and issue keys from API
        const projectSelect = document.getElementById('projectId');
        const issueSelect = document.getElementById('issueKey');

        let projects = await fetchProjects();
        let issues = await fetchIssues();

        projects.forEach(project => {
            const option = document.createElement('option');
            option.value = project.id;
            option.textContent = project.name;
            projectSelect.appendChild(option);
        });

        issues.forEach(issue => {
            const option = document.createElement('option');
            option.value = issue.id;
            option.textContent = issue.key + ': ' + issue.summary;
            issueSelect.appendChild(option);
        });
    }

    function fetchProjects() {
        return new Promise(resolve => {
            setTimeout(() => {
                resolve([
                    { id: 'Elation', name: 'Elation' },
                    { id: 'ProjectX', name: 'Project X' },
                ]);
            }, 500);
        });
    }

    function fetchIssues() {
        return new Promise(resolve => {
            setTimeout(() => {
                resolve([
                    { id: 'ELAT-26', key: 'ELAT-26', summary: 'Please merge these accounts' },
                    { id: 'PROJX-12', key: 'PROJX-12', summary: 'Fix login bug' },
                ]);
            }, 500);
        });
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
            const jira = await JiraAPI(options.baseUrl, '/rest/api/2', '', options.apiToken, `project="${projectId}" AND key="${issueKey}"`);
            const issues = await jira.getIssues(`project="${projectId}" AND key="${issueKey}"`);
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
})();
(async function () {
    document.addEventListener('DOMContentLoaded', restoreOptions);
    document.getElementById('save').addEventListener('click', saveOptions);

    const experimentalFeaturesToggle = document.getElementById('experimentalFeatures');
    const slider = document.querySelector('.slider');
    const timerLinkContainer = document.getElementById('timerLinkContainer');
    const jiraTypeSelect = document.getElementById('jiraType');
    const urlRow = document.getElementById('urlRow');
    const baseUrlInput = document.getElementById('baseUrl');

    // Create shapes
    const shapeCount = 15;
    const shapes = ['circle', 'square', 'triangle'];
    for (let i = 0; i < shapeCount; i++) {
        const shape = document.createElement('div');
        shape.className = `shape ${shapes[Math.floor(Math.random() * shapes.length)]}`;
        shape.style.left = `${Math.random() * 100}%`;
        shape.style.top = `${Math.random() * 100}%`;
        shape.style.width = `${Math.random() * 5 + 2}px`;
        shape.style.height = shape.style.width;
        shape.style.backgroundColor = `hsl(${Math.random() * 360}, 100%, 75%)`;
        shape.style.animation = `float ${Math.random() * 2 + 1}s infinite ease-in-out`;
        slider.appendChild(shape);
    }

    function updateTimerLinkVisibility() {
        if (timerLinkContainer) {
            timerLinkContainer.style.display = experimentalFeaturesToggle.checked ? 'inline' : 'none';
        }
    }

    experimentalFeaturesToggle.addEventListener('change', function() {
        if (this.checked) {
            slider.querySelectorAll('.shape').forEach(shape => {
                shape.style.opacity = '1';
            });
        } else {
            slider.querySelectorAll('.shape').forEach(shape => {
                shape.style.opacity = '0';
            });
        }
        updateTimerLinkVisibility();
    });

    jiraTypeSelect.addEventListener('change', function() {
        if (this.value === 'server') {
            baseUrlInput.placeholder = 'https://your-jira-server.com';
            urlRow.querySelector('td:first-child b').textContent = 'Jira Server URL*';
        } else {
            baseUrlInput.placeholder = 'https://your-domain.atlassian.net';
            urlRow.querySelector('td:first-child b').textContent = 'Jira Cloud URL*';
        }
    });

    function saveOptions() {
        const jiraType = jiraTypeSelect.value;
        const username = document.getElementById('username').value;
        const apiToken = document.getElementById('password').value;
        const baseUrl = baseUrlInput.value;
        const jql = document.getElementById('jql').value;
        const experimentalFeatures = experimentalFeaturesToggle.checked;

        chrome.storage.sync.set({
            jiraType,
            username,
            apiToken,
            baseUrl,
            jql,
            experimentalFeatures,
        }, function () {
            const status = document.getElementById('status');
            status.textContent = 'Options saved.';
            setTimeout(function () {
                status.textContent = '';
            }, 1000);
            updateTimerLinkVisibility();
        });
    }


    async function restoreOptions() {
        chrome.storage.sync.get({
            jiraType: 'cloud',
            username: '',
            apiToken: '',
            baseUrl: '',
            jql: '(assignee=currentUser() OR worklogAuthor=currentUser()) AND status NOT IN (Closed, Done)',
            experimentalFeatures: false
        }, async function (items) {
            jiraTypeSelect.value = items.jiraType;
            document.getElementById('username').value = items.username;
            document.getElementById('password').value = items.apiToken;
            baseUrlInput.value = items.baseUrl;
            document.getElementById('jql').value = items.jql;
            experimentalFeaturesToggle.checked = items.experimentalFeatures;
    
            updateTimerLinkVisibility();
            jiraTypeSelect.dispatchEvent(new Event('change'));

            const apiExtension = items.jiraType === 'cloud' ? '/rest/api/3' : '/rest/api/2';
            const jira = await JiraAPI(items.jiraType, items.baseUrl, apiExtension, items.username, items.apiToken, items.jql);
            const issues = await jira.getIssues(items.jql);
        });
    }
})();

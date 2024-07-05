(async function () {
    document.addEventListener('DOMContentLoaded', restoreOptions);
    document.getElementById('save').addEventListener('click', saveOptions);

    const experimentalFeaturesToggle = document.getElementById('experimentalFeatures');
    const slider = document.querySelector('.slider');

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
    });

    function saveOptions() {
        const username = document.getElementById('username').value;
        const apiToken = document.getElementById('password').value;
        const baseUrl = document.getElementById('baseUrl').value;
        const jql = document.getElementById('jql').value;
        const experimentalFeatures = experimentalFeaturesToggle.checked;

        chrome.storage.sync.set({
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
        });
    }

    async function restoreOptions() {
        chrome.storage.sync.get({
            username: '',
            apiToken: '',
            baseUrl: '',
            jql: '(assignee=currentUser() OR worklogAuthor=currentUser()) AND status NOT IN (Closed, Done)',
            experimentalFeatures: false
        }, async function (items) {
            document.getElementById('username').value = items.username;
            document.getElementById('password').value = items.apiToken;
            document.getElementById('baseUrl').value = items.baseUrl;
            document.getElementById('jql').value = items.jql;
            experimentalFeaturesToggle.checked = items.experimentalFeatures;
    
            const jira = await JiraAPI(items.baseUrl, '/rest/api/2', items.username, items.apiToken, items.jql);
            const issues = await jira.getIssues(items.jql);
        });
    }
})();

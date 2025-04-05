(async function () {
    document.addEventListener('DOMContentLoaded', restoreOptions);
    document.getElementById('save').addEventListener('click', saveOptions);
    document.addEventListener('DOMContentLoaded', () => {
        const manifestData = chrome.runtime.getManifest();
        const version = manifestData.version;
        document.getElementById('version').value = version;
    });    

    const experimentalFeaturesToggle = document.getElementById('experimentalFeatures');
    const experimentalSlider = document.querySelector('#experimentalFeatures + .slider');
    const jiraTypeSelect = document.getElementById('jiraType');
    const urlRow = document.getElementById('urlRow');
    const baseUrlInput = document.getElementById('baseUrl');
    const darkModeToggle = document.getElementById('darkModeToggle');
    const darkModeRow = document.getElementById('darkModeRow');

    function updateDarkModeVisibility(isExperimental) {
        darkModeRow.style.display = isExperimental ? 'table-row' : 'none';
        if (!isExperimental) {
            darkModeToggle.checked = false;
            document.body.classList.remove('dark-mode');
            chrome.storage.sync.set({ darkMode: false });
        }
    }

    darkModeToggle.addEventListener('change', function() {
        const isDark = this.checked;
        if (isDark) {
            document.body.classList.add('dark-mode');
        } else {
            document.body.classList.remove('dark-mode');
        }
        chrome.storage.sync.set({ darkMode: isDark });
    });

    // Create shapes for the experimental features slider
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
        experimentalSlider.appendChild(shape);
    }

    experimentalFeaturesToggle.addEventListener('change', function() {
        if (this.checked) {
            experimentalSlider.querySelectorAll('.shape').forEach(shape => {
                shape.style.opacity = '1';
            });
        } else {
            experimentalSlider.querySelectorAll('.shape').forEach(shape => {
                shape.style.opacity = '0';
            });
        }
        updateDarkModeVisibility(this.checked);
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
        const frequentWorklogDescription1 = document.getElementById('frequentWorklogDescription1').value;
        const frequentWorklogDescription2 = document.getElementById('frequentWorklogDescription2').value;
        const defaultPage = document.getElementById('defaultPage').value;

        chrome.storage.sync.set({
            jiraType,
            username,
            apiToken,
            baseUrl,
            jql,
            experimentalFeatures,
            frequentWorklogDescription1,
            frequentWorklogDescription2,
            defaultPage: defaultPage
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
          jiraType: 'cloud',
          username: '',
          apiToken: '',
          baseUrl: '',
          jql: '(assignee=currentUser() OR worklogAuthor=currentUser()) AND status NOT IN (Closed, Done)',
          experimentalFeatures: false,
          frequentWorklogDescription1: '',
          frequentWorklogDescription2: '',
          defaultPage: 'popup.html',
          darkMode: false
        }, async function (items) {
          jiraTypeSelect.value = items.jiraType;
          document.getElementById('username').value = items.username;
          document.getElementById('password').value = items.apiToken;
          baseUrlInput.value = items.baseUrl;
          document.getElementById('jql').value = items.jql;
          experimentalFeaturesToggle.checked = items.experimentalFeatures;
          document.getElementById('frequentWorklogDescription1').value = items.frequentWorklogDescription1;
          document.getElementById('frequentWorklogDescription2').value = items.frequentWorklogDescription2;
          document.getElementById('defaultPage').value = items.defaultPage;
      
          updateDarkModeVisibility(items.experimentalFeatures);
          if (items.experimentalFeatures && items.darkMode) {
            darkModeToggle.checked = items.darkMode;
            document.body.classList.add('dark-mode');
          }
      
          jiraTypeSelect.dispatchEvent(new Event('change'));
      
          const apiExtension = items.jiraType === 'cloud' ? '/rest/api/3' : '/rest/api/2';
          const jira = await JiraAPI(items.jiraType, items.baseUrl, apiExtension, items.username, items.apiToken, items.jql);
          const issues = await jira.getIssues(items.jql);
        });
    }
})();
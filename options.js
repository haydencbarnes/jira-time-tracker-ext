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
    const systemThemeToggle = document.getElementById('systemThemeToggle');
    const sidePanelToggle = document.getElementById('sidePanelToggle');
    const sidePanelRow = document.getElementById('sidePanelRow');

    // Add proper theme toggle functionality
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
        
        function updateThemeButton(isDark) {
            const iconSpan = themeToggle.querySelector('.icon');
            if (isDark) {
                iconSpan.textContent = '☀️';
                themeToggle.title = 'Switch to light mode';
            } else {
                iconSpan.textContent = '🌙';
                themeToggle.title = 'Switch to dark mode';
            }
        }
        
        // Load settings and apply theme
        chrome.storage.sync.get(['followSystemTheme', 'darkMode'], function(result) {
            const followSystem = result.followSystemTheme !== false; // default true
            const manualDark = result.darkMode === true;
            applyTheme(followSystem, manualDark);
            
            // Initialize system theme toggle
            systemThemeToggle.checked = followSystem;
        });
        
        // Theme button disables system-following and sets manual override
        themeToggle.addEventListener('click', function() {
            const isDark = !document.body.classList.contains('dark-mode');
            updateThemeButton(isDark);
            setTheme(isDark);
            chrome.storage.sync.set({ darkMode: isDark, followSystemTheme: false });
            
            // Update system theme toggle to match
            systemThemeToggle.checked = false;
        });
        
        // System theme toggle handler
        systemThemeToggle.addEventListener('change', function() {
            const followSystem = this.checked;
            chrome.storage.sync.set({ followSystemTheme: followSystem }, function() {
                chrome.storage.sync.get(['darkMode'], function(result) {
                    applyTheme(followSystem, result.darkMode === true);
                });
            });
        });
        
        // Listen for changes from other tabs/options
        chrome.storage.onChanged.addListener(function(changes, namespace) {
            if (namespace === 'sync' && ('followSystemTheme' in changes || 'darkMode' in changes)) {
                chrome.storage.sync.get(['followSystemTheme', 'darkMode'], function(result) {
                    const followSystem = result.followSystemTheme !== false;
                    const manualDark = result.darkMode === true;
                    applyTheme(followSystem, manualDark);
                    systemThemeToggle.checked = followSystem;
                });
            }
        });
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
        sidePanelRow.style.display = this.checked ? 'table-row' : 'none';
        if (!this.checked) {
            sidePanelToggle.checked = false;
            chrome.storage.sync.set({ sidePanelEnabled: false });
        }
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
        const sidePanelEnabled = sidePanelToggle.checked;

        chrome.storage.sync.set({
            jiraType,
            username,
            apiToken,
            baseUrl,
            jql,
            experimentalFeatures,
            frequentWorklogDescription1,
            frequentWorklogDescription2,
            defaultPage: defaultPage,
            sidePanelEnabled
        }, function () {
            // Notify all content scripts about experimental features change
            chrome.tabs.query({}, function(tabs) {
                tabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, {
                        type: 'SETTINGS_CHANGED',
                        experimentalFeatures: experimentalFeatures
                    }, function(response) {
                        // Ignore errors for tabs that don't have content scripts
                        if (chrome.runtime.lastError) {
                            // Expected for pages without content scripts
                        }
                    });
                });
            });
            
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
          followSystemTheme: true,
          sidePanelEnabled: false
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

          systemThemeToggle.checked = items.followSystemTheme;

          sidePanelRow.style.display = items.experimentalFeatures ? 'table-row' : 'none';
          sidePanelToggle.checked = items.experimentalFeatures && items.sidePanelEnabled;

          jiraTypeSelect.dispatchEvent(new Event('change'));

          const apiExtension = items.jiraType === 'cloud' ? '/rest/api/3' : '/rest/api/2';
          const jira = await JiraAPI(items.jiraType, items.baseUrl, apiExtension, items.username, items.apiToken, items.jql);
          const issues = await jira.getIssues(items.jql);
        });
    }
})();
let currentWeekStart = new Date();
let JIRA;
let currentWeekData = {};

// Initialize theme immediately
(function immediateTheme() {
    chrome.storage && chrome.storage.sync && chrome.storage.sync.get && chrome.storage.sync.get(['followSystemTheme', 'darkMode'], function(result) {
        const followSystem = result && result.followSystemTheme !== false;
        const manualDark = result && result.darkMode === true;
        if (followSystem) {
            const mql = window.matchMedia('(prefers-color-scheme: dark)');
            setTheme(mql.matches);
        } else {
            setTheme(manualDark);
        }
    });
    
    function setTheme(isDark) {
        if (isDark) {
            document.body.classList.add('dark-mode');
        } else {
            document.body.classList.remove('dark-mode');
        }
    }
})();

document.addEventListener('DOMContentLoaded', async function() {
    await initializeWeeklyView();
    setupEventListeners();
    setupTheme();
    await loadWeeklyData();
});

function setupTheme() {
    const themeToggle = document.getElementById('themeToggle');
    const themeToggle2 = document.getElementById('themeToggle2');
    
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
    
    // Load settings and apply theme
    chrome.storage.sync.get(['followSystemTheme', 'darkMode'], function(result) {
        const followSystem = result.followSystemTheme !== false;
        const manualDark = result.darkMode === true;
        applyTheme(followSystem, manualDark);
    });
    
    // Theme button click handlers
    [themeToggle, themeToggle2].forEach(button => {
        if (button) {
            button.addEventListener('click', function() {
                const isDark = !document.body.classList.contains('dark-mode');
                updateThemeButton(isDark);
                setTheme(isDark);
                chrome.storage.sync.set({ darkMode: isDark, followSystemTheme: false });
            });
        }
    });
    
    // Listen for changes from other tabs
    chrome.storage.onChanged.addListener(function(changes, namespace) {
        if (namespace === 'sync' && ('followSystemTheme' in changes || 'darkMode' in changes)) {
            chrome.storage.sync.get(['followSystemTheme', 'darkMode'], function(result) {
                const followSystem = result.followSystemTheme !== false;
                const manualDark = result.darkMode === true;
                applyTheme(followSystem, manualDark);
            });
        }
    });
}

function updateThemeButton(isDark) {
    [document.getElementById('themeToggle'), document.getElementById('themeToggle2')].forEach(button => {
        if (button) {
            const iconSpan = button.querySelector('.icon');
            if (isDark) {
                iconSpan.textContent = '☀️';
                button.title = 'Switch to light mode';
            } else {
                iconSpan.textContent = '🌙';
                button.title = 'Switch to dark mode';
            }
        }
    });
}

async function initializeWeeklyView() {
    try {
        const options = await new Promise((resolve, reject) => {
            chrome.storage.sync.get({
                apiToken: '',
                baseUrl: '',
                jql: '',
                username: '',
                jiraType: 'server'
            }, (result) => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve(result);
                }
            });
        });

        JIRA = await JiraAPI(options.jiraType, options.baseUrl, options.username, options.apiToken);
        
        if (!JIRA || typeof JIRA.getIssues !== 'function') {
            throw new Error('JIRA API setup failed');
        }

        // Set current week to start of this week (Monday)
        setCurrentWeekStart(new Date());
        
    } catch (error) {
        console.error('Error initializing weekly view:', error);
        displayError('Failed to initialize weekly view. Please check your JIRA settings.');
    }
}

function setupEventListeners() {
    document.getElementById('prevWeek').addEventListener('click', () => {
        navigateWeek(-1);
    });
    
    document.getElementById('nextWeek').addEventListener('click', () => {
        navigateWeek(1);
    });
    
    document.getElementById('backToMain').addEventListener('click', () => {
        window.location.href = 'popup.html?source=navigation';
    });
    
    document.getElementById('refreshData').addEventListener('click', () => {
        loadWeeklyData();
    });
    
    document.getElementById('exportWeek').addEventListener('click', () => {
        exportWeeklyData();
    });
    
    document.getElementById('bulkAction').addEventListener('click', () => {
        handleBulkAction();
    });
}

function setCurrentWeekStart(date) {
    // Set to start of week (Monday)
    currentWeekStart = new Date(date);
    const dayOfWeek = currentWeekStart.getDay();
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Sunday = 0, so Sunday to Monday is 6 days back
    currentWeekStart.setDate(date.getDate() - daysToMonday);
    currentWeekStart.setHours(0, 0, 0, 0);
    updateWeekRange();
    updateDayHeaders();
}

function updateWeekRange() {
    const weekEnd = new Date(currentWeekStart);
    weekEnd.setDate(currentWeekStart.getDate() + 6);
    
    const options = { month: 'short', day: 'numeric' };
    const startStr = currentWeekStart.toLocaleDateString('en-US', options);
    const endStr = weekEnd.toLocaleDateString('en-US', options);
    
    document.getElementById('weekRange').textContent = `${startStr} - ${endStr}`;
}

function updateDayHeaders() {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    for (let i = 0; i < 7; i++) {
        const date = new Date(currentWeekStart);
        date.setDate(currentWeekStart.getDate() + i);
        const dayElement = document.getElementById(`day${i}`);
        if (dayElement) {
            dayElement.innerHTML = `${days[i]}<br>${months[date.getMonth()]}<br>${date.getDate()}`;
        }
    }
}

function navigateWeek(direction) {
    const newDate = new Date(currentWeekStart);
    newDate.setDate(currentWeekStart.getDate() + (direction * 7));
    setCurrentWeekStart(newDate);
    loadWeeklyData();
}

async function loadWeeklyData() {
    try {
        showLoading(true);
        clearError();
        
        // Get issues and their worklogs for the current week
        const weekEnd = new Date(currentWeekStart);
        weekEnd.setDate(currentWeekStart.getDate() + 6);
        weekEnd.setHours(23, 59, 59, 999);
        
        // Fetch issues
        const issuesResponse = await JIRA.getIssues(0, '');
        const issues = issuesResponse.data || [];
        
        // Fetch worklogs for each issue
        const worklogPromises = issues.map(async (issue) => {
            try {
                const worklogResponse = await JIRA.getIssueWorklog(issue.key);
                return {
                    issue: issue,
                    worklogs: worklogResponse.worklogs || []
                };
            } catch (error) {
                console.warn(`Failed to fetch worklogs for ${issue.key}:`, error);
                return { issue: issue, worklogs: [] };
            }
        });
        
        const issueWorklogs = await Promise.all(worklogPromises);
        
        // Filter worklogs for current week
        const weeklyWorklogs = filterWorklogsForWeek(issueWorklogs, currentWeekStart, weekEnd);
        
        // Process and display the data
        currentWeekData = processWeeklyData(weeklyWorklogs);
        displayTimesheetData(currentWeekData);
        
    } catch (error) {
        console.error('Error loading weekly data:', error);
        displayError('Failed to load weekly data. Please try again.');
    } finally {
        showLoading(false);
    }
}

function filterWorklogsForWeek(issueWorklogs, weekStart, weekEnd) {
    const weeklyData = [];
    
    issueWorklogs.forEach(({ issue, worklogs }) => {
        const filteredWorklogs = worklogs.filter(worklog => {
            const worklogDate = new Date(worklog.started);
            return worklogDate >= weekStart && worklogDate <= weekEnd;
        });
        
        // Include issue even if no worklogs for this week (to show in table)
        weeklyData.push({
            issue: issue,
            worklogs: filteredWorklogs
        });
    });
    
    return weeklyData;
}

function processWeeklyData(weeklyWorklogs) {
    const projectData = {};
    
    weeklyWorklogs.forEach(({ issue, worklogs }) => {
        const projectKey = issue.fields.project.key;
        const projectName = issue.fields.project.name;
        
        if (!projectData[projectKey]) {
            projectData[projectKey] = {
                name: projectName,
                key: projectKey,
                issues: {},
                totals: Array(7).fill(0)
            };
        }
        
        if (!projectData[projectKey].issues[issue.key]) {
            projectData[projectKey].issues[issue.key] = {
                issue: issue,
                dailyHours: Array(7).fill(0),
                totalHours: 0
            };
        }
        
        const issueData = projectData[projectKey].issues[issue.key];
        
        // Process worklogs for this issue
        worklogs.forEach(worklog => {
            const worklogDate = new Date(worklog.started);
            const dayOfWeek = worklogDate.getDay();
            const dayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Convert Sunday=0 to Sunday=6, Monday=1 to Monday=0
            
            const hours = worklog.timeSpentSeconds / 3600;
            issueData.dailyHours[dayIndex] += hours;
            issueData.totalHours += hours;
            projectData[projectKey].totals[dayIndex] += hours;
        });
    });
    
    return projectData;
}

function displayTimesheetData(projectData) {
    const tbody = document.getElementById('timesheetBody');
    tbody.innerHTML = '';
    
    let grandTotals = Array(7).fill(0);
    let grandTotal = 0;
    
    Object.values(projectData).forEach(project => {
        // Add project header row
        const projectRow = createProjectHeaderRow(project);
        tbody.appendChild(projectRow);
        
        // Add issue rows
        Object.values(project.issues).forEach(issueData => {
            const issueRow = createIssueRow(issueData, project.key);
            tbody.appendChild(issueRow);
            
            // Add to grand totals
            grandTotal += issueData.totalHours;
        });
        
        // Add project total row
        const projectTotalRow = createProjectTotalRow(project);
        tbody.appendChild(projectTotalRow);
        
        // Add to grand totals
        for (let i = 0; i < 7; i++) {
            grandTotals[i] += project.totals[i];
        }
    });
    
    // Add grand total row
    const grandTotalRow = createGrandTotalRow(grandTotals, grandTotal);
    tbody.appendChild(grandTotalRow);
    
    document.getElementById('timesheetContent').style.display = 'block';
}

function createProjectHeaderRow(project) {
    const row = document.createElement('tr');
    row.className = 'project-header';
    row.dataset.projectKey = project.key;
    
    const projectTotal = project.totals.reduce((sum, hours) => sum + hours, 0);
    
    row.innerHTML = `
        <td class="bulk-cell"></td>
        <td colspan="2" class="project-name">
            <span class="expand-icon">▼</span>
            ${project.name} - ${project.key}
        </td>
        ${project.totals.map(hours => `<td class="time-cell">${formatHours(hours)}</td>`).join('')}
        <td class="total-cell">${formatHours(projectTotal)}</td>
    `;
    
    // Add click handler for expand/collapse
    const projectNameCell = row.querySelector('.project-name');
    projectNameCell.addEventListener('click', () => toggleProjectExpansion(project.key));
    
    return row;
}

function createIssueRow(issueData, projectKey) {
    const row = document.createElement('tr');
    row.className = 'issue-row';
    row.dataset.projectKey = projectKey;
    row.dataset.issueKey = issueData.issue.key;
    
    const hasAnyTime = issueData.dailyHours.some(hours => hours > 0);
    
    row.innerHTML = `
        <td class="bulk-cell">
            <input type="checkbox" class="bulk-checkbox" value="${issueData.issue.key}">
        </td>
        <td class="issue-key">
            <a href="#" class="issue-key" data-issue-key="${issueData.issue.key}">${issueData.issue.key}</a>
        </td>
        <td class="issue-summary">${issueData.issue.fields.summary}</td>
        ${issueData.dailyHours.map(hours => `<td class="time-cell ${hours > 0 ? 'has-time' : ''}">${formatHours(hours)}</td>`).join('')}
        <td class="total-cell">${formatHours(issueData.totalHours)}</td>
    `;
    
    // Add click handler for issue key
    const issueKeyLink = row.querySelector('.issue-key');
    issueKeyLink.addEventListener('click', (e) => {
        e.preventDefault();
        openIssueInJira(issueData.issue.key);
    });
    
    return row;
}

function createProjectTotalRow(project) {
    const row = document.createElement('tr');
    row.className = 'project-total';
    row.dataset.projectKey = project.key;
    
    const projectTotal = project.totals.reduce((sum, hours) => sum + hours, 0);
    
    row.innerHTML = `
        <td class="bulk-cell"></td>
        <td colspan="2" style="text-align: right; padding-right: 10px;">${project.key}</td>
        ${project.totals.map(hours => `<td class="time-cell">${formatHours(hours)}</td>`).join('')}
        <td class="total-cell">${formatHours(projectTotal)}</td>
    `;
    
    return row;
}

function createGrandTotalRow(grandTotals, grandTotal) {
    const row = document.createElement('tr');
    row.className = 'summary-row';
    
    row.innerHTML = `
        <td class="bulk-cell"></td>
        <td colspan="2" style="text-align: right; padding-right: 10px;">Total</td>
        ${grandTotals.map(hours => `<td class="time-cell">${formatHours(hours)}</td>`).join('')}
        <td class="total-cell">${formatHours(grandTotal)}</td>
    `;
    
    return row;
}

function formatHours(hours) {
    if (hours === 0) return '0';
    return hours.toFixed(2);
}

function toggleProjectExpansion(projectKey) {
    const projectRow = document.querySelector(`[data-project-key="${projectKey}"].project-header`);
    const expandIcon = projectRow.querySelector('.expand-icon');
    const issueRows = document.querySelectorAll(`[data-project-key="${projectKey}"].issue-row`);
    const projectTotalRow = document.querySelector(`[data-project-key="${projectKey}"].project-total`);
    
    const isCollapsed = projectRow.classList.contains('collapsed');
    
    if (isCollapsed) {
        projectRow.classList.remove('collapsed');
        expandIcon.textContent = '▼';
        issueRows.forEach(row => row.style.display = '');
        if (projectTotalRow) projectTotalRow.style.display = '';
    } else {
        projectRow.classList.add('collapsed');
        expandIcon.textContent = '▶';
        issueRows.forEach(row => row.style.display = 'none');
        if (projectTotalRow) projectTotalRow.style.display = 'none';
    }
}

function openIssueInJira(issueKey) {
    chrome.storage.sync.get(['baseUrl'], (result) => {
        const baseUrl = result.baseUrl;
        if (baseUrl) {
            const normalizedBaseUrl = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
            const finalUrl = normalizedBaseUrl.endsWith('/') ? normalizedBaseUrl : `${normalizedBaseUrl}/`;
            const url = `${finalUrl}browse/${issueKey}`;
            window.open(url, '_blank');
        }
    });
}

function handleBulkAction() {
    const selectedCheckboxes = document.querySelectorAll('.bulk-checkbox:checked');
    const selectedIssues = Array.from(selectedCheckboxes).map(cb => cb.value);
    
    if (selectedIssues.length === 0) {
        displayError('Please select at least one issue for bulk action.');
        return;
    }
    
    // For now, just show selected issues
    alert(`Selected issues: ${selectedIssues.join(', ')}`);
    
    // Clear selections
    selectedCheckboxes.forEach(cb => cb.checked = false);
}

function exportWeeklyData() {
    if (!currentWeekData || Object.keys(currentWeekData).length === 0) {
        displayError('No data to export. Please load weekly data first.');
        return;
    }
    
    const weekEnd = new Date(currentWeekStart);
    weekEnd.setDate(currentWeekStart.getDate() + 6);
    
    let csvContent = 'Project,Issue Key,Issue Summary,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday,Total\n';
    
    Object.values(currentWeekData).forEach(project => {
        Object.values(project.issues).forEach(issueData => {
            const summary = issueData.issue.fields.summary.replace(/"/g, '""');
            const dailyHours = issueData.dailyHours.map(h => formatHours(h)).join(',');
            csvContent += `"${project.name}","${issueData.issue.key}","${summary}",${dailyHours},${formatHours(issueData.totalHours)}\n`;
        });
    });
    
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `weekly-timesheet-${currentWeekStart.toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
}

function showLoading(show) {
    document.getElementById('loading').style.display = show ? 'block' : 'none';
    document.getElementById('timesheetContent').style.display = show ? 'none' : 'block';
}

function displayError(message) {
    const errorElement = document.getElementById('error');
    errorElement.textContent = message;
    errorElement.style.display = 'block';
}

function clearError() {
    document.getElementById('error').style.display = 'none';
}
let currentWeekStart = new Date();
let JIRA;
let allWorklogs = [];
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
    
    // Theme button click handler
    themeToggle.addEventListener('click', function() {
        const isDark = !document.body.classList.contains('dark-mode');
        updateThemeButton(isDark);
        setTheme(isDark);
        chrome.storage.sync.set({ darkMode: isDark, followSystemTheme: false });
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
    const themeToggle = document.getElementById('themeToggle');
    const iconSpan = themeToggle.querySelector('.icon');
    if (isDark) {
        iconSpan.textContent = '☀️';
        themeToggle.title = 'Switch to light mode';
    } else {
        iconSpan.textContent = '🌙';
        themeToggle.title = 'Switch to dark mode';
    }
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

        // Set current week to start of this week (Sunday)
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
}

function setCurrentWeekStart(date) {
    // Set to start of week (Sunday)
    currentWeekStart = new Date(date);
    currentWeekStart.setDate(date.getDate() - date.getDay());
    currentWeekStart.setHours(0, 0, 0, 0);
    updateWeekRange();
}

function updateWeekRange() {
    const weekEnd = new Date(currentWeekStart);
    weekEnd.setDate(currentWeekStart.getDate() + 6);
    
    const options = { month: 'short', day: 'numeric', year: 'numeric' };
    const startStr = currentWeekStart.toLocaleDateString('en-US', options);
    const endStr = weekEnd.toLocaleDateString('en-US', options);
    
    document.getElementById('weekRange').textContent = `${startStr} - ${endStr}`;
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
        
        // Fetch issues (you can customize JQL here)
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
        displayWeeklyData(currentWeekData);
        
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
        
        if (filteredWorklogs.length > 0) {
            weeklyData.push({
                issue: issue,
                worklogs: filteredWorklogs
            });
        }
    });
    
    return weeklyData;
}

function processWeeklyData(weeklyWorklogs) {
    const weekData = {
        days: {},
        summary: {
            totalTime: 0,
            issuesWorked: new Set(),
            workingDays: new Set()
        }
    };
    
    // Initialize days
    for (let i = 0; i < 7; i++) {
        const date = new Date(currentWeekStart);
        date.setDate(currentWeekStart.getDate() + i);
        const dateStr = date.toISOString().split('T')[0];
        weekData.days[dateStr] = {
            date: date,
            tasks: []
        };
    }
    
    // Process worklogs
    weeklyWorklogs.forEach(({ issue, worklogs }) => {
        worklogs.forEach(worklog => {
            const worklogDate = new Date(worklog.started);
            const dateStr = worklogDate.toISOString().split('T')[0];
            
            if (weekData.days[dateStr]) {
                weekData.days[dateStr].tasks.push({
                    issue: issue,
                    worklog: worklog,
                    time: worklog.timeSpentSeconds,
                    comment: getWorklogComment(worklog)
                });
                
                weekData.summary.totalTime += worklog.timeSpentSeconds;
                weekData.summary.issuesWorked.add(issue.key);
                weekData.summary.workingDays.add(dateStr);
            }
        });
    });
    
    return weekData;
}

function getWorklogComment(worklog) {
    if (typeof worklog.comment === 'string') {
        return worklog.comment;
    } else if (worklog.comment && worklog.comment.content) {
        // Handle ADF (Atlassian Document Format) comments
        return worklog.comment.content
            .map(block => block.content || [])
            .flat()
            .map(content => content.text || '')
            .join(' ');
    }
    return '';
}

function displayWeeklyData(weekData) {
    displaySummary(weekData.summary);
    displayCalendar(weekData.days);
    
    document.getElementById('weeklyContent').style.display = 'block';
}

function displaySummary(summary) {
    const totalHours = (summary.totalTime / 3600).toFixed(1);
    const issuesCount = summary.issuesWorked.size;
    const workingDaysCount = summary.workingDays.size;
    const avgPerDay = workingDaysCount > 0 ? (summary.totalTime / workingDaysCount / 3600).toFixed(1) : 0;
    
    document.getElementById('totalTime').textContent = `${totalHours}h`;
    document.getElementById('issuesWorked').textContent = issuesCount;
    document.getElementById('workingDays').textContent = workingDaysCount;
    document.getElementById('avgPerDay').textContent = `${avgPerDay}h`;
}

function displayCalendar(days) {
    const calendar = document.getElementById('weeklyCalendar');
    
    // Remove existing day cells (keep headers)
    const existingDays = calendar.querySelectorAll('.calendar-day');
    existingDays.forEach(day => day.remove());
    
    // Add day cells
    Object.keys(days).sort().forEach(dateStr => {
        const dayData = days[dateStr];
        const dayElement = createDayElement(dayData);
        calendar.appendChild(dayElement);
    });
}

function createDayElement(dayData) {
    const dayElement = document.createElement('div');
    dayElement.className = 'calendar-day';
    
    const today = new Date();
    const dayDate = dayData.date;
    
    // Add special classes
    if (dayDate.toDateString() === today.toDateString()) {
        dayElement.classList.add('today');
    }
    
    // Day number
    const dayNumber = document.createElement('div');
    dayNumber.className = 'day-number';
    dayNumber.textContent = dayDate.getDate();
    dayElement.appendChild(dayNumber);
    
    // Tasks
    dayData.tasks.forEach(task => {
        const taskElement = createTaskElement(task);
        dayElement.appendChild(taskElement);
    });
    
    return dayElement;
}

function createTaskElement(task) {
    const taskElement = document.createElement('div');
    taskElement.className = 'task-entry';
    
    const taskKey = document.createElement('span');
    taskKey.className = 'task-key';
    taskKey.textContent = task.issue.key;
    taskElement.appendChild(taskKey);
    
    const taskTime = document.createElement('span');
    taskTime.className = 'task-time';
    const hours = (task.time / 3600).toFixed(1);
    taskTime.textContent = `${hours}h`;
    taskElement.appendChild(taskTime);
    
    if (task.comment) {
        const taskComment = document.createElement('div');
        taskComment.className = 'task-comment';
        taskComment.textContent = task.comment;
        taskElement.appendChild(taskComment);
    }
    
    // Add click handler to view issue
    taskElement.addEventListener('click', () => {
        openIssueInJira(task.issue.key);
    });
    
    return taskElement;
}

function openIssueInJira(issueKey) {
    chrome.storage.sync.get(['baseUrl'], (result) => {
        const baseUrl = result.baseUrl;
        if (baseUrl) {
            const normalizedBaseUrl = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
            const url = `${normalizedBaseUrl}/browse/${issueKey}`;
            window.open(url, '_blank');
        }
    });
}

function exportWeeklyData() {
    if (!currentWeekData || Object.keys(currentWeekData.days).length === 0) {
        displayError('No data to export. Please load weekly data first.');
        return;
    }
    
    const weekEnd = new Date(currentWeekStart);
    weekEnd.setDate(currentWeekStart.getDate() + 6);
    
    let csvContent = 'Date,Issue Key,Issue Summary,Time Spent (Hours),Comment\n';
    
    Object.keys(currentWeekData.days).sort().forEach(dateStr => {
        const dayData = currentWeekData.days[dateStr];
        dayData.tasks.forEach(task => {
            const hours = (task.time / 3600).toFixed(1);
            const comment = task.comment ? task.comment.replace(/"/g, '""') : '';
            const summary = task.issue.fields.summary.replace(/"/g, '""');
            csvContent += `"${dateStr}","${task.issue.key}","${summary}","${hours}","${comment}"\n`;
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
    document.getElementById('weeklyContent').style.display = show ? 'none' : 'block';
}

function displayError(message) {
    const errorElement = document.getElementById('error');
    errorElement.textContent = message;
    errorElement.style.display = 'block';
}

function clearError() {
    document.getElementById('error').style.display = 'none';
}
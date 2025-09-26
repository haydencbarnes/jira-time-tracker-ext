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
    // Load settings and apply theme
    chrome.storage.sync.get(['followSystemTheme', 'darkMode'], function(result) {
        const followSystem = result.followSystemTheme !== false; // default true
        const manualDark = result.darkMode === true;
        applyTheme(followSystem, manualDark);
    });
    // Theme button disables system-following and sets manual override
    themeToggle.addEventListener('click', function() {
        const isDark = !document.body.classList.contains('dark-mode');
        updateThemeButton(isDark);
        setTheme(isDark);
        chrome.storage.sync.set({ darkMode: isDark, followSystemTheme: false });
    });
    // Listen for changes from other tabs/options
    chrome.storage.onChanged.addListener(function(changes, namespace) {
        if (namespace === 'sync' && ('followSystemTheme' in changes || 'darkMode' in changes)) {
            chrome.storage.sync.get(['followSystemTheme', 'darkMode'], function(result) {
                const followSystem = result.followSystemTheme !== false;
                const manualDark = result.darkMode === true;
                applyTheme(followSystem, manualDark);
            });
        }
    });
});

// Function to update the theme button icon
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

document.addEventListener('DOMContentLoaded', onDOMContentLoaded);

async function onDOMContentLoaded() {
    chrome.storage.sync.get({
        apiToken: '',
        baseUrl: '',
        jql: '',
        username: '',
        jiraType: 'server',
        frequentWorklogDescription1: '',
        frequentWorklogDescription2: '',
        starredIssues: {},
        defaultPage: 'popup.html',
        darkMode: false,
        experimentalFeatures: false
    }, async (options) => {
        // Get current URL and check for the 'source' parameter
        const urlParams = new URLSearchParams(window.location.search);
        const isNavigatingBack = urlParams.get('source') === 'navigation';
        
        // Check if we need to redirect
        const currentPage = window.location.pathname.split('/').pop();
        if (currentPage !== options.defaultPage && !isNavigatingBack) {
            window.location.href = options.defaultPage;
            return;
        }
        
        // Clean out any stars older than 90 days
        options.starredIssues = filterExpiredStars(options.starredIssues, 90);
        
        // Save any cleaned out stars back to storage so they don't accumulate
        chrome.storage.sync.set({ starredIssues: options.starredIssues }, () => {});
        
        await init(options);
        insertFrequentWorklogDescription(options);
        
        // Worklog suggestions will be initialized after table is drawn where input elements exist
    });
}

function filterExpiredStars(starredIssues, days) {
    const now = Date.now();
    const cutoff = days * 24 * 60 * 60 * 1000;
    const filtered = {};
    for (const issueId in starredIssues) {
        if (now - starredIssues[issueId] < cutoff) {
            filtered[issueId] = starredIssues[issueId];
        }
    }
    return filtered;
}

function buildHTML(tag, html, attrs) {
    const element = document.createElement(tag);
    if (html) element.innerHTML = html;
    Object.keys(attrs || {}).forEach(attr => {
        element.setAttribute(attr, attrs[attr]);
    });
    return element;
}

async function init(options) {
    console.log("Options received:", options);

    try {
        // Initialize the JIRA API with the provided options
        const JIRA = await JiraAPI(options.jiraType, options.baseUrl, options.username, options.apiToken);
        console.log("JIRA API Object:", JIRA);

        if (!JIRA || typeof JIRA.getIssues !== 'function') {
            console.error('JIRA API instantiation failed: Methods missing', JIRA);
            displayError('JIRA API setup failed. Please check your settings and ensure all required fields (Base URL, Username, API Token) are correctly configured. Go to Settings to verify your configuration.');
            return;
        }

        // Show the main loading spinner
        toggleVisibility('div[id=loader-container]');
        try {
            // Fetch the issues from Jira
            const issuesResponse = await JIRA.getIssues(0, options.jql);
            onFetchSuccess(issuesResponse, options); // Pass options to the function
        } catch (error) {
            console.error('Error fetching issues:', error);
            window.JiraErrorHandler.handleJiraError(error, 'Failed to fetch issues from JIRA', 'popup');
        } finally {
            toggleVisibility('div[id=loader-container]'); // Hide loader
        }
    } catch (error) {
        console.error('Error initializing JIRA API:', error);
        window.JiraErrorHandler.handleJiraError(error, 'Failed to connect to JIRA', 'popup');
    }
}

function onFetchSuccess(issuesResponse, options) {
    console.log("Fetched issues:", issuesResponse);
    drawIssuesTable(issuesResponse, options); // Pass options to the function
}

function onFetchError(error) {
    toggleVisibility('div[id=loader-container]');
    window.JiraErrorHandler.handleJiraError(error, 'Failed to fetch data from JIRA', 'popup');
}

function getWorklog(issueId, JIRA) {
    const totalTime = document.querySelector(`div.issue-total-time-spent[data-issue-id="${issueId}"]`);
    const loader = totalTime.previousSibling;

    if (!totalTime || !loader) {
        console.warn(`Elements not found for issue id: ${issueId}`);
        return;
    }

    totalTime.style.display = 'none';
    loader.style.display = 'block';

    JIRA.getIssueWorklog(issueId)
        .then((response) => onWorklogFetchSuccess(response, totalTime, loader))
        .catch((error) => onWorklogFetchError(error, totalTime, loader));
}

function sumWorklogs(worklogs) {
    if (!Array.isArray(worklogs)) return '0 hrs';
    const totalSeconds = worklogs.reduce((total, log) => total + log.timeSpentSeconds, 0);
    const totalHours = (totalSeconds / 3600).toFixed(1);
    return `${totalHours} hrs`;
}

function onWorklogFetchSuccess(response, totalTime, loader) {
    try {
        totalTime.innerText = sumWorklogs(response.worklogs);
    } catch (error) {
        console.error(`Error in summing worklogs: ${error.stack}`);
        totalTime.innerText = '0 hrs';
    }
    totalTime.style.display = 'block';
    loader.style.display = 'none';
    // Ensure inputs are cleared
    document.querySelectorAll('input.issue-time-input, input.issue-comment-input').forEach(input => input.value = '');
}

function onWorklogFetchError(error, totalTime, loader) {
    totalTime.style.display = 'block';
    loader.style.display = 'none';
    window.JiraErrorHandler.handleJiraError(error, 'Failed to fetch worklog data', 'popup');
}

async function logTimeClick(evt) {
    clearMessages(); // Clear previous error and success messages

    const issueId = evt.target.getAttribute('data-issue-id');
    const timeInput = document.querySelector(`input.issue-time-input[data-issue-id="${issueId}"]`);
    const dateInput = document.querySelector(`input.issue-log-date-input[data-issue-id="${issueId}"]`);
    const commentInput = document.querySelector(`input.issue-comment-input[data-issue-id="${issueId}"]`);
    const totalTimeSpans = document.querySelector(`div.issue-total-time-spent[data-issue-id="${issueId}"]`);
    const loader = document.querySelector(`div.loader-mini[data-issue-id="${issueId}"]`);

    console.log(`Processing issue ID: ${issueId}`);
    console.log('timeInput:', timeInput);
    console.log('dateInput:', dateInput);
    console.log('commentInput:', commentInput);
    console.log('totalTimeSpans:', totalTimeSpans);
    console.log('loader:', loader);

    if (!timeInput || !timeInput.value) {
        displayError('Time field is required. Please enter the time you want to log (e.g., 2h, 30m, 1d).');
        return;
    }

    const timeMatches = timeInput.value.match(/[0-9]{1,4}[dhm]/g);
    if (!timeMatches) {
        displayError('Invalid time format. Please use:\n• Hours: 2h, 1.5h\n• Minutes: 30m, 45m\n• Days: 1d, 0.5d\n\nExamples: "2h 30m", "1d", "45m"');
        return;
    }

    const timeSpentSeconds = convertTimeToSeconds(timeInput.value);
    if (isNaN(timeSpentSeconds) || timeSpentSeconds <= 0) {
        displayError('Invalid time value. Please enter a positive time amount using valid units (d=days, h=hours, m=minutes).');
        return;
    }

    if (totalTimeSpans && loader) {
        totalTimeSpans.innerText = ''; // Clear previous total time
        totalTimeSpans.style.display = 'none';
        loader.style.display = 'block';
    } else {
        console.warn(`This issue does not have matching total time or loader spans: ${issueId}`);
        return;
    }

    const startedTime = getStartedTime(dateInput.value);

    try {
        const options = await new Promise((resolve, reject) => 
            chrome.storage.sync.get(['baseUrl', 'apiToken', 'jql', 'username', 'jiraType'], items => {
                if (chrome.runtime.lastError) {
                    return reject(chrome.runtime.lastError);
                }
                resolve(items);
            })
        );

        const JIRA = await JiraAPI(options.jiraType, options.baseUrl, options.username, options.apiToken);

        console.log(`Update worklog details: issueId=${issueId}, timeSpentSeconds=${timeSpentSeconds}, startedTime=${startedTime}, comment=${commentInput.value}`);
        
        const result = await JIRA.updateWorklog(issueId, timeSpentSeconds, startedTime, commentInput.value);

        // Handle successful response
        console.log("Worklog successfully updated:", result);

        // Display success message with the logged time
        showSuccessAnimation(issueId, timeInput.value);

        // Clear the input fields upon success
        timeInput.value = '';
        commentInput.value = '';

        // Fetch updated worklogs so that the displayed time is consistent
        getWorklog(issueId, JIRA);

    } catch (error) {
        console.error(`Error in logTimeClick function: ${error.stack}`);

        totalTimeSpans.style.display = 'block';
        loader.style.display = 'none';

        // Check for specific known issues before calling handleJiraError
        if (error && error.status === 200) {
            // Worklog update was successful but something else caused an error
            displaySuccess("Successfully logged: " + timeInput.value + " but encountered an issue afterward.");
            showErrorAnimation(issueId);
        } else {
            window.JiraErrorHandler.handleJiraError(error, `Failed to log time for issue ${issueId}`, 'popup');
            showErrorAnimation(issueId);
        }
    }
}

function convertTimeToSeconds(timeStr) {
    const timeUnits = {
        d: 60 * 60 * 24,
        h: 60 * 60,
        m: 60,
    };

    const regex = /(\d+)([wdhm])/g;
    let match;
    let totalSeconds = 0;

    while ((match = regex.exec(timeStr)) !== null) {
        const value = parseInt(match[1], 10);
        const unit = match[2];
        totalSeconds += value * timeUnits[unit];
    }

    return totalSeconds;
}

/***************
HTML Interaction Helpers
****************/
function toggleVisibility(query) {
    const element = document.querySelector(query);
    if (element) {
        element.style.display = element.style.display === 'none' || element.style.display === '' ? 'block' : 'none';
    } else {
        console.warn(`Element not found for query: ${query}`);
    }
}

function drawIssuesTable(issuesResponse, options) {
    const logTable = document.getElementById('jira-log-time-table');

    // Remove any existing <tbody>
    const oldTbody = logTable.querySelector('tbody');
    if (oldTbody) {
        oldTbody.remove();
    }

    // Create a fresh <tbody>
    const newTbody = document.createElement('tbody');

    const issues = issuesResponse.data || [];

    // ⭐️ Reorder so starred issues appear on top
    const sortedIssues = sortByStar(issues, options.starredIssues);

    sortedIssues.forEach((issue) => {
        const row = generateLogTableRow(
            issue.key,
            issue.fields.summary,
            issue.fields.worklog,
            options
        );
        newTbody.appendChild(row);
    });

    logTable.appendChild(newTbody);
    
    // Initialize worklog suggestions for all comment inputs
    // This is done here because input elements are now created and theme is already applied
    document.querySelectorAll('.issue-comment-input').forEach(input => {
        input.style.position = 'relative';
        input.style.zIndex = '1';
        initializeWorklogSuggestions(input);
    });
}

// ⭐️ utility function that sorts starred issues to top
function sortByStar(issues, starredIssues) {
    // Return a new array sorted by whether the item is starred
    return issues.slice().sort((a, b) => {
        const aStar = starredIssues[a.key] ? 1 : 0;
        const bStar = starredIssues[b.key] ? 1 : 0;
        // Sort descending so starred=1 goes first
        return bStar - aStar;
    });
}

function generateLogTableRow(id, summary, worklog, options) {
    const row = buildHTML('tr', null, { 'data-issue-id': id });

    // 1) Create a single <td> for the star + Jira ID (to keep 7 total columns)
    const idCell = buildHTML('td', '', { class: 'issue-id', 'data-issue-id': id });

    // (A) Star icon
    const isStarred = !!options.starredIssues[id];
    const starIcon = buildHTML('span', '', { class: 'star-icon' });
    // Use textContent so we don't get any weird encoding
    starIcon.textContent = isStarred ? '\u2605' : '\u2606'; // ★ or ☆

    // Apply the correct color class
    starIcon.classList.add(isStarred ? 'starred' : 'unstarred');

    // Toggle star on click
    starIcon.addEventListener('click', () => toggleStar(id, options));

    idCell.appendChild(starIcon);
    idCell.appendChild(document.createTextNode(' ')); // small spacer

    // (B) Jira ID link
    const baseUrl = options.baseUrl.startsWith('http')
        ? options.baseUrl
        : `https://${options.baseUrl}`;
    const normalizedBaseUrl = baseUrl.endsWith('/')
        ? baseUrl
        : `${baseUrl}/`;
    const jiraLink = buildHTML('a', id, {
        href: `${normalizedBaseUrl}browse/${id}`,
        target: '_blank',
        'data-issue-id': id
    });
        
        let tooltipTimeout;
        
        jiraLink.addEventListener('mouseover', async (e) => {
            // Clear any existing timeout
            if (tooltipTimeout) {
                clearTimeout(tooltipTimeout);
                tooltipTimeout = null;
            }
            
            const existingTooltip = document.querySelector('.worklog-tooltip');
            if (existingTooltip) existingTooltip.remove();
        
            const tooltip = document.createElement('div');
            tooltip.className = 'worklog-tooltip';
            tooltip.innerHTML = 'Loading worklogs...';
            
            // Smart tooltip positioning: above or below based on available space
            const rect = e.target.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            const spaceBelow = viewportHeight - rect.bottom;
            const spaceAbove = rect.top;
            
            // Position tooltip
            tooltip.style.left = `${Math.max(10, Math.min(rect.left, window.innerWidth - 370))}px`;
            
            if (spaceBelow >= 150 || spaceBelow >= spaceAbove) {
                // Position below
                tooltip.style.top = `${rect.bottom + 5}px`;
            } else {
                // Position above
                tooltip.style.top = `${rect.top - 155}px`;
            }
            
            document.body.appendChild(tooltip);
        
            try {
                const JIRA = await JiraAPI(options.jiraType, options.baseUrl, options.username, options.apiToken);
                const worklogResponse = await JIRA.getIssueWorklog(id);
                
                // Show last 5 worklogs with user information
                const recentLogs = worklogResponse.worklogs
                    .slice(-5)
                    .reverse()
                    .map(log => {
                        const date = new Date(log.started).toLocaleDateString();
                        const hours = (log.timeSpentSeconds / 3600).toFixed(1);
                        const comment = typeof log.comment === 'string' 
                            ? log.comment 
                            : log.comment?.content?.[0]?.content?.[0]?.text || 'No comment';
                        const author = log.author?.displayName || log.author?.name || 'Unknown user';
                        return `<div style="margin-bottom: 4px;">
                            <strong>${date}</strong> - ${author}<br>
                            ${hours}h - ${comment}
                        </div>`;
                    })
                    .join('');
                    
                tooltip.innerHTML = recentLogs || 'No recent worklogs';
            } catch (error) {
                tooltip.innerHTML = 'Error loading worklogs';
            }
        });
        
        // Add mouseout event listener with delay to prevent flickering
        jiraLink.addEventListener('mouseout', (e) => {
            tooltipTimeout = setTimeout(() => {
                const tooltip = document.querySelector('.worklog-tooltip');
                if (tooltip) tooltip.remove();
            }, 150);
        });        
        
    idCell.appendChild(jiraLink);

    row.appendChild(idCell);

    // 2) Summary cell
    const summaryCell = buildHTML('td', summary, { class: 'issue-summary truncate' });
    row.appendChild(summaryCell);

    // 3) Total Time cell
    const worklogs = worklog?.worklogs || [];
    const totalSecs = worklogs.reduce((acc, wl) => acc + wl.timeSpentSeconds, 0);
    const totalTime = (totalSecs / 3600).toFixed(1) + ' hrs';

    const totalTimeCell = buildHTML('td', null, { class: 'issue-total-time' });
    const loader = buildHTML('div', '', {
        class: 'loader-mini',
        'data-issue-id': id
    });
    const totalTimeDiv = buildHTML('div', totalTime, {
        class: 'issue-total-time-spent',
        'data-issue-id': id
    });
    totalTimeCell.appendChild(loader);
    totalTimeCell.appendChild(totalTimeDiv);
    row.appendChild(totalTimeCell);

    // Fetch updated worklog details
    fetchWorklogDetails(id, options).then((details) => {
        const secs = details.reduce((acc, wl) => acc + wl.timeSpentSeconds, 0);
        totalTimeDiv.textContent = (secs / 3600).toFixed(1) + ' hrs';
        loader.style.display = 'none';
    });

    async function fetchWorklogDetails(issueId, opts) {
        const JIRA = await JiraAPI(opts.jiraType, opts.baseUrl, opts.username, opts.apiToken);
        const worklogResponse = await JIRA.getIssueWorklog(issueId);
        return worklogResponse.worklogs;
    }

    // 4) Time input cell
    const timeInput = buildHTML('input', null, {
        class: 'issue-time-input',
        'data-issue-id': id,
        placeholder: 'Xhms'
    });
    const timeInputCell = buildHTML('td');
    timeInputCell.appendChild(timeInput);
    row.appendChild(timeInputCell);

    // 5) Comment input cell (with frequent buttons)
    const commentInputContainer = buildHTML('div', null, {
        class: 'suggestion-container',
        style: 'position: relative; display: inline-block; width: 100%;'
    });
    const commentInput = buildHTML('input', null, {
        class: 'issue-comment-input',
        'data-issue-id': id,
        placeholder: 'Comment',
        style: 'width: 100%; box-sizing: border-box;'
    });
    const commentButton1 = buildHTML('button', '1', {
        class: 'frequentWorklogDescription1'
    });
    const commentButton2 = buildHTML('button', '2', {
        class: 'frequentWorklogDescription2'
    });
    commentInputContainer.appendChild(commentInput);
    commentInputContainer.appendChild(commentButton1);
    commentInputContainer.appendChild(commentButton2);
    
    const commentCell = buildHTML('td');
    commentCell.appendChild(commentInputContainer);
    row.appendChild(commentCell);

    // 6) Date input cell
    const dateInput = buildHTML('input', null, {
        type: 'date',
        class: 'issue-log-date-input',
        value: new Date().toDateInputValue(),
        'data-issue-id': id
    });
    const dateCell = buildHTML('td');
    dateCell.appendChild(dateInput);
    row.appendChild(dateCell);

    // 7) Submit button cell
    const actionButton = buildHTML('input', null, {
        type: 'button',
        value: '⇡',
        class: 'issue-log-time-btn',
        'data-issue-id': id
    });
    actionButton.addEventListener('click', async (event) => await logTimeClick(event));
    const actionCell = buildHTML('td');
    actionCell.appendChild(actionButton);
    row.appendChild(actionCell);

    return row;
}

function displaySuccess(message) {
    const success = document.getElementById('success');
    if (success) {
        success.innerText = message;
        success.style.display = 'block';
        // Hide error message on success
        const error = document.getElementById('error');
        if (error) error.style.display = 'none';
    } else {
        console.warn('Success element not found');
    }
}

function displayError(message) {
    const error = document.getElementById('error');
    if (error) {
        error.innerText = message;
        error.style.display = 'block';
    }
    
    // Hide success message on error
    const success = document.getElementById('success');
    if (success) success.style.display = 'none';
}

function clearMessages() {
    const error = document.getElementById('error');
    const success = document.getElementById('success');
    if (error) error.style.display = 'none';
    if (success) success.style.display = 'none';
}

Date.prototype.toDateInputValue = function () {
    const local = new Date(this);
    local.setMinutes(this.getMinutes() - this.getTimezoneOffset());
    return local.toJSON().slice(0, 10);
};

function getStartedTime(dateString) {
    // Parse the input date string
    const [year, month, day] = dateString.split('-').map(Number);
    
    // Create a date object using the local timezone
    const date = new Date(year, month - 1, day);
    const now = new Date();
  
    // Combine the input date with the current time
    date.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
  
    // Calculate timezone offset
    const tzo = -date.getTimezoneOffset();
    const dif = tzo >= 0 ? '+' : '-';
  
    // Format the date string
    const formattedDate = 
      `${date.getFullYear()}-` +
      `${pad(date.getMonth() + 1)}-` +
      `${pad(date.getDate())}T` +
      `${pad(date.getHours())}:` +
      `${pad(date.getMinutes())}:` +
      `${pad(date.getSeconds())}.` +
      `${pad(date.getMilliseconds(), 3)}` +
      `${dif}${pad(Math.abs(Math.floor(tzo / 60)))}:${pad(Math.abs(tzo % 60))}`;
  
    console.log("Input date string:", dateString);
    console.log("Formatted start time:", formattedDate);
    
    return formattedDate;
}

function pad(num) {
    const norm = Math.abs(Math.floor(num));
    return (norm < 10 ? '0' : '') + norm;
}

function insertFrequentWorklogDescription(options) {
    const descriptionFields = document.querySelectorAll('.issue-comment-input');
    const frequentWorklogButtons1 = document.querySelectorAll('.frequentWorklogDescription1');
    const frequentWorklogButtons2 = document.querySelectorAll('.frequentWorklogDescription2');

    // If both frequent descriptions are empty, remove the buttons entirely
    // so they never appear on input.
    const bothAreEmpty = options.frequentWorklogDescription1 === '' 
                      && options.frequentWorklogDescription2 === '';

    descriptionFields.forEach((descriptionField, index) => {
        const button1 = frequentWorklogButtons1[index];
        const button2 = frequentWorklogButtons2[index];

        // If no frequent descriptions, remove the buttons from the DOM and skip the rest
        if (bothAreEmpty) {
            if (button1) button1.remove();
            if (button2) button2.remove();
            return;
        }

        // Otherwise, wire them up as before:
        // 1) Hide/show logic
        // 2) Clicking sets the input, etc.
        function hideButtons() {
            if (button1) button1.style.display = 'none';
            if (button2) button2.style.display = 'none';
        }
        function showButtons() {
            // Handle single button case
            const onlyButton1 = options.frequentWorklogDescription1 && !options.frequentWorklogDescription2;
            const onlyButton2 = !options.frequentWorklogDescription1 && options.frequentWorklogDescription2;

            if (button1 && options.frequentWorklogDescription1) {
                button1.style.display = 'block';
                button1.style.zIndex = '2';
                // If it's the only button, position it on the right
                if (onlyButton1) {
                    button1.style.right = '3px';
                }
            }
            if (button2 && options.frequentWorklogDescription2) {
                button2.style.display = 'block';
                button2.style.zIndex = '1';
                // If it's the only button, position it on the right
                if (onlyButton2) {
                    button2.style.right = '3px';
                }
            }
        }

        // If user didn't fill anything in options, we hide by default
        if (!options.frequentWorklogDescription1 && !options.frequentWorklogDescription2) {
            hideButtons();
        } else {
            // Show buttons initially if they have content
            showButtons();
        }

        if (button1 && options.frequentWorklogDescription1) {
            button1.addEventListener('click', () => {
                descriptionField.value = options.frequentWorklogDescription1;
                hideButtons();
            });
        }
        if (button2 && options.frequentWorklogDescription2) {
            button2.addEventListener('click', () => {
                descriptionField.value = options.frequentWorklogDescription2;
                hideButtons();
            });
        }

        // If either description is non-empty, we only show the buttons 
        // if the field is empty, else hide.
        descriptionField.addEventListener('input', () => {
            if (descriptionField.value.trim() === '') {
                showButtons();
            } else {
                hideButtons();
            }
        });
    });
}

async function toggleStar(issueId, options) {
    if (options.starredIssues[issueId]) {
        delete options.starredIssues[issueId];
    } else {
        options.starredIssues[issueId] = Date.now();
    }

    chrome.storage.sync.set({ starredIssues: options.starredIssues }, () => {
        console.log(`Star state updated for ${issueId}`, options.starredIssues[issueId]);
    });

    try {
        const JIRA = await JiraAPI(options.jiraType, options.baseUrl, options.username, options.apiToken);
        const issuesResponse = await JIRA.getIssues(0, options.jql);
        
        // Redraw table so starred item jumps to top
        drawIssuesTable(issuesResponse, options);
        
        // ⭐️ Re-run your frequent-worklog setup after the new table is in the DOM
        insertFrequentWorklogDescription(options);

    } catch (err) {
        console.error('Error fetching issues after star update:', err);
    }
}

function showSuccessAnimation(issueId, loggedTime) {
    const row = document.querySelector(`tr[data-issue-id="${issueId}"]`);
    if (!row) return;

    const totalTimeCell = row.querySelector('td.issue-total-time');
    if (!totalTimeCell) return;

    // Ensure relative positioning for the absolute indicator
    totalTimeCell.style.position = 'relative';

    // Create and add indicator
    const indicator = document.createElement('span');
    indicator.className = 'logged-time-indicator';
    indicator.textContent = `+${loggedTime}`;
    totalTimeCell.appendChild(indicator);

    // Add highlight class
    row.classList.add('success-highlight');

    // Set timeouts to remove indicator and highlight
    setTimeout(() => {
        indicator.remove();
        totalTimeCell.style.position = ''; // Reset position
    }, 5000); // Remove indicator after 5 seconds (matching CSS animation)

    setTimeout(() => {
        row.classList.add('fade-highlight'); // Start fade out transition
        row.classList.remove('success-highlight');
    }, 4000); // Start fade slightly before indicator disappears

    // Clean up fade class after transition ends
    setTimeout(() => {
         row.classList.remove('fade-highlight');
    }, 5000); // Matches the fade duration
}

function showErrorAnimation(issueId) {
    const row = document.querySelector(`tr[data-issue-id="${issueId}"]`);
    if (!row) return;

    row.classList.add('error-highlight');

    setTimeout(() => {
        row.classList.add('fade-highlight');
        row.classList.remove('error-highlight');
    }, 4000); // Keep highlight for 4 seconds

    // Clean up fade class after transition ends
    setTimeout(() => {
         row.classList.remove('fade-highlight');
    }, 5000); // Matches the fade duration
}
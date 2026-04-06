// ===== Column model =====
const COLUMN_DEFS = {
    issueId:  { label: 'Jira ID', baseWidth: 14, locked: 'first', hasLogo: true },
    summary:  { label: 'Summary', baseWidth: 25 },
    status:   { label: 'Status', baseWidth: 10, optional: true },
    assignee: { label: 'Assignee', baseWidth: 10, optional: true },
    total:    { label: 'Total', baseWidth: 8, optional: true },
    log:      { label: 'Log', baseWidth: 7 },
    comment:  { label: 'Comment', baseWidth: 15, optional: true },
    date:     { label: 'Date', baseWidth: 10 },
    actions:  { label: '', baseWidth: 3, locked: 'last' }
};
const DEFAULT_COLUMN_ORDER = ['issueId', 'summary', 'total', 'log', 'comment', 'date', 'actions'];
const DEFAULT_JQL = '(assignee=currentUser() OR worklogAuthor=currentUser()) AND status NOT IN (Closed, Done)';
const DEFAULT_TIME_TABLE_COLUMNS = { showStatus: false, showAssignee: false, showTotal: true, showComment: true };

function getVisibleColumns(columnOrder, colSettings) {
    return columnOrder.filter(colId => {
        const def = COLUMN_DEFS[colId];
        if (!def) return false;
        if (!def.optional) return true;
        if (colId === 'status') return colSettings.showStatus;
        if (colId === 'assignee') return colSettings.showAssignee;
        if (colId === 'total') return colSettings.showTotal;
        if (colId === 'comment') return colSettings.showComment;
        return true;
    });
}

function getColumnWidths(visibleColumns) {
    const totalBase = visibleColumns.reduce((sum, id) => sum + COLUMN_DEFS[id].baseWidth, 0);
    const widths = {};
    visibleColumns.forEach(id => {
        widths[id] = ((COLUMN_DEFS[id].baseWidth / totalBase) * 100).toFixed(1) + '%';
    });
    return widths;
}

// Ensure columnOrder contains all known ids (handles upgrade from older storage)
function normalizeColumnOrder(stored) {
    const allIds = Object.keys(COLUMN_DEFS);
    if (!Array.isArray(stored) || stored.length === 0) return DEFAULT_COLUMN_ORDER.slice();
    const result = stored.filter(id => COLUMN_DEFS[id]);
    allIds.forEach(id => { if (!result.includes(id)) result.splice(result.length - 1, 0, id); });
    // Enforce issueId first, actions last
    const withoutLocked = result.filter(id => id !== 'issueId' && id !== 'actions');
    return ['issueId', ...withoutLocked, 'actions'];
}

// ===== Theme =====
document.addEventListener('DOMContentLoaded', function() {
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
    chrome.storage.sync.get(['followSystemTheme', 'darkMode'], function(result) {
        const followSystem = result.followSystemTheme !== false;
        const manualDark = result.darkMode === true;
        applyTheme(followSystem, manualDark);
    });
    themeToggle.addEventListener('click', function() {
        const isDark = !document.body.classList.contains('dark-mode');
        updateThemeButton(isDark);
        setTheme(isDark);
        chrome.storage.sync.set({ darkMode: isDark, followSystemTheme: false });
    });
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

// ===== Main init =====
document.addEventListener('DOMContentLoaded', onDOMContentLoaded);

async function onDOMContentLoaded() {
    chrome.storage.sync.get({
        apiToken: '',
        baseUrl: '',
        jql: DEFAULT_JQL,
        username: '',
        jiraType: 'server',
        frequentWorklogDescription1: '',
        frequentWorklogDescription2: '',
        starredIssues: {},
        defaultPage: 'popup.html',
        darkMode: false,
        experimentalFeatures: false,
        timeTableColumns: DEFAULT_TIME_TABLE_COLUMNS,
        timeTableColumnOrder: DEFAULT_COLUMN_ORDER
    }, async (options) => {
        // Normalize column settings
        options.timeTableColumns = Object.assign({}, DEFAULT_TIME_TABLE_COLUMNS, options.timeTableColumns);
        options.timeTableColumnOrder = normalizeColumnOrder(options.timeTableColumnOrder);

        const urlParams = new URLSearchParams(window.location.search);
        const isNavigatingBack = urlParams.get('source') === 'navigation';
        
        const currentPage = window.location.pathname.split('/').pop();
        if (currentPage !== options.defaultPage && !isNavigatingBack) {
            window.location.href = options.defaultPage;
            return;
        }
        
        options.starredIssues = filterExpiredStars(options.starredIssues, 90);
        chrome.storage.sync.set({ starredIssues: options.starredIssues }, () => {});
        
        // Store options globally so gear panel can access them
        window._ttOptions = options;

        initGearPanel(options);
        await init(options);
        insertFrequentWorklogDescription(options);
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

// ===== Gear settings panel =====
function syncGearPanelState(options) {
    const jqlTextarea = document.getElementById('gear-jql');
    if (jqlTextarea) jqlTextarea.value = options.jql || DEFAULT_JQL;

    const statusToggle = document.getElementById('gear-show-status');
    if (statusToggle) statusToggle.checked = !!options.timeTableColumns.showStatus;

    const assigneeToggle = document.getElementById('gear-show-assignee');
    if (assigneeToggle) assigneeToggle.checked = !!options.timeTableColumns.showAssignee;

    const totalToggle = document.getElementById('gear-show-total');
    if (totalToggle) totalToggle.checked = options.timeTableColumns.showTotal !== false;

    const commentToggle = document.getElementById('gear-show-comment');
    if (commentToggle) commentToggle.checked = !!options.timeTableColumns.showComment;

    renderGearColumnOrder(options.timeTableColumnOrder);
}

function openGearModal(options = window._ttOptions) {
    if (options) syncGearPanelState(options);
    const backdrop = document.getElementById('gear-modal-backdrop');
    backdrop.style.display = 'flex';
    const btn = document.getElementById('gearBtn');
    if (btn) btn.setAttribute('aria-expanded', 'true');
}

function closeGearModal() {
    const backdrop = document.getElementById('gear-modal-backdrop');
    backdrop.style.display = 'none';
    const btn = document.getElementById('gearBtn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
}

function initGearPanel(options) {
    const backdrop = document.getElementById('gear-modal-backdrop');
    const closeBtn = document.getElementById('gear-modal-close');
    const saveBtn = document.getElementById('gear-save-btn');
    const jqlTextarea = document.getElementById('gear-jql');

    syncGearPanelState(options);

    closeBtn.addEventListener('click', closeGearModal);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeGearModal(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && backdrop.style.display !== 'none') closeGearModal();
    });

    saveBtn.addEventListener('click', async () => {
        const newJql = jqlTextarea.value.trim() || DEFAULT_JQL;
        const newCols = {
            showStatus: document.getElementById('gear-show-status').checked,
            showAssignee: document.getElementById('gear-show-assignee').checked,
            showTotal: document.getElementById('gear-show-total').checked,
            showComment: document.getElementById('gear-show-comment').checked,
        };
        const newOrder = readGearColumnOrder();
        const jqlChanged = newJql !== options.jql;

        options.jql = newJql;
        options.timeTableColumns = newCols;
        options.timeTableColumnOrder = newOrder;

        chrome.storage.sync.set({
            jql: newJql,
            timeTableColumns: newCols,
            timeTableColumnOrder: newOrder,
        });

        closeGearModal();

        if (jqlChanged) {
            // Refetch with new JQL
            try {
                const JIRA = await JiraAPI(options.jiraType, options.baseUrl, options.username, options.apiToken);
                const issuesResponse = await JIRA.getIssues(0, options.jql);
                const cacheKey = `issuesCache:${options.baseUrl}:${options.jql}`;
                chrome.storage.local.set({ [cacheKey]: { data: issuesResponse, ts: Date.now() } });
                onFetchSuccess(issuesResponse, options);
            } catch (err) {
                window.JiraErrorHandler.handleJiraError(err, 'Failed to fetch issues with new JQL', 'popup');
            }
        } else {
            // Just redraw table with new column settings
            redrawCurrentTable(options);
        }
        insertFrequentWorklogDescription(options);
    });
}

function redrawCurrentTable(options) {
    const cacheKey = `issuesCache:${options.baseUrl}:${options.jql}`;
    chrome.storage.local.get([cacheKey], (items) => {
        const cached = items[cacheKey];
        if (cached && cached.data) {
            onFetchSuccess(cached.data, options);
            insertFrequentWorklogDescription(options);
        }
    });
}

// Drag-and-drop column order in gear panel
function renderGearColumnOrder(order) {
    const ul = document.getElementById('gear-column-order');
    ul.innerHTML = '';
    // Only show reorderable columns (exclude locked first/last)
    const reorderable = order.filter(id => id !== 'issueId' && id !== 'actions' && COLUMN_DEFS[id]);
    reorderable.forEach(colId => {
        const li = document.createElement('li');
        li.setAttribute('draggable', 'true');
        li.setAttribute('data-col-id', colId);
        li.innerHTML = `<span class="drag-handle">&#x2630;</span> ${COLUMN_DEFS[colId].label}`;
        ul.appendChild(li);
    });
    initDragAndDrop(ul);
}

function initDragAndDrop(ul) {
    // The gear modal re-renders the same list element on each open, so only bind once.
    if (ul.dataset.dragAndDropInitialized === 'true') return;
    ul.dataset.dragAndDropInitialized = 'true';

    let draggedItem = null;
    ul.addEventListener('dragstart', (e) => {
        draggedItem = e.target.closest('li');
        if (draggedItem) draggedItem.classList.add('dragging');
    });
    ul.addEventListener('dragend', () => {
        if (draggedItem) draggedItem.classList.remove('dragging');
        ul.querySelectorAll('li').forEach(li => li.classList.remove('drag-over'));
        draggedItem = null;
    });
    ul.addEventListener('dragover', (e) => {
        e.preventDefault();
        const target = e.target.closest('li');
        if (!target || target === draggedItem) return;
        ul.querySelectorAll('li').forEach(li => li.classList.remove('drag-over'));
        target.classList.add('drag-over');
    });
    ul.addEventListener('drop', (e) => {
        e.preventDefault();
        const target = e.target.closest('li');
        if (!target || target === draggedItem || !draggedItem) return;
        const items = [...ul.querySelectorAll('li')];
        const dragIdx = items.indexOf(draggedItem);
        const dropIdx = items.indexOf(target);
        if (dragIdx < dropIdx) {
            target.after(draggedItem);
        } else {
            target.before(draggedItem);
        }
        ul.querySelectorAll('li').forEach(li => li.classList.remove('drag-over'));
    });
}

function readGearColumnOrder() {
    const lis = document.querySelectorAll('#gear-column-order li');
    const middle = [...lis].map(li => li.getAttribute('data-col-id'));
    return ['issueId', ...middle, 'actions'];
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

        // Try to show cached data immediately for instant popup
        const cacheKey = `issuesCache:${options.baseUrl}:${options.jql}`;
        let showedCached = false;
        
        try {
            const cached = await new Promise(resolve => {
                chrome.storage.local.get([cacheKey], items => resolve(items[cacheKey]));
            });
            
            if (cached && cached.data && Date.now() - cached.ts < 5 * 60 * 1000) {
                // Show cached data immediately (if less than 5 min old)
                console.log('Showing cached issues');
                onFetchSuccess(cached.data, options);
                showedCached = true;
            }
        } catch (e) {
            console.warn('Cache read failed', e);
        }

        // Show loader only if we didn't show cached data
        if (!showedCached) {
            toggleVisibility('div[id=loader-container]');
        }

        try {
            // Fetch fresh issues from Jira
            const issuesResponse = await JIRA.getIssues(0, options.jql);
            
            // Cache the response
            try {
                chrome.storage.local.set({ [cacheKey]: { data: issuesResponse, ts: Date.now() } });
            } catch (e) {
                console.warn('Cache write failed', e);
            }
            
            // Update UI with fresh data
            onFetchSuccess(issuesResponse, options);
        } catch (error) {
            console.error('Error fetching issues:', error);
            // Only show error if we didn't show cached data
            if (!showedCached) {
                window.JiraErrorHandler.handleJiraError(error, 'Failed to fetch issues from JIRA', 'popup');
            }
        } finally {
            if (!showedCached) {
                toggleVisibility('div[id=loader-container]');
            }
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

        const commentValue = commentInput ? commentInput.value : '';
        console.log(`Update worklog details: issueId=${issueId}, timeSpentSeconds=${timeSpentSeconds}, startedTime=${startedTime}, comment=${commentValue}`);
        
        const result = await JIRA.updateWorklog(issueId, timeSpentSeconds, startedTime, commentValue);

        // Handle successful response
        console.log("Worklog successfully updated:", result);

        // Display success message with the logged time
        showSuccessAnimation(issueId, timeInput.value);

        timeInput.value = '';
        if (commentInput) commentInput.value = '';

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
    const visibleCols = getVisibleColumns(options.timeTableColumnOrder, options.timeTableColumns);
    const widths = getColumnWidths(visibleCols);

    // Build <thead> dynamically
    const theadTr = logTable.querySelector('thead tr');
    theadTr.innerHTML = '';
    visibleCols.forEach(colId => {
        const def = COLUMN_DEFS[colId];
        const th = document.createElement('th');
        th.setAttribute('data-col', colId);
        th.style.width = widths[colId];
        if (colId === 'issueId') {
            th.innerHTML = '<img src="src/icons/jira_logo.png" alt="Jira Logo" style="vertical-align:middle;margin-right:8px;width:16px;height:16px;"> Jira ID';
        } else if (colId === 'actions') {
            const gearBtn = document.createElement('button');
            gearBtn.id = 'gearBtn';
            gearBtn.title = 'Time Table settings';
            gearBtn.setAttribute('aria-expanded', 'false');
            gearBtn.setAttribute('aria-controls', 'gear-modal-backdrop');
            gearBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5.5a.5.5 0 0 0-.5.5v1.07a5.5 5.5 0 0 0-1.56.64L3.7 1.97a.5.5 0 0 0-.7 0l-.71.7a.5.5 0 0 0 0 .71l.74.74A5.5 5.5 0 0 0 2.4 5.7H1.3a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h1.1a5.5 5.5 0 0 0 .63 1.58l-.74.74a.5.5 0 0 0 0 .7l.71.71a.5.5 0 0 0 .7 0l.74-.74a5.5 5.5 0 0 0 1.56.64V12.5a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-1.07a5.5 5.5 0 0 0 1.56-.64l.74.74a.5.5 0 0 0 .7 0l.71-.7a.5.5 0 0 0 0-.71l-.74-.74A5.5 5.5 0 0 0 11.6 7.7h1.1a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5h-1.1a5.5 5.5 0 0 0-.63-1.58l.74-.74a.5.5 0 0 0 0-.7l-.71-.71a.5.5 0 0 0-.7 0l-.74.74A5.5 5.5 0 0 0 8 2.07V1a.5.5 0 0 0-.5-.5h-1zM7 4.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z"/></svg>';
            gearBtn.addEventListener('click', () => openGearModal());
            th.appendChild(gearBtn);
        } else {
            th.textContent = def.label;
        }
        theadTr.appendChild(th);
    });

    // Remove any existing <tbody>
    const oldTbody = logTable.querySelector('tbody');
    if (oldTbody) oldTbody.remove();

    const newTbody = document.createElement('tbody');
    const issues = issuesResponse.data || [];
    const sortedIssues = sortByStar(issues, options.starredIssues);

    sortedIssues.forEach((issue) => {
        const row = generateLogTableRow(issue, options, visibleCols);
        newTbody.appendChild(row);
    });

    logTable.appendChild(newTbody);
    
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

// ===== Cell builders (one per column id) =====
const cellBuilders = {
    issueId(issue, options) {
        const id = issue.key;
        const td = buildHTML('td', '', { class: 'issue-id', 'data-col': 'issueId', 'data-issue-id': id });
        const isStarred = !!options.starredIssues[id];
        const starIcon = buildHTML('span', '', { class: 'star-icon' });
        starIcon.textContent = isStarred ? '\u2605' : '\u2606';
        starIcon.classList.add(isStarred ? 'starred' : 'unstarred');
        starIcon.addEventListener('click', () => toggleStar(id, options));
        td.appendChild(starIcon);
        td.appendChild(document.createTextNode(' '));

        const baseUrl = options.baseUrl.startsWith('http') ? options.baseUrl : `https://${options.baseUrl}`;
        const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
        const jiraLink = buildHTML('a', id, { href: `${normalizedBaseUrl}browse/${id}`, target: '_blank', 'data-issue-id': id });
        let tooltipTimeout;
        jiraLink.addEventListener('mouseover', async (e) => {
            if (tooltipTimeout) { clearTimeout(tooltipTimeout); tooltipTimeout = null; }
            const existingTooltip = document.querySelector('.worklog-tooltip');
            if (existingTooltip) existingTooltip.remove();
            const tooltip = document.createElement('div');
            tooltip.className = 'worklog-tooltip';
            tooltip.innerHTML = 'Loading worklogs...';
            const rect = e.target.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;
            tooltip.style.left = `${Math.max(10, Math.min(rect.left, window.innerWidth - 370))}px`;
            tooltip.style.top = (spaceBelow >= 150 || spaceBelow >= rect.top)
                ? `${rect.bottom + 5}px` : `${rect.top - 155}px`;
            document.body.appendChild(tooltip);
            try {
                const JIRA = await JiraAPI(options.jiraType, options.baseUrl, options.username, options.apiToken);
                const worklogResponse = await JIRA.getIssueWorklog(id);
                const recentLogs = worklogResponse.worklogs.slice(-5).reverse().map(log => {
                    const date = new Date(log.started).toLocaleDateString();
                    const hours = (log.timeSpentSeconds / 3600).toFixed(1);
                    const comment = typeof log.comment === 'string'
                        ? log.comment
                        : log.comment?.content?.[0]?.content?.[0]?.text || 'No comment';
                    const author = log.author?.displayName || log.author?.name || 'Unknown user';
                    return `<div style="margin-bottom:4px;"><strong>${date}</strong> - ${author}<br>${hours}h - ${comment}</div>`;
                }).join('');
                tooltip.innerHTML = recentLogs || 'No recent worklogs';
            } catch (_) { tooltip.innerHTML = 'Error loading worklogs'; }
        });
        jiraLink.addEventListener('mouseout', () => {
            tooltipTimeout = setTimeout(() => {
                const t = document.querySelector('.worklog-tooltip');
                if (t) t.remove();
            }, 150);
        });
        td.appendChild(jiraLink);
        return td;
    },

    summary(issue) {
        return buildHTML('td', issue.fields.summary, { class: 'issue-summary truncate', 'data-col': 'summary' });
    },

    status(issue, options) {
        const td = buildHTML('td', null, { 'data-col': 'status' });
        const statusName = issue.fields.status?.name || 'Unknown';
        const select = document.createElement('select');
        select.className = 'status-select';
        select.setAttribute('data-issue-id', issue.key);
        const currentOpt = document.createElement('option');
        currentOpt.value = '';
        currentOpt.textContent = statusName;
        currentOpt.selected = true;
        select.appendChild(currentOpt);
        loadTransitions(issue.key, select, statusName, options);
        td.appendChild(select);
        return td;
    },

    assignee(issue, options) {
        const td = buildHTML('td', null, { 'data-col': 'assignee' });
        const container = document.createElement('div');
        container.className = 'assignee-container';
        const assigneeName = issue.fields.assignee?.displayName || 'Unassigned';
        const input = document.createElement('input');
        input.className = 'assignee-input';
        input.value = assigneeName;
        input.setAttribute('data-issue-id', issue.key);
        input.setAttribute('data-current-assignee', assigneeName);
        const dropdown = document.createElement('ul');
        dropdown.className = 'assignee-dropdown';
        dropdown.style.display = 'none';
        let debounceTimer;
        input.addEventListener('focus', () => input.select());
        input.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
                const query = input.value.trim();
                if (!query) { dropdown.style.display = 'none'; return; }
                try {
                    const JIRA = await JiraAPI(options.jiraType, options.baseUrl, options.username, options.apiToken);
                    const users = await JIRA.searchAssignableUsers(issue.key, query, 5);
                    dropdown.innerHTML = '';
                    if (users.length === 0) { dropdown.style.display = 'none'; return; }
                    users.forEach(user => {
                        const li = document.createElement('li');
                        li.textContent = user.displayName;
                        li.addEventListener('mousedown', async (e) => {
                            e.preventDefault();
                            try {
                                const J = await JiraAPI(options.jiraType, options.baseUrl, options.username, options.apiToken);
                                const assigneeField = options.jiraType === 'cloud'
                                    ? { accountId: user.accountId }
                                    : { name: user.name };
                                await J.updateIssue(issue.key, { assignee: assigneeField });
                                input.value = user.displayName;
                                input.setAttribute('data-current-assignee', user.displayName);
                                dropdown.style.display = 'none';
                            } catch (err) {
                                window.JiraErrorHandler.handleJiraError(err, `Failed to assign ${issue.key}`, 'popup');
                            }
                        });
                        dropdown.appendChild(li);
                    });
                    dropdown.style.display = 'block';
                } catch (_) { dropdown.style.display = 'none'; }
            }, 300);
        });
        input.addEventListener('blur', () => {
            setTimeout(() => {
                dropdown.style.display = 'none';
                input.value = input.getAttribute('data-current-assignee') || 'Unassigned';
            }, 200);
        });
        container.appendChild(input);
        container.appendChild(dropdown);
        td.appendChild(container);
        return td;
    },

    total(issue, options) {
        const id = issue.key;
        const worklogs = issue.fields.worklog?.worklogs || [];
        const totalSecs = worklogs.reduce((acc, wl) => acc + wl.timeSpentSeconds, 0);
        const totalTime = (totalSecs / 3600).toFixed(1) + ' hrs';
        const td = buildHTML('td', null, { class: 'issue-total-time', 'data-col': 'total' });
        const loader = buildHTML('div', '', { class: 'loader-mini', 'data-issue-id': id });
        const totalTimeDiv = buildHTML('div', totalTime, { class: 'issue-total-time-spent', 'data-issue-id': id });
        td.appendChild(loader);
        td.appendChild(totalTimeDiv);
        (async () => {
            try {
                const JIRA = await JiraAPI(options.jiraType, options.baseUrl, options.username, options.apiToken);
                const resp = await JIRA.getIssueWorklog(id);
                const secs = resp.worklogs.reduce((acc, wl) => acc + wl.timeSpentSeconds, 0);
                totalTimeDiv.textContent = (secs / 3600).toFixed(1) + ' hrs';
            } catch (_) {}
            loader.style.display = 'none';
        })();
        return td;
    },

    log(issue) {
        const td = buildHTML('td', null, { 'data-col': 'log' });
        td.appendChild(buildHTML('input', null, {
            class: 'issue-time-input', 'data-issue-id': issue.key, placeholder: 'Xhms'
        }));
        return td;
    },

    comment(issue) {
        const td = buildHTML('td', null, { 'data-col': 'comment' });
        const container = buildHTML('div', null, {
            class: 'suggestion-container',
            style: 'position:relative;display:inline-block;width:100%;'
        });
        container.appendChild(buildHTML('input', null, {
            class: 'issue-comment-input', 'data-issue-id': issue.key,
            placeholder: 'Comment', style: 'width:100%;box-sizing:border-box;'
        }));
        container.appendChild(buildHTML('button', '1', { class: 'frequentWorklogDescription1' }));
        container.appendChild(buildHTML('button', '2', { class: 'frequentWorklogDescription2' }));
        td.appendChild(container);
        return td;
    },

    date(issue) {
        const td = buildHTML('td', null, { 'data-col': 'date' });
        td.appendChild(buildHTML('input', null, {
            type: 'date', class: 'issue-log-date-input',
            value: new Date().toDateInputValue(), 'data-issue-id': issue.key
        }));
        return td;
    },

    actions(issue) {
        const td = buildHTML('td', null, { 'data-col': 'actions' });
        const btn = buildHTML('input', null, {
            type: 'button', value: '\u21E1', class: 'issue-log-time-btn', 'data-issue-id': issue.key
        });
        btn.addEventListener('click', async (event) => await logTimeClick(event));
        td.appendChild(btn);
        return td;
    }
};

async function loadTransitions(issueKey, select, currentStatusName, options) {
    try {
        const JIRA = await JiraAPI(options.jiraType, options.baseUrl, options.username, options.apiToken);
        const resp = await JIRA.getTransitions(issueKey);
        (resp.transitions || []).forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = '\u2192 ' + t.name;
            select.appendChild(opt);
        });
        select.onchange = async () => {
            const transitionId = select.value;
            if (!transitionId) return;
            try {
                select.disabled = true;
                const J = await JiraAPI(options.jiraType, options.baseUrl, options.username, options.apiToken);
                await J.transitionIssue(issueKey, transitionId);
                const newName = select.options[select.selectedIndex].textContent.replace('\u2192 ', '');
                select.options[0].textContent = newName;
                select.selectedIndex = 0;
                // Reload transitions for the new state
                while (select.options.length > 1) select.remove(1);
                await loadTransitions(issueKey, select, newName, options);
            } catch (err) {
                window.JiraErrorHandler.handleJiraError(err, `Failed to transition ${issueKey}`, 'popup');
                select.selectedIndex = 0;
            } finally {
                select.disabled = false;
            }
        };
    } catch (_) {}
}

function generateLogTableRow(issue, options, visibleCols) {
    const row = buildHTML('tr', null, { 'data-issue-id': issue.key });
    visibleCols.forEach(colId => {
        if (cellBuilders[colId]) {
            row.appendChild(cellBuilders[colId](issue, options));
        }
    });
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
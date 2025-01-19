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
        defaultPage: 'popup.html'
    }, async (options) => {
        // Check if we need to redirect to a different default page
        const currentPage = window.location.pathname.split('/').pop();
        if (currentPage !== options.defaultPage) {
            window.location.href = options.defaultPage;
            return;
        }
        
        // Clean out any stars older than 90 days
        options.starredIssues = filterExpiredStars(options.starredIssues, 90);
        
        // Save any cleaned out stars back to storage so they don’t accumulate
        chrome.storage.sync.set({ starredIssues: options.starredIssues }, () => {});
        
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
            displayError('JIRA API instantiation failed.');
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
            displayError(`Fetching Issues Error: (Settings may need set up.)`);
        } finally {
            toggleVisibility('div[id=loader-container]'); // Hide loader
        }
    } catch (error) {
        console.error('Error initializing JIRA API:', error);
        displayError('Initialization failed. (Settings may need set up.)');
    }
}

function onFetchSuccess(issuesResponse, options) {
    console.log("Fetched issues:", issuesResponse);
    drawIssuesTable(issuesResponse, options); // Pass options to the function
}

function onFetchError(error) {
    toggleVisibility('div[id=loader-container]');
    genericResponseError(error);
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
    genericResponseError(error);
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
        displayError('Time input element not found or is empty.');
        return;
    }

    const timeMatches = timeInput.value.match(/[0-9]{1,4}[dhm]/g);
    if (!timeMatches) {
        displayError('Time input in wrong format. You can specify a time unit after a time value "X", such as Xd, Xh, or Xm, to represent days, hours, and minutes (m), respectively.');
        return;
    }

    const timeSpentSeconds = convertTimeToSeconds(timeInput.value);
    if (isNaN(timeSpentSeconds) || timeSpentSeconds <= 0) {
        displayError('Invalid time input value. Please provide a valid time format.');
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
        displaySuccess("You successfully logged: " + timeInput.value + " on " + issueId);

        // Clear the input fields upon success
        timeInput.value = '';
        commentInput.value = '';

        // Fetch updated worklogs so that the displayed time is consistent
        getWorklog(issueId, JIRA);

    } catch (error) {
        console.error(`Error in logTimeClick function: ${error.stack}`);

        totalTimeSpans.style.display = 'block';
        loader.style.display = 'none';

        // Check for specific known issues before calling genericResponseError
        if (error && error.status === 200) {
            // Worklog update was successful but something else caused an error
            displaySuccess("Successfully logged: " + timeInput.value + " but encountered an issue afterward.");
        } else {
            genericResponseError(error); // Handle unexpected errors
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
    const jiraLink = buildHTML('a', id, {
        href: `${baseUrl}/browse/${id}`,
        target: '_blank'
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
        style: 'position: relative; display: inline-block;'
    });
    const commentInput = buildHTML('input', null, {
        class: 'issue-comment-input',
        'data-issue-id': id,
        placeholder: 'Work description'
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
        value: 'Submit',
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
            if (button1) button1.style.display = 'block';
            if (button2) button2.style.display = 'block';
        }

        // If user didn’t fill anything in options, we hide by default
        if (!options.frequentWorklogDescription1 && !options.frequentWorklogDescription2) {
            hideButtons();
        }

        if (button1) {
            button1.addEventListener('click', () => {
                descriptionField.value = options.frequentWorklogDescription1;
                hideButtons();
            });
        }
        if (button2) {
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
document.addEventListener('DOMContentLoaded', onDOMContentLoaded);

async function onDOMContentLoaded() {
    chrome.storage.sync.get({
        apiToken: '',
        baseUrl: '',
        jql: '',
    }, async (options) => {
        await init(options);
    });
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
        const JIRA = await JiraAPI(options.baseUrl, '/rest/api/2', '', options.apiToken, options.jql);
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
            const issuesResponse = await JIRA.getIssues(options.jql);
            onFetchSuccess(issuesResponse, options); // Pass options to the function
        } catch (error) {
            console.error('Error fetching issues:', error);
            displayError(`Fetching Issues Error: ${error.message}`);
        } finally {
            toggleVisibility('div[id=loader-container]'); // Hide loader
        }
    } catch (error) {
        console.error('Error initializing JIRA API:', error);
        displayError('Initialization failed.');
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
    const totalHours = (totalSeconds / 3600).toFixed(2);
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

    const timeMatches = timeInput.value.match(/[0-9]{1,4}[wdhm]/g);
    if (!timeMatches) {
        displayError('Time input in wrong format. You can specify a time unit after a time value "X", such as Xw, Xd, Xh, or Xm, to represent weeks, days, hours, and minutes (m), respectively.');
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
            chrome.storage.sync.get(['baseUrl', 'apiToken', 'jql'], items => {
                if (chrome.runtime.lastError) {
                    return reject(chrome.runtime.lastError);
                }
                resolve(items);
            })
        );

        const JIRA = await JiraAPI(options.baseUrl, '/rest/api/2', '', options.apiToken, options.jql);

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
        w: 60 * 60 * 24 * 7,
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

function drawIssuesTable(issues, options) {
    const logTable = document.getElementById('jira-log-time-table');
    const tbody = buildHTML('tbody');

    issues.forEach(function(issue) {
        const row = generateLogTableRow(issue.key, issue.fields.summary, issue.fields.worklog, options);
        tbody.appendChild(row);
    });

    logTable.appendChild(tbody);
}

function generateLogTableRow(id, summary, worklog, options) {
    const idCell = buildHTML('td', null, { class: 'issue-id', 'data-issue-id': id });
    const idText = document.createTextNode(id);

    const baseUrl = options.baseUrl.startsWith('http') ? options.baseUrl : `https://${options.baseUrl}`;
    const jiraLink = buildHTML('a', null, {
        href: `${baseUrl}/browse/${id}`,
        target: '_blank',
    });

    jiraLink.appendChild(idText);
    idCell.appendChild(jiraLink);

    const summaryCell = buildHTML('td', summary, { class: 'issue-summary truncate' });

    // Sum the total time from all worklogs and convert to hours
    const totalTimeSeconds = worklog.worklogs.reduce((total, log) => total + log.timeSpentSeconds, 0);
    const totalTime = (totalTimeSeconds / 3600).toFixed(2) + ' hrs';

    // Create the total time cell and loader elements
    const totalTimeCell = buildHTML('td', '', { class: 'issue-total-time' });
    const totalTimeDiv = buildHTML('div', totalTime, { class: 'issue-total-time-spent', 'data-issue-id': id });
    const loader = buildHTML('div', null, { class: 'loader-mini', 'data-issue-id': id });

    // Clear any existing content before appending new elements
    totalTimeCell.innerHTML = '';
    totalTimeCell.appendChild(loader);
    totalTimeCell.appendChild(totalTimeDiv);

    // Fetch latest worklog details and update total time spent dynamically
    fetchWorklogDetails(id, options).then((worklogDetails) => {
        const totalTimeSeconds = worklogDetails.reduce((total, log) => total + log.timeSpentSeconds, 0);
        const totalTime = (totalTimeSeconds / 3600).toFixed(2) + ' hrs';
        totalTimeDiv.innerText = totalTime;
        loader.style.display = 'none';
    });

    async function fetchWorklogDetails(issueId, options) {
        const JIRA = await JiraAPI(options.baseUrl, '/rest/api/2', '', options.apiToken, options.jql);
        const worklogResponse = await JIRA.getIssueWorklog(issueId);
        return worklogResponse.worklogs;
    }

    const timeInput = buildHTML('input', null, { class: 'issue-time-input', 'data-issue-id': id });
    const timeInputCell = buildHTML('td');
    timeInputCell.appendChild(timeInput);

    const commentInput = buildHTML('input', null, { class: 'issue-comment-input', 'data-issue-id': id });
    const commentInputCell = buildHTML('td');
    commentInputCell.appendChild(commentInput);

    const dateInput = buildHTML('input', null, {
        type: 'date',
        class: 'issue-log-date-input',
        value: new Date().toDateInputValue(),
        'data-issue-id': id,
    });
    const dateInputCell = buildHTML('td');
    dateInputCell.appendChild(dateInput);

    const actionButton = buildHTML('input', null, {
        type: 'button',
        value: 'Submit',
        class: 'issue-log-time-btn',
        'data-issue-id': id,
    });

    actionButton.addEventListener('click', async (event) => await logTimeClick(event));

    const actionCell = buildHTML('td');
    actionCell.appendChild(actionButton);

    const row = buildHTML('tr', null, { 'data-issue-id': id });
    row.appendChild(idCell);
    row.appendChild(summaryCell);
    row.appendChild(totalTimeCell);
    row.appendChild(timeInputCell);
    row.appendChild(commentInputCell);
    row.appendChild(dateInputCell);
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


Date.prototype.toDateInputValue = (function () {
    const local = new Date(this);
    local.setMinutes(this.getMinutes() - this.getTimezoneOffset());
    return local.toJSON().slice(0, 10);
});

function getStartedTime(dateString) {
    const date = new Date(dateString);
    const time = new Date();
    const tzo = -date.getTimezoneOffset();
    const dif = tzo >= 0 ? '+' : '-';

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}.${pad(time.getMilliseconds())}${dif}${pad(Math.abs(Math.floor(tzo / 60)))}:${pad(Math.abs(tzo % 60))}`;
}

function pad(num) {
    const norm = Math.abs(Math.floor(num));
    return (norm < 10 ? '0' : '') + norm;
}

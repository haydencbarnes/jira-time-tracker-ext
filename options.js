(async function () {
    document.addEventListener('DOMContentLoaded', restoreOptions);
    document.getElementById('save').addEventListener('click', saveOptions);

    function saveOptions() {
        const username = document.getElementById('username').value;
        const apiToken = document.getElementById('password').value; // Use API token in place of password
        const baseUrl = document.getElementById('baseUrl').value;
        const jql = '((assignee=currentUser()) OR worklogAuthor=currentUser())';

        chrome.storage.sync.set({
            username,
            apiToken,
            baseUrl,
            jql,
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
            jql: ''
        }, async function (items) {
            document.getElementById('username').value = items.username;
            document.getElementById('password').value = items.apiToken; // Use API token in place of password
            document.getElementById('baseUrl').value = items.baseUrl;
            document.getElementById('jql').value = items.jql;
    
            // Pass the retrieved jql value to getIssues function
            const jira = await JiraAPI(items.baseUrl, apiExtension, items.username, items.apiToken, items.jql);
            const issues = await jira.getIssues(items.jql);        });
    }
})();

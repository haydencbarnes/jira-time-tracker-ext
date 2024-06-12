(function () {
    document.addEventListener('DOMContentLoaded', restoreOptions);
    document.getElementById('save').addEventListener('click', saveOptions);

    function saveOptions() {
        const username = document.getElementById('username').value;
        const apiToken = document.getElementById('password').value; // Use API token in place of password
        const baseUrl = document.getElementById('baseUrl').value;
        const jql = document.getElementById('jql').value;

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

    function restoreOptions() {
        chrome.storage.sync.get({
            username: '',
            apiToken: '', // Retrieve API token
            baseUrl: '',
            jql: 'assignee=currentUser()'
        }, function (items) {
            document.getElementById('username').value = items.username;
            document.getElementById('password').value = items.apiToken; // Use API token in place of password
            document.getElementById('baseUrl').value = items.baseUrl;
            document.getElementById('jql').value = items.jql;
        });
    }
})();

![jira_logo](src/icons/jira_logo128.png)

# Jira Time Tracker Chrome Extension
Easily log time spent on Jira tasks directly from your browser with this convenient Chrome extension, saving you time and increasing productivity.

## Features
- Log time spent on Jira tasks directly from your browser.
- Currently only works with Jira Server (API V2).

### How it Works
Current JQL query is ((assignee=currentUser()) OR worklogAuthor=currentUser()) AND status NOT IN (Closed, Done). This means that the extension will only show issues that are:
1. Assigned to you
2. You have logged time on
3. Must not be Closed or Done.

All issues that meet the above criteria will be displayed in the extension popup. You can then select the issue you want to log time on, enter the time spent, add a comment, and adjust the date if you wish. Click the "Submit" button to log the time spent on the issue.

### Settings/Preferences
The below settings must be set for this extension to work properly.

#### Jira Domain/URL

This is your Jira Domain URL, whether that be Server or Cloud. For example: `https://jira.atlassian.com/.

#### Username/Email

Your Jira Username/Email.

#### REST API Token

This is your Jira server REST API Token. <b>Note:</b> User must currently be authenticated with Jira to access the token/extension.

#### Special Thanks
This code repo was originally modified from this [Jira Log Time](https://chrome.google.com/webstore/detail/jira-log-time/peboekgeiffcaddndeonkmkledekeegl) Chrome extension. Credit to [Oliver Debenc](https://www.linkedin.com/in/oliver-debenc-01821770) for the previous/original design, but I have made some modications.
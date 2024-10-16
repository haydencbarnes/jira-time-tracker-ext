![jira_logo](src/icons/jira_logo128.png)

# Jira Time Tracker Chrome Extension
Easily log time spent on Jira tasks directly from your browser with this convenient Chrome extension, saving you time and increasing productivity.

## Features
- Log time spent on Jira tasks directly from your browser.
- Supports older Jira Server (API V2) and newer Jira Cloud (API V3) versions.

### How Search Works
1. **Select Project**: Use the dropdown menu to select your project.
2. **Select Issue**: Choose the specific issue from the dropdown list.
3. **Fill Out Details**: Enter the date, time spent (e.g., 2h 15m), and a brief description of the work completed.
4. **Submit**: Click the "Submit" button to log your time. You will receive a success message and the form fields will clear automatically.

### How Time Table Works
1. **View Entries**: Navigate to the "Time Table" tab to see a summary (or your custom JQL query summary) of your logged time.
2. **Edit Entries**: You can add your logged time entries as needed.
3. **Detailed View**: Click on any issue to open it in Jira.

### How Timer Works
1. **Start Timer**: Click the "play" button to begin tracking time spent on a task. The timer will run in the background, even if you navigate to a different tab, and the badge will display the current time spent as well.
2. **Stop Timer**: Click the "stop" button to end the timer.
3. **Fill Out Details**: Enter a brief description of the work completed.
4. **Submit**: Click the "Submit" button to log your time. You will receive a success message and the timer fields will clear automatically.

## Settings/Preferences
The below settings must be set for this extension to work properly.

#### Jira Instance Type
This is the type of Jira instance you are using, whether that be Server or Cloud.

#### Jira Domain/URL

This is your Jira Domain URL, whether that be Server or Cloud. For example: `https://jira.atlassian.com/.

#### Username/Email

Your Jira Username/Email.

#### REST API Token

This is your Jira REST API Token.

#### Custom JQL Query
The example JQL query is ((assignee=currentUser()) OR worklogAuthor=currentUser()) AND status NOT IN (Closed, Done). This means that the extension will only show issues that are:
1. Assigned to you or you have logged time on
2. Must not be Closed or Done.

All issues that meet the above criteria will be displayed in the extension table popup view. You can then select the issue you want to log time on, enter the time spent, add a comment, and adjust the date if you wish. Click the "Submit" button to log the time spent on the issue.

You can edit/customize the custom JQL query in the Settings tab under preferences.

#### Experimental Features Toggle
This toggle allows you to enable/disable the experimental features of the extension. Currently, the only experimental feature is the timer, a Google calendar feature is also being explored.
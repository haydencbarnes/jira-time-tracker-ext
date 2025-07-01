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

**Optional(s)**:
- Star an issue to keep it at the top of your time table.
- You can also hover over the issue Jira ID to see a history of the last 5 worklogs.

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

## Other features
#### Worklog Snippets
Log work faster by using worklog snippets to store and insert a frequently used worklog description/comment. You can save two snippets in the settings tab and they will appear as buttons accross the extension in the description of work completed field.

#### Experimental Features Toggle
This toggle allows you to enable/disable the experimental features of the extension. Currently, the experimental features include:
- Dark Mode
- Worklog Autosuggestions
- Google Calendar Add-on
- JIRA Issue ID Detection & Time Tracking Popups

#### JIRA Issue ID Detection (Experimental)
- The extension scans any webpage for JIRA issue IDs (e.g. `ABC-123`).
- Each detected ID is left completely **intact** – normal links still work and plain-text stays selectable.
- A small **blue ⏱ log-time icon** is injected immediately **to the right of the ID**.
- Click the blue icon to open the quick Log-Time popup (the icon has a tooltip: *Log time for ABC-123*).
- The ID itself remains clickable/navigable so you can still open the issue in JIRA as usual.

Key details:
1. **Automatic Detection** – works in e-mails, docs, Slack, etc.
2. **Non-intrusive** – no underline; subtle background highlight only on plain-text IDs.
3. **Icon UX** – blue in light-mode, lighter blue hover, matching dark-mode palette.
4. **Bottom-right Badge** – "JIRA detection active" badge now appears bottom-right in blue for 3 s when the feature activates.
5. **All other popup features** (dark-mode, validation, error handling) remain unchanged.

This feature is perfect for logging time when viewing issue details in web-based tools, email notifications, or any other context where JIRA issue IDs appear.
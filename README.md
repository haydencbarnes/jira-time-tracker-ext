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

1. **View Entries**: Navigate to the **Time Table** tab to see issues returned by your custom JQL (see below) and your logged time.
2. **Edit Entries**: Enter time, optional worklog comment, and date, then use the submit button on each row to log work.
3. **Detailed View**: Click on any issue to open it in Jira.

**Time Table settings (gear icon top right)**  
Open the gear button in the table header (top right) to configure the Time Table:

- **Custom JQL**: Filter which issues appear.
- **Columns**: Toggle **Status** (workflow transitions per issue), **Assignee** (search and update assignment), **Total** (aggregated logged time per issue), and **Comment**.
- **Column order**: Drag to reorder middle columns (Jira ID and submit button stay fixed first and last).

**Optional(s)**:

- Star an issue to keep it at the top of your time table.
- You can also hover over the issue Jira ID to see a history of the last 5 worklogs.

### How Timer Works

1. **Start Timer**: Click the "play" button to begin tracking time spent on a task. The timer will run in the background, even if you navigate to a different tab, and the badge will display the current time spent as well.
2. **Stop Timer**: Click the "stop" button to end the timer.
3. **Fill Out Details**: Enter a brief description of the work completed.
4. **Submit**: Click the "Submit" button to log your time. You will receive a success message and the timer fields will clear automatically.

## Development

The extension source now lives in `src/ts` and `src/html`. Generated runtime JavaScript and extension HTML copies are written to `dist/`.

1. Install dependencies with `npm install`.
2. Rebuild the extension scripts with `npm run build`.
3. Validate types with `npm run typecheck`.
4. Lint TypeScript with `npm run lint` (warnings fail the command).
5. Use `npm run lint:warn` if you want warning-tolerant local lint output.
6. Check formatting with `npm run format:check` or format in place with `npm run format`.
7. Run the full CI gate locally with `npm run ci:check`.
8. Reload the unpacked extension in Chrome after rebuilding so it picks up the updated `dist/` assets.

## Settings/Preferences

The below settings must be set for this extension to work properly.

#### Jira Instance Type

This is the type of Jira instance you are using, whether that be Server or Cloud.

#### Jira Domain/URL

This is your Jira Domain URL, whether that be Server or Cloud. For example: `https://jira.atlassian.com/`.

#### Username/Email

Your Jira Username/Email.

#### REST API Token

This is your Jira REST API Token.

#### Custom JQL (Time Table)

The default JQL is `(assignee=currentUser() OR worklogAuthor=currentUser()) AND status NOT IN (Closed, Done)`. That means the Time Table shows issues that are:

1. Assigned to you or you have logged time on, and
2. Not in **Closed** or **Done**.

You edit Custom JQL in **Time Table settings (gear icon top right)** on the Time Table tab—not in the global Options page.

## Other features

#### Worklog Snippets

Log work faster by using worklog snippets to store and insert a frequently used worklog description/comment. You can save two snippets in the settings tab and they will appear as buttons accross the extension in the description of work completed field.

#### Dark Mode

This toggle allows you to enable/disable the dark mode of the extension. You can also toggle dark mode system scheme following on and off from the settings tab.

#### Experimental Features Toggle

This toggle allows you to enable/disable the experimental features of the extension. Currently, the experimental features include:

- Worklog Autosuggestions
- Google Calendar Add-on
- JIRA Issue ID Detection & Time Tracking Popups (more info below)

#### JIRA Issue ID Detection (Experimental)

- The extension scans any webpage for JIRA issue IDs (e.g. `ABC-123`).
- Each detected ID is left completely **intact** – normal links still work and plain-text stays selectable.
- A small **blue ⏱ log-time icon** is injected immediately **to the right of the ID**.
- Click the blue icon to open the quick Log-Time popup (the icon has a tooltip: _Log time for ABC-123_).
- The ID itself remains clickable/navigable so you can still open the issue in JIRA as usual.

Key details:

1. **Automatic Detection** – works in e-mails, docs, Slack, etc.
2. **Non-intrusive** – no underline; subtle background highlight only on plain-text IDs.
3. **Icon UX** – blue in light-mode, lighter blue hover, matching dark-mode palette.
4. **Bottom-right Badge** – "JIRA detection active" badge now appears bottom-right in blue for 3 s when the feature activates.
5. **All other popup features** (dark-mode, validation, error handling) remain unchanged.

This feature is perfect for logging time when viewing issue details in web-based tools, email notifications, or any other context where JIRA issue IDs appear.

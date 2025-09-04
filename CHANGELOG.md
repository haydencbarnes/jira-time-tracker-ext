## 1.4.5 (Sep 04, 2025)
- Fix: Migrated Jira Cloud search to POST `/rest/api/3/search/jql` with `nextPageToken` pagination (up to 10k issues) after GET `/search` endpoint was permanently removed (410 error). This restores issue fetching on Cloud per Atlassian's CHANGE-2046.
- Chore: Hardened issue parsing to support both legacy and new JQL service response shapes.

## 1.4.4 (Aug 23, 2025)
- Feature: Timer redesign with enhanced controls and time editing functionality
  - Redesigned timer controls layout with improved visual hierarchy
  - Added inline time editing capability - click edit icon to modify time directly
  - Enhanced comment toggle functionality with collapsible comment section
  - Improved timer display format (now shows "1h 05m 30s" instead of "01:05:30")
  - Better visual feedback for active timer state with animation improvements
  - Updated button icons and improved accessibility
  - Enhanced dark mode support for new timer controls
  - Streamlined UI with better space utilization and modern design

## 1.4.3 (Aug 23, 2025)
- Bug fix: Fixed Jira search URL construction in Settings; corrected JQL and pagination parameters to remove 400 errors on Settings page. See [#14](https://github.com/haydencbarnes/jira-time-tracker-ext/issues/14).

## 1.4.2 (Aug 21, 2025)
- UX: Adjusted the width of the Jira ID column in the popup table to be better aligned with the other columns.

## 1.4.1 (Aug 14, 2025)
- Options: Added a top-right "Report bug" button and ensured it uses the extension blue. Moved it outside the settings table to preserve layout.
- Options: Made the branding bar sticky (fixed to bottom) and allowed the options content to scroll behind with proper bottom padding.
- UX: Worklog autosuggestions are now always enabled across Popup, Search, and Timer (no longer gated by Experimental Features).

## 1.4.0 (Aug 08, 2025)
- NEW! Feature: Added a CLI tab for natural language time entry.
  - Batch logging (semicolon or new lines)
  - Slash commands with a picker (/time, /me, /help)
  - Command: /bug opens the GitHub new issue page to report bugs/features
  - Quick summaries: `time ISSUE-123` and `time ISSUE-123 --me`
  - Persistent history, dimmed user echoes, bright system responses
  - Auto-highlight Jira issue keys in blue
  - Welcome banner with classic orange BETA badge
  - Overlay command picker with viewport-aware positioning
- UI: Added caret button in footer to open CLI; centered and gradient focus/hover styling.
- Options: Added CLI as a default tab option.

## 1.3.9 (Aug 07, 2025)
- UI: Added Ko‑fi support button to brand section, moved to bottom-left; removed GitHub profile link and relocated “Designed by” to Settings.
- UI: Standardized brand/footer spacing and icon spacing across tabs; reduced popup header Jira logo to 16px.
- UX: Added new caching mechanism to the extension to improve performance and reduce API calls.

## 1.3.8 (Jul 13, 2025)
- Bug fix: Fixed an issue where editing text that included a Jira issue ID that the BETA Jira Issue ID Detection feature detected would cause the extension to make the text unusable and move the cursor to the incorrect position.

## 1.3.7 (Jul 04, 2025)
- Bug fix: Fixed an issue where the experimental side panel feature was not working as expected. https://github.com/haydencbarnes/jira-time-tracker-ext/issues/6

## 1.3.6 (Jul 04, 2025)
- Feature: Added Jira Issue ID Detection as an experimental feature. The extension scans any web-page for Jira issue IDs (e.g. ABC-123, PROJECT-456). A subtle highlight is applied and a small blue ⏱ "log-time" icon is injected to the right of the ID. Clicking the icon opens the instant Log-Time popup while the ID itself remains a normal link.
- UX: Blue "Jira detection" badge now appears bottom-right when the detector first runs. Also sped up some other animations in the extension.

## 1.3.5 (Jun 28, 2025)
- Feature: Added new error handling feature to the extension. Users can now see a more detailed error message when an error occurs.

## 1.3.4 (Jun 09, 2025)
- Bug fix: Fixed an issue where the worklog tooltip was not being displayed correctly when the user had a large number of Jira work items.

## 1.3.3 (May 31, 2025)
- Feature: Added new worklog autosuggestions feature to the Timer tab. Users can now use the worklog autosuggestions feature to quickly insert autosuggestions into the Timer tab worklog descriptions/comments if they have experimental features enabled.
- Chore: Refactored the worklog autosuggestions feature to be more consistent across all tabs.

## 1.3.2 (May 31, 2025)
- Feature: Added new worklog autosuggestions feature to the Search tab. Users can now use the worklog autosuggestions feature to quickly insert autosuggestions into the Search tab worklog descriptions/comments if they have experimental features enabled.

## 1.3.1 (May 03, 2025)
- Feature: Added new error and success animations to the Time Table tab.

## 1.3.0 (Apr 16, 2025)
- NEW! Feature: Added dark mode to the extension. Users can now toggle dark mode on and off from the bottom nav bar. You can also toggle dark mode system scheme following on and off from the options page.

## 1.2.16 (Apr 14, 2025)
- Feature: Added new experimental side panel feature to the extension. Users can now use Chrome's side panel view to log time, search for issues, and view the time table.

## 1.2.15 (Apr 08, 2025)
- Feature: Refined dark mode styling for all tabs.

## 1.2.14 (Apr 07, 2025)
- Feature: Added new worklog autosuggestions feature as an experimental feature. Users can now use the worklog autosuggestions feature to quickly insert autosuggestions into the Time Table tabs worklog descriptions/comments. Feature coming soon to the Search and Timer tabs.
- Bug fix: Fixed an issue where the frequent worklog description buttons were not showing up as expected when the user had only filled in one of the two buttons on the Time Table tab. Fix coming soon to the Search and Timer tabs.
- Bug fix: Fixed an issue where the Jira ID link was not working as expected when the user had a custom base URL.

## 1.2.13 (Apr 05, 2025)
- Feature: Added dark mode toggle to the options page as an experimental feature. Users can now toggle dark mode on and off from the options page if experimental features are enabled.

## 1.2.12 (Jan 29, 2025)
- Bug fix: UI/UX improvements to all tabs
- Docs: Updated README.md with new features and settings

## 1.2.11 (Jan 25, 2025)
- Bug fix: snippet buttons now properly render on the search and timer tabs
- Bug fix: default tab setting now properly allows you to go back to non-default tab after changing the setting

## 1.2.10 (Jan 21, 2025)
- Bug fix: Fixed an issue where snippets/frequentworklogdescriptions were not following the time table layouts header on scroll.

## 1.2.9 (Jan 20, 2025)
- Feature: Added a worklog history display to the Time Table tab. Users can now see a history of the last 5 worklogs by hovering over the issue Jira ID.
- Chore: rename frequent worklog description fields to worklog snippets to more align with feature terminology
- Fix: total hours on time table digit overflow fixes


## 1.2.8 (Jan 18, 2025)
- Feature: Added new ability to set a default open tab for the extension. Users can now choose between the Time Table, Timer, or Search tab to open by default.
- Bug fix: Fixed and aligned frontend error messages.

## 1.2.7 (Jan 10, 2025)
- Feature: Added starring functionality to prioritize issues in the pop-up table.
- Enhancement: Starred issues now appear at the top of the table, sorted dynamically.
- Bug Fix: Frequent worklog description buttons now properly reinitialize after table redraws.
- Maintenance: Added a cleaned up of old starred items automatically after 90 days to prevent data accumulation.
- UX Improvement: Improved table re-rendering logic to ensure all features and buttons remain functional after updates.

## 1.2.6 (Oct 29, 2024)
- Bug fix: Fixed frequent worklog description buttons feature that was not working as expected

## 1.2.5 (Oct 16, 2024)
- Fixed issue with timer badge not updating when timer is stopped

## 1.2.4 (Oct 15, 2024)
- Feature: added new timer badge feature that will continously show the current time spent on a task from wherever you have the extension placed when timer is running.

## 1.2.3 (Oct 14, 2024)
- Feature: added new frequent worklog description button fill feature to all features
- UX: Minor copy changes to improve clarity

## 1.2.2 (Oct 11, 2024)
- Fix: added version to options/settings page for 🐛 tracking
- Feature: added new frequent worklog description search button fill feature

## 1.2.1 (Oct 07, 2024)
- New feature: Added timer feature to the extension. Users can now start and stop a timer to track time spent on Jira tasks. The feature alsp includes quick add functionality to add time in 15min, 30min, and 1hr increments.

## 1.2.0 (Sep 11, 2024)
- NEW! The extension now supports Jira Cloud users! Atlassian Jira API V2 and V3 are both now supported. All features, including experimental features, are now available for Jira Cloud users.

## 1.1.5 (Aug 28, 2024)
- Updated API path requests structure for Jira versions above 7.4.0 (correcting basic auth issues)

## 1.1.4 (Jul 09, 2024)
- Added experimental timer feature

## 1.1.3 (Jul 03, 2024)
- Minor UX cleanup/standardization across the extension

## 1.1.2 (Jun 28, 2024)
- Fixed error messages and other UI/UX issues
- Added autocomplete for search feature

## 1.1.1 (Jun 19, 2024)
- Removed unnecessary permission for activeTab, will re-add if needed in future versions

## 1.1.0 (Jun 19, 2024)
- Added new functionality to allow users to search for issues by project
- Updated UI/UX in many places

## 0.0.1 (Jun 12, 2024)
- Initial release for JIRA API 2
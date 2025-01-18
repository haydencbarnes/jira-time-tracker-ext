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
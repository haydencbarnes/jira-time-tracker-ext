# Weekly View Feature

## Overview

The Weekly View feature has been implemented for the JIRA Time Tracker extension, providing users with a calendar-based view of their logged work organized by week. This feature allows users to visualize their time entries across days and easily navigate between different weeks.

## Files Added

### 1. `weekly-view.html`
- Main HTML file for the weekly view interface
- Features a calendar-style layout with 7 days of the week
- Includes navigation controls for moving between weeks
- Contains a summary panel showing week statistics
- Supports both light and dark themes
- Responsive design with a clean, modern UI

### 2. `weekly-view.js`
- JavaScript functionality for the weekly view
- Handles JIRA API integration for fetching worklog data
- Processes and organizes worklog entries by date
- Manages week navigation and date calculations
- Implements theme switching functionality
- Provides CSV export functionality for weekly data

## Features

### Calendar View
- 7-day weekly calendar showing Sunday through Saturday
- Each day displays:
  - Date number
  - All tasks worked on that day
  - Time spent per task
  - Work comments/descriptions
- Today's date is highlighted
- Tasks are clickable to open the corresponding JIRA issue

### Week Navigation
- Previous/Next week buttons
- Current week date range display
- Automatic calculation of week boundaries

### Summary Statistics
- **Total Time**: Sum of all logged hours for the week
- **Issues Worked**: Count of unique issues worked on
- **Working Days**: Number of days with logged work
- **Average per Day**: Average hours per working day

### Additional Features
- **Dark Mode Support**: Consistent theming with the main extension
- **CSV Export**: Export weekly timesheet data to CSV format
- **Error Handling**: Graceful handling of API failures and missing data
- **Loading States**: Visual feedback during data fetching
- **Responsive Design**: Works well within extension popup constraints

## Navigation Integration

The weekly view is accessible from:
- Main popup navigation bar (📅 calendar icon)
- Timer page navigation bar (📅 calendar icon)
- Back button in weekly view returns to main popup

## Technical Implementation

### Data Flow
1. Initialize JIRA API connection using stored credentials
2. Fetch issues using configured JQL query
3. For each issue, fetch worklog entries
4. Filter worklogs to current week date range
5. Process and organize data by day
6. Display in calendar format with summary statistics

### Week Calculation
- Week starts on Sunday (configurable)
- Week boundaries calculated using JavaScript Date objects
- Handles month/year transitions correctly
- Timezone-aware date handling

### Performance Considerations
- Parallel API calls for fetching multiple issue worklogs
- Efficient date filtering and processing
- Minimal DOM manipulation for better performance
- Graceful handling of API rate limits

## User Experience

### Workflow
1. User clicks calendar icon (📅) in navigation
2. Weekly view loads showing current week
3. Data is fetched and organized automatically
4. User can navigate between weeks using Previous/Next buttons
5. Click on any task to open the issue in JIRA
6. Export data as CSV for external reporting

### Visual Design
- Consistent with existing extension styling
- Clean, modern calendar interface
- Color-coded elements (today's date, task entries)
- Responsive layout that works in popup and side panel modes

## Error Handling

The implementation includes robust error handling for:
- JIRA API connection failures
- Missing or invalid worklog data
- Date parsing errors
- Network connectivity issues
- Rate limiting and timeout scenarios

## Future Enhancements

Potential improvements that could be added:
- Different week start days (Monday vs Sunday)
- Monthly view option
- Time range filtering
- Custom date range selection
- Worklog editing capabilities
- Team view for multiple users
- Integration with calendar applications

## Testing

The feature has been designed to work with both JIRA Server and JIRA Cloud instances and handles various worklog comment formats (plain text and ADF).

## Usage

Users can access the weekly view by:
1. Opening the extension popup
2. Clicking the calendar icon (📅) in the navigation bar
3. The weekly view will load showing the current week's logged work
4. Navigate between weeks and export data as needed
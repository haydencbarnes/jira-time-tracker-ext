/**
 * Comprehensive JIRA API Error Handler Module
 * Handles common JIRA API errors and provides actionable error messages
 */

// Comprehensive error handler for JIRA API errors
function handleJiraError(error, defaultMessage = 'An error occurred', context = '') {
    console.error('JIRA Error:', error);
    
    // Extract status code from error message if available
    const statusMatch = error.message?.match(/Error (\d+):/);
    const statusCode = statusMatch ? parseInt(statusMatch[1]) : null;
    
    let errorMessage = defaultMessage;
    let actionableSteps = '';

    switch (statusCode) {
        case 400:
            errorMessage = 'Bad Request - Invalid data sent to JIRA';
            if (context.includes('search') || context.includes('timer')) {
                actionableSteps = 'The issue key or time format may be invalid. Verify the issue exists and use proper time format (e.g., 2h, 30m).';
            } else {
                actionableSteps = 'Check your JQL query in Settings, ensure all field names are correct, and verify that referenced projects/issue types exist.';
            }
            break;
            
        case 401:
            errorMessage = 'Authentication Failed - JIRA could not verify your identity';
            actionableSteps = 'Your API token may be invalid or expired. Go to Settings and:\n1. Verify your username/email is correct\n2. Generate a new API token from your Atlassian account\n3. Ensure you\'re using an API token (not password) for Jira Cloud';
            break;
            
        case 403:
            errorMessage = 'Access Denied - You don\'t have permission for this operation';
            actionableSteps = 'Your account lacks necessary permissions. Contact your JIRA administrator to:\n1. Grant you project access\n2. Enable worklog permissions\n3. Verify your account has "Browse Projects" and "Work On Issues" permissions';
            break;
            
        case 404:
            errorMessage = 'Not Found - JIRA server or resource not found';
            if (context.includes('search') || context.includes('timer')) {
                actionableSteps = 'Check that:\n1. The issue key exists and is accessible to you\n2. Your Base URL in Settings is correct\n3. The JIRA instance is accessible';
            } else {
                actionableSteps = 'Check your Base URL in Settings:\n1. Ensure URL is correct (e.g., company.atlassian.net for Cloud)\n2. Remove any trailing slashes\n3. Verify the JIRA instance is accessible';
            }
            break;
            
        case 500:
            errorMessage = 'JIRA Server Error - Internal server problem';
            actionableSteps = 'This is a JIRA server issue. Try again in a few minutes, or contact your JIRA administrator if the problem persists.';
            break;
            
        case 503:
            errorMessage = 'JIRA Service Unavailable - Server is temporarily down';
            actionableSteps = 'JIRA is temporarily unavailable. Wait a few minutes and try again.';
            break;
            
        default:
            // Check for specific error patterns in the message
            if (error.message?.includes('Basic authentication with passwords is deprecated')) {
                errorMessage = 'Password Authentication Deprecated';
                actionableSteps = 'JIRA no longer accepts passwords. Go to Settings and:\n1. Use your email address as username\n2. Generate an API token from id.atlassian.com/manage/api-tokens\n3. Use the API token instead of your password';
            } else if (error.message?.includes('CORS') || error.message?.includes('fetch')) {
                errorMessage = 'Connection Error - Cannot reach JIRA server';
                actionableSteps = 'Network or CORS issue. Check:\n1. Your internet connection\n2. Base URL is correct in Settings\n3. JIRA server is accessible from your browser';
            } else if (error.message?.includes('Invalid JQL')) {
                errorMessage = 'Invalid JQL Query';
                actionableSteps = 'Your JQL query in Settings contains errors. Verify the query works in JIRA\'s issue search before using it here.';
            } else if (error.message?.includes('Worklog must not be null')) {
                errorMessage = 'Timer Error - No time recorded';
                actionableSteps = 'Please start and stop the timer before trying to log time. Make sure the timer has recorded some time.';
            } else {
                const settingsRef = context.includes('search') || context.includes('timer') ? 
                    'Please check your configuration in the main popup Settings and try again.' :
                    'Please check your Settings configuration and try again. If the problem persists, contact your JIRA administrator.';
                actionableSteps = settingsRef;
            }
    }

    const fullMessage = actionableSteps ? `${errorMessage}\n\n${actionableSteps}` : errorMessage;
    
    // Call displayError function if it exists, otherwise log to console
    if (typeof displayError === 'function') {
        displayError(fullMessage);
    } else {
        console.error('Display Error Function Not Found:', fullMessage);
    }
}

// Export for use in other modules (if using modules) or make globally available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { handleJiraError };
} else {
    // Make globally available for browser extension context
    window.JiraErrorHandler = { handleJiraError };
} 
async function JiraAPI(baseUrl, apiExtension, username, apiToken, jql) {
    const apiUrl = `${baseUrl}${apiExtension}`;

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${btoa(`${username}:${apiToken}`)}`
    };

    return {
        login,
        getIssue,
        getIssues,
        getIssueWorklog,
        updateWorklog,
        getProjects,
    };

    async function login() {
        const url = `/user?username=${username}`;
        return apiRequest(url, 'GET');
    }

    async function getIssue(id) {
        return apiRequest(`/issue/${id}`);
    }

    async function getIssues(jql) {
        if (!jql) {
            throw new Error("JQL query must be provided.");
        }

        const encodedJQL = encodeURIComponent(jql);
        const fields = "summary,status,worklog";
        const endpoint = `/search?jql=${encodedJQL}&fields=${fields}&startAt=0&maxResults=100000`;
        console.log(`Requesting issues with endpoint: ${endpoint}`);

        const response = await apiRequest(endpoint);
        return handleIssueResp(response);
    }

    async function getIssueWorklog(id) {
        return apiRequest(`/issue/${id}/worklog`);
    }

    async function getProjects() {
        console.log(`Requesting projects`);
        return apiRequest('/project', 'GET');  // Use generic apiRequest function
    }

    async function updateWorklog(id, timeSpentSeconds, started, comment) {
        const url = `/issue/${id}/worklog?notifyUsers=false`;
    
        const data = {
            timeSpentSeconds: timeSpentSeconds,  // Assuming timeSpent is in seconds
            comment: comment || '', 
            started: parseDate(started)  // Helper function to format the date
        };
    
        console.log("Update worklog payload:", data);  // Log the payload to debug the request
    
        return apiRequest(url, 'POST', data);
    }
    
    function parseDate(date) {
        const dateObj = new Date(date);
    
        // ISO string: "2024-06-11T00:15:38.399Z"
        const isoString = dateObj.toISOString();
    
        // Remove "Z" and append "+0000" to make it "2024-06-11T00:15:38.399+0000"
        const formattedDate = isoString.slice(0, -1) + "+0000";
    
        console.log("Parsed Date:", formattedDate); // For debugging purposes
        return formattedDate;
    }
    

    async function apiRequest(endpoint, method = 'GET', data = null) {
        const url = apiUrl.startsWith('http') ? `${apiUrl}${endpoint}` : `https://${apiUrl}${endpoint}`;
        const options = {
            method: method,
            headers: headers,
        };
        if (data && method === 'POST') {
            options.body = JSON.stringify(data);
        }
    
        console.log(`Making API request to URL: ${url} with options:`, options);
    
        try {
            const response = await fetch(url, options);
            const contentType = response.headers.get("content-type");
    
            console.log(`Response status: ${response.status}, content-type: ${contentType}`);
    
            if (response.ok) {
                console.log("API request successful");
                if (contentType && contentType.includes("application/json")) {
                    return await response.json();
                } else {
                    const text = await response.text();
                    console.warn("Expected JSON but received:", text);
                    return {
                        status: response.status,
                        statusText: response.statusText,
                        responseText: text
                    };
                }
            } else {
                let errorData;
                if (contentType && contentType.includes("application/json")) {
                    errorData = await response.json();
                } else {
                    errorData = await response.text();
                }
                handleJiraResponseError(response, errorData);
            }
        } catch (error) {
            console.error(`API Request to ${url} failed:`, error);
            throw new Error(`API request failed: ${error.message}`);
        }
    }    

    function handleJiraResponseError(response, errorData) {
        let errorMsg = 'Unknown error';
        if (response.status >= 400) {
            if (typeof errorData === 'string') {
                errorMsg = errorData;
            } else if (errorData && errorData.errorMessages) {
                errorMsg = errorData.errorMessages.join(', ');
            } else if (errorData && errorData.errors) {
                errorMsg = JSON.stringify(errorData.errors);
            } else {
                errorMsg = response.statusText;
            }
        }
    
        console.error(`Error ${response.status}: ${errorMsg}`);
        throw new Error(`Error ${response.status}: ${errorMsg}`);
    }

    function handleIssueResp(resp) {
        if (!issuesValidator(resp)) {
            console.error("Invalid issue response format:", resp);
            return [];
        }
        return resp.issues;
    }

    function issuesValidator(body) {
        if (typeof body === "object" && body !== null && "issues" in body) {
            const partial = body;
            return Array.isArray(partial.issues);
        }
        return false;
    }

}

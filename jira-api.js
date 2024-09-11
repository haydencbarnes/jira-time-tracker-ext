async function JiraAPI(jiraType, baseUrl, username, apiToken) {
    const isJiraCloud = jiraType === 'cloud';
    const apiVersion = isJiraCloud ? '3' : '2';

    // Remove trailing slash from baseUrl if present
    baseUrl = baseUrl.replace(/\/$/, '');

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${btoa(`${username}:${apiToken}`)}`
    };

    function getApiPath(path) {
        // Remove leading slash from path if present
        path = path.replace(/^\//, '');
        if (!isJiraCloud) {
            path = path.replace(/^rest\/api\/3/, `rest/api/${apiVersion}`);
        }
        return path;
    }

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

    async function getIssues(begin = 0, jql) {
        const endpoint = `/search?jql=${encodeURIComponent(jql)}&fields=summary,parent,project&maxResults=500&startAt=${begin}`;
        console.log(`Requesting issues from: ${endpoint}`);
        const response = await apiRequest(endpoint, 'GET');
        console.log(`Response from Jira:`, response);
        return handleIssueResp(response);
    }

    async function getIssueWorklog(id) {
        return apiRequest(`/issue/${id}/worklog`);
    }

    async function getProjects(begin = 0) {
        const endpoint = isJiraCloud 
            ? `/project/search?maxResults=500&startAt=${begin}`
            : '/project';
        console.log(`Requesting projects from: ${endpoint}`);
        const response = await apiRequest(endpoint, 'GET');
        console.log(`Response from Jira:`, response);
        return handleProjectResp(response);
    }

    async function updateWorklog(id, timeSpentSeconds, started, comment) {
        const endpoint = `/issue/${id}/worklog?notifyUsers=false`;
        
        const formattedComment = isJiraCloud
            ? {
                type: "doc",
                version: 1,
                content: [
                    {
                        type: "paragraph",
                        content: [
                            {
                                text: comment,
                                type: "text",
                            },
                        ],
                    },
                ],
            }
            : comment;

        const data = {
            timeSpentSeconds,
            comment: formattedComment,
            started: parseDate(started)
        };

        return apiRequest(endpoint, 'POST', data);
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
        // Ensure the endpoint does not duplicate the base URL path
        const cleanEndpoint = endpoint.replace(/^\/rest\/api\/\d+/, '').replace(/^\/+/, '');
        const url = isJiraCloud 
            ? `https://${baseUrl}/rest/api/${apiVersion}/${cleanEndpoint}`
            : `${baseUrl.startsWith('http') ? '' : 'https://'}${baseUrl}/rest/api/${apiVersion}/${cleanEndpoint}`;
        
        const options = {
            method,
            headers,
            ...(data && method === 'POST' && { body: JSON.stringify(data) })
        };
    
        console.log(`Making API request to URL: ${url} with options:`, options);
    
        try {
            const response = await fetch(url, options);
            const contentType = response.headers.get("content-type");
    
            console.log(`Response status: ${response.status}, content-type: ${contentType}`);
    
            if (response.ok) {
                console.log("API request successful");
                return contentType?.includes("application/json") ? await response.json() : await response.text();
            } else {
                const errorData = contentType?.includes("application/json") ? await response.json() : await response.text();
                handleJiraResponseError(response, errorData);
            }
        } catch (error) {
            console.error(`API Request to ${url} failed:`, error);
            throw new Error(`API request failed: ${error.message}`);
        }
    }    

    function handleJiraResponseError(response, errorData) {
        const errorMsg = typeof errorData === 'string' 
            ? errorData 
            : errorData?.errorMessages?.join(', ') 
            || JSON.stringify(errorData?.errors) 
            || response.statusText;

        console.error(`Error ${response.status}: ${errorMsg}`);
        throw new Error(`Error ${response.status}: ${errorMsg}`);
    }

    function handleProjectResp(resp) {
        if (isJiraCloud && resp.values) {
            return {
                total: resp.total,
                data: resp.values.map(project => ({
                    key: project.key,
                    name: project.name
                }))
            };
        } else if (Array.isArray(resp)) {
            return {
                total: resp.length,
                data: resp.map(project => ({
                    key: project.key,
                    name: project.name
                }))
            };
        } else {
            console.error("Unexpected project response structure:", resp);
            return { total: 0, data: [] };
        }
    }    

    function handleIssueResp(resp) {
        if (!resp?.issues) {
            console.error("Invalid issue response format:", resp);
            return { total: 0, data: [] };
        }
        return {
            total: resp.total,
            data: resp.issues.map(issue => ({
                key: issue.key,
                fields: {
                    summary: issue.fields.summary,
                    project: issue.fields.project,
                    worklog: issue.fields.worklog || { worklogs: [] }
                }
            }))
        };
    }  
}

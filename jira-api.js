async function JiraAPI(jiraType, baseUrl, username, apiToken) {
    const isJiraCloud = jiraType === 'cloud';
    const apiVersion = isJiraCloud ? '3' : '2';
    const DEFAULT_TTL_MS = 60 * 1000; // 1 minute cache for GETs
    const WORKLOG_TTL_MS = 60 * 1000;
    const memoryCache = new Map(); // in-memory cache to reduce storage.local usage

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
        // Use /myself to reliably fetch the current authenticated user for both Cloud and Server
        const url = `/myself`;
        return apiRequest(url, 'GET');
    }

    async function getIssue(id) {
        return apiRequest(`/issue/${id}`);
    }

    async function getIssues(begin = 0, jql) {
        // Cloud has migrated to /search/jql (POST). Server/DC keeps /search (GET)
        if (isJiraCloud) {
            const endpoint = `/search/jql`;
            const body = {
                jql,
                fields: ["summary", "parent", "project"],
                maxResults: 500
                // NOTE: New API uses token-based pagination. We intentionally
                // do not send startAt here to avoid 400s. begin is ignored for Cloud.
            };
            console.log(`Requesting issues from: ${endpoint} (POST /search/jql)`);
            const response = await apiRequest(endpoint, 'POST', body);
            console.log(`Response from Jira:`, response);
            return handleIssueResp(response);
        } else {
            const endpoint = `/search?jql=${encodeURIComponent(jql)}&fields=summary,parent,project&maxResults=500&startAt=${begin}`;
            console.log(`Requesting issues from: ${endpoint}`);
            const response = await apiRequest(endpoint, 'GET');
            console.log(`Response from Jira:`, response);
            return handleIssueResp(response);
        }
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

        const result = await apiRequest(endpoint, 'POST', data);
        // Invalidate cached worklog for this issue
        try {
            const url = buildAbsoluteUrl(`/issue/${id}/worklog`);
            const key = getCacheKey(url);
            memoryCache.delete(key);
            await storageLocalRemove(key);
        } catch (e) {
            console.warn('Failed to invalidate worklog cache', e);
        }
        return result;
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

    function buildAbsoluteUrl(endpoint) {
        const cleanEndpoint = endpoint.replace(/^\/rest\/api\/\d+/, '').replace(/^\/+/, '');
        return isJiraCloud
            ? `https://${baseUrl}/rest/api/${apiVersion}/${cleanEndpoint}`
            : `${baseUrl.startsWith('http') ? '' : 'https://'}${baseUrl}/rest/api/${apiVersion}/${cleanEndpoint}`;
    }

    async function apiRequest(endpoint, method = 'GET', data = null) {
        // Ensure the endpoint does not duplicate the base URL path
        const url = buildAbsoluteUrl(endpoint);
        
        const options = {
            method,
            headers,
            ...(data && method === 'POST' && { body: JSON.stringify(data) })
        };
    
        console.log(`Making API request to URL: ${url} with options:`, options);
    
        try {
            // Serve cached GETs
            if (method === 'GET') {
                const key = getCacheKey(url);
                const ttl = url.includes('/worklog') ? WORKLOG_TTL_MS : DEFAULT_TTL_MS;
                // 1) In-memory cache
                const memHit = getFromMemoryCache(key, ttl);
                if (memHit !== null) {
                    console.log(`Memory cache hit for ${url}`);
                    return memHit;
                }
                // 2) Persistent cache only for non-worklog endpoints
                if (!url.includes('/worklog')) {
                    const diskHit = await getFromCache(key, ttl);
                    if (diskHit !== null) {
                        console.log(`Disk cache hit for ${url}`);
                        setInMemoryCache(key, diskHit);
                        return diskHit;
                    }
                }
            }

            const response = await fetch(url, options);
            const contentType = response.headers.get("content-type");
    
            console.log(`Response status: ${response.status}, content-type: ${contentType}`);
    
            if (response.ok) {
                console.log("API request successful");
                const parsed = contentType?.includes("application/json") ? await response.json() : await response.text();
                if (method === 'GET') {
                    const key = getCacheKey(url);
                    // always set memory cache
                    setInMemoryCache(key, parsed);
                    // only persist non-worklog endpoints
                    if (!url.includes('/worklog')) {
                        await setInCache(key, parsed);
                    }
                }
                return parsed;
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
        // Support both classic and new JQL service shapes
        const issues = resp?.issues || resp?.results || resp?.data?.issues || [];
        if (!Array.isArray(issues)) {
            console.error("Invalid issue response format:", resp);
            return { total: 0, data: [] };
        }
        const total = typeof resp?.total === 'number' ? resp.total : issues.length;
        return {
            total,
            data: issues.map(issue => ({
                key: issue.key,
                fields: {
                    summary: issue.fields?.summary,
                    project: issue.fields?.project,
                    worklog: issue.fields?.worklog || { worklogs: [] }
                }
            }))
        };
    }  

    // ---- storage-backed cache helpers ----
    function getCacheKey(url) {
        return `GET:${username || 'anon'}:${url}`;
    }

    // In-memory cache helpers (not persisted)
    function getFromMemoryCache(key, ttlMs) {
        try {
            const now = Date.now();
            const entry = memoryCache.get(key);
            if (!entry) return null;
            const { value, ts } = entry;
            if (typeof ts !== 'number' || now - ts > ttlMs) {
                memoryCache.delete(key);
                return null;
            }
            return value;
        } catch (_) {
            return null;
        }
    }

    function setInMemoryCache(key, value) {
        try {
            memoryCache.set(key, { value, ts: Date.now() });
            // Soft cap memory size
            if (memoryCache.size > 500) {
                let oldestKey = null;
                let oldestTs = Number.POSITIVE_INFINITY;
                for (const [k, v] of memoryCache.entries()) {
                    if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
                }
                if (oldestKey) memoryCache.delete(oldestKey);
            }
        } catch (_) {}
    }

    async function getFromCache(key, ttlMs) {
        try {
            const now = Date.now();
            const entry = await storageLocalGet(key);
            if (!entry) return null;
            const { value, ts } = entry;
            if (typeof ts !== 'number' || now - ts > ttlMs) return null;
            return value;
        } catch (e) {
            console.warn('Cache read error:', e);
            return null;
        }
    }

    async function setInCache(key, value) {
        try {
            await storageLocalSet(key, { value, ts: Date.now() });
        } catch (e) {
            console.warn('Cache write error:', e);
        }
    }

    function storageLocalGet(key) {
        return new Promise((resolve) => {
            try {
                if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                    chrome.storage.local.get([key], (items) => resolve(items[key] || null));
                } else if (typeof localStorage !== 'undefined') {
                    const raw = localStorage.getItem(key);
                    resolve(raw ? JSON.parse(raw) : null);
                } else {
                    resolve(null);
                }
            } catch (_) {
                resolve(null);
            }
        });
    }

    function storageLocalSet(key, value) {
        return new Promise((resolve) => {
            try {
                if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                    chrome.storage.local.set({ [key]: value }, () => resolve());
                } else if (typeof localStorage !== 'undefined') {
                    localStorage.setItem(key, JSON.stringify(value));
                    resolve();
                } else {
                    resolve();
                }
            } catch (_) {
                resolve();
            }
        });
    }

    function storageLocalRemove(key) {
        return new Promise((resolve) => {
            try {
                if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                    chrome.storage.local.remove([key], () => resolve());
                } else if (typeof localStorage !== 'undefined') {
                    localStorage.removeItem(key);
                    resolve();
                } else {
                    resolve();
                }
            } catch (_) {
                resolve();
            }
        });
    }
}

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
        getIssuesPage,
        getIssueSuggestions,
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

    // Paged issues fetch for dropdowns/infinite scroll
    async function getIssuesPage(jql, cursor = null, pageSize = 100) {
        if (isJiraCloud) {
            const endpoint = `/search/jql`;
            const body = {
                jql: jql || "",
                maxResults: Math.min(pageSize, 100),
                fields: ["summary", "parent", "project"]
            };
            if (cursor) body.nextPageToken = cursor;
            const resp = await apiRequest(endpoint, 'POST', body);
            const issues = Array.isArray(resp?.issues) ? resp.issues : [];
            return {
                total: typeof resp?.total === 'number' ? resp.total : issues.length,
                data: issues.map(issue => ({
                    key: issue.key,
                    fields: {
                        summary: issue.fields?.summary,
                        project: issue.fields?.project
                    }
                })),
                nextCursor: resp?.nextPageToken || null
            };
        } else {
            const startAt = Number.isFinite(Number(cursor)) ? Number(cursor) : 0;
            const endpoint = `/search?jql=${encodeURIComponent(jql)}&fields=summary,parent,project&maxResults=${pageSize}&startAt=${startAt}`;
            const resp = await apiRequest(endpoint, 'GET');
            const issues = Array.isArray(resp?.issues) ? resp.issues : [];
            const total = typeof resp?.total === 'number' ? resp.total : issues.length;
            const nextStart = startAt + issues.length;
            return {
                total,
                data: issues.map(issue => ({
                    key: issue.key,
                    fields: {
                        summary: issue.fields?.summary,
                        project: issue.fields?.project
                    }
                })),
                nextCursor: nextStart < total ? String(nextStart) : null
            };
        }
    }

    // Issue picker suggestions for fast type-ahead across all pages
    async function getIssueSuggestions(query, projectKey = null) {
        if (!query || typeof query !== 'string') {
            return { total: 0, data: [] };
        }
        let endpoint = `/issue/picker?query=${encodeURIComponent(query)}`;
        if (projectKey) {
            const currentJql = `project = ${projectKey}`;
            endpoint += `&currentJQL=${encodeURIComponent(currentJql)}`;
        }
        const resp = await apiRequest(endpoint, 'GET');
        const sections = Array.isArray(resp?.sections) ? resp.sections : [];
        const flatIssues = [];
        for (const section of sections) {
            const issues = Array.isArray(section?.issues) ? section.issues : [];
            for (const issue of issues) {
                flatIssues.push({
                    key: issue?.key,
                    fields: {
                        summary: issue?.summaryText || issue?.summary || '',
                        project: null
                    }
                });
            }
        }
        // De-duplicate by key while preserving order
        const seen = new Set();
        const unique = [];
        for (const it of flatIssues) {
            if (it.key && !seen.has(it.key)) {
                seen.add(it.key);
                unique.push(it);
            }
        }
        return { total: unique.length, data: unique };
    }

    async function getIssues(begin = 0, jql) {
        // Cloud has migrated to /search/jql (POST). Server/DC keeps /search (GET)
        if (isJiraCloud) {
            const defaultPageSize = 100; // Jira Cloud caps page size at 100
            const hardCap = 10000; // user-requested high cap to effectively paginate all
            // If called for simple project dropdown (e.g., "project = KEY"), avoid fetching thousands of issues
            const isSimpleProjectQuery = typeof jql === 'string' && /^\s*project\s*=\s*[^\s]+\s*$/i.test(jql);
            const dropdownLimit = 200;
            const desiredLimit = Number.isFinite(begin) && begin > 0
                ? Math.min(begin, hardCap)
                : (isSimpleProjectQuery ? dropdownLimit : hardCap);
            let aggregatedIssues = [];
            let total = null;
            let nextPageToken = null;

            while (aggregatedIssues.length < desiredLimit) {
                const remaining = desiredLimit - aggregatedIssues.length;
                const pageSize = Math.min(defaultPageSize, remaining);
                const resp = await fetchCloudSearchPage(jql, nextPageToken, pageSize);
                // Extract issues
                const pageIssues = Array.isArray(resp?.issues) ? resp.issues : [];
                if (pageIssues.length === 0) break;

                aggregatedIssues = aggregatedIssues.concat(pageIssues);
                if (typeof resp?.total === 'number') total = resp.total;

                if ((typeof total === 'number' && aggregatedIssues.length >= total) || aggregatedIssues.length >= desiredLimit) break;

                if (resp?.nextPageToken) {
                    nextPageToken = resp.nextPageToken;
                } else {
                    break;
                }
            }

            const normalized = { total: total ?? aggregatedIssues.length, issues: aggregatedIssues.slice(0, desiredLimit) };
            return handleIssueResp(normalized);
        } else {
            // Implement pagination for Server/DC as well
            const pageSize = 1000; // typical Server/DC caps; adjust safely
            const hardCap = 10000;
            let startAt = Number.isFinite(begin) && begin > 0 ? begin : 0;
            let aggregatedIssues = [];
            let total = null;

            while (aggregatedIssues.length < hardCap) {
                const endpoint = `/search?jql=${encodeURIComponent(jql)}&fields=summary,parent,project&maxResults=${pageSize}&startAt=${startAt}`;
                console.log(`Requesting issues from: ${endpoint}`);
                const resp = await apiRequest(endpoint, 'GET');
                console.log(`Response from Jira:`, resp);

                const pageIssues = Array.isArray(resp?.issues) ? resp.issues : [];
                if (!Array.isArray(pageIssues) || pageIssues.length === 0) {
                    break;
                }

                aggregatedIssues = aggregatedIssues.concat(pageIssues);
                if (typeof resp?.total === 'number') {
                    total = resp.total;
                }

                if ((typeof total === 'number' && startAt + pageIssues.length >= total) || aggregatedIssues.length >= hardCap) {
                    break;
                }

                startAt += pageIssues.length;
            }

            const normalized = { total: total ?? aggregatedIssues.length, issues: aggregatedIssues };
            return handleIssueResp(normalized);
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
            } else if (method === 'POST' && endpoint.replace(/^\//,'').startsWith('search/jql')) {
                // Cache POST /search/jql pages by payload to keep dropdowns snappy
                const cacheKey = getPostSearchJqlCacheKey(url, data);
                const ttl = DEFAULT_TTL_MS;
                const memHit = getFromMemoryCache(cacheKey, ttl);
                if (memHit !== null) {
                    console.log(`Memory cache hit for ${endpoint} POST body`);
                    return memHit;
                }
                const diskHit = await getFromCache(cacheKey, ttl);
                if (diskHit !== null) {
                    console.log(`Disk cache hit for ${endpoint} POST body`);
                    setInMemoryCache(cacheKey, diskHit);
                    return diskHit;
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
                } else if (method === 'POST' && endpoint.replace(/^\//,'').startsWith('search/jql')) {
                    // Persist POST /search/jql results keyed by payload
                    const cacheKey = getPostSearchJqlCacheKey(url, data);
                    setInMemoryCache(cacheKey, parsed);
                    await setInCache(cacheKey, parsed);
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

    // Build a stable cache key for POST /search/jql by selecting canonical fields
    function getPostSearchJqlCacheKey(url, body) {
        const keyObj = {
            url,
            jql: body?.jql || '',
            fields: Array.isArray(body?.fields) ? body.fields : [],
            maxResults: body?.maxResults || 0,
            nextPageToken: body?.nextPageToken || ''
        };
        return `POSTJQL:${JSON.stringify(keyObj)}`;
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

    // Cloud: request issues page via POST /search/jql (token-based pagination)
    async function fetchCloudSearchPage(jql, nextPageToken, maxResults) {
        const endpoint = `/search/jql`;
        const body = {
            jql: jql || "",
            maxResults: maxResults || 100,
            fields: ["summary", "parent", "project"]
        };
        if (nextPageToken) body.nextPageToken = nextPageToken;
        return apiRequest(endpoint, 'POST', body);
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

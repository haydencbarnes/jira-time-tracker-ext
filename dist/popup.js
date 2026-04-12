"use strict";
(() => {
  // src/ts/shared/jira-api.ts
  async function JiraAPI2(jiraType, baseUrl, username, apiToken) {
    const isJiraCloud = jiraType === "cloud";
    const apiVersion = isJiraCloud ? "3" : "2";
    const DEFAULT_TTL_MS = 60 * 1e3;
    const WORKLOG_TTL_MS = 60 * 1e3;
    const memoryCache = /* @__PURE__ */ new Map();
    baseUrl = baseUrl.replace(/\/$/, "").replace(/\/rest\/api\/(?:latest|\d+)$/i, "");
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Basic ${btoa(`${username}:${apiToken}`)}`
    };
    return {
      login,
      getIssue,
      getIssues,
      getIssuesPage,
      getIssueSuggestions,
      getIssueWorklog,
      updateWorklog,
      getProjects,
      getTransitions,
      transitionIssue,
      updateIssue,
      searchAssignableUsers,
      // Utilities for shared UI behavior
      resolveIssueKeyFast,
      isIssueKeyLike,
      extractIssueKey,
      validateIssueMatchesProject,
      buildStartedTimestamp
    };
    async function login() {
      const url = `/myself`;
      return apiRequest(url, "GET");
    }
    async function getIssue(id) {
      return apiRequest(`/issue/${id}`);
    }
    async function getIssuesPage(jql, cursor = null, pageSize = 100) {
      if (isJiraCloud) {
        const endpoint = `/search/jql`;
        const body = {
          jql: jql || "",
          maxResults: Math.min(pageSize, 100),
          fields: ["summary", "parent", "project"]
        };
        if (cursor) body.nextPageToken = cursor;
        const resp = await apiRequest(endpoint, "POST", body);
        const issues = Array.isArray(resp?.issues) ? resp.issues : [];
        return {
          total: typeof resp?.total === "number" ? resp.total : issues.length,
          data: issues.map((issue) => ({
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
        const resp = await apiRequest(endpoint, "GET");
        const issues = Array.isArray(resp?.issues) ? resp.issues : [];
        const total = typeof resp?.total === "number" ? resp.total : issues.length;
        const nextStart = startAt + issues.length;
        return {
          total,
          data: issues.map((issue) => ({
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
    async function getIssueSuggestions(query, projectKey = null) {
      if (!query || typeof query !== "string") {
        return { total: 0, data: [] };
      }
      let endpoint = `/issue/picker?query=${encodeURIComponent(query)}`;
      if (projectKey) {
        const currentJql = `project = ${projectKey}`;
        endpoint += `&currentJQL=${encodeURIComponent(currentJql)}`;
      }
      const resp = await apiRequest(
        endpoint,
        "GET"
      );
      const sections = Array.isArray(resp?.sections) ? resp.sections : [];
      const flatIssues = [];
      for (const section of sections) {
        const issues = Array.isArray(section?.issues) ? section.issues : [];
        for (const issue of issues) {
          const key = issue?.key;
          if (!key) continue;
          flatIssues.push({
            key,
            fields: {
              summary: issue?.summaryText || issue?.summary || "",
              project: null
            }
          });
        }
      }
      const seen = /* @__PURE__ */ new Set();
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
      if (isJiraCloud) {
        const defaultPageSize = 100;
        const hardCap = 1e4;
        const isSimpleProjectQuery = typeof jql === "string" && /^\s*project\s*=\s*[^\s]+\s*$/i.test(jql);
        const dropdownLimit = 200;
        const desiredLimit = Number.isFinite(begin) && begin > 0 ? Math.min(begin, hardCap) : isSimpleProjectQuery ? dropdownLimit : hardCap;
        let aggregatedIssues = [];
        let total = null;
        let nextPageToken = null;
        while (aggregatedIssues.length < desiredLimit) {
          const remaining = desiredLimit - aggregatedIssues.length;
          const pageSize = Math.min(defaultPageSize, remaining);
          const resp = await fetchCloudSearchPage(jql, nextPageToken, pageSize);
          const pageIssues = Array.isArray(resp?.issues) ? resp.issues : [];
          if (pageIssues.length === 0) break;
          aggregatedIssues = aggregatedIssues.concat(pageIssues);
          if (typeof resp?.total === "number") total = resp.total;
          if (typeof total === "number" && aggregatedIssues.length >= total || aggregatedIssues.length >= desiredLimit)
            break;
          if (resp?.nextPageToken) {
            nextPageToken = resp.nextPageToken;
          } else {
            break;
          }
        }
        const normalized = {
          total: total ?? aggregatedIssues.length,
          issues: aggregatedIssues.slice(0, desiredLimit)
        };
        return handleIssueResp(normalized);
      } else {
        const pageSize = 1e3;
        const hardCap = 1e4;
        let startAt = Number.isFinite(begin) && begin > 0 ? begin : 0;
        let aggregatedIssues = [];
        let total = null;
        while (aggregatedIssues.length < hardCap) {
          const endpoint = `/search?jql=${encodeURIComponent(jql ?? "")}&fields=summary,parent,project,status,assignee&maxResults=${pageSize}&startAt=${startAt}`;
          console.log(`Requesting issues from: ${endpoint}`);
          const resp = await apiRequest(endpoint, "GET");
          console.log(`Response from Jira:`, resp);
          const pageIssues = Array.isArray(resp?.issues) ? resp.issues : [];
          if (!Array.isArray(pageIssues) || pageIssues.length === 0) {
            break;
          }
          aggregatedIssues = aggregatedIssues.concat(pageIssues);
          if (typeof resp?.total === "number") {
            total = resp.total;
          }
          if (typeof total === "number" && startAt + pageIssues.length >= total || aggregatedIssues.length >= hardCap) {
            break;
          }
          startAt += pageIssues.length;
        }
        const normalized = {
          total: total ?? aggregatedIssues.length,
          issues: aggregatedIssues
        };
        return handleIssueResp(normalized);
      }
    }
    async function getIssueWorklog(id) {
      return apiRequest(`/issue/${id}/worklog`);
    }
    async function getProjects(begin = 0) {
      const endpoint = isJiraCloud ? `/project/search?maxResults=500&startAt=${begin}` : "/project";
      console.log(`Requesting projects from: ${endpoint}`);
      const response = await apiRequest(endpoint, "GET");
      console.log(`Response from Jira:`, response);
      return handleProjectResp(response);
    }
    async function updateWorklog(id, timeSpentSeconds, started, comment) {
      const endpoint = `/issue/${id}/worklog?notifyUsers=false`;
      const formattedComment = isJiraCloud ? {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                text: comment,
                type: "text"
              }
            ]
          }
        ]
      } : comment;
      const data = {
        timeSpentSeconds,
        comment: formattedComment,
        started: parseDate(started)
      };
      const result = await apiRequest(endpoint, "POST", data);
      try {
        const url = buildAbsoluteUrl(`/issue/${id}/worklog`);
        const key = getCacheKey(url);
        memoryCache.delete(key);
        await storageLocalRemove(key);
      } catch (e) {
        console.warn("Failed to invalidate worklog cache", e);
      }
      return result;
    }
    function buildStartedTimestamp(dateInput) {
      try {
        const baseDate = dateInput ? new Date(dateInput) : /* @__PURE__ */ new Date();
        const now = /* @__PURE__ */ new Date();
        baseDate.setHours(
          now.getHours(),
          now.getMinutes(),
          now.getSeconds(),
          now.getMilliseconds()
        );
        const tzo = -baseDate.getTimezoneOffset();
        const dif = tzo >= 0 ? "+" : "-";
        const pad2 = (n, s = 2) => String(n).padStart(s, "0");
        return `${baseDate.getFullYear()}-${pad2(baseDate.getMonth() + 1)}-${pad2(baseDate.getDate())}T${pad2(baseDate.getHours())}:${pad2(baseDate.getMinutes())}:${pad2(baseDate.getSeconds())}.${pad2(baseDate.getMilliseconds(), 3)}${dif}${pad2(Math.abs(Math.floor(tzo / 60)))}:${pad2(Math.abs(tzo % 60))}`;
      } catch {
        return (/* @__PURE__ */ new Date()).toISOString();
      }
    }
    function parseDate(date) {
      const dateObj = new Date(date);
      const isoString = dateObj.toISOString();
      const formattedDate = isoString.slice(0, -1) + "+0000";
      console.log("Parsed Date:", formattedDate);
      return formattedDate;
    }
    function buildAbsoluteUrl(endpoint) {
      const cleanEndpoint = endpoint.replace(/^\/rest\/api\/\d+/, "").replace(/^\/+/, "");
      const hasProtocol = /^https?:\/\//i.test(baseUrl);
      const normalizedBase = hasProtocol ? baseUrl : `https://${baseUrl}`;
      return `${normalizedBase}/rest/api/${apiVersion}/${cleanEndpoint}`;
    }
    async function apiRequest(endpoint, method = "GET", data) {
      const url = buildAbsoluteUrl(endpoint);
      const bodyInit = data != null && (method === "POST" || method === "PUT") ? { body: JSON.stringify(data) } : {};
      const options = {
        method,
        headers,
        ...bodyInit
      };
      console.log(`Making API request to URL: ${url} with options:`, options);
      try {
        if (method === "GET") {
          const key = getCacheKey(url);
          const ttl = url.includes("/worklog") ? WORKLOG_TTL_MS : DEFAULT_TTL_MS;
          const memHit = getFromMemoryCache(key, ttl);
          if (memHit !== null) {
            console.log(`Memory cache hit for ${url}`);
            return memHit;
          }
          if (!url.includes("/worklog")) {
            const diskHit = await getFromCache(key, ttl);
            if (diskHit !== null) {
              console.log(`Disk cache hit for ${url}`);
              setInMemoryCache(key, diskHit);
              return diskHit;
            }
          }
        } else if (method === "POST" && endpoint.replace(/^\//, "").startsWith("search/jql")) {
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
        console.log(
          `Response status: ${response.status}, content-type: ${contentType}`
        );
        if (response.ok) {
          console.log("API request successful");
          const parsed = contentType?.includes("application/json") ? await response.json() : await response.text();
          if (method === "GET") {
            const key = getCacheKey(url);
            setInMemoryCache(key, parsed);
            if (!url.includes("/worklog")) {
              await setInCache(key, parsed);
            }
          } else if (method === "POST" && endpoint.replace(/^\//, "").startsWith("search/jql")) {
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
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`API request failed: ${message}`);
      }
    }
    function getPostSearchJqlCacheKey(url, body) {
      const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
      const fieldsRaw = b.fields;
      const keyObj = {
        url,
        jql: typeof b.jql === "string" ? b.jql : "",
        fields: Array.isArray(fieldsRaw) ? fieldsRaw : [],
        maxResults: typeof b.maxResults === "number" ? b.maxResults : 0,
        nextPageToken: typeof b.nextPageToken === "string" ? b.nextPageToken : ""
      };
      return `POSTJQL:${JSON.stringify(keyObj)}`;
    }
    function handleJiraResponseError(response, errorData) {
      const errorMsg = typeof errorData === "string" ? errorData : (() => {
        if (errorData && typeof errorData === "object") {
          const o = errorData;
          if (Array.isArray(o.errorMessages)) {
            return o.errorMessages.map(String).join(", ");
          }
          if (o.errors !== void 0) {
            return JSON.stringify(o.errors);
          }
        }
        return response.statusText;
      })();
      console.error(`Error ${response.status}: ${errorMsg}`);
      throw new Error(`Error ${response.status}: ${errorMsg}`);
    }
    async function fetchCloudSearchPage(jql, nextPageToken, maxResults) {
      const endpoint = `/search/jql`;
      const body = {
        jql: jql || "",
        maxResults: maxResults || 100,
        fields: ["summary", "parent", "project", "status", "assignee"]
      };
      if (nextPageToken) body.nextPageToken = nextPageToken;
      return apiRequest(endpoint, "POST", body);
    }
    function handleProjectResp(resp) {
      if (isJiraCloud && resp && typeof resp === "object" && "values" in resp && Array.isArray(resp.values)) {
        const r = resp;
        return {
          total: typeof r.total === "number" ? r.total : r.values.length,
          data: r.values.map((project) => ({
            key: project.key,
            name: project.name
          }))
        };
      } else if (Array.isArray(resp)) {
        const rows = resp;
        return {
          total: rows.length,
          data: rows.map((project) => ({
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
      const rec = resp && typeof resp === "object" && !Array.isArray(resp) ? resp : {};
      const nestedData = rec.data && typeof rec.data === "object" && !Array.isArray(rec.data) ? rec.data : void 0;
      const issuesRaw = rec.issues ?? rec.results ?? nestedData?.issues ?? [];
      if (!Array.isArray(issuesRaw)) {
        console.error("Invalid issue response format:", resp);
        return { total: 0, data: [] };
      }
      const issues = issuesRaw;
      const total = typeof rec.total === "number" ? rec.total : issues.length;
      return {
        total,
        data: issues.map((issue) => {
          const i = issue;
          return {
            key: i.key,
            fields: {
              summary: i.fields?.summary,
              project: i.fields?.project ?? null,
              status: i.fields?.status ?? null,
              assignee: i.fields?.assignee ?? null,
              worklog: i.fields?.worklog ?? { worklogs: [] }
            }
          };
        })
      };
    }
    async function getTransitions(issueKey) {
      return apiRequest(
        `/issue/${issueKey}/transitions`,
        "GET"
      );
    }
    async function transitionIssue(issueKey, transitionId) {
      const result = await apiRequest(
        `/issue/${issueKey}/transitions`,
        "POST",
        {
          transition: { id: transitionId }
        }
      );
      await invalidateGetCache(`/issue/${issueKey}/transitions`);
      return result;
    }
    async function updateIssue(issueKey, fields) {
      return apiRequest(`/issue/${issueKey}`, "PUT", { fields });
    }
    async function searchAssignableUsers(issueKey, query, maxResults = 10) {
      const endpoint = `/user/assignable/search?issueKey=${encodeURIComponent(issueKey)}&query=${encodeURIComponent(query)}&maxResults=${maxResults}`;
      const resp = await apiRequest(endpoint, "GET");
      return Array.isArray(resp) ? resp : [];
    }
    function getCacheKey(url) {
      return `GET:${username || "anon"}:${url}`;
    }
    function extractIssueKey(raw) {
      if (!raw) return "";
      const text = String(raw).trim();
      const token = text.split(/\s|:/)[0].trim();
      return token.toUpperCase();
    }
    function isIssueKeyLike(key) {
      return /^[A-Z][A-Z0-9_]*-\d+$/.test(key || "");
    }
    function validateIssueMatchesProject(issueKey, projectKey) {
      if (!issueKey || !projectKey) return true;
      const prefix = String(issueKey).split("-")[0].toUpperCase();
      return prefix === String(projectKey).toUpperCase();
    }
    async function resolveIssueKeyFast(rawText, projectKey = null) {
      const key = extractIssueKey(rawText);
      if (!isIssueKeyLike(key)) {
        return { key: "", summary: "" };
      }
      if (projectKey && !validateIssueMatchesProject(key, projectKey)) {
        const err = new Error(
          "ISSUE_PROJECT_MISMATCH"
        );
        err.code = "ISSUE_PROJECT_MISMATCH";
        err.issueKey = key;
        err.projectKey = projectKey;
        throw err;
      }
      try {
        const issue = await getIssue(key);
        const summary = issue?.fields?.summary || "";
        return { key, summary };
      } catch {
        return { key, summary: "" };
      }
    }
    function getFromMemoryCache(key, ttlMs) {
      try {
        const now = Date.now();
        const entry = memoryCache.get(key);
        if (!entry) return null;
        const { value, ts } = entry;
        if (typeof ts !== "number" || now - ts > ttlMs) {
          memoryCache.delete(key);
          return null;
        }
        return value;
      } catch {
        return null;
      }
    }
    function setInMemoryCache(key, value) {
      try {
        memoryCache.set(key, { value, ts: Date.now() });
        if (memoryCache.size > 500) {
          let oldestKey = null;
          let oldestTs = Number.POSITIVE_INFINITY;
          for (const [k, v] of memoryCache.entries()) {
            if (v.ts < oldestTs) {
              oldestTs = v.ts;
              oldestKey = k;
            }
          }
          if (oldestKey) memoryCache.delete(oldestKey);
        }
      } catch {
      }
    }
    async function getFromCache(key, ttlMs) {
      try {
        const now = Date.now();
        const entry = await storageLocalGet(key);
        if (!entry) return null;
        const { value, ts } = entry;
        if (typeof ts !== "number" || now - ts > ttlMs) return null;
        return value;
      } catch (e) {
        console.warn("Cache read error:", e);
        return null;
      }
    }
    async function setInCache(key, value) {
      try {
        await storageLocalSet(key, { value, ts: Date.now() });
      } catch (e) {
        console.warn("Cache write error:", e);
      }
    }
    async function invalidateGetCache(endpoint) {
      try {
        const url = buildAbsoluteUrl(endpoint);
        const key = getCacheKey(url);
        memoryCache.delete(key);
        await storageLocalRemove(key);
      } catch (e) {
        console.warn(`Failed to invalidate cache for ${endpoint}`, e);
      }
    }
    function storageLocalGet(key) {
      return new Promise((resolve) => {
        try {
          if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(
              [key],
              (items) => resolve(items[key] || null)
            );
          } else if (typeof localStorage !== "undefined") {
            const raw = localStorage.getItem(key);
            resolve(raw ? JSON.parse(raw) : null);
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    }
    function storageLocalSet(key, value) {
      return new Promise((resolve) => {
        try {
          if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ [key]: value }, () => resolve());
          } else if (typeof localStorage !== "undefined") {
            localStorage.setItem(key, JSON.stringify(value));
            resolve();
          } else {
            resolve();
          }
        } catch {
          resolve();
        }
      });
    }
    function storageLocalRemove(key) {
      return new Promise((resolve) => {
        try {
          if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
            chrome.storage.local.remove([key], () => resolve());
          } else if (typeof localStorage !== "undefined") {
            localStorage.removeItem(key);
            resolve();
          } else {
            resolve();
          }
        } catch {
          resolve();
        }
      });
    }
  }
  var jiraApiGlobal = globalThis;
  jiraApiGlobal.JiraAPI = JiraAPI2;

  // src/ts/shared/jira-error-handler.ts
  function getErrorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = error.message;
      return typeof message === "string" ? message : "";
    }
    return "";
  }
  function handleJiraError(error, defaultMessage = "An error occurred", context = "") {
    console.error("JIRA Error:", error);
    const errorMessageText = getErrorMessage(error);
    const statusMatch = errorMessageText.match(/Error (\d+):/);
    const statusText = statusMatch?.[1];
    const statusCode = statusText ? parseInt(statusText, 10) : null;
    let errorMessage = defaultMessage;
    let actionableSteps = "";
    switch (statusCode) {
      case 400:
        errorMessage = "Bad Request - Invalid data sent to JIRA";
        if (context.includes("search") || context.includes("timer")) {
          actionableSteps = "The work item key or time format may be invalid. Verify the issue exists and use proper time format (e.g., 2h, 30m).";
        } else {
          actionableSteps = "Check your JQL query in Time Table settings (gear icon top right), ensure all field names are correct, and verify that referenced projects/issue types exist.";
        }
        break;
      case 401:
        errorMessage = "Authentication Failed - JIRA could not verify your identity";
        actionableSteps = "Your API token may be invalid or expired. Go to Settings and:\n1. Verify your username/email is correct\n2. Generate a new API token from your Atlassian account\n3. Ensure you're using an API token (not password) for Jira Cloud";
        break;
      case 403:
        errorMessage = "Access Denied - You don't have permission for this operation";
        actionableSteps = 'Your account lacks necessary permissions. Contact your JIRA administrator to:\n1. Grant you project access\n2. Enable worklog permissions\n3. Verify your account has "Browse Projects" and "Work On Issues" permissions';
        break;
      case 404:
        errorMessage = "Not Found - JIRA server or resource not found";
        if (context.includes("search") || context.includes("timer")) {
          actionableSteps = "Check that:\n1. The work item key exists and is accessible to you\n2. Your Base URL in Settings is correct\n3. The JIRA instance is accessible";
        } else {
          actionableSteps = "Check your Base URL in Settings:\n1. Ensure URL is correct (e.g., company.atlassian.net for Cloud)\n2. Remove any trailing slashes\n3. Verify the JIRA instance is accessible";
        }
        break;
      case 500:
        errorMessage = "JIRA Server Error - Internal server problem";
        actionableSteps = "This is a JIRA server issue. Try again in a few minutes, or contact your JIRA administrator if the problem persists.";
        break;
      case 503:
        errorMessage = "JIRA Service Unavailable - Server is temporarily down";
        actionableSteps = "JIRA is temporarily unavailable. Wait a few minutes and try again.";
        break;
      default:
        if (errorMessageText.includes(
          "Basic authentication with passwords is deprecated"
        )) {
          errorMessage = "Password Authentication Deprecated";
          actionableSteps = "JIRA no longer accepts passwords. Go to Settings and:\n1. Use your email address as username\n2. Generate an API token from id.atlassian.com/manage/api-tokens\n3. Use the API token instead of your password";
        } else if (errorMessageText.includes("CORS") || errorMessageText.includes("fetch")) {
          errorMessage = "Connection Error - Cannot reach JIRA server";
          actionableSteps = "Network or CORS issue. Check:\n1. Your internet connection\n2. Base URL is correct in Settings\n3. JIRA server is accessible from your browser";
        } else if (errorMessageText.includes("Invalid JQL")) {
          errorMessage = "Invalid JQL Query";
          actionableSteps = "Your JQL query in Time Table settings (gear icon top right) contains errors. Verify the query works in JIRA's issue search before using it here.";
        } else if (errorMessageText.includes("Worklog must not be null")) {
          errorMessage = "Timer Error - No time recorded";
          actionableSteps = "Please start and stop the timer before trying to log time. Make sure the timer has recorded some time.";
        } else {
          const settingsRef = context.includes("search") || context.includes("timer") ? "Please check your configuration in the main popup Settings and try again." : "Please check your Settings configuration and try again. If the problem persists, contact your JIRA administrator.";
          actionableSteps = settingsRef;
        }
    }
    const fullMessage = actionableSteps ? `${errorMessage}

${actionableSteps}` : errorMessage;
    const displayError2 = globalThis.displayError;
    if (typeof displayError2 === "function") {
      displayError2(fullMessage);
    } else {
      console.error("Display Error Function Not Found:", fullMessage);
    }
  }
  var jiraErrorHandlerGlobal = globalThis;
  jiraErrorHandlerGlobal.JiraErrorHandler = { handleJiraError };

  // src/ts/shared/worklog-suggestions.ts
  var commonTerms = {
    // Development actions
    actions: [
      "implemented",
      "fixed",
      "debugged",
      "tested",
      "reviewed",
      "refactored",
      "optimized",
      "updated",
      "added",
      "removed",
      "modified",
      "improved",
      "integrated",
      "deployed",
      "created",
      "designed",
      "developed",
      "configured",
      "maintained",
      "monitored",
      "troubleshot",
      "resolved",
      "patched",
      "migrated",
      "validated",
      "verified"
    ],
    // Meeting types
    meetings: [
      "meeting",
      "discussion",
      "planning",
      "review",
      "standup",
      "retrospective",
      "sync",
      "workshop",
      "presentation",
      "demo",
      "training",
      "interview",
      "consultation",
      "brainstorming",
      "alignment",
      "kickoff",
      "handover",
      "onboarding"
    ],
    // Task types
    tasks: [
      "investigation",
      "analysis",
      "documentation",
      "research",
      "configuration",
      "setup",
      "maintenance",
      "optimization",
      "enhancement",
      "implementation",
      "integration",
      "testing",
      "deployment",
      "monitoring",
      "support",
      "coordination",
      "planning"
    ],
    // Status indicators
    status: [
      "in progress",
      "completed",
      "blocked",
      "waiting",
      "pending",
      "ongoing",
      "started",
      "finished",
      "reviewing",
      "testing",
      "deploying",
      "planning",
      "investigating",
      "debugging",
      "analyzing",
      "implementing"
    ],
    // Technical terms
    technical: [
      "bug",
      "feature",
      "api",
      "database",
      "server",
      "client",
      "interface",
      "backend",
      "frontend",
      "pipeline",
      "workflow",
      "service",
      "module",
      "component",
      "function",
      "class",
      "method",
      "endpoint",
      "repository"
    ],
    // Common work objects
    objects: [
      "code",
      "data",
      "tests",
      "docs",
      "review",
      "changes",
      "updates",
      "fixes",
      "improvements",
      "features",
      "requirements",
      "specifications",
      "documentation",
      "solution",
      "implementation",
      "architecture"
    ]
  };
  function isTextEntryElement(value) {
    return value instanceof HTMLInputElement || value instanceof HTMLTextAreaElement;
  }
  var WorklogSuggestions = class {
    commonTermsSet;
    maxLearnedWords;
    learnedWords;
    wordUsageCount;
    constructor() {
      this.commonTermsSet = new Set(Object.values(commonTerms).flat());
      this.maxLearnedWords = 500;
      this.learnedWords = /* @__PURE__ */ new Set();
      this.wordUsageCount = /* @__PURE__ */ new Map();
      this.loadLearnedWords();
    }
    loadLearnedWords() {
      try {
        const saved = localStorage.getItem("worklogLearnedWords");
        if (saved) {
          const data = JSON.parse(saved);
          this.learnedWords = new Set(data.words || []);
          this.wordUsageCount = new Map(data.usage || []);
        }
      } catch (error) {
        console.warn("Error loading learned words:", error);
        this.learnedWords = /* @__PURE__ */ new Set();
        this.wordUsageCount = /* @__PURE__ */ new Map();
      }
    }
    saveLearnedWords() {
      try {
        const data = {
          words: [...this.learnedWords],
          usage: [...this.wordUsageCount]
        };
        localStorage.setItem("worklogLearnedWords", JSON.stringify(data));
      } catch (error) {
        console.warn("Error saving learned words:", error);
      }
    }
    pruneLearnedWords() {
      if (this.learnedWords.size <= this.maxLearnedWords) return;
      const sortedWords = [...this.wordUsageCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, this.maxLearnedWords).map(([word]) => word);
      this.learnedWords = new Set(sortedWords);
      const newUsageCount = /* @__PURE__ */ new Map();
      sortedWords.forEach((word) => {
        newUsageCount.set(word, this.wordUsageCount.get(word));
      });
      this.wordUsageCount = newUsageCount;
    }
    learnFromText(text) {
      const words = text.toLowerCase().split(/\s+/).filter(
        (word) => word.length > 3 && // Ignore short words
        !word.match(/^\d+$/) && // Ignore numbers
        !this.commonTermsSet.has(word) && // Don't learn common terms
        word.match(/^[a-z]+$/i)
        // Only learn simple words
      );
      words.forEach((word) => {
        this.learnedWords.add(word);
        this.wordUsageCount.set(word, (this.wordUsageCount.get(word) || 0) + 1);
      });
      this.pruneLearnedWords();
      this.saveLearnedWords();
    }
    getSuggestions(partialWord) {
      if (!partialWord || partialWord.length < 2) return [];
      const searchTerm = partialWord.toLowerCase();
      const maxSuggestions = 5;
      const suggestions = /* @__PURE__ */ new Set();
      for (const category of Object.values(commonTerms)) {
        for (const term of category) {
          if (term.toLowerCase().startsWith(searchTerm)) {
            suggestions.add(term);
            if (suggestions.size >= maxSuggestions) {
              return [...suggestions];
            }
          }
        }
      }
      for (const word of this.learnedWords) {
        if (word.startsWith(searchTerm)) {
          suggestions.add(word);
          if (suggestions.size >= maxSuggestions) break;
        }
      }
      return [...suggestions];
    }
    recordUsage(word) {
      if (this.learnedWords.has(word)) {
        this.wordUsageCount.set(word, (this.wordUsageCount.get(word) || 0) + 1);
        this.saveLearnedWords();
      }
    }
  };
  var worklogSuggestions = new WorklogSuggestions();
  function initializeWorklogSuggestions2(input) {
    const inputElement = typeof input === "string" ? document.getElementById(input) : input;
    if (!isTextEntryElement(inputElement)) {
      console.error("Input element not found");
      return;
    }
    const entryInput = inputElement;
    const completionElement = document.createElement("div");
    completionElement.className = "suggestion-completion";
    completionElement.style.position = "absolute";
    completionElement.style.left = "0";
    completionElement.style.top = "0";
    completionElement.style.width = "100%";
    completionElement.style.height = "100%";
    completionElement.style.pointerEvents = "none";
    const computedStyle = window.getComputedStyle(inputElement);
    completionElement.style.padding = computedStyle.padding;
    completionElement.style.boxSizing = computedStyle.boxSizing;
    completionElement.style.fontSize = computedStyle.fontSize;
    completionElement.style.fontFamily = computedStyle.fontFamily;
    completionElement.style.lineHeight = computedStyle.lineHeight;
    completionElement.style.letterSpacing = computedStyle.letterSpacing;
    completionElement.style.wordSpacing = computedStyle.wordSpacing;
    completionElement.style.background = "transparent";
    completionElement.style.border = "1px solid transparent";
    completionElement.style.zIndex = "0";
    completionElement.style.visibility = "hidden";
    completionElement.style.resize = "none";
    completionElement.style.whiteSpace = "pre-wrap";
    completionElement.style.overflow = "hidden";
    completionElement.style.margin = "0";
    const isDarkMode = document.body.classList.contains("dark-mode");
    completionElement.style.color = isDarkMode ? "rgba(138, 180, 255, 0.85)" : "rgba(0, 0, 0, 0.35)";
    entryInput.parentNode?.insertBefore(completionElement, entryInput);
    let originalValue = "";
    let suggestionActive = false;
    function updateSuggestionColor() {
      const isDarkMode2 = document.body.classList.contains("dark-mode");
      completionElement.style.color = isDarkMode2 ? "rgba(138, 180, 255, 0.85)" : "rgba(0, 0, 0, 0.35)";
    }
    function updateSuggestions() {
      updateSuggestionColor();
      const cursorPos = entryInput.selectionStart;
      const text = entryInput.value;
      if (cursorPos !== text.length) {
        suggestionActive = false;
        completionElement.textContent = "";
        completionElement.style.visibility = "hidden";
        return;
      }
      const words = text.split(/\s+/);
      const currentWord = words[words.length - 1] || "";
      if (!currentWord || currentWord.length < 2) {
        suggestionActive = false;
        completionElement.textContent = "";
        completionElement.style.visibility = "hidden";
        return;
      }
      const suggestions = worklogSuggestions.getSuggestions(currentWord);
      if (suggestions.length > 0) {
        const suggestion = suggestions[0];
        if (suggestion && suggestion.toLowerCase().startsWith(currentWord.toLowerCase())) {
          const completion = suggestion.slice(currentWord.length);
          if (completion) {
            originalValue = text;
            const prefix = text.slice(0, text.length - currentWord.length);
            const fullSuggestion = prefix + currentWord + completion;
            completionElement.textContent = fullSuggestion;
            completionElement.style.visibility = completion ? "visible" : "hidden";
            suggestionActive = true;
            return;
          }
        }
      }
      completionElement.innerHTML = "";
      completionElement.style.visibility = "hidden";
      suggestionActive = false;
    }
    entryInput.addEventListener("keydown", (event) => {
      const e = event;
      if (suggestionActive) {
        if (e.key === "Tab") {
          e.preventDefault();
          entryInput.value = completionElement.textContent || "";
          suggestionActive = false;
          completionElement.innerHTML = "";
          completionElement.style.visibility = "hidden";
          const length = entryInput.value.length;
          entryInput.setSelectionRange(length, length);
        } else if (e.key === "Escape") {
          e.preventDefault();
          entryInput.value = originalValue;
          suggestionActive = false;
          completionElement.innerHTML = "";
          completionElement.style.visibility = "hidden";
        } else if (e.key === "Backspace") {
          entryInput.value = originalValue;
          suggestionActive = false;
          completionElement.innerHTML = "";
          completionElement.style.visibility = "hidden";
        } else {
          suggestionActive = false;
          completionElement.innerHTML = "";
          completionElement.style.visibility = "hidden";
        }
      }
    });
    entryInput.addEventListener("input", () => {
      if (!suggestionActive) {
        updateSuggestions();
      }
    });
    entryInput.addEventListener("blur", () => {
      if (suggestionActive) {
        entryInput.value = originalValue;
        suggestionActive = false;
        completionElement.innerHTML = "";
        completionElement.style.visibility = "hidden";
      }
      if (entryInput.value) {
        worklogSuggestions.learnFromText(entryInput.value);
      }
    });
    completionElement.style.visibility = "hidden";
  }
  var worklogSuggestionsGlobal = globalThis;
  worklogSuggestionsGlobal.worklogSuggestions = worklogSuggestions;
  worklogSuggestionsGlobal.initializeWorklogSuggestions = initializeWorklogSuggestions2;

  // src/ts/popup.ts
  var COLUMN_DEFS = {
    issueId: { label: "Jira ID", baseWidth: 14, locked: "first", hasLogo: true },
    summary: { label: "Summary", baseWidth: 25 },
    status: { label: "Status", baseWidth: 10, optional: true },
    assignee: { label: "Assignee", baseWidth: 10, optional: true },
    total: { label: "Total", baseWidth: 8, optional: true },
    log: { label: "Log", baseWidth: 7 },
    comment: { label: "Comment", baseWidth: 15, optional: true },
    date: { label: "Date", baseWidth: 10 },
    actions: { label: "", baseWidth: 3, locked: "last" }
  };
  var DEFAULT_COLUMN_ORDER = [
    "issueId",
    "summary",
    "total",
    "log",
    "comment",
    "date",
    "actions"
  ];
  var DEFAULT_JQL = "(assignee=currentUser() OR worklogAuthor=currentUser()) AND status NOT IN (Closed, Done)";
  var DEFAULT_TIME_TABLE_COLUMNS = {
    showStatus: false,
    showAssignee: false,
    showTotal: true,
    showComment: true
  };
  function isColumnId(id) {
    return Object.prototype.hasOwnProperty.call(COLUMN_DEFS, id);
  }
  function isOptionalColumn(colId) {
    const def = COLUMN_DEFS[colId];
    return "optional" in def && def.optional === true;
  }
  function visibilityKey(colId) {
    return "show" + colId.charAt(0).toUpperCase() + colId.slice(1);
  }
  function getVisibleColumns(columnOrder, colSettings) {
    return columnOrder.filter((colId) => {
      if (!isColumnId(colId)) return false;
      if (!isOptionalColumn(colId)) return true;
      return !!colSettings[visibilityKey(colId)];
    });
  }
  function getColumnWidths(visibleColumns) {
    const totalBase = visibleColumns.reduce(
      (sum, id) => sum + COLUMN_DEFS[id].baseWidth,
      0
    );
    const widths = {};
    visibleColumns.forEach((id) => {
      widths[id] = (COLUMN_DEFS[id].baseWidth / totalBase * 100).toFixed(1) + "%";
    });
    return widths;
  }
  function normalizeColumnOrder(stored) {
    const allIds = Object.keys(COLUMN_DEFS);
    if (!Array.isArray(stored) || stored.length === 0) {
      return [...DEFAULT_COLUMN_ORDER];
    }
    const result = stored.filter(
      (id) => isColumnId(id)
    );
    allIds.forEach((id) => {
      if (!result.includes(id)) result.splice(result.length - 1, 0, id);
    });
    const withoutLocked = result.filter(
      (id) => id !== "issueId" && id !== "actions"
    );
    return ["issueId", ...withoutLocked, "actions"];
  }
  document.addEventListener("DOMContentLoaded", function() {
    const themeToggle = document.getElementById("themeToggle");
    if (!themeToggle) return;
    function applyTheme(followSystem, manualDark) {
      if (followSystem) {
        const mql = window.matchMedia("(prefers-color-scheme: dark)");
        setTheme(mql.matches);
        mql.onchange = (e) => setTheme(e.matches);
        window._systemThemeListener = mql;
      } else {
        if (window._systemThemeListener) {
          window._systemThemeListener.onchange = null;
          window._systemThemeListener = null;
        }
        setTheme(manualDark);
      }
    }
    function setTheme(isDark) {
      updateThemeButton(isDark);
      if (isDark) {
        document.body.classList.add("dark-mode");
      } else {
        document.body.classList.remove("dark-mode");
      }
    }
    chrome.storage.sync.get(["followSystemTheme", "darkMode"], function(result) {
      const followSystem = result.followSystemTheme !== false;
      const manualDark = result.darkMode === true;
      applyTheme(followSystem, manualDark);
    });
    themeToggle.addEventListener("click", function() {
      const isDark = !document.body.classList.contains("dark-mode");
      updateThemeButton(isDark);
      setTheme(isDark);
      chrome.storage.sync.set({ darkMode: isDark, followSystemTheme: false });
    });
    chrome.storage.onChanged.addListener(function(changes, namespace) {
      if (namespace === "sync" && ("followSystemTheme" in changes || "darkMode" in changes)) {
        chrome.storage.sync.get(
          ["followSystemTheme", "darkMode"],
          function(result) {
            const followSystem = result.followSystemTheme !== false;
            const manualDark = result.darkMode === true;
            applyTheme(followSystem, manualDark);
          }
        );
      }
    });
  });
  function updateThemeButton(isDark) {
    const themeToggle = document.getElementById("themeToggle");
    const iconSpan = themeToggle?.querySelector(".icon");
    if (!themeToggle || !iconSpan) return;
    if (isDark) {
      iconSpan.textContent = "☀️";
      themeToggle.title = "Switch to light mode";
    } else {
      iconSpan.textContent = "🌙";
      themeToggle.title = "Switch to dark mode";
    }
  }
  document.addEventListener("DOMContentLoaded", onDOMContentLoaded);
  async function onDOMContentLoaded() {
    chrome.storage.sync.get(
      {
        apiToken: "",
        baseUrl: "",
        jql: DEFAULT_JQL,
        username: "",
        jiraType: "server",
        frequentWorklogDescription1: "",
        frequentWorklogDescription2: "",
        starredIssues: {},
        defaultPage: "popup.html",
        darkMode: false,
        experimentalFeatures: false,
        timeTableColumns: DEFAULT_TIME_TABLE_COLUMNS,
        timeTableColumnOrder: DEFAULT_COLUMN_ORDER
      },
      async (storedOptions) => {
        const options = storedOptions;
        options.timeTableColumns = Object.assign(
          {},
          DEFAULT_TIME_TABLE_COLUMNS,
          options.timeTableColumns
        );
        options.timeTableColumnOrder = normalizeColumnOrder(
          options.timeTableColumnOrder
        );
        const urlParams = new URLSearchParams(window.location.search);
        const isNavigatingBack = urlParams.get("source") === "navigation";
        const currentPage = window.location.pathname.split("/").pop() || "";
        if (currentPage !== options.defaultPage && !isNavigatingBack) {
          window.location.href = options.defaultPage;
          return;
        }
        options.starredIssues = filterExpiredStars(options.starredIssues, 90);
        chrome.storage.sync.set(
          { starredIssues: options.starredIssues },
          () => {
          }
        );
        window._ttOptions = options;
        initGearPanel(options);
        await init(options);
        insertFrequentWorklogDescription(options);
      }
    );
  }
  function filterExpiredStars(starredIssues, days) {
    const now = Date.now();
    const cutoff = days * 24 * 60 * 60 * 1e3;
    const filtered = {};
    for (const issueId in starredIssues) {
      if (Object.prototype.hasOwnProperty.call(starredIssues, issueId)) {
        if (now - starredIssues[issueId] < cutoff) {
          filtered[issueId] = starredIssues[issueId];
        }
      }
    }
    return filtered;
  }
  function syncGearPanelState(options) {
    const jqlTextarea = document.getElementById(
      "gear-jql"
    );
    if (jqlTextarea) jqlTextarea.value = options.jql || DEFAULT_JQL;
    renderGearColumnOrder(
      options.timeTableColumnOrder.filter(isColumnId),
      options.timeTableColumns
    );
  }
  function openGearModal(options = window._ttOptions) {
    if (options) syncGearPanelState(options);
    const backdrop = document.getElementById(
      "gear-modal-backdrop"
    );
    backdrop.style.display = "flex";
    const btn = document.getElementById("gearBtn");
    if (btn) btn.setAttribute("aria-expanded", "true");
  }
  function closeGearModal() {
    const backdrop = document.getElementById(
      "gear-modal-backdrop"
    );
    backdrop.style.display = "none";
    const btn = document.getElementById("gearBtn");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }
  function initGearPanel(options) {
    if (window._gearPanelInitialized) return;
    window._gearPanelInitialized = true;
    const backdrop = document.getElementById(
      "gear-modal-backdrop"
    );
    const closeBtn = document.getElementById(
      "gear-modal-close"
    );
    const saveBtn = document.getElementById("gear-save-btn");
    const jqlTextarea = document.getElementById(
      "gear-jql"
    );
    syncGearPanelState(options);
    closeBtn.addEventListener("click", closeGearModal);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeGearModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && backdrop.style.display !== "none")
        closeGearModal();
    });
    saveBtn.addEventListener("click", async () => {
      const newJql = jqlTextarea.value.trim() || DEFAULT_JQL;
      const newCols = readGearColumnVisibility();
      const newOrder = readGearColumnOrder();
      const jqlChanged = newJql !== options.jql;
      options.jql = newJql;
      options.timeTableColumns = newCols;
      options.timeTableColumnOrder = newOrder;
      chrome.storage.sync.set({
        jql: newJql,
        timeTableColumns: newCols,
        timeTableColumnOrder: newOrder
      });
      closeGearModal();
      if (jqlChanged) {
        try {
          const JIRA = await getSharedJira(options);
          const issuesResponse = await JIRA.getIssues(0, options.jql);
          const cacheKey = getIssuesCacheKey(options);
          chrome.storage.local.set({
            [cacheKey]: { data: issuesResponse, ts: Date.now() }
          });
          onFetchSuccess(issuesResponse, options);
        } catch (err) {
          await handleTimeTableFetchError(
            err,
            options,
            "Failed to fetch issues with new JQL"
          );
        }
      } else {
        redrawCurrentTable(options);
      }
      insertFrequentWorklogDescription(options);
    });
  }
  function redrawCurrentTable(options) {
    const cacheKey = getIssuesCacheKey(options);
    chrome.storage.local.get([cacheKey], (items) => {
      const cached = items[cacheKey];
      if (cached && cached.data) {
        onFetchSuccess(cached.data, options);
        insertFrequentWorklogDescription(options);
      }
    });
  }
  function renderGearColumnOrder(order, colSettings) {
    const ul = document.getElementById("gear-column-order");
    if (!ul) return;
    ul.innerHTML = "";
    const reorderable = order.filter(
      (id) => id !== "issueId" && id !== "actions" && COLUMN_DEFS[id]
    );
    reorderable.forEach((colId) => {
      const def = COLUMN_DEFS[colId];
      const li = document.createElement("li");
      li.setAttribute("draggable", "true");
      li.setAttribute("data-col-id", colId);
      if (isOptionalColumn(colId)) {
        const checked = isColumnEnabled(colId, colSettings);
        li.innerHTML = `<span class="drag-handle">&#x2630;</span><label><input type="checkbox" data-col-toggle="${colId}" ${checked ? "checked" : ""}> ${def.label}</label>`;
        if (!checked) li.classList.add("col-disabled");
        li.querySelector("input")?.addEventListener(
          "change",
          (e) => {
            li.classList.toggle(
              "col-disabled",
              !e.target.checked
            );
          }
        );
      } else {
        li.classList.add("col-always");
        li.innerHTML = `<span class="drag-handle">&#x2630;</span> ${def.label}`;
      }
      ul.appendChild(li);
    });
    initDragAndDrop(ul);
  }
  function isColumnEnabled(colId, colSettings) {
    if (!colSettings) return !isOptionalColumn(colId);
    if (!isOptionalColumn(colId)) return true;
    return !!colSettings[visibilityKey(colId)];
  }
  function initDragAndDrop(ul) {
    if (ul.dataset.dragAndDropInitialized === "true") return;
    ul.dataset.dragAndDropInitialized = "true";
    let draggedItem = null;
    ul.addEventListener("dragstart", (e) => {
      const li = e.target instanceof Element ? e.target.closest("li") : null;
      draggedItem = li;
      if (draggedItem) draggedItem.classList.add("dragging");
    });
    ul.addEventListener("dragend", () => {
      if (draggedItem) draggedItem.classList.remove("dragging");
      ul.querySelectorAll("li").forEach((li) => li.classList.remove("drag-over"));
      draggedItem = null;
    });
    ul.addEventListener("dragover", (e) => {
      e.preventDefault();
      const target = e.target instanceof Element ? e.target.closest("li") : null;
      if (!target || target === draggedItem) return;
      ul.querySelectorAll("li").forEach((li) => li.classList.remove("drag-over"));
      target.classList.add("drag-over");
    });
    ul.addEventListener("drop", (e) => {
      e.preventDefault();
      const target = e.target instanceof Element ? e.target.closest("li") : null;
      if (!target || target === draggedItem || !draggedItem) return;
      const items = Array.from(ul.querySelectorAll("li"));
      const dragIdx = items.indexOf(draggedItem);
      const dropIdx = items.indexOf(target);
      if (dragIdx < dropIdx) {
        target.after(draggedItem);
      } else {
        target.before(draggedItem);
      }
      ul.querySelectorAll("li").forEach((li) => li.classList.remove("drag-over"));
    });
  }
  function readGearColumnOrder() {
    const lis = document.querySelectorAll("#gear-column-order li");
    const middle = Array.from(lis, (li) => li.getAttribute("data-col-id")).filter(
      (id) => id != null && isColumnId(id)
    );
    return ["issueId", ...middle, "actions"];
  }
  function readGearColumnVisibility() {
    const toggles = document.querySelectorAll(
      "#gear-column-order input[data-col-toggle]"
    );
    const cols = {};
    toggles.forEach((cb) => {
      const id = cb.getAttribute("data-col-toggle");
      if (!id || !isColumnId(id)) return;
      cols[visibilityKey(id)] = cb.checked;
    });
    return Object.assign(
      {},
      DEFAULT_TIME_TABLE_COLUMNS,
      cols
    );
  }
  function escapeHTML(str) {
    const el = document.createElement("span");
    el.textContent = str;
    return el.innerHTML;
  }
  function buildHTML(tag, html, attrs) {
    const element = document.createElement(tag);
    if (html) element.innerHTML = html;
    Object.keys(attrs || {}).forEach((attr) => {
      element.setAttribute(attr, attrs[attr]);
    });
    return element;
  }
  async function getSharedJira(options) {
    const jiraConfig = {
      jiraType: options.jiraType,
      baseUrl: options.baseUrl,
      username: options.username,
      apiToken: options.apiToken
    };
    const configKey = JSON.stringify(jiraConfig);
    if (window._ttJiraConfigKey !== configKey || !window._ttJiraPromise) {
      window._ttJiraConfigKey = configKey;
      window._ttJiraPromise = JiraAPI(
        jiraConfig.jiraType,
        jiraConfig.baseUrl,
        jiraConfig.username,
        jiraConfig.apiToken
      );
    }
    return window._ttJiraPromise;
  }
  function getJiraErrorStatusCode(error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusMatch = message.match(/Error (\d+):/);
    return statusMatch ? parseInt(statusMatch[1], 10) : null;
  }
  function isJiraAuthError(error) {
    const statusCode = getJiraErrorStatusCode(error);
    return statusCode === 401 || statusCode === 403;
  }
  function getIssuesCacheKey(options) {
    return `issuesCache:${options.baseUrl}:${options.jql}`;
  }
  function removeTimeTableCacheEntries(baseUrl) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(null, (items) => {
          const prefix = baseUrl ? `issuesCache:${baseUrl}:` : "issuesCache:";
          const keys = Object.keys(items || {}).filter(
            (key) => key.startsWith(prefix)
          );
          if (keys.length === 0) {
            resolve();
            return;
          }
          chrome.storage.local.remove(keys, () => resolve());
        });
      } catch {
        resolve();
      }
    });
  }
  function clearTimeTableRows(options) {
    clearMessages();
    drawIssuesTable({ data: [], total: 0 }, options);
  }
  async function clearCachedTimeTableData(options) {
    await removeTimeTableCacheEntries(options.baseUrl);
    clearTimeTableRows(options);
  }
  function shouldShowPopupFetchError(error, showedCached) {
    if (!showedCached) return true;
    if (isJiraAuthError(error)) {
      return true;
    }
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return message.includes("fetch") || message.includes("network") || message.includes("cors");
  }
  async function handleTimeTableFetchError(error, options, defaultMessage, showedCached = false) {
    if (isJiraAuthError(error)) {
      await clearCachedTimeTableData(options);
    }
    if (shouldShowPopupFetchError(error, showedCached)) {
      window.JiraErrorHandler?.handleJiraError(error, defaultMessage, "popup");
    }
  }
  async function init(options) {
    console.log("Options received:", options);
    try {
      const JIRA = await getSharedJira(options);
      console.log("JIRA API Object:", JIRA);
      if (!JIRA || typeof JIRA.getIssues !== "function") {
        console.error("JIRA API instantiation failed: Methods missing", JIRA);
        displayError(
          "JIRA API setup failed. Please check your settings and ensure all required fields (Base URL, Username, API Token) are correctly configured. Go to Settings to verify your configuration."
        );
        return;
      }
      const cacheKey = getIssuesCacheKey(options);
      let showedCached = false;
      try {
        const cached = await new Promise(
          (resolve) => {
            chrome.storage.local.get(
              [cacheKey],
              (items) => resolve(items[cacheKey])
            );
          }
        );
        if (cached && cached.data && Date.now() - cached.ts < 5 * 60 * 1e3) {
          console.log("Showing cached issues");
          onFetchSuccess(cached.data, options);
          showedCached = true;
        }
      } catch (e) {
        console.warn("Cache read failed", e);
      }
      if (!showedCached) {
        toggleVisibility("div[id=loader-container]");
      }
      try {
        const issuesResponse = await JIRA.getIssues(0, options.jql);
        try {
          chrome.storage.local.set({
            [cacheKey]: { data: issuesResponse, ts: Date.now() }
          });
        } catch (e) {
          console.warn("Cache write failed", e);
        }
        onFetchSuccess(issuesResponse, options);
      } catch (error) {
        console.error("Error fetching issues:", error);
        await handleTimeTableFetchError(
          error,
          options,
          "Failed to fetch issues from JIRA",
          showedCached
        );
      } finally {
        if (!showedCached) {
          toggleVisibility("div[id=loader-container]");
        }
      }
    } catch (error) {
      console.error("Error initializing JIRA API:", error);
      window.JiraErrorHandler?.handleJiraError(
        error,
        "Failed to connect to JIRA",
        "popup"
      );
    }
  }
  function onFetchSuccess(issuesResponse, options) {
    clearMessages();
    console.log("Fetched issues:", issuesResponse);
    drawIssuesTable(issuesResponse, options);
  }
  function getWorklog(issueId, JIRA) {
    const totalTime = document.querySelector(
      `div.issue-total-time-spent[data-issue-id="${issueId}"]`
    );
    if (!totalTime) return;
    const loader = totalTime.previousElementSibling;
    if (loader) loader.style.display = "block";
    totalTime.style.display = "none";
    JIRA.getIssueWorklog(issueId).then((response) => onWorklogFetchSuccess(response, totalTime, loader)).catch((error) => onWorklogFetchError(error, totalTime, loader));
  }
  function sumWorklogs(worklogs) {
    if (!Array.isArray(worklogs)) return "0 hrs";
    const totalSeconds = worklogs.reduce(
      (total, log) => total + log.timeSpentSeconds,
      0
    );
    const totalHours = (totalSeconds / 3600).toFixed(1);
    return `${totalHours} hrs`;
  }
  function onWorklogFetchSuccess(response, totalTime, loader) {
    try {
      totalTime.innerText = sumWorklogs(response.worklogs);
    } catch (error) {
      const stack = error instanceof Error ? error.stack : void 0;
      console.error(
        `Error in summing worklogs: ${stack ?? getErrorMessage(error)}`
      );
      totalTime.innerText = "0 hrs";
    }
    if (totalTime) totalTime.style.display = "block";
    if (loader) loader.style.display = "none";
    document.querySelectorAll(
      "input.issue-time-input, input.issue-comment-input"
    ).forEach((input) => input.value = "");
  }
  function onWorklogFetchError(error, totalTime, loader) {
    if (totalTime) totalTime.style.display = "block";
    if (loader) loader.style.display = "none";
    window.JiraErrorHandler?.handleJiraError(
      error,
      "Failed to fetch worklog data",
      "popup"
    );
  }
  async function logTimeClick(evt) {
    clearMessages();
    const issueId = evt.target?.getAttribute(
      "data-issue-id"
    );
    const timeInput = document.querySelector(
      `input.issue-time-input[data-issue-id="${issueId}"]`
    );
    const dateInput = document.querySelector(
      `input.issue-log-date-input[data-issue-id="${issueId}"]`
    );
    const commentInput = document.querySelector(
      `input.issue-comment-input[data-issue-id="${issueId}"]`
    );
    const totalTimeSpans = document.querySelector(
      `div.issue-total-time-spent[data-issue-id="${issueId}"]`
    );
    const loader = document.querySelector(
      `div.loader-mini[data-issue-id="${issueId}"]`
    );
    if (!issueId || !dateInput) {
      return;
    }
    console.log(`Processing issue ID: ${issueId}`);
    if (!timeInput || !timeInput.value) {
      displayError(
        "Time field is required. Please enter the time you want to log (e.g., 2h, 30m, 1d)."
      );
      return;
    }
    const timeMatches = timeInput.value.match(/[0-9]{1,4}[dhm]/g);
    if (!timeMatches) {
      displayError(
        'Invalid time format. Please use:\n• Hours: 2h, 1.5h\n• Minutes: 30m, 45m\n• Days: 1d, 0.5d\n\nExamples: "2h 30m", "1d", "45m"'
      );
      return;
    }
    const timeSpentSeconds = convertTimeToSeconds(timeInput.value);
    if (isNaN(timeSpentSeconds) || timeSpentSeconds <= 0) {
      displayError(
        "Invalid time value. Please enter a positive time amount using valid units (d=days, h=hours, m=minutes)."
      );
      return;
    }
    if (totalTimeSpans && loader) {
      totalTimeSpans.innerText = "";
      totalTimeSpans.style.display = "none";
      loader.style.display = "block";
    }
    const startedTime = getStartedTime(dateInput.value);
    try {
      const options = await new Promise(
        (resolve, reject) => chrome.storage.sync.get(
          ["baseUrl", "apiToken", "jql", "username", "jiraType"],
          (items) => {
            if (chrome.runtime.lastError) {
              return reject(chrome.runtime.lastError);
            }
            resolve(items);
          }
        )
      );
      const JIRA = await getSharedJira(options);
      const commentValue = commentInput ? commentInput.value : "";
      console.log(
        `Update worklog details: issueId=${issueId}, timeSpentSeconds=${timeSpentSeconds}, startedTime=${startedTime}, comment=${commentValue}`
      );
      const result = await JIRA.updateWorklog(
        issueId,
        timeSpentSeconds,
        startedTime,
        commentValue
      );
      console.log("Worklog successfully updated:", result);
      showSuccessAnimation(issueId, timeInput.value);
      timeInput.value = "";
      if (commentInput) commentInput.value = "";
      getWorklog(issueId, JIRA);
    } catch (error) {
      console.error(`Error in logTimeClick function: ${getErrorMessage(error)}`);
      if (totalTimeSpans) totalTimeSpans.style.display = "block";
      if (loader) loader.style.display = "none";
      if (error?.status === 200) {
        displaySuccess(
          "Successfully logged: " + timeInput.value + " but encountered an issue afterward."
        );
        showErrorAnimation(issueId);
      } else {
        window.JiraErrorHandler?.handleJiraError(
          error,
          `Failed to log time for issue ${issueId}`,
          "popup"
        );
        showErrorAnimation(issueId);
      }
    }
  }
  function convertTimeToSeconds(timeStr) {
    const timeUnits = {
      d: 60 * 60 * 24,
      h: 60 * 60,
      m: 60,
      w: 60 * 60 * 24 * 5
    };
    const regex = /(\d+)([wdhm])/g;
    let match;
    let totalSeconds = 0;
    while ((match = regex.exec(timeStr)) !== null) {
      const value = parseInt(match[1], 10);
      const unit = match[2];
      const mult = timeUnits[unit];
      if (mult != null) totalSeconds += value * mult;
    }
    return totalSeconds;
  }
  function toggleVisibility(query) {
    const element = document.querySelector(query);
    if (element) {
      element.style.display = element.style.display === "none" || element.style.display === "" ? "block" : "none";
    } else {
      console.warn(`Element not found for query: ${query}`);
    }
  }
  function drawIssuesTable(issuesResponse, options) {
    const logTable = document.getElementById("jira-log-time-table");
    if (!logTable) return;
    const visibleCols = getVisibleColumns(
      options.timeTableColumnOrder,
      options.timeTableColumns
    );
    const widths = getColumnWidths(visibleCols);
    const theadTr = logTable.querySelector("thead tr");
    if (!theadTr) return;
    theadTr.innerHTML = "";
    visibleCols.forEach((colId) => {
      const def = COLUMN_DEFS[colId];
      const th = document.createElement("th");
      th.setAttribute("data-col", colId);
      th.style.width = widths[colId];
      if (colId === "issueId") {
        th.innerHTML = `<img src="${chrome.runtime.getURL("src/icons/jira_logo.png")}" alt="Jira Logo" style="vertical-align:middle;margin-right:8px;width:16px;height:16px;"> Jira ID`;
      } else if (colId === "actions") {
        const gearBtn = document.createElement("button");
        gearBtn.id = "gearBtn";
        gearBtn.title = "Time Table settings";
        gearBtn.setAttribute("aria-expanded", "false");
        gearBtn.setAttribute("aria-controls", "gear-modal-backdrop");
        gearBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5.5a.5.5 0 0 0-.5.5v1.07a5.5 5.5 0 0 0-1.56.64L3.7 1.97a.5.5 0 0 0-.7 0l-.71.7a.5.5 0 0 0 0 .71l.74.74A5.5 5.5 0 0 0 2.4 5.7H1.3a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h1.1a5.5 5.5 0 0 0 .63 1.58l-.74.74a.5.5 0 0 0 0 .7l.71.71a.5.5 0 0 0 .7 0l.74-.74a5.5 5.5 0 0 0 1.56.64V12.5a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-1.07a5.5 5.5 0 0 0 1.56-.64l.74.74a.5.5 0 0 0 .7 0l.71-.7a.5.5 0 0 0 0-.71l-.74-.74A5.5 5.5 0 0 0 11.6 7.7h1.1a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5h-1.1a5.5 5.5 0 0 0-.63-1.58l.74-.74a.5.5 0 0 0 0-.7l-.71-.71a.5.5 0 0 0-.7 0l-.74.74A5.5 5.5 0 0 0 8 2.07V1a.5.5 0 0 0-.5-.5h-1zM7 4.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z"/></svg>';
        gearBtn.addEventListener("click", () => openGearModal());
        th.appendChild(gearBtn);
      } else {
        th.textContent = def.label;
      }
      theadTr.appendChild(th);
    });
    const oldTbody = logTable.querySelector("tbody");
    if (oldTbody) oldTbody.remove();
    const newTbody = document.createElement("tbody");
    const issues = issuesResponse.data || [];
    const sortedIssues = sortByStar(issues, options.starredIssues);
    sortedIssues.forEach((issue) => {
      const row = generateLogTableRow(issue, options, visibleCols);
      newTbody.appendChild(row);
    });
    logTable.appendChild(newTbody);
    document.querySelectorAll(".issue-comment-input").forEach((input) => {
      input.style.position = "relative";
      input.style.zIndex = "1";
      initializeWorklogSuggestions(input);
    });
  }
  function sortByStar(issues, starredIssues) {
    return issues.slice().sort((a, b) => {
      const aStar = starredIssues[a.key] ? 1 : 0;
      const bStar = starredIssues[b.key] ? 1 : 0;
      return bStar - aStar;
    });
  }
  var cellBuilders = {
    issueId(issue, options) {
      const id = issue.key;
      const td = buildHTML("td", "", {
        class: "issue-id",
        "data-col": "issueId",
        "data-issue-id": id
      });
      const isStarred = !!options.starredIssues[id];
      const starIcon = buildHTML("span", "", { class: "star-icon" });
      starIcon.textContent = isStarred ? "★" : "☆";
      starIcon.classList.add(isStarred ? "starred" : "unstarred");
      starIcon.addEventListener("click", () => toggleStar(id, options));
      td.appendChild(starIcon);
      td.appendChild(document.createTextNode(" "));
      const baseUrl = options.baseUrl.startsWith("http") ? options.baseUrl : `https://${options.baseUrl}`;
      const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
      const jiraLink = buildHTML("a", id, {
        href: `${normalizedBaseUrl}browse/${id}`,
        target: "_blank",
        "data-issue-id": id
      });
      let tooltipTimeout;
      jiraLink.addEventListener("mouseover", async (e) => {
        if (tooltipTimeout) {
          clearTimeout(tooltipTimeout);
          tooltipTimeout = void 0;
        }
        const existingTooltip = document.querySelector(".worklog-tooltip");
        if (existingTooltip) existingTooltip.remove();
        const tooltip = document.createElement("div");
        tooltip.className = "worklog-tooltip";
        tooltip.innerHTML = "Loading worklogs...";
        const rect = e.currentTarget.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        tooltip.style.left = `${Math.max(10, Math.min(rect.left, window.innerWidth - 370))}px`;
        tooltip.style.top = spaceBelow >= 150 || spaceBelow >= rect.top ? `${rect.bottom + 5}px` : `${rect.top - 155}px`;
        document.body.appendChild(tooltip);
        try {
          const JIRA = await getSharedJira(options);
          const worklogResponse = await JIRA.getIssueWorklog(id);
          const recentLogs = worklogResponse.worklogs.slice(-5).reverse().map((log) => {
            const date = log.started ? new Date(log.started).toLocaleDateString() : "";
            const hours = (log.timeSpentSeconds / 3600).toFixed(1);
            const comment = typeof log.comment === "string" ? log.comment : log.comment?.content?.[0]?.content?.[0]?.text || "No comment";
            const author = log.author?.displayName || log.author?.name || "Unknown user";
            return `<div style="margin-bottom:4px;"><strong>${escapeHTML(date)}</strong> - ${escapeHTML(author)}<br>${escapeHTML(hours)}h - ${escapeHTML(comment)}</div>`;
          }).join("");
          tooltip.innerHTML = recentLogs || "No recent worklogs";
        } catch {
          tooltip.innerHTML = "Error loading worklogs";
        }
      });
      jiraLink.addEventListener("mouseout", () => {
        tooltipTimeout = setTimeout(() => {
          const t = document.querySelector(".worklog-tooltip");
          if (t) t.remove();
        }, 150);
      });
      td.appendChild(jiraLink);
      return td;
    },
    summary(issue, _options) {
      const td = buildHTML("td", null, {
        class: "issue-summary truncate",
        "data-col": "summary"
      });
      td.textContent = issue.fields.summary ?? "";
      return td;
    },
    status(issue, options) {
      const td = buildHTML("td", null, { "data-col": "status" });
      const statusName = issue.fields.status?.name || "Unknown";
      const select = document.createElement("select");
      select.className = "status-select";
      select.setAttribute("data-issue-id", issue.key);
      const currentOpt = document.createElement("option");
      currentOpt.value = "";
      currentOpt.textContent = statusName;
      currentOpt.selected = true;
      select.appendChild(currentOpt);
      loadTransitions(issue.key, select, statusName, options);
      td.appendChild(select);
      return td;
    },
    assignee(issue, options) {
      const td = buildHTML("td", null, { "data-col": "assignee" });
      const container = document.createElement("div");
      container.className = "assignee-container";
      const assigneeName = issue.fields.assignee?.displayName || "Unassigned";
      const input = document.createElement("input");
      input.className = "assignee-input";
      input.value = assigneeName;
      input.setAttribute("data-issue-id", issue.key);
      input.setAttribute("data-current-assignee", assigneeName);
      const dropdown = document.createElement("ul");
      dropdown.className = "assignee-dropdown";
      dropdown.style.display = "none";
      let debounceTimer;
      input.addEventListener("focus", () => input.select());
      input.addEventListener("input", () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          const query = input.value.trim();
          if (!query) {
            dropdown.style.display = "none";
            return;
          }
          try {
            const JIRA = await getSharedJira(options);
            const users = await JIRA.searchAssignableUsers(issue.key, query, 5);
            dropdown.innerHTML = "";
            if (users.length === 0) {
              dropdown.style.display = "none";
              return;
            }
            users.forEach((user) => {
              const li = document.createElement("li");
              const displayName = user.displayName ?? user.name ?? "Unknown";
              li.textContent = displayName;
              li.addEventListener("mousedown", async (e) => {
                e.preventDefault();
                try {
                  const J = await getSharedJira(options);
                  const assigneeField = options.jiraType === "cloud" ? { accountId: user.accountId ?? "" } : { name: user.name ?? "" };
                  await J.updateIssue(issue.key, { assignee: assigneeField });
                  input.value = displayName;
                  input.setAttribute("data-current-assignee", displayName);
                  dropdown.style.display = "none";
                } catch (err) {
                  window.JiraErrorHandler?.handleJiraError(
                    err,
                    `Failed to assign ${issue.key}`,
                    "popup"
                  );
                }
              });
              dropdown.appendChild(li);
            });
            dropdown.style.display = "block";
          } catch {
            dropdown.style.display = "none";
          }
        }, 300);
      });
      input.addEventListener("blur", () => {
        setTimeout(() => {
          dropdown.style.display = "none";
          input.value = input.getAttribute("data-current-assignee") || "Unassigned";
        }, 200);
      });
      container.appendChild(input);
      container.appendChild(dropdown);
      td.appendChild(container);
      return td;
    },
    total(issue, options) {
      const id = issue.key;
      const worklogs = issue.fields.worklog?.worklogs || [];
      const totalSecs = worklogs.reduce(
        (acc, wl) => acc + wl.timeSpentSeconds,
        0
      );
      const totalTime = (totalSecs / 3600).toFixed(1) + " hrs";
      const td = buildHTML("td", null, {
        class: "issue-total-time",
        "data-col": "total"
      });
      const loader = buildHTML("div", "", {
        class: "loader-mini",
        "data-issue-id": id
      });
      const totalTimeDiv = buildHTML("div", totalTime, {
        class: "issue-total-time-spent",
        "data-issue-id": id
      });
      td.appendChild(loader);
      td.appendChild(totalTimeDiv);
      (async () => {
        try {
          const JIRA = await getSharedJira(options);
          const resp = await JIRA.getIssueWorklog(id);
          const secs = resp.worklogs.reduce(
            (acc, wl) => acc + wl.timeSpentSeconds,
            0
          );
          totalTimeDiv.textContent = (secs / 3600).toFixed(1) + " hrs";
        } catch {
        }
        loader.style.display = "none";
      })();
      return td;
    },
    log(issue, _options) {
      const td = buildHTML("td", null, { "data-col": "log" });
      td.appendChild(
        buildHTML("input", null, {
          class: "issue-time-input",
          "data-issue-id": issue.key,
          placeholder: "Xhms"
        })
      );
      return td;
    },
    comment(issue, _options) {
      const td = buildHTML("td", null, { "data-col": "comment" });
      const container = buildHTML("div", null, {
        class: "suggestion-container",
        style: "position:relative;display:inline-block;width:100%;"
      });
      container.appendChild(
        buildHTML("input", null, {
          class: "issue-comment-input",
          "data-issue-id": issue.key,
          placeholder: "Comment",
          style: "width:100%;box-sizing:border-box;"
        })
      );
      container.appendChild(
        buildHTML("button", "1", { class: "frequentWorklogDescription1" })
      );
      container.appendChild(
        buildHTML("button", "2", { class: "frequentWorklogDescription2" })
      );
      td.appendChild(container);
      return td;
    },
    date(issue, _options) {
      const td = buildHTML("td", null, { "data-col": "date" });
      td.appendChild(
        buildHTML("input", null, {
          type: "date",
          class: "issue-log-date-input",
          value: (/* @__PURE__ */ new Date()).toDateInputValue(),
          "data-issue-id": issue.key
        })
      );
      return td;
    },
    actions(issue, _options) {
      const td = buildHTML("td", null, { "data-col": "actions" });
      const btn = buildHTML("input", null, {
        type: "button",
        value: "⇡",
        class: "issue-log-time-btn",
        "data-issue-id": issue.key
      });
      btn.addEventListener("click", async (event) => await logTimeClick(event));
      td.appendChild(btn);
      return td;
    }
  };
  async function loadTransitions(issueKey, select, _currentStatusName, options) {
    try {
      const JIRA = await getSharedJira(options);
      const resp = await JIRA.getTransitions(issueKey);
      (resp.transitions || []).forEach((t) => {
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = "→ " + t.name;
        select.appendChild(opt);
      });
      select.onchange = async () => {
        const transitionId = select.value;
        if (!transitionId) return;
        try {
          select.disabled = true;
          const J = await getSharedJira(options);
          await J.transitionIssue(issueKey, transitionId);
          const rawLabel = select.options[select.selectedIndex]?.textContent ?? "";
          const newName = rawLabel.replace("→ ", "");
          select.options[0].textContent = newName;
          select.selectedIndex = 0;
          while (select.options.length > 1) select.remove(1);
          await loadTransitions(issueKey, select, newName, options);
        } catch (err) {
          window.JiraErrorHandler?.handleJiraError(
            err,
            `Failed to transition ${issueKey}`,
            "popup"
          );
          select.selectedIndex = 0;
          select.disabled = false;
        }
      };
    } catch (err) {
      console.warn(`Failed to load transitions for ${issueKey}:`, err);
      select.disabled = true;
      select.title = "Could not load transitions — you may lack permission for this issue";
    }
  }
  function generateLogTableRow(issue, options, visibleCols) {
    const row = buildHTML("tr", null, { "data-issue-id": issue.key });
    visibleCols.forEach((colId) => {
      row.appendChild(cellBuilders[colId](issue, options));
    });
    return row;
  }
  function displaySuccess(message) {
    const success = document.getElementById("success");
    if (success) {
      success.innerText = message;
      success.style.display = "block";
      const error = document.getElementById("error");
      if (error) error.style.display = "none";
    } else {
      console.warn("Success element not found");
    }
  }
  function displayError(message) {
    const error = document.getElementById("error");
    if (error) {
      error.innerText = message;
      error.style.display = "block";
    }
    const success = document.getElementById("success");
    if (success) success.style.display = "none";
  }
  function clearMessages() {
    const error = document.getElementById("error");
    const success = document.getElementById("success");
    if (error) error.style.display = "none";
    if (success) success.style.display = "none";
  }
  Date.prototype.toDateInputValue = function() {
    const local = new Date(this);
    local.setMinutes(this.getMinutes() - this.getTimezoneOffset());
    return local.toJSON().slice(0, 10);
  };
  function getStartedTime(dateString) {
    const [year, month, day] = dateString.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    const now = /* @__PURE__ */ new Date();
    date.setHours(
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      now.getMilliseconds()
    );
    const tzo = -date.getTimezoneOffset();
    const dif = tzo >= 0 ? "+" : "-";
    const formattedDate = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${dif}${pad(Math.abs(Math.floor(tzo / 60)))}:${pad(Math.abs(tzo % 60))}`;
    console.log("Input date string:", dateString);
    console.log("Formatted start time:", formattedDate);
    return formattedDate;
  }
  function pad(num, width = 2) {
    return String(Math.abs(Math.floor(num))).padStart(width, "0");
  }
  function insertFrequentWorklogDescription(options) {
    const descriptionFields = document.querySelectorAll(
      ".issue-comment-input"
    );
    const frequentWorklogButtons1 = document.querySelectorAll(
      ".frequentWorklogDescription1"
    );
    const frequentWorklogButtons2 = document.querySelectorAll(
      ".frequentWorklogDescription2"
    );
    const bothAreEmpty = options.frequentWorklogDescription1 === "" && options.frequentWorklogDescription2 === "";
    descriptionFields.forEach((descriptionField, index) => {
      const button1 = frequentWorklogButtons1[index];
      const button2 = frequentWorklogButtons2[index];
      if (bothAreEmpty) {
        if (button1) button1.remove();
        if (button2) button2.remove();
        return;
      }
      function hideButtons() {
        if (button1) button1.style.display = "none";
        if (button2) button2.style.display = "none";
      }
      function showButtons() {
        const onlyButton1 = options.frequentWorklogDescription1 && !options.frequentWorklogDescription2;
        const onlyButton2 = !options.frequentWorklogDescription1 && options.frequentWorklogDescription2;
        if (button1 && options.frequentWorklogDescription1) {
          button1.style.display = "block";
          button1.style.zIndex = "2";
          if (onlyButton1) {
            button1.style.right = "3px";
          }
        }
        if (button2 && options.frequentWorklogDescription2) {
          button2.style.display = "block";
          button2.style.zIndex = "1";
          if (onlyButton2) {
            button2.style.right = "3px";
          }
        }
      }
      if (!options.frequentWorklogDescription1 && !options.frequentWorklogDescription2) {
        hideButtons();
      } else {
        showButtons();
      }
      if (button1 && options.frequentWorklogDescription1) {
        button1.addEventListener("click", () => {
          descriptionField.value = options.frequentWorklogDescription1;
          hideButtons();
        });
      }
      if (button2 && options.frequentWorklogDescription2) {
        button2.addEventListener("click", () => {
          descriptionField.value = options.frequentWorklogDescription2;
          hideButtons();
        });
      }
      descriptionField.addEventListener("input", () => {
        if (descriptionField.value.trim() === "") {
          showButtons();
        } else {
          hideButtons();
        }
      });
    });
  }
  async function toggleStar(issueId, options) {
    if (options.starredIssues[issueId]) {
      delete options.starredIssues[issueId];
    } else {
      options.starredIssues[issueId] = Date.now();
    }
    chrome.storage.sync.set({ starredIssues: options.starredIssues }, () => {
      console.log(
        `Star state updated for ${issueId}`,
        options.starredIssues[issueId]
      );
    });
    try {
      const JIRA = await getSharedJira(options);
      const issuesResponse = await JIRA.getIssues(0, options.jql);
      drawIssuesTable(issuesResponse, options);
      insertFrequentWorklogDescription(options);
    } catch (err) {
      console.error("Error fetching issues after star update:", err);
      await handleTimeTableFetchError(
        err,
        options,
        "Failed to refresh issues after updating star"
      );
    }
  }
  function showSuccessAnimation(issueId, loggedTime) {
    const row = document.querySelector(
      `tr[data-issue-id="${issueId}"]`
    );
    if (!row) return;
    const totalTimeCell = row.querySelector(
      "td.issue-total-time"
    );
    let indicator;
    if (totalTimeCell) {
      totalTimeCell.style.position = "relative";
      indicator = document.createElement("span");
      indicator.className = "logged-time-indicator";
      indicator.textContent = `+${loggedTime}`;
      totalTimeCell.appendChild(indicator);
    }
    row.classList.add("success-highlight");
    setTimeout(() => {
      if (indicator) {
        indicator.remove();
        if (totalTimeCell) totalTimeCell.style.position = "";
      }
    }, 5e3);
    setTimeout(() => {
      row.classList.add("fade-highlight");
      row.classList.remove("success-highlight");
    }, 4e3);
    setTimeout(() => {
      row.classList.remove("fade-highlight");
    }, 5e3);
  }
  function showErrorAnimation(issueId) {
    const row = document.querySelector(
      `tr[data-issue-id="${issueId}"]`
    );
    if (!row) return;
    row.classList.add("error-highlight");
    setTimeout(() => {
      row.classList.add("fade-highlight");
      row.classList.remove("error-highlight");
    }, 4e3);
    setTimeout(() => {
      row.classList.remove("fade-highlight");
    }, 5e3);
  }
  window.displayError = displayError;
})();

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
        const pad = (n, s = 2) => String(n).padStart(s, "0");
        return `${baseDate.getFullYear()}-${pad(baseDate.getMonth() + 1)}-${pad(baseDate.getDate())}T${pad(baseDate.getHours())}:${pad(baseDate.getMinutes())}:${pad(baseDate.getSeconds())}.${pad(baseDate.getMilliseconds(), 3)}${dif}${pad(Math.abs(Math.floor(tzo / 60)))}:${pad(Math.abs(tzo % 60))}`;
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

  // src/ts/shared/dom-utils.ts
  function getRequiredElement(id) {
    const element = document.getElementById(id);
    if (!element) {
      throw new Error(`Missing required element: ${id}`);
    }
    return element;
  }

  // src/ts/shared/jira-project-issue-autocomplete.ts
  function displayErrorGlobal(message) {
    const fn = globalThis.displayError;
    if (typeof fn === "function") {
      fn(message);
    }
  }
  function setupDropdownArrow(input) {
    const arrow = input.nextElementSibling;
    arrow?.addEventListener("click", (event) => {
      event.stopPropagation();
      input.focus();
      toggleDropdown(input);
    });
  }
  function toggleDropdown(input) {
    const event = new Event("toggleDropdown", { bubbles: true });
    input.dispatchEvent(event);
  }
  function setupInputFocus(input) {
    input.addEventListener("focus", function() {
      if (!this.value) {
        toggleDropdown(this);
      }
    });
  }
  function autocomplete(inp, arr, listElement, onSelect = null, options) {
    let currentFocus = -1;
    let isOpen = false;
    inp.addEventListener("input", function() {
      void showDropdown(this.value);
    });
    inp.addEventListener("toggleDropdown", function() {
      if (isOpen) {
        closeAllLists();
      } else {
        void showDropdown("");
      }
    });
    inp.addEventListener("refreshDropdown", function() {
      void showDropdown(inp.value || "");
    });
    async function showDropdown(val) {
      closeAllLists();
      currentFocus = -1;
      isOpen = true;
      let matches = arr.filter(
        (item) => item.toLowerCase().includes(val.toLowerCase())
      );
      if (matches.length === 0 && !val) {
        matches = arr;
      }
      const jira = options?.getJiraForSuggestions?.() ?? null;
      if (val && matches.length < 5 && jira != null && inp.id === "issueKey") {
        try {
          const projectInput = document.getElementById(
            "projectId"
          );
          const selectedKey = projectInput && projectInput.value ? projectInput.value.split(":")[0].trim() : null;
          const suggestions = await jira.getIssueSuggestions(val, selectedKey);
          const suggestionItems = suggestions.data.map(
            (i) => `${i.key}: ${i.fields.summary || ""}`
          );
          const merged = [...suggestionItems, ...matches];
          const seen = /* @__PURE__ */ new Set();
          matches = merged.filter((x) => {
            const k = x.split(":")[0].trim();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        } catch {
        }
      }
      matches.forEach((item) => {
        const li = document.createElement("li");
        li.innerHTML = item;
        li.addEventListener("click", function() {
          inp.value = this.innerHTML;
          closeAllLists();
          if (onSelect) onSelect(this.innerHTML);
        });
        listElement.appendChild(li);
      });
    }
    inp.addEventListener("keydown", function(e) {
      const x = listElement.getElementsByTagName("li");
      if (e.keyCode == 40) {
        currentFocus++;
        addActive(x);
      } else if (e.keyCode == 38) {
        currentFocus--;
        addActive(x);
      } else if (e.keyCode == 13) {
        e.preventDefault();
        if (currentFocus > -1) {
          if (x) x[currentFocus].click();
        }
      }
    });
    function addActive(x) {
      if (!x) return false;
      removeActive(x);
      if (currentFocus >= x.length) currentFocus = 0;
      if (currentFocus < 0) currentFocus = x.length - 1;
      x[currentFocus].classList.add("autocomplete-active");
    }
    function removeActive(x) {
      for (let i = 0; i < x.length; i += 1) {
        x[i].classList.remove("autocomplete-active");
      }
    }
    function closeAllLists(elmnt) {
      const x = document.getElementsByClassName("autocomplete-list");
      for (let i = 0; i < x.length; i += 1) {
        if (elmnt != x[i] && elmnt != inp) {
          x[i].innerHTML = "";
        }
      }
      isOpen = false;
    }
    document.addEventListener("click", function(e) {
      if (e.target !== inp && e.target !== inp.nextElementSibling) {
        closeAllLists(e.target);
      }
    });
  }
  function attachIssueDirectHandlers(JIRA, inputEl, getSelectedProjectKey, hooks, ctx) {
    if (!inputEl) return;
    const extractIssueKey = (raw) => typeof JIRA?.extractIssueKey === "function" ? JIRA.extractIssueKey(raw) : String(raw || "").trim().split(/\s|:/)[0].toUpperCase();
    const isIssueKeyLike = (key) => typeof JIRA?.isIssueKeyLike === "function" ? JIRA.isIssueKeyLike(key) : /^[A-Z][A-Z0-9_]*-\d+$/.test(key || "");
    const acceptIfValid = async () => {
      const candidate = extractIssueKey(inputEl.value);
      if (!isIssueKeyLike(candidate)) return;
      const selectedProject = getSelectedProjectKey();
      try {
        const { key, summary } = await JIRA.resolveIssueKeyFast(
          candidate,
          selectedProject || null
        );
        inputEl.value = summary ? `${key}: ${summary}` : key;
        await hooks.onResolvedSideEffects?.(key, summary, inputEl);
      } catch (err) {
        if (err?.code === "ISSUE_PROJECT_MISMATCH") {
          await hooks.onMismatch(inputEl, ctx);
          displayErrorGlobal("Work item key does not match selected project.");
        } else {
          inputEl.value = candidate;
          await hooks.onFallback(candidate, inputEl);
        }
      }
    };
    inputEl.addEventListener("paste", (e) => {
      const pasted = e && e.clipboardData && e.clipboardData.getData ? e.clipboardData.getData("text") : null;
      const candidate = extractIssueKey(pasted || inputEl.value);
      if (isIssueKeyLike(candidate)) {
        setTimeout(() => {
          void acceptIfValid();
        }, 0);
      }
    });
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const candidate = extractIssueKey(inputEl.value);
        if (isIssueKeyLike(candidate)) {
          e.preventDefault();
          void acceptIfValid();
        }
      }
    });
    inputEl.addEventListener("blur", () => {
      const candidate = extractIssueKey(inputEl.value);
      if (isIssueKeyLike(candidate)) {
        setTimeout(() => {
          void acceptIfValid();
        }, 0);
      }
    });
  }
  function bindInfiniteIssuesScroll(issueList, issueItems, jql, JIRA, issueInput, formatIssueRow, initialNextCursor) {
    let loadingMore = false;
    let nextCursor = initialNextCursor;
    issueList.addEventListener("scroll", () => {
      void (async () => {
        if (loadingMore || !nextCursor) return;
        const nearBottom = issueList.scrollTop + issueList.clientHeight >= issueList.scrollHeight - 20;
        if (!nearBottom) return;
        loadingMore = true;
        const nextPage = await JIRA.getIssuesPage(jql, nextCursor, 100);
        nextCursor = nextPage.nextCursor;
        const more = nextPage.data.map((i) => formatIssueRow(i));
        issueItems.push(...more);
        const evt = new Event("refreshDropdown", { bubbles: true });
        issueInput.dispatchEvent(evt);
        loadingMore = false;
      })();
    });
  }
  async function setupProjectIssueAutocomplete(JIRA, behavior) {
    const projectInput = getRequiredElement("projectId");
    const issueInputRef = {
      current: getRequiredElement("issueKey")
    };
    const projectList = getRequiredElement("projectList");
    const issueList = getRequiredElement("issueList");
    const projectsResponse = await JIRA.getProjects();
    const projects = projectsResponse.data;
    const projectMap = new Map(
      projects.map((project) => [project.key, project])
    );
    function getSelectedProjectKey() {
      const val = projectInput && projectInput.value ? projectInput.value : "";
      const key = val ? val.split(":")[0].trim() : "";
      return key.toUpperCase();
    }
    const ctx = {
      JIRA,
      projectInput,
      issueInputRef,
      projectList,
      issueList,
      projectMap,
      replaceIssueInput: () => {
      },
      getSelectedProjectKey
    };
    function replaceIssueInput() {
      const oldInput = issueInputRef.current;
      const oldValue = oldInput.value;
      const newInput = oldInput.cloneNode(true);
      oldInput.parentNode?.replaceChild(newInput, oldInput);
      issueInputRef.current = newInput;
      issueInputRef.current.value = oldValue;
      setupDropdownArrow(issueInputRef.current);
      setupInputFocus(issueInputRef.current);
      attachIssueDirectHandlers(
        JIRA,
        issueInputRef.current,
        getSelectedProjectKey,
        behavior.directIssueHooks,
        ctx
      );
    }
    ctx.replaceIssueInput = replaceIssueInput;
    setupDropdownArrow(projectInput);
    setupDropdownArrow(issueInputRef.current);
    setupInputFocus(projectInput);
    setupInputFocus(issueInputRef.current);
    autocomplete(
      projectInput,
      projects.map((p) => `${p.key}: ${p.name}`),
      projectList,
      (selected) => {
        void (async () => {
          const selectedKey = selected.split(":")[0].trim();
          const selectedProject = projectMap.get(selectedKey);
          if (selectedProject) {
            await behavior.onProjectSelectedFromDropdown({
              selectedKey,
              selectedProject,
              ctx
            });
          }
        })();
      }
    );
    attachIssueDirectHandlers(
      JIRA,
      issueInputRef.current,
      getSelectedProjectKey,
      behavior.directIssueHooks,
      ctx
    );
    if (behavior.runInitialPreload) {
      await behavior.runInitialPreload(ctx);
    }
    behavior.attachProjectInputExtras?.(ctx);
  }

  // src/ts/search.ts
  document.addEventListener("DOMContentLoaded", function() {
    const themeToggleElement = document.getElementById(
      "themeToggle"
    );
    if (!themeToggleElement) return;
    const themeToggle = themeToggleElement;
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
      const theme = result;
      const followSystem = theme.followSystemTheme !== false;
      const manualDark = theme.darkMode === true;
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
            const theme = result;
            const followSystem = theme.followSystemTheme !== false;
            const manualDark = theme.darkMode === true;
            applyTheme(followSystem, manualDark);
          }
        );
      }
    });
  });
  function updateThemeButton(isDark) {
    const themeToggle = document.getElementById(
      "themeToggle"
    );
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
        jiraType: "cloud",
        apiToken: "",
        baseUrl: "",
        username: "",
        frequentWorklogDescription1: "",
        frequentWorklogDescription2: "",
        darkMode: false,
        experimentalFeatures: false
      },
      async (storedOptions) => {
        const options = storedOptions;
        console.log("Storage options:", options);
        await init(options);
        getRequiredElement("search").addEventListener(
          "click",
          logTimeClick
        );
        insertFrequentWorklogDescription(options);
        const descriptionField = document.getElementById(
          "description"
        );
        if (descriptionField) {
          initializeWorklogSuggestions(descriptionField);
        }
      }
    );
    const datePicker = getRequiredElement("datePicker");
    datePicker.value = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
  }
  async function init(options) {
    console.log("Options received:", options);
    try {
      const JIRA = await JiraAPI(
        options.jiraType,
        options.baseUrl,
        options.username,
        options.apiToken
      );
      window.JIRA = JIRA;
      console.log("JIRA API Object initialized:", JIRA);
      if (!JIRA || typeof JIRA.getProjects !== "function" || typeof JIRA.getIssues !== "function") {
        console.error("JIRA API instantiation failed: Methods missing", JIRA);
        displayError(
          "JIRA API setup failed. Please check your settings and ensure all required fields (Base URL, Username, API Token) are correctly configured. Go to the main popup Settings to verify your configuration."
        );
        return;
      }
      await setupProjectIssueAutocomplete(JIRA, {
        getJiraForSuggestions: () => JIRA,
        formatIssueRow: (i) => `${i.key}: ${i.fields.summary || ""}`,
        directIssueHooks: {
          onMismatch: (inputEl, _ctx) => {
            inputEl.value = "";
          },
          onFallback: async (_candidate, _inputEl) => {
          }
        },
        onProjectSelectedFromDropdown: async ({ selectedProject, ctx }) => {
          const { JIRA: jira, replaceIssueInput, issueInputRef, issueList } = ctx;
          const jql = `project = ${selectedProject.key}`;
          replaceIssueInput();
          const page = await jira.getIssuesPage(jql, null, 100);
          const issueItems = page.data.map(
            (i) => `${i.key}: ${i.fields.summary || ""}`
          );
          autocomplete(issueInputRef.current, issueItems, issueList, null, {
            getJiraForSuggestions: () => JIRA
          });
          bindInfiniteIssuesScroll(
            issueList,
            issueItems,
            jql,
            jira,
            issueInputRef.current,
            (i) => `${i.key}: ${i.fields.summary || ""}`,
            page.nextCursor
          );
        }
      });
      const searchBtn = document.getElementById("search");
      if (searchBtn) {
        searchBtn.addEventListener("click", logTimeClick);
      }
    } catch (error) {
      console.error("Error initializing JIRA API:", error);
      window.JiraErrorHandler?.handleJiraError(
        error,
        "Failed to connect to JIRA from search page",
        "search"
      );
    }
  }
  async function logTimeClick(evt) {
    evt.preventDefault();
    const projectId = getRequiredElement("projectId").value.split(":")[0].trim();
    const issueKey = getRequiredElement("issueKey").value.split(":")[0].trim();
    const date = getRequiredElement("datePicker").value;
    const timeSpent = getRequiredElement("timeSpent").value;
    const description = getRequiredElement("description").value;
    if (!issueKey) {
      displayError(
        "Work Item Key is required. Please select or enter a valid work item key (e.g., PROJECT-123)."
      );
      return;
    }
    if (!timeSpent) {
      displayError(
        "Time Spent is required. Please enter the time you want to log (e.g., 2h, 30m, 1d)."
      );
      return;
    }
    const timeMatches = timeSpent.match(/[0-9]{1,4}[dhm]/g);
    if (!timeMatches) {
      displayError(
        'Invalid time format. Please use:\n• Hours: 2h, 1.5h\n• Minutes: 30m, 45m\n• Days: 1d, 0.5d\n\nExamples: "2h 30m", "1d", "45m"'
      );
      return;
    }
    console.log("Logging time with parameters:", {
      projectId,
      issueKey,
      date,
      timeSpent,
      description
    });
    chrome.storage.sync.get(
      {
        jiraType: "cloud",
        apiToken: "",
        baseUrl: "",
        username: ""
      },
      async (options) => {
        try {
          const JIRA = await JiraAPI(
            options.jiraType,
            options.baseUrl,
            options.username,
            options.apiToken
          );
          const startedTime = typeof JIRA.buildStartedTimestamp === "function" ? JIRA.buildStartedTimestamp(date) : new Date(date).toISOString();
          const timeSpentSeconds = convertTimeToSeconds(timeSpent);
          console.log({
            issueKey,
            timeSpentSeconds,
            startedTime,
            description
          });
          await JIRA.updateWorklog(
            issueKey,
            timeSpentSeconds,
            startedTime,
            description
          );
          displaySuccess(`You successfully logged: ${timeSpent} on ${issueKey}`);
          getRequiredElement("timeSpent").value = "";
          getRequiredElement(
            "description"
          ).value = "";
        } catch (error) {
          console.error("Error logging time:", error);
          window.JiraErrorHandler?.handleJiraError(
            error,
            `Failed to log time for issue ${issueKey}`,
            "search"
          );
        }
      }
    );
  }
  function convertTimeToSeconds(timeStr) {
    const timeUnits = {
      d: 60 * 60 * 24,
      h: 60 * 60,
      m: 60
    };
    const regex = /(\d+)([dhm])/g;
    let match;
    let totalSeconds = 0;
    while ((match = regex.exec(timeStr)) !== null) {
      const value = parseInt(match[1], 10);
      const unit = match[2];
      totalSeconds += value * timeUnits[unit];
    }
    return totalSeconds;
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
  function displaySuccess(message) {
    const success = document.getElementById("success");
    if (success) {
      success.innerText = message;
      success.style.display = "block";
      getRequiredElement("timeSpent").value = "";
      getRequiredElement("description").value = "";
      const error = document.getElementById("error");
      if (error) {
        error.innerText = "";
        error.style.display = "none";
      }
    } else {
      console.warn("Success element not found");
    }
  }
  function insertFrequentWorklogDescription(options) {
    const frequentWorklogDescription1 = document.getElementById(
      "frequentWorklogDescription1"
    );
    const frequentWorklogDescription2 = document.getElementById(
      "frequentWorklogDescription2"
    );
    const descriptionField = document.getElementById(
      "description"
    );
    if (!descriptionField) {
      console.error("Description field not found");
      return;
    }
    function hideButtons() {
      if (frequentWorklogDescription1)
        frequentWorklogDescription1.style.display = "none";
      if (frequentWorklogDescription2)
        frequentWorklogDescription2.style.display = "none";
    }
    function showButtons() {
      if (frequentWorklogDescription1 && options.frequentWorklogDescription1) {
        frequentWorklogDescription1.style.display = "block";
      }
      if (frequentWorklogDescription2 && options.frequentWorklogDescription2) {
        frequentWorklogDescription2.style.display = "block";
      }
    }
    if (!options.frequentWorklogDescription1 && !options.frequentWorklogDescription2) {
      hideButtons();
      return;
    }
    if (frequentWorklogDescription1 && options.frequentWorklogDescription1) {
      frequentWorklogDescription1.addEventListener("click", function() {
        descriptionField.value = options.frequentWorklogDescription1;
        console.log("frequentWorklogDescription1 clicked");
        hideButtons();
      });
    }
    if (frequentWorklogDescription2 && options.frequentWorklogDescription2) {
      frequentWorklogDescription2.addEventListener("click", function() {
        descriptionField.value = options.frequentWorklogDescription2;
        console.log("frequentWorklogDescription2 clicked");
        hideButtons();
      });
    }
    descriptionField.addEventListener("input", function() {
      console.log("User started typing in the description field");
      if (descriptionField.value === "") {
        showButtons();
      } else {
        hideButtons();
      }
    });
    if (descriptionField.value !== "") {
      hideButtons();
    } else {
      showButtons();
    }
  }
  window.displayError = displayError;
})();

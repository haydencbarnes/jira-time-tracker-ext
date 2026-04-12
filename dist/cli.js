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
    const displayError = globalThis.displayError;
    if (typeof displayError === "function") {
      displayError(fullMessage);
    } else {
      console.error("Display Error Function Not Found:", fullMessage);
    }
  }
  var jiraErrorHandlerGlobal = globalThis;
  jiraErrorHandlerGlobal.JiraErrorHandler = { handleJiraError };

  // src/ts/shared/dom-utils.ts
  function getRequiredElement(id) {
    const element = document.getElementById(id);
    if (!element) {
      throw new Error(`Missing required element: ${id}`);
    }
    return element;
  }

  // src/ts/cli.ts
  document.addEventListener("DOMContentLoaded", function() {
    const themeToggleElement = document.getElementById(
      "themeToggle"
    );
    if (!themeToggleElement) return;
    const themeToggle = themeToggleElement;
    function updateThemeButton(isDark) {
      const iconSpan = themeToggle.querySelector(".icon");
      if (!iconSpan) return;
      if (isDark) {
        iconSpan.textContent = "☀️";
        themeToggle.title = "Switch to light mode";
      } else {
        iconSpan.textContent = "🌙";
        themeToggle.title = "Switch to dark mode";
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
    chrome.storage.sync.get(["followSystemTheme", "darkMode"], function(result) {
      const theme = result;
      const followSystem = theme.followSystemTheme !== false;
      const manualDark = theme.darkMode === true;
      applyTheme(followSystem, manualDark);
    });
    themeToggle?.addEventListener("click", function() {
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
  document.addEventListener("DOMContentLoaded", onDOMContentLoaded);
  var CLI_AUTO_SCROLL_THRESHOLD_PX = 24;
  var shouldAutoScrollOutput = true;
  var pendingScrollFrame = null;
  var pendingFollowupScrollFrame = null;
  async function onDOMContentLoaded() {
    const output = getRequiredElement("cli-output");
    const input = getRequiredElement("cli-input");
    const palette = getRequiredElement("cmd-palette");
    initOutputAutoScroll(output);
    scrollToBottom(output, { force: true });
    const options = await readOptions();
    const JIRA = await JiraAPI(
      options.jiraType,
      options.baseUrl,
      options.username,
      options.apiToken
    );
    let meIdentifiers = buildMeIdentifiersFromUsername(options.username);
    try {
      const me = await JIRA.login();
      meIdentifiers = buildMeIdentifiersFromLogin(me, options.username);
    } catch {
    }
    const HISTORY_KEY = "CLI_HISTORY";
    const MAX_HISTORY = 300;
    let history = [];
    let historyIndex = -1;
    try {
      const stored = await new Promise((resolve) => {
        chrome.storage.local.get(
          [HISTORY_KEY],
          (value) => resolve(value || {})
        );
      });
      if (Array.isArray(stored[HISTORY_KEY])) {
        history = stored[HISTORY_KEY];
        historyIndex = history.length;
      }
    } catch {
    }
    input.addEventListener("keydown", async (e) => {
      const trimmed = input.value.trim();
      const isSlashNoArgs = /^\/[a-zA-Z]*$/.test(trimmed);
      if (palette?.dataset.open === "true" && e.key === "ArrowUp") {
        e.preventDefault();
        movePaletteSelection(palette, -1);
        return;
      }
      if (palette?.dataset.open === "true" && e.key === "ArrowDown") {
        e.preventDefault();
        movePaletteSelection(palette, 1);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && palette?.dataset.open === "true") {
        e.preventDefault();
        applySelectedCommand(palette, input);
        closeCommandPalette(palette);
        return;
      }
      if (e.key === "Escape" && palette?.dataset.open === "true") {
        e.preventDefault();
        closeCommandPalette(palette);
        return;
      }
      if (e.key === "ArrowDown" && isSlashNoArgs) {
        e.preventDefault();
        const prefix = trimmed.slice(1).toLowerCase();
        openCommandPalette(palette, input, prefix);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const command = input.value.trim();
        if (!command) return;
        closeCommandPalette(palette);
        history.push(command);
        if (history.length > MAX_HISTORY) {
          history = history.slice(history.length - MAX_HISTORY);
        }
        try {
          chrome.storage.local.set({ [HISTORY_KEY]: history });
        } catch {
        }
        historyIndex = history.length;
        input.value = "";
        const parts = command.split(/\n|;/).map((s) => s.trim()).filter(Boolean);
        const batchSeconds = parts.reduce((acc, part) => {
          const parsed = parseNaturalLanguage(part);
          return parsed?.seconds > 0 ? acc + parsed.seconds : acc;
        }, 0);
        if (parts.length > 1) {
          const totalLabel = batchSeconds > 0 ? ` — total: ${formatHumanTime(batchSeconds)}` : "";
          writeLine(
            output,
            `Batch: ${parts.length} entries${totalLabel}`,
            "line-subtle"
          );
        }
        for (const part of parts) {
          writeLine(output, `➜ ${part}`, "line-user");
          await handleCommand(part, {
            JIRA,
            options,
            output,
            input,
            meIdentifiers
          });
        }
        scrollToBottom(output, { force: true });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (historyIndex > 0) {
          historyIndex -= 1;
          input.value = history[historyIndex] || "";
          setTimeout(
            () => input.setSelectionRange(input.value.length, input.value.length)
          );
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (historyIndex < history.length - 1) {
          historyIndex += 1;
          input.value = history[historyIndex] || "";
        } else {
          historyIndex = history.length;
          input.value = "";
        }
      }
    });
    input.addEventListener("input", () => {
      const t = input.value.trim();
      if (!t.startsWith("/")) {
        closeCommandPalette(palette);
        return;
      }
      if (/^\/[a-zA-Z]*$/.test(t)) {
        const prefix = t.slice(1).toLowerCase();
        openCommandPalette(palette, input, prefix);
      } else {
        closeCommandPalette(palette);
      }
    });
  }
  function writeLine(outputEl, text, className) {
    const shouldStickToBottom = shouldAutoScrollOutput;
    const div = document.createElement("div");
    if (className) div.className = className;
    const html = text.replace(
      /\b([A-Z][A-Z0-9]+-\d+)\b/g,
      '<span class="issue-id">$1</span>'
    );
    div.innerHTML = html;
    outputEl.appendChild(div);
    if (shouldStickToBottom) {
      scrollToBottom(outputEl, { force: true });
    }
  }
  function clearCliOutput(outputEl) {
    if (!outputEl) return;
    outputEl.replaceChildren();
    scrollToBottom(outputEl, { force: true });
  }
  function initOutputAutoScroll(outputEl) {
    if (!outputEl) return;
    outputEl.addEventListener(
      "scroll",
      () => {
        shouldAutoScrollOutput = isNearBottom(outputEl);
      },
      { passive: true }
    );
  }
  function isNearBottom(outputEl) {
    if (!outputEl) return true;
    return outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight <= CLI_AUTO_SCROLL_THRESHOLD_PX;
  }
  function syncScrollToBottom(outputEl) {
    outputEl.scrollTop = outputEl.scrollHeight;
    document.getElementById("cli-bottom-anchor")?.scrollIntoView({ block: "end", inline: "nearest" });
    const pageScroller = document.scrollingElement;
    if (pageScroller) {
      pageScroller.scrollTop = pageScroller.scrollHeight;
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
  }
  function scrollToBottom(outputEl, { force = false } = {}) {
    if (!outputEl) return;
    if (!force && !shouldAutoScrollOutput) return;
    if (force) {
      shouldAutoScrollOutput = true;
    }
    if (pendingScrollFrame !== null) {
      cancelAnimationFrame(pendingScrollFrame);
    }
    if (pendingFollowupScrollFrame !== null) {
      cancelAnimationFrame(pendingFollowupScrollFrame);
    }
    pendingScrollFrame = requestAnimationFrame(() => {
      pendingScrollFrame = null;
      syncScrollToBottom(outputEl);
      pendingFollowupScrollFrame = requestAnimationFrame(() => {
        pendingFollowupScrollFrame = null;
        syncScrollToBottom(outputEl);
      });
    });
  }
  var COMMAND_ITEMS = [
    {
      cmd: "/time ISSUE-123",
      desc: "Show total and today for an issue",
      key: "time"
    },
    {
      cmd: "/time ISSUE-123 --me",
      desc: "Show only your time on an issue",
      key: "time"
    },
    { cmd: "/me ISSUE-123", desc: "Alias for your time only", key: "me" },
    { cmd: "/clear", desc: "Clear terminal output", key: "clear" },
    { cmd: "/bug", desc: "Report a bug or request a feature", key: "bug" },
    { cmd: "/help", desc: "Show help", key: "help" }
  ];
  function openCommandPalette(palette, input, prefix = "") {
    const rect = input.getBoundingClientRect();
    const vw = Math.max(
      document.documentElement.clientWidth || 0,
      window.innerWidth || 0
    );
    const vh = Math.max(
      document.documentElement.clientHeight || 0,
      window.innerHeight || 0
    );
    const paletteWidth = Math.min(520, vw - 16);
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + paletteWidth > vw - 8) {
      left = Math.max(8, vw - 8 - paletteWidth);
    }
    const estimatedHeight = 200;
    if (top + estimatedHeight > vh - 8) {
      top = Math.max(8, rect.top - 6 - estimatedHeight);
    }
    palette.style.left = `${left}px`;
    palette.style.top = `${top}px`;
    palette.style.width = `${paletteWidth}px`;
    updateCommandPalette(palette, prefix);
    palette.dataset.open = "true";
    palette.style.display = "block";
    palette.onclick = (ev) => {
      const item = ev.target?.closest(
        ".cmd-item"
      );
      if (!item) return;
      const inputEl = getRequiredElement("cli-input");
      inputEl.value = item.dataset.cmd + " ";
      closeCommandPalette(palette);
      inputEl.focus();
    };
    palette.onmousemove = (ev) => {
      const item = ev.target?.closest(
        ".cmd-item"
      );
      if (!item) return;
      palette.querySelectorAll(".cmd-item").forEach((node) => node.classList.remove("active"));
      item.classList.add("active");
    };
  }
  function closeCommandPalette(palette) {
    palette.dataset.open = "false";
    palette.style.display = "none";
  }
  function updateCommandPalette(palette, prefix = "") {
    const items = COMMAND_ITEMS.filter(
      (it) => !prefix || it.key.startsWith(prefix) || it.cmd.toLowerCase().startsWith("/" + prefix)
    );
    palette.innerHTML = items.map(
      (it, i) => `<div class="cmd-item${i === 0 ? " active" : ""}" role="option" data-cmd="${it.cmd}"><span class="cmd-label">${it.cmd}</span><span class="cmd-desc">${it.desc}</span></div>`
    ).join("");
  }
  function movePaletteSelection(palette, delta) {
    const nodes = Array.from(
      palette.querySelectorAll(".cmd-item")
    );
    const current = palette.querySelector(".cmd-item.active");
    let idx = current ? nodes.indexOf(current) : -1;
    idx = Math.max(0, Math.min(nodes.length - 1, idx + delta));
    nodes.forEach((node) => node.classList.remove("active"));
    const next = nodes[idx];
    next?.classList.add("active");
    next?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function applySelectedCommand(palette, input) {
    const active = palette.querySelector(".cmd-item.active");
    if (!active) return;
    input.value = active.dataset.cmd + " ";
  }
  function wrapIssue(issueKey) {
    return issueKey;
  }
  function showError(message) {
    const output = getRequiredElement("cli-output");
    writeLine(output, message, "line-error");
  }
  function readOptions() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(
        {
          jiraType: "cloud",
          apiToken: "",
          baseUrl: "",
          username: "",
          experimentalFeatures: false,
          frequentWorklogDescription1: "",
          frequentWorklogDescription2: ""
        },
        (items) => resolve(items)
      );
    });
  }
  async function handleCommand(raw, ctx) {
    const { JIRA, output, meIdentifiers } = ctx;
    const lc = raw.trim();
    if (lc.startsWith("/")) {
      const parts = lc.slice(1).trim().split(/\s+/);
      const cmd = (parts.shift() || "").toLowerCase();
      const rest = parts.join(" ");
      if (cmd === "help" || cmd === "?") {
        return handleCommand("help", ctx);
      }
      if (cmd === "time" || cmd === "t") {
        const m = rest.match(/^([A-Z][A-Z0-9]+-\d+)(\s+--me)?\s*$/i);
        if (!m) {
          writeLine(output, "Usage: /time ISSUE-123 [--me]");
          return;
        }
        const issueKey = m[1]?.toUpperCase();
        if (!issueKey) return;
        const onlyMe = !!m[2];
        await showIssueTimes(issueKey, JIRA, output, onlyMe, meIdentifiers);
        return;
      }
      if (cmd === "clear" || cmd === "cls") {
        if (rest.trim()) {
          writeLine(output, "Usage: /clear");
          return;
        }
        clearCliOutput(output);
        return;
      }
      if (cmd === "bug") {
        try {
          chrome.tabs?.create({
            url: "https://github.com/haydencbarnes/jira-time-tracker-ext/issues/new"
          });
        } catch {
          window.open(
            "https://github.com/haydencbarnes/jira-time-tracker-ext/issues/new",
            "_blank"
          );
        }
        writeLine(output, "Opening bug/feature tracker…", "line-subtle");
        return;
      }
      if (cmd === "me") {
        const m = rest.match(/^([A-Z][A-Z0-9]+-\d+)\s*$/i);
        if (!m) {
          writeLine(output, "Usage: /me ISSUE-123");
          return;
        }
        const issueKey = m[1]?.toUpperCase();
        if (!issueKey) return;
        await showIssueTimes(issueKey, JIRA, output, true, meIdentifiers);
        return;
      }
      writeLine(output, `Unknown command: /${cmd}`);
      return;
    }
    if (lc === "clear" || lc === "cls") {
      clearCliOutput(output);
      return;
    }
    if (lc === "help" || lc === "?") {
      writeLine(output, "Usage: ISSUE TIME [DATE] [COMMENT]");
      writeLine(output, '  - TIME: 1h, 30m, 1d, combos like "1h 30m"');
      writeLine(output, "  - DATE: today, yesterday, mon..sun, or YYYY-MM-DD");
      writeLine(output, "Info commands:");
      writeLine(
        output,
        "  time ISSUE-123           # show total and today time for an issue"
      );
      writeLine(
        output,
        "  time ISSUE-123 --me      # show only your time totals"
      );
      writeLine(output, "  ISSUE-123?               # quick alias to show times");
      writeLine(output, "Other commands:");
      writeLine(output, "  clear (or cls)           # clear terminal output");
      writeLine(output, "Slash commands:");
      writeLine(output, "  /time ISSUE-123 [--me]   # same as above, quicker");
      writeLine(
        output,
        "  /me ISSUE-123            # show only your time totals"
      );
      writeLine(output, "  /clear                   # clear terminal output");
      writeLine(
        output,
        "  /bug                     # open issues page to report bugs"
      );
      writeLine(output, "  /help                    # help");
      writeLine(output, "Examples:");
      writeLine(output, "  PROJ-123 1h 30m today Fix tests");
      writeLine(output, "  log 90m to PROJ-123 yesterday build pipeline fix");
      writeLine(output, "  PROJ-1 2h");
      writeLine(output, "Batch (semicolon or new line separated):");
      writeLine(
        output,
        "  PROJ-1 1h code review; PROJ-2 45m yesterday build fix"
      );
      return;
    }
    const timeCmdMatch = lc.match(
      /^\s*(time|show|status)\s+([A-Z][A-Z0-9]+-\d+)(\s+--me)?\s*$/i
    );
    const quickIssueQuery = lc.match(/\b([A-Z][A-Z0-9]+-\d+)\?\s*$/);
    if (timeCmdMatch || quickIssueQuery) {
      const matchedIssueKey = timeCmdMatch?.[2] ?? quickIssueQuery?.[1];
      if (!matchedIssueKey) return;
      const issueKey = matchedIssueKey.toUpperCase();
      const onlyMe = !!(timeCmdMatch && timeCmdMatch[3]);
      await showIssueTimes(issueKey, JIRA, output, onlyMe, meIdentifiers);
      return;
    }
    try {
      const parsed = parseNaturalLanguage(raw);
      if (!parsed.issueKey) {
        showError("Work item key not found. Example: PROJ-123");
        return;
      }
      if (!parsed.seconds || parsed.seconds <= 0) {
        showError("Time not understood. Examples: 2h, 30m, 1h 15m, 90m");
        return;
      }
      const startedTime = typeof JIRA.buildStartedTimestamp === "function" ? JIRA.buildStartedTimestamp(parsed.date) : new Date(parsed.date || Date.now()).toISOString();
      await JIRA.updateWorklog(
        parsed.issueKey,
        parsed.seconds,
        startedTime,
        parsed.comment || ""
      );
      const humanTime = formatHumanTime(parsed.seconds);
      writeLine(
        output,
        `✔ Logged ${humanTime} on ${wrapIssue(parsed.issueKey)}${parsed.comment ? " — " + parsed.comment : ""}`,
        "line-success"
      );
    } catch (error) {
      console.error("CLI log error:", error);
      writeLine(
        output,
        `✖ ${getErrorMessage(error) || "Failed to log time"}`,
        "line-error"
      );
      try {
        window.JiraErrorHandler?.handleJiraError(
          error,
          "Failed to log time via CLI",
          "cli"
        );
      } catch {
      }
    }
  }
  async function showIssueTimes(issueKey, JIRA, output, onlyMe = false, meIdentifiers) {
    try {
      const resp = await JIRA.getIssueWorklog(issueKey);
      const worklogs = Array.isArray(resp?.worklogs) ? resp.worklogs : [];
      const logs = onlyMe ? filterMyWorklogs(worklogs, meIdentifiers) : worklogs;
      const totalSeconds = logs.reduce(
        (acc, wl) => acc + (wl.timeSpentSeconds || 0),
        0
      );
      const today = /* @__PURE__ */ new Date();
      const todayKey = today.toISOString().slice(0, 10);
      const todaySeconds = logs.reduce((acc, wl) => {
        const started = wl.started ? new Date(wl.started) : null;
        if (!started) return acc;
        const startedKey = started.toISOString().slice(0, 10);
        return acc + (startedKey === todayKey ? wl.timeSpentSeconds || 0 : 0);
      }, 0);
      const fmt = (secs) => {
        const h = Math.floor(secs / 3600);
        const m = Math.round(secs % 3600 / 60);
        if (h && m) return `${h}h ${m}m`;
        if (h) return `${h}h`;
        return `${m}m`;
      };
      const scopeLabel = onlyMe ? "my" : "total";
      writeLine(
        output,
        `ℹ ${wrapIssue(issueKey)} — ${scopeLabel}: ${fmt(totalSeconds)}, today: ${fmt(todaySeconds)}`,
        "line-info"
      );
      if (logs.length > 0) {
        const last = logs[logs.length - 1];
        if (!last) return;
        const lastH = (last.timeSpentSeconds || 0) / 3600;
        const lastComment = typeof last.comment === "string" ? last.comment : last.comment?.content?.[0]?.content?.[0]?.text || "";
        const lastDate = last.started ? new Date(last.started).toLocaleString() : "";
        writeLine(
          output,
          `   last: ${lastH.toFixed(1)}h on ${lastDate}${lastComment ? ` — ${lastComment}` : ""}`
        );
      }
    } catch (error) {
      writeLine(
        output,
        `✖ Failed to fetch worklogs for ${issueKey}: ${getErrorMessage(error)}`,
        "line-error"
      );
    }
  }
  function filterMyWorklogs(worklogs, me) {
    if (!Array.isArray(worklogs)) return [];
    if (!me) return worklogs;
    return worklogs.filter((wl) => {
      const author = wl.author || wl.updateAuthor || {};
      const name = (author.accountId || author.emailAddress || author.displayName || author.name || "").toString().toLowerCase();
      return me.accountId && author.accountId && author.accountId === me.accountId || me.email && name.includes(me.email) || me.username && name.includes(me.username);
    });
  }
  function buildMeIdentifiersFromLogin(loginResp, fallbackUsername) {
    try {
      return {
        accountId: loginResp?.accountId || loginResp?.key || null,
        email: (loginResp?.emailAddress || "").toLowerCase() || null,
        username: (fallbackUsername || "").toLowerCase() || null
      };
    } catch {
      return buildMeIdentifiersFromUsername(fallbackUsername);
    }
  }
  function buildMeIdentifiersFromUsername(username) {
    return {
      accountId: null,
      email: (username || "").toLowerCase(),
      username: (username || "").toLowerCase()
    };
  }
  function formatHumanTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    if (h > 24) {
      const d = Math.floor(h / 24);
      const remH = h % 24;
      const parts2 = [];
      if (d) parts2.push(`${d}d`);
      if (remH) parts2.push(`${remH}h`);
      if (m) parts2.push(`${m}m`);
      return parts2.join(" ");
    }
    const parts = [];
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    if (!h && !m) parts.push(`${Math.max(1, Math.round(seconds / 60))}m`);
    return parts.join(" ");
  }
  function parseNaturalLanguage(input) {
    const text = input.trim();
    const issueMatch = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
    const issueKey = issueMatch ? issueMatch[1] : null;
    const timeRegex = /(\d+)\s*([dhm])/gi;
    let totalSeconds = 0;
    let match;
    while ((match = timeRegex.exec(text)) !== null) {
      const rawValue = match[1];
      const rawUnit = match[2];
      if (!rawValue || !rawUnit) continue;
      const value = parseInt(rawValue, 10);
      const unit = rawUnit.toLowerCase();
      if (unit === "d") totalSeconds += value * 24 * 3600;
      if (unit === "h") totalSeconds += value * 3600;
      if (unit === "m") totalSeconds += value * 60;
    }
    let date = null;
    if (totalSeconds === 0) {
      const minutesOnly = text.match(/(?<![A-Z0-9]-)\b(\d{1,4})\b(?!-)/);
      if (minutesOnly) {
        const minuteText = minutesOnly[1];
        if (minuteText) {
          const mins = parseInt(minuteText, 10);
          if (!isNaN(mins) && mins > 0) totalSeconds = mins * 60;
        }
      }
    }
    const lower = text.toLowerCase();
    const today = /* @__PURE__ */ new Date();
    if (/(^|\s)today(\s|$)/.test(lower)) {
      date = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    } else if (/(^|\s)yesterday(\s|$)/.test(lower)) {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      date = new Date(y.getFullYear(), y.getMonth(), y.getDate());
    } else {
      const weekMap = {
        sun: 0,
        mon: 1,
        tue: 2,
        wed: 3,
        thu: 4,
        fri: 5,
        sat: 6
      };
      const wd = lower.match(/\b(sun|mon|tue|wed|thu|fri|sat)\b/);
      const weekday = wd?.[1];
      if (weekday) {
        const target = weekMap[weekday];
        const d = new Date(today);
        const diff = (d.getDay() - target + 7) % 7 || 7;
        d.setDate(d.getDate() - diff);
        date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      }
    }
    const explicit = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (explicit) {
      const yearText = explicit[1];
      const monthText = explicit[2];
      const dayText = explicit[3];
      if (yearText && monthText && dayText) {
        const y = parseInt(yearText, 10);
        const m = parseInt(monthText, 10);
        const d = parseInt(dayText, 10);
        date = new Date(y, m - 1, d);
      }
    }
    let comment = text;
    if (issueKey) comment = comment.replace(issueKey, "");
    comment = comment.replace(/\b(\d+)\s*[dhm]\b/gi, "");
    comment = comment.replace(
      /\b(\d{4}-\d{2}-\d{2}|today|yesterday|sun|mon|tue|wed|thu|fri|sat)\b/gi,
      ""
    );
    comment = comment.replace(/\bto\b|\blog\b/gi, "");
    comment = comment.replace(/\s+/g, " ").trim();
    return { issueKey, seconds: totalSeconds, date, comment };
  }
  window.displayError = showError;
})();

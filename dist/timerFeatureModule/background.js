"use strict";
(() => {
  // src/ts/shared/jira-api.ts
  async function JiraAPI(jiraType, baseUrl, username, apiToken) {
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
  jiraApiGlobal.JiraAPI = JiraAPI;

  // src/ts/timerFeatureModule/background.ts
  var badgeUpdateInterval = null;
  var currentSeconds = 0;
  var isRunning = false;
  async function initSidePanelBehavior() {
    const items = await new Promise((resolve) => {
      chrome.storage.sync.get({ sidePanelEnabled: false }, (result) => {
        resolve(result);
      });
    });
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: items.sidePanelEnabled }).catch((error) => console.error(error));
  }
  void initSidePanelBehavior();
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "sync" && changes.sidePanelEnabled) {
      void chrome.sidePanel.setPanelBehavior({
        openPanelOnActionClick: changes.sidePanelEnabled.newValue === true
      }).catch((error) => console.error(error));
    }
  });
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const message = request;
    switch (message.action) {
      case "startTimer":
        startBadgeUpdate(message.seconds);
        return false;
      case "stopTimer":
        stopBadgeUpdate();
        return false;
      case "resetTimer":
        resetBadge();
        return false;
      case "updateBadge":
        updateBadge(message.seconds, message.isRunning);
        return false;
      case "syncTime":
        syncTime(message.seconds, message.isRunning);
        return false;
      case "openSidePanel":
        if (sender.tab?.windowId) {
          void chrome.sidePanel.open({ windowId: sender.tab.windowId });
        }
        return false;
      case "openUrl":
        openUrlInTab(message.url, sender);
        return false;
      case "logWorklog":
        void handleWorklogRequest(
          message,
          sendResponse
        );
        return true;
      default:
        return false;
    }
  });
  function openUrlInTab(url, sender) {
    if (!url) return;
    const createProperties = { url };
    if (sender?.tab?.windowId) {
      createProperties.windowId = sender.tab.windowId;
      if (typeof sender.tab.index === "number") {
        createProperties.index = sender.tab.index + 1;
      }
    }
    chrome.tabs.create(createProperties, () => {
      if (chrome.runtime.lastError) {
        console.error(
          "Failed to open URL from background:",
          chrome.runtime.lastError.message
        );
      }
    });
  }
  function getErrorResponse(error) {
    if (error instanceof Error) {
      const errorWithStatus = error;
      return {
        success: false,
        error: {
          message: error.message,
          status: errorWithStatus.status ?? 0
        }
      };
    }
    return {
      success: false,
      error: {
        message: "Unknown background worklog error",
        status: 0
      }
    };
  }
  async function handleWorklogRequest(request, sendResponse) {
    try {
      const jira = await JiraAPI(
        request.settings.jiraType,
        request.settings.baseUrl,
        request.settings.username,
        request.settings.apiToken
      );
      const result = await jira.updateWorklog(
        request.issueId,
        request.timeInSeconds,
        request.startedTime,
        request.comment
      );
      sendResponse({ success: true, result });
    } catch (error) {
      console.error("Background worklog error:", error);
      sendResponse(getErrorResponse(error));
    }
  }
  function clearBadgeInterval() {
    if (badgeUpdateInterval !== null) {
      window.clearInterval(badgeUpdateInterval);
      badgeUpdateInterval = null;
    }
  }
  function startBadgeUpdate(seconds) {
    currentSeconds = seconds;
    isRunning = true;
    updateBadge(currentSeconds, isRunning);
    clearBadgeInterval();
    badgeUpdateInterval = window.setInterval(() => {
      currentSeconds += 1;
      updateBadge(currentSeconds, isRunning);
    }, 1e3);
  }
  function stopBadgeUpdate() {
    clearBadgeInterval();
    isRunning = false;
    updateBadge(currentSeconds, isRunning);
  }
  function resetBadge() {
    clearBadgeInterval();
    currentSeconds = 0;
    isRunning = false;
    updateBadge(currentSeconds, isRunning);
  }
  function syncTime(seconds, running) {
    currentSeconds = seconds;
    isRunning = running;
    if (isRunning) {
      startBadgeUpdate(currentSeconds);
    } else {
      stopBadgeUpdate();
    }
  }
  function updateBadge(seconds, running) {
    if (!running) {
      chrome.action.setBadgeText({ text: "" });
      return;
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    let badgeText = "";
    if (hours > 0) {
      badgeText = `${hours}h${minutes.toString().padStart(2, "0")}`;
    } else if (minutes > 0) {
      badgeText = `${minutes}m`;
    } else {
      badgeText = `${seconds}s`;
    }
    if (badgeText.length > 4) {
      badgeText = badgeText.substring(0, 4);
    }
    chrome.action.setBadgeText({ text: badgeText });
    chrome.action.setBadgeBackgroundColor({ color: "#0052CC" });
  }
})();

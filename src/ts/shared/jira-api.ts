import type {
  IssueProjectMismatchError,
  JiraAssignableUser,
  JiraIssue,
  JiraIssuesResponse,
  JiraIssuePageResponse,
  JiraIssueSuggestionsResponse,
  JiraLoginResponse,
  JiraProjectsResponse,
  JiraTransitionResponse,
  JiraType,
  JiraWorklogResponse,
} from './types';

type CachedValue = {
  value: unknown;
  ts: number;
};

type ApiMethod = 'GET' | 'POST' | 'PUT';

/** Issue row returned by Jira search / issue list APIs */
interface ApiSearchIssue {
  key: string;
  fields?: {
    summary?: string;
    project?: JiraIssue['fields']['project'];
    status?: JiraIssue['fields']['status'];
    assignee?: JiraIssue['fields']['assignee'];
    worklog?: JiraIssue['fields']['worklog'];
  };
}

interface ApiSearchResponse {
  issues?: ApiSearchIssue[];
  total?: number;
  nextPageToken?: string;
}

interface ApiPickerIssue {
  key?: string;
  summaryText?: string;
  summary?: string;
}

interface ApiPickerSection {
  issues?: ApiPickerIssue[];
}

async function JiraAPI(
  jiraType: JiraType,
  baseUrl: string,
  username: string,
  apiToken: string
) {
  const isJiraCloud = jiraType === 'cloud';
  const apiVersion = isJiraCloud ? '3' : '2';
  const DEFAULT_TTL_MS = 60 * 1000; // 1 minute cache for GETs
  const WORKLOG_TTL_MS = 60 * 1000;
  const memoryCache = new Map<string, { value: unknown; ts: number }>(); // in-memory cache to reduce storage.local usage

  // Remove trailing slash and any accidental REST path suffix from baseUrl if present
  baseUrl = baseUrl
    .replace(/\/$/, '')
    .replace(/\/rest\/api\/(?:latest|\d+)$/i, '');

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Basic ${btoa(`${username}:${apiToken}`)}`,
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
  };

  async function login(): Promise<JiraLoginResponse> {
    // Use /myself to reliably fetch the current authenticated user for both Cloud and Server
    const url = `/myself`;
    return apiRequest<JiraLoginResponse>(url, 'GET');
  }

  async function getIssue(id: string): Promise<JiraIssue> {
    return apiRequest<JiraIssue>(`/issue/${id}`);
  }

  // Paged issues fetch for dropdowns/infinite scroll
  async function getIssuesPage(
    jql: string,
    cursor: string | null = null,
    pageSize = 100
  ): Promise<JiraIssuePageResponse> {
    if (isJiraCloud) {
      const endpoint = `/search/jql`;
      const body: {
        jql: string;
        maxResults: number;
        fields: string[];
        nextPageToken?: string;
      } = {
        jql: jql || '',
        maxResults: Math.min(pageSize, 100),
        fields: ['summary', 'parent', 'project'],
      };
      if (cursor) body.nextPageToken = cursor;
      const resp = await apiRequest<ApiSearchResponse>(endpoint, 'POST', body);
      const issues = Array.isArray(resp?.issues) ? resp.issues : [];
      return {
        total: typeof resp?.total === 'number' ? resp.total : issues.length,
        data: issues.map((issue: ApiSearchIssue) => ({
          key: issue.key,
          fields: {
            summary: issue.fields?.summary,
            project: issue.fields?.project,
          },
        })) as JiraIssue[],
        nextCursor: resp?.nextPageToken || null,
      };
    } else {
      const startAt = Number.isFinite(Number(cursor)) ? Number(cursor) : 0;
      const endpoint = `/search?jql=${encodeURIComponent(jql)}&fields=summary,parent,project&maxResults=${pageSize}&startAt=${startAt}`;
      const resp = await apiRequest<ApiSearchResponse>(endpoint, 'GET');
      const issues = Array.isArray(resp?.issues) ? resp.issues : [];
      const total =
        typeof resp?.total === 'number' ? resp.total : issues.length;
      const nextStart = startAt + issues.length;
      return {
        total,
        data: issues.map((issue: ApiSearchIssue) => ({
          key: issue.key,
          fields: {
            summary: issue.fields?.summary,
            project: issue.fields?.project,
          },
        })) as JiraIssue[],
        nextCursor: nextStart < total ? String(nextStart) : null,
      };
    }
  }

  // Issue picker suggestions for fast type-ahead across all pages
  async function getIssueSuggestions(
    query: string,
    projectKey: string | null = null
  ): Promise<JiraIssueSuggestionsResponse> {
    if (!query || typeof query !== 'string') {
      return { total: 0, data: [] };
    }
    let endpoint = `/issue/picker?query=${encodeURIComponent(query)}`;
    if (projectKey) {
      const currentJql = `project = ${projectKey}`;
      endpoint += `&currentJQL=${encodeURIComponent(currentJql)}`;
    }
    const resp = await apiRequest<{ sections?: ApiPickerSection[] }>(
      endpoint,
      'GET'
    );
    const sections = Array.isArray(resp?.sections) ? resp.sections : [];
    type PickerRow = {
      key: string;
      fields: { summary: string; project: null };
    };
    const flatIssues: PickerRow[] = [];
    for (const section of sections) {
      const issues = Array.isArray(section?.issues) ? section.issues : [];
      for (const issue of issues) {
        const key = issue?.key;
        if (!key) continue;
        flatIssues.push({
          key,
          fields: {
            summary: issue?.summaryText || issue?.summary || '',
            project: null,
          },
        });
      }
    }
    // De-duplicate by key while preserving order
    const seen = new Set<string>();
    const unique: PickerRow[] = [];
    for (const it of flatIssues) {
      if (it.key && !seen.has(it.key)) {
        seen.add(it.key);
        unique.push(it);
      }
    }
    return { total: unique.length, data: unique };
  }

  async function getIssues(
    begin = 0,
    jql?: string
  ): Promise<JiraIssuesResponse> {
    // Cloud has migrated to /search/jql (POST). Server/DC keeps /search (GET)
    if (isJiraCloud) {
      const defaultPageSize = 100; // Jira Cloud caps page size at 100
      const hardCap = 10000; // user-requested high cap to effectively paginate all
      // If called for simple project dropdown (e.g., "project = KEY"), avoid fetching thousands of issues
      const isSimpleProjectQuery =
        typeof jql === 'string' && /^\s*project\s*=\s*[^\s]+\s*$/i.test(jql);
      const dropdownLimit = 200;
      const desiredLimit =
        Number.isFinite(begin) && begin > 0
          ? Math.min(begin, hardCap)
          : isSimpleProjectQuery
            ? dropdownLimit
            : hardCap;
      let aggregatedIssues: ApiSearchIssue[] = [];
      let total: number | null = null;
      let nextPageToken: string | null = null;

      while (aggregatedIssues.length < desiredLimit) {
        const remaining = desiredLimit - aggregatedIssues.length;
        const pageSize = Math.min(defaultPageSize, remaining);
        const resp = await fetchCloudSearchPage(jql, nextPageToken, pageSize);
        // Extract issues
        const pageIssues = Array.isArray(resp?.issues) ? resp.issues : [];
        if (pageIssues.length === 0) break;

        aggregatedIssues = aggregatedIssues.concat(pageIssues);
        if (typeof resp?.total === 'number') total = resp.total;

        if (
          (typeof total === 'number' && aggregatedIssues.length >= total) ||
          aggregatedIssues.length >= desiredLimit
        )
          break;

        if (resp?.nextPageToken) {
          nextPageToken = resp.nextPageToken;
        } else {
          break;
        }
      }

      const normalized = {
        total: total ?? aggregatedIssues.length,
        issues: aggregatedIssues.slice(0, desiredLimit),
      };
      return handleIssueResp(normalized);
    } else {
      // Implement pagination for Server/DC as well
      const pageSize = 1000; // typical Server/DC caps; adjust safely
      const hardCap = 10000;
      let startAt = Number.isFinite(begin) && begin > 0 ? begin : 0;
      let aggregatedIssues: ApiSearchIssue[] = [];
      let total: number | null = null;

      while (aggregatedIssues.length < hardCap) {
        const endpoint = `/search?jql=${encodeURIComponent(jql ?? '')}&fields=summary,parent,project,status,assignee&maxResults=${pageSize}&startAt=${startAt}`;
        console.log(`Requesting issues from: ${endpoint}`);
        const resp = await apiRequest<ApiSearchResponse>(endpoint, 'GET');
        console.log(`Response from Jira:`, resp);

        const pageIssues = Array.isArray(resp?.issues) ? resp.issues : [];
        if (!Array.isArray(pageIssues) || pageIssues.length === 0) {
          break;
        }

        aggregatedIssues = aggregatedIssues.concat(pageIssues);
        if (typeof resp?.total === 'number') {
          total = resp.total;
        }

        if (
          (typeof total === 'number' && startAt + pageIssues.length >= total) ||
          aggregatedIssues.length >= hardCap
        ) {
          break;
        }

        startAt += pageIssues.length;
      }

      const normalized = {
        total: total ?? aggregatedIssues.length,
        issues: aggregatedIssues,
      };
      return handleIssueResp(normalized);
    }
  }

  async function getIssueWorklog(id: string): Promise<JiraWorklogResponse> {
    return apiRequest<JiraWorklogResponse>(`/issue/${id}/worklog`);
  }

  async function getProjects(begin = 0): Promise<JiraProjectsResponse> {
    const endpoint = isJiraCloud
      ? `/project/search?maxResults=500&startAt=${begin}`
      : '/project';
    console.log(`Requesting projects from: ${endpoint}`);
    const response = await apiRequest<unknown>(endpoint, 'GET');
    console.log(`Response from Jira:`, response);
    return handleProjectResp(response);
  }

  async function updateWorklog(
    id: string,
    timeSpentSeconds: number,
    started: string,
    comment: string
  ): Promise<unknown> {
    const endpoint = `/issue/${id}/worklog?notifyUsers=false`;

    const formattedComment = isJiraCloud
      ? {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  text: comment,
                  type: 'text',
                },
              ],
            },
          ],
        }
      : comment;

    const data = {
      timeSpentSeconds,
      comment: formattedComment,
      started: parseDate(started),
    };

    const result = await apiRequest<unknown>(endpoint, 'POST', data);
    // Invalidate cached worklog for this issue
    try {
      const url = buildAbsoluteUrl(`/issue/${id}/worklog`);
      const key = getCacheKey(url);
      memoryCache.delete(key);
      await storageLocalRemove(key);
    } catch (e: unknown) {
      console.warn('Failed to invalidate worklog cache', e);
    }
    return result;
  }

  function parseDate(date: string | number | Date): string {
    const dateObj = new Date(date);

    // ISO string: "2024-06-11T00:15:38.399Z"
    const isoString = dateObj.toISOString();

    // Remove "Z" and append "+0000" to make it "2024-06-11T00:15:38.399+0000"
    const formattedDate = isoString.slice(0, -1) + '+0000';

    console.log('Parsed Date:', formattedDate); // For debugging purposes
    return formattedDate;
  }

  function buildAbsoluteUrl(endpoint: string): string {
    const cleanEndpoint = endpoint
      .replace(/^\/rest\/api\/\d+/, '')
      .replace(/^\/+/, '');
    // Normalize baseUrl to avoid double protocol (e.g., https://https://...) and ensure protocol exists
    const hasProtocol = /^https?:\/\//i.test(baseUrl);
    const normalizedBase = hasProtocol ? baseUrl : `https://${baseUrl}`;
    return `${normalizedBase}/rest/api/${apiVersion}/${cleanEndpoint}`;
  }

  async function apiRequest<T = unknown>(
    endpoint: string,
    method: ApiMethod = 'GET',
    data?: unknown
  ): Promise<T> {
    // Ensure the endpoint does not duplicate the base URL path
    const url = buildAbsoluteUrl(endpoint);

    const bodyInit: Pick<RequestInit, 'body'> | Record<string, never> =
      data != null && (method === 'POST' || method === 'PUT')
        ? { body: JSON.stringify(data) }
        : {};

    const options: RequestInit = {
      method,
      headers,
      ...bodyInit,
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
          return memHit as T;
        }
        // 2) Persistent cache only for non-worklog endpoints
        if (!url.includes('/worklog')) {
          const diskHit = await getFromCache(key, ttl);
          if (diskHit !== null) {
            console.log(`Disk cache hit for ${url}`);
            setInMemoryCache(key, diskHit);
            return diskHit as T;
          }
        }
      } else if (
        method === 'POST' &&
        endpoint.replace(/^\//, '').startsWith('search/jql')
      ) {
        // Cache POST /search/jql pages by payload to keep dropdowns snappy
        const cacheKey = getPostSearchJqlCacheKey(url, data);
        const ttl = DEFAULT_TTL_MS;
        const memHit = getFromMemoryCache(cacheKey, ttl);
        if (memHit !== null) {
          console.log(`Memory cache hit for ${endpoint} POST body`);
          return memHit as T;
        }
        const diskHit = await getFromCache(cacheKey, ttl);
        if (diskHit !== null) {
          console.log(`Disk cache hit for ${endpoint} POST body`);
          setInMemoryCache(cacheKey, diskHit);
          return diskHit as T;
        }
      }

      const response = await fetch(url, options);
      const contentType = response.headers.get('content-type');

      console.log(
        `Response status: ${response.status}, content-type: ${contentType}`
      );

      if (response.ok) {
        console.log('API request successful');
        const parsed = contentType?.includes('application/json')
          ? await response.json()
          : await response.text();
        if (method === 'GET') {
          const key = getCacheKey(url);
          // always set memory cache
          setInMemoryCache(key, parsed);
          // only persist non-worklog endpoints
          if (!url.includes('/worklog')) {
            await setInCache(key, parsed);
          }
        } else if (
          method === 'POST' &&
          endpoint.replace(/^\//, '').startsWith('search/jql')
        ) {
          // Persist POST /search/jql results keyed by payload
          const cacheKey = getPostSearchJqlCacheKey(url, data);
          setInMemoryCache(cacheKey, parsed);
          await setInCache(cacheKey, parsed);
        }
        return parsed as T;
      } else {
        const errorData = contentType?.includes('application/json')
          ? await response.json()
          : await response.text();
        handleJiraResponseError(response, errorData);
      }
    } catch (error: unknown) {
      console.error(`API Request to ${url} failed:`, error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`API request failed: ${message}`);
    }
  }

  // Build a stable cache key for POST /search/jql by selecting canonical fields
  function getPostSearchJqlCacheKey(url: string, body: unknown): string {
    const b =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const fieldsRaw = b.fields;
    const keyObj = {
      url,
      jql: typeof b.jql === 'string' ? b.jql : '',
      fields: Array.isArray(fieldsRaw) ? fieldsRaw : [],
      maxResults: typeof b.maxResults === 'number' ? b.maxResults : 0,
      nextPageToken: typeof b.nextPageToken === 'string' ? b.nextPageToken : '',
    };
    return `POSTJQL:${JSON.stringify(keyObj)}`;
  }

  function handleJiraResponseError(
    response: Response,
    errorData: unknown
  ): never {
    const errorMsg =
      typeof errorData === 'string'
        ? errorData
        : (() => {
            if (errorData && typeof errorData === 'object') {
              const o = errorData as {
                errorMessages?: unknown;
                errors?: unknown;
              };
              if (Array.isArray(o.errorMessages)) {
                return o.errorMessages.map(String).join(', ');
              }
              if (o.errors !== undefined) {
                return JSON.stringify(o.errors);
              }
            }
            return response.statusText;
          })();

    console.error(`Error ${response.status}: ${errorMsg}`);
    throw new Error(`Error ${response.status}: ${errorMsg}`);
  }

  // Cloud: request issues page via POST /search/jql (token-based pagination)
  async function fetchCloudSearchPage(
    jql: string | undefined,
    nextPageToken: string | null,
    maxResults: number
  ): Promise<ApiSearchResponse> {
    const endpoint = `/search/jql`;
    const body: {
      jql: string;
      maxResults: number;
      fields: string[];
      nextPageToken?: string;
    } = {
      jql: jql || '',
      maxResults: maxResults || 100,
      fields: ['summary', 'parent', 'project', 'status', 'assignee'],
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    return apiRequest<ApiSearchResponse>(endpoint, 'POST', body);
  }

  function handleProjectResp(resp: unknown): JiraProjectsResponse {
    if (
      isJiraCloud &&
      resp &&
      typeof resp === 'object' &&
      'values' in resp &&
      Array.isArray((resp as { values: unknown }).values)
    ) {
      const r = resp as {
        total?: number;
        values: Array<{ key: string; name: string }>;
      };
      return {
        total: typeof r.total === 'number' ? r.total : r.values.length,
        data: r.values.map((project) => ({
          key: project.key,
          name: project.name,
        })),
      };
    } else if (Array.isArray(resp)) {
      const rows = resp as Array<{ key: string; name: string }>;
      return {
        total: rows.length,
        data: rows.map((project) => ({
          key: project.key,
          name: project.name,
        })),
      };
    } else {
      console.error('Unexpected project response structure:', resp);
      return { total: 0, data: [] };
    }
  }

  function handleIssueResp(resp: unknown): JiraIssuesResponse {
    // Support both classic and new JQL service shapes
    const rec =
      resp && typeof resp === 'object' && !Array.isArray(resp)
        ? (resp as Record<string, unknown>)
        : {};
    const nestedData =
      rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)
        ? (rec.data as Record<string, unknown>)
        : undefined;
    const issuesRaw = rec.issues ?? rec.results ?? nestedData?.issues ?? [];
    if (!Array.isArray(issuesRaw)) {
      console.error('Invalid issue response format:', resp);
      return { total: 0, data: [] };
    }
    const issues = issuesRaw;
    const total = typeof rec.total === 'number' ? rec.total : issues.length;
    return {
      total,
      data: issues.map((issue: unknown) => {
        const i = issue as ApiSearchIssue;
        return {
          key: i.key,
          fields: {
            summary: i.fields?.summary,
            project: i.fields?.project ?? null,
            status: i.fields?.status ?? null,
            assignee: i.fields?.assignee ?? null,
            worklog: i.fields?.worklog ?? { worklogs: [] },
          },
        };
      }) as JiraIssue[],
    };
  }

  async function getTransitions(
    issueKey: string
  ): Promise<JiraTransitionResponse> {
    return apiRequest<JiraTransitionResponse>(
      `/issue/${issueKey}/transitions`,
      'GET'
    );
  }

  async function transitionIssue(
    issueKey: string,
    transitionId: string
  ): Promise<unknown> {
    const result = await apiRequest<unknown>(
      `/issue/${issueKey}/transitions`,
      'POST',
      {
        transition: { id: transitionId },
      }
    );
    await invalidateGetCache(`/issue/${issueKey}/transitions`);
    return result;
  }

  async function updateIssue(
    issueKey: string,
    fields: Record<string, unknown>
  ): Promise<unknown> {
    return apiRequest<unknown>(`/issue/${issueKey}`, 'PUT', { fields });
  }

  async function searchAssignableUsers(
    issueKey: string,
    query: string,
    maxResults = 10
  ): Promise<JiraAssignableUser[]> {
    const endpoint = `/user/assignable/search?issueKey=${encodeURIComponent(issueKey)}&query=${encodeURIComponent(query)}&maxResults=${maxResults}`;
    const resp = await apiRequest<unknown>(endpoint, 'GET');
    return Array.isArray(resp) ? (resp as JiraAssignableUser[]) : [];
  }

  // ---- storage-backed cache helpers ----
  function getCacheKey(url: string): string {
    return `GET:${username || 'anon'}:${url}`;
  }

  // ---- shared helpers for fast issue acceptance and validation ----
  function extractIssueKey(raw: string): string {
    if (!raw) return '';
    const text = String(raw).trim();
    const token = text.split(/\s|:/)[0].trim();
    return token.toUpperCase();
  }

  function isIssueKeyLike(key: string): boolean {
    return /^[A-Z][A-Z0-9_]*-\d+$/.test(key || '');
  }

  function validateIssueMatchesProject(
    issueKey: string,
    projectKey: string
  ): boolean {
    if (!issueKey || !projectKey) return true;
    const prefix = String(issueKey).split('-')[0].toUpperCase();
    return prefix === String(projectKey).toUpperCase();
  }

  async function resolveIssueKeyFast(
    rawText: string,
    projectKey: string | null = null
  ): Promise<{ key: string; summary: string }> {
    const key = extractIssueKey(rawText);
    if (!isIssueKeyLike(key)) {
      return { key: '', summary: '' };
    }
    if (projectKey && !validateIssueMatchesProject(key, projectKey)) {
      const err = new Error(
        'ISSUE_PROJECT_MISMATCH'
      ) as IssueProjectMismatchError;
      err.code = 'ISSUE_PROJECT_MISMATCH';
      err.issueKey = key;
      err.projectKey = projectKey;
      throw err;
    }
    try {
      const issue = await getIssue(key);
      const summary = issue?.fields?.summary || '';
      return { key, summary };
    } catch {
      // If direct fetch fails, still return the key so UI can proceed
      return { key, summary: '' };
    }
  }

  // In-memory cache helpers (not persisted)
  function getFromMemoryCache(key: string, ttlMs: number): unknown | null {
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
    } catch {
      return null;
    }
  }

  function setInMemoryCache(key: string, value: unknown): void {
    try {
      memoryCache.set(key, { value, ts: Date.now() });
      // Soft cap memory size
      if (memoryCache.size > 500) {
        let oldestKey: string | null = null;
        let oldestTs = Number.POSITIVE_INFINITY;
        for (const [k, v] of memoryCache.entries()) {
          if (v.ts < oldestTs) {
            oldestTs = v.ts;
            oldestKey = k;
          }
        }
        if (oldestKey) memoryCache.delete(oldestKey);
      }
    } catch {}
  }

  async function getFromCache(
    key: string,
    ttlMs: number
  ): Promise<unknown | null> {
    try {
      const now = Date.now();
      const entry = await storageLocalGet(key);
      if (!entry) return null;
      const { value, ts } = entry;
      if (typeof ts !== 'number' || now - ts > ttlMs) return null;
      return value;
    } catch (e: unknown) {
      console.warn('Cache read error:', e);
      return null;
    }
  }

  async function setInCache(key: string, value: unknown): Promise<void> {
    try {
      await storageLocalSet(key, { value, ts: Date.now() });
    } catch (e: unknown) {
      console.warn('Cache write error:', e);
    }
  }

  async function invalidateGetCache(endpoint: string): Promise<void> {
    try {
      const url = buildAbsoluteUrl(endpoint);
      const key = getCacheKey(url);
      memoryCache.delete(key);
      await storageLocalRemove(key);
    } catch (e: unknown) {
      console.warn(`Failed to invalidate cache for ${endpoint}`, e);
    }
  }

  function storageLocalGet(key: string): Promise<CachedValue | null> {
    return new Promise((resolve) => {
      try {
        if (
          typeof chrome !== 'undefined' &&
          chrome.storage &&
          chrome.storage.local
        ) {
          chrome.storage.local.get([key], (items) =>
            resolve((items[key] as CachedValue | undefined) || null)
          );
        } else if (typeof localStorage !== 'undefined') {
          const raw = localStorage.getItem(key);
          resolve(raw ? (JSON.parse(raw) as CachedValue) : null);
        } else {
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    });
  }

  function storageLocalSet(key: string, value: CachedValue): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        if (
          typeof chrome !== 'undefined' &&
          chrome.storage &&
          chrome.storage.local
        ) {
          chrome.storage.local.set({ [key]: value }, () => resolve());
        } else if (typeof localStorage !== 'undefined') {
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

  function storageLocalRemove(key: string): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        if (
          typeof chrome !== 'undefined' &&
          chrome.storage &&
          chrome.storage.local
        ) {
          chrome.storage.local.remove([key], () => resolve());
        } else if (typeof localStorage !== 'undefined') {
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

const jiraApiGlobal = globalThis as typeof globalThis & {
  JiraAPI?: typeof JiraAPI;
};
jiraApiGlobal.JiraAPI = JiraAPI;

export { JiraAPI };
export type JiraApiClient = Awaited<ReturnType<typeof JiraAPI>>;

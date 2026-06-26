import './shared/jira-api';
import { getErrorMessage } from './shared/jira-error-handler';
import './shared/worklog-suggestions';
import { initPageViewLayout } from './shared/page-view-layout';
import { initializeStoredThemeControls } from './shared/theme-sync';
import {
  buildWorklogStartedTimestamp,
  getWorklogDurationValidationMessage,
  isValidWorklogDuration,
  parseWorklogDurationToSeconds,
  sumWorklogSeconds,
} from './shared/worklog-time';
import type {
  JiraApiClient,
  JiraIssue,
  JiraIssuesResponse,
  JiraWorklog,
  PopupColumnVisibility,
  PopupOptions,
  TimeTableSort,
} from './shared/types';

initPageViewLayout();

type CachedIssuesResponse = {
  data: JiraIssuesResponse;
  ts: number;
};

type TimeEntryView = 'table' | 'week';

type WeeklyEntry = {
  date: string;
  duration: string;
  comment: string;
  seconds: number;
};

type WeeklyLoggedIssuesCacheEntry = {
  data: JiraIssuesResponse;
  ts: number;
};

type WeeklyWorklogTotals = Record<string, Record<string, number>>;

type WeeklyWorklogTotalsCacheEntry = {
  data: WeeklyWorklogTotals;
  ts: number;
};

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKLY_LOGGED_ISSUES_CACHE_TTL_MS = 5 * 60 * 1000;
const WEEKLY_WORKLOG_TOTALS_CACHE_TTL_MS = 60 * 1000;
const GEAR_ICON_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5.5a.5.5 0 0 0-.5.5v1.07a5.5 5.5 0 0 0-1.56.64L3.7 1.97a.5.5 0 0 0-.7 0l-.71.7a.5.5 0 0 0 0 .71l.74.74A5.5 5.5 0 0 0 2.4 5.7H1.3a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h1.1a5.5 5.5 0 0 0 .63 1.58l-.74.74a.5.5 0 0 0 0 .7l.71.71a.5.5 0 0 0 .7 0l.74-.74a5.5 5.5 0 0 0 1.56.64V12.5a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-1.07a5.5 5.5 0 0 0 1.56-.64l.74.74a.5.5 0 0 0 .7 0l.71-.7a.5.5 0 0 0 0-.71l-.74-.74A5.5 5.5 0 0 0 11.6 7.7h1.1a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5h-1.1a5.5 5.5 0 0 0-.63-1.58l.74-.74a.5.5 0 0 0 0-.7l-.71-.71a.5.5 0 0 0-.7 0l-.74.74A5.5 5.5 0 0 0 8 2.07V1a.5.5 0 0 0-.5-.5h-1zM7 4.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z"/></svg>';

let activeTimeEntryView: TimeEntryView = 'table';
let currentWeekStart = getStartOfWeek(new Date());
let currentIssuesResponse: JiraIssuesResponse | null = null;
let currentIssuesResponseVersion = 0;
let currentPopupOptions: PopupOptions | null = null;
let viewControlsInitialized = false;
const weeklyLoggedIssuesCache = new Map<string, WeeklyLoggedIssuesCacheEntry>();
const weeklyLoggedIssuesRequests = new Map<
  string,
  Promise<JiraIssuesResponse>
>();
const weeklyWorklogTotalsCache = new Map<
  string,
  WeeklyWorklogTotalsCacheEntry
>();
const weeklyWorklogTotalsRequests = new Map<
  string,
  Promise<WeeklyWorklogTotals>
>();
let weeklyWorklogTotalsVersion = 0;

// ===== Column model =====
const COLUMN_DEFS = {
  issueId: { label: 'Jira ID', baseWidth: 14, locked: 'first', hasLogo: true },
  summary: { label: 'Summary', baseWidth: 25 },
  status: { label: 'Status', baseWidth: 10, optional: true },
  assignee: { label: 'Assignee', baseWidth: 10, optional: true },
  total: { label: 'Total', baseWidth: 8, optional: true },
  log: { label: 'Log', baseWidth: 7 },
  comment: { label: 'Worklog Comment', baseWidth: 15, optional: true },
  date: { label: 'Date', baseWidth: 10 },
  actions: { label: '', baseWidth: 3, locked: 'last' },
};
const DEFAULT_COLUMN_ORDER = [
  'issueId',
  'summary',
  'total',
  'log',
  'comment',
  'date',
  'actions',
] as const;
const DEFAULT_JQL =
  '(assignee=currentUser() OR worklogAuthor=currentUser()) AND status NOT IN (Closed, Done)';
const DEFAULT_TIME_TABLE_COLUMNS = {
  showStatus: false,
  showAssignee: false,
  showTotal: true,
  showComment: true,
};
const DEFAULT_TIME_TABLE_SORT: TimeTableSort = 'default';
const PRIORITY_RANKS: Record<string, number> = {
  highest: 5,
  blocker: 5,
  critical: 5,
  high: 4,
  major: 4,
  medium: 3,
  normal: 3,
  minor: 2,
  low: 2,
  lowest: 1,
  trivial: 1,
};

type ColumnId = keyof typeof COLUMN_DEFS;

function isColumnId(id: string): id is ColumnId {
  return Object.prototype.hasOwnProperty.call(COLUMN_DEFS, id);
}

function isOptionalColumn(colId: ColumnId): boolean {
  const def = COLUMN_DEFS[colId];
  return 'optional' in def && def.optional === true;
}

function visibilityKey(colId: ColumnId): keyof PopupColumnVisibility {
  return ('show' +
    colId.charAt(0).toUpperCase() +
    colId.slice(1)) as keyof PopupColumnVisibility;
}

function getVisibleColumns(
  columnOrder: string[],
  colSettings: PopupColumnVisibility
): ColumnId[] {
  return columnOrder.filter((colId): colId is ColumnId => {
    if (!isColumnId(colId)) return false;
    if (!isOptionalColumn(colId)) return true;
    return !!colSettings[visibilityKey(colId)];
  });
}

function getColumnWidths(visibleColumns: ColumnId[]): Record<ColumnId, string> {
  const totalBase = visibleColumns.reduce(
    (sum, id) => sum + COLUMN_DEFS[id].baseWidth,
    0
  );
  const widths = {} as Record<ColumnId, string>;
  visibleColumns.forEach((id) => {
    widths[id] =
      ((COLUMN_DEFS[id].baseWidth / totalBase) * 100).toFixed(1) + '%';
  });
  return widths;
}

// Ensure columnOrder contains all known ids (handles upgrade from older storage)
function normalizeColumnOrder(stored: unknown): ColumnId[] {
  const allIds = Object.keys(COLUMN_DEFS) as ColumnId[];
  if (!Array.isArray(stored) || stored.length === 0) {
    return [...DEFAULT_COLUMN_ORDER] as ColumnId[];
  }
  const result = (stored as string[]).filter((id): id is ColumnId =>
    isColumnId(id)
  );
  allIds.forEach((id) => {
    if (!result.includes(id)) result.splice(result.length - 1, 0, id);
  });
  // Enforce issueId first, actions last
  const withoutLocked = result.filter(
    (id) => id !== 'issueId' && id !== 'actions'
  );
  return ['issueId', ...withoutLocked, 'actions'];
}

function getStartOfWeek(date: Date): Date {
  const weekStart = new Date(date);
  weekStart.setHours(0, 0, 0, 0);
  const day = weekStart.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  weekStart.setDate(weekStart.getDate() + diff);
  return weekStart;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatDateInputValue(date: Date): string {
  const local = new Date(date);
  local.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return local.toJSON().slice(0, 10);
}

function formatWeeklyDateKey(date: Date): string {
  return formatDateInputValue(date);
}

function formatShortDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function getWeekDates(): Date[] {
  return WEEKDAY_LABELS.map((_label, index) =>
    addDays(currentWeekStart, index)
  );
}

function getWeekDateRange() {
  return {
    start: formatWeeklyDateKey(currentWeekStart),
    end: formatWeeklyDateKey(addDays(currentWeekStart, 6)),
  };
}

function formatInputTotal(seconds: number): string {
  if (seconds <= 0) return '0h';
  const hours = seconds / 3600;
  return `${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(1)}h`;
}

function getJiraIssueUrl(issueId: string, options: PopupOptions): string {
  const baseUrl = options.baseUrl.startsWith('http')
    ? options.baseUrl
    : `https://${options.baseUrl}`;
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${normalizedBaseUrl}browse/${issueId}`;
}

function getWeeklyLoggedIssuesCacheKey(options: PopupOptions): string {
  const { start, end } = getWeekDateRange();
  return [
    'weeklyLoggedIssues',
    options.jiraType,
    options.baseUrl,
    options.username,
    start,
    end,
  ].join(':');
}

function getWeeklyCachePrefix(options: PopupOptions): string {
  const { start, end } = getWeekDateRange();
  return [options.jiraType, options.baseUrl, options.username, start, end].join(
    ':'
  );
}

function getWeeklyWorklogTotalsCacheKey(
  options: PopupOptions,
  issueKeys: string[]
): string {
  return [
    'weeklyWorklogTotals',
    getWeeklyCachePrefix(options),
    issueKeys.slice().sort().join(','),
  ].join(':');
}

function buildWeeklyLoggedIssuesJql(): string {
  const { start, end } = getWeekDateRange();
  return (
    'worklogAuthor = currentUser() ' +
    `AND worklogDate >= "${start}" ` +
    `AND worklogDate <= "${end}" ` +
    'ORDER BY updated DESC'
  );
}

function mergeIssueResponses(
  baseIssuesResponse: JiraIssuesResponse,
  loggedIssuesResponse: JiraIssuesResponse
): JiraIssuesResponse {
  const byKey = new Map<string, JiraIssue>();

  (baseIssuesResponse.data || []).forEach((issue) => {
    byKey.set(issue.key, issue);
  });

  (loggedIssuesResponse.data || []).forEach((issue) => {
    const existing = byKey.get(issue.key);
    if (existing) {
      byKey.set(issue.key, {
        key: existing.key,
        fields: {
          ...issue.fields,
          ...existing.fields,
        },
      });
      return;
    }

    byKey.set(issue.key, issue);
  });

  const data = Array.from(byKey.values());
  return {
    total: data.length,
    data,
  };
}

function getWorklogDateKey(worklog: JiraWorklog): string | null {
  if (!worklog.started) return null;
  const startedDate = new Date(worklog.started);
  if (isNaN(startedDate.getTime())) return null;
  return formatWeeklyDateKey(startedDate);
}

function isWorklogByCurrentUser(
  worklog: JiraWorklog,
  currentUser: Awaited<ReturnType<JiraApiClient['login']>> | null,
  options: PopupOptions
): boolean {
  const author = worklog.author;
  if (!author) return false;

  if (currentUser) {
    if (
      currentUser.accountId &&
      author.accountId &&
      currentUser.accountId === author.accountId
    ) {
      return true;
    }

    if (
      currentUser.emailAddress &&
      author.emailAddress &&
      currentUser.emailAddress.toLowerCase() ===
        author.emailAddress.toLowerCase()
    ) {
      return true;
    }
  }

  const configuredUsername = options.username?.toLowerCase();
  if (configuredUsername) {
    return [author.name, author.key, author.emailAddress]
      .filter((value): value is string => !!value)
      .some((value) => value.toLowerCase() === configuredUsername);
  }

  return false;
}

function addWeeklyWorklogTotal(
  totals: WeeklyWorklogTotals,
  issueKey: string,
  dateKey: string,
  seconds: number
) {
  if (!totals[issueKey]) totals[issueKey] = {};
  totals[issueKey][dateKey] = (totals[issueKey][dateKey] || 0) + seconds;
}

async function loadWeeklyWorklogTotals(
  options: PopupOptions,
  issuesResponse: JiraIssuesResponse
): Promise<WeeklyWorklogTotals> {
  const issueKeys = (issuesResponse.data || []).map((issue) => issue.key);
  if (issueKeys.length === 0) return {};

  const cacheKey = getWeeklyWorklogTotalsCacheKey(options, issueKeys);
  const cached = weeklyWorklogTotalsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < WEEKLY_WORKLOG_TOTALS_CACHE_TTL_MS) {
    return cached.data;
  }

  const existingRequest = weeklyWorklogTotalsRequests.get(cacheKey);
  if (existingRequest) return existingRequest;

  const weekDates = new Set(getWeekDates().map(formatWeeklyDateKey));
  const worklogTotalsVersion = weeklyWorklogTotalsVersion;
  const request = (async () => {
    const JIRA = await getSharedJira(options);
    let currentUser: Awaited<ReturnType<JiraApiClient['login']>> | null = null;
    try {
      currentUser = await JIRA.login();
    } catch (error) {
      console.warn('Failed to resolve Jira user for worklog filtering:', error);
    }

    const totals: WeeklyWorklogTotals = {};
    await Promise.all(
      issueKeys.map(async (issueKey) => {
        try {
          const response = await JIRA.getIssueWorklog(issueKey);
          (response.worklogs || []).forEach((worklog) => {
            if (!isWorklogByCurrentUser(worklog, currentUser, options)) return;

            const dateKey = getWorklogDateKey(worklog);
            if (!dateKey || !weekDates.has(dateKey)) return;

            addWeeklyWorklogTotal(
              totals,
              issueKey,
              dateKey,
              worklog.timeSpentSeconds
            );
          });
        } catch (error) {
          console.warn(`Failed to load worklogs for ${issueKey}:`, error);
        }
      })
    );

    if (weeklyWorklogTotalsVersion === worklogTotalsVersion) {
      weeklyWorklogTotalsCache.set(cacheKey, { data: totals, ts: Date.now() });
    }
    return totals;
  })();

  weeklyWorklogTotalsRequests.set(cacheKey, request);

  try {
    return await request;
  } finally {
    weeklyWorklogTotalsRequests.delete(cacheKey);
  }
}

function clearWeeklyWorklogCaches() {
  weeklyWorklogTotalsVersion += 1;
  weeklyWorklogTotalsCache.clear();
  weeklyWorklogTotalsRequests.clear();
}

async function loadLoggedIssuesForCurrentWeek(
  options: PopupOptions
): Promise<JiraIssuesResponse> {
  const cacheKey = getWeeklyLoggedIssuesCacheKey(options);
  const cached = weeklyLoggedIssuesCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < WEEKLY_LOGGED_ISSUES_CACHE_TTL_MS) {
    return cached.data;
  }

  const existingRequest = weeklyLoggedIssuesRequests.get(cacheKey);
  if (existingRequest) return existingRequest;

  const jql = buildWeeklyLoggedIssuesJql();
  const request = (async () => {
    const JIRA = await getSharedJira(options);
    const data = await JIRA.getIssues(0, jql);
    weeklyLoggedIssuesCache.set(cacheKey, { data, ts: Date.now() });
    return data;
  })();

  weeklyLoggedIssuesRequests.set(cacheKey, request);

  try {
    return await request;
  } finally {
    weeklyLoggedIssuesRequests.delete(cacheKey);
  }
}

function initViewControls() {
  if (viewControlsInitialized) return;
  viewControlsInitialized = true;

  const weekControls = document.getElementById('week-controls');
  const prevBtn = document.getElementById(
    'week-prev-btn'
  ) as HTMLButtonElement | null;
  const nextBtn = document.getElementById(
    'week-next-btn'
  ) as HTMLButtonElement | null;
  const todayBtn = document.getElementById(
    'week-today-btn'
  ) as HTMLButtonElement | null;

  prevBtn?.addEventListener('click', () => {
    currentWeekStart = addDays(currentWeekStart, -7);
    void renderCurrentWeeklyView();
  });
  nextBtn?.addEventListener('click', () => {
    currentWeekStart = addDays(currentWeekStart, 7);
    void renderCurrentWeeklyView();
  });
  todayBtn?.addEventListener('click', () => {
    currentWeekStart = getStartOfWeek(new Date());
    void renderCurrentWeeklyView();
  });

  if (weekControls && !document.getElementById('week-gear-btn')) {
    const weekGearBtn = buildGearButton();
    weekGearBtn.id = 'week-gear-btn';
    weekGearBtn.classList.add('week-settings-btn');
    weekControls.appendChild(weekGearBtn);
  }

  setTimeEntryView(activeTimeEntryView);
}

function setTimeEntryView(view: TimeEntryView) {
  activeTimeEntryView = view;

  const viewToolbar = document.querySelector<HTMLElement>('.view-toolbar');
  const tableView = document.getElementById('table-view');
  const weekView = document.getElementById('week-view');
  const weekControls = document.getElementById('week-controls');

  if (tableView) tableView.style.display = view === 'table' ? 'block' : 'none';
  if (weekView) weekView.style.display = view === 'week' ? 'block' : 'none';
  if (viewToolbar)
    viewToolbar.style.display = view === 'week' ? 'flex' : 'none';
  if (weekControls) {
    weekControls.style.display = view === 'week' ? 'flex' : 'none';
  }

  if (view === 'week') {
    void renderCurrentWeeklyView();
  }
}

async function renderCurrentWeeklyView() {
  if (!currentIssuesResponse || !currentPopupOptions) {
    updateWeekRangeLabel();
    return;
  }

  const options = currentPopupOptions;
  const baseIssuesResponse = currentIssuesResponse;
  const issueVersion = currentIssuesResponseVersion;
  const cacheKey = getWeeklyLoggedIssuesCacheKey(options);

  const cached = weeklyLoggedIssuesCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < WEEKLY_LOGGED_ISSUES_CACHE_TTL_MS) {
    const mergedIssuesResponse = mergeIssueResponses(
      baseIssuesResponse,
      cached.data
    );
    drawWeeklyView(mergedIssuesResponse, options);
    await loadAndRenderWeeklyWorklogTotals(
      mergedIssuesResponse,
      options,
      cacheKey,
      issueVersion
    );
    return;
  }

  drawWeeklyLoadingState(baseIssuesResponse, options);

  try {
    const loggedIssuesResponse = await loadLoggedIssuesForCurrentWeek(options);
    if (
      activeTimeEntryView !== 'week' ||
      currentPopupOptions !== options ||
      currentIssuesResponseVersion !== issueVersion ||
      getWeeklyLoggedIssuesCacheKey(options) !== cacheKey
    ) {
      return;
    }

    const mergedIssuesResponse = mergeIssueResponses(
      baseIssuesResponse,
      loggedIssuesResponse
    );
    drawWeeklyView(mergedIssuesResponse, options);
    await loadAndRenderWeeklyWorklogTotals(
      mergedIssuesResponse,
      options,
      cacheKey,
      issueVersion
    );
  } catch (error) {
    console.warn('Failed to load historical weekly issues:', error);
    if (
      activeTimeEntryView === 'week' &&
      currentPopupOptions === options &&
      currentIssuesResponseVersion === issueVersion &&
      getWeeklyLoggedIssuesCacheKey(options) === cacheKey
    ) {
      drawWeeklyView(baseIssuesResponse, options);
      window.JiraErrorHandler?.handleJiraError(
        error,
        'Failed to load issues with work logged for this week',
        'popup'
      );
    }
  }
}

async function loadAndRenderWeeklyWorklogTotals(
  issuesResponse: JiraIssuesResponse,
  options: PopupOptions,
  loggedIssuesCacheKey: string,
  issueVersion: number
) {
  try {
    const worklogTotalsVersion = weeklyWorklogTotalsVersion;
    const totals = await loadWeeklyWorklogTotals(options, issuesResponse);
    if (
      activeTimeEntryView !== 'week' ||
      currentPopupOptions !== options ||
      currentIssuesResponseVersion !== issueVersion ||
      weeklyWorklogTotalsVersion !== worklogTotalsVersion ||
      getWeeklyLoggedIssuesCacheKey(options) !== loggedIssuesCacheKey
    ) {
      return;
    }

    applyWeeklyWorklogTotals(totals);
  } catch (error) {
    console.warn('Failed to load weekly worklog totals:', error);
  }
}

function updateWeekRangeLabel() {
  const rangeLabel = document.getElementById('week-range-label');
  if (!rangeLabel) return;

  const weekEnd = addDays(currentWeekStart, 6);
  rangeLabel.textContent = `${formatShortDate(currentWeekStart)} - ${formatShortDate(weekEnd)}`;
}

// ===== Theme =====
document.addEventListener('DOMContentLoaded', function () {
  const themeToggle = document.getElementById('themeToggle');
  if (!themeToggle) return;
  initializeStoredThemeControls({
    toggle: themeToggle as HTMLButtonElement,
  });
});

// ===== Main init =====
document.addEventListener('DOMContentLoaded', onDOMContentLoaded);

async function onDOMContentLoaded() {
  chrome.storage.sync.get(
    {
      apiToken: '',
      baseUrl: '',
      jql: DEFAULT_JQL,
      username: '',
      jiraType: 'server',
      frequentWorklogDescription1: '',
      frequentWorklogDescription2: '',
      starredIssues: {},
      defaultPage: 'popup.html',
      timeEntryView: 'table',
      darkMode: false,
      experimentalFeatures: false,
      timeTableColumns: DEFAULT_TIME_TABLE_COLUMNS,
      timeTableColumnOrder: DEFAULT_COLUMN_ORDER,
      timeTableSort: DEFAULT_TIME_TABLE_SORT,
    },
    async (storedOptions) => {
      const options = storedOptions as unknown as PopupOptions;
      // Normalize column settings
      options.timeTableColumns = Object.assign(
        {},
        DEFAULT_TIME_TABLE_COLUMNS,
        options.timeTableColumns
      );
      options.timeTableColumnOrder = normalizeColumnOrder(
        options.timeTableColumnOrder
      );
      options.timeTableSort = normalizeTimeTableSort(options.timeTableSort);
      options.timeEntryView =
        options.timeEntryView === 'week' ? 'week' : 'table';
      activeTimeEntryView = options.timeEntryView;

      const urlParams = new URLSearchParams(window.location.search);
      const isNavigatingBack = urlParams.get('source') === 'navigation';

      const currentPage = window.location.pathname.split('/').pop() || '';
      if (currentPage !== options.defaultPage && !isNavigatingBack) {
        window.location.href = options.defaultPage;
        return;
      }

      options.starredIssues = filterExpiredStars(options.starredIssues, 90);
      chrome.storage.sync.set(
        { starredIssues: options.starredIssues },
        () => {}
      );

      // Store options globally so gear panel can access them
      window._ttOptions = options;

      initGearPanel(options);
      initViewControls();
      await init(options);
      insertFrequentWorklogDescription(options);
    }
  );
}

function normalizeTimeTableSort(sort: unknown): TimeTableSort {
  return isTimeTableSort(sort) ? sort : DEFAULT_TIME_TABLE_SORT;
}

function isTimeTableSort(sort: unknown): sort is TimeTableSort {
  return (
    sort === 'default' ||
    sort === 'dateNewest' ||
    sort === 'dateOldest' ||
    sort === 'totalDesc' ||
    sort === 'totalAsc' ||
    sort === 'priority'
  );
}

function filterExpiredStars(
  starredIssues: Record<string, number>,
  days: number
): Record<string, number> {
  const now = Date.now();
  const cutoff = days * 24 * 60 * 60 * 1000;
  const filtered: Record<string, number> = {};
  for (const issueId in starredIssues) {
    if (Object.prototype.hasOwnProperty.call(starredIssues, issueId)) {
      if (now - starredIssues[issueId] < cutoff) {
        filtered[issueId] = starredIssues[issueId];
      }
    }
  }
  return filtered;
}

// ===== Gear settings panel =====
function syncGearPanelState(options: PopupOptions) {
  const jqlTextarea = document.getElementById(
    'gear-jql'
  ) as HTMLTextAreaElement | null;
  if (jqlTextarea) jqlTextarea.value = options.jql || DEFAULT_JQL;

  const sortSelect = document.getElementById(
    'gear-time-table-sort'
  ) as HTMLSelectElement | null;
  if (sortSelect) sortSelect.value = options.timeTableSort;

  const weekViewToggle = document.getElementById(
    'gear-week-view-toggle'
  ) as HTMLInputElement | null;
  if (weekViewToggle) weekViewToggle.checked = activeTimeEntryView === 'week';

  renderGearColumnOrder(
    options.timeTableColumnOrder.filter(isColumnId),
    options.timeTableColumns
  );
}

function openGearModal(options: PopupOptions | undefined = window._ttOptions) {
  if (options) syncGearPanelState(options);
  const backdrop = document.getElementById(
    'gear-modal-backdrop'
  ) as HTMLDivElement;
  backdrop.style.display = 'flex';
  document
    .querySelectorAll('.gear-btn')
    .forEach((btn) => btn.setAttribute('aria-expanded', 'true'));
}

function closeGearModal() {
  const backdrop = document.getElementById(
    'gear-modal-backdrop'
  ) as HTMLDivElement;
  backdrop.style.display = 'none';
  document
    .querySelectorAll('.gear-btn')
    .forEach((btn) => btn.setAttribute('aria-expanded', 'false'));
}

function initGearPanel(options: PopupOptions) {
  if (window._gearPanelInitialized) return;
  window._gearPanelInitialized = true;

  const backdrop = document.getElementById(
    'gear-modal-backdrop'
  ) as HTMLDivElement;
  const closeBtn = document.getElementById(
    'gear-modal-close'
  ) as HTMLButtonElement;
  const saveBtn = document.getElementById('gear-save-btn') as HTMLButtonElement;
  const jqlTextarea = document.getElementById(
    'gear-jql'
  ) as HTMLTextAreaElement;
  const sortSelect = document.getElementById(
    'gear-time-table-sort'
  ) as HTMLSelectElement;
  const weekViewToggle = document.getElementById(
    'gear-week-view-toggle'
  ) as HTMLInputElement;

  syncGearPanelState(options);

  closeBtn.addEventListener('click', closeGearModal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeGearModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && backdrop.style.display !== 'none')
      closeGearModal();
  });

  saveBtn.addEventListener('click', async () => {
    const newJql = jqlTextarea.value.trim() || DEFAULT_JQL;
    const newCols = readGearColumnVisibility();
    const newOrder = readGearColumnOrder();
    const newSort = normalizeTimeTableSort(sortSelect.value);
    const nextView: TimeEntryView = weekViewToggle.checked ? 'week' : 'table';
    const jqlChanged = newJql !== options.jql;

    options.jql = newJql;
    options.timeTableColumns = newCols;
    options.timeTableColumnOrder = newOrder;
    options.timeTableSort = newSort;
    options.timeEntryView = nextView;

    chrome.storage.sync.set({
      jql: newJql,
      timeEntryView: nextView,
      timeTableColumns: newCols,
      timeTableColumnOrder: newOrder,
      timeTableSort: newSort,
    });

    closeGearModal();
    setTimeEntryView(nextView);

    if (jqlChanged) {
      // Refetch with new JQL
      try {
        const JIRA = await getSharedJira(options);
        const issuesResponse = await JIRA.getIssues(0, options.jql);
        const cacheKey = getIssuesCacheKey(options);
        chrome.storage.local.set({
          [cacheKey]: { data: issuesResponse, ts: Date.now() },
        });
        await onFetchSuccess(issuesResponse, options);
      } catch (err) {
        await handleTimeTableFetchError(
          err,
          options,
          'Failed to fetch issues with new JQL'
        );
      }
    } else {
      // Just redraw table with new column settings
      await redrawCurrentTable(options);
    }
    insertFrequentWorklogDescription(options);
  });
}

async function redrawCurrentTable(options: PopupOptions) {
  const cacheKey = getIssuesCacheKey(options);
  const cached = await new Promise<CachedIssuesResponse | undefined>(
    (resolve) => {
      chrome.storage.local.get([cacheKey], (items) =>
        resolve(items[cacheKey] as CachedIssuesResponse | undefined)
      );
    }
  );

  if (cached && cached.data) {
    await onFetchSuccess(cached.data, options);
  }
}

// Drag-and-drop column order in gear panel (with inline visibility toggles)
function renderGearColumnOrder(
  order: ColumnId[],
  colSettings: PopupColumnVisibility
) {
  const ul = document.getElementById('gear-column-order');
  if (!ul) return;
  ul.innerHTML = '';
  const reorderable = order.filter(
    (id) => id !== 'issueId' && id !== 'actions' && COLUMN_DEFS[id]
  );
  reorderable.forEach((colId) => {
    const def = COLUMN_DEFS[colId];
    const li = document.createElement('li');
    li.setAttribute('draggable', 'true');
    li.setAttribute('data-col-id', colId);

    if (isOptionalColumn(colId)) {
      const checked = isColumnEnabled(colId, colSettings);
      li.innerHTML =
        `<span class="drag-handle">&#x2630;</span>` +
        `<label><input type="checkbox" data-col-toggle="${colId}" ${checked ? 'checked' : ''}> ${def.label}</label>`;
      if (!checked) li.classList.add('col-disabled');
      li.querySelector<HTMLInputElement>('input')?.addEventListener(
        'change',
        (e) => {
          li.classList.toggle(
            'col-disabled',
            !(e.target as HTMLInputElement).checked
          );
        }
      );
    } else {
      li.classList.add('col-always');
      li.innerHTML = `<span class="drag-handle">&#x2630;</span> ${def.label}`;
    }
    ul.appendChild(li);
  });
  initDragAndDrop(ul as HTMLUListElement);
}

function isColumnEnabled(
  colId: ColumnId,
  colSettings: PopupColumnVisibility | undefined
) {
  if (!colSettings) return !isOptionalColumn(colId);
  if (!isOptionalColumn(colId)) return true;
  return !!colSettings[visibilityKey(colId)];
}

function initDragAndDrop(ul: HTMLUListElement) {
  // The gear modal re-renders the same list element on each open, so only bind once.
  if (ul.dataset.dragAndDropInitialized === 'true') return;
  ul.dataset.dragAndDropInitialized = 'true';

  let draggedItem: HTMLLIElement | null = null;
  ul.addEventListener('dragstart', (e: DragEvent) => {
    const li = e.target instanceof Element ? e.target.closest('li') : null;
    draggedItem = li;
    if (draggedItem) draggedItem.classList.add('dragging');
  });
  ul.addEventListener('dragend', () => {
    if (draggedItem) draggedItem.classList.remove('dragging');
    ul.querySelectorAll('li').forEach((li) => li.classList.remove('drag-over'));
    draggedItem = null;
  });
  ul.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault();
    const target = e.target instanceof Element ? e.target.closest('li') : null;
    if (!target || target === draggedItem) return;
    ul.querySelectorAll('li').forEach((li) => li.classList.remove('drag-over'));
    target.classList.add('drag-over');
  });
  ul.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault();
    const target = e.target instanceof Element ? e.target.closest('li') : null;
    if (!target || target === draggedItem || !draggedItem) return;
    const items = Array.from(ul.querySelectorAll('li'));
    const dragIdx = items.indexOf(draggedItem);
    const dropIdx = items.indexOf(target);
    if (dragIdx < dropIdx) {
      target.after(draggedItem);
    } else {
      target.before(draggedItem);
    }
    ul.querySelectorAll('li').forEach((li) => li.classList.remove('drag-over'));
  });
}

function readGearColumnOrder(): ColumnId[] {
  const lis = document.querySelectorAll<HTMLElement>('#gear-column-order li');
  const middle = Array.from(lis, (li) => li.getAttribute('data-col-id')).filter(
    (id): id is ColumnId => id != null && isColumnId(id)
  );
  return ['issueId', ...middle, 'actions'];
}

function readGearColumnVisibility(): PopupColumnVisibility {
  const toggles = document.querySelectorAll<HTMLInputElement>(
    '#gear-column-order input[data-col-toggle]'
  );
  const cols: Partial<PopupColumnVisibility> = {};
  toggles.forEach((cb) => {
    const id = cb.getAttribute('data-col-toggle');
    if (!id || !isColumnId(id)) return;
    cols[visibilityKey(id)] = cb.checked;
  });
  return Object.assign(
    {},
    DEFAULT_TIME_TABLE_COLUMNS,
    cols
  ) as PopupColumnVisibility;
}

function escapeHTML(str: string) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

function buildHTML(
  tag: string,
  html: string | null | undefined,
  attrs?: Record<string, string> | null
) {
  const element = document.createElement(tag);
  if (html) element.innerHTML = html;
  Object.keys(attrs || {}).forEach((attr) => {
    element.setAttribute(attr, (attrs as Record<string, string>)[attr]);
  });
  return element;
}

function buildGearButton(): HTMLButtonElement {
  const gearBtn = document.createElement('button');
  gearBtn.type = 'button';
  gearBtn.className = 'gear-btn';
  gearBtn.title = 'Time Table settings';
  gearBtn.setAttribute('aria-expanded', 'false');
  gearBtn.setAttribute('aria-controls', 'gear-modal-backdrop');
  gearBtn.innerHTML = GEAR_ICON_SVG;
  gearBtn.addEventListener('click', () => openGearModal());
  return gearBtn;
}

async function getSharedJira(options: PopupOptions): Promise<JiraApiClient> {
  const jiraConfig = {
    jiraType: options.jiraType,
    baseUrl: options.baseUrl,
    username: options.username,
    apiToken: options.apiToken,
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

function getJiraErrorStatusCode(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = message.match(/Error (\d+):/);
  return statusMatch ? parseInt(statusMatch[1], 10) : null;
}

function isJiraAuthError(error: unknown) {
  const statusCode = getJiraErrorStatusCode(error);
  return statusCode === 401 || statusCode === 403;
}

function getIssuesCacheKey(options: PopupOptions) {
  return `issuesCache:${options.baseUrl}:${options.jql}`;
}

function removeTimeTableCacheEntries(baseUrl: string) {
  return new Promise<void>((resolve) => {
    try {
      chrome.storage.local.get(null, (items) => {
        const prefix = baseUrl ? `issuesCache:${baseUrl}:` : 'issuesCache:';
        const keys = Object.keys(items || {}).filter((key) =>
          key.startsWith(prefix)
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

function clearTimeTableRows(options: PopupOptions) {
  clearMessages();
  const emptyResponse = { data: [], total: 0 };
  currentIssuesResponse = emptyResponse;
  currentIssuesResponseVersion += 1;
  currentPopupOptions = options;
  drawIssuesTable(emptyResponse, options);
  drawWeeklyView(emptyResponse, options);
}

async function clearCachedTimeTableData(options: PopupOptions) {
  await removeTimeTableCacheEntries(options.baseUrl);
  clearTimeTableRows(options);
}

function shouldShowPopupFetchError(error: unknown, showedCached: boolean) {
  if (!showedCached) return true;

  if (isJiraAuthError(error)) {
    return true;
  }

  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    message.includes('fetch') ||
    message.includes('network') ||
    message.includes('cors')
  );
}

async function handleTimeTableFetchError(
  error: unknown,
  options: PopupOptions,
  defaultMessage: string,
  showedCached = false
) {
  if (isJiraAuthError(error)) {
    await clearCachedTimeTableData(options);
  }

  if (shouldShowPopupFetchError(error, showedCached)) {
    window.JiraErrorHandler?.handleJiraError(error, defaultMessage, 'popup');
  }
}

async function init(options: PopupOptions) {
  console.log('Options received:', options);

  try {
    // Initialize the JIRA API with the provided options
    const JIRA = await getSharedJira(options);
    console.log('JIRA API Object:', JIRA);

    if (!JIRA || typeof JIRA.getIssues !== 'function') {
      console.error('JIRA API instantiation failed: Methods missing', JIRA);
      displayError(
        'JIRA API setup failed. Please check your settings and ensure all required fields (Base URL, Username, API Token) are correctly configured. Go to Settings to verify your configuration.'
      );
      return;
    }

    // Try to show cached data immediately for instant popup
    const cacheKey = getIssuesCacheKey(options);
    let showedCached = false;

    try {
      const cached = await new Promise<CachedIssuesResponse | undefined>(
        (resolve) => {
          chrome.storage.local.get([cacheKey], (items) =>
            resolve(items[cacheKey] as CachedIssuesResponse | undefined)
          );
        }
      );

      if (cached && cached.data && Date.now() - cached.ts < 5 * 60 * 1000) {
        // Show cached data immediately (if less than 5 min old)
        console.log('Showing cached issues');
        await onFetchSuccess(cached.data, options);
        showedCached = true;
      }
    } catch (e) {
      console.warn('Cache read failed', e);
    }

    // Show loader only if we didn't show cached data
    if (!showedCached) {
      toggleVisibility('div[id=loader-container]');
    }

    try {
      // Fetch fresh issues from Jira
      const issuesResponse = await JIRA.getIssues(0, options.jql);

      // Cache the response
      try {
        chrome.storage.local.set({
          [cacheKey]: { data: issuesResponse, ts: Date.now() },
        });
      } catch (e) {
        console.warn('Cache write failed', e);
      }

      // Update UI with fresh data
      await onFetchSuccess(issuesResponse, options);
    } catch (error) {
      console.error('Error fetching issues:', error);
      await handleTimeTableFetchError(
        error,
        options,
        'Failed to fetch issues from JIRA',
        showedCached
      );
    } finally {
      if (!showedCached) {
        toggleVisibility('div[id=loader-container]');
      }
    }
  } catch (error) {
    console.error('Error initializing JIRA API:', error);
    window.JiraErrorHandler?.handleJiraError(
      error,
      'Failed to connect to JIRA',
      'popup'
    );
  }
}

function onFetchSuccess(
  issuesResponse: JiraIssuesResponse,
  options: PopupOptions
) {
  clearMessages();
  currentIssuesResponse = issuesResponse;
  currentIssuesResponseVersion += 1;
  currentPopupOptions = options;
  console.log('Fetched issues:', issuesResponse);
  drawIssuesTable(issuesResponse, options);
  if (activeTimeEntryView === 'week') {
    void renderCurrentWeeklyView();
  }
}

function getWorklog(issueId: string, JIRA: JiraApiClient) {
  const totalTime = document.querySelector<HTMLDivElement>(
    `div.issue-total-time-spent[data-issue-id="${issueId}"]`
  );
  if (!totalTime) return;
  const loader = totalTime.previousElementSibling as HTMLDivElement | null;

  if (loader) loader.style.display = 'block';
  totalTime.style.display = 'none';

  JIRA.getIssueWorklog(issueId)
    .then((response) => onWorklogFetchSuccess(response, totalTime, loader))
    .catch((error) => onWorklogFetchError(error, totalTime, loader));
}

function sumWorklogs(worklogs: JiraWorklog[]) {
  const totalSeconds = sumWorklogSeconds(worklogs);
  const totalHours = (totalSeconds / 3600).toFixed(1);
  return `${totalHours} hrs`;
}

function onWorklogFetchSuccess(
  response: { worklogs: JiraWorklog[] },
  totalTime: HTMLDivElement,
  loader: HTMLDivElement | null
) {
  try {
    totalTime.innerText = sumWorklogs(response.worklogs);
  } catch (error) {
    const stack = error instanceof Error ? error.stack : undefined;
    console.error(
      `Error in summing worklogs: ${stack ?? getErrorMessage(error)}`
    );
    totalTime.innerText = '0 hrs';
  }
  if (totalTime) totalTime.style.display = 'block';
  if (loader) loader.style.display = 'none';
  document
    .querySelectorAll<HTMLInputElement>(
      'input.issue-time-input, input.issue-comment-input'
    )
    .forEach((input) => (input.value = ''));
}

function onWorklogFetchError(
  error: unknown,
  totalTime: HTMLDivElement,
  loader: HTMLDivElement | null
) {
  if (totalTime) totalTime.style.display = 'block';
  if (loader) loader.style.display = 'none';
  window.JiraErrorHandler?.handleJiraError(
    error,
    'Failed to fetch worklog data',
    'popup'
  );
}

async function logTimeClick(evt: Event) {
  clearMessages(); // Clear previous error and success messages

  const issueId = (evt.target as HTMLElement | null)?.getAttribute(
    'data-issue-id'
  );
  const timeInput = document.querySelector<HTMLInputElement>(
    `input.issue-time-input[data-issue-id="${issueId}"]`
  );
  const dateInput = document.querySelector<HTMLInputElement>(
    `input.issue-log-date-input[data-issue-id="${issueId}"]`
  );
  const commentInput = document.querySelector<HTMLInputElement>(
    `input.issue-comment-input[data-issue-id="${issueId}"]`
  );
  const totalTimeSpans = document.querySelector<HTMLDivElement>(
    `div.issue-total-time-spent[data-issue-id="${issueId}"]`
  );
  const loader = document.querySelector<HTMLDivElement>(
    `div.loader-mini[data-issue-id="${issueId}"]`
  );

  if (!issueId || !dateInput) {
    return;
  }

  console.log(`Processing issue ID: ${issueId}`);

  if (!timeInput || !timeInput.value) {
    displayError(
      'Time field is required. Please enter the time you want to log (e.g., 2h, 30m, 1d).'
    );
    return;
  }

  if (!isValidWorklogDuration(timeInput.value, { allowWeeks: true })) {
    displayError(getWorklogDurationValidationMessage({ allowWeeks: true }));
    return;
  }

  const timeSpentSeconds = parseWorklogDurationToSeconds(timeInput.value, {
    allowWeeks: true,
  });
  if (isNaN(timeSpentSeconds) || timeSpentSeconds <= 0) {
    displayError(
      'Invalid time value. Please enter a positive time amount using valid units (d=days, h=hours, m=minutes).'
    );
    return;
  }

  if (totalTimeSpans && loader) {
    totalTimeSpans.innerText = '';
    totalTimeSpans.style.display = 'none';
    loader.style.display = 'block';
  }

  const startedTime = buildWorklogStartedTimestamp(dateInput.value);

  try {
    const options = await new Promise<PopupOptions>((resolve, reject) =>
      chrome.storage.sync.get(
        ['baseUrl', 'apiToken', 'jql', 'username', 'jiraType'],
        (items) => {
          if (chrome.runtime.lastError) {
            return reject(chrome.runtime.lastError);
          }
          resolve(items as unknown as PopupOptions);
        }
      )
    );

    const JIRA = await getSharedJira(options);

    const commentValue = commentInput ? commentInput.value : '';
    console.log(
      `Update worklog details: issueId=${issueId}, timeSpentSeconds=${timeSpentSeconds}, startedTime=${startedTime}, comment=${commentValue}`
    );

    const result = await JIRA.updateWorklog(
      issueId,
      timeSpentSeconds,
      startedTime,
      commentValue
    );

    // Handle successful response
    console.log('Worklog successfully updated:', result);

    // Display success message with the logged time
    showSuccessAnimation(issueId, timeInput.value);

    timeInput.value = '';
    if (commentInput) commentInput.value = '';

    // Fetch updated worklogs so that the displayed time is consistent
    getWorklog(issueId, JIRA);
  } catch (error) {
    console.error(`Error in logTimeClick function: ${getErrorMessage(error)}`);

    if (totalTimeSpans) totalTimeSpans.style.display = 'block';
    if (loader) loader.style.display = 'none';

    // Check for specific known issues before calling handleJiraError
    if ((error as { status?: number } | null)?.status === 200) {
      // Worklog update was successful but something else caused an error
      displaySuccess(
        'Successfully logged: ' +
          timeInput.value +
          ' but encountered an issue afterward.'
      );
      showErrorAnimation(issueId);
    } else {
      window.JiraErrorHandler?.handleJiraError(
        error,
        `Failed to log time for issue ${issueId}`,
        'popup'
      );
      showErrorAnimation(issueId);
    }
  }
}

/***************
HTML Interaction Helpers
****************/
function toggleVisibility(query: string) {
  const element = document.querySelector(query) as HTMLElement | null;
  if (element) {
    element.style.display =
      element.style.display === 'none' || element.style.display === ''
        ? 'block'
        : 'none';
  } else {
    console.warn(`Element not found for query: ${query}`);
  }
}

function drawIssuesTable(
  issuesResponse: JiraIssuesResponse,
  options: PopupOptions
) {
  const logTable = document.getElementById('jira-log-time-table');
  if (!logTable) return;
  const visibleCols = getVisibleColumns(
    options.timeTableColumnOrder,
    options.timeTableColumns
  );
  const widths = getColumnWidths(visibleCols);

  // Build <thead> dynamically
  const theadTr = logTable.querySelector('thead tr');
  if (!theadTr) return;
  theadTr.innerHTML = '';
  visibleCols.forEach((colId) => {
    const def = COLUMN_DEFS[colId];
    const th = document.createElement('th');
    th.setAttribute('data-col', colId);
    th.style.width = widths[colId];
    if (colId === 'issueId') {
      th.innerHTML = `<img src="${chrome.runtime.getURL('src/icons/jira_logo.png')}" alt="Jira Logo" style="vertical-align:middle;margin-right:8px;width:16px;height:16px;"> Jira ID`;
    } else if (colId === 'actions') {
      th.appendChild(buildGearButton());
    } else {
      th.textContent = def.label;
    }
    theadTr.appendChild(th);
  });

  // Remove any existing <tbody>
  const oldTbody = logTable.querySelector('tbody');
  if (oldTbody) oldTbody.remove();

  const newTbody = document.createElement('tbody');
  const issues = issuesResponse.data || [];
  const sortedIssues = sortIssues(
    issues,
    options.starredIssues,
    options.timeTableSort
  );

  sortedIssues.forEach((issue) => {
    const row = generateLogTableRow(issue, options, visibleCols);
    newTbody.appendChild(row);
  });

  logTable.appendChild(newTbody);

  document
    .querySelectorAll<HTMLInputElement>('.issue-comment-input')
    .forEach((input) => {
      input.style.position = 'relative';
      input.style.zIndex = '1';
      initializeWorklogSuggestions(input);
    });
}

function drawWeeklyView(
  issuesResponse: JiraIssuesResponse,
  options: PopupOptions
) {
  updateWeekRangeLabel();

  const weeklyTable = document.getElementById('weekly-log-table');
  if (!weeklyTable) return;

  const thead = weeklyTable.querySelector('thead');
  const tbody = weeklyTable.querySelector('tbody');
  const tfoot = weeklyTable.querySelector('tfoot');
  if (!thead || !tbody || !tfoot) return;

  const weekDates = getWeekDates();
  thead.innerHTML = '';
  tbody.innerHTML = '';
  tfoot.innerHTML = '';

  const headerRow = document.createElement('tr');
  const issueHeading = document.createElement('th');
  issueHeading.className = 'weekly-issue-heading';
  issueHeading.textContent = 'Issue';
  headerRow.appendChild(issueHeading);

  weekDates.forEach((date, index) => {
    const dayHeading = document.createElement('th');
    dayHeading.className = 'weekly-day-heading';
    const dayLabel = document.createElement('span');
    dayLabel.className = 'weekly-day-label';
    dayLabel.textContent = WEEKDAY_LABELS[index];
    const dateLabel = document.createElement('span');
    dateLabel.className = 'weekly-date-label';
    dateLabel.textContent = formatShortDate(date);
    dayHeading.appendChild(dayLabel);
    dayHeading.appendChild(dateLabel);
    headerRow.appendChild(dayHeading);
  });

  const totalHeading = document.createElement('th');
  totalHeading.className = 'weekly-total-heading';
  totalHeading.textContent = 'Total';
  headerRow.appendChild(totalHeading);

  const actionHeading = document.createElement('th');
  actionHeading.className = 'weekly-action-heading';
  actionHeading.textContent = '';
  headerRow.appendChild(actionHeading);
  thead.appendChild(headerRow);

  const issues = sortIssues(
    issuesResponse.data || [],
    options.starredIssues,
    options.timeTableSort
  );
  if (issues.length === 0) {
    const emptyRow = document.createElement('tr');
    const emptyCell = document.createElement('td');
    emptyCell.className = 'weekly-empty';
    emptyCell.colSpan = weekDates.length + 3;
    emptyCell.textContent = 'No issues match the current JQL.';
    emptyRow.appendChild(emptyCell);
    tbody.appendChild(emptyRow);
  } else {
    issues.forEach((issue) => {
      tbody.appendChild(generateWeeklyIssueRow(issue, options, weekDates));
    });
  }

  const footerRow = document.createElement('tr');
  const labelCell = document.createElement('td');
  labelCell.textContent = 'Daily totals';
  labelCell.className = 'weekly-row-total';
  footerRow.appendChild(labelCell);

  weekDates.forEach((date) => {
    const totalCell = document.createElement('td');
    totalCell.className = 'weekly-day-total';
    totalCell.setAttribute('data-weekly-total-date', formatWeeklyDateKey(date));
    totalCell.textContent = '0h';
    footerRow.appendChild(totalCell);
  });

  const grandTotalCell = document.createElement('td');
  grandTotalCell.className = 'weekly-grand-total';
  grandTotalCell.textContent = '0h';
  footerRow.appendChild(grandTotalCell);
  footerRow.appendChild(document.createElement('td'));
  tfoot.appendChild(footerRow);

  weeklyTable
    .querySelectorAll<HTMLInputElement>('.weekly-comment-input')
    .forEach((input) => initializeWorklogSuggestions(input));
  updateWeeklyTotals();
}

function drawWeeklyLoadingState(
  issuesResponse: JiraIssuesResponse,
  options: PopupOptions
) {
  drawWeeklyView(issuesResponse, options);

  const weeklyTable = document.getElementById('weekly-log-table');
  const tbody = weeklyTable?.querySelector('tbody');
  if (!tbody) return;

  if ((issuesResponse.data || []).length === 0) {
    tbody.innerHTML = '';
  }

  const loadingRow = document.createElement('tr');
  const loadingCell = document.createElement('td');
  loadingCell.className = 'weekly-empty';
  loadingCell.colSpan = WEEKDAY_LABELS.length + 3;
  loadingCell.textContent = 'Loading logged issues for this week...';
  loadingRow.appendChild(loadingCell);
  tbody.appendChild(loadingRow);
}

function generateWeeklyIssueRow(
  issue: JiraIssue,
  options: PopupOptions,
  weekDates: Date[]
): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.className = 'weekly-issue-row';
  row.setAttribute('data-weekly-issue-id', issue.key);

  const issueCell = document.createElement('td');
  issueCell.className = 'weekly-issue-cell';
  const issueLink = document.createElement('a');
  issueLink.className = 'weekly-issue-key';
  issueLink.href = getJiraIssueUrl(issue.key, options);
  issueLink.target = '_blank';
  issueLink.textContent = issue.key;
  const summary = document.createElement('div');
  summary.className = 'weekly-issue-summary truncate';
  summary.textContent = issue.fields.summary ?? '';
  issueCell.appendChild(issueLink);
  issueCell.appendChild(summary);
  row.appendChild(issueCell);

  weekDates.forEach((date) => {
    const dateValue = formatWeeklyDateKey(date);
    const cell = document.createElement('td');
    const entry = document.createElement('div');
    entry.className = 'weekly-entry';

    const loggedTime = document.createElement('div');
    loggedTime.className = 'weekly-logged-time';
    loggedTime.setAttribute('data-weekly-logged-issue-id', issue.key);
    loggedTime.setAttribute('data-weekly-logged-date', dateValue);
    loggedTime.setAttribute('data-weekly-logged-seconds', '0');
    loggedTime.textContent = '';

    const timeInput = document.createElement('input');
    timeInput.className = 'weekly-time-input';
    timeInput.placeholder = '1h';
    timeInput.setAttribute('data-weekly-issue-id', issue.key);
    timeInput.setAttribute('data-weekly-date', dateValue);
    timeInput.addEventListener('input', updateWeeklyTotals);

    const commentInput = document.createElement('textarea');
    commentInput.className = 'weekly-comment-input';
    commentInput.placeholder = 'Worklog comment';
    commentInput.setAttribute('data-weekly-issue-id', issue.key);
    commentInput.setAttribute('data-weekly-date', dateValue);

    entry.appendChild(loggedTime);
    entry.appendChild(timeInput);
    entry.appendChild(commentInput);
    cell.appendChild(entry);
    row.appendChild(cell);
  });

  const rowTotal = document.createElement('td');
  rowTotal.className = 'weekly-row-total';
  rowTotal.setAttribute('data-weekly-row-total', issue.key);
  rowTotal.textContent = '0h';
  row.appendChild(rowTotal);

  const actionCell = document.createElement('td');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'weekly-log-btn';
  button.setAttribute('data-weekly-issue-id', issue.key);
  button.textContent = 'Log';
  button.addEventListener('click', logWeeklyIssueClick);
  actionCell.appendChild(button);
  row.appendChild(actionCell);

  return row;
}

function applyWeeklyWorklogTotals(totals: WeeklyWorklogTotals) {
  const table = document.getElementById('weekly-log-table');
  if (!table) return;

  table.querySelectorAll<HTMLElement>('.weekly-logged-time').forEach((cell) => {
    const issueId = cell.getAttribute('data-weekly-logged-issue-id') || '';
    const date = cell.getAttribute('data-weekly-logged-date') || '';
    const seconds = totals[issueId]?.[date] || 0;
    cell.setAttribute('data-weekly-logged-seconds', String(seconds));
    cell.textContent = seconds > 0 ? `Logged ${formatInputTotal(seconds)}` : '';
  });

  updateWeeklyTotals();
}

function addLoggedWeeklyEntriesToRow(
  row: HTMLTableRowElement,
  entries: WeeklyEntry[]
) {
  entries.forEach((entry) => {
    const loggedTime = row.querySelector<HTMLElement>(
      `.weekly-logged-time[data-weekly-logged-date="${entry.date}"]`
    );
    if (!loggedTime) return;

    const previousSeconds = Number(
      loggedTime.getAttribute('data-weekly-logged-seconds') || '0'
    );
    const nextSeconds =
      (Number.isFinite(previousSeconds) ? previousSeconds : 0) + entry.seconds;
    loggedTime.setAttribute('data-weekly-logged-seconds', String(nextSeconds));
    loggedTime.textContent =
      nextSeconds > 0 ? `Logged ${formatInputTotal(nextSeconds)}` : '';
  });
}

function clearWeeklyEntryInputs(row: HTMLTableRowElement, date: string) {
  row
    .querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement
    >(`[data-weekly-date="${date}"]`)
    .forEach((input) => {
      input.value = '';
    });
}

function addLoggedSecondsToTableIssueTotal(issueId: string, seconds: number) {
  const totalTime = document.querySelector<HTMLDivElement>(
    `div.issue-total-time-spent[data-issue-id="${issueId}"]`
  );
  const loader = totalTime?.previousElementSibling as HTMLDivElement | null;
  const issue = currentIssuesResponse?.data?.find(
    (currentIssue) => currentIssue.key === issueId
  );
  const currentSeconds = issue
    ? getIssueTotalSeconds(issue)
    : parseFloat(totalTime?.textContent || '') * 3600;
  const nextSeconds =
    (Number.isFinite(currentSeconds) ? currentSeconds : 0) + seconds;

  if (issue) {
    issue.fields.timespent = nextSeconds;
  }

  if (loader) loader.style.display = 'none';
  if (totalTime) {
    totalTime.innerText = `${(nextSeconds / 3600).toFixed(1)} hrs`;
    totalTime.style.display = 'block';
  }
}

function updateWeeklyTotals() {
  const table = document.getElementById('weekly-log-table');
  if (!table) return;

  const dayTotals = new Map<string, number>();
  let grandTotal = 0;

  table
    .querySelectorAll<HTMLTableRowElement>('.weekly-issue-row')
    .forEach((row) => {
      let rowSeconds = 0;
      row
        .querySelectorAll<HTMLElement>('.weekly-logged-time')
        .forEach((loggedTime) => {
          const seconds = Number(
            loggedTime.getAttribute('data-weekly-logged-seconds') || '0'
          );
          const date = loggedTime.getAttribute('data-weekly-logged-date') || '';
          if (!Number.isFinite(seconds) || seconds <= 0) return;

          rowSeconds += seconds;
          dayTotals.set(date, (dayTotals.get(date) || 0) + seconds);
        });

      row
        .querySelectorAll<HTMLInputElement>('.weekly-time-input')
        .forEach((input) => {
          const duration = input.value.trim();
          if (
            !duration ||
            !isValidWorklogDuration(duration, { allowWeeks: true })
          ) {
            return;
          }

          const seconds = parseWorklogDurationToSeconds(duration, {
            allowWeeks: true,
          });
          const date = input.getAttribute('data-weekly-date') || '';
          rowSeconds += seconds;
          dayTotals.set(date, (dayTotals.get(date) || 0) + seconds);
        });

      const rowTotal = row.querySelector<HTMLElement>('.weekly-row-total');
      if (rowTotal) rowTotal.textContent = formatInputTotal(rowSeconds);
      grandTotal += rowSeconds;
    });

  table
    .querySelectorAll<HTMLElement>('[data-weekly-total-date]')
    .forEach((cell) => {
      const date = cell.getAttribute('data-weekly-total-date') || '';
      cell.textContent = formatInputTotal(dayTotals.get(date) || 0);
    });

  const grandTotalCell = table.querySelector<HTMLElement>(
    '.weekly-grand-total'
  );
  if (grandTotalCell) {
    grandTotalCell.textContent = formatInputTotal(grandTotal);
  }
}

function getWeeklyEntriesForRow(row: HTMLTableRowElement): WeeklyEntry[] {
  const entries: WeeklyEntry[] = [];
  row
    .querySelectorAll<HTMLInputElement>('.weekly-time-input')
    .forEach((timeInput) => {
      const duration = timeInput.value.trim();
      if (!duration) return;

      const date = timeInput.getAttribute('data-weekly-date') || '';
      const commentInput = row.querySelector<HTMLTextAreaElement>(
        `.weekly-comment-input[data-weekly-date="${date}"]`
      );

      entries.push({
        date,
        duration,
        comment: commentInput?.value ?? '',
        seconds: parseWorklogDurationToSeconds(duration, { allowWeeks: true }),
      });
    });
  return entries;
}

async function logWeeklyIssueClick(evt: Event) {
  clearMessages();

  const button = evt.currentTarget as HTMLButtonElement | null;
  const issueId = button?.getAttribute('data-weekly-issue-id');
  const row = issueId
    ? document.querySelector<HTMLTableRowElement>(
        `tr[data-weekly-issue-id="${issueId}"]`
      )
    : null;

  if (!button || !issueId || !row) return;

  const entries = getWeeklyEntriesForRow(row);
  if (entries.length === 0) {
    displayError(`Enter at least one time value for ${issueId}.`);
    return;
  }

  for (const entry of entries) {
    if (!entry.date) {
      displayError(`Missing a worklog date for ${issueId}.`);
      return;
    }

    if (!isValidWorklogDuration(entry.duration, { allowWeeks: true })) {
      displayError(
        `${issueId} on ${entry.date}: ${getWorklogDurationValidationMessage({
          allowWeeks: true,
        })}`
      );
      return;
    }

    if (isNaN(entry.seconds) || entry.seconds <= 0) {
      displayError(
        `Enter a positive time value for ${issueId} on ${entry.date}.`
      );
      return;
    }
  }

  button.disabled = true;
  const originalLabel = button.textContent || 'Log';
  button.textContent = '...';

  try {
    const options = currentPopupOptions ?? (await getStoredPopupOptions());
    const JIRA = await getSharedJira(options);
    const postedEntries: WeeklyEntry[] = [];

    for (const entry of entries) {
      await JIRA.updateWorklog(
        issueId,
        entry.seconds,
        buildWorklogStartedTimestamp(entry.date),
        entry.comment
      );

      postedEntries.push(entry);
      clearWeeklyEntryInputs(row, entry.date);
      addLoggedWeeklyEntriesToRow(row, [entry]);
      addLoggedSecondsToTableIssueTotal(issueId, entry.seconds);
      clearWeeklyWorklogCaches();
      updateWeeklyTotals();
    }

    const totalSeconds = postedEntries.reduce(
      (sum, entry) => sum + entry.seconds,
      0
    );
    displaySuccess(
      `Logged ${formatInputTotal(totalSeconds)} across ${
        postedEntries.length
      } day${postedEntries.length === 1 ? '' : 's'} for ${issueId}.`
    );
    showWeeklyRowAnimation(row, true);
  } catch (error) {
    window.JiraErrorHandler?.handleJiraError(
      error,
      `Failed to log weekly time for issue ${issueId}`,
      'popup'
    );
    showWeeklyRowAnimation(row, false);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function showWeeklyRowAnimation(row: HTMLTableRowElement, success: boolean) {
  row.classList.add(success ? 'success-highlight' : 'error-highlight');

  setTimeout(() => {
    row.classList.add('fade-highlight');
    row.classList.remove(success ? 'success-highlight' : 'error-highlight');
  }, 4000);

  setTimeout(() => {
    row.classList.remove('fade-highlight');
  }, 5000);
}

function getStoredPopupOptions(): Promise<PopupOptions> {
  return new Promise<PopupOptions>((resolve, reject) =>
    chrome.storage.sync.get(
      ['baseUrl', 'apiToken', 'jql', 'username', 'jiraType'],
      (items) => {
        if (chrome.runtime.lastError) {
          return reject(chrome.runtime.lastError);
        }
        resolve(items as unknown as PopupOptions);
      }
    )
  );
}

// ⭐️ utility function that sorts starred issues to top
function sortIssues(
  issues: JiraIssue[],
  starredIssues: Record<string, number>,
  sortMode: TimeTableSort
) {
  return issues
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => {
      const starCompare =
        Number(!!starredIssues[b.issue.key]) -
        Number(!!starredIssues[a.issue.key]);
      if (starCompare !== 0) return starCompare;

      const sortCompare = compareIssues(a.issue, b.issue, sortMode);
      if (sortCompare !== 0) return sortCompare;

      return a.index - b.index;
    })
    .map(({ issue }) => issue);
}

function compareIssues(a: JiraIssue, b: JiraIssue, sortMode: TimeTableSort) {
  switch (sortMode) {
    case 'dateNewest':
      return getIssueDateMs(b) - getIssueDateMs(a);
    case 'dateOldest':
      return getIssueDateMs(a) - getIssueDateMs(b);
    case 'totalDesc':
      return getIssueTotalSeconds(b) - getIssueTotalSeconds(a);
    case 'totalAsc':
      return getIssueTotalSeconds(a) - getIssueTotalSeconds(b);
    case 'priority':
      return getIssuePriorityRank(b) - getIssuePriorityRank(a);
    default:
      return 0;
  }
}

function getIssueDateMs(issue: JiraIssue) {
  const date = issue.fields.updated || issue.fields.created || '';
  const parsed = Date.parse(date);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getIssueTotalSeconds(issue: JiraIssue) {
  if (typeof issue.fields.timespent === 'number') {
    return issue.fields.timespent;
  }

  return sumWorklogSeconds(issue.fields.worklog?.worklogs || []);
}

function getIssuePriorityRank(issue: JiraIssue) {
  const priorityName = (issue.fields.priority?.name || '').toLowerCase();
  if (priorityName in PRIORITY_RANKS) return PRIORITY_RANKS[priorityName];

  return 0;
}

// ===== Cell builders (one per column id) =====
type CellBuilder = (issue: JiraIssue, options: PopupOptions) => HTMLElement;

const cellBuilders: Record<ColumnId, CellBuilder> = {
  issueId(issue, options) {
    const id = issue.key;
    const td = buildHTML('td', '', {
      class: 'issue-id',
      'data-col': 'issueId',
      'data-issue-id': id,
    });
    const isStarred = !!options.starredIssues[id];
    const starIcon = buildHTML('span', '', { class: 'star-icon' });
    starIcon.textContent = isStarred ? '\u2605' : '\u2606';
    starIcon.classList.add(isStarred ? 'starred' : 'unstarred');
    starIcon.addEventListener('click', () => toggleStar(id, options));
    td.appendChild(starIcon);
    td.appendChild(document.createTextNode(' '));

    const baseUrl = options.baseUrl.startsWith('http')
      ? options.baseUrl
      : `https://${options.baseUrl}`;
    const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const jiraLink = buildHTML('a', id, {
      href: `${normalizedBaseUrl}browse/${id}`,
      target: '_blank',
      'data-issue-id': id,
    });
    let tooltipTimeout: ReturnType<typeof setTimeout> | undefined;
    jiraLink.addEventListener('mouseover', async (e: MouseEvent) => {
      if (tooltipTimeout) {
        clearTimeout(tooltipTimeout);
        tooltipTimeout = undefined;
      }
      const existingTooltip = document.querySelector('.worklog-tooltip');
      if (existingTooltip) existingTooltip.remove();
      const tooltip = document.createElement('div');
      tooltip.className = 'worklog-tooltip';
      tooltip.innerHTML = 'Loading worklogs...';
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      tooltip.style.left = `${Math.max(10, Math.min(rect.left, window.innerWidth - 370))}px`;
      tooltip.style.top =
        spaceBelow >= 150 || spaceBelow >= rect.top
          ? `${rect.bottom + 5}px`
          : `${rect.top - 155}px`;
      document.body.appendChild(tooltip);
      try {
        const JIRA = await getSharedJira(options);
        const worklogResponse = await JIRA.getIssueWorklog(id);
        const recentLogs = worklogResponse.worklogs
          .slice(-5)
          .reverse()
          .map((log) => {
            const date = log.started
              ? new Date(log.started).toLocaleDateString()
              : '';
            const hours = (log.timeSpentSeconds / 3600).toFixed(1);
            const comment =
              typeof log.comment === 'string'
                ? log.comment
                : log.comment?.content?.[0]?.content?.[0]?.text || 'No comment';
            const author =
              log.author?.displayName || log.author?.name || 'Unknown user';
            return `<div style="margin-bottom:4px;"><strong>${escapeHTML(date)}</strong> - ${escapeHTML(author)}<br>${escapeHTML(hours)}h - ${escapeHTML(comment)}</div>`;
          })
          .join('');
        tooltip.innerHTML = recentLogs || 'No recent worklogs';
      } catch {
        tooltip.innerHTML = 'Error loading worklogs';
      }
    });
    jiraLink.addEventListener('mouseout', () => {
      tooltipTimeout = setTimeout(() => {
        const t = document.querySelector('.worklog-tooltip');
        if (t) t.remove();
      }, 150);
    });
    td.appendChild(jiraLink);
    return td;
  },

  summary(issue, _options) {
    const td = buildHTML('td', null, {
      class: 'issue-summary truncate',
      'data-col': 'summary',
    });
    td.textContent = issue.fields.summary ?? '';
    return td;
  },

  status(issue, options) {
    const td = buildHTML('td', null, { 'data-col': 'status' });
    const statusName = issue.fields.status?.name || 'Unknown';
    const select = document.createElement('select');
    select.className = 'status-select';
    select.setAttribute('data-issue-id', issue.key);
    const currentOpt = document.createElement('option');
    currentOpt.value = '';
    currentOpt.textContent = statusName;
    currentOpt.selected = true;
    select.appendChild(currentOpt);
    loadTransitions(issue.key, select, statusName, options);
    td.appendChild(select);
    return td;
  },

  assignee(issue, options) {
    const td = buildHTML('td', null, { 'data-col': 'assignee' });
    const container = document.createElement('div');
    container.className = 'assignee-container';
    const assigneeName = issue.fields.assignee?.displayName || 'Unassigned';
    const input = document.createElement('input');
    input.className = 'assignee-input';
    input.value = assigneeName;
    input.setAttribute('data-issue-id', issue.key);
    input.setAttribute('data-current-assignee', assigneeName);
    const dropdown = document.createElement('ul');
    dropdown.className = 'assignee-dropdown';
    dropdown.style.display = 'none';
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    input.addEventListener('focus', () => input.select());
    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const query = input.value.trim();
        if (!query) {
          dropdown.style.display = 'none';
          return;
        }
        try {
          const JIRA = await getSharedJira(options);
          const users = await JIRA.searchAssignableUsers(issue.key, query, 5);
          dropdown.innerHTML = '';
          if (users.length === 0) {
            dropdown.style.display = 'none';
            return;
          }
          users.forEach((user) => {
            const li = document.createElement('li');
            const displayName = user.displayName ?? user.name ?? 'Unknown';
            li.textContent = displayName;
            li.addEventListener('mousedown', async (e) => {
              e.preventDefault();
              try {
                const J = await getSharedJira(options);
                const assigneeField =
                  options.jiraType === 'cloud'
                    ? { accountId: user.accountId ?? '' }
                    : { name: user.name ?? '' };
                await J.updateIssue(issue.key, { assignee: assigneeField });
                input.value = displayName;
                input.setAttribute('data-current-assignee', displayName);
                dropdown.style.display = 'none';
              } catch (err) {
                window.JiraErrorHandler?.handleJiraError(
                  err,
                  `Failed to assign ${issue.key}`,
                  'popup'
                );
              }
            });
            dropdown.appendChild(li);
          });
          dropdown.style.display = 'block';
        } catch {
          dropdown.style.display = 'none';
        }
      }, 300);
    });
    input.addEventListener('blur', () => {
      setTimeout(() => {
        dropdown.style.display = 'none';
        input.value =
          input.getAttribute('data-current-assignee') || 'Unassigned';
      }, 200);
    });
    container.appendChild(input);
    container.appendChild(dropdown);
    td.appendChild(container);
    return td;
  },

  total(issue, options) {
    const id = issue.key;
    const totalSecs = getIssueTotalSeconds(issue);
    const totalTime = (totalSecs / 3600).toFixed(1) + ' hrs';
    const td = buildHTML('td', null, {
      class: 'issue-total-time',
      'data-col': 'total',
    });
    const loader = buildHTML('div', '', {
      class: 'loader-mini',
      'data-issue-id': id,
    });
    const totalTimeDiv = buildHTML('div', totalTime, {
      class: 'issue-total-time-spent',
      'data-issue-id': id,
    });
    td.appendChild(loader);
    td.appendChild(totalTimeDiv);

    if (typeof issue.fields.timespent === 'number') {
      loader.style.display = 'none';
      return td;
    }

    (async () => {
      try {
        const JIRA = await getSharedJira(options);
        const resp = await JIRA.getIssueWorklog(id);
        const secs = resp.worklogs.reduce(
          (acc, wl) => acc + wl.timeSpentSeconds,
          0
        );
        totalTimeDiv.textContent = (secs / 3600).toFixed(1) + ' hrs';
      } catch {}
      loader.style.display = 'none';
    })();
    return td;
  },

  log(issue, _options) {
    const td = buildHTML('td', null, { 'data-col': 'log' });
    td.appendChild(
      buildHTML('input', null, {
        class: 'issue-time-input',
        'data-issue-id': issue.key,
        placeholder: 'Xhms',
      })
    );
    return td;
  },

  comment(issue, _options) {
    const td = buildHTML('td', null, { 'data-col': 'comment' });
    const container = buildHTML('div', null, {
      class: 'suggestion-container',
      style: 'position:relative;display:inline-block;width:100%;',
    });
    container.appendChild(
      buildHTML('input', null, {
        class: 'issue-comment-input',
        'data-issue-id': issue.key,
        placeholder: 'Worklog comment',
        style: 'width:100%;box-sizing:border-box;',
      })
    );
    container.appendChild(
      buildHTML('button', '1', { class: 'frequentWorklogDescription1' })
    );
    container.appendChild(
      buildHTML('button', '2', { class: 'frequentWorklogDescription2' })
    );
    td.appendChild(container);
    return td;
  },

  date(issue, _options) {
    const td = buildHTML('td', null, { 'data-col': 'date' });
    td.appendChild(
      buildHTML('input', null, {
        type: 'date',
        class: 'issue-log-date-input',
        value: new Date().toDateInputValue(),
        'data-issue-id': issue.key,
      })
    );
    return td;
  },

  actions(issue, _options) {
    const td = buildHTML('td', null, { 'data-col': 'actions' });
    const btn = buildHTML('input', null, {
      type: 'button',
      value: '\u21E1',
      class: 'issue-log-time-btn',
      'data-issue-id': issue.key,
    });
    btn.addEventListener('click', async (event) => await logTimeClick(event));
    td.appendChild(btn);
    return td;
  },
};

async function loadTransitions(
  issueKey: string,
  select: HTMLSelectElement,
  _currentStatusName: string,
  options: PopupOptions
) {
  try {
    const JIRA = await getSharedJira(options);
    const resp = await JIRA.getTransitions(issueKey);
    (resp.transitions || []).forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = '\u2192 ' + t.name;
      select.appendChild(opt);
    });
    select.onchange = async () => {
      const transitionId = select.value;
      if (!transitionId) return;
      try {
        select.disabled = true;
        const J = await getSharedJira(options);
        await J.transitionIssue(issueKey, transitionId);
        const rawLabel =
          select.options[select.selectedIndex]?.textContent ?? '';
        const newName = rawLabel.replace('\u2192 ', '');
        select.options[0].textContent = newName;
        select.selectedIndex = 0;
        // Reload transitions for the new state
        while (select.options.length > 1) select.remove(1);
        await loadTransitions(issueKey, select, newName, options);
      } catch (err) {
        window.JiraErrorHandler?.handleJiraError(
          err,
          `Failed to transition ${issueKey}`,
          'popup'
        );
        select.selectedIndex = 0;
        select.disabled = false;
      }
    };
  } catch (err) {
    console.warn(`Failed to load transitions for ${issueKey}:`, err);
    select.disabled = true;
    select.title =
      'Could not load transitions — you may lack permission for this issue';
  }
}

function generateLogTableRow(
  issue: JiraIssue,
  options: PopupOptions,
  visibleCols: ColumnId[]
) {
  const row = buildHTML('tr', null, { 'data-issue-id': issue.key });
  visibleCols.forEach((colId) => {
    row.appendChild(cellBuilders[colId](issue, options));
  });
  return row;
}

function displaySuccess(message: string) {
  const success = document.getElementById('success');
  if (success) {
    success.innerText = message;
    success.style.display = 'block';
    // Hide error message on success
    const error = document.getElementById('error');
    if (error) error.style.display = 'none';
  } else {
    console.warn('Success element not found');
  }
}

function displayError(message: string) {
  const error = document.getElementById('error');
  if (error) {
    error.innerText = message;
    error.style.display = 'block';
  }

  // Hide success message on error
  const success = document.getElementById('success');
  if (success) success.style.display = 'none';
}

function clearMessages() {
  const error = document.getElementById('error');
  const success = document.getElementById('success');
  if (error) error.style.display = 'none';
  if (success) success.style.display = 'none';
}

Date.prototype.toDateInputValue = function () {
  const local = new Date(this);
  local.setMinutes(this.getMinutes() - this.getTimezoneOffset());
  return local.toJSON().slice(0, 10);
};

function insertFrequentWorklogDescription(options: PopupOptions) {
  const descriptionFields = document.querySelectorAll<HTMLInputElement>(
    '.issue-comment-input'
  );
  const frequentWorklogButtons1 = document.querySelectorAll<HTMLButtonElement>(
    '.frequentWorklogDescription1'
  );
  const frequentWorklogButtons2 = document.querySelectorAll<HTMLButtonElement>(
    '.frequentWorklogDescription2'
  );

  // If both frequent descriptions are empty, remove the buttons entirely
  // so they never appear on input.
  const bothAreEmpty =
    options.frequentWorklogDescription1 === '' &&
    options.frequentWorklogDescription2 === '';

  descriptionFields.forEach((descriptionField, index) => {
    const button1 = frequentWorklogButtons1[index];
    const button2 = frequentWorklogButtons2[index];

    // If no frequent descriptions, remove the buttons from the DOM and skip the rest
    if (bothAreEmpty) {
      if (button1) button1.remove();
      if (button2) button2.remove();
      return;
    }

    // Otherwise, wire them up as before:
    // 1) Hide/show logic
    // 2) Clicking sets the input, etc.
    function hideButtons() {
      if (button1) button1.style.display = 'none';
      if (button2) button2.style.display = 'none';
    }
    function showButtons() {
      // Handle single button case
      const onlyButton1 =
        options.frequentWorklogDescription1 &&
        !options.frequentWorklogDescription2;
      const onlyButton2 =
        !options.frequentWorklogDescription1 &&
        options.frequentWorklogDescription2;

      if (button1 && options.frequentWorklogDescription1) {
        button1.style.display = 'block';
        button1.style.zIndex = '2';
        // If it's the only button, position it on the right
        if (onlyButton1) {
          button1.style.right = '3px';
        }
      }
      if (button2 && options.frequentWorklogDescription2) {
        button2.style.display = 'block';
        button2.style.zIndex = '1';
        // If it's the only button, position it on the right
        if (onlyButton2) {
          button2.style.right = '3px';
        }
      }
    }

    // If user didn't fill anything in options, we hide by default
    if (
      !options.frequentWorklogDescription1 &&
      !options.frequentWorklogDescription2
    ) {
      hideButtons();
    } else {
      // Show buttons initially if they have content
      showButtons();
    }

    if (button1 && options.frequentWorklogDescription1) {
      button1.addEventListener('click', () => {
        descriptionField.value = options.frequentWorklogDescription1;
        hideButtons();
      });
    }
    if (button2 && options.frequentWorklogDescription2) {
      button2.addEventListener('click', () => {
        descriptionField.value = options.frequentWorklogDescription2;
        hideButtons();
      });
    }

    // If either description is non-empty, we only show the buttons
    // if the field is empty, else hide.
    descriptionField.addEventListener('input', () => {
      if (descriptionField.value.trim() === '') {
        showButtons();
      } else {
        hideButtons();
      }
    });
  });
}

async function toggleStar(issueId: string, options: PopupOptions) {
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

    // Redraw table so starred item jumps to top
    await onFetchSuccess(issuesResponse, options);

    // ⭐️ Re-run your frequent-worklog setup after the new table is in the DOM
    insertFrequentWorklogDescription(options);
  } catch (err) {
    console.error('Error fetching issues after star update:', err);
    await handleTimeTableFetchError(
      err,
      options,
      'Failed to refresh issues after updating star'
    );
  }
}

function showSuccessAnimation(issueId: string, loggedTime: string) {
  const row = document.querySelector<HTMLTableRowElement>(
    `tr[data-issue-id="${issueId}"]`
  );
  if (!row) return;

  const totalTimeCell = row.querySelector<HTMLTableCellElement>(
    'td.issue-total-time'
  );
  let indicator: HTMLSpanElement | undefined;

  if (totalTimeCell) {
    totalTimeCell.style.position = 'relative';
    indicator = document.createElement('span');
    indicator.className = 'logged-time-indicator';
    indicator.textContent = `+${loggedTime}`;
    totalTimeCell.appendChild(indicator);
  }

  row.classList.add('success-highlight');

  setTimeout(() => {
    if (indicator) {
      indicator.remove();
      if (totalTimeCell) totalTimeCell.style.position = '';
    }
  }, 5000);

  setTimeout(() => {
    row.classList.add('fade-highlight');
    row.classList.remove('success-highlight');
  }, 4000);

  setTimeout(() => {
    row.classList.remove('fade-highlight');
  }, 5000);
}

function showErrorAnimation(issueId: string) {
  const row = document.querySelector<HTMLTableRowElement>(
    `tr[data-issue-id="${issueId}"]`
  );
  if (!row) return;

  row.classList.add('error-highlight');

  setTimeout(() => {
    row.classList.add('fade-highlight');
    row.classList.remove('error-highlight');
  }, 4000); // Keep highlight for 4 seconds

  // Clean up fade class after transition ends
  setTimeout(() => {
    row.classList.remove('fade-highlight');
  }, 5000); // Matches the fade duration
}
(window as Window & { displayError?: typeof displayError }).displayError =
  displayError;
export {};

export type JiraType = 'cloud' | 'server';

export interface AtlassianDocumentNode {
  type: string;
  version?: number;
  text?: string;
  content?: AtlassianDocumentNode[];
}

export interface JiraUser {
  accountId?: string;
  emailAddress?: string;
  displayName?: string;
  name?: string;
  key?: string;
}

export interface JiraProjectRef {
  key: string;
  name?: string;
}

export interface JiraStatus {
  id?: string;
  name?: string;
}

export interface JiraWorklog {
  started?: string;
  timeSpentSeconds: number;
  comment?: string | AtlassianDocumentNode;
  author?: JiraUser;
  updateAuthor?: JiraUser;
}

export interface JiraWorklogResponse {
  worklogs: JiraWorklog[];
  total?: number;
}

export interface JiraIssueFields {
  summary?: string;
  project?: JiraProjectRef | null;
  status?: JiraStatus | null;
  assignee?: JiraUser | null;
  worklog?: JiraWorklogResponse;
  [key: string]: unknown;
}

export interface JiraIssue {
  key: string;
  fields: JiraIssueFields;
}

export interface JiraTransition {
  id: string;
  name: string;
}

export interface JiraTransitionResponse {
  transitions: JiraTransition[];
}

export interface JiraProjectsResponse {
  total: number;
  data: Array<{ key: string; name: string }>;
}

export interface JiraIssuesResponse {
  total: number;
  data: JiraIssue[];
}

export interface JiraIssuePageResponse extends JiraIssuesResponse {
  nextCursor: string | null;
}

export interface JiraIssueSuggestionsResponse extends JiraIssuesResponse {}

export interface JiraLoginResponse extends JiraUser {}

export interface JiraAssignableUser extends JiraUser {}

export interface JiraApiClient {
  login(): Promise<JiraLoginResponse>;
  getIssue(id: string): Promise<JiraIssue>;
  getIssues(begin?: number, jql?: string): Promise<JiraIssuesResponse>;
  getIssuesPage(
    jql: string,
    cursor?: string | null,
    pageSize?: number
  ): Promise<JiraIssuePageResponse>;
  getIssueSuggestions(
    query: string,
    projectKey?: string | null
  ): Promise<JiraIssueSuggestionsResponse>;
  getIssueWorklog(id: string): Promise<JiraWorklogResponse>;
  updateWorklog(
    id: string,
    timeSpentSeconds: number,
    started: string,
    comment: string
  ): Promise<unknown>;
  getProjects(begin?: number): Promise<JiraProjectsResponse>;
  getTransitions(issueKey: string): Promise<JiraTransitionResponse>;
  transitionIssue(issueKey: string, transitionId: string): Promise<unknown>;
  updateIssue(
    issueKey: string,
    fields: Record<string, unknown>
  ): Promise<unknown>;
  searchAssignableUsers(
    issueKey: string,
    query: string,
    maxResults?: number
  ): Promise<JiraAssignableUser[]>;
  resolveIssueKeyFast(
    rawText: string,
    projectKey?: string | null
  ): Promise<{ key: string; summary: string }>;
  isIssueKeyLike(key: string): boolean;
  extractIssueKey(raw: string): string;
  validateIssueMatchesProject(issueKey: string, projectKey: string): boolean;
}

export interface ThemeSettings {
  followSystemTheme: boolean;
  darkMode: boolean;
}

export interface BaseExtensionOptions {
  jiraType: JiraType;
  apiToken: string;
  baseUrl: string;
  username: string;
  frequentWorklogDescription1: string;
  frequentWorklogDescription2: string;
  darkMode?: boolean;
  experimentalFeatures?: boolean;
}

export interface SearchOptions extends BaseExtensionOptions {}

export interface CliOptions extends BaseExtensionOptions {}

export interface PopupColumnVisibility {
  showStatus: boolean;
  showAssignee: boolean;
  showTotal: boolean;
  showComment: boolean;
  [key: string]: boolean;
}

export interface PopupOptions extends BaseExtensionOptions {
  jql: string;
  starredIssues: Record<string, number>;
  defaultPage: string;
  timeTableColumns: PopupColumnVisibility;
  timeTableColumnOrder: string[];
}

export interface TimerOptions extends BaseExtensionOptions {
  projectId: string;
  projectName: string;
  issueKey: string;
  issueTitle: string;
}

export interface ExtensionSettings {
  issueDetectionEnabled?: boolean;
  baseUrl: string;
  username: string;
  apiToken: string;
  jiraType: JiraType;
  experimentalFeatures?: boolean;
  floatingTimerWidgetEnabled?: boolean;
  followSystemTheme?: boolean;
  darkMode?: boolean;
  sidePanelEnabled?: boolean;
}

export interface OptionsPageSettings extends BaseExtensionOptions {
  issueDetectionEnabled: boolean;
  defaultPage: string;
  followSystemTheme: boolean;
  sidePanelEnabled: boolean;
  floatingTimerWidgetEnabled: boolean;
}

export interface TimerState {
  issueKey?: string;
  timerSeconds: number;
  timerIsRunning: boolean;
  timerLastUpdated: number | null;
}

export interface SettingsChangedMessage {
  type: 'SETTINGS_CHANGED';
  experimentalFeatures?: boolean;
  issueDetectionEnabled?: boolean;
  floatingTimerWidgetEnabled?: boolean;
}

export interface BackgroundTimerSettings {
  jiraType: JiraType;
  baseUrl: string;
  username: string;
  apiToken: string;
}

export interface BackgroundWorklogRequest {
  action: 'logWorklog';
  settings: BackgroundTimerSettings;
  issueId: string;
  timeInSeconds: number;
  startedTime: string;
  comment: string;
}

export interface BackgroundWorklogResponse {
  success: boolean;
  result?: unknown;
  error?: {
    message: string;
    status: number;
  };
}

export type TextEntryElement = HTMLInputElement | HTMLTextAreaElement;

export interface IssueProjectMismatchError extends Error {
  code: 'ISSUE_PROJECT_MISMATCH';
  issueKey: string;
  projectKey: string;
}

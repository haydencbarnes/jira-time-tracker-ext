import type {
  JiraApiClient,
  PopupOptions,
  TextEntryElement,
} from './shared/types';

declare global {
  interface Date {
    toDateInputValue(): string;
  }

  interface IdleDeadline {
    readonly didTimeout: boolean;
    timeRemaining(): number;
  }

  type IdleRequestCallback = (deadline: IdleDeadline) => void;

  interface Window {
    JIRA?: JiraApiClient;
    JiraErrorHandler?: {
      handleJiraError: (
        error: unknown,
        defaultMessage?: string,
        context?: string
      ) => void;
    };
    __jiraFloatingTimerWidgetInitialized?: boolean;
    _systemThemeListener?: MediaQueryList | null;
    _ttOptions?: PopupOptions;
    _gearPanelInitialized?: boolean;
    _ttJiraConfigKey?: string;
    _ttJiraPromise?: Promise<JiraApiClient>;
    displayError?: (message: string) => void;
  }

  var requestIdleCallback:
    | ((callback: IdleRequestCallback, options?: { timeout: number }) => number)
    | undefined;
  var cancelIdleCallback: ((handle: number) => void) | undefined;

  const JiraAPI: typeof import('./shared/jira-api').JiraAPI;
  const initializeWorklogSuggestions: (
    input: string | TextEntryElement
  ) => void;
  const worklogSuggestions: typeof import('./shared/worklog-suggestions').worklogSuggestions;
}

export {};

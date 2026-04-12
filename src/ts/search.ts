import './shared/jira-api';
import './shared/jira-error-handler';
import './shared/worklog-suggestions';
import { getRequiredElement } from './shared/dom-utils';
import {
  autocomplete,
  bindInfiniteIssuesScroll,
  setupProjectIssueAutocomplete,
} from './shared/jira-project-issue-autocomplete';
import type {
  JiraApiClient,
  SearchOptions,
  TextEntryElement,
} from './shared/types';

document.addEventListener('DOMContentLoaded', function () {
  const themeToggleElement = document.getElementById(
    'themeToggle'
  ) as HTMLButtonElement | null;
  if (!themeToggleElement) return;
  const themeToggle = themeToggleElement;

  // Unified theme logic
  function applyTheme(followSystem: boolean, manualDark: boolean): void {
    if (followSystem) {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
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
  function setTheme(isDark: boolean): void {
    updateThemeButton(isDark);
    if (isDark) {
      document.body.classList.add('dark-mode');
    } else {
      document.body.classList.remove('dark-mode');
    }
  }
  // Load settings and apply theme
  chrome.storage.sync.get(['followSystemTheme', 'darkMode'], function (result) {
    const theme = result as { followSystemTheme?: boolean; darkMode?: boolean };
    const followSystem = theme.followSystemTheme !== false; // default true
    const manualDark = theme.darkMode === true;
    applyTheme(followSystem, manualDark);
  });
  // Theme button disables system-following and sets manual override
  themeToggle.addEventListener('click', function () {
    const isDark = !document.body.classList.contains('dark-mode');
    updateThemeButton(isDark);
    setTheme(isDark);
    chrome.storage.sync.set({ darkMode: isDark, followSystemTheme: false });
  });
  // Listen for changes from other tabs/options
  chrome.storage.onChanged.addListener(function (changes, namespace) {
    if (
      namespace === 'sync' &&
      ('followSystemTheme' in changes || 'darkMode' in changes)
    ) {
      chrome.storage.sync.get(
        ['followSystemTheme', 'darkMode'],
        function (result) {
          const theme = result as {
            followSystemTheme?: boolean;
            darkMode?: boolean;
          };
          const followSystem = theme.followSystemTheme !== false;
          const manualDark = theme.darkMode === true;
          applyTheme(followSystem, manualDark);
        }
      );
    }
  });
});

// Function to update the theme button icon
function updateThemeButton(isDark: boolean): void {
  const themeToggle = document.getElementById(
    'themeToggle'
  ) as HTMLButtonElement | null;
  const iconSpan = themeToggle?.querySelector<HTMLElement>('.icon');
  if (!themeToggle || !iconSpan) return;
  if (isDark) {
    iconSpan.textContent = '☀️';
    themeToggle.title = 'Switch to light mode';
  } else {
    iconSpan.textContent = '🌙';
    themeToggle.title = 'Switch to dark mode';
  }
}

document.addEventListener('DOMContentLoaded', onDOMContentLoaded);

async function onDOMContentLoaded(): Promise<void> {
  chrome.storage.sync.get(
    {
      jiraType: 'cloud',
      apiToken: '',
      baseUrl: '',
      username: '',
      frequentWorklogDescription1: '',
      frequentWorklogDescription2: '',
      darkMode: false,
      experimentalFeatures: false,
    },
    async (storedOptions) => {
      const options = storedOptions as unknown as SearchOptions;
      console.log('Storage options:', options);
      await init(options);

      getRequiredElement<HTMLButtonElement>('search').addEventListener(
        'click',
        logTimeClick
      );

      insertFrequentWorklogDescription(options);

      // Initialize worklog suggestions for description field
      const descriptionField = document.getElementById(
        'description'
      ) as TextEntryElement | null;
      if (descriptionField) {
        initializeWorklogSuggestions(descriptionField);
      }
    }
  );

  const datePicker = getRequiredElement<HTMLInputElement>('datePicker');
  datePicker.value = new Date().toISOString().split('T')[0];
}

async function init(options: SearchOptions): Promise<void> {
  console.log('Options received:', options);

  try {
    // Initialize the JIRA API with the provided options
    const JIRA = (await JiraAPI(
      options.jiraType,
      options.baseUrl,
      options.username,
      options.apiToken
    )) as JiraApiClient;
    // Expose for autocomplete suggestions
    window.JIRA = JIRA;
    console.log('JIRA API Object initialized:', JIRA);

    if (
      !JIRA ||
      typeof JIRA.getProjects !== 'function' ||
      typeof JIRA.getIssues !== 'function'
    ) {
      console.error('JIRA API instantiation failed: Methods missing', JIRA);
      displayError(
        'JIRA API setup failed. Please check your settings and ensure all required fields (Base URL, Username, API Token) are correctly configured. Go to the main popup Settings to verify your configuration.'
      );
      return;
    }

    await setupProjectIssueAutocomplete(JIRA, {
      getJiraForSuggestions: () => JIRA,
      formatIssueRow: (i) => `${i.key}: ${i.fields.summary || ''}`,
      directIssueHooks: {
        onMismatch: (inputEl, _ctx) => {
          inputEl.value = '';
        },
        onFallback: async (_candidate, _inputEl) => {
          /* noop */
        },
      },
      onProjectSelectedFromDropdown: async ({ selectedProject, ctx }) => {
        const { JIRA: jira, replaceIssueInput, issueInputRef, issueList } =
          ctx;
        const jql = `project = ${selectedProject.key}`;
        replaceIssueInput();
        const page = await jira.getIssuesPage(jql, null, 100);
        const issueItems = page.data.map(
          (i) => `${i.key}: ${i.fields.summary || ''}`
        );
        autocomplete(issueInputRef.current, issueItems, issueList, null, {
          getJiraForSuggestions: () => JIRA,
        });
        bindInfiniteIssuesScroll(
          issueList,
          issueItems,
          jql,
          jira,
          issueInputRef.current,
          (i) => `${i.key}: ${i.fields.summary || ''}`,
          page.nextCursor
        );
      },
    });

    const searchBtn = document.getElementById('search');
    if (searchBtn) {
      searchBtn.addEventListener('click', logTimeClick);
    }
  } catch (error) {
    console.error('Error initializing JIRA API:', error);
    window.JiraErrorHandler?.handleJiraError(
      error,
      'Failed to connect to JIRA from search page',
      'search'
    );
  }
}

async function logTimeClick(evt: Event): Promise<void> {
  evt.preventDefault();

  const projectId = getRequiredElement<HTMLInputElement>('projectId')
    .value.split(':')[0]
    .trim();
  const issueKey = getRequiredElement<HTMLInputElement>('issueKey')
    .value.split(':')[0]
    .trim();
  const date = getRequiredElement<HTMLInputElement>('datePicker').value;
  const timeSpent = getRequiredElement<HTMLInputElement>('timeSpent').value;
  const description = (
    getRequiredElement<HTMLInputElement>('description') as TextEntryElement
  ).value;

  // Validation
  if (!issueKey) {
    displayError(
      'Work Item Key is required. Please select or enter a valid work item key (e.g., PROJECT-123).'
    );
    return;
  }

  if (!timeSpent) {
    displayError(
      'Time Spent is required. Please enter the time you want to log (e.g., 2h, 30m, 1d).'
    );
    return;
  }

  // Validate time format
  const timeMatches = timeSpent.match(/[0-9]{1,4}[dhm]/g);
  if (!timeMatches) {
    displayError(
      'Invalid time format. Please use:\n• Hours: 2h, 1.5h\n• Minutes: 30m, 45m\n• Days: 1d, 0.5d\n\nExamples: "2h 30m", "1d", "45m"'
    );
    return;
  }

  console.log('Logging time with parameters:', {
    projectId,
    issueKey,
    date,
    timeSpent,
    description,
  });

  chrome.storage.sync.get(
    {
      jiraType: 'cloud',
      apiToken: '',
      baseUrl: '',
      username: '',
    },
    async (options) => {
      try {
        const JIRA = await JiraAPI(
          options.jiraType as SearchOptions['jiraType'],
          options.baseUrl as string,
          options.username as string,
          options.apiToken as string
        );
        const startedTime =
          typeof JIRA.buildStartedTimestamp === 'function'
            ? JIRA.buildStartedTimestamp(date)
            : new Date(date).toISOString();
        const timeSpentSeconds = convertTimeToSeconds(timeSpent);

        console.log({
          issueKey,
          timeSpentSeconds,
          startedTime,
          description,
        });

        await JIRA.updateWorklog(
          issueKey,
          timeSpentSeconds,
          startedTime,
          description
        );
        displaySuccess(`You successfully logged: ${timeSpent} on ${issueKey}`);

        getRequiredElement<HTMLInputElement>('timeSpent').value = '';
        (
          getRequiredElement<HTMLInputElement>(
            'description'
          ) as TextEntryElement
        ).value = '';
      } catch (error) {
        console.error('Error logging time:', error);
        window.JiraErrorHandler?.handleJiraError(
          error,
          `Failed to log time for issue ${issueKey}`,
          'search'
        );
      }
    }
  );
}

function convertTimeToSeconds(timeStr: string): number {
  const timeUnits = {
    d: 60 * 60 * 24,
    h: 60 * 60,
    m: 60,
  } as const;

  const regex = /(\d+)([dhm])/g;
  let match;
  let totalSeconds = 0;

  while ((match = regex.exec(timeStr)) !== null) {
    const value = parseInt(match[1], 10);
    const unit = match[2] as keyof typeof timeUnits;
    totalSeconds += value * timeUnits[unit];
  }

  return totalSeconds;
}

function displayError(message: string): void {
  const error = document.getElementById('error') as HTMLDivElement | null;
  if (error) {
    error.innerText = message;
    error.style.display = 'block';
  }

  const success = document.getElementById('success') as HTMLDivElement | null;
  if (success) success.style.display = 'none';
}

function displaySuccess(message: string): void {
  const success = document.getElementById('success') as HTMLDivElement | null;
  if (success) {
    success.innerText = message;
    success.style.display = 'block';

    getRequiredElement<HTMLInputElement>('timeSpent').value = '';
    (
      getRequiredElement<HTMLInputElement>('description') as TextEntryElement
    ).value = '';

    const error = document.getElementById('error') as HTMLDivElement | null;
    if (error) {
      error.innerText = '';
      error.style.display = 'none';
    }
  } else {
    console.warn('Success element not found');
  }
}

function insertFrequentWorklogDescription(options: SearchOptions): void {
  const frequentWorklogDescription1 = document.getElementById(
    'frequentWorklogDescription1'
  ) as HTMLButtonElement | null;
  const frequentWorklogDescription2 = document.getElementById(
    'frequentWorklogDescription2'
  ) as HTMLButtonElement | null;
  const descriptionField = document.getElementById(
    'description'
  ) as TextEntryElement | null;

  if (!descriptionField) {
    console.error('Description field not found');
    return;
  }

  function hideButtons() {
    if (frequentWorklogDescription1)
      frequentWorklogDescription1.style.display = 'none';
    if (frequentWorklogDescription2)
      frequentWorklogDescription2.style.display = 'none';
  }

  function showButtons() {
    if (frequentWorklogDescription1 && options.frequentWorklogDescription1) {
      frequentWorklogDescription1.style.display = 'block';
    }
    if (frequentWorklogDescription2 && options.frequentWorklogDescription2) {
      frequentWorklogDescription2.style.display = 'block';
    }
  }

  // Initially hide buttons if no descriptions are set
  if (
    !options.frequentWorklogDescription1 &&
    !options.frequentWorklogDescription2
  ) {
    hideButtons();
    return;
  }

  if (frequentWorklogDescription1 && options.frequentWorklogDescription1) {
    frequentWorklogDescription1.addEventListener('click', function () {
      descriptionField.value = options.frequentWorklogDescription1;
      console.log('frequentWorklogDescription1 clicked');
      hideButtons();
    });
  }

  if (frequentWorklogDescription2 && options.frequentWorklogDescription2) {
    frequentWorklogDescription2.addEventListener('click', function () {
      descriptionField.value = options.frequentWorklogDescription2;
      console.log('frequentWorklogDescription2 clicked');
      hideButtons();
    });
  }

  descriptionField.addEventListener('input', function () {
    console.log('User started typing in the description field');
    if (descriptionField.value === '') {
      showButtons();
    } else {
      hideButtons();
    }
  });

  // Check initial description field state
  if (descriptionField.value !== '') {
    hideButtons();
  } else {
    showButtons();
  }
}
(window as Window & { displayError?: typeof displayError }).displayError =
  displayError;
export {};

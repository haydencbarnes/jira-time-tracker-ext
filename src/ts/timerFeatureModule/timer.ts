import '../shared/jira-api';
import { getErrorMessage } from '../shared/jira-error-handler';
import '../shared/worklog-suggestions';
import { getRequiredElement } from '../shared/dom-utils';
import {
  autocomplete,
  bindInfiniteIssuesScroll,
  setupProjectIssueAutocomplete,
  type ProjectIssueAutocompleteContext,
} from '../shared/jira-project-issue-autocomplete';
import type {
  BackgroundTimerSettings,
  BackgroundWorklogResponse,
  JiraApiClient,
  TextEntryElement,
  TimerOptions,
  TimerState,
} from '../shared/types';

type CommentContainerVisibilityDetail = { shown: boolean };

function clearIssueStorageFromAutocomplete(
  ctx: ProjectIssueAutocompleteContext
): void {
  if (ctx.issueInputRef.current) ctx.issueInputRef.current.value = '';
  ctx.issueList.innerHTML = '';
  try {
    if (chrome.storage?.sync?.remove) {
      chrome.storage.sync.remove(['issueKey', 'issueTitle']);
    }
  } catch {}
}

let timer: number | null = null;
let isRunning = false;
let seconds = 0;
let JIRA: JiraApiClient | null = null;
let _timerSettings: BackgroundTimerSettings | null = null;

(function immediateTheme() {
  // Synchronously read theme from storage (best effort, may be async, but runs before DOMContentLoaded)
  if (chrome.storage?.sync?.get) {
    chrome.storage.sync.get(
      ['followSystemTheme', 'darkMode'],
      function (result) {
        const theme = (result || {}) as {
          followSystemTheme?: boolean;
          darkMode?: boolean;
        };
        const followSystem = theme.followSystemTheme !== false; // default true
        const manualDark = theme.darkMode === true;
        if (followSystem) {
          const mql = window.matchMedia('(prefers-color-scheme: dark)');
          setTheme(mql.matches);
        } else {
          setTheme(manualDark);
        }
      }
    );
  }
  function setTheme(isDark: boolean) {
    if (isDark) {
      document.body.classList.add('dark-mode');
    } else {
      document.body.classList.remove('dark-mode');
    }
  }
})();

document.addEventListener('DOMContentLoaded', onDOMContentLoaded);

function enforceProjectIssueConsistency(): void {
  try {
    const projectInput = document.getElementById(
      'projectId'
    ) as HTMLInputElement | null;
    const issueInput = document.getElementById(
      'issueKey'
    ) as HTMLInputElement | null;
    const projectVal =
      projectInput && projectInput.value ? projectInput.value : '';
    const issueVal = issueInput && issueInput.value ? issueInput.value : '';
    const projectKey = projectVal
      ? projectVal.split(':')[0].trim().toUpperCase()
      : '';
    const issueKey = issueVal
      ? issueVal.split(':')[0].trim().toUpperCase()
      : '';
    const issuePrefix = issueKey.includes('-') ? issueKey.split('-')[0] : '';

    if (projectKey && issuePrefix && projectKey !== issuePrefix) {
      // Clear mismatched issue and remove saved values
      if (issueInput) issueInput.value = '';
      try {
        if (chrome.storage?.sync?.remove) {
          chrome.storage.sync.remove(['issueKey', 'issueTitle']);
        }
      } catch {}
    }

    // Track selected key for later change detection
    if (projectInput && projectInput.dataset && projectKey) {
      projectInput.dataset.selectedKey = projectKey;
    }
  } catch {}
}

async function onDOMContentLoaded(): Promise<void> {
  chrome.storage.sync.get(
    {
      apiToken: '',
      baseUrl: '',
      projectId: '',
      projectName: '',
      issueKey: '',
      issueTitle: '',
      username: '',
      jiraType: 'cloud',
      frequentWorklogDescription1: '',
      frequentWorklogDescription2: '',
      darkMode: false,
      experimentalFeatures: false,
    },
    async (storedOptions) => {
      const options = storedOptions as unknown as TimerOptions;
      console.log('Storage options:', options);
      // Keep a minimal copy of settings for background requests
      _timerSettings = {
        jiraType: options.jiraType,
        baseUrl: options.baseUrl,
        username: options.username,
        apiToken: options.apiToken,
      };
      // Restore saved project and issue BEFORE initializing autocomplete so it can bind to the correct project
      if (options.projectId && options.projectName) {
        getRequiredElement<HTMLInputElement>('projectId').value =
          `${options.projectId}: ${options.projectName}`;
      } else if (options.projectId) {
        getRequiredElement<HTMLInputElement>('projectId').value =
          options.projectId;
      }
      if (options.issueKey && options.issueTitle) {
        getRequiredElement<HTMLInputElement>('issueKey').value =
          `${options.issueKey}: ${options.issueTitle}`;
      } else if (options.issueKey) {
        getRequiredElement<HTMLInputElement>('issueKey').value =
          options.issueKey;
      }

      // Enforce consistency between project and issue from restored values
      enforceProjectIssueConsistency();

      await init(options);

      getRequiredElement<HTMLButtonElement>('startStop').addEventListener(
        'click',
        toggleTimer
      );
      getRequiredElement<HTMLButtonElement>('reset').addEventListener(
        'click',
        resetTimer
      );
      getRequiredElement<HTMLButtonElement>('logTime').addEventListener(
        'click',
        logTimeClick
      );

      const toggleCommentBtn = document.getElementById('toggleComment');
      if (toggleCommentBtn) {
        toggleCommentBtn.addEventListener('click', toggleCommentVisibility);
      }
      const editTimeBtn = document.getElementById('editTime');
      if (editTimeBtn) {
        editTimeBtn.addEventListener('click', startTimeEditing);
      }

      insertFrequentWorklogDescription(options);

      restoreTimerState();

      const themeToggle = document.getElementById(
        'themeToggle'
      ) as HTMLButtonElement | null;

      // Unified theme logic
      function applyTheme(followSystem: boolean, manualDark: boolean) {
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
      function setTheme(isDark: boolean) {
        updateThemeButton(isDark);
        if (isDark) {
          document.body.classList.add('dark-mode');
        } else {
          document.body.classList.remove('dark-mode');
        }
      }
      // Load settings and apply theme
      chrome.storage.sync.get(
        ['followSystemTheme', 'darkMode'],
        function (result) {
          const theme = result as {
            followSystemTheme?: boolean;
            darkMode?: boolean;
          };
          const followSystem = theme.followSystemTheme !== false; // default true
          const manualDark = theme.darkMode === true;
          applyTheme(followSystem, manualDark);

          // Initialize worklog suggestions AFTER theme is applied
          const descriptionField = document.getElementById(
            'description'
          ) as TextEntryElement | null;
          if (
            descriptionField &&
            typeof initializeWorklogSuggestions === 'function'
          ) {
            initializeWorklogSuggestions(descriptionField);
          }
        }
      );
      // Theme button disables system-following and sets manual override
      themeToggle?.addEventListener('click', function () {
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
        if (
          namespace === 'sync' &&
          ('timerSeconds' in changes ||
            'timerIsRunning' in changes ||
            'timerLastUpdated' in changes)
        ) {
          applyTimerStateFromChanges(changes);
        }
        // no-op for experimentalFeatures; suggestions always enabled now
      });
    }
  );
}

async function init(options: TimerOptions): Promise<void> {
  console.log('Options received:', options);

  try {
    JIRA = (await JiraAPI(
      options.jiraType,
      options.baseUrl,
      options.username,
      options.apiToken
    )) as JiraApiClient;
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

    await setupAutocomplete(JIRA);
  } catch (error) {
    console.error('Error initializing JIRA API:', error);
    window.JiraErrorHandler?.handleJiraError(
      error,
      'Failed to connect to JIRA from timer page',
      'timer'
    );
  }
}

async function setupAutocomplete(JIRA: JiraApiClient): Promise<void> {
  const client = JIRA;
  await setupProjectIssueAutocomplete(client, {
    getJiraForSuggestions: () => client,
    formatIssueRow: (i) => `${i.key}: ${i.fields.summary || ''}`,
    directIssueHooks: {
      onMismatch: (_inputEl, ctx) => {
        clearIssueStorageFromAutocomplete(ctx);
      },
      onFallback: async (candidate, _inputEl) => {
        try {
          chrome.storage.sync.set({ issueKey: candidate, issueTitle: '' });
        } catch {}
      },
      onResolvedSideEffects: async (key, summary, _inputEl) => {
        try {
          chrome.storage.sync.set({
            issueKey: key,
            issueTitle: summary || '',
          });
        } catch {}
      },
    },
    onProjectSelectedFromDropdown: async ({
      selectedKey,
      selectedProject,
      ctx,
    }) => {
      const {
        JIRA: jira,
        replaceIssueInput,
        issueInputRef,
        issueList,
        projectInput,
      } = ctx;
      const previousKey =
        projectInput && projectInput.dataset
          ? projectInput.dataset.selectedKey
          : null;
      if (projectInput && projectInput.dataset)
        projectInput.dataset.selectedKey = selectedKey;
      if (previousKey && previousKey !== selectedKey) {
        clearIssueStorageFromAutocomplete(ctx);
      }
      const jql = `project = ${selectedProject.key}`;
      replaceIssueInput();
      const page = await jira.getIssuesPage(jql, null, 100);
      const issueItems = page.data.map(
        (i) => `${i.key}: ${i.fields.summary || ''}`
      );
      autocomplete(
        issueInputRef.current,
        issueItems,
        issueList,
        (selectedIssue) => {
          const issueKey = selectedIssue.split(':')[0].trim();
          const issueTitle = selectedIssue
            .substring(selectedIssue.indexOf(':') + 1)
            .trim();
          chrome.storage.sync.set({
            issueKey: issueKey,
            issueTitle: issueTitle,
          });
          issueInputRef.current.value = selectedIssue;
        },
        {
          getJiraForSuggestions: () => client,
        }
      );
      bindInfiniteIssuesScroll(
        issueList,
        issueItems,
        jql,
        jira,
        issueInputRef.current,
        (i) => `${i.key}: ${i.fields.summary || ''}`,
        page.nextCursor
      );
      chrome.storage.sync.set({
        projectId: selectedKey,
        projectName: selectedProject.name,
      });
    },
    runInitialPreload: async (ctx) => {
      const {
        JIRA: jira,
        projectInput,
        issueInputRef,
        projectMap,
        issueList,
        replaceIssueInput,
      } = ctx;
      try {
        const initialVal =
          projectInput && projectInput.value ? projectInput.value : '';
        const initialKey = initialVal ? initialVal.split(':')[0].trim() : '';
        if (!initialKey || !projectMap.has(initialKey)) return;

        if (projectInput && projectInput.dataset)
          projectInput.dataset.selectedKey = initialKey;

        if (issueInputRef.current && issueInputRef.current.value) {
          const existingIssueKey = issueInputRef.current.value
            .split(':')[0]
            .trim();
          const existingPrefix = existingIssueKey.includes('-')
            ? existingIssueKey.split('-')[0]
            : '';
          if (
            existingPrefix &&
            existingPrefix.toUpperCase() !== initialKey.toUpperCase()
          ) {
            clearIssueStorageFromAutocomplete(ctx);
          }
        }

        const selectedProject = projectMap.get(initialKey);
        if (!selectedProject) return;

        const jql = `project = ${selectedProject.key}`;
        replaceIssueInput();
        const page = await jira.getIssuesPage(jql, null, 100);
        const issueItems = page.data.map(
          (i) => `${i.key}: ${i.fields.summary || ''}`
        );
        autocomplete(
          issueInputRef.current,
          issueItems,
          issueList,
          (selectedIssue) => {
            const issueKey = selectedIssue.split(':')[0].trim();
            const issueTitle = selectedIssue
              .substring(selectedIssue.indexOf(':') + 1)
              .trim();
            chrome.storage.sync.set({
              issueKey: issueKey,
              issueTitle: issueTitle,
            });
            issueInputRef.current.value = selectedIssue;
          },
          {
            getJiraForSuggestions: () => client,
          }
        );
        bindInfiniteIssuesScroll(
          issueList,
          issueItems,
          jql,
          jira,
          issueInputRef.current,
          (i) => `${i.key}: ${i.fields.summary || ''}`,
          page.nextCursor
        );
      } catch {
        // best-effort init
      }
    },
    attachProjectInputExtras: (ctx) => {
      const { projectInput } = ctx;
      projectInput.addEventListener('input', () => {
        const typedKey = projectInput.value
          ? projectInput.value.split(':')[0].trim()
          : '';
        const currentKey =
          projectInput && projectInput.dataset
            ? projectInput.dataset.selectedKey
            : '';
        if (typedKey && currentKey && typedKey !== currentKey) {
          clearIssueStorageFromAutocomplete(ctx);
        }
      });
    },
  });
}


function toggleTimer() {
  if (isRunning) {
    chrome.runtime.sendMessage({ action: 'stopTimer' });
  } else {
    chrome.runtime.sendMessage({ action: 'startTimer', seconds: seconds });
  }

  isRunning = !isRunning;
  applyTimerRunningUi();
  saveTimerState();
}

function updateTimer() {
  if (!isRunning) return;
  seconds++;
  updateTimerDisplay();
  if (seconds % 5 === 0) {
    // Save every 5 seconds
    saveTimerState();
  }
}

function updateTimerDisplay(): void {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const timerInput = document.getElementById(
    'timer'
  ) as HTMLInputElement | null;
  if (timerInput) {
    timerInput.value = `${hours}h ${pad(minutes)}m ${pad(secs)}s`;
  }
}

function resetTimer() {
  isRunning = false;
  seconds = 0;
  updateTimerDisplay();
  applyTimerRunningUi();
  chrome.runtime.sendMessage({ action: 'resetTimer' });
  chrome.storage.sync.remove([
    'timerSeconds',
    'timerIsRunning',
    'timerLastUpdated',
  ]);
}

function pad(num: number): string {
  return num.toString().padStart(2, '0');
}

function applyTimerRunningUi() {
  const startStopIcon = document.getElementById('startStopIcon');
  const timerAnimation = document.getElementById('timer-animation');
  if (!startStopIcon || !timerAnimation) return;

  if (isRunning) {
    startStopIcon.textContent = 'pause';
    timerAnimation.style.display = 'block';
    timerAnimation.classList.add('active');
    if (!timer) {
      timer = setInterval(updateTimer, 1000);
    }
  } else {
    if (timer !== null) {
      clearInterval(timer);
    }
    timer = null;
    startStopIcon.textContent = 'play_arrow';
    timerAnimation.style.display = 'none';
    timerAnimation.classList.remove('active');
  }
}

function applyStoredTimerState(
  items: Pick<
    TimerState,
    'timerSeconds' | 'timerIsRunning' | 'timerLastUpdated'
  >
): void {
  seconds = items.timerSeconds;
  isRunning = items.timerIsRunning;

  if (isRunning && items.timerLastUpdated) {
    const elapsedSeconds = Math.floor(
      (new Date().getTime() - items.timerLastUpdated) / 1000
    );
    seconds += elapsedSeconds;
  }

  updateTimerDisplay();
  applyTimerRunningUi();
}

function getTimerChangeValue<T>(
  changes: { [key: string]: chrome.storage.StorageChange },
  key: string,
  defaultValue: T,
  fallbackValue: T
): T {
  if (!(key in changes)) return fallbackValue;
  return Object.prototype.hasOwnProperty.call(changes[key], 'newValue')
    ? (changes[key].newValue as T)
    : defaultValue;
}

function applyTimerStateFromChanges(changes: {
  [key: string]: chrome.storage.StorageChange;
}): void {
  applyStoredTimerState({
    timerSeconds: getTimerChangeValue(changes, 'timerSeconds', 0, seconds),
    timerIsRunning: getTimerChangeValue(
      changes,
      'timerIsRunning',
      false,
      isRunning
    ),
    timerLastUpdated: getTimerChangeValue(
      changes,
      'timerLastUpdated',
      null,
      Date.now()
    ),
  });
}

function loadTimerState(syncBackground = false): void {
  chrome.storage.sync.get(
    {
      timerSeconds: 0,
      timerIsRunning: false,
      timerLastUpdated: null,
    },
    function (items) {
      applyStoredTimerState(
        items as Pick<
          TimerState,
          'timerSeconds' | 'timerIsRunning' | 'timerLastUpdated'
        >
      );

      if (!syncBackground) return;

      chrome.runtime.sendMessage({
        action: 'updateBadge',
        seconds: seconds,
        isRunning: isRunning,
      });
      if (isRunning) {
        chrome.runtime.sendMessage({ action: 'startTimer', seconds: seconds });
      }
    }
  );
}

// Handle editable time
let _preEditSeconds = 0;
function startTimeEditing(): void {
  if (isRunning) {
    displayError('Pause the timer before editing time.');
    return;
  }
  const timerInput = document.getElementById(
    'timer'
  ) as HTMLInputElement | null;
  if (!timerInput) return;
  const inputEl = timerInput;
  _preEditSeconds = seconds;
  inputEl.readOnly = false;
  inputEl.focus();
  inputEl.select();

  const onBlur = () => applyTimeEditCleanup(true);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyTimeEditCleanup(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      seconds = _preEditSeconds;
      updateTimerDisplay();
      applyTimeEditCleanup(false);
    }
  };

  function applyTimeEditCleanup(apply: boolean): void {
    inputEl.removeEventListener('blur', onBlur);
    inputEl.removeEventListener('keydown', onKey);
    if (apply) {
      const parsed = parseTimeString(inputEl.value);
      if (parsed !== null) {
        seconds = parsed;
        updateTimerDisplay();
        saveTimerState();
      } else {
        // revert on invalid
        seconds = _preEditSeconds;
        updateTimerDisplay();
        displayError('Invalid time. Use format like 1h 05m 30s.');
      }
    }
    inputEl.readOnly = true;
  }

  inputEl.addEventListener('blur', onBlur);
  inputEl.addEventListener('keydown', onKey);
}

function parseTimeString(text: string): number | null {
  if (!text) return null;
  const normalized = text.trim().toLowerCase();
  const regex =
    /^(?:\s*(\d+)\s*h)?\s*(?:([0-5]?\d)\s*m)?\s*(?:([0-5]?\d)\s*s)?\s*$/i;
  const match = normalized.match(regex);
  if (!match) return null;
  const h = parseInt(match[1] || '0', 10);
  const m = parseInt(match[2] || '0', 10);
  const s = parseInt(match[3] || '0', 10);
  if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s)) return null;
  if (m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}

function toggleCommentVisibility(): void {
  const container = document.getElementById(
    'commentContainer'
  ) as HTMLElement | null;
  const button = document.getElementById('toggleComment') as HTMLElement | null;
  if (!container) return;
  const showing = !container.classList.contains('show');
  if (showing) {
    container.classList.add('show');
    button?.classList.add('active');
  } else {
    container.classList.remove('show');
    button?.classList.remove('active');
  }
  document.dispatchEvent(
    new CustomEvent('commentContainerVisibilityChanged', {
      detail: { shown: showing },
    })
  );
}

function insertFrequentWorklogDescription(options: TimerOptions): void {
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

  // Attach click handlers
  if (frequentWorklogDescription1 && options.frequentWorklogDescription1) {
    frequentWorklogDescription1.addEventListener('click', function () {
      descriptionField.value = options.frequentWorklogDescription1;
      hideButtons();
    });
  }
  if (frequentWorklogDescription2 && options.frequentWorklogDescription2) {
    frequentWorklogDescription2.addEventListener('click', function () {
      descriptionField.value = options.frequentWorklogDescription2;
      hideButtons();
    });
  }

  descriptionField.addEventListener('input', function () {
    if (descriptionField.value === '') {
      showButtons();
    } else {
      hideButtons();
    }
  });

  // React when the comment container is shown/hidden
  document.addEventListener('commentContainerVisibilityChanged', (e) => {
    const detail = (e as CustomEvent<CommentContainerVisibilityDetail>).detail;
    if (detail && detail.shown) {
      if (descriptionField.value === '') {
        showButtons();
      } else {
        hideButtons();
      }
    } else {
      hideButtons();
    }
  });

  // Initialize state only when container is visible at load
  const container = document.getElementById('commentContainer');
  const containerShown = container && container.classList.contains('show');
  if (containerShown) {
    if (descriptionField.value !== '') {
      hideButtons();
    } else {
      showButtons();
    }
  } else {
    hideButtons();
  }
}

async function logTimeClick(): Promise<void> {
  const issueKey = getRequiredElement<HTMLInputElement>('issueKey')
    .value.split(':')[0]
    .trim();
  const timeSpent = secondsToJiraFormat(seconds);
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

  if (seconds <= 0) {
    displayError(
      'No time recorded. Please start the timer, work on your task, then stop the timer before logging time.'
    );
    return;
  }

  console.log('Logging time with parameters:', {
    issueKey,
    timeSpent,
    description,
  });

  try {
    const startedTime = new Date().toISOString();
    // Prefer background worker to avoid CORS/preflight issues
    const response = await new Promise<BackgroundWorklogResponse>((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            action: 'logWorklog',
            settings: _timerSettings,
            issueId: issueKey,
            timeInSeconds: seconds,
            startedTime: startedTime,
            comment: description,
          },
          (resp) => {
            // Handle runtime send errors gracefully
            if (chrome.runtime && chrome.runtime.lastError) {
              resolve({
                success: false,
                error: {
                  message:
                    chrome.runtime.lastError.message ??
                    'Extension runtime error',
                  status: 0,
                },
              });
            } else {
              resolve(
                (resp || {
                  success: false,
                  error: { message: 'Empty background response', status: 0 },
                }) as BackgroundWorklogResponse
              );
            }
          }
        );
      } catch (error) {
        resolve({
          success: false,
          error: {
            message: getErrorMessage(error) || 'Background request failed',
            status: 0,
          },
        });
      }
    });

    if (response && response.success) {
      displaySuccess(`You successfully logged: ${timeSpent} on ${issueKey}`);
      (
        getRequiredElement<HTMLInputElement>('description') as TextEntryElement
      ).value = '';
      resetTimer();
    } else {
      const err =
        response && response.error
          ? new Error(response.error.message || 'Failed to log work')
          : new Error('Failed to log work');
      throw err;
    }
  } catch (error) {
    console.error('Error logging time:', error);
    window.JiraErrorHandler?.handleJiraError(
      error,
      `Failed to log time for work item ${issueKey}`,
      'timer'
    );
  }
}

function secondsToJiraFormat(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  let result = '';
  if (hours > 0) result += `${hours}h `;
  if (minutes > 0) result += `${minutes}m `;
  if (seconds > 0) result += `${seconds}s`;

  return result.trim();
}

function displayError(message: string): void {
  const error = getRequiredElement<HTMLDivElement>('error');
  error.innerText = message;
  error.style.display = 'block';
  getRequiredElement<HTMLDivElement>('success').style.display = 'none';
}

function displaySuccess(message: string): void {
  const success = getRequiredElement<HTMLDivElement>('success');
  success.innerText = message;
  success.style.display = 'block';
  getRequiredElement<HTMLDivElement>('error').style.display = 'none';
}

function saveTimerState(): void {
  chrome.storage.sync.set({
    timerSeconds: seconds,
    timerIsRunning: isRunning,
    timerLastUpdated: new Date().getTime(),
  });
}

function restoreTimerState() {
  loadTimerState(true);
}

// Function to update the theme button icon
function updateThemeButton(isDark: boolean) {
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
(window as Window & { displayError?: typeof displayError }).displayError =
  displayError;
export {};

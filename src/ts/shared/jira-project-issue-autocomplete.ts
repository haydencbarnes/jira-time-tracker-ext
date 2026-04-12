import { getRequiredElement } from './dom-utils';
import type {
  JiraApiClient,
  JiraIssue,
  JiraProjectsResponse,
} from './types';

function displayErrorGlobal(message: string): void {
  const fn = (
    globalThis as unknown as { displayError?: (msg: string) => void }
  ).displayError;
  if (typeof fn === 'function') {
    fn(message);
  }
}

export function setupDropdownArrow(input: HTMLInputElement): void {
  const arrow = input.nextElementSibling;
  arrow?.addEventListener('click', (event) => {
    event.stopPropagation();
    input.focus();
    toggleDropdown(input);
  });
}

export function toggleDropdown(input: HTMLInputElement): void {
  const event = new Event('toggleDropdown', { bubbles: true });
  input.dispatchEvent(event);
}

export function setupInputFocus(input: HTMLInputElement): void {
  input.addEventListener('focus', function () {
    if (!this.value) {
      toggleDropdown(this);
    }
  });
}

export interface AutocompleteOptions {
  getJiraForSuggestions?: () => JiraApiClient | null;
}

export function autocomplete(
  inp: HTMLInputElement,
  arr: string[],
  listElement: HTMLUListElement,
  onSelect: ((selected: string) => void) | null = null,
  options?: AutocompleteOptions
): void {
  let currentFocus = -1;
  let isOpen = false;

  inp.addEventListener('input', function () {
    void showDropdown(this.value);
  });

  inp.addEventListener('toggleDropdown', function () {
    if (isOpen) {
      closeAllLists();
    } else {
      void showDropdown('');
    }
  });

  inp.addEventListener('refreshDropdown', function () {
    void showDropdown(inp.value || '');
  });

  async function showDropdown(val: string): Promise<void> {
    closeAllLists();
    currentFocus = -1;
    isOpen = true;

    let matches = arr.filter((item) =>
      item.toLowerCase().includes(val.toLowerCase())
    );
    if (matches.length === 0 && !val) {
      matches = arr;
    }

    const jira = options?.getJiraForSuggestions?.() ?? null;
    if (
      val &&
      matches.length < 5 &&
      jira != null &&
      inp.id === 'issueKey'
    ) {
      try {
        const projectInput = document.getElementById(
          'projectId'
        ) as HTMLInputElement | null;
        const selectedKey =
          projectInput && projectInput.value
            ? projectInput.value.split(':')[0].trim()
            : null;
        const suggestions = await jira.getIssueSuggestions(val, selectedKey);
        const suggestionItems = suggestions.data.map(
          (i) => `${i.key}: ${i.fields.summary || ''}`
        );
        const merged = [...suggestionItems, ...matches];
        const seen = new Set<string>();
        matches = merged.filter((x) => {
          const k = x.split(':')[0].trim();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      } catch {
        // ignore suggestions errors, fall back to local
      }
    }

    matches.forEach((item) => {
      const li = document.createElement('li');
      li.innerHTML = item;
      li.addEventListener('click', function () {
        inp.value = this.innerHTML;
        closeAllLists();
        if (onSelect) onSelect(this.innerHTML);
      });
      listElement.appendChild(li);
    });
  }

  inp.addEventListener('keydown', function (e) {
    const x = listElement.getElementsByTagName('li');
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

  function addActive(x: HTMLCollectionOf<HTMLLIElement>): false | void {
    if (!x) return false;
    removeActive(x);
    if (currentFocus >= x.length) currentFocus = 0;
    if (currentFocus < 0) currentFocus = x.length - 1;
    x[currentFocus].classList.add('autocomplete-active');
  }

  function removeActive(x: HTMLCollectionOf<HTMLLIElement>): void {
    for (let i = 0; i < x.length; i += 1) {
      x[i].classList.remove('autocomplete-active');
    }
  }

  function closeAllLists(elmnt?: EventTarget | null): void {
    const x = document.getElementsByClassName('autocomplete-list');
    for (let i = 0; i < x.length; i += 1) {
      if (elmnt != x[i] && elmnt != inp) {
        (x[i] as HTMLElement).innerHTML = '';
      }
    }
    isOpen = false;
  }

  document.addEventListener('click', function (e) {
    if (e.target !== inp && e.target !== inp.nextElementSibling) {
      closeAllLists(e.target);
    }
  });
}

export interface ProjectIssueAutocompleteContext {
  JIRA: JiraApiClient;
  projectInput: HTMLInputElement;
  issueInputRef: { current: HTMLInputElement };
  projectList: HTMLUListElement;
  issueList: HTMLUListElement;
  projectMap: Map<string, JiraProjectsResponse['data'][number]>;
  replaceIssueInput: () => void;
  getSelectedProjectKey: () => string;
}

export interface ProjectIssueDirectResolveHooks {
  onMismatch: (
    inputEl: HTMLInputElement,
    ctx: ProjectIssueAutocompleteContext
  ) => void | Promise<void>;
  onFallback: (
    candidate: string,
    inputEl: HTMLInputElement
  ) => void | Promise<void>;
  onResolvedSideEffects?: (
    key: string,
    summary: string | null,
    inputEl: HTMLInputElement
  ) => void | Promise<void>;
}

export function attachIssueDirectHandlers(
  JIRA: JiraApiClient,
  inputEl: HTMLInputElement,
  getSelectedProjectKey: () => string,
  hooks: ProjectIssueDirectResolveHooks,
  ctx: ProjectIssueAutocompleteContext
): void {
  if (!inputEl) return;

  const extractIssueKey = (raw: string) =>
    typeof JIRA?.extractIssueKey === 'function'
      ? JIRA.extractIssueKey(raw)
      : String(raw || '')
          .trim()
          .split(/\s|:/)[0]
          .toUpperCase();

  const isIssueKeyLike = (key: string) =>
    typeof JIRA?.isIssueKeyLike === 'function'
      ? JIRA.isIssueKeyLike(key)
      : /^[A-Z][A-Z0-9_]*-\d+$/.test(key || '');

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
      if (
        (err as { code?: string } | null)?.code === 'ISSUE_PROJECT_MISMATCH'
      ) {
        await hooks.onMismatch(inputEl, ctx);
        displayErrorGlobal('Work item key does not match selected project.');
      } else {
        inputEl.value = candidate;
        await hooks.onFallback(candidate, inputEl);
      }
    }
  };

  inputEl.addEventListener('paste', (e) => {
    const pasted =
      e && e.clipboardData && e.clipboardData.getData
        ? e.clipboardData.getData('text')
        : null;
    const candidate = extractIssueKey(pasted || inputEl.value);
    if (isIssueKeyLike(candidate)) {
      setTimeout(() => {
        void acceptIfValid();
      }, 0);
    }
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const candidate = extractIssueKey(inputEl.value);
      if (isIssueKeyLike(candidate)) {
        e.preventDefault();
        void acceptIfValid();
      }
    }
  });

  inputEl.addEventListener('blur', () => {
    const candidate = extractIssueKey(inputEl.value);
    if (isIssueKeyLike(candidate)) {
      setTimeout(() => {
        void acceptIfValid();
      }, 0);
    }
  });
}

export function bindInfiniteIssuesScroll(
  issueList: HTMLUListElement,
  issueItems: string[],
  jql: string,
  JIRA: JiraApiClient,
  issueInput: HTMLInputElement,
  formatIssueRow: (issue: JiraIssue) => string,
  initialNextCursor: string | null
): void {
  let loadingMore = false;
  let nextCursor = initialNextCursor;

  issueList.addEventListener('scroll', () => {
    void (async () => {
      if (loadingMore || !nextCursor) return;
      const nearBottom =
        issueList.scrollTop + issueList.clientHeight >=
        issueList.scrollHeight - 20;
      if (!nearBottom) return;
      loadingMore = true;
      const nextPage = await JIRA.getIssuesPage(jql, nextCursor, 100);
      nextCursor = nextPage.nextCursor;
      const more = nextPage.data.map((i) => formatIssueRow(i));
      issueItems.push(...more);
      const evt = new Event('refreshDropdown', { bubbles: true });
      issueInput.dispatchEvent(evt);
      loadingMore = false;
    })();
  });
}

export interface ProjectIssueAutocompleteBehavior {
  getJiraForSuggestions: () => JiraApiClient | null;
  formatIssueRow: (issue: JiraIssue) => string;
  directIssueHooks: ProjectIssueDirectResolveHooks;
  onProjectSelectedFromDropdown: (args: {
    selectedKey: string;
    selectedProject: JiraProjectsResponse['data'][number];
    ctx: ProjectIssueAutocompleteContext;
  }) => Promise<void>;
  runInitialPreload?: (ctx: ProjectIssueAutocompleteContext) => Promise<void>;
  attachProjectInputExtras?: (ctx: ProjectIssueAutocompleteContext) => void;
}

export async function setupProjectIssueAutocomplete(
  JIRA: JiraApiClient,
  behavior: ProjectIssueAutocompleteBehavior
): Promise<void> {
  const projectInput = getRequiredElement<HTMLInputElement>('projectId');
  const issueInputRef = {
    current: getRequiredElement<HTMLInputElement>('issueKey'),
  };
  const projectList = getRequiredElement<HTMLUListElement>('projectList');
  const issueList = getRequiredElement<HTMLUListElement>('issueList');

  const projectsResponse = await JIRA.getProjects();
  const projects = projectsResponse.data;
  const projectMap = new Map<string, JiraProjectsResponse['data'][number]>(
    projects.map((project) => [project.key, project])
  );

  function getSelectedProjectKey(): string {
    const val = projectInput && projectInput.value ? projectInput.value : '';
    const key = val ? val.split(':')[0].trim() : '';
    return key.toUpperCase();
  }

  const ctx: ProjectIssueAutocompleteContext = {
    JIRA,
    projectInput,
    issueInputRef,
    projectList,
    issueList,
    projectMap,
    replaceIssueInput: () => {
      /* set below */
    },
    getSelectedProjectKey,
  };

  function replaceIssueInput(): void {
    const oldInput = issueInputRef.current;
    const oldValue = oldInput.value;
    const newInput = oldInput.cloneNode(true) as HTMLInputElement;
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
        const selectedKey = selected.split(':')[0].trim();
        const selectedProject = projectMap.get(selectedKey);
        if (selectedProject) {
          await behavior.onProjectSelectedFromDropdown({
            selectedKey,
            selectedProject,
            ctx,
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

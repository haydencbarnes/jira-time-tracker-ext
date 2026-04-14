import './shared/jira-api';
import { getErrorMessage } from './shared/jira-error-handler';
import { getRequiredElement } from './shared/dom-utils';
import { initPageViewLayout } from './shared/page-view-layout';
import { initializeStoredThemeControls } from './shared/theme-sync';
import { buildWorklogStartedTimestamp } from './shared/worklog-time';
import type {
  CliOptions,
  JiraApiClient,
  JiraLoginResponse,
  JiraWorklog,
} from './shared/types';

initPageViewLayout();

interface MeIdentifiers {
  accountId: string | null;
  email: string | null;
  username: string | null;
}

interface ParsedCliCommand {
  issueKey: string | null;
  seconds: number;
  date: Date | null;
  comment: string;
}

interface CommandContext {
  JIRA: JiraApiClient;
  options: CliOptions;
  output: HTMLDivElement;
  input: HTMLInputElement;
  meIdentifiers: MeIdentifiers;
}

// Theme init shared with other pages
document.addEventListener('DOMContentLoaded', function () {
  const themeToggleElement = document.getElementById(
    'themeToggle'
  ) as HTMLButtonElement | null;
  if (!themeToggleElement) return;
  initializeStoredThemeControls({ toggle: themeToggleElement });
});

document.addEventListener('DOMContentLoaded', onDOMContentLoaded);

const CLI_AUTO_SCROLL_THRESHOLD_PX = 24;
let shouldAutoScrollOutput = true;
let pendingScrollFrame: number | null = null;
let pendingFollowupScrollFrame: number | null = null;

async function onDOMContentLoaded() {
  const output = getRequiredElement<HTMLDivElement>('cli-output');
  const input = getRequiredElement<HTMLInputElement>('cli-input');
  const palette = getRequiredElement<HTMLDivElement>('cmd-palette');

  // Welcome banner is rendered inline in the terminal via cli.html; suppress extra ready line
  initOutputAutoScroll(output);
  scrollToBottom(output, { force: true });

  const options = await readOptions();
  const JIRA = (await JiraAPI(
    options.jiraType,
    options.baseUrl,
    options.username,
    options.apiToken
  )) as JiraApiClient;

  // Resolve current user identifiers for filtering "my" worklogs
  let meIdentifiers = buildMeIdentifiersFromUsername(options.username);
  try {
    const me = await JIRA.login();
    meIdentifiers = buildMeIdentifiersFromLogin(me, options.username);
  } catch {
    /* ignore */
  }

  // Command history
  const HISTORY_KEY = 'CLI_HISTORY';
  const MAX_HISTORY = 300;
  let history: string[] = [];
  let historyIndex = -1;

  // Load persisted history
  try {
    const stored = await new Promise<Record<string, unknown>>((resolve) => {
      chrome.storage.local.get([HISTORY_KEY], (value) =>
        resolve((value || {}) as Record<string, unknown>)
      );
    });
    if (Array.isArray(stored[HISTORY_KEY])) {
      history = stored[HISTORY_KEY] as string[];
      historyIndex = history.length; // position at end
    }
  } catch {}

  input.addEventListener('keydown', async (e) => {
    // Slash command palette handling
    const trimmed = input.value.trim();
    const isSlashNoArgs = /^\/[a-zA-Z]*$/.test(trimmed); // only slash + optional letters, no spaces

    // If palette is open, Arrow keys navigate first
    if (palette?.dataset.open === 'true' && e.key === 'ArrowUp') {
      e.preventDefault();
      movePaletteSelection(palette, -1);
      return;
    }
    if (palette?.dataset.open === 'true' && e.key === 'ArrowDown') {
      e.preventDefault();
      movePaletteSelection(palette, 1);
      return;
    }
    if (
      (e.key === 'Enter' || e.key === 'Tab') &&
      palette?.dataset.open === 'true'
    ) {
      e.preventDefault();
      applySelectedCommand(palette, input);
      closeCommandPalette(palette);
      return;
    }
    if (e.key === 'Escape' && palette?.dataset.open === 'true') {
      e.preventDefault();
      closeCommandPalette(palette);
      return;
    }

    // Open palette on first ArrowDown when typing a slash command name (no args)
    if (e.key === 'ArrowDown' && isSlashNoArgs) {
      e.preventDefault();
      const prefix = trimmed.slice(1).toLowerCase();
      openCommandPalette(palette, input, prefix);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const command = input.value.trim();
      if (!command) return;
      closeCommandPalette(palette);
      history.push(command);
      // Persist bounded history
      if (history.length > MAX_HISTORY) {
        history = history.slice(history.length - MAX_HISTORY);
      }
      try {
        chrome.storage.local.set({ [HISTORY_KEY]: history });
      } catch {}
      historyIndex = history.length;
      input.value = '';

      // Support batch: split by newlines or semicolons
      const parts = command
        .split(/\n|;/)
        .map((s) => s.trim())
        .filter(Boolean);

      const batchSeconds = parts.reduce((acc, part) => {
        const parsed = parseNaturalLanguage(part);
        return parsed?.seconds > 0 ? acc + parsed.seconds : acc;
      }, 0);

      if (parts.length > 1) {
        const totalLabel =
          batchSeconds > 0 ? ` — total: ${formatHumanTime(batchSeconds)}` : '';
        writeLine(
          output,
          `Batch: ${parts.length} entries${totalLabel}`,
          'line-subtle'
        );
      }

      for (const part of parts) {
        writeLine(output, `➜ ${part}`, 'line-user');
        await handleCommand(part, {
          JIRA,
          options,
          output,
          input,
          meIdentifiers,
        });
      }
      scrollToBottom(output, { force: true });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (historyIndex > 0) {
        historyIndex -= 1;
        input.value = history[historyIndex] || '';
        setTimeout(() =>
          input.setSelectionRange(input.value.length, input.value.length)
        );
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex < history.length - 1) {
        historyIndex += 1;
        input.value = history[historyIndex] || '';
      } else {
        historyIndex = history.length;
        input.value = '';
      }
    }
  });

  input.addEventListener('input', () => {
    const t = input.value.trim();
    if (!t.startsWith('/')) {
      closeCommandPalette(palette);
      return;
    }
    // Open or refresh palette when typing "/" and the command name (no args yet)
    if (/^\/[a-zA-Z]*$/.test(t)) {
      const prefix = t.slice(1).toLowerCase();
      openCommandPalette(palette, input, prefix);
    } else {
      // user typed a space/args: close palette to restore normal arrows
      closeCommandPalette(palette);
    }
  });
}

function writeLine(
  outputEl: HTMLDivElement,
  text: string,
  className?: string
): void {
  const shouldStickToBottom = shouldAutoScrollOutput;
  const div = document.createElement('div');
  if (className) div.className = className;
  // Convert work item keys like ABC-123 to styled spans
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

function clearCliOutput(outputEl: HTMLDivElement): void {
  if (!outputEl) return;
  outputEl.replaceChildren();
  scrollToBottom(outputEl, { force: true });
}

function initOutputAutoScroll(outputEl: HTMLDivElement): void {
  if (!outputEl) return;
  outputEl.addEventListener(
    'scroll',
    () => {
      shouldAutoScrollOutput = isNearBottom(outputEl);
    },
    { passive: true }
  );
}

function isNearBottom(outputEl: HTMLDivElement): boolean {
  if (!outputEl) return true;
  return (
    outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight <=
    CLI_AUTO_SCROLL_THRESHOLD_PX
  );
}

function syncScrollToBottom(outputEl: HTMLDivElement): void {
  outputEl.scrollTop = outputEl.scrollHeight;
  // Keep the input + footer in view when the popup page is taller than the viewport.
  // Welcome stays visible: `.cli-terminal-header` is `position: sticky; top: 0` in cli.html.
  document
    .getElementById('cli-bottom-anchor')
    ?.scrollIntoView({ block: 'end', inline: 'nearest' });
  const pageScroller = document.scrollingElement;
  if (pageScroller) {
    pageScroller.scrollTop = pageScroller.scrollHeight;
  }
  window.scrollTo(0, document.documentElement.scrollHeight);
}

function scrollToBottom(
  outputEl: HTMLDivElement,
  { force = false }: { force?: boolean } = {}
): void {
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

const COMMAND_ITEMS = [
  {
    cmd: '/time ISSUE-123',
    desc: 'Show total and today for an issue',
    key: 'time',
  },
  {
    cmd: '/time ISSUE-123 --me',
    desc: 'Show only your time on an issue',
    key: 'time',
  },
  { cmd: '/me ISSUE-123', desc: 'Alias for your time only', key: 'me' },
  { cmd: '/clear', desc: 'Clear terminal output', key: 'clear' },
  { cmd: '/bug', desc: 'Report a bug or request a feature', key: 'bug' },
  { cmd: '/help', desc: 'Show help', key: 'help' },
];

function openCommandPalette(
  palette: HTMLDivElement,
  input: HTMLInputElement,
  prefix = ''
): void {
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
  // If not enough space below, show above input
  const estimatedHeight = 200; // rough estimate
  if (top + estimatedHeight > vh - 8) {
    top = Math.max(8, rect.top - 6 - estimatedHeight);
  }
  palette.style.left = `${left}px`;
  palette.style.top = `${top}px`;
  palette.style.width = `${paletteWidth}px`;
  updateCommandPalette(palette, prefix);
  palette.dataset.open = 'true';
  palette.style.display = 'block';

  // mouse interactions
  palette.onclick = (ev) => {
    const item = (ev.target as Element | null)?.closest<HTMLDivElement>(
      '.cmd-item'
    );
    if (!item) return;
    const inputEl = getRequiredElement<HTMLInputElement>('cli-input');
    inputEl.value = item.dataset.cmd + ' ';
    closeCommandPalette(palette);
    inputEl.focus();
  };
  palette.onmousemove = (ev) => {
    const item = (ev.target as Element | null)?.closest<HTMLDivElement>(
      '.cmd-item'
    );
    if (!item) return;
    palette
      .querySelectorAll<HTMLElement>('.cmd-item')
      .forEach((node) => node.classList.remove('active'));
    item.classList.add('active');
  };
}

function closeCommandPalette(palette: HTMLDivElement): void {
  palette.dataset.open = 'false';
  palette.style.display = 'none';
}

function updateCommandPalette(palette: HTMLDivElement, prefix = ''): void {
  const items = COMMAND_ITEMS.filter(
    (it) =>
      !prefix ||
      it.key.startsWith(prefix) ||
      it.cmd.toLowerCase().startsWith('/' + prefix)
  );
  palette.innerHTML = items
    .map(
      (it, i) =>
        `<div class="cmd-item${i === 0 ? ' active' : ''}" role="option" data-cmd="${it.cmd}">` +
        `<span class="cmd-label">${it.cmd}</span>` +
        `<span class="cmd-desc">${it.desc}</span>` +
        `</div>`
    )
    .join('');
}

function movePaletteSelection(palette: HTMLDivElement, delta: number): void {
  const nodes = Array.from(
    palette.querySelectorAll<HTMLDivElement>('.cmd-item')
  );
  const current = palette.querySelector<HTMLDivElement>('.cmd-item.active');
  let idx = current ? nodes.indexOf(current) : -1;
  idx = Math.max(0, Math.min(nodes.length - 1, idx + delta));
  nodes.forEach((node) => node.classList.remove('active'));
  const next = nodes[idx];
  next?.classList.add('active');
  next?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function applySelectedCommand(
  palette: HTMLDivElement,
  input: HTMLInputElement
): void {
  const active = palette.querySelector<HTMLDivElement>('.cmd-item.active');
  if (!active) return;
  input.value = active.dataset.cmd + ' ';
}

function wrapIssue(issueKey: string): string {
  // Return a text node with marker to style work item keys; since we use textContent,
  // we will substitute inline by adding zero-width joiners to preserve blue via CSS class
  // Simpler: return as string and rely on regex styling post-insert.
  return issueKey;
}

function showError(message: string): void {
  const output = getRequiredElement<HTMLDivElement>('cli-output');
  writeLine(output, message, 'line-error');
}

function readOptions(): Promise<CliOptions> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      {
        jiraType: 'cloud',
        apiToken: '',
        baseUrl: '',
        username: '',
        experimentalFeatures: false,
        frequentWorklogDescription1: '',
        frequentWorklogDescription2: '',
      },
      (items) => resolve(items as unknown as CliOptions)
    );
  });
}

async function handleCommand(raw: string, ctx: CommandContext): Promise<void> {
  const { JIRA, output, meIdentifiers } = ctx;
  const lc = raw.trim();

  // Slash commands for quick access
  if (lc.startsWith('/')) {
    const parts = lc.slice(1).trim().split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();
    const rest = parts.join(' ');
    if (cmd === 'help' || cmd === '?') {
      return handleCommand('help', ctx);
    }
    if (cmd === 'time' || cmd === 't') {
      // /time ISSUE-123 [--me]
      const m = rest.match(/^([A-Z][A-Z0-9]+-\d+)(\s+--me)?\s*$/i);
      if (!m) {
        writeLine(output, 'Usage: /time ISSUE-123 [--me]');
        return;
      }
      const issueKey = m[1]?.toUpperCase();
      if (!issueKey) return;
      const onlyMe = !!m[2];
      await showIssueTimes(issueKey, JIRA, output, onlyMe, meIdentifiers);
      return;
    }
    if (cmd === 'clear' || cmd === 'cls') {
      if (rest.trim()) {
        writeLine(output, 'Usage: /clear');
        return;
      }
      clearCliOutput(output);
      return;
    }
    if (cmd === 'bug') {
      // Open issues page in a new tab
      try {
        chrome.tabs?.create({
          url: 'https://github.com/haydencbarnes/jira-time-tracker-ext/issues/new',
        });
      } catch {
        window.open(
          'https://github.com/haydencbarnes/jira-time-tracker-ext/issues/new',
          '_blank'
        );
      }
      writeLine(output, 'Opening bug/feature tracker…', 'line-subtle');
      return;
    }
    if (cmd === 'me') {
      // /me ISSUE-123 → show only my time
      const m = rest.match(/^([A-Z][A-Z0-9]+-\d+)\s*$/i);
      if (!m) {
        writeLine(output, 'Usage: /me ISSUE-123');
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

  if (lc === 'clear' || lc === 'cls') {
    clearCliOutput(output);
    return;
  }

  if (lc === 'help' || lc === '?') {
    writeLine(output, 'Usage: ISSUE TIME [DATE] [COMMENT]');
    writeLine(output, '  - TIME: 1h, 30m, 1d, combos like "1h 30m"');
    writeLine(output, '  - DATE: today, yesterday, mon..sun, or YYYY-MM-DD');
    writeLine(output, 'Info commands:');
    writeLine(
      output,
      '  time ISSUE-123           # show total and today time for an issue'
    );
    writeLine(
      output,
      '  time ISSUE-123 --me      # show only your time totals'
    );
    writeLine(output, '  ISSUE-123?               # quick alias to show times');
    writeLine(output, 'Other commands:');
    writeLine(output, '  clear (or cls)           # clear terminal output');
    writeLine(output, 'Slash commands:');
    writeLine(output, '  /time ISSUE-123 [--me]   # same as above, quicker');
    writeLine(
      output,
      '  /me ISSUE-123            # show only your time totals'
    );
    writeLine(output, '  /clear                   # clear terminal output');
    writeLine(
      output,
      '  /bug                     # open issues page to report bugs'
    );
    writeLine(output, '  /help                    # help');
    writeLine(output, 'Examples:');
    writeLine(output, '  PROJ-123 1h 30m today Fix tests');
    writeLine(output, '  log 90m to PROJ-123 yesterday build pipeline fix');
    writeLine(output, '  PROJ-1 2h');
    writeLine(output, 'Batch (semicolon or new line separated):');
    writeLine(
      output,
      '  PROJ-1 1h code review; PROJ-2 45m yesterday build fix'
    );
    return;
  }

  // Quick info lookups: "time ISSUE-123" or "ISSUE-123?"
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
      showError('Work item key not found. Example: PROJ-123');
      return;
    }
    if (!parsed.seconds || parsed.seconds <= 0) {
      showError('Time not understood. Examples: 2h, 30m, 1h 15m, 90m');
      return;
    }

    const startedTime = buildWorklogStartedTimestamp(parsed.date);
    await JIRA.updateWorklog(
      parsed.issueKey,
      parsed.seconds,
      startedTime,
      parsed.comment || ''
    );

    const humanTime = formatHumanTime(parsed.seconds);
    writeLine(
      output,
      `✔ Logged ${humanTime} on ${wrapIssue(parsed.issueKey)}${parsed.comment ? ' — ' + parsed.comment : ''}`,
      'line-success'
    );
  } catch (error) {
    console.error('CLI log error:', error);
    // Prefer terminal error output; still send to handler for consistency
    writeLine(
      output,
      `✖ ${getErrorMessage(error) || 'Failed to log time'}`,
      'line-error'
    );
    try {
      window.JiraErrorHandler?.handleJiraError(
        error,
        'Failed to log time via CLI',
        'cli'
      );
    } catch {}
  }
}

async function showIssueTimes(
  issueKey: string,
  JIRA: JiraApiClient,
  output: HTMLDivElement,
  onlyMe = false,
  meIdentifiers?: MeIdentifiers
): Promise<void> {
  try {
    const resp = await JIRA.getIssueWorklog(issueKey);
    const worklogs = Array.isArray(resp?.worklogs) ? resp.worklogs : [];
    const logs = onlyMe ? filterMyWorklogs(worklogs, meIdentifiers) : worklogs;
    const totalSeconds = logs.reduce(
      (acc, wl) => acc + (wl.timeSpentSeconds || 0),
      0
    );
    const today = new Date();
    const todayKey = today.toISOString().slice(0, 10); // YYYY-MM-DD
    const todaySeconds = logs.reduce((acc, wl) => {
      const started = wl.started ? new Date(wl.started) : null;
      if (!started) return acc;
      const startedKey = started.toISOString().slice(0, 10);
      return acc + (startedKey === todayKey ? wl.timeSpentSeconds || 0 : 0);
    }, 0);

    const fmt = (secs: number): string => {
      const h = Math.floor(secs / 3600);
      const m = Math.round((secs % 3600) / 60);
      if (h && m) return `${h}h ${m}m`;
      if (h) return `${h}h`;
      return `${m}m`;
    };

    const scopeLabel = onlyMe ? 'my' : 'total';
    writeLine(
      output,
      `ℹ ${wrapIssue(issueKey)} — ${scopeLabel}: ${fmt(totalSeconds)}, today: ${fmt(todaySeconds)}`,
      'line-info'
    );

    // Show last log snippet
    if (logs.length > 0) {
      const last = logs[logs.length - 1];
      if (!last) return;
      const lastH = (last.timeSpentSeconds || 0) / 3600;
      const lastComment =
        typeof last.comment === 'string'
          ? last.comment
          : last.comment?.content?.[0]?.content?.[0]?.text || '';
      const lastDate = last.started
        ? new Date(last.started).toLocaleString()
        : '';
      writeLine(
        output,
        `   last: ${lastH.toFixed(1)}h on ${lastDate}${lastComment ? ` — ${lastComment}` : ''}`
      );
    }
  } catch (error) {
    writeLine(
      output,
      `✖ Failed to fetch worklogs for ${issueKey}: ${getErrorMessage(error)}`,
      'line-error'
    );
  }
}

function filterMyWorklogs(
  worklogs: JiraWorklog[],
  me?: MeIdentifiers | null
): JiraWorklog[] {
  if (!Array.isArray(worklogs)) return [];
  if (!me) return worklogs; // fallback: show all
  return worklogs.filter((wl) => {
    const author = wl.author || wl.updateAuthor || {};
    const name = (
      author.accountId ||
      author.emailAddress ||
      author.displayName ||
      author.name ||
      ''
    )
      .toString()
      .toLowerCase();
    return (
      (me.accountId && author.accountId && author.accountId === me.accountId) ||
      (me.email && name.includes(me.email)) ||
      (me.username && name.includes(me.username))
    );
  });
}

function buildMeIdentifiersFromLogin(
  loginResp: JiraLoginResponse | null,
  fallbackUsername: string
): MeIdentifiers {
  try {
    return {
      accountId: loginResp?.accountId || loginResp?.key || null,
      email: (loginResp?.emailAddress || '').toLowerCase() || null,
      username: (fallbackUsername || '').toLowerCase() || null,
    };
  } catch {
    return buildMeIdentifiersFromUsername(fallbackUsername);
  }
}

function buildMeIdentifiersFromUsername(username: string): MeIdentifiers {
  return {
    accountId: null,
    email: (username || '').toLowerCase(),
    username: (username || '').toLowerCase(),
  };
}

// Convert seconds to compact human string like "1h 30m"
function formatHumanTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);

  // Prefer hours; only convert to days when the total exceeds 24h
  if (h > 24) {
    const d = Math.floor(h / 24);
    const remH = h % 24;
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (remH) parts.push(`${remH}h`);
    if (m) parts.push(`${m}m`);
    return parts.join(' ');
  }

  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!h && !m) parts.push(`${Math.max(1, Math.round(seconds / 60))}m`);
  return parts.join(' ');
}

// Build started timestamp using current local time on given date (or today)

// Parse natural language like:
// - "PROJ-123 1h 30m today Fix tests"
// - "log 90m to PROJ-123 yesterday build pipeline"
// Returns { issueKey, seconds, date: Date, comment }
function parseNaturalLanguage(input: string): ParsedCliCommand {
  const text = input.trim();

  // Extract work item key (e.g., ABC-123)
  const issueMatch = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  const issueKey = issueMatch ? issueMatch[1] : null;

  // Extract time expressions (support h, m, d; also allow plain minutes like "90m")
  // e.g., 1h, 30m, 1d, 1h 45m
  const timeRegex = /(\d+)\s*([dhm])/gi;
  let totalSeconds = 0;
  let match;
  while ((match = timeRegex.exec(text)) !== null) {
    const rawValue = match[1];
    const rawUnit = match[2];
    if (!rawValue || !rawUnit) continue;
    const value = parseInt(rawValue, 10);
    const unit = rawUnit.toLowerCase();
    if (unit === 'd') totalSeconds += value * 24 * 3600;
    if (unit === 'h') totalSeconds += value * 3600;
    if (unit === 'm') totalSeconds += value * 60;
  }

  // If no explicit unit but looks like minutes number ("log 90 to ABC-1")
  let date: Date | null = null;

  if (totalSeconds === 0) {
    // Avoid capturing digits that are part of a work item key like PROJ-123
    const minutesOnly = text.match(/(?<![A-Z0-9]-)\b(\d{1,4})\b(?!-)/);
    if (minutesOnly) {
      const minuteText = minutesOnly[1];
      if (minuteText) {
        const mins = parseInt(minuteText, 10);
        if (!isNaN(mins) && mins > 0) totalSeconds = mins * 60;
      }
    }
  }

  // Extract date keywords: today, yesterday, weekdays, or explicit YYYY-MM-DD
  const lower = text.toLowerCase();
  const today = new Date();
  if (/(^|\s)today(\s|$)/.test(lower)) {
    date = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  } else if (/(^|\s)yesterday(\s|$)/.test(lower)) {
    const y = new Date(today);
    y.setDate(y.getDate() - 1);
    date = new Date(y.getFullYear(), y.getMonth(), y.getDate());
  } else {
    // Weekday names
    const weekMap = {
      sun: 0,
      mon: 1,
      tue: 2,
      wed: 3,
      thu: 4,
      fri: 5,
      sat: 6,
    } as const;
    const wd = lower.match(/\b(sun|mon|tue|wed|thu|fri|sat)\b/);
    const weekday = wd?.[1] as keyof typeof weekMap | undefined;
    if (weekday) {
      const target = weekMap[weekday];
      const d = new Date(today);
      const diff = (d.getDay() - target + 7) % 7 || 7; // last occurrence
      d.setDate(d.getDate() - diff);
      date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }
  }
  // Explicit date
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

  // Build comment: remove work item key, time tokens, date tokens
  let comment = text;
  if (issueKey) comment = comment.replace(issueKey, '');
  comment = comment.replace(/\b(\d+)\s*[dhm]\b/gi, '');
  comment = comment.replace(
    /\b(\d{4}-\d{2}-\d{2}|today|yesterday|sun|mon|tue|wed|thu|fri|sat)\b/gi,
    ''
  );
  comment = comment.replace(/\bto\b|\blog\b/gi, '');
  comment = comment.replace(/\s+/g, ' ').trim();

  return { issueKey, seconds: totalSeconds, date, comment };
}
(window as Window & { displayError?: typeof showError }).displayError =
  showError;
export {};

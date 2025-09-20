// Theme init shared with other pages
document.addEventListener('DOMContentLoaded', function () {
  const themeToggle = document.getElementById('themeToggle');

  function updateThemeButton(isDark) {
    const iconSpan = themeToggle?.querySelector('.icon');
    if (!iconSpan) return;
    if (isDark) {
      iconSpan.textContent = '☀️';
      themeToggle.title = 'Switch to light mode';
    } else {
      iconSpan.textContent = '🌙';
      themeToggle.title = 'Switch to dark mode';
    }
  }

  function setTheme(isDark) {
    updateThemeButton(isDark);
    if (isDark) {
      document.body.classList.add('dark-mode');
    } else {
      document.body.classList.remove('dark-mode');
    }
  }

  function applyTheme(followSystem, manualDark) {
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

  chrome.storage.sync.get(['followSystemTheme', 'darkMode'], function (result) {
    const followSystem = result.followSystemTheme !== false;
    const manualDark = result.darkMode === true;
    applyTheme(followSystem, manualDark);
  });

  themeToggle?.addEventListener('click', function () {
    const isDark = !document.body.classList.contains('dark-mode');
    updateThemeButton(isDark);
    setTheme(isDark);
    chrome.storage.sync.set({ darkMode: isDark, followSystemTheme: false });
  });

  chrome.storage.onChanged.addListener(function (changes, namespace) {
    if (namespace === 'sync' && ('followSystemTheme' in changes || 'darkMode' in changes)) {
      chrome.storage.sync.get(['followSystemTheme', 'darkMode'], function (result) {
        const followSystem = result.followSystemTheme !== false;
        const manualDark = result.darkMode === true;
        applyTheme(followSystem, manualDark);
      });
    }
  });
});

document.addEventListener('DOMContentLoaded', onDOMContentLoaded);

async function onDOMContentLoaded() {
  const output = document.getElementById('cli-output');
  const input = document.getElementById('cli-input');
  const palette = document.getElementById('cmd-palette');

  // Welcome banner is rendered inline in the terminal via cli.html; suppress extra ready line

  const options = await readOptions();
  const JIRA = await JiraAPI(options.jiraType, options.baseUrl, options.username, options.apiToken);

  // Resolve current user identifiers for filtering "my" worklogs
  let meIdentifiers = buildMeIdentifiersFromUsername(options.username);
  try {
    const me = await JIRA.login();
    meIdentifiers = buildMeIdentifiersFromLogin(me, options.username);
  } catch (_) { /* ignore */ }

  // Command history
  const HISTORY_KEY = 'CLI_HISTORY';
  const MAX_HISTORY = 300;
  let history = [];
  let historyIndex = -1;

  // Load persisted history
  try {
    const stored = await new Promise((resolve) => chrome.storage.local.get([HISTORY_KEY], (v) => resolve(v || {})));
    if (Array.isArray(stored[HISTORY_KEY])) {
      history = stored[HISTORY_KEY];
      historyIndex = history.length; // position at end
    }
  } catch (_) {}

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
    if ((e.key === 'Enter' || e.key === 'Tab') && palette?.dataset.open === 'true') {
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
      try { chrome.storage.local.set({ [HISTORY_KEY]: history }); } catch (_) {}
      historyIndex = history.length;
      input.value = '';

      // Support batch: split by newlines or semicolons
      const parts = command
        .split(/\n|;/)
        .map(s => s.trim())
        .filter(Boolean);

      if (parts.length > 1) {
        writeLine(output, `Batch: ${parts.length} entries`, 'line-subtle');
      }

      for (const part of parts) {
        writeLine(output, `➜ ${part}`, 'line-user');
        await handleCommand(part, { JIRA, options, output, input, meIdentifiers });
      }
      scrollToBottom(output);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (historyIndex > 0) {
        historyIndex -= 1;
        input.value = history[historyIndex] || '';
        setTimeout(() => input.setSelectionRange(input.value.length, input.value.length));
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
    // Update palette suggestions while user types command name
    if (palette?.dataset.open === 'true') {
      if (/^\/[a-zA-Z]*$/.test(t)) {
        const prefix = t.slice(1).toLowerCase();
        updateCommandPalette(palette, prefix);
      } else {
        // user typed a space/args: close palette to restore normal arrows
        closeCommandPalette(palette);
      }
    }
  });
}

function writeLine(outputEl, text, className) {
  const div = document.createElement('div');
  if (className) div.className = className;
  // Convert work item keys like ABC-123 to styled spans
  const html = text
    .replace(/\b([A-Z][A-Z0-9]+-\d+)\b/g, '<span class="issue-id">$1</span>');
  div.innerHTML = html;
  outputEl.appendChild(div);
}

function scrollToBottom(outputEl) {
  outputEl.scrollTop = outputEl.scrollHeight;
}

const COMMAND_ITEMS = [
  { cmd: '/time ISSUE-123', desc: 'Show total and today for an issue', key: 'time' },
  { cmd: '/time ISSUE-123 --me', desc: 'Show only your time on an issue', key: 'time' },
  { cmd: '/me ISSUE-123', desc: 'Alias for your time only', key: 'me' },
  { cmd: '/bug', desc: 'Report a bug or request a feature', key: 'bug' },
  { cmd: '/help', desc: 'Show help', key: 'help' },
];

function openCommandPalette(palette, input, prefix = '') {
  const rect = input.getBoundingClientRect();
  const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
  const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
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
    const item = ev.target.closest('.cmd-item');
    if (!item) return;
    const inputEl = document.getElementById('cli-input');
    inputEl.value = item.dataset.cmd + ' ';
    closeCommandPalette(palette);
    inputEl.focus();
  };
  palette.onmousemove = (ev) => {
    const item = ev.target.closest('.cmd-item');
    if (!item) return;
    palette.querySelectorAll('.cmd-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
  };
}

function closeCommandPalette(palette) {
  if (!palette) return;
  palette.dataset.open = 'false';
  palette.style.display = 'none';
}

function updateCommandPalette(palette, prefix = '') {
  const items = COMMAND_ITEMS.filter(it =>
    !prefix || it.key.startsWith(prefix) || it.cmd.toLowerCase().startsWith('/' + prefix)
  );
  palette.innerHTML = items.map((it, i) => (
    `<div class="cmd-item${i===0?' active':''}" role="option" data-cmd="${it.cmd}">`+
      `<span class="cmd-label">${it.cmd}</span>`+
      `<span class="cmd-desc">${it.desc}</span>`+
    `</div>`
  )).join('');
}

function movePaletteSelection(palette, delta) {
  const nodes = Array.from(palette.querySelectorAll('.cmd-item'));
  const current = palette.querySelector('.cmd-item.active');
  let idx = current ? nodes.indexOf(current) : -1;
  idx = Math.max(0, Math.min(nodes.length - 1, idx + delta));
  nodes.forEach(n => n.classList.remove('active'));
  nodes[idx]?.classList.add('active');
}

function applySelectedCommand(palette, input) {
  const active = palette.querySelector('.cmd-item.active');
  if (!active) return;
  input.value = active.dataset.cmd + ' ';
}

function wrapIssue(issueKey) {
  // Return a text node with marker to style work item keys; since we use textContent,
  // we will substitute inline by adding zero-width joiners to preserve blue via CSS class
  // Simpler: return as string and rely on regex styling post-insert.
  return issueKey;
}

// Override banner behavior: print to terminal only
function showSuccess(message) {
  const output = document.getElementById('cli-output');
  writeLine(output, message, 'line-success');
}

function showError(message) {
  const output = document.getElementById('cli-output');
  writeLine(output, message, 'line-error');
}

function readOptions() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({
      jiraType: 'cloud',
      apiToken: '',
      baseUrl: '',
      username: '',
      experimentalFeatures: false,
      frequentWorklogDescription1: '',
      frequentWorklogDescription2: ''
    }, resolve);
  });
}

async function handleCommand(raw, ctx) {
  const { JIRA, options, output, meIdentifiers } = ctx;
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
      const issueKey = m[1].toUpperCase();
      const onlyMe = !!m[2];
      await showIssueTimes(issueKey, JIRA, output, onlyMe, meIdentifiers);
      return;
    }
    if (cmd === 'bug') {
      // Open issues page in a new tab
      try {
        chrome.tabs?.create({ url: 'https://github.com/haydencbarnes/jira-time-tracker-ext/issues/new' });
      } catch (_) {
        window.open('https://github.com/haydencbarnes/jira-time-tracker-ext/issues/new', '_blank');
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
      const issueKey = m[1].toUpperCase();
      await showIssueTimes(issueKey, JIRA, output, true, meIdentifiers);
      return;
    }
    writeLine(output, `Unknown command: /${cmd}`);
    return;
  }

  if (lc === 'help' || lc === '?') {
    writeLine(output, 'Usage: ISSUE TIME [DATE] [COMMENT]');
    writeLine(output, '  - TIME: 1h, 30m, 1d, combos like "1h 30m"');
    writeLine(output, '  - DATE: today, yesterday, mon..sun, or YYYY-MM-DD');
    writeLine(output, 'Info commands:');
    writeLine(output, '  time ISSUE-123           # show total and today time for an issue');
    writeLine(output, '  time ISSUE-123 --me      # show only your time totals');
    writeLine(output, '  ISSUE-123?               # quick alias to show times');
    writeLine(output, 'Slash commands:');
    writeLine(output, '  /time ISSUE-123 [--me]   # same as above, quicker');
    writeLine(output, '  /me ISSUE-123            # show only your time totals');
    writeLine(output, '  /bug                     # open issues page to report bugs');
    writeLine(output, '  /help                    # help');
    writeLine(output, 'Examples:');
    writeLine(output, '  PROJ-123 1h 30m today Fix tests');
    writeLine(output, '  log 90m to PROJ-123 yesterday build pipeline fix');
    writeLine(output, '  PROJ-1 2h');
    writeLine(output, 'Batch (semicolon or new line separated):');
    writeLine(output, '  PROJ-1 1h code review; PROJ-2 45m yesterday build fix');
    return;
  }

  // Quick info lookups: "time ISSUE-123" or "ISSUE-123?"
  const timeCmdMatch = lc.match(/^\s*(time|show|status)\s+([A-Z][A-Z0-9]+-\d+)(\s+--me)?\s*$/i);
  const quickIssueQuery = lc.match(/\b([A-Z][A-Z0-9]+-\d+)\?\s*$/);
  if (timeCmdMatch || quickIssueQuery) {
    const issueKey = (timeCmdMatch ? timeCmdMatch[2] : quickIssueQuery[1]).toUpperCase();
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

  const startedTime = typeof JIRA.buildStartedTimestamp === 'function' 
    ? JIRA.buildStartedTimestamp(parsed.date)
    : new Date(parsed.date || Date.now()).toISOString();
    await JIRA.updateWorklog(parsed.issueKey, parsed.seconds, startedTime, parsed.comment || '');

    const humanTime = formatHumanTime(parsed.seconds);
    writeLine(output, `✔ Logged ${humanTime} on ${wrapIssue(parsed.issueKey)}${parsed.comment ? ' — ' + parsed.comment : ''}`, 'line-success');
  } catch (error) {
    console.error('CLI log error:', error);
    // Prefer terminal error output; still send to handler for consistency
    writeLine(output, `✖ ${error.message || 'Failed to log time'}`, 'line-error');
    try { window.JiraErrorHandler?.handleJiraError(error, 'Failed to log time via CLI', 'cli'); } catch (_) {}
  }
}

async function showIssueTimes(issueKey, JIRA, output, onlyMe = false, meIdentifiers) {
  try {
    const resp = await JIRA.getIssueWorklog(issueKey);
    const worklogs = Array.isArray(resp?.worklogs) ? resp.worklogs : [];
    const logs = onlyMe ? filterMyWorklogs(worklogs, meIdentifiers) : worklogs;
    const totalSeconds = logs.reduce((acc, wl) => acc + (wl.timeSpentSeconds || 0), 0);
    const today = new Date();
    const todayKey = today.toISOString().slice(0, 10); // YYYY-MM-DD
    const todaySeconds = logs.reduce((acc, wl) => {
      const started = wl.started ? new Date(wl.started) : null;
      if (!started) return acc;
      const startedKey = started.toISOString().slice(0, 10);
      return acc + (startedKey === todayKey ? (wl.timeSpentSeconds || 0) : 0);
    }, 0);

    const fmt = (secs) => {
      const h = Math.floor(secs / 3600);
      const m = Math.round((secs % 3600) / 60);
      if (h && m) return `${h}h ${m}m`;
      if (h) return `${h}h`;
      return `${m}m`;
    };

    const scopeLabel = onlyMe ? 'my' : 'total';
    writeLine(output, `ℹ ${wrapIssue(issueKey)} — ${scopeLabel}: ${fmt(totalSeconds)}, today: ${fmt(todaySeconds)}`, 'line-info');

    // Show last log snippet
    if (logs.length > 0) {
      const last = logs[logs.length - 1];
      const lastH = (last.timeSpentSeconds || 0) / 3600;
      const lastComment = typeof last.comment === 'string'
        ? last.comment
        : last.comment?.content?.[0]?.content?.[0]?.text || '';
      const lastDate = last.started ? new Date(last.started).toLocaleString() : '';
      writeLine(output, `   last: ${(lastH).toFixed(1)}h on ${lastDate}${lastComment ? ` — ${lastComment}` : ''}`);
    }
  } catch (e) {
    writeLine(output, `✖ Failed to fetch worklogs for ${issueKey}: ${e.message || e}`, 'line-error');
  }
}

function filterMyWorklogs(worklogs, me) {
  if (!Array.isArray(worklogs)) return [];
  if (!me) return worklogs; // fallback: show all
  return worklogs.filter(wl => {
    const author = wl.author || wl.updateAuthor || {};
    const name = (author.accountId || author.emailAddress || author.displayName || author.name || '').toString().toLowerCase();
    return (
      (me.accountId && author.accountId && author.accountId === me.accountId) ||
      (me.email && name.includes(me.email)) ||
      (me.username && name.includes(me.username))
    );
  });
}

function buildMeIdentifiersFromLogin(loginResp, fallbackUsername) {
  try {
    return {
      accountId: loginResp?.accountId || loginResp?.key || null,
      email: (loginResp?.emailAddress || '').toLowerCase() || null,
      username: (fallbackUsername || '').toLowerCase() || null,
    };
  } catch (_) {
    return buildMeIdentifiersFromUsername(fallbackUsername);
  }
}

function buildMeIdentifiersFromUsername(username) {
  return {
    accountId: null,
    email: (username || '').toLowerCase(),
    username: (username || '').toLowerCase(),
  };
}

// Convert seconds to compact human string like "1h 30m"
function formatHumanTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const d = Math.floor(h / 8); // display day-equivalent if large
  if (d >= 1 && h % 8 === 0 && m === 0) return `${d}d`;
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
function parseNaturalLanguage(input) {
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
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit === 'd') totalSeconds += value * 24 * 3600;
    if (unit === 'h') totalSeconds += value * 3600;
    if (unit === 'm') totalSeconds += value * 60;
  }

  // If no explicit unit but looks like minutes number ("log 90 to ABC-1")
  if (totalSeconds === 0) {
    // Avoid capturing digits that are part of a work item key like PROJ-123
    const minutesOnly = text.match(/(?<![A-Z0-9]-)\b(\d{1,4})\b(?!-)/);
    if (minutesOnly) {
      const mins = parseInt(minutesOnly[1], 10);
      if (!isNaN(mins) && mins > 0) totalSeconds = mins * 60;
    }
  }

  // Extract date keywords: today, yesterday, weekdays, or explicit YYYY-MM-DD
  let date = null;
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
    const weekMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const wd = lower.match(/\b(sun|mon|tue|wed|thu|fri|sat)\b/);
    if (wd) {
      const target = weekMap[wd[1]];
      const d = new Date(today);
      const diff = (d.getDay() - target + 7) % 7 || 7; // last occurrence
      d.setDate(d.getDate() - diff);
      date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }
  }
  // Explicit date
  const explicit = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (explicit) {
    const y = parseInt(explicit[1], 10);
    const m = parseInt(explicit[2], 10);
    const d = parseInt(explicit[3], 10);
    date = new Date(y, m - 1, d);
  }

  // Build comment: remove work item key, time tokens, date tokens
  let comment = text;
  if (issueKey) comment = comment.replace(issueKey, '');
  comment = comment.replace(/\b(\d+)\s*[dhm]\b/gi, '');
  comment = comment.replace(/\b(\d{4}-\d{2}-\d{2}|today|yesterday|sun|mon|tue|wed|thu|fri|sat)\b/gi, '');
  comment = comment.replace(/\bto\b|\blog\b/gi, '');
  comment = comment.replace(/\s+/g, ' ').trim();

  return { issueKey, seconds: totalSeconds, date, comment };
}



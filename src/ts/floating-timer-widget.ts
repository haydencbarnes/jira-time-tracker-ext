import type {
  BackgroundTimerSettings,
  BackgroundWorklogResponse,
  ExtensionSettings,
  FloatingTimerLabel,
  SettingsChangedMessage,
  TimerState,
} from './shared/types';

(function () {
  if (window.__jiraFloatingTimerWidgetInitialized) return;
  window.__jiraFloatingTimerWidgetInitialized = true;

  const POSITION_STORAGE_KEY = 'floatingTimerWidgetPosition';
  const DRAG_THRESHOLD_PX = 6;
  // Hovering the grip this long turns it into an X that hides the widget.
  const DISMISS_HOVER_MS = 3000;
  const GRIP_ICON_MARKUP = '&#x2630;';
  const DISMISS_ICON_MARKUP = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"></path>
    </svg>
  `;

  type FloatingWidgetSettings = Required<
    Pick<
      ExtensionSettings,
      | 'apiToken'
      | 'baseUrl'
      | 'darkMode'
      | 'floatingTimerWidgetEnabled'
      | 'followSystemTheme'
      | 'jiraType'
      | 'username'
    >
  > & {
    floatingTimerLabel: FloatingTimerLabel;
  };

  type FloatingWidgetTimerState = Required<
    Pick<
      TimerState,
      | 'issueKey'
      | 'issueTitle'
      | 'timerSeconds'
      | 'timerIsRunning'
      | 'timerLastUpdated'
    >
  >;

  type WidgetPosition = {
    left: number;
    top: number;
  };

  class FloatingTimerWidget {
    private widget: HTMLDivElement | null;
    private gripButton: HTMLButtonElement | null;
    private dismissTimer: number | null;
    private dismissArmed: boolean;
    private issueText: HTMLButtonElement | null;
    private issueKeyText: HTMLSpanElement | null;
    private issueTitleText: HTMLButtonElement | null;
    private issueTitleInner: HTMLSpanElement | null;
    private marqueeFrame: number | null;
    private marqueeKey: string;
    private timerValue: HTMLButtonElement | null;
    private timerText: HTMLSpanElement | null;
    private logButton: HTMLButtonElement | null;
    private resetButton: HTMLButtonElement | null;
    private toggleButton: HTMLButtonElement | null;
    private confirmPanel: HTMLDivElement | null;
    private confirmText: HTMLParagraphElement | null;
    private interval: number | null;
    private settings: FloatingWidgetSettings | null;
    private issueKey: string;
    private issueTitle: string;
    private seconds: number;
    private isRunning: boolean;
    private lastUpdated: number | null;
    private themeMediaQuery: MediaQueryList | null;
    private position: WidgetPosition | null;
    private dragStart: {
      pointerId: number;
      startX: number;
      startY: number;
      originLeft: number;
      originTop: number;
      moved: boolean;
    } | null;
    private suppressClick: boolean;
    private isLogging: boolean;
    private boundSystemThemeListener: () => void;
    private boundStorageListener: (
      changes: { [key: string]: chrome.storage.StorageChange },
      namespace: string
    ) => void;
    private boundMessageListener: (message: unknown) => void;
    private boundResizeListener: () => void;
    private boundPointerMove: (event: PointerEvent) => void;
    private boundPointerUp: (event: PointerEvent) => void;

    constructor() {
      this.widget = null;
      this.gripButton = null;
      this.dismissTimer = null;
      this.dismissArmed = false;
      this.issueText = null;
      this.issueKeyText = null;
      this.issueTitleText = null;
      this.issueTitleInner = null;
      this.marqueeFrame = null;
      this.marqueeKey = '';
      this.timerValue = null;
      this.timerText = null;
      this.logButton = null;
      this.resetButton = null;
      this.toggleButton = null;
      this.confirmPanel = null;
      this.confirmText = null;
      this.interval = null;
      this.settings = null;
      this.issueKey = '';
      this.issueTitle = '';
      this.seconds = 0;
      this.isRunning = false;
      this.lastUpdated = null;
      this.themeMediaQuery = null;
      this.position = null;
      this.dragStart = null;
      this.suppressClick = false;
      this.isLogging = false;
      this.boundSystemThemeListener = this.applyTheme.bind(this);
      this.boundStorageListener = this.handleStorageChange.bind(this);
      this.boundMessageListener = this.handleMessage.bind(this);
      this.boundResizeListener = this.handleResize.bind(this);
      this.boundPointerMove = this.onPointerMove.bind(this);
      this.boundPointerUp = this.onPointerUp.bind(this);

      this.init();
    }

    async init(): Promise<void> {
      this.settings = await this.readSettings();
      this.position = await this.readPosition();
      await this.syncTimerState();
      this.updateVisibility();

      chrome.storage.onChanged.addListener(this.boundStorageListener);
      chrome.runtime.onMessage.addListener(this.boundMessageListener);
      window.addEventListener('resize', this.boundResizeListener);
    }

    readSettings(): Promise<FloatingWidgetSettings> {
      return new Promise((resolve) => {
        chrome.storage.sync.get(
          {
            apiToken: '',
            baseUrl: '',
            darkMode: false,
            floatingTimerLabel: 'keyAndTitle',
            floatingTimerWidgetEnabled: false,
            followSystemTheme: true,
            jiraType: 'cloud',
            username: '',
          },
          (items) => {
            const raw = items as FloatingWidgetSettings;
            resolve({
              ...raw,
              floatingTimerLabel: this.normalizeLabel(raw.floatingTimerLabel),
            });
          }
        );
      });
    }

    readTimerState(): Promise<FloatingWidgetTimerState> {
      return new Promise((resolve) => {
        chrome.storage.sync.get(
          {
            issueKey: '',
            issueTitle: '',
            timerSeconds: 0,
            timerIsRunning: false,
            timerLastUpdated: null,
          },
          (items) => resolve(items as FloatingWidgetTimerState)
        );
      });
    }

    writeTimerState(
      nextState: Partial<FloatingWidgetTimerState>
    ): Promise<void> {
      return new Promise<void>((resolve) => {
        chrome.storage.sync.set(nextState, () => resolve());
      });
    }

    clearTimerState(): Promise<void> {
      return new Promise<void>((resolve) => {
        chrome.storage.sync.remove(
          ['timerSeconds', 'timerIsRunning', 'timerLastUpdated'],
          () => resolve()
        );
      });
    }

    isWidgetPosition(value: unknown): value is WidgetPosition {
      return (
        !!value &&
        typeof value === 'object' &&
        typeof (value as WidgetPosition).left === 'number' &&
        typeof (value as WidgetPosition).top === 'number'
      );
    }

    readPosition(): Promise<WidgetPosition | null> {
      return new Promise((resolve) => {
        chrome.storage.local.get({ [POSITION_STORAGE_KEY]: null }, (items) => {
          const value = items[POSITION_STORAGE_KEY];
          resolve(this.isWidgetPosition(value) ? value : null);
        });
      });
    }

    persistPosition(position: WidgetPosition): void {
      this.position = position;
      chrome.storage.local.set({ [POSITION_STORAGE_KEY]: position });
    }

    shouldShow(): boolean {
      return this.settings?.floatingTimerWidgetEnabled === true;
    }

    normalizeLabel(value: unknown): FloatingTimerLabel {
      return value === 'key' || value === 'title' || value === 'keyAndTitle'
        ? value
        : 'keyAndTitle';
    }

    ensureWidget(): void {
      if (this.widget) return;

      // Drop widgets left behind by a content script from a previous
      // extension load; their script context is gone, so they never update.
      document
        .querySelectorAll('.jira-floating-timer-widget')
        .forEach((stale) => stale.remove());

      const widget = document.createElement('div');
      widget.className = 'jira-floating-timer-widget';
      widget.innerHTML = `
        <button type="button" class="jira-floating-timer-widget-grip" data-action="grip" title="Drag to move" aria-label="Drag to move">${GRIP_ICON_MARKUP}</button>
        <div class="jira-floating-timer-widget-copy">
          <div class="jira-floating-timer-widget-stack">
            <button type="button" class="jira-floating-timer-widget-issue" title="Open Jira issue">
              <span class="jira-floating-timer-widget-key"></span>
            </button>
            <button type="button" class="jira-floating-timer-widget-value" title="Open full timer">
              <span class="jira-floating-timer-widget-dot" aria-hidden="true"></span>
              <span class="jira-floating-timer-widget-time">0:00</span>
            </button>
          </div>
          <button type="button" class="jira-floating-timer-widget-title" title="Open Jira issue"><span class="jira-floating-timer-widget-title-text"></span></button>
        </div>
        <div class="jira-floating-timer-widget-actions">
          <button type="button" class="jira-floating-timer-widget-icon jira-floating-timer-widget-toggle" data-action="toggle" title="Start timer" aria-label="Start timer"></button>
          <button type="button" class="jira-floating-timer-widget-icon jira-floating-timer-widget-reset" data-action="reset" title="Reset timer" aria-label="Reset timer">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"></path>
            </svg>
          </button>
          <button type="button" class="jira-floating-timer-widget-icon jira-floating-timer-widget-log" data-action="log" title="Log time" aria-label="Log time">&#x21E1;</button>
        </div>
        <div class="jira-floating-timer-widget-confirm" hidden>
          <p class="jira-floating-timer-widget-confirm-text"></p>
          <div class="jira-floating-timer-widget-confirm-actions">
            <button type="button" data-action="log-cancel">Cancel</button>
            <button type="button" data-action="log-confirm">Log time &#x21E1;</button>
          </div>
        </div>
      `;

      widget
        .querySelector<HTMLButtonElement>('[data-action="toggle"]')
        ?.addEventListener('click', (event) => {
          if (this.shouldIgnoreClick(event)) return;
          if (this.isRunning) {
            void this.pauseTimer();
          } else {
            void this.startTimer();
          }
        });

      widget
        .querySelector<HTMLButtonElement>('[data-action="reset"]')
        ?.addEventListener('click', (event) => {
          if (this.shouldIgnoreClick(event)) return;
          void this.resetTimer();
        });

      widget
        .querySelector<HTMLButtonElement>('[data-action="log"]')
        ?.addEventListener('click', (event) => {
          if (this.shouldIgnoreClick(event)) return;
          this.openLogConfirm();
        });

      widget
        .querySelector<HTMLButtonElement>('[data-action="log-cancel"]')
        ?.addEventListener('click', (event) => {
          if (this.shouldIgnoreClick(event)) return;
          this.closeLogConfirm();
        });

      widget
        .querySelector<HTMLButtonElement>('[data-action="log-confirm"]')
        ?.addEventListener('click', (event) => {
          if (this.shouldIgnoreClick(event)) return;
          void this.confirmLog();
        });

      widget
        .querySelectorAll<HTMLButtonElement>(
          '.jira-floating-timer-widget-issue, .jira-floating-timer-widget-title'
        )
        .forEach((button) => {
          button.addEventListener('click', (event) => {
            if (this.shouldIgnoreClick(event)) return;
            this.openIssue();
          });
        });

      const grip = widget.querySelector<HTMLButtonElement>(
        '[data-action="grip"]'
      );
      grip?.addEventListener('pointerenter', (event) => {
        if (event.pointerType === 'mouse') this.startDismissTimer();
      });
      grip?.addEventListener('pointerleave', () => this.cancelDismiss());
      grip?.addEventListener('focus', () => this.startDismissTimer());
      grip?.addEventListener('blur', () => this.cancelDismiss());
      grip?.addEventListener('click', (event) => {
        if (this.shouldIgnoreClick(event)) return;
        if (!this.dismissArmed) return;
        void this.disableFloatingTimer();
      });

      widget
        .querySelector<HTMLButtonElement>('.jira-floating-timer-widget-value')
        ?.addEventListener('click', (event) => {
          if (this.shouldIgnoreClick(event)) return;
          this.openFullTimer();
        });

      widget.addEventListener('pointerdown', (event) => {
        this.onPointerDown(event);
      });
      widget.addEventListener(
        'click',
        (event) => {
          if (!this.suppressClick) return;
          event.preventDefault();
          event.stopPropagation();
          this.suppressClick = false;
        },
        true
      );
      widget.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && this.confirmPanel?.hidden === false) {
          event.stopPropagation();
          this.closeLogConfirm();
          this.logButton?.focus();
        }
      });

      document.body.appendChild(widget);

      this.widget = widget;
      this.gripButton = grip;
      this.issueText = widget.querySelector<HTMLButtonElement>(
        '.jira-floating-timer-widget-issue'
      );
      this.issueKeyText = widget.querySelector<HTMLSpanElement>(
        '.jira-floating-timer-widget-key'
      );
      this.issueTitleText = widget.querySelector<HTMLButtonElement>(
        '.jira-floating-timer-widget-title'
      );
      this.issueTitleInner = widget.querySelector<HTMLSpanElement>(
        '.jira-floating-timer-widget-title-text'
      );
      this.timerValue = widget.querySelector<HTMLButtonElement>(
        '.jira-floating-timer-widget-value'
      );
      this.timerText = widget.querySelector<HTMLSpanElement>(
        '.jira-floating-timer-widget-time'
      );
      this.logButton = widget.querySelector<HTMLButtonElement>(
        '[data-action="log"]'
      );
      this.resetButton = widget.querySelector<HTMLButtonElement>(
        '[data-action="reset"]'
      );
      this.toggleButton = widget.querySelector<HTMLButtonElement>(
        '[data-action="toggle"]'
      );
      this.confirmPanel = widget.querySelector<HTMLDivElement>(
        '.jira-floating-timer-widget-confirm'
      );
      this.confirmText = widget.querySelector<HTMLParagraphElement>(
        '.jira-floating-timer-widget-confirm-text'
      );

      this.applyTheme();
      this.applyPosition();
      this.render();
    }

    removeWidget(): void {
      this.stopDisplayInterval();
      this.detachThemeListener();
      this.endDrag();
      this.cancelDismiss();
      if (this.widget) {
        this.widget.remove();
        this.widget = null;
        this.gripButton = null;
        this.issueText = null;
        this.issueKeyText = null;
        this.issueTitleText = null;
        this.issueTitleInner = null;
        this.timerValue = null;
        this.timerText = null;
        this.logButton = null;
        this.resetButton = null;
        this.toggleButton = null;
        this.confirmPanel = null;
        this.confirmText = null;
      }
      if (this.marqueeFrame !== null) {
        window.cancelAnimationFrame(this.marqueeFrame);
        this.marqueeFrame = null;
      }
      this.marqueeKey = '';
    }

    updateVisibility(): void {
      if (!this.shouldShow()) {
        this.removeWidget();
        return;
      }

      this.ensureWidget();
      this.applyTheme();
      this.applyPosition();
      this.render();
      this.syncDisplayInterval();
    }

    handleMessage(message: unknown): void {
      const settingsMessage = message as Partial<SettingsChangedMessage> | null;
      if (!settingsMessage || settingsMessage.type !== 'SETTINGS_CHANGED')
        return;

      if (!this.settings) return;

      if (typeof settingsMessage.floatingTimerWidgetEnabled === 'boolean') {
        this.settings.floatingTimerWidgetEnabled =
          settingsMessage.floatingTimerWidgetEnabled;
      }

      this.updateVisibility();
    }

    async handleStorageChange(
      changes: { [key: string]: chrome.storage.StorageChange },
      namespace: string
    ): Promise<void> {
      if (namespace === 'local' && changes[POSITION_STORAGE_KEY]) {
        const next = changes[POSITION_STORAGE_KEY].newValue;
        if (this.isWidgetPosition(next)) {
          this.position = next;
          this.applyPosition();
        }
        return;
      }

      if (namespace !== 'sync') return;

      if (
        changes.floatingTimerWidgetEnabled ||
        changes.floatingTimerLabel ||
        changes.baseUrl ||
        changes.username ||
        changes.apiToken ||
        changes.jiraType ||
        changes.followSystemTheme ||
        changes.darkMode
      ) {
        this.settings = await this.readSettings();
        this.updateVisibility();
      }

      if (
        changes.issueKey ||
        changes.issueTitle ||
        changes.timerSeconds ||
        changes.timerIsRunning ||
        changes.timerLastUpdated
      ) {
        this.applyTimerStateFromChanges(changes);
        this.render();
        this.syncDisplayInterval();
      }
    }

    applyStoredTimerState(state: FloatingWidgetTimerState): void {
      this.issueKey = state.issueKey
        ? String(state.issueKey).trim().toUpperCase()
        : '';
      this.issueTitle = state.issueTitle ? String(state.issueTitle).trim() : '';
      this.seconds = Number.isFinite(state.timerSeconds)
        ? state.timerSeconds
        : 0;
      this.isRunning = state.timerIsRunning === true;
      this.lastUpdated = state.timerLastUpdated || null;

      if (this.isRunning) {
        this.seconds = this.getCurrentSeconds();
        this.lastUpdated = Date.now();
      }
    }

    async syncTimerState(): Promise<void> {
      const state = await this.readTimerState();
      this.applyStoredTimerState(state);
    }

    getCurrentSeconds(): number {
      if (!this.isRunning || !this.lastUpdated) {
        return Math.max(0, this.seconds || 0);
      }

      const elapsedSeconds = Math.floor((Date.now() - this.lastUpdated) / 1000);
      return Math.max(0, (this.seconds || 0) + Math.max(0, elapsedSeconds));
    }

    formatTimer(totalSeconds: number): string {
      const safeSeconds = Math.max(0, totalSeconds || 0);
      const hours = Math.floor(safeSeconds / 3600);
      const minutes = Math.floor((safeSeconds % 3600) / 60);
      const seconds = safeSeconds % 60;
      if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      }
      return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    formatLogDuration(totalSeconds: number): string {
      const safeSeconds = Math.max(0, totalSeconds || 0);
      const hours = Math.floor(safeSeconds / 3600);
      const minutes = Math.floor((safeSeconds % 3600) / 60);
      const seconds = safeSeconds % 60;
      const parts: string[] = [];
      if (hours > 0) parts.push(`${hours}h`);
      if (minutes > 0) parts.push(`${minutes}m`);
      if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
      return parts.join(' ');
    }

    getToggleIconMarkup(): string {
      // Same Material "pause" / "play_arrow" glyphs as the timer page.
      const path = this.isRunning
        ? 'M6 19h4V5H6v14zm8-14v14h4V5h-4z'
        : 'M8 5v14l11-7z';
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="${path}"></path>
        </svg>
      `;
    }

    renderIssueLabel(): void {
      if (!this.issueText || !this.issueKeyText || !this.issueTitleText) return;

      const mode = this.settings?.floatingTimerLabel || 'keyAndTitle';
      const key = this.issueKey;
      const title = this.issueTitle;
      const showKey = !!key && (mode !== 'title' || !title);
      const showTitle = !!title && mode !== 'key';

      const openLabel = key ? `Open ${key} in Jira` : 'Open Jira issue';

      // Key sits above the time in the centered stack.
      this.issueKeyText.textContent = showKey ? key : '';
      this.issueText.hidden = !showKey;
      this.issueText.disabled = !key;
      this.issueText.title = openLabel;
      this.issueText.setAttribute('aria-label', openLabel);

      // Title is its own column, vertically centered beside the stack.
      if (this.issueTitleInner) {
        this.issueTitleInner.textContent = showTitle ? title : '';
      } else {
        this.issueTitleText.textContent = showTitle ? title : '';
      }
      this.issueTitleText.hidden = !showTitle;
      this.issueTitleText.disabled = !key;
      this.issueTitleText.title = key ? `${title}\n${openLabel}` : title;
      this.issueTitleText.setAttribute(
        'aria-label',
        key ? `${title}. ${openLabel}` : title
      );
      this.widget?.classList.toggle('has-title', showTitle);
      this.updateTitleMarquee();
    }

    getIssueUrl(): string {
      if (!this.issueKey || !this.settings?.baseUrl) return '';

      const hasProtocol = /^https?:\/\//i.test(this.settings.baseUrl);
      const normalizedBaseUrl = hasProtocol
        ? this.settings.baseUrl
        : `https://${this.settings.baseUrl}`;

      return `${normalizedBaseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(this.issueKey)}`;
    }

    getTimerChangeValue<T>(
      changes: { [key: string]: chrome.storage.StorageChange },
      key: string,
      defaultValue: T,
      fallbackValue: T
    ): T {
      if (!(key in changes)) return fallbackValue;
      const change = changes[key];
      if (!change) return fallbackValue;
      return Object.prototype.hasOwnProperty.call(change, 'newValue')
        ? (change.newValue as T)
        : defaultValue;
    }

    applyTimerStateFromChanges(changes: {
      [key: string]: chrome.storage.StorageChange;
    }): void {
      this.applyStoredTimerState({
        issueKey: this.getTimerChangeValue(
          changes,
          'issueKey',
          '',
          this.issueKey
        ),
        issueTitle: this.getTimerChangeValue(
          changes,
          'issueTitle',
          '',
          this.issueTitle
        ),
        timerSeconds: this.getTimerChangeValue(
          changes,
          'timerSeconds',
          0,
          this.seconds
        ),
        timerIsRunning: this.getTimerChangeValue(
          changes,
          'timerIsRunning',
          false,
          this.isRunning
        ),
        timerLastUpdated: this.getTimerChangeValue(
          changes,
          'timerLastUpdated',
          null,
          this.lastUpdated
        ),
      });
    }

    /**
     * Scroll the title back and forth when it doesn't fit, so the whole
     * text can be read. Measured on the next frame; skipped when nothing
     * relevant changed since the last measurement.
     */
    updateTitleMarquee(force = false): void {
      const clip = this.issueTitleText;
      const inner = this.issueTitleInner;
      if (!clip || !inner) return;

      const key = clip.hidden
        ? ''
        : `${inner.textContent ?? ''}|${this.issueKeyText?.hidden ? '' : this.issueKeyText?.textContent}`;
      if (!force && key === this.marqueeKey) return;
      this.marqueeKey = key;

      if (this.marqueeFrame !== null) {
        window.cancelAnimationFrame(this.marqueeFrame);
      }
      this.marqueeFrame = window.requestAnimationFrame(() => {
        this.marqueeFrame = null;
        if (!this.issueTitleText || !this.issueTitleInner) return;
        if (this.issueTitleText.hidden) {
          this.issueTitleText.classList.remove('is-scrolling');
          return;
        }

        // Compare the text width with the visible width. The bounding rect
        // ignores the marquee's translateX, so this is safe to run while the
        // animation is mid-flight without restarting it.
        const overflow = Math.ceil(
          this.issueTitleInner.getBoundingClientRect().width -
            this.issueTitleText.clientWidth
        );
        if (overflow <= 2) {
          this.issueTitleText.classList.remove('is-scrolling');
          this.issueTitleText.style.removeProperty('--jira-ftw-overflow');
          this.issueTitleText.style.removeProperty('--jira-ftw-duration');
          return;
        }

        // Roughly 35px/s of travel plus a hold at each end, capped so very
        // long titles still cycle in a reasonable time.
        const duration = Math.min(24, Math.max(6, overflow / 12 + 2));
        this.issueTitleText.style.setProperty(
          '--jira-ftw-overflow',
          `-${overflow}px`
        );
        this.issueTitleText.style.setProperty(
          '--jira-ftw-duration',
          `${duration.toFixed(1)}s`
        );
        this.issueTitleText.classList.add('is-scrolling');
      });
    }

    handleResize(): void {
      this.clampPositionToViewport();
      this.updateTitleMarquee(true);
    }

    startDismissTimer(): void {
      if (this.dismissArmed || this.dismissTimer !== null || this.dragStart) {
        return;
      }
      this.dismissTimer = window.setTimeout(() => {
        this.dismissTimer = null;
        this.dismissArmed = true;
        this.renderGrip();
      }, DISMISS_HOVER_MS);
    }

    cancelDismiss(): void {
      if (this.dismissTimer !== null) {
        window.clearTimeout(this.dismissTimer);
        this.dismissTimer = null;
      }
      if (this.dismissArmed) {
        this.dismissArmed = false;
        this.renderGrip();
      }
    }

    renderGrip(): void {
      if (!this.gripButton) return;
      const label = this.dismissArmed
        ? 'Hide the floating timer (turn it back on in Settings)'
        : 'Drag to move';
      this.gripButton.classList.toggle('is-dismiss', this.dismissArmed);
      this.gripButton.innerHTML = this.dismissArmed
        ? DISMISS_ICON_MARKUP
        : GRIP_ICON_MARKUP;
      this.gripButton.title = label;
      this.gripButton.setAttribute('aria-label', label);
    }

    /** Turns the floating timer setting off; the timer itself keeps running. */
    async disableFloatingTimer(): Promise<void> {
      this.cancelDismiss();
      await new Promise<void>((resolve) => {
        chrome.storage.sync.set({ floatingTimerWidgetEnabled: false }, () =>
          resolve()
        );
      });
      if (this.settings) this.settings.floatingTimerWidgetEnabled = false;
      this.updateVisibility();
    }

    render(): void {
      if (
        !this.widget ||
        !this.issueText ||
        !this.timerValue ||
        !this.logButton ||
        !this.resetButton ||
        !this.toggleButton
      )
        return;

      const currentSeconds = this.getCurrentSeconds();
      const canReset = this.isRunning || currentSeconds > 0;
      const canLog = !!this.issueKey && currentSeconds > 0 && !this.isLogging;
      this.renderIssueLabel();
      this.widget.classList.toggle('is-running', this.isRunning);
      const formattedTime = this.formatTimer(currentSeconds);
      if (this.timerText) {
        this.timerText.textContent = formattedTime;
      } else {
        this.timerValue.textContent = formattedTime;
      }
      this.timerValue.setAttribute(
        'aria-label',
        `${this.isRunning ? 'Timer running' : 'Timer paused'}, ${formattedTime}. Open full timer`
      );
      this.logButton.disabled = !canLog;
      this.logButton.title = !this.issueKey
        ? 'Select a work item on the timer page first'
        : currentSeconds <= 0
          ? 'Start the timer before logging'
          : `Log ${this.formatLogDuration(currentSeconds)} to ${this.issueKey}`;
      this.logButton.setAttribute('aria-label', this.logButton.title);
      this.resetButton.disabled = !canReset;
      this.resetButton.title = canReset ? 'Reset timer' : 'Timer already reset';
      this.resetButton.setAttribute(
        'aria-label',
        canReset ? 'Reset timer' : 'Timer already reset'
      );
      this.toggleButton.innerHTML = this.getToggleIconMarkup();
      const toggleTitle = this.isRunning
        ? 'Pause timer'
        : currentSeconds > 0
          ? 'Resume timer'
          : 'Start timer';
      this.toggleButton.title = toggleTitle;
      this.toggleButton.setAttribute('aria-label', toggleTitle);
    }

    syncDisplayInterval(): void {
      if (!this.widget) {
        this.stopDisplayInterval();
        return;
      }

      if (!this.isRunning) {
        this.stopDisplayInterval();
        this.render();
        return;
      }

      if (this.interval) return;

      this.render();
      this.interval = window.setInterval(() => {
        this.render();
      }, 1000);
    }

    stopDisplayInterval(): void {
      if (this.interval) {
        window.clearInterval(this.interval);
        this.interval = null;
      }
    }

    async startTimer(): Promise<void> {
      const currentSeconds = this.getCurrentSeconds();
      const now = Date.now();

      await this.writeTimerState({
        timerSeconds: currentSeconds,
        timerIsRunning: true,
        timerLastUpdated: now,
      });

      chrome.runtime.sendMessage({
        action: 'startTimer',
        seconds: currentSeconds,
      });

      this.seconds = currentSeconds;
      this.isRunning = true;
      this.lastUpdated = now;
      this.render();
      this.syncDisplayInterval();
    }

    async pauseTimer(): Promise<void> {
      const currentSeconds = this.getCurrentSeconds();
      const now = Date.now();

      await this.writeTimerState({
        timerSeconds: currentSeconds,
        timerIsRunning: false,
        timerLastUpdated: now,
      });

      chrome.runtime.sendMessage({ action: 'stopTimer' });

      this.seconds = currentSeconds;
      this.isRunning = false;
      this.lastUpdated = now;
      this.render();
      this.syncDisplayInterval();
    }

    async resetTimer(): Promise<void> {
      await this.clearTimerState();
      chrome.runtime.sendMessage({ action: 'resetTimer' });

      this.seconds = 0;
      this.isRunning = false;
      this.lastUpdated = null;
      this.closeLogConfirm();
      this.render();
      this.syncDisplayInterval();
    }

    getBackgroundSettings(): BackgroundTimerSettings | null {
      if (
        !this.settings?.baseUrl ||
        !this.settings.username ||
        !this.settings.apiToken
      ) {
        return null;
      }

      return {
        jiraType: this.settings.jiraType,
        baseUrl: this.settings.baseUrl,
        username: this.settings.username,
        apiToken: this.settings.apiToken,
      };
    }

    openLogConfirm(): void {
      const currentSeconds = this.getCurrentSeconds();
      if (!this.widget || !this.confirmPanel || !this.confirmText) return;
      if (!this.issueKey || currentSeconds <= 0) return;

      this.confirmText.textContent = `Log ${this.formatLogDuration(currentSeconds)} to ${this.issueKey}?`;

      // Keep the panel on screen wherever the pill has been dragged.
      const rect = this.widget.getBoundingClientRect();
      this.confirmPanel.classList.toggle('is-below', rect.top < 120);
      this.confirmPanel.classList.toggle('is-left', rect.left < 260);
      this.confirmPanel.hidden = false;
      this.widget
        .querySelector<HTMLButtonElement>('[data-action="log-confirm"]')
        ?.focus();
    }

    closeLogConfirm(): void {
      if (this.confirmPanel) this.confirmPanel.hidden = true;
      this.isLogging = false;
      this.render();
    }

    async confirmLog(): Promise<void> {
      const currentSeconds = this.getCurrentSeconds();
      const settings = this.getBackgroundSettings();
      if (!this.issueKey || currentSeconds <= 0) {
        this.closeLogConfirm();
        return;
      }
      if (!settings) {
        if (this.confirmText) {
          this.confirmText.textContent =
            'Add your Jira URL, username, and API token in Options first.';
        }
        return;
      }

      this.isLogging = true;
      this.render();
      if (this.confirmText) {
        this.confirmText.textContent = `Logging ${this.formatLogDuration(currentSeconds)} to ${this.issueKey}...`;
      }

      try {
        const response = await this.sendWorklog(
          settings,
          this.issueKey,
          currentSeconds
        );
        if (!response.success) {
          throw new Error(response.error?.message || 'Failed to log work');
        }

        // Update the pill first so the reset is visible immediately, then
        // celebrate; AudioContext setup can take a moment on some pages.
        await this.resetTimer();
        this.showLogFlash();
        window.setTimeout(() => this.playLogDing(), 0);
      } catch (error) {
        this.isLogging = false;
        this.render();
        if (this.confirmText) {
          this.confirmText.textContent =
            error instanceof Error
              ? error.message
              : `Failed to log time to ${this.issueKey}`;
        }
      }
    }

    sendWorklog(
      settings: BackgroundTimerSettings,
      issueKey: string,
      timeInSeconds: number
    ): Promise<BackgroundWorklogResponse> {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            action: 'logWorklog',
            settings,
            issueId: issueKey,
            timeInSeconds,
            startedTime: new Date().toISOString(),
            comment: '',
          },
          (response) => {
            if (chrome.runtime.lastError) {
              resolve({
                success: false,
                error: {
                  message:
                    chrome.runtime.lastError.message ??
                    'Extension runtime error',
                  status: 0,
                },
              });
              return;
            }

            resolve(
              (response || {
                success: false,
                error: { message: 'Empty background response', status: 0 },
              }) as BackgroundWorklogResponse
            );
          }
        );
      });
    }

    playLogDing(): void {
      try {
        const AudioContextCtor =
          window.AudioContext ||
          (window as Window & { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (!AudioContextCtor) return;

        const audioContext = new AudioContextCtor();
        void audioContext.resume();
        const now = audioContext.currentTime;
        const notes = [523.25, 659.25, 783.99];

        notes.forEach((frequency, index) => {
          const oscillator = audioContext.createOscillator();
          const gain = audioContext.createGain();
          const start = now + index * 0.08;
          oscillator.type = 'sine';
          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
          oscillator.connect(gain);
          gain.connect(audioContext.destination);
          oscillator.start(start);
          oscillator.stop(start + 0.36);
        });

        window.setTimeout(() => {
          void audioContext.close();
        }, 800);
      } catch {
        // Audio can be blocked by the page; logging still succeeded.
      }
    }

    showLogFlash(): void {
      const flash = document.createElement('div');
      flash.className = 'jira-floating-timer-log-flash';
      document.documentElement.appendChild(flash);
      window.setTimeout(() => {
        flash.remove();
      }, 1700);
    }

    applyPosition(): void {
      if (!this.widget) return;

      if (!this.position) {
        this.widget.style.left = '';
        this.widget.style.top = '';
        this.widget.style.right = '16px';
        this.widget.style.bottom = '16px';
        return;
      }

      const next = this.getClampedPosition(this.position);
      this.widget.style.right = 'auto';
      this.widget.style.bottom = 'auto';
      this.widget.style.left = `${next.left}px`;
      this.widget.style.top = `${next.top}px`;
      this.position = next;
    }

    getClampedPosition(position: WidgetPosition): WidgetPosition {
      const width = this.widget?.offsetWidth || 180;
      const height = this.widget?.offsetHeight || 48;
      const maxLeft = Math.max(8, window.innerWidth - width - 8);
      const maxTop = Math.max(8, window.innerHeight - height - 8);
      return {
        left: Math.min(Math.max(8, position.left), maxLeft),
        top: Math.min(Math.max(8, position.top), maxTop),
      };
    }

    clampPositionToViewport(): void {
      if (!this.position || !this.widget) return;
      const next = this.getClampedPosition(this.position);
      if (next.left === this.position.left && next.top === this.position.top) {
        return;
      }
      this.persistPosition(next);
      this.applyPosition();
    }

    getWidgetOrigin(): WidgetPosition {
      if (!this.widget) return { left: 0, top: 0 };
      const rect = this.widget.getBoundingClientRect();
      return { left: rect.left, top: rect.top };
    }

    onPointerDown(event: PointerEvent): void {
      if (!this.widget || event.button !== 0 || this.dragStart) return;
      if (
        event.target instanceof Element &&
        event.target.closest('.jira-floating-timer-widget-confirm')
      ) {
        return;
      }

      // A press is the start of a drag, never a hover; make sure holding the
      // grip still can't arm the hide button.
      if (!this.dismissArmed) this.cancelDismiss();

      const origin = this.getWidgetOrigin();
      this.dragStart = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originLeft: origin.left,
        originTop: origin.top,
        moved: false,
      };
      // Track the gesture on the window instead of capturing the pointer here:
      // capturing on pointerdown reroutes the eventual click to the pill, so
      // the buttons underneath would never receive it.
      window.addEventListener('pointermove', this.boundPointerMove, true);
      window.addEventListener('pointerup', this.boundPointerUp, true);
      window.addEventListener('pointercancel', this.boundPointerUp, true);
    }

    onPointerMove(event: PointerEvent): void {
      if (!this.widget || !this.dragStart) return;
      if (event.pointerId !== this.dragStart.pointerId) return;

      const deltaX = event.clientX - this.dragStart.startX;
      const deltaY = event.clientY - this.dragStart.startY;
      if (!this.dragStart.moved) {
        if (Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD_PX) return;

        this.dragStart.moved = true;
        this.widget.classList.add('is-dragging');
        this.closeLogConfirm();
        this.cancelDismiss();
        try {
          // Safe to capture now: a click is no longer wanted for this gesture.
          this.widget.setPointerCapture(event.pointerId);
        } catch {
          // Window listeners keep tracking the pointer without capture.
        }
      }

      const next = this.getClampedPosition({
        left: this.dragStart.originLeft + deltaX,
        top: this.dragStart.originTop + deltaY,
      });
      this.widget.style.right = 'auto';
      this.widget.style.bottom = 'auto';
      this.widget.style.left = `${next.left}px`;
      this.widget.style.top = `${next.top}px`;
    }

    onPointerUp(event: PointerEvent): void {
      if (!this.dragStart || event.pointerId !== this.dragStart.pointerId)
        return;

      if (this.dragStart.moved && this.widget) {
        this.suppressClick = true;
        // Any click from this gesture fires right after pointerup; clear the
        // flag afterwards so it can't swallow the next real click.
        window.setTimeout(() => {
          this.suppressClick = false;
        }, 0);
        const rect = this.widget.getBoundingClientRect();
        this.persistPosition({ left: rect.left, top: rect.top });
      }

      this.endDrag();
    }

    endDrag(): void {
      if (this.widget) {
        this.widget.classList.remove('is-dragging');
        if (
          this.dragStart &&
          this.widget.hasPointerCapture(this.dragStart.pointerId)
        ) {
          this.widget.releasePointerCapture(this.dragStart.pointerId);
        }
      }
      window.removeEventListener('pointermove', this.boundPointerMove, true);
      window.removeEventListener('pointerup', this.boundPointerUp, true);
      window.removeEventListener('pointercancel', this.boundPointerUp, true);
      this.dragStart = null;
    }

    shouldIgnoreClick(event: Event): boolean {
      if (!this.suppressClick) return false;
      event.preventDefault();
      event.stopPropagation();
      this.suppressClick = false;
      return true;
    }

    openFullTimer(): void {
      this.openUrl(chrome.runtime.getURL('dist/timerFeatureModule/timer.html'));
    }

    openIssue(): void {
      const issueUrl = this.getIssueUrl();
      if (!issueUrl) return;
      this.openUrl(issueUrl);
    }

    openUrl(url: string): void {
      if (!url) return;
      chrome.runtime.sendMessage({ action: 'openUrl', url });
    }

    applyTheme(): void {
      if (!this.widget) return;

      this.attachThemeListener();

      const shouldUseDarkTheme =
        this.settings?.followSystemTheme !== false
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
          : this.settings?.darkMode === true;

      this.widget.classList.toggle('dark', shouldUseDarkTheme);
    }

    attachThemeListener(): void {
      if (this.settings?.followSystemTheme === false) {
        this.detachThemeListener();
        return;
      }

      if (!this.themeMediaQuery) {
        this.themeMediaQuery = window.matchMedia(
          '(prefers-color-scheme: dark)'
        );
        if (typeof this.themeMediaQuery.addEventListener === 'function') {
          this.themeMediaQuery.addEventListener(
            'change',
            this.boundSystemThemeListener
          );
        } else if (typeof this.themeMediaQuery.addListener === 'function') {
          this.themeMediaQuery.addListener(this.boundSystemThemeListener);
        }
      }
    }

    detachThemeListener(): void {
      if (!this.themeMediaQuery) return;

      if (typeof this.themeMediaQuery.removeEventListener === 'function') {
        this.themeMediaQuery.removeEventListener(
          'change',
          this.boundSystemThemeListener
        );
      } else if (typeof this.themeMediaQuery.removeListener === 'function') {
        this.themeMediaQuery.removeListener(this.boundSystemThemeListener);
      }

      this.themeMediaQuery = null;
    }
  }

  new FloatingTimerWidget();
})();
export {};

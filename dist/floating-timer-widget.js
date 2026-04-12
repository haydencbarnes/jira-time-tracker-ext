"use strict";
(() => {
  // src/ts/floating-timer-widget.ts
  (function() {
    if (window.__jiraFloatingTimerWidgetInitialized) return;
    window.__jiraFloatingTimerWidgetInitialized = true;
    class FloatingTimerWidget {
      widget;
      timerText;
      issueText;
      issueSeparator;
      timerValue;
      resetButton;
      toggleButton;
      interval;
      settings;
      issueKey;
      seconds;
      isRunning;
      lastUpdated;
      themeMediaQuery;
      boundSystemThemeListener;
      boundStorageListener;
      boundMessageListener;
      constructor() {
        this.widget = null;
        this.timerText = null;
        this.issueText = null;
        this.issueSeparator = null;
        this.timerValue = null;
        this.resetButton = null;
        this.toggleButton = null;
        this.interval = null;
        this.settings = null;
        this.issueKey = "";
        this.seconds = 0;
        this.isRunning = false;
        this.lastUpdated = null;
        this.themeMediaQuery = null;
        this.boundSystemThemeListener = this.applyTheme.bind(this);
        this.boundStorageListener = this.handleStorageChange.bind(this);
        this.boundMessageListener = this.handleMessage.bind(this);
        this.init();
      }
      async init() {
        this.settings = await this.readSettings();
        await this.syncTimerState();
        this.updateVisibility();
        chrome.storage.onChanged.addListener(this.boundStorageListener);
        chrome.runtime.onMessage.addListener(this.boundMessageListener);
      }
      readSettings() {
        return new Promise((resolve) => {
          chrome.storage.sync.get(
            {
              baseUrl: "",
              experimentalFeatures: false,
              floatingTimerWidgetEnabled: false,
              followSystemTheme: true,
              darkMode: false
            },
            (items) => resolve(items)
          );
        });
      }
      readTimerState() {
        return new Promise((resolve) => {
          chrome.storage.sync.get(
            {
              issueKey: "",
              timerSeconds: 0,
              timerIsRunning: false,
              timerLastUpdated: null
            },
            (items) => resolve(items)
          );
        });
      }
      writeTimerState(nextState) {
        return new Promise((resolve) => {
          chrome.storage.sync.set(nextState, () => resolve());
        });
      }
      clearTimerState() {
        return new Promise((resolve) => {
          chrome.storage.sync.remove(
            ["timerSeconds", "timerIsRunning", "timerLastUpdated"],
            () => resolve()
          );
        });
      }
      shouldShow() {
        return !!(this.settings?.experimentalFeatures && this.settings?.floatingTimerWidgetEnabled);
      }
      ensureWidget() {
        if (this.widget) return;
        const widget = document.createElement("div");
        widget.className = "jira-floating-timer-widget";
        widget.innerHTML = `
        <span class="jira-floating-timer-widget-badge">Beta</span>
        <div class="jira-floating-timer-widget-time">
          <button type="button" class="jira-floating-timer-widget-issue" title="Open Jira issue"></button>
          <span class="jira-floating-timer-widget-separator" aria-hidden="true">&middot;</span>
          <button type="button" class="jira-floating-timer-widget-value" title="Open full timer">0:00</button>
        </div>
        <button type="button" class="jira-floating-timer-widget-icon jira-floating-timer-widget-reset" data-action="reset" title="Reset timer" aria-label="Reset timer">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"></path>
          </svg>
        </button>
        <button type="button" class="jira-floating-timer-widget-icon jira-floating-timer-widget-toggle" data-action="toggle" title="Start timer" aria-label="Start timer"></button>
      `;
        widget.querySelector('[data-action="toggle"]')?.addEventListener("click", () => {
          if (this.isRunning) {
            void this.pauseTimer();
          } else {
            void this.startTimer();
          }
        });
        widget.querySelector('[data-action="reset"]')?.addEventListener("click", () => {
          void this.resetTimer();
        });
        widget.querySelector(".jira-floating-timer-widget-issue")?.addEventListener("click", () => {
          this.openIssue();
        });
        widget.querySelector(".jira-floating-timer-widget-value")?.addEventListener("click", () => {
          this.openFullTimer();
        });
        document.body.appendChild(widget);
        this.widget = widget;
        this.timerText = widget.querySelector(
          ".jira-floating-timer-widget-time"
        );
        this.issueText = widget.querySelector(
          ".jira-floating-timer-widget-issue"
        );
        this.issueSeparator = widget.querySelector(
          ".jira-floating-timer-widget-separator"
        );
        this.timerValue = widget.querySelector(
          ".jira-floating-timer-widget-value"
        );
        this.resetButton = widget.querySelector(
          '[data-action="reset"]'
        );
        this.toggleButton = widget.querySelector(
          '[data-action="toggle"]'
        );
        this.applyTheme();
        this.render();
      }
      removeWidget() {
        this.stopDisplayInterval();
        this.detachThemeListener();
        if (this.widget) {
          this.widget.remove();
          this.widget = null;
          this.timerText = null;
          this.issueText = null;
          this.issueSeparator = null;
          this.timerValue = null;
          this.resetButton = null;
          this.toggleButton = null;
        }
      }
      updateVisibility() {
        if (!this.shouldShow()) {
          this.removeWidget();
          return;
        }
        this.ensureWidget();
        this.applyTheme();
        this.render();
        this.syncDisplayInterval();
      }
      handleMessage(message) {
        const settingsMessage = message;
        if (!settingsMessage || settingsMessage.type !== "SETTINGS_CHANGED")
          return;
        if (!this.settings) return;
        if (typeof settingsMessage.experimentalFeatures === "boolean") {
          this.settings.experimentalFeatures = settingsMessage.experimentalFeatures;
        }
        if (typeof settingsMessage.floatingTimerWidgetEnabled === "boolean") {
          this.settings.floatingTimerWidgetEnabled = settingsMessage.floatingTimerWidgetEnabled;
        }
        this.updateVisibility();
      }
      async handleStorageChange(changes, namespace) {
        if (namespace !== "sync") return;
        if (changes.experimentalFeatures || changes.floatingTimerWidgetEnabled || changes.baseUrl || changes.followSystemTheme || changes.darkMode) {
          this.settings = await this.readSettings();
          this.updateVisibility();
        }
        if (changes.issueKey || changes.timerSeconds || changes.timerIsRunning || changes.timerLastUpdated) {
          this.applyTimerStateFromChanges(changes);
          this.render();
          this.syncDisplayInterval();
        }
      }
      applyStoredTimerState(state) {
        this.issueKey = state.issueKey ? String(state.issueKey).trim().toUpperCase() : "";
        this.seconds = Number.isFinite(state.timerSeconds) ? state.timerSeconds : 0;
        this.isRunning = state.timerIsRunning === true;
        this.lastUpdated = state.timerLastUpdated || null;
        if (this.isRunning) {
          this.seconds = this.getCurrentSeconds();
          this.lastUpdated = Date.now();
        }
      }
      async syncTimerState() {
        const state = await this.readTimerState();
        this.applyStoredTimerState(state);
      }
      getCurrentSeconds() {
        if (!this.isRunning || !this.lastUpdated) {
          return Math.max(0, this.seconds || 0);
        }
        const elapsedSeconds = Math.floor((Date.now() - this.lastUpdated) / 1e3);
        return Math.max(0, (this.seconds || 0) + Math.max(0, elapsedSeconds));
      }
      formatTimer(totalSeconds) {
        const safeSeconds = Math.max(0, totalSeconds || 0);
        const hours = Math.floor(safeSeconds / 3600);
        const minutes = Math.floor(safeSeconds % 3600 / 60);
        const seconds = safeSeconds % 60;
        if (hours > 0) {
          return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
        }
        return `${minutes}:${String(seconds).padStart(2, "0")}`;
      }
      getToggleIconMarkup() {
        if (this.isRunning) {
          return `
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <rect x="6" y="5" width="4" height="14" rx="1"></rect>
            <rect x="14" y="5" width="4" height="14" rx="1"></rect>
          </svg>
        `;
        }
        return `
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M8 5.5v13l10-6.5z"></path>
        </svg>
      `;
      }
      getIssueUrl() {
        if (!this.issueKey || !this.settings?.baseUrl) return "";
        const hasProtocol = /^https?:\/\//i.test(this.settings.baseUrl);
        const normalizedBaseUrl = hasProtocol ? this.settings.baseUrl : `https://${this.settings.baseUrl}`;
        return `${normalizedBaseUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(this.issueKey)}`;
      }
      getTimerChangeValue(changes, key, defaultValue, fallbackValue) {
        if (!(key in changes)) return fallbackValue;
        const change = changes[key];
        if (!change) return fallbackValue;
        return Object.prototype.hasOwnProperty.call(change, "newValue") ? change.newValue : defaultValue;
      }
      applyTimerStateFromChanges(changes) {
        this.applyStoredTimerState({
          issueKey: this.getTimerChangeValue(
            changes,
            "issueKey",
            "",
            this.issueKey
          ),
          timerSeconds: this.getTimerChangeValue(
            changes,
            "timerSeconds",
            0,
            this.seconds
          ),
          timerIsRunning: this.getTimerChangeValue(
            changes,
            "timerIsRunning",
            false,
            this.isRunning
          ),
          timerLastUpdated: this.getTimerChangeValue(
            changes,
            "timerLastUpdated",
            null,
            this.lastUpdated
          )
        });
      }
      render() {
        if (!this.widget || !this.issueText || !this.issueSeparator || !this.timerValue || !this.resetButton || !this.toggleButton)
          return;
        const currentSeconds = this.getCurrentSeconds();
        const canReset = this.isRunning || currentSeconds > 0;
        this.issueText.textContent = this.issueKey;
        this.issueText.hidden = !this.issueKey;
        this.issueSeparator.hidden = !this.issueKey;
        this.timerValue.textContent = this.formatTimer(currentSeconds);
        this.issueText.disabled = !this.issueKey;
        this.resetButton.disabled = !canReset;
        this.resetButton.title = canReset ? "Reset timer" : "Timer already reset";
        this.resetButton.setAttribute(
          "aria-label",
          canReset ? "Reset timer" : "Timer already reset"
        );
        this.toggleButton.innerHTML = this.getToggleIconMarkup();
        const toggleTitle = this.isRunning ? "Pause timer" : currentSeconds > 0 ? "Resume timer" : "Start timer";
        this.toggleButton.title = toggleTitle;
        this.toggleButton.setAttribute("aria-label", toggleTitle);
      }
      syncDisplayInterval() {
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
        }, 1e3);
      }
      stopDisplayInterval() {
        if (this.interval) {
          window.clearInterval(this.interval);
          this.interval = null;
        }
      }
      async startTimer() {
        const currentSeconds = this.getCurrentSeconds();
        const now = Date.now();
        await this.writeTimerState({
          timerSeconds: currentSeconds,
          timerIsRunning: true,
          timerLastUpdated: now
        });
        chrome.runtime.sendMessage({
          action: "startTimer",
          seconds: currentSeconds
        });
        this.seconds = currentSeconds;
        this.isRunning = true;
        this.lastUpdated = now;
        this.render();
        this.syncDisplayInterval();
      }
      async pauseTimer() {
        const currentSeconds = this.getCurrentSeconds();
        const now = Date.now();
        await this.writeTimerState({
          timerSeconds: currentSeconds,
          timerIsRunning: false,
          timerLastUpdated: now
        });
        chrome.runtime.sendMessage({ action: "stopTimer" });
        this.seconds = currentSeconds;
        this.isRunning = false;
        this.lastUpdated = now;
        this.render();
        this.syncDisplayInterval();
      }
      async resetTimer() {
        await this.clearTimerState();
        chrome.runtime.sendMessage({ action: "resetTimer" });
        this.seconds = 0;
        this.isRunning = false;
        this.lastUpdated = null;
        this.render();
        this.syncDisplayInterval();
      }
      openFullTimer() {
        this.openUrl(chrome.runtime.getURL("dist/timerFeatureModule/timer.html"));
      }
      openIssue() {
        const issueUrl = this.getIssueUrl();
        if (!issueUrl) return;
        this.openUrl(issueUrl);
      }
      openUrl(url) {
        if (!url) return;
        chrome.runtime.sendMessage({ action: "openUrl", url });
      }
      applyTheme() {
        if (!this.widget) return;
        this.attachThemeListener();
        const shouldUseDarkTheme = this.settings?.followSystemTheme !== false ? window.matchMedia("(prefers-color-scheme: dark)").matches : this.settings?.darkMode === true;
        this.widget.classList.toggle("dark", shouldUseDarkTheme);
      }
      attachThemeListener() {
        if (this.settings?.followSystemTheme === false) {
          this.detachThemeListener();
          return;
        }
        if (!this.themeMediaQuery) {
          this.themeMediaQuery = window.matchMedia(
            "(prefers-color-scheme: dark)"
          );
          if (typeof this.themeMediaQuery.addEventListener === "function") {
            this.themeMediaQuery.addEventListener(
              "change",
              this.boundSystemThemeListener
            );
          } else if (typeof this.themeMediaQuery.addListener === "function") {
            this.themeMediaQuery.addListener(this.boundSystemThemeListener);
          }
        }
      }
      detachThemeListener() {
        if (!this.themeMediaQuery) return;
        if (typeof this.themeMediaQuery.removeEventListener === "function") {
          this.themeMediaQuery.removeEventListener(
            "change",
            this.boundSystemThemeListener
          );
        } else if (typeof this.themeMediaQuery.removeListener === "function") {
          this.themeMediaQuery.removeListener(this.boundSystemThemeListener);
        }
        this.themeMediaQuery = null;
      }
    }
    new FloatingTimerWidget();
  })();
})();

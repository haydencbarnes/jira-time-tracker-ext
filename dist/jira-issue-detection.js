"use strict";
(() => {
  // src/ts/shared/jira-error-handler.ts
  function getErrorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = error.message;
      return typeof message === "string" ? message : "";
    }
    return "";
  }
  function handleJiraError(error, defaultMessage = "An error occurred", context = "") {
    console.error("JIRA Error:", error);
    const errorMessageText = getErrorMessage(error);
    const statusMatch = errorMessageText.match(/Error (\d+):/);
    const statusText = statusMatch?.[1];
    const statusCode = statusText ? parseInt(statusText, 10) : null;
    let errorMessage = defaultMessage;
    let actionableSteps = "";
    switch (statusCode) {
      case 400:
        errorMessage = "Bad Request - Invalid data sent to JIRA";
        if (context.includes("search") || context.includes("timer")) {
          actionableSteps = "The work item key or time format may be invalid. Verify the issue exists and use proper time format (e.g., 2h, 30m).";
        } else {
          actionableSteps = "Check your JQL query in Time Table settings (gear icon top right), ensure all field names are correct, and verify that referenced projects/issue types exist.";
        }
        break;
      case 401:
        errorMessage = "Authentication Failed - JIRA could not verify your identity";
        actionableSteps = "Your API token may be invalid or expired. Go to Settings and:\n1. Verify your username/email is correct\n2. Generate a new API token from your Atlassian account\n3. Ensure you're using an API token (not password) for Jira Cloud";
        break;
      case 403:
        errorMessage = "Access Denied - You don't have permission for this operation";
        actionableSteps = 'Your account lacks necessary permissions. Contact your JIRA administrator to:\n1. Grant you project access\n2. Enable worklog permissions\n3. Verify your account has "Browse Projects" and "Work On Issues" permissions';
        break;
      case 404:
        errorMessage = "Not Found - JIRA server or resource not found";
        if (context.includes("search") || context.includes("timer")) {
          actionableSteps = "Check that:\n1. The work item key exists and is accessible to you\n2. Your Base URL in Settings is correct\n3. The JIRA instance is accessible";
        } else {
          actionableSteps = "Check your Base URL in Settings:\n1. Ensure URL is correct (e.g., company.atlassian.net for Cloud)\n2. Remove any trailing slashes\n3. Verify the JIRA instance is accessible";
        }
        break;
      case 500:
        errorMessage = "JIRA Server Error - Internal server problem";
        actionableSteps = "This is a JIRA server issue. Try again in a few minutes, or contact your JIRA administrator if the problem persists.";
        break;
      case 503:
        errorMessage = "JIRA Service Unavailable - Server is temporarily down";
        actionableSteps = "JIRA is temporarily unavailable. Wait a few minutes and try again.";
        break;
      default:
        if (errorMessageText.includes(
          "Basic authentication with passwords is deprecated"
        )) {
          errorMessage = "Password Authentication Deprecated";
          actionableSteps = "JIRA no longer accepts passwords. Go to Settings and:\n1. Use your email address as username\n2. Generate an API token from id.atlassian.com/manage/api-tokens\n3. Use the API token instead of your password";
        } else if (errorMessageText.includes("CORS") || errorMessageText.includes("fetch")) {
          errorMessage = "Connection Error - Cannot reach JIRA server";
          actionableSteps = "Network or CORS issue. Check:\n1. Your internet connection\n2. Base URL is correct in Settings\n3. JIRA server is accessible from your browser";
        } else if (errorMessageText.includes("Invalid JQL")) {
          errorMessage = "Invalid JQL Query";
          actionableSteps = "Your JQL query in Time Table settings (gear icon top right) contains errors. Verify the query works in JIRA's issue search before using it here.";
        } else if (errorMessageText.includes("Worklog must not be null")) {
          errorMessage = "Timer Error - No time recorded";
          actionableSteps = "Please start and stop the timer before trying to log time. Make sure the timer has recorded some time.";
        } else {
          const settingsRef = context.includes("search") || context.includes("timer") ? "Please check your configuration in the main popup Settings and try again." : "Please check your Settings configuration and try again. If the problem persists, contact your JIRA administrator.";
          actionableSteps = settingsRef;
        }
    }
    const fullMessage = actionableSteps ? `${errorMessage}

${actionableSteps}` : errorMessage;
    const displayError = globalThis.displayError;
    if (typeof displayError === "function") {
      displayError(fullMessage);
    } else {
      console.error("Display Error Function Not Found:", fullMessage);
    }
  }
  var jiraErrorHandlerGlobal = globalThis;
  jiraErrorHandlerGlobal.JiraErrorHandler = { handleJiraError };

  // src/ts/jira-issue-detection.ts
  function isTextEntryElement(element) {
    return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
  }
  var JiraIssueDetector = class {
    isEnabled;
    highlightedIssues;
    currentPopup;
    observer;
    JIRA_PATTERN;
    debounceTimeout;
    constructor() {
      this.isEnabled = false;
      this.highlightedIssues = /* @__PURE__ */ new Set();
      this.currentPopup = null;
      this.observer = null;
      this.JIRA_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/g;
      this.debounceTimeout = null;
      this.init();
    }
    async init() {
      const settings = await this.getExtensionSettings();
      this.isEnabled = settings.issueDetectionEnabled !== false;
      if (!settings.baseUrl || !settings.apiToken) {
        console.log("JIRA Detection: Extension not configured, skipping");
        return;
      }
      if (this.isEnabled) {
        this.scheduleIdleScan();
        this.setupObserver();
      } else {
        console.log("JIRA Detection: Feature disabled");
      }
      chrome.runtime.onMessage.addListener((message) => {
        const settingsMessage = message;
        if (settingsMessage?.type === "SETTINGS_CHANGED" && typeof settingsMessage.issueDetectionEnabled === "boolean") {
          const nextEnabled = settingsMessage.issueDetectionEnabled;
          if (nextEnabled !== this.isEnabled) {
            this.isEnabled = nextEnabled;
            if (this.isEnabled) {
              this.scheduleIdleScan();
              this.setupObserver();
            } else {
              this.cleanup();
            }
          }
        }
      });
    }
    // Use requestIdleCallback to avoid blocking the main thread
    scheduleIdleScan() {
      if ("requestIdleCallback" in window) {
        requestIdleCallback(() => this.scanAndHighlightIssues(), {
          timeout: 2e3
        });
      } else {
        setTimeout(() => this.scanAndHighlightIssues(), 100);
      }
    }
    async getExtensionSettings() {
      return new Promise((resolve) => {
        chrome.storage.sync.get(
          {
            issueDetectionEnabled: true,
            baseUrl: "",
            username: "",
            apiToken: "",
            jiraType: "cloud"
          },
          (items) => resolve(items)
        );
      });
    }
    scanAndHighlightIssues() {
      if (!this.isEnabled) return;
      const bodyText = document.body?.innerText || "";
      if (bodyText.length > 5e5) {
        if (!this.JIRA_PATTERN.test(bodyText.slice(0, 5e4))) {
          return;
        }
      }
      const selection = window.getSelection();
      const activeElement = document.activeElement;
      const activeTextEntry = isTextEntryElement(activeElement) ? activeElement : null;
      let selectionStart;
      let selectionEnd;
      let selectionRange = null;
      if (activeTextEntry) {
        selectionStart = activeTextEntry.selectionStart;
        selectionEnd = activeTextEntry.selectionEnd;
      }
      if (selection && selection.rangeCount > 0) {
        selectionRange = selection.getRangeAt(0).cloneRange();
      }
      this.clearHighlights();
      const roots = [document.body];
      const filterFn = {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName ? parent.tagName.toLowerCase() : "";
          if (["script", "style", "noscript"].includes(tag))
            return NodeFilter.FILTER_REJECT;
          if (parent.classList.contains("jira-log-time-icon") || parent.classList.contains("jira-issue-id-highlight") || parent.closest(".jira-issue-popup"))
            return NodeFilter.FILTER_REJECT;
          if (activeElement && (parent === activeElement || parent.closest('input, textarea, [contenteditable="true"]') === activeElement))
            return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      };
      const processRoot = (root) => {
        if (!root) return;
        const walker = document.createTreeWalker(
          root,
          NodeFilter.SHOW_TEXT,
          filterFn
        );
        const list = [];
        let n;
        while (n = walker.nextNode()) {
          if ((n.textContent ?? "").trim().match(this.JIRA_PATTERN)) list.push(n);
        }
        list.forEach((t) => this.highlightIssuesInTextNode(t));
      };
      roots.forEach(processRoot);
      if (activeTextEntry) {
        try {
          activeTextEntry.focus();
          if (selectionStart !== void 0 && selectionEnd !== void 0) {
            activeTextEntry.setSelectionRange(selectionStart, selectionEnd);
          }
        } catch {
        }
      } else if (selectionRange && activeElement instanceof HTMLElement && activeElement.isContentEditable) {
        try {
          activeElement.focus();
          const selection2 = window.getSelection();
          if (selection2) {
            selection2.removeAllRanges();
            selection2.addRange(selectionRange);
          }
        } catch {
        }
      }
    }
    highlightIssuesInTextNode(textNode) {
      const text = textNode.textContent ?? "";
      const matches = [...text.matchAll(this.JIRA_PATTERN)];
      if (matches.length === 0) return;
      const parentNode = textNode.parentNode;
      if (!parentNode || !(parentNode instanceof Element)) return;
      const parent = parentNode;
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      matches.forEach((match) => {
        const issueId = match[0];
        const startIndex = match.index;
        if (parent.tagName === "A") {
          const nextSibling = parent.nextSibling;
          const hasLogIcon = nextSibling instanceof Element && nextSibling.classList.contains("jira-log-time-icon");
          if (!hasLogIcon) {
            const logIcon2 = document.createElement("span");
            logIcon2.className = "jira-log-time-icon";
            logIcon2.dataset.issueId = issueId;
            logIcon2.title = `Log time for ${issueId}`;
            logIcon2.addEventListener("click", (e) => {
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
              this.showPopup(issueId, logIcon2);
            });
            parent.after(logIcon2);
          }
          return;
        }
        if (parent.closest('[contenteditable="true"]')) {
          const refEl = parent;
          const nextAfterRef = refEl.nextSibling;
          const hasLogIconAfterRef = nextAfterRef instanceof Element && nextAfterRef.classList.contains("jira-log-time-icon");
          if (!hasLogIconAfterRef) {
            const logIcon2 = document.createElement("span");
            logIcon2.className = "jira-log-time-icon";
            logIcon2.dataset.issueId = issueId;
            logIcon2.title = `Log time for ${issueId}`;
            logIcon2.addEventListener("click", (e) => {
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
              this.showPopup(issueId, logIcon2);
            });
            const wrapper = document.createElement("span");
            wrapper.contentEditable = "false";
            wrapper.appendChild(logIcon2);
            refEl.after(wrapper);
          }
          return;
        }
        if (startIndex > lastIndex) {
          fragment.appendChild(
            document.createTextNode(text.slice(lastIndex, startIndex))
          );
        }
        const span = document.createElement("span");
        span.className = "jira-issue-id-highlight";
        span.textContent = issueId;
        span.dataset.issueId = issueId;
        const logIcon = document.createElement("span");
        logIcon.className = "jira-log-time-icon";
        logIcon.dataset.issueId = issueId;
        logIcon.title = `Log time for ${issueId}`;
        logIcon.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          this.showPopup(issueId, logIcon);
        });
        logIcon.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        const container = document.createElement("span");
        container.appendChild(span);
        container.appendChild(logIcon);
        fragment.appendChild(container);
        this.highlightedIssues.add(issueId);
        lastIndex = startIndex + issueId.length;
      });
      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
      parent.replaceChild(fragment, textNode);
    }
    isActiveInputField(element) {
      if (!element) return false;
      const tagName = element.tagName?.toLowerCase();
      if (tagName === "input" || tagName === "textarea") {
        return true;
      }
      if (element instanceof HTMLElement && element.isContentEditable) {
        return true;
      }
      if (element.closest('[contenteditable="true"]') || element.closest(".ProseMirror") || element.closest(".CodeMirror") || element.closest('[role="textbox"]') || element.closest(".editor") || element.closest(".text-editor") || element.closest(".compose") || element.closest(".email-compose")) {
        return true;
      }
      return false;
    }
    setupObserver() {
      if (!this.isEnabled) return;
      this.observer?.disconnect();
      this.observer = new MutationObserver((mutations) => {
        let hasSignificantChange = false;
        for (const mutation of mutations) {
          if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
            for (const node of Array.from(mutation.addedNodes)) {
              if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent || "";
                if (text.length > 3 && this.JIRA_PATTERN.test(text)) {
                  hasSignificantChange = true;
                  break;
                }
              }
            }
          }
          if (hasSignificantChange) break;
        }
        if (hasSignificantChange) {
          if (this.debounceTimeout !== null) {
            clearTimeout(this.debounceTimeout);
          }
          this.debounceTimeout = setTimeout(() => {
            this.scheduleIdleScan();
          }, 1e3);
        }
      });
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: false
      });
    }
    async showPopup(issueId, targetElement) {
      this.closePopup();
      const settings = await this.getExtensionSettings();
      if (!settings.baseUrl || !settings.username || !settings.apiToken) {
        this.showConfigurationError();
        return;
      }
      this.currentPopup = await this.createPopup(issueId, settings);
      document.body.appendChild(this.currentPopup);
      this.positionPopup(this.currentPopup, targetElement);
      const popupEl = this.currentPopup;
      setTimeout(() => {
        popupEl.classList.add("show");
      }, 10);
      this.setupPopupHandlers(issueId, settings);
    }
    async createPopup(issueId, settings) {
      const popup = document.createElement("div");
      popup.className = "jira-issue-popup";
      await this.applyThemeToPopup(popup);
      const baseUrl = settings.baseUrl.startsWith("http") ? settings.baseUrl : `https://${settings.baseUrl}`;
      const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
      const issueUrl = `${normalizedBaseUrl}browse/${issueId}`;
      popup.innerHTML = `
      <div class="jira-issue-popup-header">
        <h3 class="jira-issue-popup-title">Log Time: <a href="${issueUrl}" target="_blank" style="color: inherit; text-decoration: none;">${issueId}</a></h3>
        <button class="jira-issue-popup-close" type="button" aria-label="Close">&times;</button>
      </div>
      
      <div class="jira-issue-popup-success">
        Time logged successfully!
      </div>
      
      <div class="jira-issue-popup-error">
        <!-- Error message will be inserted here -->
      </div>
      
      <div class="jira-issue-popup-loading">
        Logging time...
      </div>
      
      <form class="jira-issue-popup-form">
        <div class="jira-issue-popup-field">
          <label class="jira-issue-popup-label" for="jira-time-input">Time Spent*</label>
          <input 
            type="text" 
            id="jira-time-input" 
            class="jira-issue-popup-input" 
            placeholder="2h 30m, 1d, 45m..." 
            required
          >
          <small style="color: #666; font-size: 12px;">Examples: 2h, 30m, 1d, 2h 30m</small>
        </div>
        
        <div class="jira-issue-popup-field">
          <label class="jira-issue-popup-label" for="jira-date-input">Date</label>
          <input 
            type="date" 
            id="jira-date-input" 
            class="jira-issue-popup-input"
            value="${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}"
          >
        </div>
        
        <div class="jira-issue-popup-field">
          <label class="jira-issue-popup-label" for="jira-comment-input">Work Description</label>
          <textarea 
            id="jira-comment-input" 
            class="jira-issue-popup-input jira-issue-popup-textarea" 
            placeholder="Describe your work, magic, or craft"
          ></textarea>
        </div>
        
        <div class="jira-issue-popup-buttons">
          <button type="button" class="jira-issue-popup-button secondary jira-popup-cancel">Cancel</button>
          <button type="submit" class="jira-issue-popup-button primary jira-popup-submit">Log Time ↩ </button>
        </div>
      </form>
    `;
      return popup;
    }
    async applyThemeToPopup(popup) {
      try {
        const result = await new Promise((resolve) => {
          chrome.storage.sync.get(["followSystemTheme", "darkMode"], (items) => {
            resolve(items);
          });
        });
        const followSystem = result.followSystemTheme !== false;
        const manualDark = result.darkMode === true;
        let shouldUseDarkTheme = false;
        if (followSystem) {
          shouldUseDarkTheme = window.matchMedia(
            "(prefers-color-scheme: dark)"
          ).matches;
        } else {
          shouldUseDarkTheme = manualDark;
        }
        if (shouldUseDarkTheme) {
          popup.classList.add("dark");
        }
      } catch (error) {
        console.warn(
          "Failed to read theme settings, falling back to system preference:",
          error
        );
        if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
          popup.classList.add("dark");
        }
      }
    }
    positionPopup(popup, targetElement) {
      const rect = targetElement.getBoundingClientRect();
      const popupRect = popup.getBoundingClientRect();
      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight
      };
      let top = rect.bottom + window.scrollY + 5;
      let left = rect.left + window.scrollX;
      if (left + popupRect.width > viewport.width) {
        left = viewport.width - popupRect.width - 10;
      }
      if (left < 10) {
        left = 10;
      }
      if (top + popupRect.height > viewport.height + window.scrollY) {
        top = rect.top + window.scrollY - popupRect.height - 5;
      }
      popup.style.left = `${left}px`;
      popup.style.top = `${top}px`;
    }
    setupPopupHandlers(issueId, settings) {
      const popup = this.currentPopup;
      if (!popup) return;
      const form = popup.querySelector(".jira-issue-popup-form");
      const closeBtn = popup.querySelector(
        ".jira-issue-popup-close"
      );
      const cancelBtn = popup.querySelector(".jira-popup-cancel");
      const timeInput = popup.querySelector("#jira-time-input");
      const dateInput = popup.querySelector("#jira-date-input");
      const commentInput = popup.querySelector(
        "#jira-comment-input"
      );
      if (!form || !closeBtn || !cancelBtn || !timeInput || !dateInput || !commentInput)
        return;
      const closePopup = () => this.closePopup();
      closeBtn.addEventListener("click", closePopup);
      cancelBtn.addEventListener("click", closePopup);
      document.addEventListener(
        "click",
        (e) => {
          if (this.currentPopup && e.target instanceof Node && !this.currentPopup.contains(e.target)) {
            closePopup();
          }
        },
        { once: true }
      );
      document.addEventListener(
        "keydown",
        (e) => {
          if (e.key === "Escape" && this.currentPopup) {
            closePopup();
          }
        },
        { once: true }
      );
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const timeValue = timeInput.value.trim();
        if (!timeValue) {
          this.showPopupError("Time field is required");
          return;
        }
        if (!this.validateTimeFormat(timeValue)) {
          this.showPopupError(
            'Invalid time format. Use: 2h, 30m, 1d, or combinations like "2h 30m"'
          );
          return;
        }
        await this.logTime(
          issueId,
          timeValue,
          dateInput.value,
          commentInput.value,
          settings
        );
      });
      timeInput.focus();
    }
    validateTimeFormat(timeStr) {
      const timePattern = /^(\d+[dhm]\s*)+$/i;
      return timePattern.test(timeStr.trim());
    }
    convertTimeToSeconds(timeStr) {
      const timeUnits = {
        d: 60 * 60 * 24,
        h: 60 * 60,
        m: 60
      };
      const regex = /(\d+)([dhm])/gi;
      let match;
      let totalSeconds = 0;
      while ((match = regex.exec(timeStr)) !== null) {
        const value = parseInt(match[1], 10);
        const unit = match[2].toLowerCase();
        const multiplier = timeUnits[unit];
        if (multiplier !== void 0) {
          totalSeconds += value * multiplier;
        }
      }
      return totalSeconds;
    }
    async logTime(issueId, timeStr, dateStr, comment, settings) {
      const popup = this.currentPopup;
      if (!popup) return;
      const form = popup.querySelector(".jira-issue-popup-form");
      const loading = popup.querySelector(
        ".jira-issue-popup-loading"
      );
      const submitBtn = popup.querySelector(".jira-popup-submit");
      if (!form || !loading || !submitBtn) return;
      form.style.display = "none";
      loading.classList.add("show");
      submitBtn.disabled = true;
      try {
        const timeInSeconds = this.convertTimeToSeconds(timeStr);
        const startedTime = this.getStartedTime(dateStr);
        const response = await new Promise(
          (resolve, reject) => {
            chrome.runtime.sendMessage(
              {
                action: "logWorklog",
                issueId,
                timeInSeconds,
                startedTime,
                comment,
                settings
              },
              (response2) => {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message));
                } else {
                  resolve(
                    response2 || {
                      success: false,
                      error: { message: "Empty response", status: 0 }
                    }
                  );
                }
              }
            );
          }
        );
        if (response.success) {
          this.showPopupSuccess("Time logged successfully!");
          setTimeout(() => {
            this.closePopup();
          }, 2e3);
        } else {
          throw response.error;
        }
      } catch (error) {
        console.error("Error logging time:", error);
        let errorMessage = "Failed to log time. ";
        const status = error.status;
        if (status === 401) {
          errorMessage += "Please check your JIRA credentials in the extension settings.";
        } else if (status === 403) {
          errorMessage += "You don't have permission to log time on this issue.";
        } else if (status === 404) {
          errorMessage += "Issue not found. Please check the issue ID.";
        } else {
          errorMessage += getErrorMessage(error) || "Please try again.";
        }
        this.showPopupError(errorMessage);
        form.style.display = "flex";
        loading.classList.remove("show");
        submitBtn.disabled = false;
      }
    }
    getStartedTime(dateString) {
      if (!dateString) {
        return (/* @__PURE__ */ new Date()).toISOString();
      }
      const date = new Date(dateString);
      if (isNaN(date.getTime())) {
        return (/* @__PURE__ */ new Date()).toISOString();
      }
      date.setHours(12, 0, 0, 0);
      return date.toISOString();
    }
    showPopupSuccess(message) {
      if (!this.currentPopup) return;
      const success = this.currentPopup.querySelector(
        ".jira-issue-popup-success"
      );
      const form = this.currentPopup.querySelector(
        ".jira-issue-popup-form"
      );
      const loading = this.currentPopup.querySelector(
        ".jira-issue-popup-loading"
      );
      if (!success || !form || !loading) return;
      success.textContent = message;
      success.classList.add("show");
      form.style.display = "none";
      loading.classList.remove("show");
    }
    showPopupError(message) {
      if (!this.currentPopup) return;
      const error = this.currentPopup.querySelector(
        ".jira-issue-popup-error"
      );
      if (!error) return;
      error.textContent = message;
      error.classList.add("show");
      setTimeout(() => {
        error.classList.remove("show");
      }, 5e3);
    }
    showConfigurationError() {
      const message = "JIRA configuration required. Please set up your JIRA connection in the extension settings.";
      const notification = document.createElement("div");
      notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #de350b;
      color: white;
      padding: 12px 16px;
      border-radius: 4px;
      z-index: 10001;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      max-width: 300px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    `;
      notification.textContent = message;
      document.body.appendChild(notification);
      setTimeout(() => {
        notification.remove();
      }, 5e3);
    }
    closePopup() {
      if (this.currentPopup) {
        this.currentPopup.classList.remove("show");
        setTimeout(() => {
          this.currentPopup?.remove();
          this.currentPopup = null;
        }, 200);
      }
    }
    clearHighlights() {
      const selection = window.getSelection();
      const activeElement = document.activeElement;
      const activeTextEntry = isTextEntryElement(activeElement) ? activeElement : null;
      let selectionStart;
      let selectionEnd;
      let selectionRange = null;
      if (activeTextEntry) {
        selectionStart = activeTextEntry.selectionStart;
        selectionEnd = activeTextEntry.selectionEnd;
      }
      if (selection && selection.rangeCount > 0) {
        selectionRange = selection.getRangeAt(0).cloneRange();
      }
      document.querySelectorAll(".jira-issue-id-highlight").forEach((highlight) => {
        const container = highlight.parentElement;
        const parent = container?.parentElement;
        if (parent) {
          if (activeElement && (parent === activeElement || parent.closest('input, textarea, [contenteditable="true"]') === activeElement)) {
            return;
          }
          parent.replaceChild(
            document.createTextNode(highlight.textContent),
            container
          );
          parent.normalize();
        }
      });
      document.querySelectorAll(".jira-log-time-icon").forEach((icon) => {
        if (activeElement && (icon.parentNode === activeElement || icon.closest('input, textarea, [contenteditable="true"]') === activeElement)) {
          return;
        }
        icon.remove();
      });
      this.highlightedIssues.clear();
      if (activeTextEntry) {
        try {
          activeTextEntry.focus();
          if (selectionStart !== void 0 && selectionEnd !== void 0) {
            activeTextEntry.setSelectionRange(selectionStart, selectionEnd);
          }
        } catch {
        }
      } else if (selectionRange && activeElement instanceof HTMLElement && activeElement.isContentEditable) {
        try {
          activeElement.focus();
          const selection2 = window.getSelection();
          if (selection2) {
            selection2.removeAllRanges();
            selection2.addRange(selectionRange);
          }
        } catch {
        }
      }
    }
    cleanup() {
      this.clearHighlights();
      this.closePopup();
      this.observer?.disconnect();
      this.observer = null;
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => new JiraIssueDetector());
  } else {
    new JiraIssueDetector();
  }
})();

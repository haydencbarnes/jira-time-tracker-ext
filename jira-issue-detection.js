// JIRA Issue ID Detection and Time Tracking Content Script (stable)
// Detects JIRA issue IDs on any page and provides a quick log-time popup

class JiraIssueDetector {
  constructor() {
    this.isEnabled = false;
    this.highlightedIssues = new Set();
    this.currentPopup = null;
    this.JIRA_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/g;
    this.debounceTimeout = null;

    this.init();
  }

  async init() {
    const settings = await this.getExtensionSettings();
    // Default ON unless explicitly disabled
    this.isEnabled = settings.issueDetectionEnabled !== false;

    // Skip entirely if extension isn't configured - no point scanning
    if (!settings.baseUrl || !settings.apiToken) {
      console.log('JIRA Detection: Extension not configured, skipping');
      return;
    }

    if (this.isEnabled) {
      // Defer initial scan to avoid blocking page load
      this.scheduleIdleScan();
      this.setupObserver();
    } else {
      console.log('JIRA Detection: Feature disabled');
    }

    // Listen for settings changes
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'SETTINGS_CHANGED' && typeof message.issueDetectionEnabled === 'boolean') {
        const nextEnabled = message.issueDetectionEnabled;
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
    if ('requestIdleCallback' in window) {
      requestIdleCallback(() => this.scanAndHighlightIssues(), { timeout: 2000 });
    } else {
      setTimeout(() => this.scanAndHighlightIssues(), 100);
    }
  }

  async getExtensionSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get({
        issueDetectionEnabled: true,
        baseUrl: '',
        username: '',
        apiToken: '',
        jiraType: 'cloud'
      }, resolve);
    });
  }

  scanAndHighlightIssues() {
    if (!this.isEnabled) return;

    // Quick check: skip pages unlikely to have JIRA issues (performance optimization)
    const bodyText = document.body?.innerText || '';
    if (bodyText.length > 500000) {
      // Very large page - only scan if we find a potential match in first 50k chars
      if (!this.JIRA_PATTERN.test(bodyText.slice(0, 50000))) {
        return;
      }
    }

    // Store current selection to restore later
    const selection = window.getSelection();
    const activeElement = document.activeElement;
    let selectionStart, selectionEnd;
    let selectionRange = null;

    // Store cursor position for input elements
    if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
      selectionStart = activeElement.selectionStart;
      selectionEnd = activeElement.selectionEnd;
    }

    // Store selection for contenteditable elements
    if (selection && selection.rangeCount > 0) {
      selectionRange = selection.getRangeAt(0).cloneRange();
    }

    // Clear existing highlights
    this.clearHighlights();

    // Only scan document.body - skip expensive shadow DOM enumeration
    // Shadow DOM scanning was causing performance issues with querySelectorAll('*')
    const roots = [document.body];

    const filterFn = {
      acceptNode: (node)=>{
        const parent=node.parentElement;
        if(!parent) return NodeFilter.FILTER_REJECT;
        const tag=parent.tagName?parent.tagName.toLowerCase():'';
        if(['script','style','noscript'].includes(tag)) return NodeFilter.FILTER_REJECT;
        if(parent.classList.contains('jira-log-time-icon')||parent.classList.contains('jira-issue-id-highlight')||parent.closest('.jira-issue-popup')) return NodeFilter.FILTER_REJECT;
        // Only skip highlighting in the currently active input field to avoid cursor interference
        if (activeElement && (parent === activeElement || parent.closest('input, textarea, [contenteditable="true"]') === activeElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    };

    const processRoot = root=>{
      if (!root) return;
      const walker = document.createTreeWalker(root,NodeFilter.SHOW_TEXT,filterFn,false);
      const list=[];let n;while(n=walker.nextNode()){if(n.textContent.trim().match(this.JIRA_PATTERN)) list.push(n);}list.forEach(t=>this.highlightIssuesInTextNode(t));
    };

    roots.forEach(processRoot);

    // Restore cursor position
    if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
      try {
        // Restore focus and cursor position for input elements
        activeElement.focus();
        if (selectionStart !== undefined && selectionEnd !== undefined) {
          activeElement.setSelectionRange(selectionStart, selectionEnd);
        }
      } catch (e) {
        // Silently handle any errors during restoration
      }
    } else if (selectionRange && activeElement && activeElement.isContentEditable) {
      try {
        // Restore selection for contenteditable elements
        activeElement.focus();
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(selectionRange);
      } catch (e) {
        // Silently handle any errors during restoration
      }
    }
  }

  highlightIssuesInTextNode(textNode) {
    const text = textNode.textContent;
    const matches = [...text.matchAll(this.JIRA_PATTERN)];

    if (matches.length === 0) return;

    const parent = textNode.parentNode;
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;

    matches.forEach(match => {
      const issueId = match[0];
      const startIndex = match.index;

      // If inside a link, simply append icon after the link once and continue
      if (parent.tagName === 'A') {
        if (!parent.nextSibling || !parent.nextSibling.classList || !parent.nextSibling.classList.contains('jira-log-time-icon')) {
          const logIcon = document.createElement('span');
          logIcon.className = 'jira-log-time-icon';
          logIcon.dataset.issueId = issueId;
          logIcon.title = `Log time for ${issueId}`;
          logIcon.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            this.showPopup(issueId, logIcon);
          });
          parent.after(logIcon);
        }
        return; // do not alter text node when inside anchor
      }

      // If inside a contenteditable element
      if (parent.closest('[contenteditable="true"]')) {
        const refEl = parent; // element containing text
        if (!refEl.nextSibling || !refEl.nextSibling.classList || !refEl.nextSibling.classList.contains('jira-log-time-icon')) {
          const logIcon = document.createElement('span');
          logIcon.className = 'jira-log-time-icon';
          logIcon.dataset.issueId = issueId;
          logIcon.title = `Log time for ${issueId}`;
          logIcon.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            this.showPopup(issueId, logIcon);
          });

          // Wrap icon in non-editable span to keep caret away
          const wrapper = document.createElement('span');
          wrapper.contentEditable = 'false';
          wrapper.appendChild(logIcon);
          refEl.after(wrapper);
        }
        return;
      }

      // Add text before the match
      if (startIndex > lastIndex) {
        fragment.appendChild(
          document.createTextNode(text.slice(lastIndex, startIndex))
        );
      }

      // Create highlighted span for the issue ID (without click handler)
      const span = document.createElement('span');
      span.className = 'jira-issue-id-highlight';
      span.textContent = issueId;
      span.dataset.issueId = issueId;

      // Create log time icon
      const logIcon = document.createElement('span');
      logIcon.className = 'jira-log-time-icon';
      logIcon.dataset.issueId = issueId;
      logIcon.title = `Log time for ${issueId}`;

      // Add click handler to the icon
      logIcon.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        this.showPopup(issueId, logIcon);
      });

      // Also add mousedown to ensure we capture the event
      logIcon.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });

      // Create container for issue ID + icon
      const container = document.createElement('span');
      container.appendChild(span);
      container.appendChild(logIcon);

      fragment.appendChild(container);
      this.highlightedIssues.add(issueId);

      lastIndex = startIndex + issueId.length;
    });

    // Add remaining text
    if (lastIndex < text.length) {
      fragment.appendChild(
        document.createTextNode(text.slice(lastIndex))
      );
    }

    // Replace the original text node
    parent.replaceChild(fragment, textNode);
  }

  isActiveInputField(element) {
    if (!element) return false;

    const tagName = element.tagName?.toLowerCase();

    // Check for input elements
    if (tagName === 'input' || tagName === 'textarea') {
      return true;
    }

    // Check for contenteditable elements
    if (element.isContentEditable) {
      return true;
    }

    // Check if element is part of a rich text editor (common selectors)
    if (element.closest('[contenteditable="true"]') ||
        element.closest('.ProseMirror') ||
        element.closest('.CodeMirror') ||
        element.closest('[role="textbox"]') ||
        element.closest('.editor') ||
        element.closest('.text-editor') ||
        element.closest('.compose') ||
        element.closest('.email-compose')) {
      return true;
    }

    return false;
  }

  setupObserver() {
    if (!this.isEnabled) return;

    // Disconnect any existing observer
    this.observer?.disconnect();

    // Use MutationObserver to detect new content - optimized for performance
    this.observer = new MutationObserver((mutations) => {
      // Only trigger rescan if significant content was added
      let hasSignificantChange = false;

      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          // Check if any added node might contain JIRA patterns
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
              const text = node.textContent || '';
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
        // Debounce scanning to avoid excessive calls
        clearTimeout(this.debounceTimeout);
        this.debounceTimeout = setTimeout(() => {
          this.scheduleIdleScan();
        }, 1000); // Increased debounce for better performance
      }
    });

    // Only observe childList, not characterData (reduces overhead significantly)
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: false
    });

    // Remove the global input listener - it's too aggressive
    // Users can refresh page or use the popup if needed
  }

  async showPopup(issueId, targetElement) {
    // Close existing popup
    this.closePopup();

    const settings = await this.getExtensionSettings();
    if (!settings.baseUrl || !settings.username || !settings.apiToken) {
      this.showConfigurationError();
      return;
    }

    // Create popup
    this.currentPopup = await this.createPopup(issueId, settings);
    document.body.appendChild(this.currentPopup);

    // Position popup
    this.positionPopup(this.currentPopup, targetElement);

    // Show popup
    setTimeout(() => {
      this.currentPopup.classList.add('show');
    }, 10);

    // Set up form handlers
    this.setupPopupHandlers(issueId, settings);
  }

  async createPopup(issueId, settings) {
    const popup = document.createElement('div');
    popup.className = 'jira-issue-popup';

    // Apply dark theme based on extension settings
    await this.applyThemeToPopup(popup);

    // Construct JIRA issue URL
    const baseUrl = settings.baseUrl.startsWith('http')
      ? settings.baseUrl
      : `https://${settings.baseUrl}`;
    const normalizedBaseUrl = baseUrl.endsWith('/')
      ? baseUrl
      : `${baseUrl}/`;
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
            value="${new Date().toISOString().split('T')[0]}"
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
        chrome.storage.sync.get(['followSystemTheme', 'darkMode'], resolve);
      });

      const followSystem = result.followSystemTheme !== false; // default true
      const manualDark = result.darkMode === true;

      let shouldUseDarkTheme = false;

      if (followSystem) {
        shouldUseDarkTheme = window.matchMedia('(prefers-color-scheme: dark)').matches;
      } else {
        shouldUseDarkTheme = manualDark;
      }

      if (shouldUseDarkTheme) {
        popup.classList.add('dark');
      }
    } catch (error) {
      console.warn('Failed to read theme settings, falling back to system preference:', error);
      // Fallback to system preference if storage read fails
      if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        popup.classList.add('dark');
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

    // Adjust if popup would go off-screen
    if (left + popupRect.width > viewport.width) {
      left = viewport.width - popupRect.width - 10;
    }
    
    if (left < 10) {
      left = 10;
    }

    // If popup would go off bottom, show above target
    if (top + popupRect.height > viewport.height + window.scrollY) {
      top = rect.top + window.scrollY - popupRect.height - 5;
    }

    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  setupPopupHandlers(issueId, settings) {
    const popup = this.currentPopup;
    const form = popup.querySelector('.jira-issue-popup-form');
    const closeBtn = popup.querySelector('.jira-issue-popup-close');
    const cancelBtn = popup.querySelector('.jira-popup-cancel');
    const timeInput = popup.querySelector('#jira-time-input');
    const dateInput = popup.querySelector('#jira-date-input');
    const commentInput = popup.querySelector('#jira-comment-input');

    // Close handlers
    const closePopup = () => this.closePopup();
    closeBtn.addEventListener('click', closePopup);
    cancelBtn.addEventListener('click', closePopup);

    // Click outside to close
    document.addEventListener('click', (e) => {
      if (this.currentPopup && !this.currentPopup.contains(e.target)) {
        closePopup();
      }
    }, { once: true });

    // Escape key to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.currentPopup) {
        closePopup();
      }
    }, { once: true });

    // Form submission
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const timeValue = timeInput.value.trim();
      if (!timeValue) {
        this.showPopupError('Time field is required');
        return;
      }

      if (!this.validateTimeFormat(timeValue)) {
        this.showPopupError('Invalid time format. Use: 2h, 30m, 1d, or combinations like "2h 30m"');
        return;
      }

      await this.logTime(issueId, timeValue, dateInput.value, commentInput.value, settings);
    });

    // Focus time input
    timeInput.focus();
  }

  validateTimeFormat(timeStr) {
    // Check if time format is valid (e.g., 2h, 30m, 1d, 2h 30m)
    const timePattern = /^(\d+[dhm]\s*)+$/i;
    return timePattern.test(timeStr.trim());
  }

  convertTimeToSeconds(timeStr) {
    const timeUnits = {
      d: 60 * 60 * 24,
      h: 60 * 60,
      m: 60,
    };

    const regex = /(\d+)([dhm])/gi;
    let match;
    let totalSeconds = 0;

    while ((match = regex.exec(timeStr)) !== null) {
      const value = parseInt(match[1], 10);
      const unit = match[2].toLowerCase();
      totalSeconds += value * timeUnits[unit];
    }

    return totalSeconds;
  }

  async logTime(issueId, timeStr, dateStr, comment, settings) {
    const popup = this.currentPopup;
    const form = popup.querySelector('.jira-issue-popup-form');
    const loading = popup.querySelector('.jira-issue-popup-loading');
    const submitBtn = popup.querySelector('.jira-popup-submit');

    // Show loading state
    form.style.display = 'none';
    loading.classList.add('show');
    submitBtn.disabled = true;

    try {
      const timeInSeconds = this.convertTimeToSeconds(timeStr);
      const startedTime = this.getStartedTime(dateStr);

      // Send message to background script to handle the API call
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'logWorklog',
          issueId: issueId,
          timeInSeconds: timeInSeconds,
          startedTime: startedTime,
          comment: comment,
          settings: settings
        }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });

      if (response.success) {
        this.showPopupSuccess('Time logged successfully!');
        
        setTimeout(() => {
          this.closePopup();
        }, 2000);
      } else {
        throw response.error;
      }

    } catch (error) {
      console.error('Error logging time:', error);
      
      let errorMessage = 'Failed to log time. ';
      
      if (error.status === 401) {
        errorMessage += 'Please check your JIRA credentials in the extension settings.';
      } else if (error.status === 403) {
        errorMessage += 'You don\'t have permission to log time on this issue.';
      } else if (error.status === 404) {
        errorMessage += 'Issue not found. Please check the issue ID.';
      } else {
        errorMessage += error.message || 'Please try again.';
      }
      
      this.showPopupError(errorMessage);
      
      // Restore form
      form.style.display = 'flex';
      loading.classList.remove('show');
      submitBtn.disabled = false;
    }
  }

  getStartedTime(dateString) {
    if (!dateString) {
      return new Date().toISOString();
    }
    
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      return new Date().toISOString();
    }
    
    // Set to 12:00 PM of the selected date
    date.setHours(12, 0, 0, 0);
    return date.toISOString();
  }

  showPopupSuccess(message) {
    if (!this.currentPopup) return;
    
    const success = this.currentPopup.querySelector('.jira-issue-popup-success');
    const form = this.currentPopup.querySelector('.jira-issue-popup-form');
    const loading = this.currentPopup.querySelector('.jira-issue-popup-loading');
    
    success.textContent = message;
    success.classList.add('show');
    form.style.display = 'none';
    loading.classList.remove('show');
  }

  showPopupError(message) {
    if (!this.currentPopup) return;
    
    const error = this.currentPopup.querySelector('.jira-issue-popup-error');
    error.textContent = message;
    error.classList.add('show');
    
    setTimeout(() => {
      error.classList.remove('show');
    }, 5000);
  }

  showConfigurationError() {
    const message = 'JIRA configuration required. Please set up your JIRA connection in the extension settings.';
    
    // Create a simple notification
    const notification = document.createElement('div');
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
    }, 5000);
  }

  closePopup() {
    if (this.currentPopup) {
      this.currentPopup.classList.remove('show');
      setTimeout(() => {
        this.currentPopup?.remove();
        this.currentPopup = null;
      }, 200);
    }
  }

  clearHighlights() {
    // Store current selection to restore later
    const selection = window.getSelection();
    const activeElement = document.activeElement;
    let selectionStart, selectionEnd;
    let selectionRange = null;
    
    // Store cursor position for input elements
    if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
      selectionStart = activeElement.selectionStart;
      selectionEnd = activeElement.selectionEnd;
    }
    
    // Store selection for contenteditable elements
    if (selection && selection.rangeCount > 0) {
      selectionRange = selection.getRangeAt(0).cloneRange();
    }

    document.querySelectorAll('.jira-issue-id-highlight').forEach(highlight => {
      const container = highlight.parentNode;
      const parent = container?.parentNode;
      if (parent) {
        // Only skip if this is inside the currently active input field
        if (activeElement && (parent === activeElement || parent.closest('input, textarea, [contenteditable="true"]') === activeElement)) {
          return;
        }
        parent.replaceChild(document.createTextNode(highlight.textContent), container);
        parent.normalize();
      }
    });
    document.querySelectorAll('.jira-log-time-icon').forEach(icon => {
      // Only skip if this is inside the currently active input field
      if (activeElement && (icon.parentNode === activeElement || icon.closest('input, textarea, [contenteditable="true"]') === activeElement)) {
        return;
      }
      icon.remove();
    });
    this.highlightedIssues.clear();

    // Restore cursor position
    if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
      try {
        // Restore focus and cursor position for input elements
        activeElement.focus();
        if (selectionStart !== undefined && selectionEnd !== undefined) {
          activeElement.setSelectionRange(selectionStart, selectionEnd);
        }
      } catch (e) {
        // Silently handle any errors during restoration
      }
    } else if (selectionRange && activeElement && activeElement.isContentEditable) {
      try {
        // Restore selection for contenteditable elements
        activeElement.focus();
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(selectionRange);
      } catch (e) {
        // Silently handle any errors during restoration
      }
    }
  }

  cleanup() {
    this.clearHighlights();
    this.closePopup();
    this.observer?.disconnect();
    this.observer = null;
  }
}

// Boot
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded',()=> new JiraIssueDetector());
} else {
  new JiraIssueDetector();
}



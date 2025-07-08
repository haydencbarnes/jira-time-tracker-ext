// JIRA Issue ID Detection and Time Tracking Content Script
// This script runs on all web pages and detects JIRA issue IDs

class JiraIssueDetector {
  constructor() {
    this.isEnabled = false;
    this.highlightedIssues = new Set();
    this.currentPopup = null;
    this.JIRA_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/g;
    this.debounceTimeout = null;
    this.lastActiveElement = null; // Track currently focused element
    this.isProcessing = false; // Prevent recursive processing
    
    this.init();
  }

  async init() {
    // Check if experimental features are enabled
    const settings = await this.getExtensionSettings();
    this.isEnabled = settings.experimentalFeatures;
    
    if (this.isEnabled) {
      this.showExperimentalBadge();
      this.scanAndHighlightIssues();
      this.setupObserver();
    } else {
      console.log('JIRA Detection: Feature disabled');
    }

    // Listen for settings changes
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'SETTINGS_CHANGED' && message.experimentalFeatures !== this.isEnabled) {
        this.isEnabled = message.experimentalFeatures;
        if (this.isEnabled) {
          this.showExperimentalBadge();
          this.scanAndHighlightIssues();
          this.setupObserver();
        } else {
          this.cleanup();
        }
      }
    });
  }

  async getExtensionSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get({
        experimentalFeatures: false,
        baseUrl: '',
        username: '',
        apiToken: '',
        jiraType: 'cloud'
      }, resolve);
    });
  }

  showExperimentalBadge() {
    // Show a brief experimental feature badge
    const badge = document.createElement('div');
    badge.className = 'jira-experimental-badge';
    badge.textContent = 'Jira Issue Detection On - BETA';
    document.body.appendChild(badge);
    
    setTimeout(() => {
      if (badge.parentNode) {
        badge.parentNode.removeChild(badge);
      }
    }, 3000);
  }

  scanAndHighlightIssues() {
    if (!this.isEnabled || this.isProcessing) return;

    // Don't scan if user is actively typing in a contenteditable element
    const activeElement = document.activeElement;
    if (activeElement && this.isContentEditable(activeElement)) {
      this.lastActiveElement = activeElement;
      return;
    }

    this.isProcessing = true;

    // Preserve cursor position before clearing highlights
    const cursorInfo = this.saveCursorPosition();

    // Clear existing highlights
    this.clearHighlights();

    const roots = [document.body];
    // Collect all shadow roots currently in the DOM
    document.querySelectorAll('*').forEach(el=>{
      if(el.shadowRoot) roots.push(el.shadowRoot);
    });

    const filterFn = {
      acceptNode: (node)=>{
        const parent=node.parentElement;
        if(!parent) return NodeFilter.FILTER_REJECT;
        const tag=parent.tagName?parent.tagName.toLowerCase():'';
        if(['script','style','noscript'].includes(tag)) return NodeFilter.FILTER_REJECT;
        if(parent.classList.contains('jira-log-time-icon')||parent.classList.contains('jira-issue-id-highlight')||parent.closest('.jira-issue-popup')) return NodeFilter.FILTER_REJECT;
        
        // Skip currently focused contenteditable elements to preserve cursor
        if (this.isContentEditable(parent) && parent === document.activeElement) {
          return NodeFilter.FILTER_REJECT;
        }
        
        return NodeFilter.FILTER_ACCEPT;
      }
    };

    const processRoot = root=>{
      const walker = document.createTreeWalker(root,NodeFilter.SHOW_TEXT,filterFn,false);
      const list=[];let n;while(n=walker.nextNode()){if(n.textContent.trim().match(this.JIRA_PATTERN)) list.push(n);}list.forEach(t=>this.highlightIssuesInTextNode(t));
    };

    roots.forEach(processRoot);

    // Restore cursor position after processing
    this.restoreCursorPosition(cursorInfo);
    
    this.isProcessing = false;
  }

  isContentEditable(element) {
    if (!element) return false;
    return element.contentEditable === 'true' || 
           element.closest('[contenteditable="true"]') !== null ||
           element.tagName === 'INPUT' ||
           element.tagName === 'TEXTAREA';
  }

  mightContainJiraIssue(element) {
    if (!element) return false;
    
    // Get text content from the element
    let text = '';
    if (element.value !== undefined) {
      text = element.value; // For input/textarea
    } else {
      text = element.textContent || element.innerText || '';
    }
    
    // Quick check: does it contain uppercase letters and numbers that might form a Jira ID?
    // This is a fast pre-check to avoid expensive regex on every keystroke
    return /[A-Z]+.*[0-9]|[0-9].*[A-Z]/.test(text) && text.length > 2;
  }

  saveCursorPosition() {
    const activeElement = document.activeElement;
    if (!activeElement) return null;

    if (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA') {
      return {
        element: activeElement,
        start: activeElement.selectionStart,
        end: activeElement.selectionEnd,
        type: 'input'
      };
    }

    if (this.isContentEditable(activeElement)) {
      const selection = window.getSelection();
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        return {
          element: activeElement,
          range: range.cloneRange(),
          type: 'contenteditable'
        };
      }
    }

    return null;
  }

  restoreCursorPosition(cursorInfo) {
    if (!cursorInfo) return;

    try {
      if (cursorInfo.type === 'input' && cursorInfo.element) {
        // Restore cursor in input/textarea
        cursorInfo.element.focus();
        cursorInfo.element.setSelectionRange(cursorInfo.start, cursorInfo.end);
      } else if (cursorInfo.type === 'contenteditable' && cursorInfo.element && cursorInfo.range) {
        // Restore cursor in contenteditable
        const selection = window.getSelection();
        selection.removeAllRanges();
        
        // Validate that the range is still valid
        if (cursorInfo.range.startContainer && 
            document.contains(cursorInfo.range.startContainer)) {
          selection.addRange(cursorInfo.range);
          cursorInfo.element.focus();
        }
      }
    } catch (error) {
      // Silently handle cases where cursor restoration fails
      console.debug('Could not restore cursor position:', error);
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

      // Skip adding icons in editable content - we'll use context menu instead
      if (parent.closest('[contenteditable="true"]') || 
          parent.closest('input') || 
          parent.closest('textarea')) {
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

  setupObserver() {
    if (!this.isEnabled) return;

    // Use MutationObserver to detect new content
    this.observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      
      mutations.forEach(mutation => {
        if ((mutation.type === 'childList' && mutation.addedNodes.length > 0) ||
            mutation.type === 'characterData') {
          shouldScan = true;
        }
      });

      if (shouldScan) {
        // Debounce scanning to avoid excessive calls
        clearTimeout(this.debounceTimeout);
        this.debounceTimeout = setTimeout(() => {
          this.scanAndHighlightIssues();
        }, 500);
      }
    });

    this.observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true
    });

    // Listen to user input events (captures typing in <input>, <textarea>, contenteditable)
    window.addEventListener('input', (e) => {
      const target = e.target;
      
      // Only re-scan if we might have added/removed Jira issue IDs
      if (this.mightContainJiraIssue(target)) {
        clearTimeout(this.debounceTimeout);
        this.debounceTimeout = setTimeout(() => {
          this.scanAndHighlightIssues();
        }, 300); // Increased debounce to reduce frequency
      }
    }, true);
    
    // Also listen for focus changes to handle delayed scanning
    window.addEventListener('focusout', (e) => {
      const target = e.target;
      if (this.isContentEditable(target) && this.mightContainJiraIssue(target)) {
        clearTimeout(this.debounceTimeout);
        this.debounceTimeout = setTimeout(() => {
          this.scanAndHighlightIssues();
        }, 100);
      }
    }, true);

    // Set up context menu for editable content
    this.setupContextMenu();
  }

  setupContextMenu() {
    let contextMenuVisible = false;

    // Listen for right-click events
    document.addEventListener('contextmenu', (e) => {
      // Only handle context menu in editable elements
      if (!this.isContentEditable(e.target)) {
        this.hideContextMenu();
        return;
      }

      const selectedText = this.getSelectedText();
      const jiraIssue = this.extractJiraIssueFromText(selectedText);
      
      if (jiraIssue) {
        e.preventDefault();
        this.showContextMenu(e.pageX, e.pageY, jiraIssue);
        contextMenuVisible = true;
      } else {
        this.hideContextMenu();
      }
    });

    // Hide context menu on click elsewhere
    document.addEventListener('click', () => {
      if (contextMenuVisible) {
        this.hideContextMenu();
        contextMenuVisible = false;
      }
    });

    // Hide context menu on escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && contextMenuVisible) {
        this.hideContextMenu();
        contextMenuVisible = false;
      }
    });
  }

  getSelectedText() {
    const selection = window.getSelection();
    return selection.toString().trim();
  }

  extractJiraIssueFromText(text) {
    if (!text) return null;
    
    // Find all Jira issues in the text
    const matches = [...text.matchAll(this.JIRA_PATTERN)];
    
    if (matches.length === 0) return null;
    
    // If there's only one issue, return it
    if (matches.length === 1) {
      return matches[0][0];
    }
    
    // If there are multiple issues, prefer the one that's most completely selected
    // This handles cases where someone selects "ABC-123 and DEF-456" 
    // and we want to be smart about which one they likely want
    const trimmedText = text.trim();
    
    for (const match of matches) {
      const issue = match[0];
      const startIndex = match.index;
      const endIndex = startIndex + issue.length;
      
      // Check if this issue is at the start or end of selection
      if (startIndex === 0 || endIndex === trimmedText.length) {
        return issue;
      }
      
      // Check if this issue is surrounded by word boundaries in the selection
      const beforeChar = trimmedText[startIndex - 1] || ' ';
      const afterChar = trimmedText[endIndex] || ' ';
      if (/\s/.test(beforeChar) && /\s/.test(afterChar)) {
        return issue;
      }
    }
    
    // Default to the first match if no clear preference
    return matches[0][0];
  }

  showContextMenu(x, y, issueId) {
    // Remove existing context menu if any
    this.hideContextMenu();

    const contextMenu = document.createElement('div');
    contextMenu.className = 'jira-context-menu';
    contextMenu.innerHTML = `
      <div class="jira-context-menu-item" data-action="log-time">
        <span class="jira-context-menu-icon">⏱</span>
        Log Time for ${issueId}
      </div>
    `;

    // Add to DOM first to measure dimensions
    contextMenu.style.position = 'absolute';
    contextMenu.style.visibility = 'hidden';
    document.body.appendChild(contextMenu);

    // Measure menu dimensions
    const menuRect = contextMenu.getBoundingClientRect();
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight
    };

    // Adjust position to keep menu in viewport
    let finalX = x;
    let finalY = y;

    if (x + menuRect.width > viewport.width) {
      finalX = x - menuRect.width;
    }

    if (y + menuRect.height > viewport.height) {
      finalY = y - menuRect.height;
    }

    // Ensure minimum margins
    finalX = Math.max(10, finalX);
    finalY = Math.max(10, finalY);

    // Apply final position and make visible
    contextMenu.style.left = `${finalX}px`;
    contextMenu.style.top = `${finalY}px`;
    contextMenu.style.visibility = 'visible';
    contextMenu.style.zIndex = '10000';

    // Add click handler
    const menuItem = contextMenu.querySelector('[data-action="log-time"]');
    menuItem.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hideContextMenu();
      this.showPopup(issueId, menuItem);
    });

    this.currentContextMenu = contextMenu;
  }

  hideContextMenu() {
    if (this.currentContextMenu) {
      this.currentContextMenu.remove();
      this.currentContextMenu = null;
    }
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
        <h3 class="jira-issue-popup-title">Log Time: <a href="${issueUrl}" target="_blank" style="color: inherit; text-decoration: none;">${issueId}</a> <span class="jira-popup-beta-badge">BETA</span></h3>
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
    document.querySelectorAll('.jira-issue-id-highlight').forEach(highlight => {
      const container = highlight.parentNode;
      const parent = container?.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(highlight.textContent), container);
        parent.normalize();
      }
    });
    document.querySelectorAll('.jira-log-time-icon').forEach(icon=>icon.remove());
    this.highlightedIssues.clear();
  }

  cleanup() {
    this.clearHighlights();
    this.closePopup();
    this.hideContextMenu();
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
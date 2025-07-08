// JIRA Issue ID Detection and Time Tracking Content Script
// This script runs on all web pages and detects JIRA issue IDs

class JiraIssueDetector {
  constructor() {
    this.highlights = [];
    this.observer = null;
    this.currentBubble = null;
    this.popup = null;
    this.isProcessing = false;
    this.lastProcessedText = '';
    this.cursorPosition = null;
    this.debug = false; // Set to true for debugging
  }

  async init() {
    try {
      // Wait for page to be ready
      if (document.readyState === 'loading') {
        await new Promise(resolve => {
          document.addEventListener('DOMContentLoaded', resolve);
        });
      }

      // Get extension settings
      const settings = await this.getExtensionSettings();
      if (this.debug) console.debug('Extension settings:', settings);

      // Show experimental badge
      this.showExperimentalBadge();

      // Start scanning and setup observers
      this.scanAndHighlightIssues();
      this.setupObserver();

      // Set up selection bubble for editable content
      this.setupSelectionBubble();
    } catch (error) {
      console.error('Failed to initialize Jira detector:', error);
    }
  }

  async getExtensionSettings() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
        resolve(response || {});
      });
    });
  }

  showExperimentalBadge() {
    // Show a small badge indicating the extension is active
    const badge = document.createElement('div');
    badge.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      background: #0052cc;
      color: white;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      z-index: 9999;
      font-family: sans-serif;
      opacity: 0.8;
    `;
    badge.textContent = 'Jira Time Logger';
    document.body.appendChild(badge);
    
    // Auto-hide after 3 seconds
    setTimeout(() => {
      badge.style.transition = 'opacity 0.5s';
      badge.style.opacity = '0';
      setTimeout(() => badge.remove(), 500);
    }, 3000);
  }

  scanAndHighlightIssues() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // Clear existing highlights
      this.clearHighlights();

      // Find all text nodes that might contain Jira issues
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const element = node.parentElement;
            // Skip contenteditable elements (we handle those separately with bubbles)
            if (this.isContentEditable(element)) {
              return NodeFilter.FILTER_REJECT;
            }
            // Only process text nodes that might contain Jira issues
            return this.mightContainJiraIssue(element) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          }
        }
      );

      const textNodes = [];
      let node;
      while (node = walker.nextNode()) {
        textNodes.push(node);
      }

      // Process text nodes
      textNodes.forEach(textNode => {
        this.highlightIssuesInTextNode(textNode);
      });

    } finally {
      this.isProcessing = false;
    }
  }

  isContentEditable(element) {
    if (!element) return false;
    return element.isContentEditable || element.contentEditable === 'true' ||
           element.tagName === 'INPUT' || element.tagName === 'TEXTAREA';
  }

  mightContainJiraIssue(element) {
    if (!element || !element.textContent) return false;
    const text = element.textContent;
    // Quick check for potential Jira issue patterns
    return /[A-Z]{1,10}-\d+/.test(text);
  }

  saveCursorPosition() {
    const selection = window.getSelection();
    if (!selection.rangeCount) return null;

    const range = selection.getRangeAt(0);
    const element = range.commonAncestorContainer;
    
    // Only save cursor position in editable elements
    if (!this.isContentEditable(element.nodeType === Node.TEXT_NODE ? element.parentElement : element)) {
      return null;
    }

    return {
      startContainer: range.startContainer,
      startOffset: range.startOffset,
      endContainer: range.endContainer,
      endOffset: range.endOffset,
      collapsed: range.collapsed
    };
  }

  restoreCursorPosition(cursorInfo) {
    if (!cursorInfo) return;

    try {
      const selection = window.getSelection();
      const range = document.createRange();
      
      range.setStart(cursorInfo.startContainer, cursorInfo.startOffset);
      range.setEnd(cursorInfo.endContainer, cursorInfo.endOffset);
      
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (error) {
      // Silently ignore cursor restoration errors
    }
  }

  highlightIssuesInTextNode(textNode) {
    if (!textNode.textContent) return;

    const text = textNode.textContent;
    const jiraPattern = /\b[A-Z]{1,10}-\d+\b/g;
    const matches = [...text.matchAll(jiraPattern)];

    if (matches.length === 0) return;

    const parent = textNode.parentNode;
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;

    matches.forEach(match => {
      const issueId = match[0];
      const startIndex = match.index;
      const endIndex = startIndex + issueId.length;

      // Add text before the match
      if (startIndex > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, startIndex)));
      }

      // Create highlighted span for the Jira issue
      const span = document.createElement('span');
      span.className = 'jira-issue-highlight';
      span.textContent = issueId;
      span.setAttribute('data-jira-issue', issueId);

      // Apply styling
      Object.assign(span.style, {
        backgroundColor: '#e3f2fd',
        color: '#1976d2',
        padding: '1px 3px',
        borderRadius: '3px',
        cursor: 'pointer',
        position: 'relative',
        textDecoration: 'underline',
        fontWeight: '500'
      });

      // Add click handler
      span.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showPopup(issueId, span);
      });

      // Add hover effect
      span.addEventListener('mouseenter', () => {
        span.style.backgroundColor = '#bbdefb';
      });
      
      span.addEventListener('mouseleave', () => {
        span.style.backgroundColor = '#e3f2fd';
      });

      fragment.appendChild(span);
      this.highlights.push(span);
      lastIndex = endIndex;
    });

    // Add remaining text
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    // Replace the original text node
    parent.replaceChild(fragment, textNode);
  }

  setupObserver() {
    // Disconnect existing observer
    if (this.observer) {
      this.observer.disconnect();
    }

    // Create new observer for dynamic content
    this.observer = new MutationObserver((mutations) => {
      let shouldRescan = false;

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && this.mightContainJiraIssue(node)) {
              shouldRescan = true;
              break;
            }
          }
        } else if (mutation.type === 'characterData') {
          if (this.mightContainJiraIssue(mutation.target.parentElement)) {
            shouldRescan = true;
          }
        }
        
        if (shouldRescan) break;
      }

      if (shouldRescan) {
        // Debounce rescanning
        clearTimeout(this.rescanTimeout);
        this.rescanTimeout = setTimeout(() => {
          this.scanAndHighlightIssues();
        }, 300);
      }
    });

    // Start observing
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  setupSelectionBubble() {
    // Listen for text selection changes
    document.addEventListener('mouseup', () => {
      setTimeout(() => this.handleTextSelection(), 10);
    });
    
    document.addEventListener('keyup', () => {
      setTimeout(() => this.handleTextSelection(), 10);
    });

    // Hide bubble on click elsewhere
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.jira-selection-bubble')) {
        this.hideBubble();
      }
    });

    // Hide bubble on scroll
    document.addEventListener('scroll', () => {
      this.hideBubble();
    }, true);
  }

  handleTextSelection() {
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();
    
    if (!selectedText) {
      this.hideBubble();
      return;
    }

    const jiraIssue = this.extractJiraIssueFromText(selectedText);
    
    if (jiraIssue && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      
      // Only show bubble if selection is in editable content
      const container = range.commonAncestorContainer;
      const element = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
      
      if (this.isContentEditable(element)) {
        this.showBubble(rect, jiraIssue);
      } else {
        this.hideBubble();
      }
    } else {
      this.hideBubble();
    }
  }

  showBubble(selectionRect, jiraIssue) {
    // Remove existing bubble
    this.hideBubble();

    // Create bubble element
    const bubble = document.createElement('div');
    bubble.className = 'jira-selection-bubble';
    
    // Apply theme
    this.applyBubbleTheme(bubble);
    
    bubble.innerHTML = `
      <div class="jira-bubble-content">
        <span class="jira-bubble-icon">⏱</span>
        <span class="jira-bubble-text">Log time for ${jiraIssue}</span>
      </div>
    `;

    // Position bubble below selection
    const bubbleX = selectionRect.left + (selectionRect.width / 2);
    const bubbleY = selectionRect.bottom + window.scrollY + 8;

    bubble.style.position = 'absolute';
    bubble.style.left = `${bubbleX}px`;
    bubble.style.top = `${bubbleY}px`;
    bubble.style.transform = 'translateX(-50%)';
    bubble.style.zIndex = '10000';

    // Add click handler
    bubble.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hideBubble();
      this.showPopup(jiraIssue, bubble, { centered: true });
    });

    // Add to page
    document.body.appendChild(bubble);
    this.currentBubble = bubble;

    // Position adjustment if off-screen
    this.adjustBubblePosition(bubble);

    // Animate in
    setTimeout(() => {
      bubble.classList.add('jira-bubble-visible');
    }, 10);
  }

  hideBubble() {
    if (this.currentBubble) {
      this.currentBubble.remove();
      this.currentBubble = null;
    }
  }

  applyBubbleTheme(bubble) {
    // Detect if page has dark theme
    const bodyStyles = window.getComputedStyle(document.body);
    const backgroundColor = bodyStyles.backgroundColor;
    const isDark = backgroundColor && this.isColorDark(backgroundColor);

    // Base styles
    Object.assign(bubble.style, {
      background: isDark ? '#2d2d2d' : '#ffffff',
      border: `1px solid ${isDark ? '#555' : '#e0e0e0'}`,
      borderRadius: '8px',
      boxShadow: isDark ? 
        '0 4px 12px rgba(0, 0, 0, 0.5)' : 
        '0 4px 12px rgba(0, 0, 0, 0.15)',
      padding: '8px 12px',
      fontSize: '14px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      color: isDark ? '#ffffff' : '#333333',
      cursor: 'pointer',
      userSelect: 'none',
      opacity: '0',
      transition: 'opacity 0.2s ease, transform 0.2s ease',
      transform: 'translateX(-50%) translateY(-4px)',
      whiteSpace: 'nowrap'
    });

    // Add arrow pointing up to selection
    const arrow = document.createElement('div');
    arrow.className = 'jira-bubble-arrow';
    Object.assign(arrow.style, {
      position: 'absolute',
      top: '-6px',
      left: '50%',
      transform: 'translateX(-50%)',
      width: '0',
      height: '0',
      borderLeft: '6px solid transparent',
      borderRight: '6px solid transparent',
      borderBottom: `6px solid ${isDark ? '#2d2d2d' : '#ffffff'}`,
      zIndex: '1'
    });

    const arrowBorder = document.createElement('div');
    Object.assign(arrowBorder.style, {
      position: 'absolute',
      top: '-7px',
      left: '50%',
      transform: 'translateX(-50%)',
      width: '0',
      height: '0',
      borderLeft: '7px solid transparent',
      borderRight: '7px solid transparent',
      borderBottom: `7px solid ${isDark ? '#555' : '#e0e0e0'}`,
      zIndex: '0'
    });

    bubble.appendChild(arrowBorder);
    bubble.appendChild(arrow);
  }

  adjustBubblePosition(bubble) {
    const rect = bubble.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const margin = 10;

    // Adjust horizontal position if off-screen
    if (rect.left < margin) {
      bubble.style.left = `${margin}px`;
      bubble.style.transform = 'translateX(0)';
    } else if (rect.right > viewportWidth - margin) {
      bubble.style.left = `${viewportWidth - margin}px`;
      bubble.style.transform = 'translateX(-100%)';
    }
  }

  isColorDark(color) {
    // Simple check to determine if a color is dark
    if (color.includes('rgb')) {
      const values = color.match(/\d+/g);
      if (values && values.length >= 3) {
        const brightness = (parseInt(values[0]) * 299 + parseInt(values[1]) * 587 + parseInt(values[2]) * 114) / 1000;
        return brightness < 128;
      }
    }
    return false;
  }

  getSelectedText() {
    return window.getSelection().toString();
  }

  findJiraIssueNearCursor(editableElement) {
    if (!editableElement) return null;

    const selection = window.getSelection();
    if (!selection.rangeCount) return null;

    const range = selection.getRangeAt(0);
    const textContent = editableElement.textContent || editableElement.innerText || '';
    
    // Look for Jira issues around the cursor position
    const cursorOffset = this.getTextOffsetFromElement(editableElement, range.startContainer, range.startOffset);
    if (cursorOffset === -1) return null;

    const before = textContent.slice(Math.max(0, cursorOffset - 20), cursorOffset);
    const after = textContent.slice(cursorOffset, Math.min(textContent.length, cursorOffset + 20));
    const context = before + after;

    return this.extractJiraIssueFromText(context);
  }

  getTextOffsetFromElement(element, node, offset) {
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );

    let textOffset = 0;
    let currentNode;

    while (currentNode = walker.nextNode()) {
      if (currentNode === node) {
        return textOffset + offset;
      }
      textOffset += currentNode.textContent.length;
    }

    return -1;
  }

  extractJiraIssueFromText(text) {
    if (!text) return null;
    
    const jiraPattern = /\b[A-Z]{1,10}-\d+\b/;
    const match = text.match(jiraPattern);
    return match ? match[0] : null;
  }

  async showPopup(issueId, targetElement, options = {}) {
    // Close existing popup
    this.closePopup();

    try {
      const settings = await this.getExtensionSettings();
      const popup = await this.createPopup(issueId, settings);
      
      // Apply theme to popup
      await this.applyThemeToPopup(popup);
      
      // Position popup
      if (options.centered) {
        this.centerPopup(popup);
      } else {
        this.positionPopup(popup, targetElement);
      }
      
      // Setup event handlers
      this.setupPopupHandlers(issueId, settings);
      
      this.popup = popup;
    } catch (error) {
      console.error('Failed to show popup:', error);
      this.showPopupError('Failed to load popup. Please check your settings.');
    }
  }

  async createPopup(issueId, settings) {
    const popup = document.createElement('div');
    popup.className = 'jira-popup';
    
    // Get current date for default
    const today = new Date().toISOString().split('T')[0];
    
    popup.innerHTML = `
      <div class="jira-popup-header">
        <h3>Log Time - ${issueId}</h3>
        <button class="jira-popup-close" aria-label="Close">×</button>
      </div>
      <div class="jira-popup-content">
        <div class="jira-popup-field">
          <label for="timeSpent">Time Spent:</label>
          <input type="text" id="timeSpent" placeholder="1h 30m" />
          <small>Format: 2h 30m, 1.5h, 90m</small>
        </div>
        <div class="jira-popup-field">
          <label for="workDate">Date:</label>
          <input type="date" id="workDate" value="${today}" />
        </div>
        <div class="jira-popup-field">
          <label for="workComment">Comment (optional):</label>
          <textarea id="workComment" placeholder="Description of work done..."></textarea>
        </div>
        <div class="jira-popup-actions">
          <button id="logTime" class="jira-popup-primary">Log Time</button>
          <button id="cancelLog" class="jira-popup-secondary">Cancel</button>
        </div>
        <div class="jira-popup-status"></div>
      </div>
    `;

    // Apply base styles
    Object.assign(popup.style, {
      position: 'fixed',
      zIndex: '10001',
      background: '#ffffff',
      border: '1px solid #ddd',
      borderRadius: '8px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
      padding: '0',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: '14px',
      width: '400px',
      maxHeight: '80vh',
      overflow: 'auto'
    });

    document.body.appendChild(popup);
    return popup;
  }

  async applyThemeToPopup(popup) {
    // Detect page theme
    const bodyStyles = window.getComputedStyle(document.body);
    const backgroundColor = bodyStyles.backgroundColor;
    const isDark = backgroundColor && this.isColorDark(backgroundColor);

    if (isDark) {
      popup.style.background = '#2d2d2d';
      popup.style.color = '#ffffff';
      popup.style.border = '1px solid #555';
      
      // Apply dark theme to all child elements
      const inputs = popup.querySelectorAll('input, textarea');
      inputs.forEach(input => {
        input.style.background = '#1a1a1a';
        input.style.color = '#ffffff';
        input.style.border = '1px solid #555';
      });
    }
  }

  positionPopup(popup, targetElement) {
    if (!targetElement) {
      this.centerPopup(popup);
      return;
    }

    const rect = targetElement.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    
    // Position below the target element
    let left = rect.left + (rect.width / 2) - (popupRect.width / 2);
    let top = rect.bottom + window.scrollY + 10;
    
    // Adjust if off-screen
    const margin = 10;
    left = Math.max(margin, Math.min(left, window.innerWidth - popupRect.width - margin));
    
    if (top + popupRect.height > window.innerHeight + window.scrollY) {
      top = rect.top + window.scrollY - popupRect.height - 10;
    }
    
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  centerPopup(popup) {
    const rect = popup.getBoundingClientRect();
    const left = (window.innerWidth - rect.width) / 2;
    const top = (window.innerHeight - rect.height) / 2;
    
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  setupPopupHandlers(issueId, settings) {
    const popup = this.popup;
    if (!popup) return;

    const closePopup = () => this.closePopup();

    // Close button
    const closeBtn = popup.querySelector('.jira-popup-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', closePopup);
    }

    // Cancel button
    const cancelBtn = popup.querySelector('#cancelLog');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', closePopup);
    }

    // Log time button
    const logBtn = popup.querySelector('#logTime');
    if (logBtn) {
      logBtn.addEventListener('click', async () => {
        const timeInput = popup.querySelector('#timeSpent');
        const dateInput = popup.querySelector('#workDate');
        const commentInput = popup.querySelector('#workComment');

        const timeSpent = timeInput.value.trim();
        const workDate = dateInput.value;
        const comment = commentInput.value.trim();

        if (!timeSpent) {
          this.showPopupError('Please enter time spent');
          timeInput.focus();
          return;
        }

        if (!this.validateTimeFormat(timeSpent)) {
          this.showPopupError('Invalid time format. Use: 1h 30m, 1.5h, or 90m');
          timeInput.focus();
          return;
        }

        await this.logTime(issueId, timeSpent, workDate, comment, settings);
      });
    }

    // Close on escape key
    const handleKeydown = (e) => {
      if (e.key === 'Escape') {
        closePopup();
      }
    };
    document.addEventListener('keydown', handleKeydown);

    // Store the handler so we can remove it later
    popup._keydownHandler = handleKeydown;

    // Focus first input
    const firstInput = popup.querySelector('#timeSpent');
    if (firstInput) {
      setTimeout(() => firstInput.focus(), 100);
    }
  }

  validateTimeFormat(timeStr) {
    // Accept formats like: 1h 30m, 1.5h, 90m, 2h, 30m
    const timePattern = /^(\d+(\.\d+)?[hH](\s*\d+[mM])?|\d+[mM])$/;
    return timePattern.test(timeStr.replace(/\s+/g, ''));
  }

  convertTimeToSeconds(timeStr) {
    const cleanTime = timeStr.toLowerCase().replace(/\s+/g, '');
    let totalSeconds = 0;
    
    // Match hours and minutes
    const hourMatch = cleanTime.match(/(\d+(?:\.\d+)?)h/);
    const minuteMatch = cleanTime.match(/(\d+)m/);
    
    if (hourMatch) {
      totalSeconds += parseFloat(hourMatch[1]) * 3600;
    }
    
    if (minuteMatch) {
      totalSeconds += parseInt(minuteMatch[1]) * 60;
    }
    
    return totalSeconds;
  }

  async logTime(issueId, timeStr, dateStr, comment, settings) {
    const statusDiv = this.popup.querySelector('.jira-popup-status');
    
    try {
      statusDiv.textContent = 'Logging time...';
      statusDiv.style.color = '#666';

      // Show configuration error if settings are missing
      if (!settings.jiraUrl || !settings.email || !settings.apiToken) {
        this.showConfigurationError();
        return;
      }

      // Convert time to seconds
      const timeSpentSeconds = this.convertTimeToSeconds(timeStr);
      
      // Prepare the worklog data
      const worklogData = {
        timeSpentSeconds: timeSpentSeconds,
        started: this.getStartedTime(dateStr),
        comment: comment || ''
      };

      // Send request to background script
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'logWorklog',
          issueId: issueId,
          worklogData: worklogData,
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
        this.showPopupSuccess(`Time logged successfully: ${timeStr}`);
        setTimeout(() => this.closePopup(), 2000);
      } else {
        this.showPopupError(response.error || 'Failed to log time');
      }
    } catch (error) {
      console.error('Error logging time:', error);
      this.showPopupError('Error: ' + error.message);
    }
  }

  getStartedTime(dateString) {
    // Convert date string to ISO format for Jira API
    const date = new Date(dateString);
    // Set time to 9:00 AM by default
    date.setHours(9, 0, 0, 0);
    return date.toISOString();
  }

  showPopupSuccess(message) {
    const statusDiv = this.popup?.querySelector('.jira-popup-status');
    if (statusDiv) {
      statusDiv.textContent = message;
      statusDiv.style.color = '#4caf50';
    }
  }

  showPopupError(message) {
    const statusDiv = this.popup?.querySelector('.jira-popup-status');
    if (statusDiv) {
      statusDiv.textContent = message;
      statusDiv.style.color = '#f44336';
    }
  }

  showConfigurationError() {
    const statusDiv = this.popup?.querySelector('.jira-popup-status');
    if (statusDiv) {
      statusDiv.innerHTML = `
        <div style="color: #f44336; margin-bottom: 8px;">
          Extension not configured. Please:
        </div>
        <ol style="margin: 0; padding-left: 20px; font-size: 12px;">
          <li>Click the extension icon</li>
          <li>Enter your Jira URL</li>
          <li>Enter your email</li>
          <li>Enter your API token</li>
        </ol>
        <div style="margin-top: 8px; font-size: 12px;">
          <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" style="color: #1976d2;">
            Create API Token
          </a>
        </div>
      `;
    }
  }

  closePopup() {
    if (this.popup) {
      // Remove keydown handler
      if (this.popup._keydownHandler) {
        document.removeEventListener('keydown', this.popup._keydownHandler);
      }
      
      this.popup.remove();
      this.popup = null;
    }
  }

  clearHighlights() {
    this.highlights.forEach(highlight => {
      if (highlight.parentNode) {
        const textNode = document.createTextNode(highlight.textContent);
        highlight.parentNode.replaceChild(textNode, highlight);
      }
    });
    this.highlights = [];
  }

  cleanup() {
    this.clearHighlights();
    this.closePopup();
    this.hideBubble();
    this.observer?.disconnect();
    this.observer = null;
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    const detector = new JiraIssueDetector();
    detector.init();
  });
} else {
  const detector = new JiraIssueDetector();
  detector.init();
}
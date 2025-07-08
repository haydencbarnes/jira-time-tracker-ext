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
    // Enable debug mode via URL parameter or localStorage
    this.debug = window.location.search.includes('jira-debug') || 
                localStorage.getItem('jira-debug') === 'true';
    
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
    let lastRightClickInfo = null;

    // Listen for right-click events to capture position and selection
    document.addEventListener('contextmenu', (e) => {
      // Always capture right-click info for potential custom menu injection
      lastRightClickInfo = {
        x: e.pageX,
        y: e.pageY,
        clientX: e.clientX,
        clientY: e.clientY,
        target: e.target,
        timestamp: Date.now()
      };

            // Only handle context menu in editable elements
      if (!this.isContentEditable(e.target)) {
        this.hideContextMenu();
        return;
      }

      const selectedText = this.getSelectedText();
      let jiraIssue = this.extractJiraIssueFromText(selectedText);
      
      // If no Jira issue in selection, try to find one in the current editable element
      if (!jiraIssue && this.isContentEditable(e.target)) {
        jiraIssue = this.findJiraIssueNearCursor(e.target);
      }
      
      if (jiraIssue) {
          // Try to inject into custom menus first, fallback to our own menu
          setTimeout(() => {
            const injected = this.tryInjectIntoCustomMenu(jiraIssue, lastRightClickInfo);
            if (!injected) {
              // If injection failed, prevent default and show our menu
              e.preventDefault();
              this.showContextMenu(e.pageX, e.pageY, jiraIssue);
              contextMenuVisible = true;
            } else {
              // Successfully injected, hide our standalone menu if it exists
              this.hideContextMenu();
            }
          }, 50); // Small delay to let custom menus render
        } else {
          this.hideContextMenu();
        }
    });

    // Watch for custom context menus being added to DOM
    this.setupCustomMenuInjection();

    // Hide context menu on click elsewhere
    document.addEventListener('click', () => {
      if (contextMenuVisible) {
        this.hideContextMenu();
        contextMenuVisible = false;
      }
    });

    // Handle keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && contextMenuVisible) {
        this.hideContextMenu();
        contextMenuVisible = false;
      }
      
              // Handle keyboard context menu (Shift+F10, Menu key)
        if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
          const activeElement = document.activeElement;
          if (this.isContentEditable(activeElement)) {
            const selectedText = this.getSelectedText();
            let jiraIssue = this.extractJiraIssueFromText(selectedText);
            
            // If no Jira issue in selection, try to find one in the current editable element
            if (!jiraIssue) {
              jiraIssue = this.findJiraIssueNearCursor(activeElement);
            }
            
            if (jiraIssue) {
            lastRightClickInfo = {
              x: 0,
              y: 0,
              clientX: 0, 
              clientY: 0,
              target: activeElement,
              timestamp: Date.now(),
              keyboardTriggered: true
            };
            
            // Try to inject into any custom menu that appears
            setTimeout(() => {
              if (!this.tryInjectIntoCustomMenu(jiraIssue, lastRightClickInfo)) {
                // Get cursor position for fallback menu
                const selection = window.getSelection();
                let rect = { left: 0, top: 0 };
                
                if (selection.rangeCount > 0) {
                  const range = selection.getRangeAt(0);
                  const rangeRect = range.getBoundingClientRect();
                  rect = rangeRect;
                }
                
                e.preventDefault();
                this.showContextMenu(rect.left + window.pageXOffset, rect.top + window.pageYOffset, jiraIssue, { centered: true });
                contextMenuVisible = true;
              }
            }, 50);
          }
        }
      }
    });
  }

  setupCustomMenuInjection() {
    // Use MutationObserver to detect when ANY potential menu is added
    const menuObserver = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if this looks like a menu (dynamic detection)
            const menuElement = this.detectPotentialMenu(node);
            if (menuElement) {
              this.attemptMenuInjection(menuElement);
            }
          }
        });
      });
    });

    menuObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    this.menuObserver = menuObserver;
  }

  detectPotentialMenu(node) {
    // Check if the node itself looks like a menu
    if (this.looksLikeMenu(node)) {
      return node;
    }

    // Check immediate children for menu-like elements
    if (node.children) {
      for (const child of node.children) {
        if (this.looksLikeMenu(child)) {
          return child;
        }
      }
    }

    return null;
  }

  looksLikeMenu(element) {
    if (!element || !element.getBoundingClientRect) return false;

    const rect = element.getBoundingClientRect();
    const styles = window.getComputedStyle(element);

    // Basic visibility check
    if (rect.width === 0 || rect.height === 0 || 
        styles.display === 'none' || styles.visibility === 'hidden') {
      return false;
    }

    // Check for menu-like attributes (high priority)
    const role = element.getAttribute('role');
    if (role === 'menu' || role === 'menubar' || role === 'listbox' || role === 'dialog') {
      if (this.debug) console.debug('Menu detected by role:', role, element);
      return true;
    }

    // Check for Microsoft/Outlook context menu ID pattern
    const id = element.getAttribute('id') || '';
    if (id.startsWith('ContextMenu-') || id.includes('contextualCtxMenu')) {
      if (this.debug) console.debug('Menu detected by ID pattern:', id, element);
      return true;
    }

    // Check for common menu class patterns
    const className = element.className || '';
    if (className.toLowerCase().includes('menu') || 
        className.toLowerCase().includes('context') ||
        className.toLowerCase().includes('dropdown') ||
        className.toLowerCase().includes('popup')) {
      if (this.debug) console.debug('Menu detected by class pattern:', className, element);
      return true;
    }

    // More permissive positioning check
    const position = styles.position;
    if (position !== 'absolute' && position !== 'fixed' && position !== 'relative') {
      return false;
    }

    // More permissive z-index check (lowered threshold)
    const zIndex = parseInt(styles.zIndex) || 0;
    if (position === 'fixed' && zIndex < 1) {
      return false;
    }
    if (position === 'absolute' && zIndex < 10) {
      return false;
    }

    // Check for menu-like styling (more permissive)
    const hasMenuStyling = 
      styles.boxShadow !== 'none' ||
      styles.border !== 'none' && styles.border !== '0px' && styles.border !== 'initial' ||
      styles.backgroundColor !== 'rgba(0, 0, 0, 0)' && styles.backgroundColor !== 'transparent' && styles.backgroundColor !== 'initial' ||
      styles.outline !== 'none' ||
      parseFloat(styles.borderRadius) > 0;

    // Check if it contains clickable items (reduced threshold)
    const clickableItems = this.findClickableMenuItems(element);
    const hasClickableContent = clickableItems.length >= 1;

          // Accept if it has either menu styling OR clickable content
      if (hasMenuStyling || hasClickableContent) {
        // Additional size validation - must be reasonable menu size
        if (rect.width >= 80 && rect.height >= 30) {
          if (this.debug) console.debug('Menu detected by styling+content:', element);
          return true;
        }
      }

    return false;
  }

  findClickableMenuItems(menuElement) {
    const potentialItems = [];
    
    // Priority 1: Look for actual menu items (buttons, links with menuitem role)
    const menuItems = menuElement.querySelectorAll('[role="menuitem"], button, a[href]');
    for (const item of menuItems) {
      const rect = item.getBoundingClientRect();
      if (rect.width >= 30 && rect.height >= 15) {
        potentialItems.push(item);
      }
    }
    
    // Priority 2: Look for other clickable elements if no menu items found
    if (potentialItems.length === 0) {
      const candidates = menuElement.querySelectorAll('*');
      
      for (const candidate of candidates) {
        const styles = window.getComputedStyle(candidate);
        const rect = candidate.getBoundingClientRect();
        
        // Skip invisible or tiny elements
        if (rect.width < 30 || rect.height < 15) continue;
        
        // Check for clickable indicators
        const isClickable = 
          styles.cursor === 'pointer' ||
          candidate.hasAttribute('role') && ['option', 'button', 'link'].includes(candidate.getAttribute('role')) ||
          candidate.tagName === 'LI' && candidate.textContent.trim().length > 0 ||
          candidate.hasAttribute('tabindex') ||
          candidate.hasAttribute('data-command') ||
          candidate.hasAttribute('data-action') ||
          candidate.className.toLowerCase().includes('item') ||
          candidate.className.toLowerCase().includes('option');
          
        if (isClickable) {
          potentialItems.push(candidate);
        }
      }
    }
    
    return potentialItems;
  }

  tryInjectIntoCustomMenu(jiraIssue, rightClickInfo) {
    if (!rightClickInfo || Date.now() - rightClickInfo.timestamp > 1000) {
      return false; // Too old or no info
    }

    // Look for custom menu immediately
    const menuElement = this.findVisibleCustomMenu(rightClickInfo);
    if (menuElement) {
      this.injectJiraOption(menuElement, jiraIssue);
      return true; // Successfully injected
    }

    // Wait a bit more for menu to fully render and try again
    setTimeout(() => {
      const delayedMenuElement = this.findVisibleCustomMenu(rightClickInfo);
      if (delayedMenuElement) {
        this.injectJiraOption(delayedMenuElement, jiraIssue);
      } else {
        // Last resort: look for ANY recently added element near click position
        this.tryLastResortInjection(jiraIssue, rightClickInfo);
      }
    }, 150); // Slightly longer delay

    return false; // No immediate injection, might inject later
  }

  tryLastResortInjection(jiraIssue, rightClickInfo) {
    // Find any element that appeared recently near the click position
    const clickX = rightClickInfo.clientX;
    const clickY = rightClickInfo.clientY;
    
    const recentElements = document.querySelectorAll('*');
    const candidates = [];
    
    for (const element of recentElements) {
      const rect = element.getBoundingClientRect();
      const styles = window.getComputedStyle(element);
      
      // Skip invisible elements
      if (rect.width === 0 || rect.height === 0 || 
          styles.display === 'none' || styles.visibility === 'hidden') {
        continue;
      }
      
      // Must be positioned
      if (styles.position === 'static') continue;
      
      // Must be near click location
      const distance = Math.sqrt(
        Math.pow(rect.left - clickX, 2) + Math.pow(rect.top - clickY, 2)
      );
      if (distance > 150) continue;
      
      // Must have some content
      if (element.textContent.trim().length === 0) continue;
      
      // Must be reasonable menu size
      if (rect.width < 50 || rect.height < 20 || rect.width > 600 || rect.height > 800) continue;
      
      // Has some clickable content or menu-like structure
      const hasContent = 
        element.querySelectorAll('*').length > 3 || // Has some structure
        element.textContent.includes('Copy') || // Common menu items
        element.textContent.includes('Paste') ||
        element.textContent.includes('Cut') ||
        element.textContent.includes('Delete') ||
        element.textContent.includes('Reply') ||
        element.textContent.includes('Forward');
      
      if (hasContent) {
        candidates.push({ element, distance });
      }
    }
    
    // Sort by distance (closest first)
    candidates.sort((a, b) => a.distance - b.distance);
    
    // Try to inject into the closest candidate
    if (candidates.length > 0) {
      this.injectJiraOption(candidates[0].element, jiraIssue);
    }
  }

  findVisibleCustomMenu(rightClickInfo) {
    const clickX = rightClickInfo.clientX;
    const clickY = rightClickInfo.clientY;
    const isKeyboardTriggered = rightClickInfo.keyboardTriggered;

    // Primary detection: Find elements that clearly look like menus
    const allElements = document.querySelectorAll('*');
    const potentialMenus = [];
    const fallbackCandidates = [];

    for (const element of allElements) {
      if (this.looksLikeMenu(element)) {
        potentialMenus.push(element);
      } else if (this.couldBeMenu(element)) {
        fallbackCandidates.push(element);
      }
    }

    // Sort by z-index (highest first) to get the topmost menu
    potentialMenus.sort((a, b) => {
      const zIndexA = parseInt(window.getComputedStyle(a).zIndex) || 0;
      const zIndexB = parseInt(window.getComputedStyle(b).zIndex) || 0;
      return zIndexB - zIndexA;
    });

    // Try primary candidates first
    for (const menu of potentialMenus) {
      const rect = menu.getBoundingClientRect();
      
      // For keyboard-triggered menus, accept the topmost visible menu
      if (isKeyboardTriggered) {
        return menu;
      }
      
      // For mouse-triggered menus, check if menu is near the click position
      const distance = Math.sqrt(
        Math.pow(rect.left - clickX, 2) + Math.pow(rect.top - clickY, 2)
      );
      
      if (distance < 300) { // Within 300px of click
        return menu;
      }
    }

    // Fallback: Try less obvious candidates (for cases like Outlook)
    fallbackCandidates.sort((a, b) => {
      const zIndexA = parseInt(window.getComputedStyle(a).zIndex) || 0;
      const zIndexB = parseInt(window.getComputedStyle(b).zIndex) || 0;
      return zIndexB - zIndexA;
    });

    for (const menu of fallbackCandidates) {
      const rect = menu.getBoundingClientRect();
      
      if (isKeyboardTriggered) {
        return menu;
      }
      
      const distance = Math.sqrt(
        Math.pow(rect.left - clickX, 2) + Math.pow(rect.top - clickY, 2)
      );
      
      if (distance < 200) { // Stricter distance for fallback candidates
        return menu;
      }
    }

    return null;
  }

  couldBeMenu(element) {
    if (!element || !element.getBoundingClientRect) return false;

    const rect = element.getBoundingClientRect();
    const styles = window.getComputedStyle(element);

    // Basic visibility check
    if (rect.width === 0 || rect.height === 0 || 
        styles.display === 'none' || styles.visibility === 'hidden') {
      return false;
    }

    // Size check - could be a menu if it's a reasonable size
    if (rect.width < 60 || rect.height < 25 || rect.width > 500 || rect.height > 600) {
      return false;
    }

    // Must be positioned (but more permissive than strict menu detection)
    const position = styles.position;
    if (position === 'static') {
      return false;
    }

    // Check if it has any menu-like characteristics
    const hasAnyMenuCharacteristic = 
      element.hasAttribute('role') ||
      (element.className && (
        element.className.includes('menu') ||
        element.className.includes('context') ||
        element.className.includes('dropdown') ||
        element.className.includes('popup') ||
        element.className.includes('flyout')
      )) ||
      styles.boxShadow !== 'none' ||
      styles.border !== 'none' && styles.border !== '0px' ||
      element.querySelectorAll('button, a, [role="menuitem"], [role="option"]').length > 0;

    return hasAnyMenuCharacteristic;
  }

  attemptMenuInjection(menuElement) {
    const selectedText = this.getSelectedText();
    let jiraIssue = this.extractJiraIssueFromText(selectedText);
    
    // If no Jira issue in selection, try to find one in the current editable element
    if (!jiraIssue && this.isContentEditable(document.activeElement)) {
      jiraIssue = this.findJiraIssueNearCursor(document.activeElement);
    }
    
    if (jiraIssue && this.isContentEditable(document.activeElement)) {
      this.injectJiraOption(menuElement, jiraIssue);
    }
  }

  injectJiraOption(menuElement, jiraIssue) {
    // Comprehensive duplicate prevention - check document-wide
    if (document.querySelector('.jira-injected-option')) {
      return; // Already injected somewhere, don't duplicate
    }

    if (this.debug) console.debug('Attempting to inject Jira option into menu:', menuElement, 'for issue:', jiraIssue);
    
    const jiraOption = this.createJiraMenuOption(jiraIssue, menuElement);
    
    if (this.debug) console.debug('Created Jira option element:', jiraOption);
    
    // Try different injection strategies based on menu structure
    this.injectUsingStrategy(menuElement, jiraOption);
    
    // Verify injection succeeded
    if (menuElement.querySelector('.jira-injected-option')) {
      if (this.debug) console.debug('✅ Jira option successfully injected');
    } else {
      if (this.debug) console.debug('❌ Jira option injection failed');
    }
  }

  createJiraMenuOption(jiraIssue, menuElement) {
    // Detect menu structure and create appropriate element
    const menuItems = menuElement.querySelectorAll('[role="menuitem"]');
    
    if (menuItems.length > 0) {
      // Microsoft/Outlook style: create button with matching structure
      return this.createMicrosoftStyleMenuItem(jiraIssue, menuItems[0]);
    } else {
      // Generic menu: create simple div
      return this.createGenericMenuItem(jiraIssue, menuElement);
    }
  }

  createMicrosoftStyleMenuItem(jiraIssue, sampleButton) {
    // Create li container to match Outlook structure
    const li = document.createElement('li');
    li.role = 'presentation';
    const parentLi = sampleButton.closest('li');
    li.className = parentLi ? parentLi.className : '';

    // Create a DIV that looks like a button but avoids Outlook's button handling
    const buttonDiv = document.createElement('div');
    buttonDiv.className = 'jira-injected-option';
    buttonDiv.setAttribute('role', 'menuitem');
    buttonDiv.setAttribute('tabindex', '-1');
    buttonDiv.setAttribute('aria-label', `Log Time for ${jiraIssue}`);
    buttonDiv.setAttribute('data-jira-issue', jiraIssue);
    
    // Add explicit style to prevent any inherited Outlook behaviors
    buttonDiv.style.cssText += '; pointer-events: auto; isolation: isolate; contain: layout style;';
    
    // Sample the structure from existing buttons
    const iconElement = sampleButton.querySelector('i[data-icon-name]');
    const iconClass = iconElement ? iconElement.className : 'icon-618';
    const labelElement = sampleButton.querySelector('.label-611');
    const labelClass = labelElement ? labelElement.className : 'label-611';
    
    buttonDiv.innerHTML = `
      <div class="linkContent-609">
        <i data-icon-name="ClockRegular" aria-hidden="true" class="${iconClass}">
          <span role="presentation" aria-hidden="true">⏱</span>
        </i>
        <span class="${labelClass}">Log Time for ${jiraIssue}</span>
      </div>
    `;
    
    // Copy visual styles from sample button but make it look clickable
    this.copyComputedStyles(sampleButton, buttonDiv);
    buttonDiv.style.cursor = 'pointer';
    buttonDiv.style.userSelect = 'none';
    
    // Add comprehensive event isolation
    const clickHandler = (e) => {
      if (this.debug) console.debug('Jira menu item clicked!', e, jiraIssue);
      
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      
      // Force immediate menu hide
      setTimeout(() => {
        document.body.click(); // Click elsewhere to hide Outlook menu
      }, 0);
      
      this.hideAllMenus();
      this.showPopup(jiraIssue, buttonDiv, { centered: true });
    };

    // Capture all possible events
    ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach(eventType => {
      buttonDiv.addEventListener(eventType, eventType === 'click' ? clickHandler : (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }, true);
    });

    // Add keyboard support
    buttonDiv.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        clickHandler(e);
      }
    }, true);

    // Create an additional isolation wrapper
    const isolationWrapper = document.createElement('div');
    isolationWrapper.style.cssText = 'position: relative; z-index: 1000; pointer-events: auto;';
    isolationWrapper.appendChild(buttonDiv);
    
    li.appendChild(isolationWrapper);
    return li;
  }

  createGenericMenuItem(jiraIssue, menuElement) {
    const option = document.createElement('div');
    option.className = 'jira-injected-option';
    option.innerHTML = `
      <span class="jira-menu-icon">⏱</span>
      <span class="jira-menu-text">Log Time for ${jiraIssue}</span>
    `;
    
    // Apply dynamic styles to blend with the existing menu
    this.adaptToMenuStyling(option, menuElement);
    
    option.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hideAllMenus();
      this.showPopup(jiraIssue, option, { centered: true });
    });

    return option;
  }

  copyComputedStyles(sourceElement, targetElement) {
    const sourceStyles = window.getComputedStyle(sourceElement);
    
    // Copy key visual properties
    const stylesToCopy = [
      'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
      'fontSize', 'fontFamily', 'fontWeight', 'lineHeight',
      'color', 'backgroundColor', 'border', 'borderRadius',
      'minHeight', 'height', 'display', 'alignItems', 'justifyContent',
      'textAlign', 'cursor', 'transition'
    ];
    
    stylesToCopy.forEach(style => {
      if (sourceStyles[style] && sourceStyles[style] !== 'initial') {
        targetElement.style[style] = sourceStyles[style];
      }
    });

    // Add hover effect
    const hoverBackgroundColor = this.getHoverColor(sourceElement);
    targetElement.addEventListener('mouseenter', () => {
      targetElement.style.backgroundColor = hoverBackgroundColor;
    });
    
    targetElement.addEventListener('mouseleave', () => {
      targetElement.style.backgroundColor = sourceStyles.backgroundColor;
    });
  }

  getHoverColor(element) {
    // Try to detect hover color or create appropriate one
    const styles = window.getComputedStyle(element);
    const bgColor = styles.backgroundColor;
    
    // Create hover effect based on current background
    if (bgColor.includes('rgb')) {
      const values = bgColor.match(/\d+/g);
      if (values && values.length >= 3) {
        const r = parseInt(values[0]);
        const g = parseInt(values[1]);
        const b = parseInt(values[2]);
        
        // Darken or lighten based on current brightness
        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
        if (brightness > 128) {
          // Light background, darken on hover
          return `rgba(${Math.max(0, r-20)}, ${Math.max(0, g-20)}, ${Math.max(0, b-20)}, 0.8)`;
        } else {
          // Dark background, lighten on hover
          return `rgba(${Math.min(255, r+20)}, ${Math.min(255, g+20)}, ${Math.min(255, b+20)}, 0.8)`;
        }
      }
    }
    
    return 'rgba(0, 82, 204, 0.1)'; // Default hover
  }

  adaptToMenuStyling(option, menuElement) {
    // Find existing menu items to sample styling from
    const existingItems = this.findClickableMenuItems(menuElement);
    
    if (existingItems.length === 0) {
      // Fallback to basic styling if no items found
      this.applyBasicMenuStyling(option);
      return;
    }

    // Sample styling from the first menu item
    const sampleItem = existingItems[0];
    const sampleStyles = window.getComputedStyle(sampleItem);
    const sampleRect = sampleItem.getBoundingClientRect();

    // Apply sampled styles to our option
    Object.assign(option.style, {
      display: 'flex',
      alignItems: 'center',
      cursor: 'pointer',
      userSelect: 'none',
      boxSizing: 'border-box',
      gap: '8px',
      
      // Sample these from existing items
      fontSize: sampleStyles.fontSize || '14px',
      fontFamily: sampleStyles.fontFamily,
      fontWeight: sampleStyles.fontWeight,
      lineHeight: sampleStyles.lineHeight,
      color: sampleStyles.color,
      backgroundColor: 'transparent',
      
      // Padding (use existing or reasonable default)
      padding: sampleStyles.padding || '8px 12px',
      paddingLeft: sampleStyles.paddingLeft || '12px',
      paddingRight: sampleStyles.paddingRight || '12px',
      paddingTop: sampleStyles.paddingTop || '8px',
      paddingBottom: sampleStyles.paddingBottom || '8px',
      
      // Margins and borders
      margin: sampleStyles.margin,
      border: sampleStyles.border,
      borderRadius: sampleStyles.borderRadius || '0px',
      
      // Height
      minHeight: `${Math.max(sampleRect.height, 24)}px`,
      
      // Transitions
      transition: sampleStyles.transition || 'background-color 0.15s ease'
    });

    // Style the icon
    const icon = option.querySelector('.jira-menu-icon');
    if (icon) {
      Object.assign(icon.style, {
        width: '16px',
        textAlign: 'center',
        color: '#0052cc',
        flexShrink: '0'
      });
    }

    // Add hover effects based on sampling hover states if possible
    this.addAdaptiveHoverEffects(option, sampleItem);
  }

  addAdaptiveHoverEffects(option, sampleItem) {
    // Try to detect what happens on hover for similar items
    let hoverBackgroundColor = 'rgba(0, 82, 204, 0.1)'; // Default
    
    // Sample common hover colors from the theme
    const bodyStyles = window.getComputedStyle(document.body);
    const isDarkTheme = bodyStyles.backgroundColor && 
                       this.isColorDark(bodyStyles.backgroundColor);
    
    if (isDarkTheme) {
      hoverBackgroundColor = 'rgba(255, 255, 255, 0.1)';
    } else {
      hoverBackgroundColor = 'rgba(0, 0, 0, 0.05)';
    }

    option.addEventListener('mouseenter', () => {
      option.style.backgroundColor = hoverBackgroundColor;
    });
    
    option.addEventListener('mouseleave', () => {
      option.style.backgroundColor = 'transparent';
    });
  }

  applyBasicMenuStyling(option) {
    // Fallback styling when we can't sample from existing items
    Object.assign(option.style, {
      display: 'flex',
      alignItems: 'center',
      padding: '8px 12px',
      cursor: 'pointer',
      fontSize: '14px',
      color: 'inherit',
      background: 'transparent',
      borderRadius: '4px',
      transition: 'background-color 0.15s ease',
      gap: '8px',
      userSelect: 'none',
      minHeight: '32px'
    });

    const icon = option.querySelector('.jira-menu-icon');
    if (icon) {
      Object.assign(icon.style, {
        width: '16px',
        textAlign: 'center',
        color: '#0052cc'
      });
    }

    option.addEventListener('mouseenter', () => {
      option.style.backgroundColor = 'rgba(0, 82, 204, 0.1)';
    });
    
    option.addEventListener('mouseleave', () => {
      option.style.backgroundColor = 'transparent';
    });
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

  injectUsingStrategy(menuElement, jiraOption) {
    // For Microsoft/Outlook menus, find the correct ul container
    if (this.tryMicrosoftStyleInjection(menuElement, jiraOption)) return;
    
    // Fallback to generic strategies
    const separator = this.createMenuSeparator(menuElement);
    if (this.tryAppendWithSeparator(menuElement, separator, jiraOption)) return;
    if (this.tryInsertAfterSeparatorWithOption(menuElement, separator, jiraOption)) return;
    if (this.tryPrependWithSeparator(menuElement, jiraOption, separator)) return;
    if (this.tryListContainerWithSeparator(menuElement, separator, jiraOption)) return;
  }

  tryMicrosoftStyleInjection(menuElement, jiraOption) {
    // Look for the pattern: ul > li > button[role="menuitem"]
    const menuItems = menuElement.querySelectorAll('[role="menuitem"]');
    
    if (this.debug) console.debug('Microsoft style injection - found menu items:', menuItems.length);
    
    if (menuItems.length === 0) return false;
    
    // Find the ul that contains the menu items
    const firstMenuItem = menuItems[0];
    const menuItemsContainer = firstMenuItem.closest('ul');
    
    if (this.debug) console.debug('Microsoft style injection - menu container:', menuItemsContainer);
    
    if (!menuItemsContainer) return false;
    
    try {
      // Add a subtle separator before our option
      const separator = this.createMicrosoftStyleSeparator();
      
      // If we created a li element (Microsoft style), inject it directly
      if (jiraOption.tagName === 'LI') {
        if (this.debug) console.debug('Microsoft style injection - injecting LI element directly');
        menuItemsContainer.appendChild(separator);
        menuItemsContainer.appendChild(jiraOption);
        return true;
      } else {
        if (this.debug) console.debug('Microsoft style injection - wrapping in LI element');
        // Wrap in li if needed
        const li = document.createElement('li');
        li.role = 'presentation';
        const parentLi = firstMenuItem.closest('li');
        li.className = parentLi ? parentLi.className : '';
        li.appendChild(jiraOption);
        menuItemsContainer.appendChild(separator);
        menuItemsContainer.appendChild(li);
        return true;
      }
    } catch (e) {
      if (this.debug) console.debug('Microsoft style injection failed:', e);
      return false;
    }
  }

  createMicrosoftStyleSeparator() {
    const separatorLi = document.createElement('li');
    separatorLi.role = 'presentation';
    separatorLi.className = 'jira-menu-separator-li';
    
    const separatorDiv = document.createElement('div');
    separatorDiv.style.cssText = `
      height: 1px;
      background-color: rgba(0, 0, 0, 0.1);
      margin: 4px 12px;
      opacity: 0.6;
    `;
    
    separatorLi.appendChild(separatorDiv);
    return separatorLi;
  }

  tryAppendWithSeparator(menuElement, separator, jiraOption) {
    try {
      menuElement.appendChild(separator);
      menuElement.appendChild(jiraOption);
      return true;
    } catch (e) {
      // Clean up if partial success
      try { separator.remove(); } catch {}
      try { jiraOption.remove(); } catch {}
      return false;
    }
  }

  tryInsertAfterSeparatorWithOption(menuElement, separator, jiraOption) {
    const separators = menuElement.querySelectorAll('hr, .separator, .divider, [role="separator"]');
    if (separators.length > 0) {
      try {
        separators[0].after(separator);
        separator.after(jiraOption);
        return true;
      } catch (e) {
        try { separator.remove(); } catch {}
        try { jiraOption.remove(); } catch {}
        return false;
      }
    }
    return false;
  }

  tryPrependWithSeparator(menuElement, jiraOption, separator) {
    try {
      menuElement.insertBefore(jiraOption, menuElement.firstChild);
      jiraOption.after(separator);
      return true;
    } catch (e) {
      try { separator.remove(); } catch {}
      try { jiraOption.remove(); } catch {}
      return false;
    }
  }

  tryListContainerWithSeparator(menuElement, separator, jiraOption) {
    const listContainer = menuElement.querySelector('ul, ol, [role="menu"], .menu-items');
    if (listContainer) {
      try {
        listContainer.appendChild(separator);
        listContainer.appendChild(jiraOption);
        return true;
      } catch (e) {
        try { separator.remove(); } catch {}
        try { jiraOption.remove(); } catch {}
        return false;
      }
    }
    return false;
  }

  createMenuSeparator(menuElement) {
    const separator = document.createElement('div');
    separator.className = 'jira-menu-separator';
    
    // Try to find existing separators to match their style
    const existingSeparators = menuElement.querySelectorAll('hr, .separator, .divider, [role="separator"]');
    
    if (existingSeparators.length > 0) {
      const sampleSeparator = existingSeparators[0];
      const sampleStyles = window.getComputedStyle(sampleSeparator);
      
      Object.assign(separator.style, {
        height: sampleStyles.height || '1px',
        backgroundColor: sampleStyles.backgroundColor || 'rgba(0, 0, 0, 0.1)',
        margin: sampleStyles.margin || '4px 0',
        width: '100%',
        border: sampleStyles.border,
        borderTop: sampleStyles.borderTop,
        borderBottom: sampleStyles.borderBottom
      });
    } else {
      // Fallback separator style
      const bodyStyles = window.getComputedStyle(document.body);
      const isDarkTheme = bodyStyles.backgroundColor && this.isColorDark(bodyStyles.backgroundColor);
      
      Object.assign(separator.style, {
        height: '1px',
        backgroundColor: isDarkTheme ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.1)',
        margin: '4px 0',
        width: '100%'
      });
    }
    
    return separator;
  }



  hideAllMenus() {
    // Hide our custom menu
    this.hideContextMenu();
    
    // Clean up any injected menu items
    this.cleanupInjectedOptions();
    
    // Try to hide common custom menus by clicking elsewhere
    document.body.click();
  }

  cleanupInjectedOptions() {
    // Remove all injected Jira options and separators
    document.querySelectorAll('.jira-injected-option, .jira-menu-separator, .jira-menu-separator-li').forEach(element => {
      try {
        element.remove();
      } catch (e) {
        // Ignore removal errors
      }
    });
    
    // Also remove any parent containers we might have created
    document.querySelectorAll('[data-jira-issue]').forEach(element => {
      try {
        // Remove the entire li container if it's one of ours
        const li = element.closest('li');
        if (li && li.querySelector('.jira-injected-option')) {
          li.remove();
        }
      } catch (e) {
        // Ignore removal errors
      }
    });
  }

  getSelectedText() {
    const selection = window.getSelection();
    return selection.toString().trim();
  }

  findJiraIssueNearCursor(editableElement) {
    // Get text content from the editable element
    let text = '';
    if (editableElement.value !== undefined) {
      text = editableElement.value; // For input/textarea
    } else {
      text = editableElement.textContent || editableElement.innerText || '';
    }
    
    // Find all Jira issues in the text
    const matches = [...text.matchAll(this.JIRA_PATTERN)];
    
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0][0];
    
    // If multiple issues, try to find one near the cursor position
    try {
      const selection = window.getSelection();
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const cursorOffset = range.startOffset;
        
        // Find the closest issue to cursor position
        let closest = matches[0];
        let closestDistance = Math.abs(matches[0].index - cursorOffset);
        
        for (const match of matches) {
          const distance = Math.abs(match.index - cursorOffset);
          if (distance < closestDistance) {
            closest = match;
            closestDistance = distance;
          }
        }
        
        return closest[0];
      }
    } catch (e) {
      // Fallback to first issue if cursor detection fails
    }
    
    return matches[0][0];
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

  showContextMenu(x, y, issueId, options = {}) {
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

    // Position menu
    let finalX, finalY;
    
    if (options.centered) {
      // Center the context menu
      finalX = (viewport.width - menuRect.width) / 2 + window.scrollX;
      finalY = (viewport.height - menuRect.height) / 2 + window.scrollY;
    } else {
      // Position near click location
      finalX = x;
      finalY = y;

      if (x + menuRect.width > viewport.width) {
        finalX = x - menuRect.width;
      }

      if (y + menuRect.height > viewport.height) {
        finalY = y - menuRect.height;
      }
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
      this.showPopup(issueId, menuItem, { centered: true });
    });

    this.currentContextMenu = contextMenu;
  }

  hideContextMenu() {
    if (this.currentContextMenu) {
      this.currentContextMenu.remove();
      this.currentContextMenu = null;
    }
  }

  async showPopup(issueId, targetElement, options = {}) {
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
    if (options.centered) {
      this.centerPopup(this.currentPopup);
    } else {
      this.positionPopup(this.currentPopup, targetElement);
    }

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

  centerPopup(popup) {
    const popupRect = popup.getBoundingClientRect();
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight
    };

    // Center horizontally and vertically
    const left = (viewport.width - popupRect.width) / 2 + window.scrollX;
    const top = (viewport.height - popupRect.height) / 2 + window.scrollY;

    // Ensure minimum margins
    const finalLeft = Math.max(10, left);
    const finalTop = Math.max(10, top);

    popup.style.left = `${finalLeft}px`;
    popup.style.top = `${finalTop}px`;
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
    this.cleanupInjectedOptions();
    this.observer?.disconnect();
    this.observer = null;
    this.menuObserver?.disconnect();
    this.menuObserver = null;
  }
}

// Boot
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded',()=> new JiraIssueDetector());
} else {
  new JiraIssueDetector();
}
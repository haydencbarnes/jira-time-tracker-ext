// Common work-related terms dictionary organized by categories
const commonTerms = {
    // Development actions
    actions: [
        'implemented', 'fixed', 'debugged', 'tested', 'reviewed', 'refactored', 'optimized',
        'updated', 'added', 'removed', 'modified', 'improved', 'integrated', 'deployed',
        'created', 'designed', 'developed', 'configured', 'maintained', 'monitored',
        'troubleshot', 'resolved', 'patched', 'migrated', 'validated', 'verified'
    ],
    // Meeting types
    meetings: [
        'meeting', 'discussion', 'planning', 'review', 'standup', 'retrospective', 'sync',
        'workshop', 'presentation', 'demo', 'training', 'interview', 'consultation',
        'brainstorming', 'alignment', 'kickoff', 'handover', 'onboarding'
    ],
    // Task types
    tasks: [
        'investigation', 'analysis', 'documentation', 'research', 'configuration', 'setup',
        'maintenance', 'optimization', 'enhancement', 'implementation', 'integration',
        'testing', 'deployment', 'monitoring', 'support', 'coordination', 'planning'
    ],
    // Status indicators
    status: [
        'in progress', 'completed', 'blocked', 'waiting', 'pending', 'ongoing',
        'started', 'finished', 'reviewing', 'testing', 'deploying', 'planning',
        'investigating', 'debugging', 'analyzing', 'implementing'
    ],
    // Technical terms
    technical: [
        'bug', 'feature', 'api', 'database', 'server', 'client', 'interface',
        'backend', 'frontend', 'pipeline', 'workflow', 'service', 'module',
        'component', 'function', 'class', 'method', 'endpoint', 'repository'
    ],
    // Common work objects
    objects: [
        'code', 'data', 'tests', 'docs', 'review', 'changes', 'updates',
        'fixes', 'improvements', 'features', 'requirements', 'specifications',
        'documentation', 'solution', 'implementation', 'architecture'
    ]
};

class WorklogSuggestions {
    constructor() {
        // Flatten common terms for faster lookup
        this.commonTermsSet = new Set(
            Object.values(commonTerms).flat()
        );
        
        // Initialize learned words with size limit
        this.maxLearnedWords = 500; // Limit learned words to prevent memory issues
        this.learnedWords = new Set();
        this.wordUsageCount = new Map(); // Track word usage for pruning
        this.loadLearnedWords();
    }

    loadLearnedWords() {
        try {
            const saved = localStorage.getItem('worklogLearnedWords');
            if (saved) {
                const data = JSON.parse(saved);
                this.learnedWords = new Set(data.words || []);
                this.wordUsageCount = new Map(data.usage || []);
            }
        } catch (error) {
            console.warn('Error loading learned words:', error);
            this.learnedWords = new Set();
            this.wordUsageCount = new Map();
        }
    }

    saveLearnedWords() {
        try {
            const data = {
                words: [...this.learnedWords],
                usage: [...this.wordUsageCount]
            };
            localStorage.setItem('worklogLearnedWords', JSON.stringify(data));
        } catch (error) {
            console.warn('Error saving learned words:', error);
        }
    }

    pruneLearnedWords() {
        if (this.learnedWords.size <= this.maxLearnedWords) return;

        // Sort words by usage count and keep only the most used ones
        const sortedWords = [...this.wordUsageCount.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, this.maxLearnedWords)
            .map(([word]) => word);

        this.learnedWords = new Set(sortedWords);
        
        // Clean up usage counts
        const newUsageCount = new Map();
        sortedWords.forEach(word => {
            newUsageCount.set(word, this.wordUsageCount.get(word));
        });
        this.wordUsageCount = newUsageCount;
    }

    learnFromText(text) {
        // Split text into words, normalize and filter
        const words = text.toLowerCase()
            .split(/\s+/)
            .filter(word => 
                word.length > 3 && // Ignore short words
                !word.match(/^\d+$/) && // Ignore numbers
                !this.commonTermsSet.has(word) && // Don't learn common terms
                word.match(/^[a-z]+$/i) // Only learn simple words
            );

        // Update learned words and usage counts
        words.forEach(word => {
            this.learnedWords.add(word);
            this.wordUsageCount.set(
                word,
                (this.wordUsageCount.get(word) || 0) + 1
            );
        });

        this.pruneLearnedWords();
        this.saveLearnedWords();
    }

    getSuggestions(partialWord) {
        if (!partialWord || partialWord.length < 2) return [];
        
        const searchTerm = partialWord.toLowerCase();
        const maxSuggestions = 5;
        const suggestions = new Set();

        // First check common terms (prioritize these)
        for (const category of Object.values(commonTerms)) {
            for (const term of category) {
                if (term.toLowerCase().startsWith(searchTerm)) {
                    suggestions.add(term);
                    if (suggestions.size >= maxSuggestions) {
                        return [...suggestions];
                    }
                }
            }
        }

        // Then check learned words
        for (const word of this.learnedWords) {
            if (word.startsWith(searchTerm)) {
                suggestions.add(word);
                if (suggestions.size >= maxSuggestions) break;
            }
        }

        return [...suggestions];
    }

    recordUsage(word) {
        if (this.learnedWords.has(word)) {
            this.wordUsageCount.set(
                word,
                (this.wordUsageCount.get(word) || 0) + 1
            );
            this.saveLearnedWords();
        }
    }
}

// Initialize suggestions system
const worklogSuggestions = new WorklogSuggestions();

function initializeWorklogSuggestions(input) {
    // Accept either an element or an ID
    const inputElement = typeof input === 'string' ? document.getElementById(input) : input;
    
    if (!inputElement) {
        console.error('Input element not found');
        return;
    }

    const completionElement = document.createElement('div');
    completionElement.className = 'suggestion-completion';
    
    // Apply inline styles to ensure visibility in dark mode
    completionElement.style.position = 'absolute';
    completionElement.style.left = '0';
    completionElement.style.top = '0';
    completionElement.style.width = '100%';
    completionElement.style.height = '100%';
    completionElement.style.pointerEvents = 'none';
    
    // Match the exact styling of the input element
    const computedStyle = window.getComputedStyle(inputElement);
    completionElement.style.padding = computedStyle.padding;
    completionElement.style.boxSizing = computedStyle.boxSizing;
    completionElement.style.fontSize = computedStyle.fontSize;
    completionElement.style.fontFamily = computedStyle.fontFamily;
    completionElement.style.lineHeight = computedStyle.lineHeight;
    completionElement.style.letterSpacing = computedStyle.letterSpacing;
    completionElement.style.wordSpacing = computedStyle.wordSpacing;
    
    completionElement.style.background = 'transparent';
    completionElement.style.border = '1px solid transparent';
    completionElement.style.zIndex = '0';
    completionElement.style.resize = 'none';
    completionElement.style.whiteSpace = 'pre-wrap';
    completionElement.style.overflow = 'hidden';
    completionElement.style.margin = '0';
    
    // Set color based on dark mode
    const isDarkMode = document.body.classList.contains('dark-mode');
    completionElement.style.color = isDarkMode ? '#666' : '#999';
    
    inputElement.parentNode.insertBefore(completionElement, inputElement);
    
    let originalValue = '';
    let suggestionActive = false;

    function updateSuggestionColor() {
        const isDarkMode = document.body.classList.contains('dark-mode');
        completionElement.style.color = isDarkMode ? '#666' : '#999';
    }

    function updateSuggestions() {
        updateSuggestionColor(); // Ensure color is correct
        
        const cursorPos = inputElement.selectionStart;
        const text = inputElement.value;
        
        // Don't show suggestions if cursor is not at the end
        if (cursorPos !== text.length) {
            suggestionActive = false;
            completionElement.textContent = '';
            return;
        }

        const words = text.split(/\s+/);
        const currentWord = words[words.length - 1] || '';
        
        if (!currentWord || currentWord.length < 2) {
            suggestionActive = false;
            completionElement.textContent = '';
            return;
        }

        // Get suggestions
        const suggestions = worklogSuggestions.getSuggestions(currentWord);
        
        if (suggestions.length > 0) {
            const suggestion = suggestions[0];
            if (suggestion.toLowerCase().startsWith(currentWord.toLowerCase())) {
                const completion = suggestion.slice(currentWord.length);
                if (completion) {
                    originalValue = text;
                    const prefix = text.slice(0, text.length - currentWord.length);
                    const fullSuggestion = prefix + currentWord + completion;
                    completionElement.textContent = fullSuggestion;
                    suggestionActive = true;
                    return;
                }
            }
        }
        
        completionElement.textContent = '';
        suggestionActive = false;
    }

    // Handle special keys
    inputElement.addEventListener('keydown', (e) => {
        if (suggestionActive) {
            if (e.key === 'Tab') {
                e.preventDefault();
                inputElement.value = completionElement.textContent;
                suggestionActive = false;
                completionElement.textContent = '';
                // Move cursor to end
                const length = inputElement.value.length;
                inputElement.setSelectionRange(length, length);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                inputElement.value = originalValue;
                suggestionActive = false;
                completionElement.textContent = '';
            } else if (e.key === 'Backspace') {
                // Clear the suggestion and let backspace work on the original text
                inputElement.value = originalValue;
                suggestionActive = false;
                completionElement.textContent = '';
                // Let the backspace event continue to remove one character
            } else {
                // For any other key press while suggestion is active, accept the suggestion
                suggestionActive = false;
                completionElement.textContent = '';
            }
        }
    });

    // Handle input changes
    inputElement.addEventListener('input', () => {
        if (!suggestionActive) {
            updateSuggestions();
        }
    });

    // Handle focus loss
    inputElement.addEventListener('blur', () => {
        if (suggestionActive) {
            inputElement.value = originalValue;
            suggestionActive = false;
            completionElement.textContent = '';
        }
        // Learn from the input when it loses focus
        if (inputElement.value) {
            worklogSuggestions.learnFromText(inputElement.value);
        }
    });
} 
"use strict";
(() => {
  // src/ts/shared/dom-utils.ts
  function getRequiredElement(id) {
    const element = document.getElementById(id);
    if (!element) {
      throw new Error(`Missing required element: ${id}`);
    }
    return element;
  }

  // src/ts/options.ts
  function getRequiredSelector(selector) {
    const element = document.querySelector(selector);
    if (!element) {
      throw new Error(`Missing required element: ${selector}`);
    }
    return element;
  }
  function getSyncStorage(defaults) {
    return new Promise((resolve) => {
      chrome.storage.sync.get(defaults, (items) => resolve(items));
    });
  }
  function setSyncStorage(items) {
    return new Promise((resolve) => {
      chrome.storage.sync.set(items, () => resolve());
    });
  }
  (function initOptionsPage() {
    const saveButton = getRequiredElement("save");
    const versionInput = getRequiredElement("version");
    const experimentalFeaturesToggle = getRequiredElement(
      "experimentalFeatures"
    );
    const issueDetectionToggle = getRequiredElement(
      "issueDetectionToggle"
    );
    const experimentalSlider = getRequiredSelector(
      "#experimentalFeatures + .slider"
    );
    const jiraTypeSelect = getRequiredElement("jiraType");
    const urlRow = getRequiredElement("urlRow");
    const baseUrlInput = getRequiredElement("baseUrl");
    const systemThemeToggle = getRequiredElement("systemThemeToggle");
    const sidePanelToggle = getRequiredElement("sidePanelToggle");
    const sidePanelRow = getRequiredElement("sidePanelRow");
    const floatingTimerWidgetToggle = getRequiredElement(
      "floatingTimerWidgetToggle"
    );
    const floatingTimerWidgetRow = getRequiredElement(
      "floatingTimerWidgetRow"
    );
    const usernameInput = getRequiredElement("username");
    const passwordInput = getRequiredElement("password");
    const frequentWorklogDescription1Input = getRequiredElement(
      "frequentWorklogDescription1"
    );
    const frequentWorklogDescription2Input = getRequiredElement(
      "frequentWorklogDescription2"
    );
    const defaultPageSelect = getRequiredElement("defaultPage");
    const statusElement = getRequiredElement("status");
    document.addEventListener("DOMContentLoaded", restoreOptions);
    document.addEventListener("DOMContentLoaded", () => {
      versionInput.value = chrome.runtime.getManifest().version;
    });
    saveButton.addEventListener("click", saveOptions);
    initThemeControls();
    createExperimentalShapes();
    experimentalFeaturesToggle.addEventListener(
      "change",
      onExperimentalToggleChange
    );
    jiraTypeSelect.addEventListener("change", onJiraTypeChange);
    function createExperimentalShapes() {
      const shapeCount = 15;
      const shapes = ["circle", "square", "triangle"];
      for (let i = 0; i < shapeCount; i += 1) {
        const shape = document.createElement("div");
        shape.className = `shape ${shapes[Math.floor(Math.random() * shapes.length)]}`;
        shape.style.left = `${Math.random() * 130 - 15}%`;
        shape.style.top = `${Math.random() * 130 - 15}%`;
        shape.style.width = `${Math.random() * 5 + 2}px`;
        shape.style.height = shape.style.width;
        shape.style.backgroundColor = `hsl(${Math.random() * 360}, 100%, 75%)`;
        shape.style.animation = `float ${Math.random() * 2 + 1}s infinite ease-in-out`;
        experimentalSlider.appendChild(shape);
      }
    }
    function updateThemeButton(themeToggle, isDark) {
      const iconSpan = themeToggle.querySelector(".icon");
      if (!iconSpan) return;
      if (isDark) {
        iconSpan.textContent = "☀️";
        themeToggle.title = "Switch to light mode";
      } else {
        iconSpan.textContent = "🌙";
        themeToggle.title = "Switch to dark mode";
      }
    }
    function setTheme(themeToggle, isDark) {
      updateThemeButton(themeToggle, isDark);
      document.body.classList.toggle("dark-mode", isDark);
    }
    function applyTheme(themeToggle, followSystem, manualDark) {
      if (followSystem) {
        const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
        setTheme(themeToggle, mediaQuery.matches);
        mediaQuery.onchange = (event) => setTheme(themeToggle, event.matches);
        window._systemThemeListener = mediaQuery;
        return;
      }
      if (window._systemThemeListener) {
        window._systemThemeListener.onchange = null;
        window._systemThemeListener = null;
      }
      setTheme(themeToggle, manualDark);
    }
    function initThemeControls() {
      document.addEventListener("DOMContentLoaded", async () => {
        const themeToggle = getRequiredElement("themeToggle");
        const themeSettings = await getSyncStorage({
          followSystemTheme: true,
          darkMode: false
        });
        const followSystem = themeSettings.followSystemTheme !== false;
        const manualDark = themeSettings.darkMode === true;
        applyTheme(themeToggle, followSystem, manualDark);
        systemThemeToggle.checked = followSystem;
        themeToggle.addEventListener("click", async () => {
          const isDark = !document.body.classList.contains("dark-mode");
          setTheme(themeToggle, isDark);
          await setSyncStorage({ darkMode: isDark, followSystemTheme: false });
          systemThemeToggle.checked = false;
        });
        systemThemeToggle.addEventListener("change", async () => {
          const nextFollowSystem = systemThemeToggle.checked;
          await setSyncStorage({ followSystemTheme: nextFollowSystem });
          const latestTheme = await getSyncStorage({
            darkMode: false
          });
          applyTheme(
            themeToggle,
            nextFollowSystem,
            latestTheme.darkMode === true
          );
        });
        chrome.storage.onChanged.addListener((changes, namespace) => {
          if (namespace === "sync" && ("followSystemTheme" in changes || "darkMode" in changes)) {
            void getSyncStorage({
              followSystemTheme: true,
              darkMode: false
            }).then((latestThemeSettings) => {
              const latestFollowSystem = latestThemeSettings.followSystemTheme !== false;
              const latestManualDark = latestThemeSettings.darkMode === true;
              applyTheme(themeToggle, latestFollowSystem, latestManualDark);
              systemThemeToggle.checked = latestFollowSystem;
            });
          }
        });
      });
    }
    function onExperimentalToggleChange() {
      const isEnabled = experimentalFeaturesToggle.checked;
      experimentalSlider.querySelectorAll(".shape").forEach((shape) => {
        shape.style.opacity = isEnabled ? "1" : "0";
      });
      sidePanelRow.style.display = isEnabled ? "table-row" : "none";
      floatingTimerWidgetRow.style.display = isEnabled ? "table-row" : "none";
      if (!isEnabled) {
        sidePanelToggle.checked = false;
        floatingTimerWidgetToggle.checked = false;
        chrome.storage.sync.set({
          sidePanelEnabled: false,
          floatingTimerWidgetEnabled: false
        });
      }
    }
    function onJiraTypeChange() {
      const urlLabel = urlRow.querySelector("td:first-child b");
      if (jiraTypeSelect.value === "server") {
        baseUrlInput.placeholder = "https://your-jira-server.com";
        if (urlLabel) {
          urlLabel.textContent = "Jira Server URL*";
        }
      } else {
        baseUrlInput.placeholder = "https://your-domain.atlassian.net";
        if (urlLabel) {
          urlLabel.textContent = "Jira Cloud URL*";
        }
      }
    }
    async function notifyTabs(message) {
      const tabs = await chrome.tabs.query({});
      tabs.forEach((tab) => {
        if (typeof tab.id !== "number") {
          return;
        }
        chrome.tabs.sendMessage(tab.id, message, () => {
          if (chrome.runtime.lastError) {
          }
        });
      });
    }
    async function saveOptions() {
      const experimentalFeatures = experimentalFeaturesToggle.checked;
      const issueDetectionEnabled = issueDetectionToggle.checked;
      const sidePanelEnabled = experimentalFeatures && sidePanelToggle.checked;
      const floatingTimerWidgetEnabled = experimentalFeatures && floatingTimerWidgetToggle.checked;
      await setSyncStorage({
        jiraType: jiraTypeSelect.value,
        username: usernameInput.value,
        apiToken: passwordInput.value,
        baseUrl: baseUrlInput.value,
        experimentalFeatures,
        issueDetectionEnabled,
        frequentWorklogDescription1: frequentWorklogDescription1Input.value,
        frequentWorklogDescription2: frequentWorklogDescription2Input.value,
        defaultPage: defaultPageSelect.value,
        sidePanelEnabled,
        floatingTimerWidgetEnabled
      });
      await notifyTabs({
        type: "SETTINGS_CHANGED",
        experimentalFeatures,
        issueDetectionEnabled,
        floatingTimerWidgetEnabled
      });
      statusElement.textContent = "Options saved.";
      window.setTimeout(() => {
        statusElement.textContent = "";
      }, 1e3);
    }
    async function restoreOptions() {
      const items = await getSyncStorage({
        jiraType: "cloud",
        username: "",
        apiToken: "",
        baseUrl: "",
        experimentalFeatures: false,
        issueDetectionEnabled: true,
        frequentWorklogDescription1: "",
        frequentWorklogDescription2: "",
        defaultPage: "popup.html",
        followSystemTheme: true,
        sidePanelEnabled: false,
        floatingTimerWidgetEnabled: false,
        darkMode: false
      });
      jiraTypeSelect.value = items.jiraType;
      usernameInput.value = items.username;
      passwordInput.value = items.apiToken;
      baseUrlInput.value = items.baseUrl;
      experimentalFeaturesToggle.checked = items.experimentalFeatures ?? false;
      issueDetectionToggle.checked = items.issueDetectionEnabled !== false;
      frequentWorklogDescription1Input.value = items.frequentWorklogDescription1;
      frequentWorklogDescription2Input.value = items.frequentWorklogDescription2;
      defaultPageSelect.value = items.defaultPage;
      systemThemeToggle.checked = items.followSystemTheme;
      sidePanelRow.style.display = items.experimentalFeatures ? "table-row" : "none";
      sidePanelToggle.checked = !!(items.experimentalFeatures && items.sidePanelEnabled);
      floatingTimerWidgetRow.style.display = items.experimentalFeatures ? "table-row" : "none";
      floatingTimerWidgetToggle.checked = !!(items.experimentalFeatures && items.floatingTimerWidgetEnabled);
      jiraTypeSelect.dispatchEvent(new Event("change"));
    }
  })();
})();

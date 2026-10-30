export const DEFAULT_SETTINGS = {
  fontSize: 'medium',
  autoScroll: true,
  theme: 'light',
  selectedMicId: '',
  englishDialect: 'en-US',
  speechEngine: 'web-speech',
  translationEngine: 'google-gtx',
  geminiApiKey: '',
  showEnglishParallel: false,
  saveHistoryToDisk: false
};

export async function loadSettings() {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
        resolve({ ...DEFAULT_SETTINGS, ...stored });
      });
    } else {

      const local = localStorage.getItem('nghegiang_settings');
      resolve(local ? { ...DEFAULT_SETTINGS, ...JSON.parse(local) } : DEFAULT_SETTINGS);
    }
  });
}

export async function saveSettings(updates) {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set(updates, () => {
        resolve();
      });
    } else {
      const current = localStorage.getItem('nghegiang_settings');
      const merged = { ...(current ? JSON.parse(current) : DEFAULT_SETTINGS), ...updates };
      localStorage.setItem('nghegiang_settings', JSON.stringify(merged));
      resolve();
    }
  });
}

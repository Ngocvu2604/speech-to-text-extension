function setupSidePanelBehavior() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error) => console.warn('[NgheGiang] Cấu hình SidePanel behavior:', error));
  }
}

chrome.runtime.onInstalled.addListener(() => {
  setupSidePanelBehavior();
});

chrome.runtime.onStartup.addListener(() => {
  setupSidePanelBehavior();
});

setupSidePanelBehavior();

chrome.action.onClicked.addListener(async (tab) => {
  if (chrome.sidePanel && chrome.sidePanel.open) {
    try {
      if (tab?.windowId) {
        await chrome.sidePanel.open({ windowId: tab.windowId });
      }
    } catch (err) {
      console.warn('[NgheGiang] Không thể mở side panel bằng action.onClicked:', err);
    }
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  if (request.action === 'OPEN_POPOUT_WINDOW') {
    const popoutUrl = chrome.runtime.getURL('sidepanel.html?popout=true');
    chrome.windows.create({
      url: popoutUrl,
      type: 'popup',
      width: 480,
      height: 720,
      top: 100,
      left: 100
    }).then((win) => {
      sendResponse({ success: true, windowId: win.id });
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (request.action === 'OPEN_PERMISSION_TAB') {
    const permUrl = chrome.runtime.getURL('permission.html');
    chrome.tabs.create({ url: permUrl }).then((tab) => {
      sendResponse({ success: true, tabId: tab.id });
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

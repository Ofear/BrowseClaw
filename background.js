// BrowseClaw Background Service Worker
// Handles side panel setup, content script injection, and screenshot capture

// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Failed to set panel behavior:', error));

// ─── Message Handler ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'ensureContentScript') {
    injectContentScript(message.tabId)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'captureScreenshot') {
    chrome.tabs.captureVisibleTab(null, {
      format: message.format || 'jpeg',
      quality: message.quality || 75
    })
      .then((dataUrl) => sendResponse({ success: true, dataUrl }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'tabAction') {
    handleTabAction(message).then(sendResponse).catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'getFrameIds') {
    chrome.webNavigation.getAllFrames({ tabId: message.tabId }, (frames) => {
      sendResponse(frames || []);
    });
    return true;
  }
});

async function handleTabAction({ tabAction, params }) {
  switch (tabAction) {
    case 'list_tabs': {
      const tabs = await chrome.tabs.query({});
      return { success: true, data: tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active })) };
    }
    case 'switch_tab': {
      await chrome.tabs.update(params.tabId, { active: true });
      return { success: true };
    }
    case 'open_tab': {
      const tab = await chrome.tabs.create({ url: params.url });
      return { success: true, data: { id: tab.id } };
    }
    case 'close_tab': {
      await chrome.tabs.remove(params.tabId);
      return { success: true };
    }
    default:
      throw new Error(`Unknown tab action: ${tabAction}`);
  }
}

// ─── Content Script Re-injection on Navigation ─────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && !tab.url.startsWith('chrome://')) {
    injectContentScript(tabId).catch(() => {});
  }
});

// ─── Content Script Injection ───────────────────────────────────────────────────
async function injectContentScript(tabId) {
  try {
    const results = await chrome.tabs.sendMessage(tabId, { action: 'ping' }).catch(() => null);
    if (results?.pong) return;
  } catch {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  } catch (err) {
    if (!err.message.includes('Cannot access')) {
      console.warn('Failed to inject content script:', err);
    }
  }
}

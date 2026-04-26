import { fetchMyPRs } from './github.js';
import { computeDiff, annotatePRRole, buildTabEntry } from './state.js';
import { findGroup, createGroup, addTabToGroup, removeTabSafely, ensureTabInGroup, resolveWindowForGroup } from './tabgroup.js';

const ALARM_NAME = 'pr-sync';

// ── Startup ───────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

async function setup() {
  const { authToken, refreshIntervalMinutes = 5 } =
    await chrome.storage.local.get(['authToken', 'refreshIntervalMinutes']);
  if (!authToken) return;
  // Clear then recreate so interval changes take effect immediately
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 0,
    periodInMinutes: Number(refreshIntervalMinutes),
  });
}

// ── Alarm ─────────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) sync();
});

// ── Messages from popup ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from this extension's own pages (popup, options)
  if (sender.id !== chrome.runtime.id) return;
  if (msg.type === 'sync') {
    sync().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true; // keep message channel open for async response
  }
  if (msg.type === 'setup') {
    setup().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
});

// ── Tab lifecycle listeners ───────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { tabState = {} } = await chrome.storage.local.get('tabState');
  const url = Object.keys(tabState).find(u => tabState[u].tabId === tabId);
  if (!url) return;
  delete tabState[url];
  await chrome.storage.local.set({ tabState });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const { tabState = {} } = await chrome.storage.local.get('tabState');
  const url = Object.keys(tabState).find(u => tabState[u].tabId === tabId);
  if (!url) return;
  const base = url.split('?')[0];
  if (!changeInfo.url.startsWith(base)) {
    delete tabState[url];
    await chrome.storage.local.set({ tabState });
  }
});

// ── Core sync ─────────────────────────────────────────────────────────────────

async function sync() {
  const { authToken, username, groupId: storedGroupId, tabState = {}, customFilter = '' } =
    await chrome.storage.local.get(['authToken', 'username', 'groupId', 'tabState', 'customFilter']);

  if (!authToken) return;

  try {
    const rawPRs = await fetchMyPRs(authToken, username, customFilter);
    const prs = rawPRs.map(pr => annotatePRRole(pr, username));
    const { newPRs, closedUrls } = computeDiff(prs, tabState);

    // Validate / locate existing group
    const group = await findGroup(storedGroupId);
    let groupId = group?.id ?? null;
    const windowId = await resolveWindowForGroup(group);

    // Close tabs for merged/closed PRs
    for (const url of closedUrls) {
      const entry = tabState[url];
      if (entry) {
        await removeTabSafely(entry.tabId, url);
        delete tabState[url];
      }
    }

    // Open tabs for new PRs
    for (const pr of newPRs) {
      if (groupId == null) {
        // First PR — create the tab and group it
        const tab = await chrome.tabs.create({ url: pr.html_url, windowId, active: false });
        groupId = await createGroup(tab.id, windowId);
        tabState[pr.html_url] = buildTabEntry(pr, tab.id, windowId);
      } else {
        const tabId = await addTabToGroup(pr.html_url, groupId, windowId);
        tabState[pr.html_url] = buildTabEntry(pr, tabId, windowId);
      }
    }

    // Re-group any tracked tabs the user dragged out of the group
    if (groupId != null) {
      for (const entry of Object.values(tabState)) {
        await ensureTabInGroup(entry.tabId, groupId);
      }
    }

    await chrome.storage.local.set({
      tabState,
      groupId,
      lastSyncedAt: Date.now(),
      lastError: null,
    });

    await chrome.action.setBadgeText({ text: '' });

  } catch (err) {
    const code = err.code || 'UNKNOWN';
    await chrome.storage.local.set({ lastError: code });

    if (code === 'UNAUTHORIZED') {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#e84040' });
    } else if (code === 'RATE_LIMITED') {
      await chrome.action.setBadgeText({ text: '⏱' });
      await chrome.action.setBadgeBackgroundColor({ color: '#e09020' });
    }
  }
}

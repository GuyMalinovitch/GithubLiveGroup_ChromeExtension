import { fetchMyPRs, fetchTeamPRs } from './github.js';
import { computeDiff, annotatePRRole, annotateTeamPRRole, buildTabEntry } from './state.js';
import { findGroup, createGroup, addTabToGroup, removeTabSafely, ensureTabInGroup, resolveWindowForGroup } from './tabgroup.js';
import { pollOnce } from './auth.js';

const ALARM_NAME = 'pr-sync';
const AUTH_ALARM_NAME = 'auth-poll';

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
  if (alarm.name === AUTH_ALARM_NAME) pollAuthAlarm();
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
  if (msg.type === 'startAuthPoll') {
    startAuthPoll().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
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

// ── OAuth Device Flow (background polling fallback) ───────────────────────────

/** Start a 1-minute repeating alarm to poll for an OAuth token in the background. */
async function startAuthPoll() {
  await chrome.alarms.clear(AUTH_ALARM_NAME);
  await chrome.alarms.create(AUTH_ALARM_NAME, { delayInMinutes: 1, periodInMinutes: 1 });
}

/**
 * Called by the auth-poll alarm every minute.
 * If pendingAuth is in storage, poll GitHub once. On success store the token and
 * kick off setup; on terminal failure clear pendingAuth and cancel the alarm.
 */
async function pollAuthAlarm() {
  const { pendingAuth } = await chrome.storage.local.get('pendingAuth');
  if (!pendingAuth) {
    await chrome.alarms.clear(AUTH_ALARM_NAME);
    return;
  }

  // Bail out if the device code has expired
  if (Date.now() > pendingAuth.expiresAt) {
    await chrome.storage.local.remove('pendingAuth');
    await chrome.alarms.clear(AUTH_ALARM_NAME);
    return;
  }

  try {
    const result = await pollOnce(pendingAuth.device_code);
    if (result.status === 'ok') {
      const { getAuthenticatedUser } = await import('./github.js');
      const username = await getAuthenticatedUser(result.token);
      await chrome.storage.local.set({ authToken: result.token, username, authType: 'oauth' });
      await chrome.storage.local.remove('pendingAuth');
      await chrome.alarms.clear(AUTH_ALARM_NAME);
      await setup();
    } else if (result.status === 'expired' || result.status === 'denied') {
      await chrome.storage.local.remove('pendingAuth');
      await chrome.alarms.clear(AUTH_ALARM_NAME);
    }
    // 'pending' and 'slow_down' → do nothing, alarm fires again next minute
  } catch {
    // Network error — try again next alarm tick
  }
}

// ── Core sync ─────────────────────────────────────────────────────────────────

let syncInFlight = false;

function parseTeamUsernames(raw, selfUsername) {
  const normalizedRaw = typeof raw === 'string' ? raw : '';
  const selfUsernameLower = typeof selfUsername === 'string' ? selfUsername.toLowerCase() : '';
  const seen = new Set();
  return normalizedRaw
    .split(',')
    .map(u => u.trim().replace(/^@/, ''))
    .filter(u => {
      if (!u || u.toLowerCase() === selfUsernameLower) return false;
      const lower = u.toLowerCase();
      if (seen.has(lower)) return false;
      seen.add(lower);
      return true;
    });
}

async function tabStillExists(tabId) {
  if (tabId == null) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function sync() {
  if (syncInFlight) return;
  syncInFlight = true;
  try {
    await _sync();
  } finally {
    syncInFlight = false;
  }
}

async function _sync() {
  const { authToken, username, groupId: storedGroupId, teamGroupId: storedTeamGroupId, tabState = {}, customFilter = '', teamUsernames: rawTeamUsernames = '' } =
    await chrome.storage.local.get(['authToken', 'username', 'groupId', 'teamGroupId', 'tabState', 'customFilter', 'teamUsernames']);

  if (!authToken) return;

  try {
    const teamUsernames = parseTeamUsernames(rawTeamUsernames, username);
    const rawMyPRs = await fetchMyPRs(authToken, username, customFilter);
    const myPRs = rawMyPRs.map(pr => annotatePRRole(pr, username));

    let teamPRs = [];
    if (teamUsernames.length > 0) {
      try {
        const rawTeamPRs = await fetchTeamPRs(authToken, teamUsernames, customFilter);
        const myUrls = new Set(myPRs.map(pr => pr.html_url));
        teamPRs = rawTeamPRs
          .filter(pr => !myUrls.has(pr.html_url))
          .map(pr => annotateTeamPRRole(pr));
      } catch {
        // Non-fatal: preserve existing team tabs so they aren't closed on transient failure
        teamPRs = Object.entries(tabState)
          .filter(([, entry]) => entry.role === 'team')
          .map(([url, entry]) => ({ html_url: url, role: 'team', author: entry.author }));
      }
    }

    const allPRs = [...myPRs, ...teamPRs];
    const prByUrl = new Map(allPRs.map(pr => [pr.html_url, pr]));

    // Validate / locate existing groups
    const group = await findGroup(storedGroupId);
    let groupId = group?.id ?? null;

    const teamGroup = await findGroup(storedTeamGroupId);
    let teamGroupId = teamGroup?.id ?? null;

    const windowId = await resolveWindowForGroup(group ?? teamGroup);

    // If a group no longer exists, only clear entries whose tabs are actually gone
    if (groupId == null) {
      for (const [key, entry] of Object.entries(tabState)) {
        if (entry.role !== 'team' && !(await tabStillExists(entry.tabId))) {
          delete tabState[key];
        }
      }
    }
    if (teamGroupId == null) {
      for (const [key, entry] of Object.entries(tabState)) {
        if (entry.role === 'team' && !(await tabStillExists(entry.tabId))) {
          delete tabState[key];
        }
      }
    }

    const { newPRs, closedUrls } = computeDiff(allPRs, tabState);

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
      if (pr.role === 'team') {
        if (teamGroupId == null) {
          const tab = await chrome.tabs.create({ url: pr.html_url, windowId, active: false });
          teamGroupId = await createGroup(tab.id, windowId, 'Team PRs', 'green');
          tabState[pr.html_url] = buildTabEntry(pr, tab.id, windowId);
        } else {
          const tabId = await addTabToGroup(pr.html_url, teamGroupId, windowId);
          tabState[pr.html_url] = buildTabEntry(pr, tabId, windowId);
        }
      } else {
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
    }

    // Reconcile metadata (role, author) for all retained entries
    for (const [url, entry] of Object.entries(tabState)) {
      const pr = prByUrl.get(url);
      if (pr) tabState[url] = buildTabEntry(pr, entry.tabId, entry.windowId);
    }

    // Re-group any tracked tabs the user dragged out of their group
    if (groupId != null) {
      for (const entry of Object.values(tabState)) {
        if (entry.role !== 'team') await ensureTabInGroup(entry.tabId, groupId);
      }
    }
    if (teamGroupId != null) {
      for (const entry of Object.values(tabState)) {
        if (entry.role === 'team') await ensureTabInGroup(entry.tabId, teamGroupId);
      }
    }

    await chrome.storage.local.set({
      tabState,
      groupId,
      teamGroupId,
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

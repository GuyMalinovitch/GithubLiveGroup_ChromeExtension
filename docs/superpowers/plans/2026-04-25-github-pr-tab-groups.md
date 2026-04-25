# GitHub PR Tab Groups — Chrome Extension Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chrome Manifest V3 extension that polls GitHub's Search API and keeps a "My PRs" tab group live-synced with open pull requests the user authored or is assigned to.

**Architecture:** A background service worker uses `chrome.alarms` to poll GitHub every N minutes. It diffs fetched PRs against stored state (in `chrome.storage.local`), opens new tabs into a single managed tab group, re-groups escaped tabs, and closes tabs for merged/closed PRs. Tab lifecycle events (`onRemoved`, `onUpdated`) keep state clean between ticks.

**Tech Stack:** Vanilla JS (ES modules), Chrome Extensions API MV3, GitHub Search API v3, Jest 29 for unit testing pure-logic modules.

---

## File Map

| File | Responsibility |
|---|---|
| `manifest.json` | Extension metadata, permissions, service worker declaration |
| `github.js` | GitHub API client — fetch PRs with pagination, resolve authenticated user |
| `state.js` | Pure functions — diff fetched vs stored, annotate roles, build tab entries, group by role, format timestamps |
| `tabgroup.js` | Chrome tab-group lifecycle — find/validate group, create group, add tab, remove tab safely, re-group escaped tab |
| `background.js` | Service worker — alarm setup, sync loop, tab event listeners, badge updates |
| `popup.html` | Popup markup — PR list view + settings panel (toggled) |
| `popup.css` | Popup styles — dark GitHub-inspired theme, 320px wide |
| `popup.js` | Popup logic — render PR groups, settings form, click-to-focus tab, send sync message |
| `icons/generate.js` | One-time script to generate PNG icons using only Node.js built-ins |
| `icons/icon{16,32,48,128}.png` | Extension icons (generated, committed) |
| `tests/github.test.js` | Unit tests for github.js |
| `tests/state.test.js` | Unit tests for state.js |
| `package.json` | Dev deps (Jest) and test script |

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `manifest.json`
- Modify: `.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "github-pr-tabs",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --experimental-vm-modules node_modules/.bin/jest"
  },
  "devDependencies": {
    "jest": "^29.7.0"
  },
  "jest": {
    "testEnvironment": "node",
    "transform": {}
  }
}
```

- [ ] **Step 2: Install dev deps**

```bash
cd /home/guy.malinovitch/projects/github-pr-tabs && npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Create manifest.json**

```json
{
  "manifest_version": 3,
  "name": "GitHub PR Tabs",
  "version": "1.0.0",
  "description": "Live tab group for your open GitHub pull requests",
  "permissions": ["tabs", "tabGroups", "storage", "alarms"],
  "host_permissions": ["https://api.github.com/*"],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup.html",
    "default_title": "GitHub PR Tabs",
    "default_icon": {
      "16": "icons/icon16.png",
      "32": "icons/icon32.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "icons": {
    "16": "icons/icon16.png",
    "32": "icons/icon32.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

- [ ] **Step 4: Update .gitignore**

Append to `.gitignore`:
```
node_modules/
```

- [ ] **Step 5: Commit**

```bash
cd /home/guy.malinovitch/projects/github-pr-tabs && git add -A && git commit -m "feat: project scaffold, manifest, jest setup

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: GitHub API Client (`github.js`)

**Files:**
- Create: `github.js`
- Create: `tests/github.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/github.test.js`:

```javascript
import { parseLinkNext, getAuthenticatedUser, fetchMyPRs } from '../github.js';

// --- parseLinkNext ---

test('parseLinkNext returns null when no header', () => {
  expect(parseLinkNext(null)).toBe(null);
});

test('parseLinkNext extracts next URL', () => {
  const header = '<https://api.github.com/search/issues?page=2>; rel="next", <https://api.github.com/search/issues?page=5>; rel="last"';
  expect(parseLinkNext(header)).toBe('https://api.github.com/search/issues?page=2');
});

test('parseLinkNext returns null when no next rel', () => {
  const header = '<https://api.github.com/search/issues?page=1>; rel="prev"';
  expect(parseLinkNext(header)).toBe(null);
});

// --- getAuthenticatedUser ---

test('getAuthenticatedUser returns login', async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ login: 'testuser' }),
    headers: { get: () => null },
  });
  const user = await getAuthenticatedUser('ghp_token');
  expect(user).toBe('testuser');
  expect(fetch).toHaveBeenCalledWith(
    'https://api.github.com/user',
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer ghp_token' }) })
  );
});

test('getAuthenticatedUser throws UNAUTHORIZED on 401', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, headers: { get: () => null } });
  await expect(getAuthenticatedUser('bad')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});

// --- fetchMyPRs ---

test('fetchMyPRs merges and deduplicates authored and assigned PRs', async () => {
  const authoredPR = { html_url: 'https://github.com/org/repo/pull/1', number: 1, title: 'PR1', user: { login: 'testuser' }, repository_url: 'https://api.github.com/repos/org/repo', assignees: [] };
  const assignedPR = { html_url: 'https://github.com/org/repo/pull/2', number: 2, title: 'PR2', user: { login: 'other' }, repository_url: 'https://api.github.com/repos/org/repo', assignees: [{ login: 'testuser' }] };
  const dupPR    = { html_url: 'https://github.com/org/repo/pull/1', number: 1, title: 'PR1', user: { login: 'testuser' }, repository_url: 'https://api.github.com/repos/org/repo', assignees: [{ login: 'testuser' }] };

  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [authoredPR] }), headers: { get: () => null } })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [assignedPR, dupPR] }), headers: { get: () => null } });

  const prs = await fetchMyPRs('ghp_token', 'testuser');
  expect(prs).toHaveLength(2);
  expect(prs.map(p => p.html_url)).toEqual(
    expect.arrayContaining([authoredPR.html_url, assignedPR.html_url])
  );
});

test('fetchMyPRs paginates until no next link', async () => {
  const pr1 = { html_url: 'https://github.com/org/repo/pull/1', number: 1, title: 'PR1', user: { login: 'testuser' }, repository_url: 'https://api.github.com/repos/org/repo', assignees: [] };
  const pr2 = { html_url: 'https://github.com/org/repo/pull/2', number: 2, title: 'PR2', user: { login: 'testuser' }, repository_url: 'https://api.github.com/repos/org/repo', assignees: [] };

  global.fetch = jest.fn()
    // authored page 1 → has next
    .mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ items: [pr1] }),
      headers: { get: (h) => h === 'Link' ? '<https://api.github.com/search/issues?page=2>; rel="next"' : null },
    })
    // authored page 2 → no next
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [pr2] }), headers: { get: () => null } })
    // assigned → empty
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [] }), headers: { get: () => null } });

  const prs = await fetchMyPRs('ghp_token', 'testuser');
  expect(prs).toHaveLength(2);
});

test('fetchMyPRs throws RATE_LIMITED on 403', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403, headers: { get: () => null } });
  await expect(fetchMyPRs('ghp_token', 'user')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd /home/guy.malinovitch/projects/github-pr-tabs && npm test -- tests/github.test.js 2>&1 | tail -20
```

Expected: `Cannot find module '../github.js'`

- [ ] **Step 3: Implement github.js**

Create `github.js`:

```javascript
const BASE = 'https://api.github.com';

function headers(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export function parseLinkNext(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

async function fetchAllPages(url, token) {
  const results = [];
  let nextUrl = url;
  while (nextUrl) {
    const res = await fetch(nextUrl, { headers: headers(token) });
    if (res.status === 401) throw Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED' });
    if (res.status === 403) throw Object.assign(new Error('Rate limited'), { code: 'RATE_LIMITED' });
    if (!res.ok) throw Object.assign(new Error(`GitHub API error: ${res.status}`), { code: 'API_ERROR' });
    const data = await res.json();
    results.push(...data.items);
    nextUrl = parseLinkNext(res.headers.get('Link'));
  }
  return results;
}

export async function getAuthenticatedUser(token) {
  const res = await fetch(`${BASE}/user`, { headers: headers(token) });
  if (res.status === 401) throw Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED' });
  if (!res.ok) throw Object.assign(new Error(`GitHub API error: ${res.status}`), { code: 'API_ERROR' });
  const data = await res.json();
  return data.login;
}

export async function fetchMyPRs(token, username) {
  const [authored, assigned] = await Promise.all([
    fetchAllPages(
      `${BASE}/search/issues?q=type:pr+state:open+author:${username}&per_page=100`,
      token
    ),
    fetchAllPages(
      `${BASE}/search/issues?q=type:pr+state:open+assignee:${username}&per_page=100`,
      token
    ),
  ]);
  const seen = new Set();
  const merged = [];
  for (const pr of [...authored, ...assigned]) {
    if (!seen.has(pr.html_url)) {
      seen.add(pr.html_url);
      merged.push(pr);
    }
  }
  return merged;
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd /home/guy.malinovitch/projects/github-pr-tabs && npm test -- tests/github.test.js 2>&1 | tail -15
```

Expected: `Tests: 7 passed, 7 total`

- [ ] **Step 5: Commit**

```bash
cd /home/guy.malinovitch/projects/github-pr-tabs && git add -A && git commit -m "feat: github API client with pagination and error codes

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: State Management (`state.js`)

**Files:**
- Create: `state.js`
- Create: `tests/state.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/state.test.js`:

```javascript
import { computeDiff, annotatePRRole, buildTabEntry, groupByRole, relativeTime } from '../state.js';

const makePR = (num, login = 'me', assignees = []) => ({
  html_url: `https://github.com/org/repo/pull/${num}`,
  number: num,
  title: `PR ${num}`,
  user: { login },
  repository_url: 'https://api.github.com/repos/org/repo',
  assignees,
});

// --- computeDiff ---

test('computeDiff finds new PRs not in stored state', () => {
  const fetched = [makePR(1), makePR(2)];
  const stored = {};
  const { newPRs, closedUrls } = computeDiff(fetched, stored);
  expect(newPRs).toHaveLength(2);
  expect(closedUrls).toHaveLength(0);
});

test('computeDiff finds closed PRs no longer in fetched', () => {
  const fetched = [makePR(2)];
  const stored = {
    'https://github.com/org/repo/pull/1': { tabId: 10, windowId: 1 },
    'https://github.com/org/repo/pull/2': { tabId: 11, windowId: 1 },
  };
  const { newPRs, closedUrls } = computeDiff(fetched, stored);
  expect(newPRs).toHaveLength(0);
  expect(closedUrls).toEqual(['https://github.com/org/repo/pull/1']);
});

test('computeDiff returns empty diff when nothing changed', () => {
  const pr = makePR(1);
  const stored = { [pr.html_url]: { tabId: 5, windowId: 1 } };
  const { newPRs, closedUrls } = computeDiff([pr], stored);
  expect(newPRs).toHaveLength(0);
  expect(closedUrls).toHaveLength(0);
});

// --- annotatePRRole ---

test('annotatePRRole marks authored when user is the PR author', () => {
  const pr = makePR(1, 'me');
  expect(annotatePRRole(pr, 'me').role).toBe('authored');
});

test('annotatePRRole marks assigned when user is not the PR author', () => {
  const pr = makePR(1, 'other');
  expect(annotatePRRole(pr, 'me').role).toBe('assigned');
});

test('annotatePRRole is case-insensitive', () => {
  const pr = makePR(1, 'Me');
  expect(annotatePRRole(pr, 'me').role).toBe('authored');
});

// --- buildTabEntry ---

test('buildTabEntry extracts repo path from repository_url', () => {
  const pr = { ...makePR(1), role: 'authored' };
  const entry = buildTabEntry(pr, 99, 2);
  expect(entry.repo).toBe('org/repo');
  expect(entry.tabId).toBe(99);
  expect(entry.windowId).toBe(2);
  expect(entry.number).toBe(1);
  expect(entry.title).toBe('PR 1');
  expect(entry.role).toBe('authored');
});

// --- groupByRole ---

test('groupByRole splits entries into authored and assigned', () => {
  const state = {
    'https://github.com/org/repo/pull/1': { tabId: 1, windowId: 1, role: 'authored', number: 1, title: 'A', repo: 'org/repo' },
    'https://github.com/org/repo/pull/2': { tabId: 2, windowId: 1, role: 'assigned', number: 2, title: 'B', repo: 'org/repo' },
  };
  const { authored, assigned } = groupByRole(state);
  expect(authored).toHaveLength(1);
  expect(assigned).toHaveLength(1);
  expect(authored[0].number).toBe(1);
  expect(assigned[0].number).toBe(2);
});

// --- relativeTime ---

test('relativeTime returns "just now" for < 1 minute', () => {
  expect(relativeTime(Date.now() - 30000)).toBe('just now');
});

test('relativeTime returns "X mins ago"', () => {
  expect(relativeTime(Date.now() - 5 * 60 * 1000)).toBe('5 mins ago');
});

test('relativeTime returns "never" for null', () => {
  expect(relativeTime(null)).toBe('never');
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd /home/guy.malinovitch/projects/github-pr-tabs && npm test -- tests/state.test.js 2>&1 | tail -10
```

Expected: `Cannot find module '../state.js'`

- [ ] **Step 3: Implement state.js**

Create `state.js`:

```javascript
export function computeDiff(fetchedPRs, tabState) {
  const fetchedUrls = new Set(fetchedPRs.map(pr => pr.html_url));
  const storedUrls = Object.keys(tabState);
  const newPRs = fetchedPRs.filter(pr => !tabState[pr.html_url]);
  const closedUrls = storedUrls.filter(url => !fetchedUrls.has(url));
  return { newPRs, closedUrls };
}

export function annotatePRRole(pr, username) {
  const isAuthor = pr.user.login.toLowerCase() === username.toLowerCase();
  return { ...pr, role: isAuthor ? 'authored' : 'assigned' };
}

export function buildTabEntry(pr, tabId, windowId) {
  const repo = pr.repository_url.replace('https://api.github.com/repos/', '');
  return { tabId, windowId, number: pr.number, title: pr.title, repo, role: pr.role };
}

export function groupByRole(tabState) {
  const authored = [];
  const assigned = [];
  for (const [url, entry] of Object.entries(tabState)) {
    const item = { url, ...entry };
    if (entry.role === 'authored') authored.push(item);
    else assigned.push(item);
  }
  return { authored, assigned };
}

export function relativeTime(timestamp) {
  if (!timestamp) return 'never';
  const mins = Math.floor((Date.now() - timestamp) / 60000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 min ago';
  if (mins < 60) return `${mins} mins ago`;
  const hrs = Math.floor(mins / 60);
  return hrs === 1 ? '1 hr ago' : `${hrs} hrs ago`;
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd /home/guy.malinovitch/projects/github-pr-tabs && npm test -- tests/state.test.js 2>&1 | tail -10
```

Expected: `Tests: 10 passed, 10 total`

- [ ] **Step 5: Run all tests**

```bash
cd /home/guy.malinovitch/projects/github-pr-tabs && npm test 2>&1 | tail -15
```

Expected: all 17 tests pass.

- [ ] **Step 6: Commit**

```bash
cd /home/guy.malinovitch/projects/github-pr-tabs && git add -A && git commit -m "feat: state management pure functions with tests

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Tab Group Manager (`tabgroup.js`)

**Files:**
- Create: `tabgroup.js`

No unit tests — all functions call Chrome APIs. Verified in Task 8.

- [ ] **Step 1: Implement tabgroup.js**

Create `tabgroup.js`:

```javascript
/**
 * Try to retrieve the stored group. Returns the group object if still alive,
 * or null if it no longer exists. Clears stale groupId from storage on miss.
 */
export async function findGroup(storedGroupId) {
  if (storedGroupId == null) return null;
  try {
    return await chrome.tabGroups.get(storedGroupId);
  } catch {
    await chrome.storage.local.remove('groupId');
    return null;
  }
}

/**
 * Create a new "My PRs" tab group containing the given tab.
 * Saves the new groupId to storage.
 */
export async function createGroup(tabId, windowId) {
  const groupId = await chrome.tabs.group({ tabIds: [tabId], windowId });
  await chrome.tabGroups.update(groupId, { title: 'My PRs', color: 'blue' });
  await chrome.storage.local.set({ groupId });
  return groupId;
}

/**
 * Open a new tab for prUrl in the given window and add it to the group.
 * Returns the new tabId.
 */
export async function addTabToGroup(prUrl, groupId, windowId) {
  const tab = await chrome.tabs.create({ url: prUrl, windowId, active: false });
  await chrome.tabs.group({ tabIds: [tab.id], groupId });
  return tab.id;
}

/**
 * Remove a tab only if its current URL still matches the tracked PR URL.
 * Handles stale tabIds silently.
 */
export async function removeTabSafely(tabId, prUrl) {
  try {
    const tab = await chrome.tabs.get(tabId);
    // Strip query string for comparison (GitHub may add ?tab= params)
    const base = prUrl.split('?')[0];
    if (!tab.url || !tab.url.startsWith(base)) return;
    await chrome.tabs.remove(tabId);
  } catch {
    // Tab already gone — no-op
  }
}

/**
 * Ensure a tracked tab is inside the group. Called after sync to re-group
 * any tabs the user may have dragged out.
 */
export async function ensureTabInGroup(tabId, groupId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId !== groupId) {
      await chrome.tabs.group({ tabIds: [tabId], groupId });
    }
  } catch {
    // Tab gone — state cleanup handled by onRemoved listener
  }
}

/**
 * Get the windowId that contains the given groupId.
 * Falls back to the last focused normal window if the group is gone.
 */
export async function resolveWindowForGroup(group) {
  if (group) return group.windowId;
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  return win.id;
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/guy.malinovitch/projects/github-pr-tabs && git add tabgroup.js && git commit -m "feat: tab group manager (find, create, add, remove, re-group)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: Background Service Worker (`background.js`)

**Files:**
- Create: `background.js`

- [ ] **Step 1: Implement background.js**

Create `background.js`:

```javascript
import { fetchMyPRs } from './github.js';
import { computeDiff, annotatePRRole, buildTabEntry } from './state.js';
import { findGroup, createGroup, addTabToGroup, removeTabSafely, ensureTabInGroup, resolveWindowForGroup } from './tabgroup.js';

const ALARM_NAME = 'pr-sync';

// ── Startup ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

async function setup() {
  const { authToken, refreshIntervalMinutes = 5 } =
    await chrome.storage.local.get(['authToken', 'refreshIntervalMinutes']);
  if (!authToken) return;
  // Clear existing alarm before recreating (handles interval changes)
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

// ── Message from popup ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'sync') {
    sync().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true; // keep channel open for async response
  }
  if (msg.type === 'setup') {
    setup().then(() => sendResponse({ ok: true }));
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
  const { authToken, username, groupId: storedGroupId, tabState = {} } =
    await chrome.storage.local.get(['authToken', 'username', 'groupId', 'tabState']);

  if (!authToken) return;

  try {
    const rawPRs = await fetchMyPRs(authToken, username);
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
        // First PR ever — create the tab and group it
        const tab = await chrome.tabs.create({ url: pr.html_url, windowId, active: false });
        groupId = await createGroup(tab.id, windowId);
        tabState[pr.html_url] = buildTabEntry(pr, tab.id, windowId);
      } else {
        const tabId = await addTabToGroup(pr.html_url, groupId, windowId);
        tabState[pr.html_url] = buildTabEntry(pr, tabId, windowId);
      }
    }

    // Re-group any tracked tabs the user dragged out
    if (groupId != null) {
      for (const [, entry] of Object.entries(tabState)) {
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
```

- [ ] **Step 2: Commit**

```bash
cd /home/guy.malinovitch/projects/github-pr-tabs && git add background.js && git commit -m "feat: background service worker with sync loop and tab lifecycle

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: Popup (`popup.html`, `popup.css`, `popup.js`)

**Files:**
- Create: `popup.html`
- Create: `popup.css`
- Create: `popup.js`

- [ ] **Step 1: Create popup.html**

Create `popup.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>GitHub PR Tabs</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div id="app">

    <header>
      <span class="logo">⬡ My PRs</span>
      <div class="header-actions">
        <span id="sync-status" class="status-text"></span>
        <button id="sync-btn" class="icon-btn" title="Sync now">⟳</button>
        <button id="settings-btn" class="icon-btn" title="Settings">⚙</button>
      </div>
    </header>

    <!-- PR List View -->
    <div id="pr-view">

      <div id="state-no-token" class="empty-state hidden">
        <div class="empty-icon">🔑</div>
        <p>Add your GitHub token to get started.</p>
        <button id="go-settings-btn" class="primary-btn">Open Settings</button>
      </div>

      <div id="state-loading" class="empty-state hidden">
        <div class="spinner"></div>
        <p>Syncing…</p>
      </div>

      <div id="state-error" class="empty-state hidden">
        <div class="empty-icon">⚠️</div>
        <p id="error-msg"></p>
      </div>

      <div id="state-empty" class="empty-state hidden">
        <div class="empty-icon">🎉</div>
        <p>No open pull requests found.</p>
      </div>

      <div id="pr-list" class="hidden">
        <section id="authored-section">
          <button class="section-header" data-target="authored-list">
            <span class="chevron">▸</span>
            <span class="section-label">AUTHORED</span>
            <span class="section-count" id="authored-count">0</span>
          </button>
          <ul id="authored-list" class="pr-group"></ul>
        </section>

        <section id="assigned-section">
          <button class="section-header" data-target="assigned-list">
            <span class="chevron">▸</span>
            <span class="section-label">ASSIGNED</span>
            <span class="section-count" id="assigned-count">0</span>
          </button>
          <ul id="assigned-list" class="pr-group"></ul>
        </section>
      </div>
    </div>

    <!-- Settings View -->
    <div id="settings-view" class="hidden">
      <div class="settings-section">
        <label class="settings-label" for="token-input">Personal Access Token</label>
        <p class="settings-hint">Needs <code>repo</code> and <code>read:user</code> scopes. <a href="https://github.com/settings/tokens/new?scopes=repo,read:user" target="_blank">Create one ↗</a></p>
        <input id="token-input" type="password" placeholder="ghp_…" autocomplete="off" spellcheck="false">
        <p id="auth-status" class="auth-status"></p>
        <button id="save-token-btn" class="primary-btn">Save Token</button>
      </div>

      <div class="settings-section">
        <label class="settings-label" for="interval-select">Sync interval</label>
        <select id="interval-select">
          <option value="1">Every 1 minute</option>
          <option value="5" selected>Every 5 minutes</option>
          <option value="15">Every 15 minutes</option>
          <option value="30">Every 30 minutes</option>
        </select>
      </div>

      <div class="settings-section settings-footer">
        <button id="sync-now-settings-btn" class="secondary-btn">Sync Now</button>
        <button id="signout-btn" class="danger-btn">Sign Out</button>
      </div>
    </div>

  </div>
  <script type="module" src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create popup.css**

Create `popup.css`:

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #0d1117;
  --surface: #161b22;
  --border: #30363d;
  --text: #e6edf3;
  --muted: #8b949e;
  --accent: #58a6ff;
  --green: #3fb950;
  --authored-color: #3fb950;
  --assigned-color: #388bfd;
  --danger: #f85149;
  --radius: 6px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

body {
  width: 340px;
  min-height: 200px;
  max-height: 560px;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 13px;
  overflow: hidden;
}

#app { display: flex; flex-direction: column; height: 100%; }

/* Header */
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.logo { font-weight: 600; font-size: 14px; color: var(--accent); letter-spacing: 0.3px; }

.header-actions { display: flex; align-items: center; gap: 6px; }

.status-text { font-size: 11px; color: var(--muted); }

.icon-btn {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 16px;
  padding: 2px 4px;
  border-radius: var(--radius);
  line-height: 1;
  transition: color 0.15s, background 0.15s;
}
.icon-btn:hover { color: var(--text); background: var(--surface); }

/* Views */
#pr-view, #settings-view { overflow-y: auto; flex: 1; }

.hidden { display: none !important; }

/* Empty states */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px 24px;
  text-align: center;
  color: var(--muted);
}
.empty-icon { font-size: 28px; }
.spinner {
  width: 24px; height: 24px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Section headers */
.section-header {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px 4px;
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.6px;
  text-align: left;
}
.section-header:hover { color: var(--text); }

.chevron { font-size: 10px; transition: transform 0.15s; display: inline-block; }
.section-header.open .chevron { transform: rotate(90deg); }

.section-label { flex: 1; }
.section-count {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0 6px;
  font-size: 10px;
  min-width: 18px;
  text-align: center;
}

#authored-section .section-header { color: var(--authored-color); }
#assigned-section .section-header { color: var(--assigned-color); }

/* PR list */
.pr-group { list-style: none; padding-bottom: 4px; }

.pr-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 12px 7px 20px;
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: background 0.1s;
}
.pr-item:hover { background: var(--surface); }

#authored-list .pr-item { border-left-color: var(--authored-color); }
#assigned-list .pr-item { border-left-color: var(--assigned-color); }

.pr-number { color: var(--accent); font-size: 11px; white-space: nowrap; padding-top: 1px; }
.pr-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pr-title { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pr-repo { color: var(--muted); font-size: 11px; }

/* Settings */
.settings-section {
  padding: 14px 14px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.settings-footer { flex-direction: row; padding-top: 10px; padding-bottom: 14px; gap: 8px; }

.settings-label { font-size: 11px; font-weight: 600; color: var(--muted); letter-spacing: 0.5px; }
.settings-hint { font-size: 11px; color: var(--muted); }
.settings-hint a { color: var(--accent); text-decoration: none; }
.settings-hint code { font-family: monospace; background: var(--surface); padding: 0 3px; border-radius: 3px; }

input[type="password"], select {
  width: 100%;
  padding: 6px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  font-size: 12px;
  outline: none;
}
input[type="password"]:focus, select:focus { border-color: var(--accent); }

.auth-status { font-size: 11px; min-height: 16px; }
.auth-status.ok { color: var(--green); }
.auth-status.err { color: var(--danger); }

button { cursor: pointer; border-radius: var(--radius); font-size: 12px; padding: 6px 12px; border: none; }

.primary-btn { background: #238636; color: #fff; }
.primary-btn:hover { background: #2ea043; }

.secondary-btn { background: var(--surface); border: 1px solid var(--border); color: var(--text); }
.secondary-btn:hover { background: var(--border); }

.danger-btn { background: none; border: 1px solid var(--danger); color: var(--danger); }
.danger-btn:hover { background: rgba(248,81,73,0.1); }
```

- [ ] **Step 3: Create popup.js**

Create `popup.js`:

```javascript
import { groupByRole, relativeTime } from './state.js';
import { getAuthenticatedUser } from './github.js';

const $ = id => document.getElementById(id);

// ── View switching ────────────────────────────────────────────────────────────

let inSettings = false;

function showPRView() {
  inSettings = false;
  $('pr-view').classList.remove('hidden');
  $('settings-view').classList.add('hidden');
}

function showSettingsView() {
  inSettings = true;
  $('pr-view').classList.add('hidden');
  $('settings-view').classList.remove('hidden');
}

// ── PR list rendering ─────────────────────────────────────────────────────────

function renderPRList(tabState, lastSyncedAt, lastError) {
  const { authored, assigned } = groupByRole(tabState);

  hideAllStates();

  if (lastError === 'UNAUTHORIZED') {
    showState('state-error');
    $('error-msg').textContent = 'Token invalid — check your settings.';
    return;
  }
  if (lastError === 'RATE_LIMITED') {
    showState('state-error');
    $('error-msg').textContent = 'GitHub rate limit reached. Retrying next tick.';
    return;
  }

  if (authored.length === 0 && assigned.length === 0) {
    showState('state-empty');
    return;
  }

  $('pr-list').classList.remove('hidden');
  $('sync-status').textContent = relativeTime(lastSyncedAt);

  renderGroup('authored-list', 'authored-count', authored);
  renderGroup('assigned-list', 'assigned-count', assigned);
}

function renderGroup(listId, countId, items) {
  const list = $(listId);
  const countEl = $(countId);
  list.innerHTML = '';
  countEl.textContent = items.length;

  // Open section if it has items
  const header = list.closest('section').querySelector('.section-header');
  if (items.length > 0) {
    header.classList.add('open');
    list.classList.remove('hidden');
  }

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'pr-item';
    li.innerHTML = `
      <span class="pr-number">#${item.number}</span>
      <div class="pr-body">
        <span class="pr-title" title="${escHtml(item.title)}">${escHtml(item.title)}</span>
        <span class="pr-repo">${escHtml(item.repo)}</span>
      </div>`;
    li.addEventListener('click', () => focusPRTab(item));
    list.appendChild(li);
  }
}

function hideAllStates() {
  for (const id of ['state-no-token', 'state-loading', 'state-error', 'state-empty', 'pr-list']) {
    $(id).classList.add('hidden');
  }
}

function showState(id) {
  hideAllStates();
  $(id).classList.remove('hidden');
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Tab focus ─────────────────────────────────────────────────────────────────

async function focusPRTab(item) {
  try {
    await chrome.tabs.update(item.tabId, { active: true });
    await chrome.windows.update(item.windowId, { focused: true });
  } catch {
    // Tab gone — open fresh
    await chrome.tabs.create({ url: item.url, active: true });
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadSettings() {
  const { authToken, username, refreshIntervalMinutes = 5 } =
    await chrome.storage.local.get(['authToken', 'username', 'refreshIntervalMinutes']);

  if (authToken) {
    $('token-input').value = '';
    $('token-input').placeholder = '••••••••••••• (saved)';
    const status = $('auth-status');
    status.className = 'auth-status ok';
    status.textContent = username ? `Connected as @${username}` : 'Token saved';
  }

  const sel = $('interval-select');
  sel.value = String(refreshIntervalMinutes);
}

async function saveToken() {
  const token = $('token-input').value.trim();
  const status = $('auth-status');

  if (!token) {
    status.className = 'auth-status err';
    status.textContent = 'Please enter a token.';
    return;
  }

  status.className = 'auth-status';
  status.textContent = 'Verifying…';

  try {
    const username = await getAuthenticatedUser(token);
    await chrome.storage.local.set({ authToken: token, username });
    status.className = 'auth-status ok';
    status.textContent = `Connected as @${username}`;
    $('token-input').value = '';
    $('token-input').placeholder = '••••••••••••• (saved)';
    // Restart alarm with new token
    chrome.runtime.sendMessage({ type: 'setup' });
  } catch (err) {
    status.className = 'auth-status err';
    status.textContent = err.code === 'UNAUTHORIZED'
      ? 'Invalid token — check scopes and try again.'
      : 'Could not reach GitHub. Check your connection.';
  }
}

async function saveInterval() {
  const minutes = Number($('interval-select').value);
  await chrome.storage.local.set({ refreshIntervalMinutes: minutes });
  chrome.runtime.sendMessage({ type: 'setup' });
}

async function signOut() {
  await chrome.storage.local.clear();
  await chrome.alarms.clearAll();
  $('token-input').value = '';
  $('token-input').placeholder = 'ghp_…';
  $('auth-status').textContent = '';
  showPRView();
  showState('state-no-token');
}

// ── Section collapse ──────────────────────────────────────────────────────────

document.querySelectorAll('.section-header').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = document.getElementById(btn.dataset.target);
    const isOpen = btn.classList.toggle('open');
    target.classList.toggle('hidden', !isOpen);
  });
});

// ── Sync ──────────────────────────────────────────────────────────────────────

async function triggerSync() {
  showState('state-loading');
  await chrome.runtime.sendMessage({ type: 'sync' });
  await loadView();
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function loadView() {
  const { authToken, tabState = {}, lastSyncedAt, lastError } =
    await chrome.storage.local.get(['authToken', 'tabState', 'lastSyncedAt', 'lastError']);

  if (!authToken) {
    showState('state-no-token');
    return;
  }

  renderPRList(tabState, lastSyncedAt, lastError);
  $('sync-status').textContent = relativeTime(lastSyncedAt);
}

// ── Event listeners ───────────────────────────────────────────────────────────

$('settings-btn').addEventListener('click', () => {
  if (inSettings) { showPRView(); loadView(); }
  else { showSettingsView(); loadSettings(); }
});

$('sync-btn').addEventListener('click', triggerSync);
$('go-settings-btn').addEventListener('click', () => { showSettingsView(); loadSettings(); });
$('save-token-btn').addEventListener('click', saveToken);
$('interval-select').addEventListener('change', saveInterval);
$('sync-now-settings-btn').addEventListener('click', triggerSync);
$('signout-btn').addEventListener('click', signOut);

// Kick off
showState('state-loading');
loadView();
```

- [ ] **Step 4: Commit**

```bash
cd /home/guy.malinovitch/projects/github-pr-tabs && git add popup.html popup.css popup.js && git commit -m "feat: popup with PR list view and inline settings panel

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 7: Icons

**Files:**
- Create: `icons/generate.js`
- Create: `icons/icon16.png`, `icons/icon32.png`, `icons/icon48.png`, `icons/icon128.png`

- [ ] **Step 1: Create icon generator script**

Create `icons/generate.js` (zero npm dependencies — uses Node.js built-in `zlib`):

```javascript
// Run with: node icons/generate.js
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));

function crc32(buf) {
  const table = Array.from({ length: 256 }, (_, i) => {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const b of buf) crc = (table[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

function makePNG(size, hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB, no alpha

  // Build raw scanlines: filter byte 0 + RGB per pixel
  const rowBytes = 1 + size * 3;
  const raw = Buffer.alloc(size * rowBytes);
  for (let y = 0; y < size; y++) {
    const base = y * rowBytes;
    raw[base] = 0; // filter type None
    for (let x = 0; x < size; x++) {
      const cx = x - size / 2, cy = y - size / 2;
      const inCircle = Math.sqrt(cx * cx + cy * cy) <= size / 2 - 1;
      raw[base + 1 + x * 3] = inCircle ? r : 13;
      raw[base + 2 + x * 3] = inCircle ? g : 17;
      raw[base + 3 + x * 3] = inCircle ? b : 23;
    }
  }

  const idat = deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

for (const size of [16, 32, 48, 128]) {
  const out = join(__dir, `icon${size}.png`);
  writeFileSync(out, makePNG(size, '#2ea043')); // GitHub green circle
  console.log(`✓ icon${size}.png`);
}
```

- [ ] **Step 2: Generate the icons**

```bash
cd /home/guy.malinovitch/projects/github-pr-tabs && node icons/generate.js
```

Expected output:
```
✓ icon16.png
✓ icon32.png
✓ icon48.png
✓ icon128.png
```

- [ ] **Step 3: Verify files exist**

```bash
ls -lh /home/guy.malinovitch/projects/github-pr-tabs/icons/*.png
```

Expected: 4 PNG files, each > 0 bytes.

- [ ] **Step 4: Commit**

```bash
cd /home/guy.malinovitch/projects/github-pr-tabs && git add icons/ && git commit -m "feat: extension icons (green circle, generated)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 8: Run All Tests + Final Verification

- [ ] **Step 1: Run the full test suite**

```bash
cd /home/guy.malinovitch/projects/github-pr-tabs && npm test 2>&1 | tail -20
```

Expected: all 17 tests pass, 0 failures.

- [ ] **Step 2: Verify project file structure**

```bash
find /home/guy.malinovitch/projects/github-pr-tabs -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.superpowers/*' | sort
```

Expected structure matches file map above.

- [ ] **Step 3: Manual load in Chrome**

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select `/home/guy.malinovitch/projects/github-pr-tabs`
4. Extension should appear with green circle icon and no errors in the service worker console.

- [ ] **Step 4: Configure and test**

1. Click the extension icon
2. Click ⚙ → paste a real GitHub PAT with `repo,read:user` scopes → Save Token
3. Verify "Connected as @{username}" appears
4. Watch the "My PRs" tab group appear with your open PRs

- [ ] **Step 5: Final commit**

```bash
cd /home/guy.malinovitch/projects/github-pr-tabs && git add -A && git commit -m "chore: final cleanup and verification

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

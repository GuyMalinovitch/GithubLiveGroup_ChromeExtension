# GitHub PR Tab Groups — Chrome Extension Design

**Date:** 2026-04-25  
**Status:** Approved

---

## Problem

No existing Chrome extension auto-syncs a user's GitHub pull requests into a live Chrome tab group. The closest experience is Arc browser's "live folders" for GitHub, which don't exist in Chrome. This extension fills that gap.

---

## Goals

- Automatically collect all open PRs the user has **authored** or is **assigned to**, across all GitHub organizations and repositories.
- Open each PR as a tab in a named Chrome tab group ("My PRs").
- Keep the group live: add tabs for new PRs, close tabs for merged/closed PRs.
- Minimal friction: configure once, works in the background.

## Non-Goals

- Filtering by specific org or repo (all repos, all orgs — no filtering).
- Webhook-based real-time sync (polling is sufficient and avoids infra complexity).
- PR review actions, commenting, or any GitHub interaction beyond navigation.
- OAuth backend/proxy (v1 uses PAT only; OAuth requires a server-side code exchange that is out of scope).

---

## Architecture

### Approach: Polling Background Worker

A Manifest V3 Chrome extension with a **background service worker** that uses `chrome.alarms` to poll GitHub's Search API at a configurable interval. This is the simplest reliable approach for a live-folder experience without requiring any server infrastructure.

### Components

#### 1. Background Service Worker (`background.js`)

Responsibilities:
- Register and handle a `chrome.alarms` alarm at the configured interval (default: 5 minutes).
- On each alarm tick (and on extension startup):
  1. Read auth token and refresh interval from `chrome.storage.sync`.
  2. Call GitHub Search API for PRs authored by the user.
  3. Call GitHub Search API for PRs assigned to the user.
  4. Merge and deduplicate results by PR URL.
  5. Diff against stored state (`chrome.storage.local` map of `url → tabId`).
  6. Open new tabs for PRs not yet in the group.
  7. Close tabs for PRs that are now merged or closed.
  8. Persist updated state.
- Handle errors gracefully (network failures, API rate limits, expired tokens).

#### 2. GitHub API Client (`github.js`)

A thin module imported by the service worker:
- `fetchMyPRs(token, username)` — runs two parallel Search API queries:
  - `GET /search/issues?q=type:pr+state:open+author:{username}&per_page=100`
  - `GET /search/issues?q=type:pr+state:open+assignee:{username}&per_page=100`
  - Paginates through all pages (follows `Link: <url>; rel="next"` headers) until no next page.
  - Merges and deduplicates by `html_url`.
- `getAuthenticatedUser(token)` — `GET /user` to resolve username from token.
- Handles 401 (invalid token) and 403 (rate limit) with distinct error codes.

#### 3. Popup (`popup.html`, `popup.js`, `popup.css`)

Two views toggled by a gear (⚙) icon in the header:

**PR List View (default):**
- Header: extension name, sync status ("last synced 2m ago"), manual sync button, gear icon.
- Two collapsible sections: **AUTHORED** and **ASSIGNED**, each showing PR count.
- Each PR row: number, title, repo name. Clicking opens the PR tab (or focuses existing tab).
- Empty state: helpful message if no token configured or no open PRs.
- Loading state while sync is in progress.

**Settings Panel View (toggled by gear icon):**
- Auth section:
  - **Personal Access Token (PAT)** input field with save button.
  - Shows connected username when authenticated.
  - (OAuth requires a server-side code exchange; deferred to a future version.)
- Sync section:
  - Dropdown for refresh interval: 1 min, 5 min, 15 min, 30 min.
- Manual "Sync Now" button.
- "Sign out" link.

#### 4. Icons (`icons/`)

PNG icons at 16×16, 32×32, 48×48, 128×128 px. Simple GitHub-mark-style icon with a green dot to indicate active sync.

---

## Data Flow

```
chrome.alarms fires
  └─► background.js: handleAlarm()
        ├─► chrome.storage.sync → read token + username
        ├─► github.js: fetchMyPRs(token, username)
        │     ├─► GET /search/issues?q=type:pr+state:open+author:{username}
        │     └─► GET /search/issues?q=type:pr+state:open+assignee:{username}
        ├─► merge + dedupe by html_url
        ├─► chrome.storage.local → read { url: tabId } state map
        ├─► diff: newPRs = fetched - stored; closedPRs = stored - fetched
        ├─► for each newPR: chrome.tabs.create({url}) → add to group
        ├─► for each closedPR: chrome.tabs.remove(tabId)
        └─► chrome.storage.local → write updated state map
```

---

## Tab Group Management

- Group name: **"My PRs"**, color: **blue**.
- **Single managed group** — the extension maintains one global group. It is created in the focused window at first sync; subsequent syncs reuse it regardless of window. State tracks the `groupId` so the group can be found after window switches.
- If the user manually closes the group (or all its tabs), it is recreated on the next sync tick.
- If the user drags a tracked PR tab out of the group, it will be moved back into the group on the next sync.
- Tabs within the group are not reordered by the extension after initial placement.
- If a tab is manually closed by the user, it will be reopened on the next sync (since the PR is still open). This matches Arc's live-folder behavior.

### Tab Lifecycle Safety

Before closing a tab for a merged/closed PR, the extension **must verify** the tab's current URL still matches the tracked PR URL:
- Listen to `chrome.tabs.onUpdated` and `chrome.tabs.onRemoved` to maintain the state map.
- On `onUpdated` (URL changed): if the tab navigated away from the tracked PR URL, remove it from the state map — do not close it on next sync.
- On `onRemoved`: remove the tab from the state map (user closed it manually).
- Before `chrome.tabs.remove(tabId)`: query the tab's current URL and skip removal if it doesn't match.

---

### Authentication

### Personal Access Token (PAT)
- User pastes a GitHub PAT with `repo` and `read:user` scopes.
- Stored in `chrome.storage.local` (not synced — keeps the token local to the device).
- Username resolved once via `GET /user` and cached in `chrome.storage.local`.

### First Launch
- If no token is configured, the popup opens directly to the Settings Panel view with an explanatory message.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| No token configured | Popup shows setup prompt; no alarm registered |
| 401 Unauthorized | Badge shows ⚠, popup shows "Token invalid — check settings" |
| 403 Rate limited | Skip sync tick, retry on next alarm; badge shows rate-limit warning |
| Network error | Retry on next alarm tick; last-known state preserved |
| Tab already closed manually | `tabs.onRemoved` listener cleans up state map; no stale ID stored |
| `chrome.tabs.remove` fails | Catch the error, remove stale entry from state map |
| PR tab opened in wrong window | Tabs are created in the focused window at sync time |

---

## Storage Schema

**`chrome.storage.local`** (all data local to the device):
```json
{
  "authToken": "ghp_...",
  "username": "guymali",
  "refreshIntervalMinutes": 5,
  "tabState": {
    "https://github.com/org/repo/pull/142": { "tabId": 1234, "windowId": 5 },
    "https://github.com/org/repo/pull/138": { "tabId": 1235, "windowId": 5 }
  },
  "groupId": 7,
  "lastSyncedAt": 1714000000000,
  "lastError": null
}
```

All settings (including token and interval) are stored locally only. No data is synced via `chrome.storage.sync`.

---

## File Structure

```
github-pr-tabs/
├── manifest.json
├── background.js
├── github.js
├── popup.html
├── popup.js
├── popup.css
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

---

## Manifest (key permissions)

```json
{
  "manifest_version": 3,
  "permissions": ["tabs", "tabGroups", "storage", "alarms"],
  "host_permissions": ["https://api.github.com/*"],
  "background": { "service_worker": "background.js" },
  "action": { "default_popup": "popup.html" }
}
```

---

## GitHub API Rate Limits

The Search API allows 30 requests/minute authenticated. Two queries per sync tick (plus pagination if needed) = ~2–4 req/tick in practice. At 5-min intervals: ~0.4–0.8 req/min — well within limits. Even at 1-min intervals: ~2–4 req/min, still well under the 30 req/min cap.

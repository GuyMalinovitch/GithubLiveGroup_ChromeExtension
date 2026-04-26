# GitHub PR Tabs — Chrome Extension

> Automatically maintains a live Chrome tab group for all your open GitHub pull requests — authored and assigned.

![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-blue?logo=googlechrome)
![Tests](https://img.shields.io/badge/tests-21%20passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Table of Contents

- [User Quick Start](#user-quick-start)
- [Architecture](#architecture)
- [Module Reference](#module-reference)
- [State Schema](#state-schema)
- [Message Protocol](#message-protocol)
- [GitHub API Queries](#github-api-queries)
- [Development Setup](#development-setup)
- [Testing](#testing)
- [Debugging](#debugging)
- [Security Model](#security-model)
- [Known Limitations](#known-limitations)
- [Contributing](#contributing)
- [Chrome Web Store](#chrome-web-store)
- [License](#license)

---

## User Quick Start

1. Go to `chrome://extensions/` → enable **Developer mode** → **Load unpacked** → select this folder
2. Create a GitHub PAT with `repo` scope at [github.com/settings/tokens](https://github.com/settings/tokens)
   - If your org uses SAML SSO: **Configure SSO → Authorize** the org for your token
3. Click the extension icon → ⚙ Settings → paste token → Save
4. Your open PRs open in a "My PRs" tab group automatically

---

## Architecture

The extension is a **Manifest V3** Chrome extension with no backend and no external dependencies at runtime.

```
┌─────────────────────────────────────────────────────────────┐
│  Chrome Browser                                             │
│                                                             │
│  ┌──────────────┐   messages   ┌──────────────────────────┐ │
│  │  popup.html  │◄────────────►│  background.js           │ │
│  │  popup.js    │              │  (MV3 service worker)    │ │
│  └──────────────┘              │                          │ │
│                                │  chrome.alarms ──► sync()│ │
│  chrome.storage.local          │         │                │ │
│  ┌───────────────────┐         │         ▼                │ │
│  │ authToken         │◄───────►│  github.js               │ │
│  │ username          │         │  (GitHub Search API)     │ │
│  │ customFilter      │         │         │                │ │
│  │ refreshInterval   │         │         ▼                │ │
│  │ tabState          │◄───────►│  state.js (pure diff)    │ │
│  │ groupId           │         │         │                │ │
│  │ lastSyncedAt      │         │         ▼                │ │
│  │ lastError         │         │  tabgroup.js             │ │
│  └───────────────────┘         │  (chrome.tabs/tabGroups) │ │
│                                └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Sync loop

```
chrome.alarms fires
        │
        ▼
  sync() in background.js
        │
        ├─ fetchMyPRs(token, username, customFilter)
        │         └─ GET /search/issues?q=is:pr+is:open+author:…
        │         └─ GET /search/issues?q=is:pr+is:open+assignee:…
        │         └─ deduplicate by html_url
        │
        ├─ annotatePRRole(pr, username) → adds .role = 'authored' | 'assigned'
        │
        ├─ computeDiff(prs, tabState)
        │         └─ returns { newPRs, closedUrls }
        │
        ├─ for closedUrls → removeTabSafely(tabId, url)
        │
        ├─ for newPRs    → chrome.tabs.create → addTabToGroup
        │
        └─ chrome.storage.local.set({ tabState, groupId, lastSyncedAt })
```

---

## Module Reference

### `manifest.json`
Chrome MV3 manifest. Key points:
- `"type": "module"` on the service worker — required for ESM imports in background.js
- `minimum_chrome_version: "89"` — first version with `chrome.tabGroups` API
- CSP: `script-src 'self'; object-src 'none'` — no inline scripts, no remote scripts
- Permissions scoped to minimum necessary; `host_permissions` limited to `api.github.com`

### `background.js` — Service Worker
The heart of the extension. Responsibilities:
- `setup()` — reads storage, clears and recreates the alarm with the current interval
- `sync()` — full sync cycle (fetch → diff → open/close tabs → update storage)
- `chrome.tabs.onRemoved` — removes stale entries from `tabState` when user closes a PR tab
- `chrome.tabs.onUpdated` — removes entries if the tab navigates away from the PR URL
- Receives `{ type: 'sync' }` and `{ type: 'setup' }` messages from the popup

> **MV3 note:** Service workers are ephemeral. Never store state in module-level variables — always read from `chrome.storage.local` at the start of each function.

### `github.js` — API Client
- `parseLinkNext(header)` — parses RFC 5988 `Link` header to get the next pagination URL. **Validates the URL is on `api.github.com`** before returning it (prevents token exfiltration via malicious Link headers).
- `fetchAllPages(url, token)` — follows pagination until no `next` link
- `getAuthenticatedUser(token)` — verifies token and returns the GitHub login
- `fetchMyPRs(token, username, customFilter)` — runs authored + assigned queries in parallel, deduplicates by `html_url`

### `state.js` — Pure Functions (no Chrome APIs)
All functions are pure and fully unit-tested:
- `computeDiff(prs, tabState)` — diffs fetched PR list against stored tab state → `{ newPRs, closedUrls }`
- `annotatePRRole(pr, username)` — adds `.role = 'authored' | 'assigned'` to a PR object
- `buildTabEntry(pr, tabId, windowId)` — constructs a `tabState` entry from a PR + tab info
- `groupByRole(tabState)` — splits tabState into `{ authored[], assigned[] }` for the popup
- `relativeTime(isoString)` — human-readable "2 min ago" from ISO timestamp

### `tabgroup.js` — Chrome Tab Group Manager
Wraps the `chrome.tabs` and `chrome.tabGroups` APIs:
- `findGroup(groupId)` — safely fetches a group, returns `null` if it no longer exists
- `resolveWindowForGroup(group)` — gets the window to create new tabs in; uses `getLastFocused` (safe from service workers — `getCurrent()` is not available in MV3 service workers)
- `createGroup(tabId, windowId)` — creates a tab group named "My PRs" with a green colour
- `addTabToGroup(tabId, groupId)` — moves a tab into the group
- `ensureTabInGroup(tabId, groupId)` — re-groups a tab that has escaped the group
- `removeTabSafely(tabId, prUrl)` — verifies `tab.url` starts with the expected PR URL before removing (prevents closing the wrong tab)

### `popup.html` / `popup.css` / `popup.js` — Extension Popup
Two-view popup (340px wide):
- **PR list view** — shows authored/assigned sections, collapsible; click to focus tab
- **Settings view** — PAT input, search filter, sync interval, sign-out

CSS uses `prefers-color-scheme` to adapt to Chrome's light/dark mode setting.

### `icons/generate.js` — Icon Generator
Zero-dependency Node.js script that generates all 4 PNG icons using raw pixel manipulation + zlib. Draws a git PR graph symbol (two filled circles + vertical branch line + horizontal arrow + open ring target) on a dark rounded card. Run with `node icons/generate.js`.

---

## State Schema

Everything lives in `chrome.storage.local`:

```js
{
  // Auth
  authToken: "ghp_…",               // GitHub PAT
  username: "your-login",            // from GET /user

  // Settings
  refreshIntervalMinutes: 5,         // 1 | 5 | 15 | 30
  customFilter: "org:my-org",        // appended to search queries (can be empty)

  // Sync state
  lastSyncedAt: "2026-04-26T…",      // ISO timestamp of last successful sync
  lastError: null,                   // null | "UNAUTHORIZED" | "RATE_LIMITED" | "API_ERROR"

  // Tab group
  groupId: 42,                       // chrome.tabGroups ID of the managed group (or null)

  // Per-PR tab tracking
  tabState: {
    "https://github.com/org/repo/pull/1": {
      tabId: 1234,
      windowId: 1,
      number: 1,
      title: "Fix the thing",
      repo: "org/repo",             // stripped of https://api.github.com/repos/ prefix
      role: "authored",             // "authored" | "assigned"
      url: "https://github.com/org/repo/pull/1"
    },
    // … one entry per open PR tab
  }
}
```

---

## Message Protocol

The popup sends messages to the background service worker via `chrome.runtime.sendMessage`. The background only accepts messages from `sender.id === chrome.runtime.id`.

| Message | Effect |
|---------|--------|
| `{ type: 'sync' }` | Runs `sync()` immediately; responds `{ ok: true/false }` |
| `{ type: 'setup' }` | Runs `setup()` to recreate the alarm; responds `{ ok: true/false }` |

---

## GitHub API Queries

Two search queries run in parallel on every sync:

```
GET https://api.github.com/search/issues
    ?q=is:pr+is:open+author:<username>[+<customFilter>]
    &per_page=100

GET https://api.github.com/search/issues
    ?q=is:pr+is:open+assignee:<username>[+<customFilter>]
    &per_page=100
```

Results are paginated via `Link: <url>; rel="next"` headers. Duplicate PRs (authored + assigned) are deduped by `html_url`. The `customFilter` field lets users narrow results with any GitHub search qualifiers, e.g. `org:my-org -label:wip`.

**Rate limits:** The Search API allows 30 requests/minute for authenticated users. A full sync uses 2 requests (more if paginating). A 5-minute interval with <100 PRs never comes close to the limit.

---

## Development Setup

```bash
# Prerequisites: Node.js 18+
git clone https://github.com/GuyMalinovitch/GithubLiveGroup_ChromeExtension.git
cd GithubLiveGroup_ChromeExtension

npm install          # installs Jest (only dev dependency)
npm test             # run all 21 unit tests
npm run pack         # build store-ready github-pr-tabs.zip
node icons/generate.js  # regenerate PNG icons
```

### Load in Chrome

1. `chrome://extensions/` → enable **Developer mode**
2. **Load unpacked** → select the repo root
3. After any code change: click the **↺ refresh** button on the extension card

---

## Testing

Tests use **Jest 29 with ESM** (`--experimental-vm-modules`). Only pure modules are tested — Chrome APIs are not available in Node.js and are not mocked.

```
tests/
├── github.test.js   — 11 tests: parseLinkNext, getAuthenticatedUser, fetchMyPRs
│                      pagination, deduplication, error codes, customFilter injection,
│                      off-origin Link header rejection
└── state.test.js    — 10 tests: computeDiff, annotatePRRole, buildTabEntry,
                       groupByRole, relativeTime
```

`tabgroup.js` and `background.js` are not unit tested as they depend entirely on Chrome APIs. Test them manually by loading the extension.

```bash
npm test                        # run all tests
npm test -- --watch             # watch mode
npm test -- tests/github.test.js  # single file
```

---

## Debugging

### Service worker console
1. `chrome://extensions/` → find the extension → click **"Service Worker"** link
2. This opens DevTools for the background service worker
3. Check the **Console** tab for sync errors, API responses, and tab operations

### Popup DevTools
Right-click the extension popup → **Inspect** → opens DevTools for the popup page

### Inspect storage state
In the service worker console:
```js
// View all stored state
chrome.storage.local.get(null, console.log)

// Clear everything (simulates sign-out)
chrome.storage.local.clear()

// Manually trigger a sync
chrome.runtime.sendMessage({ type: 'sync' })
```

### Common issues

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| No PRs shown, no error | PAT not SSO-authorized for your org | GitHub → Settings → Tokens → Configure SSO → Authorize org |
| "Token invalid" error | PAT expired or wrong scopes | Regenerate with `repo` scope |
| Tabs not opening | Tab group lost (browser restarted) | Click Sync Now — a new group will be created |
| Service worker sleeping | MV3 workers are ephemeral | Clicking the popup wakes the worker; alarms also wake it |

---

## Security Model

| Concern | Approach |
|---------|---------|
| Token storage | `chrome.storage.local` — local device only, inaccessible to web pages |
| Token transmission | Sent only to `https://api.github.com` via `Authorization: Bearer` header — never in URL query params |
| Pagination redirect | `parseLinkNext` validates URL origin against `api.github.com` before following |
| XSS | All user-controlled content (PR title, repo, number) passed through `escHtml()` before `innerHTML` |
| Content Security Policy | `script-src 'self'; object-src 'none'` — no inline JS, no remote scripts |
| Message spoofing | `onMessage` handler checks `sender.id === chrome.runtime.id` — rejects messages from web pages or other extensions |
| Tab removal safety | `removeTabSafely` verifies `tab.url` prefix before closing |

---

## Known Limitations

- **PAT only** — OAuth is deferred to a future version. GitHub OAuth Apps require server-side code exchange (no PKCE); Device Flow is the right approach for a future v2.
- **github.com only** — GitHub Enterprise Server uses a different API base URL (`https://<hostname>/api/v3`). Not currently configurable.
- **Single tab group** — one global "My PRs" group per browser. Opening a second Chrome profile creates a second group.
- **No draft PR filter** — draft PRs appear alongside regular PRs. Add `-is:draft` to the custom filter to exclude them.
- **Service worker lifecycle** — Chrome may terminate the service worker after ~30s of inactivity. `chrome.alarms` reliably wakes it for sync, but the tab state is always re-read from storage (never cached in memory).

---

## Contributing

1. Fork the repo and create a feature branch
2. Add/update tests in `tests/` for any logic in `github.js` or `state.js`
3. Run `npm test` — all tests must pass
4. Load unpacked and test manually in Chrome
5. Open a pull request

No build step, no bundler, no transpiler — the extension runs directly from source.

---

## Chrome Web Store

To publish a new version:
1. Bump `"version"` in `manifest.json`
2. Run `npm run pack` → uploads `github-pr-tabs.zip`
3. The store listing requires:
   - At least one screenshot at **1280×800** or **640×400**
   - A hosted privacy policy URL (can use the raw GitHub URL of `PRIVACY.md`)

See [PRIVACY.md](PRIVACY.md) for the full privacy policy.

---

## License

[MIT](LICENSE) © 2026 [GuyMalinovitch](https://github.com/GuyMalinovitch)


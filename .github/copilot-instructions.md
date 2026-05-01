# Copilot Instructions — GitHub PR Tabs

## What this project is

A **Chrome Manifest V3 extension** (no backend, no build step, no bundler) that automatically maintains a Chrome tab group named "My PRs" containing every open GitHub PR the user authored, was assigned to, or belongs to tracked team members.

## Tech stack & constraints

- **Plain ESM** everywhere — `"type": "module"` in `package.json`; `"type": "module"` on the service worker in `manifest.json`. No TypeScript, no Babel, no Webpack.
- **No runtime dependencies** — only `jest` as a dev dependency.
- **Chrome MV3 service worker**: `background.js` runs as an ephemeral service worker. Chrome may kill and restart it at any time. **Never rely on module-level variables for persistent state** — always read from `chrome.storage.local` at the start of each function. (`syncInFlight` is the only intentional module-level var; it guards against concurrent sync runs within a single worker lifetime.)
- **`chrome.windows.getCurrent()` is not available in MV3 service workers** — use `chrome.windows.getLastFocused({ windowTypes: ['normal'] })` instead (see `resolveWindowForGroup` in `tabgroup.js`).
- The extension loads directly from source — refresh the extension card in `chrome://extensions/` after any code change. No compile step needed.

## File map

| File | Role |
|------|------|
| `manifest.json` | Extension manifest; permissions, CSP, service worker entry |
| `background.js` | Service worker: alarm scheduling, sync orchestration, tab lifecycle listeners, message handler |
| `github.js` | GitHub Search API client: pagination, auth, error codes |
| `state.js` | **Pure functions only** — diff computation, PR role annotation, tab entry construction, popup helpers |
| `tabgroup.js` | Chrome tab/tabGroup API wrappers |
| `popup.html` / `popup.css` / `popup.js` | 340 px extension popup, two views: PR list and Settings |
| `icons/generate.js` | Zero-dependency icon generator (run with `node icons/generate.js`) |
| `tests/github.test.js` | Unit tests for `github.js` |
| `tests/state.test.js` | Unit tests for `state.js` |
| `jest.setup.js` | Exposes `jest` as a global so test files can use `jest.fn()` without importing it |

## Module responsibilities & boundaries

### `github.js`
- All HTTP calls to the GitHub API live here; nothing else touches `fetch`.
- Errors are thrown as `Object.assign(new Error(…), { code: 'UNAUTHORIZED' | 'RATE_LIMITED' | 'API_ERROR' })`.
- `parseLinkNext` **validates pagination URLs are on `api.github.com`** before returning them (prevents token exfiltration via malicious `Link` headers).
- `fetchMyPRs` runs the `author:` and `assignee:` queries **in parallel** and deduplicates by `html_url`.
- `fetchTeamPRs` runs one `author:` query per team member **in parallel** and deduplicates.
- `customFilter` is appended to every query; whitespace-separated tokens are joined with `+`.

### `state.js`
- **No Chrome APIs** — fully pure and synchronous (except `relativeTime`).
- This is the only module with comprehensive unit tests.
- `buildTabEntry` strips `https://api.github.com/repos/` prefix from `repository_url` to store a clean `org/repo` string.
- PR `role` values: `'authored'` | `'assigned'` | `'team'`.
- Team PRs also carry an `author` field (the teammate's login).

### `tabgroup.js`
- Wraps `chrome.tabs` and `chrome.tabGroups`; all functions `try/catch` Chrome errors silently (stale IDs are expected).
- `removeTabSafely` verifies `tab.url.startsWith(base)` before removing (strips query params for comparison).
- `ensureTabInGroup` re-groups tabs the user dragged out; called on every sync pass.

### `background.js`
- `setup()` — recreate the alarm; called on install, startup, and when the popup saves new settings.
- `sync()` — single-flight guard → `_sync()`.
- `_sync()` — read storage → fetch → diff → close tabs → open tabs → reconcile metadata → re-group → write storage.
- Tab lifecycle listeners clean `tabState` when the user closes or navigates away from a PR tab.
- Only accepts messages from `sender.id === chrome.runtime.id`.

### `popup.js`
- Two views toggled by `showPRView()` / `showSettingsView()`.
- All user-controlled strings go through `escHtml()` before `innerHTML` — never bypass this.
- Settings changes send `{ type: 'sync' }` or `{ type: 'setup' }` to the background to apply immediately.

## `chrome.storage.local` schema

```js
{
  authToken: "ghp_…",                // GitHub PAT
  username: "github-login",           // resolved via GET /user on token save
  refreshIntervalMinutes: 5,          // 1 | 5 | 15 | 30
  customFilter: "org:my-org",         // extra GitHub search qualifiers (may be empty)
  teamUsernames: "alice, @bob",       // raw comma-separated input; parsed in background.js
  groupId: 42,                        // chrome.tabGroups ID (null if no group yet)
  lastSyncedAt: 1714123456789,        // Date.now() timestamp of last successful sync
  lastError: null,                    // null | "UNAUTHORIZED" | "RATE_LIMITED" | "API_ERROR"
  tabState: {
    "https://github.com/org/repo/pull/1": {
      tabId: 1234, windowId: 1,
      number: 1, title: "Fix the thing", repo: "org/repo",
      role: "authored",               // "authored" | "assigned" | "team"
      // author: "alice"             // only present when role === "team"
    }
  }
}
```

## Testing

```bash
npm test                              # run all 21 unit tests (Jest 29, ESM)
npm test -- --watch                   # watch mode
npm test -- tests/github.test.js      # single file
```

- Tests only cover `github.js` and `state.js` (pure modules). `tabgroup.js` and `background.js` require Chrome APIs and are tested manually.
- `global.fetch` is monkey-patched in tests; always reset it in `afterEach` (see existing tests for the pattern).
- Tests use `jest.fn()` available as a global (set up in `jest.setup.js`).

## Packaging

```bash
npm run pack    # produces github-pr-tabs.zip for the Chrome Web Store
```

The zip includes only the files listed in `package.json`'s `pack` script — do not add new source files without also adding them there.

## Security rules — never violate these

1. **All PR-sourced strings** (title, repo, number, author) must pass through `escHtml()` before being set via `innerHTML`.
2. **Token only to `api.github.com`** — never log it, never put it in a URL, never send it anywhere else.
3. **`parseLinkNext` origin check** — if you modify pagination logic, keep the `startsWith('https://api.github.com/')` guard.
4. **Message handler** must keep the `sender.id === chrome.runtime.id` check.

## Common gotchas

- Adding a new setting: update `chrome.storage.local.get(…)` in `background.js` (`_sync` and `setup`), in `popup.js` (`loadSettings`), and in `signOut` (to clear it).
- If a new module needs Chrome APIs, do not add unit tests for it — document it in `README.md`'s Testing section instead.
- The tab group title is hardcoded as `'My PRs'` and color as `'blue'` in `tabgroup.js → createGroup`.
- `teamUsernames` input allows `@`-prefixed names and the current user's own username — both are stripped in `parseTeamUsernames` in `background.js`.

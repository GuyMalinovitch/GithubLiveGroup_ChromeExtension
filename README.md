# GitHub PR Tabs

> A Chrome extension that automatically maintains a live tab group for all your open GitHub pull requests — both authored and assigned to you.

![Chrome](https://img.shields.io/badge/Chrome-MV3-blue?logo=googlechrome)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Features

- 🗂️ **Live tab group** — opens one tab per open PR, grouped under "My PRs"
- 👤 **Authored + assigned** — tracks PRs you created and PRs assigned to you
- 🔄 **Auto-sync** — polls GitHub on a configurable interval (1 / 5 / 15 / 30 min)
- ❌ **Auto-close** — removes tabs for PRs that are merged or closed
- 🔒 **100% local** — your PAT never leaves your browser; no servers, no telemetry
- 🌐 **All repos** — works across all organisations and repositories you have access to

---

## Installation

### From the Chrome Web Store *(recommended)*

> *(Link will appear here once the extension is published)*

### Load unpacked (developer mode)

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right)
4. Click **Load unpacked** and select the project folder
5. The extension icon appears in your toolbar

---

## Setup

### 1. Create a GitHub Personal Access Token

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)**
2. Click **Generate new token (classic)**
3. Give it a name like `GitHub PR Tabs`
4. Select the following scope:
   - ✅ `repo` — required to see PRs in private repositories
   - *(If you only use public repos, `public_repo` is sufficient)*
5. Click **Generate token** and copy it immediately

### 2. Enter the token in the extension

1. Click the extension icon in Chrome's toolbar
2. Click the **⚙ gear icon** to open settings
3. Paste your token into the **GitHub Personal Access Token** field
4. Click **Save** — the extension confirms your GitHub username
5. Choose your preferred **sync interval**
6. Click **Sync Now** or wait for the first automatic sync

Your PRs will open in a new Chrome tab group called **My PRs**.

---

## Usage

| Action | How |
|--------|-----|
| View all PRs | Click the extension icon |
| Jump to a PR | Click any PR in the popup list |
| Sync immediately | Click ⟳ in the popup header, or **Sync Now** in settings |
| Change interval | Settings → Sync Interval |
| Sign out / remove token | Settings → **Sign Out** |

The extension shows:
- **Authored** — PRs you opened
- **Assigned** — PRs assigned to you (deduped with authored)
- Last sync time and error status in the header

---

## Permissions

| Permission | Why it's needed |
|------------|----------------|
| `tabs` | Open, focus, and close PR tabs |
| `tabGroups` | Create and manage the "My PRs" tab group |
| `storage` | Store your PAT and settings locally |
| `alarms` | Schedule periodic sync without a persistent background page |
| `https://api.github.com/*` | Fetch your pull requests from the GitHub API |

No other host permissions are requested. Your token is only ever sent to `api.github.com`.

---

## Privacy

Your GitHub token is stored in `chrome.storage.local` — it never leaves your browser except to authenticate with the GitHub API. No analytics, no telemetry, no external servers. See [PRIVACY.md](PRIVACY.md) for the full privacy policy.

---

## Development

### Prerequisites

- Node.js 18+
- npm

### Install dev dependencies

```bash
npm install
```

### Run tests

```bash
npm test
```

### Build a store-ready ZIP

```bash
npm run pack
```

This creates `github-pr-tabs.zip` containing only the files needed by Chrome (no `node_modules`, no tests).

### Project structure

```
github-pr-tabs/
├── manifest.json       # Chrome extension manifest (MV3)
├── background.js       # Service worker: sync loop, tab lifecycle
├── github.js           # GitHub API client with pagination
├── state.js            # Pure state functions (fully unit tested)
├── tabgroup.js         # Chrome tab group manager
├── popup.html          # Extension popup markup
├── popup.css           # Popup styles (dark GitHub theme)
├── popup.js            # Popup logic and event handling
├── icons/              # Extension icons (16, 32, 48, 128 px)
└── tests/              # Jest unit tests
```

---

## Chrome Web Store Submission Notes

Before publishing, you must:

1. **Create a developer account** at [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole) ($5 one-time fee)
2. **Host the privacy policy** at a stable URL (e.g. GitHub Pages) and paste it into the store listing
3. **Take screenshots** — the store requires at least one screenshot at 1280×800 or 640×400 pixels
4. **Run `npm run pack`** to generate the ZIP to upload

---

## License

[MIT](LICENSE) © 2026

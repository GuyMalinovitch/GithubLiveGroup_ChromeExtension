# Privacy Policy — GitHub PR Tabs

*Last updated: 2026-04-26*

## Overview

GitHub PR Tabs is a Chrome extension that displays your open GitHub pull requests in a managed tab group. This policy explains what data the extension accesses, how it is used, and how it is protected.

---

## Data Collected

| Data | Purpose | Where it is stored |
|------|---------|-------------------|
| GitHub Personal Access Token (PAT) | Authenticate with the GitHub API | `chrome.storage.local` (local device only) |
| GitHub username | Display "Connected as @username" in the popup | `chrome.storage.local` (local device only) |
| Sync interval preference | Schedule automatic refresh | `chrome.storage.local` (local device only) |
| Pull request list (title, URL, repo, number) | Render the popup PR list and maintain tab group | `chrome.storage.local` (local device only) |

---

## How Data Is Used

- The **PAT** is sent exclusively to `https://api.github.com` to fetch your open pull requests via the GitHub Search API (`/search/issues`) and to verify your identity (`/user`). It is transmitted over HTTPS and is never included in URL query parameters.
- **Pull request data** is used only to open and maintain tabs in Chrome. It is not read by or shared with any party other than the GitHub API.
- **No data is sent to any third-party server**, analytics service, or external service other than `https://api.github.com`.
- **No advertising**, profiling, or tracking of any kind is performed.

---

## Data Storage

All data is stored in `chrome.storage.local`, which is:

- **Local to your device** — it is never synced across devices via Google's servers
- **Accessible only to this extension** — other extensions and web pages cannot read it
- **Never transmitted** to any server controlled by the extension developer

---

## Data Retention and Deletion

You can delete all stored data at any time:

- **Sign Out** button in the extension settings removes the PAT, username, and all PR state
- **Uninstalling** the extension removes all locally stored data permanently

---

## Permissions Justification

| Chrome Permission | Justification |
|-------------------|--------------|
| `tabs` | Required to open PR tabs, focus existing tabs, and close tabs for merged/closed PRs |
| `tabGroups` | Required to create and manage the "My PRs" tab group |
| `storage` | Required to persist your PAT and settings between browser sessions |
| `alarms` | Required to schedule periodic sync without a persistent background page |
| `https://api.github.com/*` | Required to call the GitHub REST API to fetch pull requests |

No other permissions are requested. No broad host permissions (`<all_urls>`, `http://*/*`) are used.

---

## Third Parties

This extension communicates only with the **GitHub REST API** (`https://api.github.com`). It does not use any analytics SDKs, crash reporters, advertising networks, or other third-party services.

---

## Changes to This Policy

If this policy changes, the updated version will be published at the same URL. Significant changes will also be noted in the extension's version changelog.

---

## Contact

For questions or concerns about this privacy policy, please open an issue in the extension's source repository.

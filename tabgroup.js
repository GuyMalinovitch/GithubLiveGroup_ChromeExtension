/**
 * Try to retrieve the stored group. Returns the group object if still alive,
 * or null if it no longer exists. Clears stale groupId from storage on miss.
 */
export async function findGroup(storedGroupId) {
  if (storedGroupId == null) return null;
  try {
    return await chrome.tabGroups.get(storedGroupId);
  } catch {
    return null;
  }
}

/**
 * Create a new "My PRs" tab group containing the given tab.
 * Saves the new groupId to storage.
 *
 * NOTE: chrome.tabs.group expects windowId inside createProperties, not at the top level.
 */
export async function createGroup(tabId, windowId, title = 'My PRs', color = 'blue') {
  const groupId = await chrome.tabs.group({
    tabIds: [tabId],
    createProperties: { windowId },
  });
  await chrome.tabGroups.update(groupId, { title, color });
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
    // Tab gone — state cleanup handled by onRemoved listener in background.js
  }
}

/**
 * Get the windowId of the window containing the group.
 * Falls back to the last focused normal window if the group is gone.
 */
export async function resolveWindowForGroup(group) {
  if (group) return group.windowId;
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  return win.id;
}

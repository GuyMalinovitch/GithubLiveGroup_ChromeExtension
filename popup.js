import { groupByRole, groupTeamByAuthor, relativeTime } from './state.js';
import { startDeviceFlow, pollOnce } from './auth.js';
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
  const { authored, assigned, team } = groupByRole(tabState);

  hideAllStates();

  if (lastError === 'UNAUTHORIZED') {
    showState('state-error');
    $('error-msg').textContent = 'Authorization failed — sign out and sign in again.';
    return;
  }
  if (lastError === 'RATE_LIMITED') {
    showState('state-error');
    $('error-msg').textContent = 'GitHub rate limit reached. Retrying next tick.';
    return;
  }

  if (authored.length === 0 && assigned.length === 0 && team.length === 0) {
    showState('state-empty');
    return;
  }

  $('pr-list').classList.remove('hidden');
  $('sync-status').textContent = relativeTime(lastSyncedAt);

  renderGroup('authored-list', 'authored-count', authored);
  renderGroup('assigned-list', 'assigned-count', assigned);
  renderTeamSections(groupTeamByAuthor(team));
}

function renderGroup(listId, countId, items) {
  const list = $(listId);
  const countEl = $(countId);
  list.innerHTML = '';
  countEl.textContent = items.length;

  const header = list.closest('section').querySelector('.section-header');
  if (items.length > 0) {
    header.classList.add('open');
    list.classList.remove('hidden');
  }

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'pr-item';
    const authorTag = item.author ? ` · @${escHtml(item.author)}` : '';
    li.innerHTML = `
      <span class="pr-number">#${escHtml(String(item.number))}</span>
      <div class="pr-body">
        <span class="pr-title" title="${escHtml(item.title)}">${escHtml(item.title)}</span>
        <span class="pr-repo">${escHtml(item.repo)}${authorTag}</span>
      </div>`;
    li.addEventListener('click', () => focusPRTab(item));
    list.appendChild(li);
  }
}

function renderTeamSections(byAuthor) {
  const container = $('team-sections');
  container.innerHTML = '';
  for (const [author, items] of Object.entries(byAuthor)) {
    const listId = `team-list-${author}`;
    const countId = `team-count-${author}`;
    const section = document.createElement('section');
    section.innerHTML = `
      <button class="section-header" data-target="${listId}">
        <span class="chevron">▸</span>
        <span class="section-label">${escHtml(author.toUpperCase())}</span>
        <span class="section-count" id="${countId}">0</span>
      </button>
      <ul id="${listId}" class="pr-group hidden"></ul>`;
    section.querySelector('.section-header').addEventListener('click', () => {
      const isOpen = section.querySelector('.section-header').classList.toggle('open');
      section.querySelector(`#${listId}`).classList.toggle('hidden', !isOpen);
    });
    container.appendChild(section);
    renderGroup(listId, countId, items);
  }
}

function hideAllStates() {
  for (const id of ['state-no-token', 'state-auth-pending', 'state-loading', 'state-error', 'state-empty', 'pr-list']) {
    $(id).classList.add('hidden');
  }
}

function showState(id) {
  hideAllStates();
  $(id).classList.remove('hidden');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Tab focus ───────────

async function focusPRTab(item) {
  try {
    await chrome.tabs.update(item.tabId, { active: true });
    await chrome.windows.update(item.windowId, { focused: true });
  } catch {
    // Tab gone — open fresh
    await chrome.tabs.create({ url: item.url, active: true });
  }
}

// ── OAuth Flow Device ────────────────────────

let pollTimer = null;

function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

async function startOAuthFlow() {
  showState('state-loading');
  let flowData;
  try {
    flowData = await startDeviceFlow();
  } catch {
    showState('state-error');
    $('error-msg').textContent = 'Could not reach GitHub. Check your connection.';
    return;
  }

  const { device_code, user_code, verification_uri, expires_in, interval } = flowData;
  const expiresAt = Date.now() + expires_in * 1000;

  // Persist so the background alarm can poll if the popup is closed
  await chrome.storage.local.set({ pendingAuth: { device_code, expiresAt, interval } });
  chrome.runtime.sendMessage({ type: 'startAuthPoll' }).catch(() => {});

  $('user-code-display').textContent = user_code;
  $('device-link').href = verification_uri;
  showState('state-auth-pending');

  schedulePopupPoll(device_code, interval, expiresAt);
}

function schedulePopupPoll(device_code, intervalSecs, expiresAt) {
  stopPolling();
  if (Date.now() > expiresAt) { onAuthExpired(); return; }
  pollTimer = setTimeout(async () => {
    try {
      const result = await pollOnce(device_code);
      if (result.status === 'ok') {
        await onAuthSuccess(result.token);
      } else if (result.status === 'expired') {
        onAuthExpired();
      } else if (result.status === 'denied') {
        await cancelAuth();
        showState('state-no-token');
      } else {
        const next = result.status === 'slow_down' ? (result.newInterval ?? intervalSecs) : intervalSecs;
        schedulePopupPoll(device_code, next, expiresAt);
      }
    } catch {
      // Network hiccup — retry on next tick
      schedulePopupPoll(device_code, intervalSecs, expiresAt);
    }
  }, intervalSecs * 1000);
}

async function onAuthSuccess(token) {
  stopPolling();
  let username;
  try {
    username = await getAuthenticatedUser(token);
  } catch {
    showState('state-error');
    $('error-msg').textContent = 'Authorized, but could not fetch your username.';
    return;
  }
  await chrome.storage.local.set({ authToken: token, username, authType: 'oauth' });
  await chrome.storage.local.remove('pendingAuth');
  chrome.runtime.sendMessage({ type: 'setup' }).catch(() => {});
  await loadView();
}

function onAuthExpired() {
  stopPolling();
  chrome.storage.local.remove('pendingAuth');
  showState('state-error');
  $('error-msg').textContent = 'Authorization timed out. Please try again.';
}

async function cancelAuth() {
  stopPolling();
  await chrome.storage.local.remove('pendingAuth');
}

/** On popup open: if a device flow was already started, resume fast polling. */
async function resumePendingAuth() {
  const { pendingAuth } = await chrome.storage.local.get('pendingAuth');
  if (!pendingAuth) return false;
  if (Date.now() > pendingAuth.expiresAt) {
    await chrome.storage.local.remove('pendingAuth');
    return false;
  }
  // user_code is not re-fetched — instruct user to check the tab they opened
  $('user-code-display').textContent = '(see previously opened tab)';
  $('device-link').href = 'https://github.com/login/device';
  showState('state-auth-pending');
  schedulePopupPoll(pendingAuth.device_code, pendingAuth.interval ?? 5, pendingAuth.expiresAt);
  return true;
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadSettings() {
  const { authToken, username, refreshIntervalMinutes = 5, customFilter = '', teamUsernames = '' } =
    await chrome.storage.local.get(['authToken', 'username', 'refreshIntervalMinutes', 'customFilter', 'teamUsernames']);

  const status = $('auth-status');
  const signinBtn = $('signin-settings-btn');
  const togglePatBtn = $('toggle-pat-btn');
  const patSection = $('pat-section');
  if (authToken) {
    status.className = 'auth-status ok';
    status.textContent = username ? `Connected as @${escHtml(username)}` : 'Connected';
    signinBtn.classList.add('hidden');
    togglePatBtn.classList.add('hidden');
    patSection.classList.add('hidden');
  } else {
    status.className = 'auth-status';
    status.textContent = 'Not signed in.';
    signinBtn.classList.remove('hidden');
    togglePatBtn.classList.remove('hidden');
  }

  $('interval-select').value = String(refreshIntervalMinutes);
  $('filter-input').value = customFilter;
  $('team-usernames-input').value = teamUsernames;
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
    await chrome.storage.local.set({ authToken: token, username, authType: 'pat' });
    status.className = 'auth-status ok';
    status.textContent = `Connected as @${escHtml(username)}`;
    $('token-input').value = '';
    $('pat-section').classList.add('hidden');
    $('toggle-pat-btn').classList.add('hidden');
    $('signin-settings-btn').classList.add('hidden');
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

async function saveFilter() {
  const customFilter = $('filter-input').value.trim();
  await chrome.storage.local.set({ customFilter });
  chrome.runtime.sendMessage({ type: 'sync' });
}

async function saveTeamUsernames() {
  const teamUsernames = $('team-usernames-input').value.trim();
  await chrome.storage.local.set({ teamUsernames });
  chrome.runtime.sendMessage({ type: 'sync' });
}

async function signOut() {
  stopPolling();
  await chrome.storage.local.clear();
  await chrome.alarms.clearAll();
  $('auth-status').textContent = '';
  $('filter-input').value = '';
  $('team-usernames-input').value = '';
  $('token-input').value = '';
  showPRView();
  showState('state-no-token');
}

// ── Section collapse / expand ─────────────────────────────────────────────────

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
  try {
    await chrome.runtime.sendMessage({ type: 'sync' });
  } catch {
    // service worker may have been sleeping — message still triggers wake
  }
  await loadView();
}

// ── Storage change listener — auto-update when background alarm completes auth ─

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.authToken?.newValue && !inSettings) {
    stopPolling();
    loadView();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function loadView() {
  const { authToken, tabState = {}, lastSyncedAt, lastError } =
    await chrome.storage.local.get(['authToken', 'tabState', 'lastSyncedAt', 'lastError']);

  if (!authToken) {
    const resumed = await resumePendingAuth();
    if (!resumed) showState('state-no-token');
    return;
  }

  renderPRList(tabState, lastSyncedAt, lastError);
  $('sync-status').textContent = relativeTime(lastSyncedAt);
}

// ── Event wiring ──────────────────────────────────────────────────────────────

$('settings-btn').addEventListener('click', () => {
  if (inSettings) { showPRView(); loadView(); }
  else { showSettingsView(); loadSettings(); }
});

$('sync-btn').addEventListener('click', triggerSync);
$('signin-btn').addEventListener('click', startOAuthFlow);
$('use-pat-btn').addEventListener('click', () => { showSettingsView(); loadSettings(); $('pat-section').classList.remove('hidden'); });
$('signin-settings-btn').addEventListener('click', () => { showPRView(); startOAuthFlow(); });
$('toggle-pat-btn').addEventListener('click', () => { $('pat-section').classList.toggle('hidden'); });
$('save-token-btn').addEventListener('click', saveToken);
$('cancel-auth-btn').addEventListener('click', async () => { await cancelAuth(); showState('state-no-token'); });
$('interval-select').addEventListener('change', saveInterval);
$('filter-input').addEventListener('change', saveFilter);
$('team-usernames-input').addEventListener('change', saveTeamUsernames);
$('sync-now-settings-btn').addEventListener('click', triggerSync);
$('signout-btn').addEventListener('click', signOut);

// Kick off
showState('state-loading');
loadView();

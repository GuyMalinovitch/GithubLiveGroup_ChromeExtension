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

  const header = list.closest('section').querySelector('.section-header');
  if (items.length > 0) {
    header.classList.add('open');
    list.classList.remove('hidden');
  }

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'pr-item';
    li.innerHTML = `
      <span class="pr-number">#${escHtml(String(item.number))}</span>
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
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

  $('interval-select').value = String(refreshIntervalMinutes);
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

// ── Event wiring ──────────────────────────────────────────────────────────────

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

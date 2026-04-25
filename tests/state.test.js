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

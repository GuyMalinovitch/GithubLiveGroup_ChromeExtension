import { parseLinkNext, getAuthenticatedUser, fetchMyPRs, fetchTeamPRs } from '../github.js';

afterEach(() => {
  global.fetch = undefined;
});

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

test('parseLinkNext rejects off-origin URLs', () => {
  const header = '<https://attacker.example.com/steal>; rel="next"';
  expect(parseLinkNext(header)).toBe(null);
});

test('getAuthenticatedUser returns login', async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true, status: 200,
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

test('fetchMyPRs merges and deduplicates authored and assigned PRs', async () => {
  const authoredPR = { html_url: 'https://github.com/org/repo/pull/1', number: 1, title: 'PR1', user: { login: 'testuser' }, repository_url: 'https://api.github.com/repos/org/repo', assignees: [] };
  const assignedPR = { html_url: 'https://github.com/org/repo/pull/2', number: 2, title: 'PR2', user: { login: 'other'  }, repository_url: 'https://api.github.com/repos/org/repo', assignees: [{ login: 'testuser' }] };
  const dupPR      = { html_url: 'https://github.com/org/repo/pull/1', number: 1, title: 'PR1', user: { login: 'testuser' }, repository_url: 'https://api.github.com/repos/org/repo', assignees: [{ login: 'testuser' }] };

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
    .mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ items: [pr1] }),
      headers: { get: (h) => h === 'Link' ? '<https://api.github.com/search/issues?page=2>; rel="next"' : null },
    })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [pr2] }), headers: { get: () => null } })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [] }), headers: { get: () => null } });

  const prs = await fetchMyPRs('ghp_token', 'testuser');
  expect(prs).toHaveLength(2);
});

test('fetchMyPRs throws RATE_LIMITED on 403', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403, headers: { get: () => null } });
  await expect(fetchMyPRs('ghp_token', 'user')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
});

test('fetchMyPRs appends customFilter to both queries', async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ items: [] }),
    headers: { get: () => null },
  });

  await fetchMyPRs('ghp_token', 'testuser', 'org:my-org -label:wip');

  const urls = fetch.mock.calls.map(c => c[0]);
  expect(urls[0]).toContain('org:my-org+-label:wip');
  expect(urls[1]).toContain('org:my-org+-label:wip');
});

// --- fetchTeamPRs ---

test('fetchTeamPRs returns empty array for empty username list', async () => {
  global.fetch = jest.fn();
  const prs = await fetchTeamPRs('ghp_token', []);
  expect(prs).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});

test('fetchTeamPRs fetches authored PRs for each team member', async () => {
  const pr1 = { html_url: 'https://github.com/org/repo/pull/3', number: 3, title: 'PR3', user: { login: 'alice' }, repository_url: 'https://api.github.com/repos/org/repo', assignees: [] };
  const pr2 = { html_url: 'https://github.com/org/repo/pull/4', number: 4, title: 'PR4', user: { login: 'bob' }, repository_url: 'https://api.github.com/repos/org/repo', assignees: [] };

  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [pr1] }), headers: { get: () => null } })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [pr2] }), headers: { get: () => null } });

  const prs = await fetchTeamPRs('ghp_token', ['alice', 'bob']);
  expect(prs).toHaveLength(2);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][0]).toContain('author:alice');
  expect(fetch.mock.calls[1][0]).toContain('author:bob');
});

test('fetchTeamPRs deduplicates PRs shared across team members', async () => {
  const sharedPR = { html_url: 'https://github.com/org/repo/pull/1', number: 1, title: 'PR1', user: { login: 'alice' }, repository_url: 'https://api.github.com/repos/org/repo', assignees: [] };

  global.fetch = jest.fn()
    .mockResolvedValue({ ok: true, status: 200, json: async () => ({ items: [sharedPR] }), headers: { get: () => null } });

  const prs = await fetchTeamPRs('ghp_token', ['alice', 'bob']);
  expect(prs).toHaveLength(1);
});

test('fetchTeamPRs appends customFilter to queries', async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ items: [] }),
    headers: { get: () => null },
  });

  await fetchTeamPRs('ghp_token', ['alice'], 'org:my-org');
  expect(fetch.mock.calls[0][0]).toContain('org:my-org');
});

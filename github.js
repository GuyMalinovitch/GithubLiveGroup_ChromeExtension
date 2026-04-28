const BASE = 'https://api.github.com';

function headers(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export function parseLinkNext(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  if (!match) return null;
  const url = match[1];
  // Only follow pagination URLs on the trusted GitHub API origin
  if (!url.startsWith('https://api.github.com/')) return null;
  return url;
}

async function fetchAllPages(url, token) {
  const results = [];
  let nextUrl = url;
  while (nextUrl) {
    const res = await fetch(nextUrl, { headers: headers(token) });
    if (res.status === 401) throw Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED' });
    if (res.status === 403) throw Object.assign(new Error('GitHub API: rate limited'), { code: 'RATE_LIMITED' });
    if (!res.ok) throw Object.assign(new Error(`GitHub API error: ${res.status}`), { code: 'API_ERROR' });
    const data = await res.json();
    const items = data?.items;
    if (!Array.isArray(items)) {
      throw Object.assign(new Error('GitHub API: unexpected response shape'), { code: 'API_ERROR' });
    }
    results.push(...items);
    nextUrl = parseLinkNext(res.headers.get('Link'));
  }
  return results;
}

export async function getAuthenticatedUser(token) {
  const res = await fetch(`${BASE}/user`, { headers: headers(token) });
  if (res.status === 401) throw Object.assign(new Error('GitHub API: unauthorized'), { code: 'UNAUTHORIZED' });
  if (!res.ok) throw Object.assign(new Error(`GitHub API: error ${res.status}`), { code: 'API_ERROR' });
  const data = await res.json();
  return data.login;
}

export async function fetchTeamPRs(token, teamUsernames, customFilter = '') {
  if (!teamUsernames || teamUsernames.length === 0) return [];
  const extra = customFilter.trim()
    ? '+' + customFilter.trim().split(/\s+/).join('+')
    : '';
  const pages = await Promise.all(
    teamUsernames.map(u =>
      fetchAllPages(
        `${BASE}/search/issues?q=is:pr+is:open+author:${encodeURIComponent(u)}${extra}&per_page=100`,
        token
      )
    )
  );
  const seen = new Set();
  const merged = [];
  for (const prs of pages) {
    for (const pr of prs) {
      if (!seen.has(pr.html_url)) {
        seen.add(pr.html_url);
        merged.push(pr);
      }
    }
  }
  return merged;
}

export async function fetchMyPRs(token, username, customFilter = '') {
  // Split custom filter on whitespace, join with + (GitHub search qualifier separator)
  const extra = customFilter.trim()
    ? '+' + customFilter.trim().split(/\s+/).join('+')
    : '';
  const [authored, assigned] = await Promise.all([
    fetchAllPages(
      `${BASE}/search/issues?q=is:pr+is:open+author:${encodeURIComponent(username)}${extra}&per_page=100`,
      token
    ),
    fetchAllPages(
      `${BASE}/search/issues?q=is:pr+is:open+assignee:${encodeURIComponent(username)}${extra}&per_page=100`,
      token
    ),
  ]);
  const seen = new Set();
  const merged = [];
  for (const pr of [...authored, ...assigned]) {
    if (!seen.has(pr.html_url)) {
      seen.add(pr.html_url);
      merged.push(pr);
    }
  }
  return merged;
}

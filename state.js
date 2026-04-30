export function computeDiff(fetchedPRs, tabState) {
  const fetchedUrls = new Set(fetchedPRs.map(pr => pr.html_url));
  const storedUrls = Object.keys(tabState);
  const newPRs = fetchedPRs.filter(pr => !tabState[pr.html_url]);
  const closedUrls = storedUrls.filter(url => !fetchedUrls.has(url));
  return { newPRs, closedUrls };
}

export function annotatePRRole(pr, username) {
  const isAuthor = pr.user.login.toLowerCase() === username.toLowerCase();
  return { ...pr, role: isAuthor ? 'authored' : 'assigned' };
}

export function annotateTeamPRRole(pr) {
  return { ...pr, role: 'team', author: pr.user.login };
}

export function buildTabEntry(pr, tabId, windowId) {
  const repo = pr.repository_url.replace('https://api.github.com/repos/', '');
  const entry = { tabId, windowId, number: pr.number, title: pr.title, repo, role: pr.role };
  if (pr.role === 'team') entry.author = pr.author;
  return entry;
}

export function groupTeamByAuthor(teamItems) {
  const byAuthor = {};
  for (const item of teamItems) {
    const author = item.author || 'unknown';
    if (!byAuthor[author]) byAuthor[author] = [];
    byAuthor[author].push(item);
  }
  return Object.fromEntries(Object.keys(byAuthor).sort().map(k => [k, byAuthor[k]]));
}

export function groupByRole(tabState) {
  const authored = [];
  const assigned = [];
  const team = [];
  for (const [url, entry] of Object.entries(tabState)) {
    const item = { url, ...entry };
    if (entry.role === 'authored') authored.push(item);
    else if (entry.role === 'assigned') assigned.push(item);
    else team.push(item);
  }
  return { authored, assigned, team };
}

export function relativeTime(timestamp) {
  if (!timestamp) return 'never';
  const mins = Math.floor((Date.now() - timestamp) / 60000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 min ago';
  if (mins < 60) return `${mins} mins ago`;
  const hrs = Math.floor(mins / 60);
  return hrs === 1 ? '1 hr ago' : `${hrs} hrs ago`;
}

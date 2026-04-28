// Replace with the Client ID from your GitHub OAuth App
// (Settings → Developer settings → OAuth Apps → your app)
// Device Flow does NOT need a client_secret.
const CLIENT_ID = 'YOUR_CLIENT_ID';
const SCOPES = 'repo';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/**
 * Step 1: request a device + user code from GitHub.
 * Returns { device_code, user_code, verification_uri, expires_in, interval }
 */
export async function startDeviceFlow() {
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `client_id=${encodeURIComponent(CLIENT_ID)}&scope=${encodeURIComponent(SCOPES)}`,
  });
  if (!res.ok) throw new Error(`GitHub device flow error: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return data; // { device_code, user_code, verification_uri, expires_in, interval }
}

/**
 * Step 2: poll once for the access token.
 * Returns { status, token?, newInterval? }
 *   status: 'ok' | 'pending' | 'slow_down' | 'expired' | 'denied'
 */
export async function pollOnce(device_code) {
  const res = await fetch(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: [
      `client_id=${encodeURIComponent(CLIENT_ID)}`,
      `device_code=${encodeURIComponent(device_code)}`,
      `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:device_code')}`,
    ].join('&'),
  });

  if (!res.ok) throw new Error(`Token poll error: ${res.status}`);
  const data = await res.json();

  if (data.access_token) {
    // Verify GitHub granted the scope we need
    const granted = (data.scope || '').split(',').map(s => s.trim());
    if (!granted.includes('repo')) {
      return { status: 'denied' }; // user unchecked the repo scope
    }
    return { status: 'ok', token: data.access_token };
  }

  switch (data.error) {
    case 'authorization_pending': return { status: 'pending' };
    case 'slow_down':             return { status: 'slow_down', newInterval: (data.interval || 5) + 5 };
    case 'expired_token':         return { status: 'expired' };
    case 'access_denied':         return { status: 'denied' };
    default:                      throw new Error(data.error_description || data.error || 'Unknown error');
  }
}

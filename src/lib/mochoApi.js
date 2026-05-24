/**
 * MOCHO API Client for Chrome Extension.
 * All calls to getmocho.com backend go through here.
 */

const BASE_URL = 'https://getmocho.com/api/ext';

async function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['apiKey'], (result) => {
      resolve(result.apiKey || null);
    });
  });
}

async function apiFetch(path, options = {}) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    return { ok: false, error: 'No API key configured. Open extension options to add one.' };
  }

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });

    const json = await response.json().catch(() => ({}));

    if (!response.ok) {
      return { ok: false, error: json.error || `Request failed (${response.status})` };
    }

    return { ok: true, data: json };
  } catch (err) {
    return { ok: false, error: 'Cannot connect to MOCHO. Check your internet connection.' };
  }
}

/** Verify API key and return user info. Used by options page "Test Connection". */
export async function verifyConnection() {
  return apiFetch('/me');
}

/** Get all sites connected to the user's MOCHO account. */
export async function getSites() {
  return apiFetch('/sites');
}

/**
 * Check if a domain is connected to the user's MOCHO account.
 * Pass the bare domain: "example.com" (no https://, no trailing slash).
 */
export async function matchDomain(domain) {
  return apiFetch(`/sites/match?domain=${encodeURIComponent(domain)}`);
}

/**
 * Get crawler intelligence data for a connected site.
 * Only call after matchDomain() confirms matched: true.
 */
export async function getCrawlerStats(siteId) {
  return apiFetch(`/sites/${siteId}/crawler-stats`);
}

/**
 * Post a local page scan result to MOCHO for historical tracking.
 * siteId is optional — pass if the domain matched a connected site.
 * Fire-and-forget: never await this in the main analysis flow.
 */
export async function postScanResult(payload) {
  return apiFetch('/scan-results', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

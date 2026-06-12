/**
 * public/lib/api-client.js
 *
 * API client and backend URL management extracted from public/index.html.
 *
 * Provides:
 * - URL normalization and base-URL management (query param + localStorage)
 * - Full API URL construction
 * - Auth-aware fetch wrapper (`apiFetch`)
 * - Login / OIDC URL builders and auth flow starter
 * - Backend health check and connection testing
 *
 * Browser/Frontend API Boundary
 * -----------------------------
 * These functions are loaded as a global script in index.html and are also
 * importable by Node.js tests (see test/api-client.test.js).
 * Any function that appears in both server.js and index.html should live here
 * to prevent divergence (see issue #477).
 */

/* ---------------------------------------------------------------------------
 * Constants & state
 * ------------------------------------------------------------------------ */

/** Example backend URL shown to users in prompts. */
const SANITIZED_SERVER_EXAMPLE_URL = 'https://miso-chat.example.com';

/** localStorage key for the stored API base URL. */
const API_BASE_STORAGE_KEY = 'openclaw.apiBaseUrl';

let mobileAuthInFlight = false;
let mobileAuthSettledAt = 0;

/* ---------------------------------------------------------------------------
 * URL helpers
 * ------------------------------------------------------------------------ */

/**
 * Normalize a raw URL string to a canonical origin + path.
 * - Adds `https://` prefix if no scheme is present.
 * - Strips trailing slashes.
 * - Returns '' for invalid input.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeBaseUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

    try {
        const parsed = new URL(withScheme);
        if (!['http:', 'https:'].includes(parsed.protocol)) return '';
        return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
    } catch {
        return '';
    }
}

/**
 * Return the current API base URL from query params or localStorage.
 * Query param (`?backend=`) takes priority and is persisted to localStorage.
 *
 * @returns {string}
 */
function getApiBaseUrl() {
    const fromQuery = new URLSearchParams(window.location.search).get('backend');
    if (fromQuery) {
        const normalized = normalizeBaseUrl(fromQuery);
        localStorage.setItem(API_BASE_STORAGE_KEY, normalized);
        if (typeof updateNativeBuildMarker === 'function') updateNativeBuildMarker();
        return normalized;
    }
    return normalizeBaseUrl(localStorage.getItem(API_BASE_STORAGE_KEY) || '');
}

/**
 * Persist a base URL to localStorage.
 *
 * @param {string} url
 * @returns {string} Normalized URL (or '' if invalid).
 */
function setApiBaseUrl(url) {
    const normalized = normalizeBaseUrl(url);
    if (normalized) localStorage.setItem(API_BASE_STORAGE_KEY, normalized);
    else localStorage.removeItem(API_BASE_STORAGE_KEY);
    if (typeof updateNativeBuildMarker === 'function') updateNativeBuildMarker();
    return normalized;
}

/**
 * Build the full health-check URL for a given base.
 *
 * @param {string} baseUrl
 * @returns {string}
 */
function backendHealthUrl(baseUrl) {
    return `${baseUrl}/api/health`;
}

/**
 * Build a full API URL by prepending the current base URL.
 * If no base is configured, returns the path unchanged (relative request).
 *
 * @param {string} path
 * @returns {string}
 */
function apiUrl(path) {
    const base = getApiBaseUrl();
    if (!base) return path;
    return `${base}${path}`;
}

/* ---------------------------------------------------------------------------
 * Login / OIDC helpers
 * ------------------------------------------------------------------------ */

/**
 * Build the `return_to` URL for login redirects.
 * On mobile (Capacitor), uses a deep-link scheme; otherwise the current page URL.
 *
 * @returns {string}
 */
function loginReturnToUrl() {
    const backend = getApiBaseUrl();
    if (typeof isLikelyMobile === 'function' && isLikelyMobile()) {
        const appReturn = new URL('misochat://auth/callback');
        if (backend) {
            appReturn.searchParams.set('backend', backend);
        }
        return appReturn.toString();
    }

    const current = new URL(window.location.href);
    if (backend) {
        current.searchParams.set('backend', backend);
    }
    return current.toString();
}

/**
 * Build the login page URL with return-to and mobile flags.
 *
 * @returns {string}
 */
function loginUrl() {
    const target = new URL(apiUrl('/login'), window.location.href);
    target.searchParams.set('return_to', loginReturnToUrl());
    if (typeof isLikelyMobile === 'function' && isLikelyMobile()) {
        target.searchParams.set('mobile', '1');
    }
    return target.toString();
}

/**
 * Build the OIDC authorization URL.
 *
 * @returns {string}
 */
function oidcUrl() {
    const target = new URL(apiUrl('/auth/oidc'), window.location.href);
    target.searchParams.set('return_to', loginReturnToUrl());
    target.searchParams.set('mobile', '1');
    return target.toString();
}

/**
 * Start the authentication flow.
 * On Capacitor, opens the browser via plugin; otherwise redirects.
 */
async function startAuthFlow() {
    const url = typeof isNativeCapacitor === 'function' && isNativeCapacitor() ? oidcUrl() : loginUrl();
    if (typeof isNativeCapacitor === 'function' && isNativeCapacitor()) {
        const browser = window.Capacitor?.Plugins?.Browser;
        if (browser && typeof browser.open === 'function') {
            await browser.open({ url });
            return;
        }
    }
    window.location.assign(url);
}

/* ---------------------------------------------------------------------------
 * Auth handling
 * ------------------------------------------------------------------------ */

/**
 * Handle a 401 response by starting the auth flow and throwing.
 * Guards against rapid re-entrancy with a 4-second cooldown.
 */
async function handleAuthRequired() {
    if (mobileAuthInFlight) {
        throw new Error('Authentication pending');
    }
    const justSettled = mobileAuthSettledAt && (Date.now() - mobileAuthSettledAt) < 4000;
    if (justSettled) {
        throw new Error('Authentication settling');
    }
    await startAuthFlow();
    throw new Error('Authentication required');
}

/* ---------------------------------------------------------------------------
 * API fetch wrapper
 * ------------------------------------------------------------------------ */

/**
 * Fetch wrapper that automatically handles 401 by triggering auth flow.
 * Delegates to `apiUrl()` for base URL resolution.
 *
 * @param {string} path
 * @param {RequestInit | undefined} options
 * @returns {Promise<Response>}
 */
async function apiFetch(path, options) {
    const response = await fetch(apiUrl(path), {
        credentials: 'include',
        ...(options || {}),
    });

    if (response.status === 401) {
        await handleAuthRequired();
    }

    return response;
}

/* ---------------------------------------------------------------------------
 * Backend connection testing
 * ------------------------------------------------------------------------ */

/**
 * Test connectivity to a backend URL.
 *
 * @param {string} baseUrl
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function testBackendConnection(baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) {
        return { ok: false, message: `Invalid backend URL. Enter a full URL like ${SANITIZED_SERVER_EXAMPLE_URL}` };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
        const response = await fetch(backendHealthUrl(normalized), {
            method: 'GET',
            credentials: 'include',
            signal: controller.signal,
        });

        if (!response.ok) {
            if (response.status === 404) {
                return { ok: false, message: 'Backend API not found (404). Check the backend URL.' };
            }
            if (response.status >= 500) {
                return { ok: false, message: 'Backend unavailable (5xx). Server responded with an error.' };
            }
            return { ok: false, message: `Connection test failed (${response.status}).` };
        }

        return { ok: true, message: `Connection OK: ${normalized}` };
    } catch (error) {
        const message = String(error?.message || '').toLowerCase();
        if (error?.name === 'AbortError') {
            return { ok: false, message: 'Connection test timed out after 8 seconds.' };
        }
        if (message.includes('failed to fetch') || message.includes('network')) {
            return { ok: false, message: `Backend unreachable (${normalized}). Check URL, network, or certificate.` };
        }
        return { ok: false, message: `Connection test failed: ${error?.message || 'unknown error'}` };
    } finally {
        clearTimeout(timeout);
    }
}

/* ---------------------------------------------------------------------------
 * Exports (Node.js test harness)
 * ------------------------------------------------------------------------ */

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SANITIZED_SERVER_EXAMPLE_URL,
        API_BASE_STORAGE_KEY,
        normalizeBaseUrl,
        apiUrl,
        backendHealthUrl,
        testBackendConnection,
    };
}

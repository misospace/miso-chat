/**
 * public/lib/session-key-hydration.js
 *
 * Session key persistence and hydration extracted from public/index.html.
 *
 * Manages the lifecycle of the selected session key across page loads:
 *   1. On startup, `hydrateStoredSessionKey()` reads from secure storage
 *      (with localStorage fallback migration).
 *   2. After login/logout, `persistStoredSessionKey()` writes the current
 *      key to secure storage (falling back to localStorage).
 *   3. `clearAuthLocalState()` resets everything on logout.
 *
 * Dependencies:
 *   - `isNativeCapacitor()` (exposed globally by lib/capacitor-detect.js)
 *   - `secureStorageGet`, `secureStorageSet`, `secureStorageRemove`
 *     (exposed globally by lib/secure-storage.js)
 *   - Global `storedSessionKey` variable (defined in index.html)
 *   - `localStorage` (browser API)
 *
 * Exports (global + module.exports):
 *   SESSION_STORAGE_KEY           -> string constant
 *   hydrateStoredSessionKey()     -> Promise<void>
 *   persistStoredSessionKey(key)  -> Promise<void>
 *   clearAuthLocalState()         -> Promise<void>
 */

/* ---------------------------------------------------------------------------
 * Constants (exposed globally for index.html inline script)
 * ------------------------------------------------------------------------ */

var SESSION_STORAGE_KEY = 'miso.selectedSessionKey';

// Expose on globalThis so the inline script in index.html can reference it
if (typeof globalThis !== 'undefined') {
    globalThis.SESSION_STORAGE_KEY = SESSION_STORAGE_KEY;
}

/* ---------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------ */

async function hydrateStoredSessionKey() {
    var secureValue;
    if (typeof secureStorageGet === 'function') {
        secureValue = await secureStorageGet(SESSION_STORAGE_KEY);
    }

    if (secureValue) {
        storedSessionKey = secureValue;
        try {
            localStorage.removeItem(SESSION_STORAGE_KEY);
        } catch {
            // ignore local storage errors
        }
        return;
    }

    var localValue = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!localValue) return;

    storedSessionKey = localValue;

    if (typeof secureStorageSet === 'function') {
        var migrated = await secureStorageSet(SESSION_STORAGE_KEY, localValue);
        if (migrated) {
            try {
                localStorage.removeItem(SESSION_STORAGE_KEY);
            } catch {
                // ignore local storage errors
            }
        }
    }
}

async function persistStoredSessionKey(sessionKey) {
    storedSessionKey = sessionKey || null;

    if (!sessionKey) {
        if (typeof secureStorageRemove === 'function') {
            await secureStorageRemove(SESSION_STORAGE_KEY);
        }
        try {
            localStorage.removeItem(SESSION_STORAGE_KEY);
        } catch {
            // ignore local storage errors
        }
        return;
    }

    var savedToSecureStorage = false;
    if (typeof secureStorageSet === 'function') {
        savedToSecureStorage = await secureStorageSet(SESSION_STORAGE_KEY, sessionKey);
    }

    if (savedToSecureStorage) {
        try {
            localStorage.removeItem(SESSION_STORAGE_KEY);
        } catch {
            // ignore local storage errors
        }
        return;
    }

    localStorage.setItem(SESSION_STORAGE_KEY, sessionKey);
}

async function clearAuthLocalState() {
    await persistStoredSessionKey(null);
}

/* ---------------------------------------------------------------------------
 * Exports (Node.js test harness)
 * ------------------------------------------------------------------------ */

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SESSION_STORAGE_KEY,
        hydrateStoredSessionKey,
        persistStoredSessionKey,
        clearAuthLocalState,
    };
}

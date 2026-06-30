/**
 * public/lib/secure-storage.js
 *
 * Capacitor Secure Storage wrapper extracted from public/index.html.
 *
 * Provides a thin, fault-tolerant layer over the Capacitor secure storage
 * plugin (SecureStoragePlugin / CapacitorSecureStoragePlugin / SecureStorage).
 * All functions return safe defaults when the plugin is unavailable so they
 * can be called unconditionally from browser code.
 *
 * Dependencies:
 *   - `isNativeCapacitor()` (exposed globally by lib/capacitor-detect.js)
 *
 * Exports (global + module.exports):
 *   secureStorageGet(key)       -> string|null
 *   secureStorageSet(key, value) -> boolean
 *   secureStorageRemove(key)     -> void
 */

/* ---------------------------------------------------------------------------
 * Internal helpers
 * ------------------------------------------------------------------------ */

function getSecureStoragePlugin() {
    if (typeof isNativeCapacitor !== 'function' || !isNativeCapacitor()) return null;
    var plugins = (typeof window !== 'undefined' ? window : {}).Capacitor?.Plugins;
    if (!plugins) return null;
    return (
        plugins.SecureStoragePlugin
        || plugins.CapacitorSecureStoragePlugin
        || plugins.SecureStorage
        || null
    );
}

/* ---------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------ */

async function secureStorageGet(key) {
    var plugin = getSecureStoragePlugin();
    if (!plugin || typeof plugin.get !== 'function') return null;
    try {
        var result = await plugin.get({ key });
        if (typeof result === 'string') return result;
        return typeof result?.value === 'string' ? result.value : null;
    } catch {
        return null;
    }
}

async function secureStorageSet(key, value) {
    var plugin = getSecureStoragePlugin();
    if (!plugin || typeof plugin.set !== 'function') return false;
    try {
        await plugin.set({ key, value: String(value) });
        return true;
    } catch {
        return false;
    }
}

async function secureStorageRemove(key) {
    var plugin = getSecureStoragePlugin();
    if (!plugin || typeof plugin.remove !== 'function') return;
    try {
        await plugin.remove({ key });
    } catch {
        // ignore secure storage remove errors
    }
}

/* ---------------------------------------------------------------------------
 * Exports (Node.js test harness)
 * ------------------------------------------------------------------------ */

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        secureStorageGet,
        secureStorageSet,
        secureStorageRemove,
    };
}

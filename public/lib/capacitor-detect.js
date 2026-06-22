/**
 * lib/capacitor-detect.js
 *
 * Shared Capacitor native-platform detection.
 *
 * Exports `isNativeCapacitor()` so that both `index.html` and browser-side
 * modules (e.g. `lib/reaction-events-browser.js`) can use the same check
 * without duplicating logic or risking divergence.
 *
 * The guard against `window` being undefined is intentional — this module
 * may be loaded in contexts where the DOM is not available.
 */

(function () {
  'use strict';

  var root = typeof globalThis !== 'undefined' ? globalThis : self;

  /**
   * Returns true when running inside a Capacitor native platform.
   *
   * @returns {boolean}
   */
  function isNativeCapacitor() {
    var win = root.window || root;
    if (typeof win === 'undefined') return false;
    if (typeof win.Capacitor === 'undefined') return false;
    if (typeof win.Capacitor.isNativePlatform !== 'function') return false;
    return win.Capacitor.isNativePlatform();
  }

  // Expose globally for browser use
  root.isNativeCapacitor = isNativeCapacitor;
})();

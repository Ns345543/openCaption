/*
 * nodeglue.js
 * Gives the panel access to Node built-ins. CEP must have been launched with
 * --enable-nodejs and --mixed-context (see CSXS/manifest.xml).
 */
var NODE = (function () {
  var g = (typeof globalThis !== 'undefined') ? globalThis : window;

  function getRequire() {
    if (typeof window.cep_node !== 'undefined' && window.cep_node && window.cep_node.require) {
      return window.cep_node.require.bind(window.cep_node);
    }
    if (typeof g.require === 'function') return g.require.bind(g);
    if (typeof require === 'function') return require;
    return null;
  }

  var req = getRequire();
  if (!req) {
    return { ok: false, error: 'Node.js is not available in this panel. Re-install the extension (manifest must enable --enable-nodejs).' };
  }

  var api = { ok: true };
  try {
    api.fs = req('fs');
    api.path = req('path');
    api.os = req('os');
    api.https = req('https');
    api.http = req('http');
    api.child_process = req('child_process');
    api.crypto = req('crypto');
  } catch (e) {
    return { ok: false, error: 'Node modules failed to load: ' + e.message };
  }

  api.process = (typeof process !== 'undefined') ? process : g.process;
  api.appData = api.process && api.process.env && api.process.env.APPDATA
    ? api.process.env.APPDATA
    : api.path.join(api.os.homedir(), 'AppData', 'Roaming');

  return api;
})();

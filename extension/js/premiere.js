/*
 * premiere.js — thin async wrapper around the ExtendScript host (jsx/host.jsx).
 *
 * Two failure modes get handled explicitly:
 *   1. host.jsx hasn't been evaluated yet (right after the panel opens).
 *   2. host.jsx failed to parse, so CaptionAI never exists at all.
 */
var Premiere = (function () {
  var cs = new CSInterface();
  var hostLoaded = false;

  function extensionRoot() {
    try {
      var p = cs.getSystemPath(SystemPath.EXTENSION);
      if (p) return p;
    } catch (e1) { /* fall through */ }
    try {
      var loc = decodeURIComponent(String(window.location.pathname || '')).replace(/^\/+/, '');
      var cut = loc.toLowerCase().lastIndexOf('/index.html');
      if (cut > 0) return loc.slice(0, cut);
    } catch (e2) { /* fall through */ }
    return '';
  }

  /**
   * Evaluates host.jsx ourselves instead of relying on CEP's one-shot ScriptPath
   * load. That makes panel updates take effect on reopen instead of requiring a
   * full Premiere restart every time the ExtendScript changes.
   */
  function ensureHost() {
    if (hostLoaded) return Promise.resolve(true);

    var root = extensionRoot();
    if (!root) return Promise.resolve(false);

    var target = root.replace(/\\/g, '/');
    var script = '$.evalFile("' + target + '/jsx/host.jsx"); "host-ok"';

    return new Promise(function (resolve) {
      cs.evalScript(script, function (res) {
        hostLoaded = (res === 'host-ok');
        resolve(hostLoaded);
      });
    });
  }

  function describeMissing(fn, reject) {
    cs.evalScript('String(typeof CaptionAI)', function (kind) {
      if (kind === 'undefined') {
        reject(new Error(
          'host.jsx did not load in Premiere, so the panel cannot talk to the timeline. ' +
          'Restart Premiere Pro (reopening the panel is not enough for ExtendScript).'
        ));
      } else {
        reject(new Error(
          'Premiere raised an error inside ' + fn + '(). ' +
          'Look for a dialog or error in Premiere, then check the ExtendScript console.'
        ));
      }
    });
  }

  function call(fn, args, attempt) {
    attempt = attempt || 0;

    return new Promise(function (resolve, reject) {
      var script = 'CaptionAI.' + fn + '(' + JSON.stringify(args || {}) + ')';

      cs.evalScript(script, function (result) {
        var failed = (result === 'EvalScript error.' || result === undefined || result === null);

        if (failed) {
          // CEP evaluates ScriptPath just after the page loads; a call that lands
          // too early fails once and then succeeds.
          if (attempt < 3) {
            setTimeout(function () {
              call(fn, args, attempt + 1).then(resolve, reject);
            }, 250 * (attempt + 1));
            return;
          }
          describeMissing(fn, reject);
          return;
        }

        if (result === '') {
          reject(new Error('Premiere returned an empty response for "' + fn + '".'));
          return;
        }

        var parsed;
        try {
          parsed = JSON.parse(result);
        } catch (e) {
          reject(new Error('Unreadable reply from Premiere: ' + String(result).slice(0, 300)));
          return;
        }
        resolve(parsed);
      });
    });
  }

  return {
    call: call,
    ensureHost: ensureHost,
    ping: function () { return call('ping'); },
    getSequenceInfo: function (scope) { return call('getSequenceInfo', { scope: scope }); },
    importCaptions: function (srtPath) { return call('importCaptions', { path: srtPath }); },
    revealInExplorer: function (p) { return call('revealInExplorer', { path: p }); }
  };
})();

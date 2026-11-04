/*
 * update.js — GitHub release check and the in-panel updater.
 *
 * CEP has no update service, so the panel asks GitHub for the newest release:
 *
 *   panel start ──► releases/latest (cached for 6 h)
 *                ──► compare tag with the running version
 *                ──► banner: "update available / update now"
 *
 * "Update now" downloads the release's Windows zip, verifies its SHA-256
 * against the asset digest (or SHA256SUMS.txt), extracts it into
 *
 *   %APPDATA%\CaptionAI\updates\<version>\
 *
 * and starts a detached PowerShell helper. The helper waits until Premiere has
 * exited, swaps the extension folder, and relaunches Premiere. Settings and the
 * API key live in %APPDATA%\CaptionAI and are never touched.
 *
 * Nothing is executed from the download. Only the openCaption repository is
 * contacted, and installation is refused unless the checksum matches.
 */
var Updater = (function () {
  'use strict';

  if (typeof NODE === 'undefined' || !NODE.ok) {
    return { ok: false, error: 'Node.js is not available, so update checks are disabled.' };
  }
  if (typeof Config === 'undefined' || !Config.ok) {
    return { ok: false, error: 'Settings are unavailable, so update checks are disabled.' };
  }

  var fs = NODE.fs;
  var path = NODE.path;
  var https = NODE.https;
  var cp = NODE.child_process;
  var crypto = NODE.crypto;

  var REPO = 'Ns345543/openCaption';
  var API_URL = 'https://api.github.com/repos/' + REPO + '/releases/latest';
  var RELEASES_URL = 'https://github.com/' + REPO + '/releases/latest';
  var USER_AGENT = 'openCaption-updater';

  var CACHE_FILE = path.join(Config.DATA_DIR, 'update.json');
  var CACHE_TTL = 6 * 60 * 60 * 1000;          // 6 hours
  var UPDATES_DIR = path.join(Config.DATA_DIR, 'updates');
  var RESULT_FILE = path.join(Config.DATA_DIR, 'update-result.json');
  var HELPER_FILE = path.join(UPDATES_DIR, 'install-update.ps1');

  /* ------------------------------------------------------------- semver */

  function parseVersion(value) {
    var text = String(value || '').trim().replace(/^v/i, '');
    var m = text.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
    if (!m) return null;
    return {
      major: parseInt(m[1], 10),
      minor: parseInt(m[2], 10),
      patch: parseInt(m[3], 10),
      pre: m[4] || '',
      text: m[0]
    };
  }

  function comparePre(a, b) {
    if (!a && !b) return 0;
    if (!a) return 1;                 // 1.0.0 > 1.0.0-beta
    if (!b) return -1;
    var aa = a.split('.');
    var bb = b.split('.');
    var n = Math.max(aa.length, bb.length);
    for (var i = 0; i < n; i++) {
      if (aa[i] === undefined) return -1;
      if (bb[i] === undefined) return 1;
      var na = /^\d+$/.test(aa[i]) ? parseInt(aa[i], 10) : null;
      var nb = /^\d+$/.test(bb[i]) ? parseInt(bb[i], 10) : null;
      if (na !== null && nb !== null) {
        if (na !== nb) return na < nb ? -1 : 1;
      } else if (na !== null) {
        return -1;                  // numeric identifiers sort lower
      } else if (nb !== null) {
        return 1;
      } else if (aa[i] !== bb[i]) {
        return aa[i] < bb[i] ? -1 : 1;
      }
    }
    return 0;
  }

  /** -1 older, 0 same, 1 newer (a is the left-hand version). */
  function compareVersions(a, b) {
    var va = parseVersion(a);
    var vb = parseVersion(b);
    if (!va && !vb) return 0;
    if (!va) return -1;
    if (!vb) return 1;
    if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
    if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
    if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;
    return comparePre(va.pre, vb.pre);
  }

  function isNewer(candidate, current) {
    return compareVersions(candidate, current) > 0;
  }

  /* --------------------------------------------------------------- files */

  function ensureDir(dir) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Recursive delete that also works on the older Node bundled with CEP. */
  function rmrf(target) {
    var stat;
    try { stat = fs.lstatSync(target); } catch (e) { return; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      try { fs.unlinkSync(target); } catch (e2) { /* ignore */ }
      return;
    }
    var entries = [];
    try { entries = fs.readdirSync(target); } catch (e3) { entries = []; }
    for (var i = 0; i < entries.length; i++) rmrf(path.join(target, entries[i]));
    try { fs.rmdirSync(target); } catch (e4) { /* ignore */ }
  }

  function readText(file) {
    var raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
    // Windows PowerShell 5 writes UTF-8 with a BOM; JSON.parse rejects it.
    return (raw.charCodeAt(0) === 0xFEFF) ? raw.slice(1) : raw;
  }

  function writeJson(file, data) {
    try {
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Hash a large ZIP without loading it into memory. */
  function sha256File(file) {
    return new Promise(function (resolve, reject) {
      var hash = crypto.createHash('sha256');
      var stream = fs.createReadStream(file);
      stream.on('data', function (chunk) { hash.update(chunk); });
      stream.on('error', reject);
      stream.on('end', function () { resolve(hash.digest('hex')); });
    });
  }

  function fmtBytes(bytes) {
    if (!bytes || bytes < 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /* --------------------------------------------------------------- cache */

  /* Bump when the cached release shape changes. v2: assets carry the GitHub
     asset id, which the fallback download needs. */
  var CACHE_SCHEMA = 2;

  function readCache() {
    var raw = readText(CACHE_FILE);
    if (!raw) return null;
    try {
      var data = JSON.parse(raw);
      if (!data || data.schema !== CACHE_SCHEMA || !data.checkedAt || !data.release) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  function writeCache(release) {
    writeJson(CACHE_FILE, { schema: CACHE_SCHEMA, checkedAt: Date.now(), release: release });
  }

  /* ---------------------------------------------------------------- http */

  /*
   * Reliability notes (1.8.1):
   *
   * A release asset download is not one request. github.com answers with a 302
   * to release-assets.githubusercontent.com, a signed URL on a separate CDN
   * host that expires after about an hour. Two consequences:
   *
   *   - A retry must restart at the official github.com release URL so it gets
   *     a fresh signature; replaying the redirect target can fail with 403.
   *   - The old code relied on req.setTimeout(), which did not cover the TCP
   *     connect / TLS phase reliably. A filtered or slow CDN therefore produced
   *     "connect ETIMEDOUT 185.199.x.x:443" after the OS SYN timeout and
   *     aborted the update with no retry. Every attempt here has its own
   *     connect deadline instead.
   *
   * Downloads stream to "<name>.part", are size-checked, then renamed. Nothing
   * is installed unless the SHA-256 published by GitHub matches.
   */

  var NET = {
    connectTimeout: 20000,                 // connect + TLS + response headers
    idleTimeout: 45000,                    // no bytes received while downloading
    downloadTimeout: 15 * 60 * 1000,       // whole ZIP, including slow links
    textTimeout: 60000,                    // SHA256SUMS.txt / small responses
    maxAttempts: 4,
    retryBase: 1000,
    retryMax: 15000,
    maxRedirects: 8
  };

  var RETRYABLE_CODES = {
    ETIMEDOUT: 1, ECONNRESET: 1, ECONNREFUSED: 1, ECONNABORTED: 1,
    EPIPE: 1, ENOTFOUND: 1, EAI_AGAIN: 1, EAI_FAIL: 1,
    EHOSTUNREACH: 1, ENETUNREACH: 1, ENETDOWN: 1, ESOCKETTIMEDOUT: 1
  };
  var RETRYABLE_STATUS = { 408: 1, 425: 1, 429: 1, 500: 1, 502: 1, 503: 1, 504: 1 };

  var BASE_HEADERS = {
    'User-Agent': USER_AGENT,
    'Accept-Encoding': 'identity'
  };
  var RELEASE_HEADERS = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/octet-stream',
    'Accept-Encoding': 'identity'
  };
  var API_ASSET_HEADERS = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/octet-stream',
    'X-GitHub-Api-Version': '2022-11-28',
    'Accept-Encoding': 'identity'
  };

  function resolveLocation(base, location) {
    if (/^[a-z]+:\/\//i.test(location)) return location;
    if (location.indexOf('//') === 0) return 'https:' + location;
    if (location.charAt(0) === '/') {
      var m = base.match(/^([a-z]+:\/\/[^\/]+)/i);
      return (m ? m[1] : 'https://github.com') + location;
    }
    return base.replace(/[^\/]*$/, '') + location;
  }

  function hostOf(url) {
    var m = String(url || '').match(/^[a-z]+:\/\/[^\/:?#]+/i);
    return m ? m[0].replace(/^[a-z]+:\/\//i, '') : 'GitHub';
  }

  function makeError(code, message, extra) {
    var err = new Error(message);
    err.code = code || 'EUPDATE';
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) err[k] = extra[k];
      }
    }
    return err;
  }

  function retryable(err) {
    if (!err) return false;
    if (err.retryable === true) return true;
    if (err.retryable === false) return false;
    return !!(RETRYABLE_CODES[err.code] || RETRYABLE_STATUS[err.status]);
  }

  function netError(cause, stage) {
    var code = (cause && cause.code) || 'ENETWORK';
    var text = (cause && cause.message) ? cause.message : String(cause);
    var err = makeError(code, text, { stage: stage || 'network' });
    err.technical = text;
    return err;
  }

  /*
   * Cancellation. A run owns one token; every socket wait, retry sleep and
   * fallback step checks it. Aborting only touches the staging files — the
   * installed extension is never part of a download.
   */
  var currentRun = null;

  function newRun() {
    var token = { canceled: false, aborters: [] };
    token.register = function (fn) {
      if (token.canceled) {
        try { fn(); } catch (e) { /* ignore */ }
        return function () {};
      }
      token.aborters.push(fn);
      return function () {
        var index = token.aborters.indexOf(fn);
        if (index >= 0) token.aborters.splice(index, 1);
      };
    };
    token.cancel = function () {
      if (token.canceled) return false;
      token.canceled = true;
      var list = token.aborters;
      token.aborters = [];
      for (var i = 0; i < list.length; i++) {
        try { list[i](); } catch (e) { /* ignore */ }
      }
      return true;
    };
    return token;
  }

  function cancelError(stage) {
    return makeError('ECANCELED', 'The update was cancelled.', {
      retryable: false, canceled: true, stage: stage || 'download'
    });
  }

  function parseRetryAfter(value) {
    if (!value) return 0;
    var seconds = parseInt(value, 10);
    if (!isNaN(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30000);
    var when = Date.parse(value);
    if (!isNaN(when)) return Math.max(0, Math.min(when - Date.now(), 30000));
    return 0;
  }

  function apiError(status, body, retryAfter, url) {
    var message = 'GitHub returned HTTP ' + status;
    if (status === 403 || status === 429) {
      message = 'GitHub rate limit reached. Try again later.';
    } else if (status === 404) {
      message = 'No published release was found on GitHub.';
    }
    var detail = '';
    try {
      var parsed = JSON.parse(body);
      if (parsed && parsed.message) detail = parsed.message;
    } catch (e) { /* not JSON */ }
    var err = makeError('EHTTP' + status, detail ? message + ' (' + detail + ')' : message, {
      status: status,
      stage: 'http',
      retryable: !!RETRYABLE_STATUS[status]
    });
    if (status === 403) {
      var wait = parseRetryAfter(retryAfter);
      if (wait > 0) {
        err.retryable = true;
        err.retryAfterMs = wait;
      }
    } else if (retryAfter) {
      err.retryAfterMs = parseRetryAfter(retryAfter);
    }
    err.technical = 'HTTP ' + status + (detail ? ' - ' + detail : '') + ' from ' + hostOf(url);
    return err;
  }

  function humanMessage(err) {
    if (!err) return 'The update failed.';
    if (err.userMessage) return err.userMessage;
    var code = String(err.code || '');
    if (code === 'ECANCELED') {
      return 'The update was cancelled. Your installed version was left unchanged.';
    }
    if (code === 'ETIMEDOUT') {
      return 'GitHub did not answer in time. The connection may be slow, filtered by a firewall, or temporarily unavailable.';
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL') {
      return 'GitHub could not be reached. Check the internet connection or VPN, then retry.';
    }
    if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED') {
      return 'The connection to GitHub was interrupted before the download finished.';
    }
    if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || code === 'ENETDOWN') {
      return 'The network is unavailable right now. Reconnect, then retry.';
    }
    if (code === 'EINCOMPLETE') {
      return 'The download was incomplete, so it was discarded. Retry to fetch it again.';
    }
    if (code === 'ECHECKSUM') {
      return 'The downloaded package did not match the SHA-256 checksum published by GitHub, so it was discarded.';
    }
    if (code === 'ENOCHECKSUM') {
      return 'This release does not publish a usable SHA-256 checksum, so it cannot be installed automatically.';
    }
    if (code === 'EZIP' || code === 'EVALIDATE') return err.message;
    if (err.status === 429) return 'GitHub is limiting downloads right now. Wait a minute, then retry.';
    if (err.status >= 500) return 'GitHub\'s download server had a temporary problem. Retry in a moment.';
    if (err.status === 403) return 'GitHub refused the download, usually because of a temporary rate limit. Retry in a few minutes.';
    return err.message || 'The update failed.';
  }

  function sleep(ms, token) {
    return new Promise(function (resolve) {
      var timer = null;
      var unregister = null;
      function done() {
        if (timer) { clearTimeout(timer); timer = null; }
        if (unregister) unregister();
        resolve();
      }
      timer = setTimeout(done, ms);
      if (token) unregister = token.register(done);
    });
  }

  /** Exponential backoff with full jitter, bounded, and never below Retry-After. */
  function backoffDelay(attempt, retryAfterMs) {
    var exp = Math.min(NET.retryMax, NET.retryBase * Math.pow(2, Math.max(0, attempt - 1)));
    var jittered = Math.round(exp * (0.6 + Math.random() * 0.8));
    return Math.min(NET.retryMax, Math.max(jittered, retryAfterMs || 0));
  }

  function withRetries(work, options) {
    options = options || {};
    var max = options.maxAttempts || NET.maxAttempts;
    var attempt = 0;

    function run() {
      if (options.token && options.token.canceled) return Promise.reject(cancelError(options.stage));
      attempt += 1;
      return Promise.resolve().then(function () { return work(attempt); })
        .catch(function (err) {
          if (options.token && options.token.canceled) throw cancelError(options.stage);
          if (attempt >= max || !retryable(err)) {
            if (err && !err.attempts) err.attempts = attempt;
            throw err;
          }
          var delay = backoffDelay(attempt, err.retryAfterMs);
          if (typeof options.onRetry === 'function') {
            try { options.onRetry(err, attempt, max, delay); } catch (e) { /* ignore */ }
          }
          return sleep(delay, options.token).then(run);
        });
    }

    return run();
  }

  function transportFor(url) {
    if (/^http:\/\//i.test(url) && NODE.http) return NODE.http;
    return https;
  }

  /**
   * Start a GET and resolve as soon as a 2xx response with a readable body
   * arrives. Redirects are followed, but only the final response is returned.
   * The returned promise rejects on connect/TLS/response-header timeouts.
   */
  function openStream(url, options, redirects) {
    options = options || {};
    redirects = redirects || 0;

    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = null;
      var req = null;
      var unregister = null;

      function releaseToken() {
        if (unregister) { unregister(); unregister = null; }
      }

      function fail(err) {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        releaseToken();
        try { if (req) req.destroy(); } catch (e) { /* ignore */ }
        reject(err);
      }

      if (options.token && options.token.canceled) return fail(cancelError('connect'));

      try {
        req = transportFor(url).get(url, {
          agent: false,
          headers: options.headers || BASE_HEADERS
        }, function (res) {
          if (timer) { clearTimeout(timer); timer = null; }
          var status = res.statusCode;

          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (redirects >= NET.maxRedirects) {
              return fail(makeError('EREDIRECT', 'GitHub redirected too many times.', {
                retryable: false, stage: 'redirect'
              }));
            }
            var next = resolveLocation(url, res.headers.location);
            settled = true;
            releaseToken();
            openStream(next, options, redirects + 1).then(resolve, reject);
            return;
          }

          if (status < 200 || status >= 300) {
            var body = '';
            res.setEncoding('utf8');
            res.on('data', function (chunk) { if (body.length < 4000) body += chunk; });
            res.on('error', function (err) { fail(netError(err, 'http')); });
            res.on('end', function () {
              fail(apiError(status, body, res.headers['retry-after'], url));
            });
            return;
          }

          settled = true;
          releaseToken();
          resolve({ res: res, req: req, url: url, host: hostOf(url) });
        });

        req.on('error', function (err) { fail(netError(err, 'connect')); });

        if (options.token) {
          unregister = options.token.register(function () { fail(cancelError('connect')); });
          if (settled) return;
        }

        timer = setTimeout(function () {
          var seconds = Math.max(1, Math.round((options.responseTimeout || NET.connectTimeout) / 1000));
          var err = makeError('ETIMEDOUT',
            'Could not connect to ' + hostOf(url) + ' within ' + seconds + ' seconds.', {
              retryable: true, stage: 'connect'
            });
          err.technical = 'connect ETIMEDOUT ' + hostOf(url) + ' (no response after ' + seconds + 's)';
          fail(err);
        }, options.responseTimeout || NET.connectTimeout);
      } catch (err) {
        fail(netError(err, 'request'));
      }
    });
  }

  /** Read a bounded body; rejects if the server stalls mid-response. */
  function readBody(res, options) {
    options = options || {};
    var idle = options.idleTimeout || NET.idleTimeout;
    return new Promise(function (resolve, reject) {
      var chunks = [];
      var size = 0;
      var settled = false;
      var timer = null;
      var unregister = null;

      function releaseToken() {
        if (unregister) { unregister(); unregister = null; }
      }

      function stop(err) {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        releaseToken();
        try { res.destroy(); } catch (e) { /* ignore */ }
        reject(err);
      }

      function arm() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          stop(makeError('ETIMEDOUT', 'GitHub stopped sending data.', {
            retryable: true, stage: 'read'
          }));
        }, idle);
      }

      arm();
      if (options.token) {
        unregister = options.token.register(function () { stop(cancelError('read')); });
        if (settled) return;
      }
      res.on('data', function (chunk) {
        size += chunk.length;
        if (size > (options.maxBytes || 4 * 1024 * 1024)) {
          return stop(makeError('ETOOBIG', 'GitHub returned more data than expected.', {
            retryable: false, stage: 'read'
          }));
        }
        chunks.push(chunk);
        arm();
      });
      res.on('error', function (err) { stop(netError(err, 'read')); });
      res.on('end', function () {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        releaseToken();
        resolve(Buffer.concat(chunks));
      });
    });
  }

  function httpGetBuffer(url, options) {
    options = options || {};
    return withRetries(function () {
      return openStream(url, {
        headers: options.headers,
        responseTimeout: options.responseTimeout || NET.connectTimeout,
        token: options.token
      }).then(function (handle) {
        return readBody(handle.res, {
          maxBytes: options.maxBytes,
          idleTimeout: options.idleTimeout || NET.idleTimeout,
          token: options.token
        }).then(function (body) {
          return { body: body, url: handle.url, host: handle.host };
        });
      });
    }, {
      maxAttempts: options.maxAttempts,
      token: options.token,
      onRetry: options.onRetry
    });
  }

  function getJson(url) {
    return httpGetBuffer(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Accept-Encoding': 'identity'
      },
      maxBytes: 4 * 1024 * 1024,
      idleTimeout: NET.textTimeout,
      maxAttempts: 3
    }).then(function (result) {
      try {
        return JSON.parse(result.body.toString('utf8'));
      } catch (e) {
        throw makeError('EBADJSON', 'GitHub returned an unreadable response.', {
          stage: 'check', retryable: true
        });
      }
    });
  }

  function downloadText(url, headers, token) {
    return httpGetBuffer(url, {
      headers: headers || RELEASE_HEADERS,
      maxBytes: 1024 * 1024,
      idleTimeout: NET.textTimeout,
      token: token
    }).then(function (result) {
      return result.body.toString('utf8');
    });
  }

  /**
   * One download attempt. Bytes go to "<destination>.part"; the file is only
   * renamed into place after the byte count and content length agree.
   */
  function downloadAttempt(url, destination, options) {
    options = options || {};

    return new Promise(function (resolve, reject) {
      var part = destination + '.part';
      var res = null;
      var req = null;
      var out = null;
      var total = 0;
      var received = 0;
      var settled = false;
      var lastReport = 0;
      var idleTimer = null;
      var overallTimer = null;
      var idleMs = options.idleTimeout || NET.idleTimeout;
      var unregister = null;

      ensureDir(path.dirname(destination));
      rmrf(part);

      function clearTimers() {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        if (overallTimer) { clearTimeout(overallTimer); overallTimer = null; }
      }

      function releaseToken() {
        if (unregister) { unregister(); unregister = null; }
      }

      function deletePart(done) {
        var called = false;
        function once() {
          if (called) return;
          called = true;
          rmrf(part);
          done();
        }
        if (!out) return once();
        // Windows cannot delete a file that still has an open handle, so wait
        // for the write stream to close before removing the partial file.
        out.once('close', once);
        try { out.destroy(); } catch (e) { once(); }
        setTimeout(once, 1000);
      }

      function fail(err) {
        if (settled) return;
        settled = true;
        clearTimers();
        releaseToken();
        try { if (res) res.destroy(); } catch (e) { /* ignore */ }
        try { if (req) req.destroy(); } catch (e2) { /* ignore */ }
        deletePart(function () { reject(err); });
      }

      function incomplete() {
        var detail = total
          ? 'The download stopped after ' + fmtBytes(received) + ' of ' + fmtBytes(total) + '.'
          : 'The download ended before the whole file arrived.';
        return makeError('EINCOMPLETE', detail, { retryable: true, stage: 'download' });
      }

      function armIdle() {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(function () {
          fail(makeError('ETIMEDOUT',
            'The download stalled (no data for ' + Math.round(idleMs / 1000) + ' seconds).', {
              retryable: true, stage: 'download'
            }));
        }, idleMs);
      }

      function finish() {
        if (settled) return;
        if (total > 0 && received !== total) return fail(incomplete());
        if (options.expectedSize && received !== options.expectedSize) return fail(incomplete());
        if (received === 0) return fail(incomplete());

        settled = true;
        clearTimers();
        releaseToken();
        try {
          rmrf(destination);
          fs.renameSync(part, destination);
        } catch (e) {
          deletePart(function () {
            reject(makeError('ESAVE', 'The download could not be saved: ' + e.message, {
              retryable: false, stage: 'save'
            }));
          });
          return;
        }
        resolve({ bytes: received, total: total || received, url: url });
      }

      if (options.token) {
        if (options.token.canceled) return fail(cancelError('download'));
        unregister = options.token.register(function () { fail(cancelError('download')); });
        if (settled) return;
      }

      openStream(url, {
        headers: options.headers,
        responseTimeout: options.responseTimeout || NET.connectTimeout,
        token: options.token
      }).then(function (handle) {
        res = handle.res;
        req = handle.req;

        var encoding = String(res.headers['content-encoding'] || '').toLowerCase();
        if (encoding && encoding !== 'identity') {
          return fail(makeError('EENCODING', 'GitHub compressed the download unexpectedly.', {
            retryable: true, stage: 'download'
          }));
        }

        total = parseInt(res.headers['content-length'], 10) || 0;
        if (options.expectedSize && total && total !== options.expectedSize) {
          // A proxy or CDN answered with the wrong body; do not write it.
          return fail(makeError('ESIZE', 'GitHub returned an unexpected file size.', {
            retryable: true, stage: 'download'
          }));
        }

        out = fs.createWriteStream(part);
        armIdle();

        res.on('data', function (chunk) {
          received += chunk.length;
          armIdle();
          var now = Date.now();
          if (typeof options.onProgress === 'function' &&
              (now - lastReport > 150 || (total && received >= total))) {
            lastReport = now;
            try { options.onProgress(received, total); } catch (e) { /* ignore */ }
          }
        });
        res.on('aborted', function () { fail(incomplete()); });
        res.on('error', function (err) { fail(netError(err, 'download')); });
        out.on('error', function (err) {
          fail(makeError('EWRITE', 'Could not write the update file: ' + err.message, {
            retryable: false, stage: 'write'
          }));
        });
        out.on('finish', finish);

        if (options.overallTimeout) {
          overallTimer = setTimeout(function () {
            fail(makeError('ETIMEDOUT',
              'The download did not finish within ' + Math.round(options.overallTimeout / 60000) + ' minutes.', {
                retryable: true, stage: 'download'
              }));
          }, options.overallTimeout);
        }

        res.pipe(out);
      }, fail);
    });
  }

  /* ------------------------------------------------------------- release */

  function parseRelease(raw) {
    if (!raw || !raw.tag_name) return null;
    var version = String(raw.tag_name).replace(/^v/i, '');
    var parsed = parseVersion(version);
    if (!parsed) return null;
    // Use only the matched semver so a stray tag suffix can never reach a
    // generated .bat file or a folder name.
    version = parsed.text;

    var assets = [];
    var list = raw.assets || [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a || !a.name || !a.browser_download_url) continue;
      var digest = String(a.digest || '');
      assets.push({
        name: a.name,
        url: a.browser_download_url,
        /* The API asset endpoint is an alternate route to the same bytes when
           the browser download URL cannot be reached. */
        apiUrl: a.id ? ('https://api.github.com/repos/' + REPO + '/releases/assets/' + a.id) : '',
        id: a.id || 0,
        size: a.size || 0,
        sha256: digest.indexOf('sha256:') === 0 ? digest.slice(7) : ''
      });
    }

    return {
      tag: raw.tag_name,
      version: version,
      name: raw.name || raw.tag_name,
      notes: raw.body || '',
      htmlUrl: raw.html_url || ('https://github.com/' + REPO + '/releases/tag/' + raw.tag_name),
      publishedAt: raw.published_at || '',
      assets: assets,
      zip: pickAsset(assets, '\\.zip$', version, 'openCaption.zip'),
      sums: pickAsset(assets, '^SHA256SUMS\\.txt$', ''),
      zxp: pickAsset(assets, '\\.zxp$', version, 'openCaption.zxp')
    };
  }

  /**
   * Prefer the permanent package name, then one that contains the release
   * version (older releases used openCaption-<version>-windows.zip), and fall
   * back to any other match.
   */
  function pickAsset(assets, pattern, version, preferred) {
    var re = new RegExp(pattern, 'i');
    var want = preferred ? preferred.toLowerCase() : '';
    var versionMatch = null;
    var fallback = null;
    for (var i = 0; i < assets.length; i++) {
      if (!re.test(assets[i].name)) continue;
      if (want && assets[i].name.toLowerCase() === want) return assets[i];
      if (version && !versionMatch && assets[i].name.indexOf(version) >= 0) versionMatch = assets[i];
      if (!fallback) fallback = assets[i];
    }
    return versionMatch || fallback;
  }

  function parseSums(text, filename) {
    var lines = String(text || '').split(/\r?\n/);
    var wanted = String(filename || '').toLowerCase();
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^\s*([a-f0-9]{64})\s+\*?(.+?)\s*$/i);
      if (!m) continue;
      var name = m[2].replace(/^.*[\\\/]/, '').toLowerCase();
      if (name === wanted) return m[1].toLowerCase();
    }
    return '';
  }

  /**
   * The checksum is never optional: an update without one is refused instead
   * of installed. Prefer the digest GitHub reports for the asset itself, then
   * the release's SHA256SUMS.txt.
   */
  function expectedSha256(release, asset, onEvent, token) {
    if (token && token.canceled) return Promise.reject(cancelError('checksum'));
    if (asset.sha256) return Promise.resolve(asset.sha256.toLowerCase());
    if (!release.sums) {
      return Promise.reject(makeError('ENOCHECKSUM',
        'This release does not publish a SHA-256 checksum, so it was not installed. Use the release page.', {
          retryable: false, stage: 'checksum'
        }));
    }
    if (typeof onEvent === 'function') {
      onEvent({ phase: 'connecting', detail: 'Fetching the published checksum' });
    }
    return downloadText(release.sums.url, null, token).then(function (text) {
      var sha = parseSums(text, asset.name);
      if (!sha) {
        throw makeError('ENOCHECKSUM',
          'SHA256SUMS.txt does not list ' + asset.name + ', so the download cannot be verified.', {
            retryable: false, stage: 'checksum'
          });
      }
      return sha;
    });
  }

  /* --------------------------------------------------------- installation */

  function extensionRoots() {
    var roots = [];

    // The panel's own URL is the most trustworthy source: it is the folder
    // Premiere actually loaded, even if several copies are installed.
    try {
      if (typeof window !== 'undefined' && window.location && window.location.href) {
        var href = decodeURIComponent(window.location.href.split('?')[0].split('#')[0]);
        var m = href.match(/^file:\/\/\/(.+)\/index\.html?$/i);
        if (m) roots.push(path.resolve(m[1]));
      }
    } catch (e0) { /* ignore */ }

    try {
      if (typeof __dirname === 'string' && __dirname) {
        roots.push(path.resolve(__dirname, '..'));
      }
    } catch (e1) { /* ignore */ }

    try {
      if (window.__adobe_cep__ && window.__adobe_cep__.getSystemPath) {
        var viaCep = window.__adobe_cep__.getSystemPath('extension');
        if (viaCep) roots.push(viaCep);
      }
    } catch (e2) { /* ignore */ }

    var unique = [];
    for (var i = 0; i < roots.length; i++) {
      var value = roots[i];
      if (!value) continue;
      value = path.resolve(value);
      if (unique.indexOf(value) < 0) unique.push(value);
    }
    return unique;
  }

  function extensionRoot() {
    var roots = extensionRoots();
    for (var i = 0; i < roots.length; i++) {
      try {
        if (fs.existsSync(path.join(roots[i], 'CSXS', 'manifest.xml'))) return roots[i];
      } catch (e) { /* ignore */ }
    }
    return roots.length ? roots[0] : '';
  }

  function powershellPath() {
    var sysRoot = (NODE.process && (NODE.process.env.SystemRoot || NODE.process.env.windir)) || 'C:\\Windows';
    var full = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      if (fs.existsSync(full)) return full;
    } catch (e) { /* ignore */ }
    return 'powershell.exe';
  }

  var capabilityCache = null;

  /** Junction and symlink installs are normal here (install.ps1 creates one). */
  function resolveLink(dir) {
    try {
      var real = fs.realpathSync(dir);
      return real ? path.resolve(real) : dir;
    } catch (e) {
      return dir;
    }
  }

  function canWrite(dir) {
    var probe = path.join(dir, '.opencaption-write-test-' + Date.now());
    try {
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return true;
    } catch (e) {
      return false;
    }
  }

  function capability() {
    if (capabilityCache) return capabilityCache;

    function no(reason) {
      capabilityCache = { ok: false, reason: reason };
      return capabilityCache;
    }

    var platform = NODE.process && NODE.process.platform;
    if (platform && platform !== 'win32') {
      return no('Automatic updates are only available on Windows.');
    }

    var detected = extensionRoot();
    if (!detected) return no('The installed extension folder could not be located.');

    // The normal installer links the panel with a junction, so update the real
    // folder behind it instead of refusing to touch a "development copy".
    var root = resolveLink(detected);

    try {
      if (!fs.existsSync(path.join(root, 'CSXS', 'manifest.xml'))) {
        return no('The installed extension folder looks incomplete.');
      }
    } catch (e) {
      return no('The installed extension folder could not be read.');
    }

    if (canWrite(root)) {
      capabilityCache = {
        ok: true,
        root: root,
        detected: detected,
        link: root !== detected,
        powershell: powershellPath()
      };
      return capabilityCache;
    }

    // A system-wide install under Program Files cannot be written without
    // admin rights. Premiere also loads the per-user CEP folder, so install
    // there instead and leave the old copy untouched.
    try {
      var cepRoot = path.join(NODE.appData, 'Adobe', 'CEP', 'extensions');
      var userRoot = path.join(cepRoot, path.basename(root));
      if (fs.existsSync(cepRoot) && canWrite(cepRoot)) {
        capabilityCache = {
          ok: true,
          root: userRoot,
          detected: detected,
          fallback: true,
          powershell: powershellPath()
        };
        return capabilityCache;
      }
    } catch (e2) { /* fall through to the reason below */ }

    return no('The installed folder is not writable (usually because it is under Program Files). Install the release once from the download page.');
  }

  function findExtensionRoot(dir, depth) {
    depth = depth || 0;
    try {
      if (fs.existsSync(path.join(dir, 'CSXS', 'manifest.xml'))) return dir;
    } catch (e) { /* ignore */ }
    if (depth > 3) return '';

    var entries = [];
    try { entries = fs.readdirSync(dir); } catch (e2) { return ''; }
    for (var i = 0; i < entries.length; i++) {
      var child = path.join(dir, entries[i]);
      var stat;
      try { stat = fs.lstatSync(child); } catch (e3) { continue; }
      if (!stat.isDirectory()) continue;
      var found = findExtensionRoot(child, depth + 1);
      if (found) return found;
    }
    return '';
  }

  function manifestVersion(root) {
    var text = readText(path.join(root, 'CSXS', 'manifest.xml'));
    var m = text.match(/ExtensionBundleVersion\s*=\s*"([^"]+)"/i);
    return m ? m[1] : '';
  }

  /** A staged copy must contain the panel and the audio helper, not just a manifest. */
  function looksComplete(root) {
    var required = [
      'index.html',
      'js/app.js',
      'js/translate.js',
      'jsx/host.jsx',
      'CSXS/manifest.xml',
      'tools/ffmpeg/ffmpeg.exe'
    ];    for (var i = 0; i < required.length; i++) {
      try {
        if (!fs.existsSync(path.join(root, required[i]))) return false;
      } catch (e) {
        return false;
      }
    }
    return true;
  }

  function preparedPath(version) {
    return path.join(UPDATES_DIR, version);
  }

  function findPrepared(version) {
    var cap = capability();
    if (!cap.ok) return null;
    var dir = preparedPath(version);
    try {
      if (!fs.existsSync(dir)) return null;
    } catch (e) {
      return null;
    }
    var source = findExtensionRoot(dir, 0);
    if (!source || !looksComplete(source)) return null;
    var found = manifestVersion(source);
    if (!found || compareVersions(found, version) !== 0) return null;
    return {
      version: version,
      source: source,
      root: cap.root,
      dir: dir,
      prepared: true
    };
  }

  function cleanupOldVersions(keepVersion) {
    var entries = [];
    try { entries = fs.readdirSync(UPDATES_DIR); } catch (e) { return; }
    for (var i = 0; i < entries.length; i++) {
      if (!/^\d+\.\d+\.\d+$/.test(entries[i])) continue;
      if (entries[i] === keepVersion) continue;
      rmrf(path.join(UPDATES_DIR, entries[i]));
    }
  }

  function psQuote(value) {
    return "'" + String(value).replace(/'/g, "''") + "'";
  }

  /**
   * Extract into the staging folder after refusing entries that would escape
   * it (an absolute path or ".."), then let Expand-Archive write the files.
   */
  function extractZip(powershell, zipFile, destination) {
    var command =
      "$ErrorActionPreference='Stop'; " +
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
      "$zip=[IO.Compression.ZipFile]::OpenRead(" + psQuote(zipFile) + "); " +
      "try { foreach ($e in $zip.Entries) { " +
      "$n=$e.FullName.Replace('\\','/'); " +
      "if ($n.StartsWith('/') -or $n -match '^[A-Za-z]:' -or $n.Contains('../')) { " +
      "throw ('Unsafe path in update package: ' + $n) } } } finally { $zip.Dispose() }; " +
      "Expand-Archive -LiteralPath " + psQuote(zipFile) +
      " -DestinationPath " + psQuote(destination) + " -Force";

    return new Promise(function (resolve, reject) {
      cp.execFile(powershell, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command
      ], { windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, function (err, stdout, stderr) {
        if (err) {
          var detail = String(stderr || err.message || '').trim();
          if (detail.length > 400) detail = detail.slice(0, 400) + '...';
          var failure = makeError('EZIP',
            'Could not extract the update' + (detail ? ': ' + detail : '.'), {
              retryable: false, stage: 'install'
            });
          failure.technical = detail || 'Expand-Archive failed';
          return reject(failure);
        }
        resolve(true);
      });
    });
  }

  /* -------------------------------------------------------------- checking */

  function buildResult(currentVersion, release, meta) {
    var cap = capability();
    var update = isNewer(release.version, currentVersion);
    return {
      ok: true,
      current: String(currentVersion || '').replace(/^v/i, ''),
      latest: release,
      updateAvailable: update,
      canSelfUpdate: cap,
      prepared: update ? findPrepared(release.version) : null,
      cached: !!(meta && meta.cached),
      stale: !!(meta && meta.stale),
      error: (meta && meta.error) || ''
    };
  }

  function check(currentVersion, force) {
    var cache = readCache();
    var fresh = cache && (Date.now() - cache.checkedAt < CACHE_TTL);

    if (!force && fresh) {
      return Promise.resolve(buildResult(currentVersion, cache.release, { cached: true }));
    }

    return getJson(API_URL).then(function (raw) {
      var release = parseRelease(raw);
      if (!release) throw new Error('GitHub did not return a usable release.');
      writeCache(release);
      return buildResult(currentVersion, release, { cached: false });
    }).catch(function (err) {
      // A stale cache is better than an error banner at every launch.
      if (cache) {
        return buildResult(currentVersion, cache.release, {
          cached: true,
          stale: true,
          error: err.message
        });
      }
      return { ok: false, error: err.message, updateAvailable: false };
    });
  }

  /* ------------------------------------------------------------ preparing */

  function installError(message) {
    return makeError('EVALIDATE', message, { retryable: false, stage: 'install' });
  }

  /**
   * Official routes to the same bytes. The release download URL is tried
   * first; the asset API is a second official GitHub endpoint that answers
   * with its own redirect. Retries always restart at the source URL so the
   * signed CDN link is refreshed instead of replayed after it expires.
   */
  function downloadSources(release) {
    var sources = [];
    function add(label, url, headers) {
      if (!url) return;
      for (var i = 0; i < sources.length; i++) {
        if (sources[i].url === url) return;
      }
      sources.push({ label: label, url: url, headers: headers });
    }
    add('GitHub release', release.zip.url, RELEASE_HEADERS);
    add('GitHub asset API', release.zip.apiUrl, API_ASSET_HEADERS);
    return sources;
  }

  function downloadReleaseZip(release, zipFile, options) {
    options = options || {};
    var sources = downloadSources(release);
    var failures = [];
    var index = 0;
    var lastError = null;

    function next() {
      if (options.token && options.token.canceled) throw cancelError('download');
      if (index >= sources.length) {
        var err = makeError('EDOWNLOAD', 'The update could not be downloaded from GitHub.', {
          retryable: true, stage: 'download'
        });
        err.userMessage = lastError
          ? humanMessage(lastError)
          : 'The update could not be downloaded from GitHub. Try again, or open the release page.';
        err.technical = failures.join(' | ') || err.message;
        throw err;
      }

      var source = sources[index];
      index += 1;
      if (typeof options.onEvent === 'function') {
        options.onEvent({
          phase: 'connecting',
          source: source.label,
          host: hostOf(source.url)
        });
      }

      return withRetries(function () {
        return downloadAttempt(source.url, zipFile, {
          headers: source.headers,
          expectedSize: release.zip.size || 0,
          overallTimeout: NET.downloadTimeout,
          token: options.token,
          onProgress: options.onProgress
        });
      }, {
        maxAttempts: NET.maxAttempts,
        token: options.token,
        onRetry: function (failure, attempt, max, delay) {
          if (typeof options.onEvent !== 'function') return;
          options.onEvent({
            phase: 'retrying',
            attempt: Math.min(attempt + 1, max),
            attempts: max,
            reason: humanMessage(failure),
            detail: humanMessage(failure),
            technical: failure.technical || failure.message,
            delayMs: delay
          });
        }
      }).catch(function (failure) {
        // A cancel is final: do not spend the fallback source on it.
        if ((options.token && options.token.canceled) || failure.canceled) {
          throw failure.canceled ? failure : cancelError('download');
        }
        lastError = failure;
        failures.push(source.label + ': ' + (failure.technical || failure.message));
        return next();
      });
    }

    return Promise.resolve().then(next);
  }

  /**
   * Download, verify, stage and validate. The running installation is never
   * touched here; installPrepared() moves the staged folder into place later,
   * only after Premiere has closed.
   */
  function prepare(release, onEvent) {
    function emit(phase, extra) {
      if (typeof onEvent !== 'function') return;
      var event;
      if (phase && typeof phase === 'object') {
        event = phase;
      } else {
        event = { phase: phase };
        if (extra) {
          for (var k in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, k)) event[k] = extra[k];
          }
        }
      }
      try { onEvent(event); } catch (e) { /* ignore */ }
    }

    var cap = capability();
    var version = release && release.version;
    var releaseUrl = (release && release.htmlUrl) || RELEASES_URL;

    function rejectWith(err) {
      if (!(err instanceof Error)) err = makeError('EUPDATE', String(err));
      if (!err.userMessage) err.userMessage = humanMessage(err);
      if (!err.technical) err.technical = err.message;
      if (!err.releaseUrl) err.releaseUrl = releaseUrl;
      err.kind = err.stage === 'install' ? 'install' : 'download';
      return Promise.reject(err);
    }

    if (!cap.ok) {
      return rejectWith(makeError('ECONFIG', cap.reason, { retryable: false, stage: 'config' }));
    }
    if (!release || !release.zip) {
      return rejectWith(makeError('ENOPACKAGE',
        'This release has no Windows package. Use the release page instead.', {
          retryable: false, stage: 'install'
        }));
    }

    var dir = preparedPath(version);
    var zipFile = path.join(dir, 'package.zip');
    var extractDir = path.join(dir, 'extract');
    var expectedSha = '';

    var existing = findPrepared(version);
    if (existing) {
      emit('ready', { version: version });
      return Promise.resolve(existing);
    }

    if (!ensureDir(dir)) {
      return rejectWith(makeError('ESTAGE',
        'Could not create the update folder in %APPDATA%\\CaptionAI.', {
          retryable: false, stage: 'install'
        }));
    }

    var token = newRun();
    currentRun = token;

    return expectedSha256(release, release.zip, emit, token).then(function (sha) {
      if (token.canceled) throw cancelError('checksum');
      expectedSha = sha;
      return downloadReleaseZip(release, zipFile, {
        token: token,
        onEvent: emit,
        onProgress: function (received, total) {
          emit('downloading', {
            received: received,
            total: total,
            percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0
          });
        }
      });
    }).then(function () {
      if (token.canceled) throw cancelError('download');
      emit('verifying', { percent: 100 });
      return sha256File(zipFile);
    }).then(function (actual) {
      if (token.canceled) throw cancelError('verify');
      if (String(actual).toLowerCase() !== String(expectedSha).toLowerCase()) {
        rmrf(zipFile);
        throw makeError('ECHECKSUM',
          'The downloaded package did not match the published SHA-256 checksum, so it was discarded.', {
            retryable: false, stage: 'checksum'
          });
      }

      emit('installing', {});
      rmrf(extractDir);
      if (!ensureDir(extractDir)) {
        throw makeError('ESTAGE', 'Could not create the staging folder.', {
          retryable: false, stage: 'install'
        });
      }
      return extractZip(cap.powershell, zipFile, extractDir);
    }).then(function () {
      if (token.canceled) throw cancelError('install');
      var source = findExtensionRoot(extractDir, 0);
      if (!source) {
        throw installError('The downloaded package did not contain the openCaption extension.');
      }
      if (!looksComplete(source)) {
        throw installError('The downloaded package is incomplete (a panel file or ffmpeg.exe is missing).');
      }

      var found = manifestVersion(source);
      if (!found) throw installError('The downloaded package has no version in its manifest.');
      if (compareVersions(found, version) !== 0) {
        throw installError('The package contains version ' + found + ' instead of ' + version + '.');
      }

      rmrf(zipFile);
      cleanupOldVersions(version);
      writeJson(path.join(dir, 'prepared.json'), {
        version: version,
        preparedAt: new Date().toISOString(),
        size: release.zip.size || 0,
        sha256: expectedSha,
        notes: release.notes,
        htmlUrl: release.htmlUrl
      });

      emit('ready', { version: version });
      return {
        version: version,
        source: source,
        root: cap.root,
        dir: dir,
        prepared: true,
        sha256: expectedSha
      };
    }).catch(function (err) {
      // Only the staging area is cleaned up. The installed panel stays as is.
      rmrf(zipFile);
      rmrf(extractDir);
      return rejectWith(err);
    }).then(function (result) {
      currentRun = null;
      return result;
    }, function (err) {
      currentRun = null;
      throw err;
    });
  }

  /** Abort the running prepare(): sockets close, retries stop, temp files go. */
  function cancel() {
    if (!currentRun) return { ok: false, error: 'No update download is in progress.' };
    if (!currentRun.cancel()) return { ok: false, error: 'The update is already being cancelled.' };
    return { ok: true };
  }

  /* ------------------------------------------------------------- helper */

  function helperScript() {
    return [
      'param(',
      '  [string]$Config = "",',
      '  [string]$Source = "",',
      '  [string]$Target = "",',
      '  [string]$Result = "",',
      '  [string]$Version = "",',
      '  [string]$Cleanup = "",',
      '  [int]$WaitMinutes = 360,',
      '  [switch]$SkipWait',
      ')',
      '',
      '$ErrorActionPreference = "Stop"',
      '',
      '# Paths arrive through a UTF-8 JSON file so non-ASCII user folders survive',
      '# both the command line and cmd.exe codepages.',
      'if ($Config) {',
      '  $job = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json',
      '  if (-not $Source) { $Source = [string]$job.source }',
      '  if (-not $Target) { $Target = [string]$job.target }',
      '  if (-not $Result) { $Result = [string]$job.result }',
      '  if (-not $Version) { $Version = [string]$job.version }',
      '  if (-not $Cleanup) { $Cleanup = [string]$job.cleanup }',
      '}',
      'if (-not $Result) { exit 1 }',
      '$LogFile = [IO.Path]::ChangeExtension($Result, ".log")',
      '',
      'function Write-Log([string]$text) {',
      '  try {',
      '    $line = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss") + "  " + $text',
      '    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8',
      '  } catch { }',
      '}',
      '',
      'function Write-Result([string]$status, [string]$message) {',
      '  try {',
      '    $json = [ordered]@{',
      '      status = $status',
      '      message = $message',
      '      version = $Version',
      '      at = (Get-Date).ToString("o")',
      '    } | ConvertTo-Json -Compress',
      '    Set-Content -LiteralPath $Result -Value $json -Encoding UTF8',
      '  } catch { }',
      '}',
      '',
      'function Test-Premiere {',
      '  foreach ($n in @("Adobe Premiere Pro", "Adobe Premiere Pro Beta")) {',
      '    if (Get-Process -Name $n -ErrorAction SilentlyContinue) { return $true }',
      '  }',
      '  return $false',
      '}',
      '',
      'try {',
      '  Write-Log "Helper started. version=$Version source=$Source target=$Target"',
      '  $mutex = New-Object -TypeName System.Threading.Mutex -ArgumentList $false, "Local\\openCaptionUpdater"',
      '  if (-not $mutex.WaitOne(0)) {',
      '    Write-Log "Another update helper is already waiting; exiting."',
      '    exit 0',
      '  }',
      '  $exe = ""',
      '  $wasRunning = $false',
      '  foreach ($n in @("Adobe Premiere Pro", "Adobe Premiere Pro Beta")) {',
      '    $p = Get-Process -Name $n -ErrorAction SilentlyContinue | Select-Object -First 1',
      '    if ($p) {',
      '      $wasRunning = $true',
      '      if (-not $exe) { try { $exe = $p.Path } catch { } }',
      '    }',
      '  }',
      '  if ($wasRunning) { Write-Log "Premiere is running; waiting for it to close." }',
      '',
      '  if (-not $SkipWait) {',
      '    $deadline = (Get-Date).AddMinutes($WaitMinutes)',
      '    while ((Test-Premiere) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Seconds 2 }',
      '    if (Test-Premiere) {',
      '      Write-Log "Timed out waiting for Premiere to close."',
      '      Write-Result "timeout" "Premiere Pro was still running, so the update was not installed."',
      '      exit 0',
      '    }',
      '    Start-Sleep -Seconds 2',
      '  }',
      '',
      '  if (-not (Test-Path -LiteralPath $Source)) { throw "The staged update is missing: $Source" }',
      '  if (-not (Test-Path -LiteralPath (Join-Path $Source "CSXS\\manifest.xml"))) {',
      '    throw "The staged update is incomplete: $Source"',
      '  }',
      '',
      '  $targetExists = Test-Path -LiteralPath $Target',
      '  if ($targetExists) {',
      '    $item = Get-Item -LiteralPath $Target -Force',
      '    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {',
      '      $real = $item.Target',
      '      if ($real -is [array]) { $real = $real[0] }',
      '      if ($real -and (Test-Path -LiteralPath $real)) {',
      '        Write-Log "Target is a junction; updating its target $real"',
      '        $Target = $real',
      '        $targetExists = Test-Path -LiteralPath $Target',
      '      } else {',
      '        throw "The installed panel is a junction with no reachable target; install the release manually."',
      '      }',
      '    }',
      '  }',
      '',
      '  $parent = Split-Path -Parent $Target',
      '  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }',
      '  $stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")',
      '  $backup = $Target + ".old-" + $stamp',
      '  try {',
      '    # Move the staged folder into place after renaming the old one. Both live',
      '    # under %APPDATA%, so this is a rename, not a 100 MB copy: the panel is',
      '    # missing for milliseconds instead of several seconds.',
      '    if ($targetExists) { Rename-Item -LiteralPath $Target -NewName (Split-Path -Leaf $backup) }',
      '    try {',
      '      Move-Item -LiteralPath $Source -Destination $Target',
      '    } catch {',
      '      if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction SilentlyContinue }',
      '      if ($targetExists -and (Test-Path -LiteralPath $backup)) {',
      '        Rename-Item -LiteralPath $backup -NewName (Split-Path -Leaf $Target)',
      '      }',
      '      throw',
      '    }',
      '    Get-ChildItem -LiteralPath $Target -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue',
      '    if ($targetExists -and (Test-Path -LiteralPath $backup)) {',
      '      Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue',
      '    }',
      '    Write-Log "Installed the new panel."',
      '    Write-Result "ok" "Updated to openCaption $Version."',
      '  } catch {',
      '    $copyError = $_.Exception.Message',
      '    Write-Log ("Install failed: " + $copyError)',
      '    if ((-not (Test-Path -LiteralPath $Target)) -and $targetExists -and (Test-Path -LiteralPath $backup)) {',
      '      Rename-Item -LiteralPath $backup -NewName (Split-Path -Leaf $Target)',
      '      Write-Log "Restored the previous panel."',
      '    }',
      '    Write-Result "error" ("Could not install the update: " + $copyError)',
      '    exit 1',
      '  }',
      '',
      '  if ($Cleanup -and ($Cleanup -ne $Target) -and (Test-Path -LiteralPath $Cleanup)) {',
      '    Remove-Item -LiteralPath $Cleanup -Recurse -Force -ErrorAction SilentlyContinue',
      '  }',
      '',
      '  if ($wasRunning -and $exe -and (Test-Path -LiteralPath $exe)) {',
      '    Start-Sleep -Seconds 2',
      '    try { Start-Process -FilePath $exe; Write-Log "Relaunched $exe" } catch { Write-Log ("Relaunch failed: " + $_.Exception.Message) }',
      '  }',
      '  exit 0',
      '} catch {',
      '  Write-Log ("Failed: " + $_.Exception.Message)',
      '  Write-Result "error" $_.Exception.Message',
      '  exit 1',
      '}',
      ''
    ].join('\r\n');
  }

  function writeManualHelper(prep) {
    // One script serves both routes: the panel starts it with "auto" (no
    // prompt), while double-clicking it waits with a message and a pause.
    var bat = [
      '@echo off',
      'setlocal',
      'title openCaption - finish update',
      'if /i not "%~1"=="auto" (',
      '  echo.',
      '  echo  This finishes the openCaption update to v' + prep.version + '.',
      '  echo  Close Premiere Pro first. The panel will be replaced and Premiere reopened.',
      '  echo.',
      ')',
      '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-update.ps1" -Config "%~dp0job.json"',
      'set "RC=%ERRORLEVEL%"',
      'if /i "%~1"=="auto" exit /b %RC%',
      'echo.',
      'if not "%RC%"=="0" echo  Update failed. See the log next to update-result.json.',
      'pause',
      'exit /b %RC%',
      ''
    ].join('\r\n');
    try {
      fs.writeFileSync(path.join(UPDATES_DIR, 'finish-update.bat'), bat, 'ascii');
    } catch (e) { /* optional fallback */ }
  }

  function installPrepared(prep) {
    if (!prep || !prep.source || !prep.root) {
      return { ok: false, error: 'There is no prepared update to install.' };
    }

    var jobFile = path.join(UPDATES_DIR, 'job.json');
    try {
      ensureDir(UPDATES_DIR);
      fs.writeFileSync(HELPER_FILE, helperScript(), 'utf8');
      writeManualHelper(prep);
      if (!writeJson(jobFile, {
        source: prep.source,
        target: prep.root,
        result: RESULT_FILE,
        version: prep.version,
        cleanup: prep.dir || ''
      })) {
        throw new Error('Could not write the update job file.');
      }
      try { fs.unlinkSync(RESULT_FILE); } catch (e) { /* none */ }
    } catch (err) {
      return { ok: false, error: 'Could not write the update helper: ' + err.message };
    }

    // A plain detached spawn is still tied to the panel's process tree on some
    // Windows builds and dies when Premiere exits. "cmd /c start" hands the
    // batch file to the shell, which outlives Premiere. The batch file does the
    // quoting through %~dp0, so paths with spaces and non-ASCII names work.
    var batFile = path.join(UPDATES_DIR, 'finish-update.bat');

    try {
      var child = cp.spawn('cmd.exe', ['/c', 'start', '""', '/min', batFile, 'auto'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
      return { ok: true, pid: child.pid, helper: HELPER_FILE, bat: batFile, resultFile: RESULT_FILE };
    } catch (err) {
      return { ok: false, error: 'Could not start the update helper: ' + err.message };
    }
  }

  function readResult() {
    var raw = readText(RESULT_FILE);
    if (!raw) return null;
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { return null; }
    try { fs.unlinkSync(RESULT_FILE); } catch (e2) { /* ignore */ }
    return parsed;
  }

  function openReleasePage(release) {
    var url = (release && release.htmlUrl) ? String(release.htmlUrl) : RELEASES_URL;
    return /^https?:\/\//i.test(url) ? url : RELEASES_URL;
  }

  return {
    ok: true,
    REPO: REPO,
    RELEASES_URL: RELEASES_URL,
    CACHE_FILE: CACHE_FILE,
    UPDATES_DIR: UPDATES_DIR,
    parseVersion: parseVersion,
    compareVersions: compareVersions,
    check: check,
    prepare: prepare,
    cancel: cancel,
    installPrepared: installPrepared,
    readResult: readResult,
    capability: capability,
    openReleasePage: openReleasePage,
    /* Test hooks; not used by the panel. */
    _parseRelease: parseRelease,
    _parseSums: parseSums,
    _pickAsset: pickAsset,
    _findExtensionRoot: findExtensionRoot,
    _manifestVersion: manifestVersion,
    _sha256File: sha256File,
    _extractZip: extractZip,
    _helperScript: helperScript,
    _net: NET,
    _humanMessage: humanMessage,
    _backoffDelay: backoffDelay
  };
})();

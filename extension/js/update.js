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

  function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }

  function fmtBytes(bytes) {
    if (!bytes || bytes < 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /* --------------------------------------------------------------- cache */

  function readCache() {
    var raw = readText(CACHE_FILE);
    if (!raw) return null;
    try {
      var data = JSON.parse(raw);
      return (data && data.checkedAt && data.release) ? data : null;
    } catch (e) {
      return null;
    }
  }

  function writeCache(release) {
    writeJson(CACHE_FILE, { checkedAt: Date.now(), release: release });
  }

  /* ---------------------------------------------------------------- http */

  function resolveLocation(base, location) {
    if (/^[a-z]+:\/\//i.test(location)) return location;
    if (location.charAt(0) === '/') {
      var m = base.match(/^([a-z]+:\/\/[^\/]+)/i);
      return (m ? m[1] : 'https://github.com') + location;
    }
    return base.replace(/[^\/]*$/, '') + location;
  }

  function apiError(status, body) {
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
    return new Error(detail ? message + ' (' + detail + ')' : message);
  }

  function getJson(url, redirects) {
    redirects = redirects || 0;
    return new Promise(function (resolve, reject) {
      var req = https.get(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects >= 5) return reject(new Error('Too many redirects from GitHub.'));
          var next = resolveLocation(url, res.headers.location);
          return getJson(next, redirects + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          var body = '';
          res.setEncoding('utf8');
          res.on('data', function (chunk) {
            if (body.length < 4000) body += chunk;
          });
          res.on('end', function () { reject(apiError(res.statusCode, body)); });
          return;
        }
        var chunks = [];
        res.on('data', function (chunk) { chunks.push(chunk); });
        res.on('end', function () {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(new Error('GitHub returned an unreadable response.'));
          }
        });
      });
      req.on('error', function (e) { reject(new Error('Network error: ' + e.message)); });
      req.setTimeout(30000, function () { req.destroy(new Error('Network timeout.')); });
    });
  }

  function downloadFile(url, destination, onProgress, redirects) {
    redirects = redirects || 0;
    return new Promise(function (resolve, reject) {
      ensureDir(path.dirname(destination));
      var req = https.get(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/octet-stream' }
      }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects >= 8) return reject(new Error('Too many redirects.'));
          var next = resolveLocation(url, res.headers.location);
          return downloadFile(next, destination, onProgress, redirects + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          var body = '';
          res.setEncoding('utf8');
          res.on('data', function (chunk) { if (body.length < 2000) body += chunk; });
          res.on('end', function () { reject(apiError(res.statusCode, body)); });
          return;
        }
        var total = parseInt(res.headers['content-length'], 10) || 0;
        var received = 0;
        var lastReport = 0;
        var out = fs.createWriteStream(destination);
        var finished = false;

        function fail(err) {
          if (finished) return;
          finished = true;
          try { out.destroy(); } catch (e) { /* ignore */ }
          rmrf(destination);
          reject(err);
        }

        res.on('data', function (chunk) {
          received += chunk.length;
          var now = Date.now();
          if (onProgress && (now - lastReport > 180 || received === total)) {
            lastReport = now;
            try { onProgress(received, total); } catch (e2) { /* ignore */ }
          }
        });
        res.on('error', fail);
        out.on('error', fail);
        out.on('finish', function () {
          if (finished) return;
          finished = true;
          resolve({ bytes: received, total: total });
        });
        res.pipe(out);
      });
      req.on('error', function (e) { reject(new Error('Download failed: ' + e.message)); });
      req.setTimeout(60000, function () { req.destroy(new Error('Download stalled (no data for 60 seconds).')); });
    });
  }

  function downloadText(url, redirects) {
    redirects = redirects || 0;
    return new Promise(function (resolve, reject) {
      var req = https.get(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/octet-stream' }
      }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects >= 8) return reject(new Error('Too many redirects.'));
          var next = resolveLocation(url, res.headers.location);
          return downloadText(next, redirects + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(apiError(res.statusCode, ''));
        }
        var body = '';
        res.setEncoding('utf8');
        res.on('data', function (chunk) {
          if (body.length < 1024 * 1024) body += chunk;
        });
        res.on('end', function () { resolve(body); });
      });
      req.on('error', function (e) { reject(new Error('Download failed: ' + e.message)); });
      req.setTimeout(30000, function () { req.destroy(new Error('Network timeout.')); });
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
      zip: pickAsset(assets, 'windows\\.zip$', version),
      sums: pickAsset(assets, '^SHA256SUMS\\.txt$', ''),
      zxp: pickAsset(assets, '\\.zxp$', version)
    };
  }

  /** Prefer an asset whose name contains the release version. */
  function pickAsset(assets, pattern, version) {
    var re = new RegExp(pattern, 'i');
    var fallback = null;
    for (var i = 0; i < assets.length; i++) {
      if (!re.test(assets[i].name)) continue;
      if (version && assets[i].name.indexOf(version) >= 0) return assets[i];
      if (!fallback) fallback = assets[i];
    }
    return fallback;
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

  function expectedSha256(release, asset) {
    if (asset.sha256) return Promise.resolve(asset.sha256.toLowerCase());
    if (!release.sums) return Promise.resolve('');
    return downloadText(release.sums.url).then(function (text) {
      return parseSums(text, asset.name);
    }).catch(function () {
      return '';
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

  function extractZip(powershell, zipFile, destination) {
    var command = "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '" +
      String(zipFile).replace(/'/g, "''") + "' -DestinationPath '" +
      String(destination).replace(/'/g, "''") + "' -Force";
    return new Promise(function (resolve, reject) {
      cp.execFile(powershell, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command
      ], { windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, function (err, stdout, stderr) {
        if (err) {
          var detail = String(stderr || err.message || '').trim();
          return reject(new Error('Could not extract the update' + (detail ? ': ' + detail : '.')));
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

  function prepare(release, onProgress) {
    var cap = capability();
    if (!cap.ok) return Promise.reject(new Error(cap.reason));
    if (!release || !release.zip) {
      return Promise.reject(new Error('This release has no Windows package. Use the release page instead.'));
    }

    var version = release.version;
    var dir = preparedPath(version);
    var zipFile = path.join(dir, 'package.zip');
    var extractDir = path.join(dir, 'extract');

    function report(pct, label) {
      if (typeof onProgress !== 'function') return;
      try { onProgress(Math.max(0, Math.min(100, Math.round(pct))), label); } catch (e) { /* ignore */ }
    }

    var existing = findPrepared(version);
    if (existing) {
      report(100, 'Already downloaded and verified.');
      return Promise.resolve(existing);
    }

    if (!ensureDir(dir)) {
      return Promise.reject(new Error('Could not create the update folder in %APPDATA%\\CaptionAI.'));
    }

    report(0, 'Downloading ' + release.zip.name + ' (' + fmtBytes(release.zip.size) + ')');

    return downloadFile(release.zip.url, zipFile, function (received, total) {
      var pct = total ? (received / total) * 96 : 0;
      report(pct, 'Downloading ' + fmtBytes(received) + (total ? ' of ' + fmtBytes(total) : ''));
    }).then(function () {
      report(97, 'Verifying SHA-256 checksum');
      return expectedSha256(release, release.zip);
    }).then(function (expected) {
      if (!expected) {
        throw new Error('This release has no checksum, so it was not installed. Use the release page.');
      }
      var actual = sha256File(zipFile);
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        rmrf(zipFile);
        throw new Error('Checksum mismatch: the download was corrupted. Try again.');
      }
      report(98, 'Extracting');
      rmrf(extractDir);
      return extractZip(cap.powershell, zipFile, extractDir);
    }).then(function () {
      var source = findExtensionRoot(extractDir, 0);
      if (!source) throw new Error('The downloaded package did not contain the openCaption extension.');
      if (!looksComplete(source)) {
        throw new Error('The downloaded package is incomplete (a panel file or ffmpeg.exe is missing).');
      }

      var found = manifestVersion(source);
      if (!found) throw new Error('The downloaded package has no version in its manifest.');
      if (compareVersions(found, version) !== 0) {
        throw new Error('The package contains version ' + found + ' instead of ' + version + '.');
      }

      rmrf(zipFile);
      cleanupOldVersions(version);
      writeJson(path.join(dir, 'prepared.json'), {
        version: version,
        preparedAt: new Date().toISOString(),
        notes: release.notes,
        htmlUrl: release.htmlUrl
      });

      report(100, 'Downloaded and verified');
      return {
        version: version,
        source: source,
        root: cap.root,
        dir: dir,
        prepared: true
      };
    });
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
    _helperScript: helperScript
  };
})();

/*
 * updater.test.js — exercises extension/js/update.js outside Premiere.
 *
 * The updater is loaded with stubs for the CEP globals (window/NODE/Config)
 * and talks to a local HTTP server that imitates GitHub's behaviour:
 * transient 5xx, a connection that never answers, a truncated body, a body
 * that does not match the published checksum and a stalled download that the
 * user cancels.
 *
 * Run: node tests/updater.test.js
 */
'use strict';

var assert = require('assert');
var cp = require('child_process');
var crypto = require('crypto');
var fs = require('fs');
var http = require('http');
var os = require('os');
var path = require('path');
var vm = require('vm');
var pathToFileURL = require('url').pathToFileURL;

var ROOT = path.resolve(__dirname, '..');
var UPDATE_JS = path.join(ROOT, 'extension', 'js', 'update.js');

var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opencaption-updater-'));
var DATA = path.join(TMP, 'data');
var APPDATA = path.join(TMP, 'appdata');
var INSTALLED = path.join(TMP, 'cep', 'com.captionai.panel');

var Updater = null;
var server = null;
var baseUrl = '';
var sockets = [];

var fixtures = {};

/* ------------------------------------------------------------- utilities */

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function makeExtension(dir, version) {
  writeFile(path.join(dir, 'index.html'), '<!doctype html><title>openCaption ' + version + '</title>');
  writeFile(path.join(dir, 'js', 'app.js'), 'var VERSION = "' + version + '";\n');
  writeFile(path.join(dir, 'js', 'translate.js'), '// translate ' + version + '\n');
  writeFile(path.join(dir, 'jsx', 'host.jsx'), '// host ' + version + '\n');
  writeFile(path.join(dir, 'CSXS', 'manifest.xml'),
    '<ExtensionManifest ExtensionBundleVersion="' + version + '"></ExtensionManifest>');
  writeFile(path.join(dir, 'tools', 'ffmpeg', 'ffmpeg.exe'),
    Buffer.from('fake-ffmpeg-' + version));
}

function zipDir(dir, zipPath) {
  var command = "Compress-Archive -LiteralPath '" + dir.replace(/'/g, "''") +
    "' -DestinationPath '" + zipPath.replace(/'/g, "''") + "' -Force";
  cp.execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command
  ], { stdio: 'pipe' });
}

function buildPackage(version) {
  var stage = path.join(TMP, 'stage-' + version, 'openCaption');
  makeExtension(path.join(stage, 'extension'), version);
  var zipPath = path.join(TMP, 'openCaption-' + version + '.zip');
  zipDir(stage, zipPath);
  var buffer = fs.readFileSync(zipPath);
  return { buffer: buffer, sha: sha256(buffer), size: buffer.length };
}

function hashTree(dir, base) {
  base = base || dir;
  var result = {};
  var entries = fs.readdirSync(dir);
  for (var i = 0; i < entries.length; i++) {
    var file = path.join(dir, entries[i]);
    var stat = fs.statSync(file);
    if (stat.isDirectory()) {
      var nested = hashTree(file, base);
      for (var key in nested) result[key] = nested[key];
    } else {
      result[path.relative(base, file).replace(/\\/g, '/')] = sha256(fs.readFileSync(file));
    }
  }
  return result;
}

function resetData() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
}

/* --------------------------------------------------------------- server */

function startServer() {
  return new Promise(function (resolve) {
    server = http.createServer(function (req, res) {
      var pathname = req.url.split('?')[0];
      var handler = routes[pathname];
      if (!handler) {
        res.writeHead(404, { 'Content-Length': '0' });
        res.end();
        return;
      }
      handler(req, res);
    });
    server.on('connection', function (socket) { sockets.push(socket); });
    server.listen(0, '127.0.0.1', function () {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
}

var routes = {};

function sendZip(res, buffer) {
  res.writeHead(200, {
    'Content-Length': String(buffer.length),
    'Content-Type': 'application/zip'
  });
  res.end(buffer);
}

function loadUpdater() {
  global.window = {
    location: { href: pathToFileURL(path.join(INSTALLED, 'index.html')).href }
  };
  global.NODE = {
    ok: true,
    fs: fs,
    path: path,
    os: os,
    http: http,
    https: require('https'),
    child_process: cp,
    crypto: crypto,
    appData: APPDATA,
    process: {
      platform: 'win32',
      env: {
        SystemRoot: process.env.SystemRoot || 'C:\\Windows',
        APPDATA: APPDATA
      }
    }
  };
  global.Config = { ok: true, DATA_DIR: DATA };

  var source = fs.readFileSync(UPDATE_JS, 'utf8');
  vm.runInThisContext(source + '\n;global.Updater = Updater;', { filename: UPDATE_JS });
  Updater = global.Updater;

  Object.assign(Updater._net, {
    connectTimeout: 400,
    idleTimeout: 800,
    downloadTimeout: 20000,
    textTimeout: 3000,
    maxAttempts: 3,
    retryBase: 15,
    retryMax: 60
  });
}

function makeRelease(version, pkg) {
  return Updater._parseRelease({
    tag_name: 'v' + version,
    name: 'openCaption ' + version,
    html_url: baseUrl + '/release/v' + version,
    body: 'Test release ' + version,
    published_at: '2026-11-04T00:00:00Z',
    assets: [
      {
        id: 424242,
        name: 'openCaption.zip',
        size: pkg.size,
        digest: 'sha256:' + pkg.sha,
        browser_download_url: baseUrl + '/releases/download/v' + version + '/openCaption.zip'
      },
      {
        id: 424243,
        name: 'SHA256SUMS.txt',
        size: 80,
        digest: 'sha256:' + sha256(Buffer.from('sums')),
        browser_download_url: baseUrl + '/sums/v' + version
      }
    ]
  });
}

function prepare(release) {
  var events = [];
  return Updater.prepare(release, function (event) { events.push(event); })
    .then(function (prepared) {
      return { prepared: prepared, events: events };
    }, function (err) {
      err.events = events;
      throw err;
    });
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/* ---------------------------------------------------------------- tests */

/*
 * Scenario 1: the first request is answered with a transient 503, the second
 * connection hangs until the connect deadline, the third succeeds. The whole
 * ZIP must arrive, match the checksum and be staged.
 */
async function scenarioRetry() {
  resetData();

  var version = '9.9.9';
  var pkg = fixtures[version];
  var hits = 0;

  routes = {};
  routes['/releases/download/v' + version + '/openCaption.zip'] = function (req, res) {
    hits += 1;
    if (hits === 1) {
      res.writeHead(503, { 'Content-Length': '0', 'Retry-After': '0' });
      res.end();
      return;
    }
    if (hits === 2) return;             // accept the connection, never answer
    // GitHub answers with a 302 to a separate CDN host; follow the same shape.
    res.writeHead(302, {
      'Content-Length': '0',
      Location: baseUrl + '/cdn/v' + version + '/openCaption.zip'
    });
    res.end();
  };
  routes['/cdn/v' + version + '/openCaption.zip'] = function (req, res) {
    sendZip(res, pkg.buffer);
  };

  var release = makeRelease(version, pkg);
  release.zip.apiUrl = '';

  var started = Date.now();
  var result = await prepare(release);
  var prepared = result.prepared;
  var events = result.events;
  var phases = events.map(function (event) { return event.phase; });

  assert.strictEqual(hits, 3, 'expected two failed attempts then a successful third');
  assert.ok(prepared.source && fs.existsSync(prepared.source), 'staged extension should exist');
  assert.strictEqual(prepared.sha256, pkg.sha, 'staged checksum should match the fixture');
  assert.ok(fs.existsSync(path.join(prepared.source, 'js', 'app.js')), 'panel file should be staged');
  assert.ok(fs.readFileSync(path.join(prepared.source, 'js', 'app.js'), 'utf8').indexOf(version) >= 0,
    'staged panel should be the new version');
  assert.ok(phases.indexOf('retrying') >= 0, 'a retry status should be reported');
  assert.ok(phases.indexOf('verifying') >= 0, 'verification status should be reported');
  assert.ok(phases.indexOf('installing') >= 0, 'staging status should be reported');

  var downloadEvents = events.filter(function (event) {
    return event.phase === 'downloading' && event.total > 0 && event.received === event.total;
  });
  assert.ok(downloadEvents.length > 0, 'progress should reach the content length');

  assert.ok(!fs.existsSync(path.join(DATA, 'updates', version, 'package.zip')),
    'the verified ZIP should be removed after staging');
  assert.ok(fs.existsSync(path.join(DATA, 'updates', version, 'prepared.json')),
    'prepared metadata should be written');
  assert.ok(Date.now() - started < 15000, 'recovery should happen without long stalls');

  console.log('  retries: ' + hits + ' requests, phases: ' + phases.join(' -> '));
}

/*
 * Scenario 2: a truncated body and then a full-size body with the wrong
 * checksum. Both must be refused; the installed panel must not change and no
 * partial file may be left behind.
 */
async function scenarioCorrupt() {
  resetData();

  var version = '9.9.8';
  var pkg = fixtures[version];
  var installedBefore = JSON.stringify(hashTree(INSTALLED));
  var mode = 'incomplete';

  routes = {};
  routes['/releases/download/v' + version + '/openCaption.zip'] = function (req, res) {
    if (mode === 'incomplete') {
      var half = Math.floor(pkg.buffer.length / 2);
      res.writeHead(200, {
        'Content-Length': String(pkg.buffer.length),
        'Content-Type': 'application/zip'
      });
      res.write(pkg.buffer.slice(0, half));
      setTimeout(function () { res.destroy(); }, 20);
      return;
    }
    sendZip(res, crypto.randomBytes(pkg.buffer.length));
  };

  var release = makeRelease(version, pkg);
  release.zip.apiUrl = '';

  var incompleteError = null;
  try {
    await prepare(release);
  } catch (err) {
    incompleteError = err;
  }
  assert.ok(incompleteError, 'a truncated ZIP must not be accepted');
  assert.ok(/incomplete/i.test(incompleteError.userMessage || ''),
    'the incomplete download should explain itself: ' + (incompleteError.userMessage || incompleteError.message));
  assert.ok(incompleteError.releaseUrl, 'the error should carry the release page URL');
  assert.ok(!/\n\s+at /.test(incompleteError.technical || ''), 'technical detail must not be a stack trace');

  await delay(1200);                    // the .part is removed after its handle closes
  var updateDir = path.join(DATA, 'updates', version);
  assert.ok(!fs.existsSync(path.join(updateDir, 'package.zip')), 'no invalid ZIP may remain');
  assert.ok(!fs.existsSync(path.join(updateDir, 'package.zip.part')), 'no partial file may remain');
  assert.ok(!fs.existsSync(path.join(updateDir, 'extract')), 'nothing may be staged');

  mode = 'corrupt';
  var checksumError = null;
  try {
    await prepare(release);
  } catch (err) {
    checksumError = err;
  }
  assert.ok(checksumError, 'a checksum mismatch must not be accepted');
  assert.strictEqual(checksumError.code, 'ECHECKSUM', 'expected a checksum error, got ' + checksumError.code);
  assert.ok(/checksum/i.test(checksumError.userMessage || ''), 'the checksum error should be human readable');

  await delay(1200);
  assert.ok(!fs.existsSync(updateDir) || fs.readdirSync(updateDir).length === 0,
    'the failed update folder should be empty or removed');

  var installedAfter = JSON.stringify(hashTree(INSTALLED));
  assert.strictEqual(installedAfter, installedBefore, 'the installed extension must be byte-identical');
  assert.strictEqual(Updater.capability().ok, true, 'the panel root should still be writable');

  console.log('  refused incomplete (' + incompleteError.code + ') and corrupt (' + checksumError.code + ') downloads');
}

/* Normal path, plus the official API-asset fallback when the release URL fails. */
async function scenarioNormalAndFallback() {
  resetData();

  var version = '9.9.6';
  var pkg = fixtures[version];

  routes = {};
  routes['/releases/download/v' + version + '/openCaption.zip'] = function (req, res) {
    sendZip(res, pkg.buffer);
  };

  var release = makeRelease(version, pkg);
  release.zip.apiUrl = baseUrl + '/repos/Ns345543/openCaption/releases/assets/424242';

  var result = await prepare(release);
  assert.strictEqual(result.prepared.sha256, pkg.sha, 'normal download should verify');

  resetData();
  var fallbackVersion = '9.9.5';
  var fallbackPkg = fixtures[fallbackVersion];
  var primaryHits = 0;
  var apiHits = 0;

  routes = {};
  routes['/releases/download/v' + fallbackVersion + '/openCaption.zip'] = function (req, res) {
    primaryHits += 1;
    res.writeHead(503, { 'Content-Length': '0', 'Retry-After': '0' });
    res.end();
  };
  routes['/repos/Ns345543/openCaption/releases/assets/424242'] = function (req, res) {
    apiHits += 1;
    sendZip(res, fallbackPkg.buffer);
  };

  // No asset digest: force the updater to read SHA256SUMS.txt over HTTP.
  routes['/sums/v' + fallbackVersion] = function (req, res) {
    var text = fallbackPkg.sha + '  openCaption.zip\n';
    res.writeHead(200, {
      'Content-Length': Buffer.byteLength(text),
      'Content-Type': 'text/plain'
    });
    res.end(text);
  };

  var fallbackRelease = makeRelease(fallbackVersion, fallbackPkg);
  fallbackRelease.zip.sha256 = '';
  fallbackRelease.zip.apiUrl = baseUrl + '/repos/Ns345543/openCaption/releases/assets/424242';

  var fallbackResult = await prepare(fallbackRelease);
  assert.strictEqual(fallbackResult.prepared.sha256, fallbackPkg.sha, 'fallback download should verify');
  assert.strictEqual(primaryHits, Updater._net.maxAttempts,
    'the release URL should be retried before falling back');
  assert.strictEqual(apiHits, 1, 'the asset API should be used as the fallback');

  console.log('  normal download verified; fallback used after ' + primaryHits + ' primary attempts');
}

/*
 * Scenario 3: the user cancels while the download is stalled. The request must
 * be aborted without a retry or fallback, no temporary file may remain, the
 * installed tree must stay byte-identical and a later attempt must still work.
 */
async function scenarioCancel() {
  resetData();

  var version = '9.9.7';
  var pkg = fixtures[version];
  var installedBefore = JSON.stringify(hashTree(INSTALLED));
  var url = '/releases/download/v' + version + '/openCaption.zip';

  routes = {};
  routes[url] = function (req, res) {
    res.writeHead(200, {
      'Content-Length': String(pkg.buffer.length),
      'Content-Type': 'application/zip'
    });
    res.write(pkg.buffer.slice(0, Math.floor(pkg.buffer.length / 3)));
    // Never end: the transfer stalls with the connection still open.
  };

  var release = makeRelease(version, pkg);
  release.zip.apiUrl = '';

  var events = [];
  var canceledAt = -1;
  var pending = Updater.prepare(release, function (event) {
    events.push(event);
    if (event.phase === 'downloading' && event.received > 0 && canceledAt < 0) {
      canceledAt = event.received;
      setTimeout(function () { Updater.cancel(); }, 30);
    }
  });

  var error = null;
  try {
    await pending;
  } catch (err) {
    error = err;
  }

  assert.ok(error, 'a cancelled download must reject');
  assert.strictEqual(error.code, 'ECANCELED', 'expected ECANCELED, got ' + error.code);
  assert.ok(/cancel/i.test(error.userMessage || ''), 'the cancellation should be human readable');
  assert.ok(canceledAt > 0, 'cancel should happen after bytes arrived');
  assert.ok(!events.some(function (event) { return event.phase === 'retrying'; }),
    'cancellation must not start a retry');

  await delay(1200);
  var updateDir = path.join(DATA, 'updates', version);
  assert.ok(!fs.existsSync(path.join(updateDir, 'package.zip')), 'no ZIP may remain after cancel');
  assert.ok(!fs.existsSync(path.join(updateDir, 'package.zip.part')), 'no partial file may remain');
  assert.ok(!fs.existsSync(path.join(updateDir, 'extract')), 'nothing may be staged');
  assert.strictEqual(JSON.stringify(hashTree(INSTALLED)), installedBefore,
    'the installed extension must be byte-identical after a cancel');

  // A cancel must only stop the run it belongs to.
  routes[url] = function (req, res) { sendZip(res, pkg.buffer); };
  var retried = await prepare(release);
  assert.strictEqual(retried.prepared.sha256, pkg.sha, 'a retry after cancel should verify');

  console.log('  cancelled after ' + canceledAt + ' bytes, retry verified, no leftovers');
}

/* ---------------------------------------------------------------- runner */

async function main() {
  makeExtension(INSTALLED, '1.8.0');
  fs.mkdirSync(DATA, { recursive: true });

  fixtures['9.9.9'] = buildPackage('9.9.9');
  fixtures['9.9.8'] = buildPackage('9.9.8');
  fixtures['9.9.7'] = buildPackage('9.9.7');
  fixtures['9.9.6'] = buildPackage('9.9.6');
  fixtures['9.9.5'] = buildPackage('9.9.5');

  await startServer();
  loadUpdater();

  var failures = 0;
  async function run(name, fn) {
    process.stdout.write('- ' + name + '\n');
    try {
      await fn();
      process.stdout.write('  PASS\n');
    } catch (err) {
      failures += 1;
      process.stdout.write('  FAIL: ' + (err && err.stack ? err.stack : err) + '\n');
    }
  }

  await run('retry after 503 + connection timeout', scenarioRetry);
  await run('refuse incomplete and corrupted downloads', scenarioCorrupt);
  await run('normal download + asset API fallback', scenarioNormalAndFallback);
  await run('cancel a stalled download', scenarioCancel);

  for (var i = 0; i < sockets.length; i++) {
    try { sockets[i].destroy(); } catch (e) { /* ignore */ }
  }
  await new Promise(function (resolve) { server.close(resolve); });

  fs.rmSync(TMP, { recursive: true, force: true });

  process.stdout.write(failures ? '\n' + failures + ' test(s) failed\n' : '\nAll updater tests passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

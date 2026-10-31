/*
 * config.js — settings persistence.
 *
 * Data lives in %APPDATA%\CaptionAI\config.json so that upgrading or
 * re-installing the extension never wipes the user's API key.
 *
 * The key is obfuscated (XOR + base64), not encrypted. A panel running inside
 * Premiere has no secure enclave to hold a secret; anyone with access to the
 * user's Windows account can recover it. That is an acceptable trade-off for a
 * local tool, but it is why this extension ships without a bundled key.
 */
var Config = (function () {
  if (!NODE.ok) {
    return { ok: false, error: NODE.error };
  }

  var fs = NODE.fs;
  var path = NODE.path;

  var DATA_DIR = path.join(NODE.appData, 'CaptionAI');
  var CONFIG_FILE = path.join(DATA_DIR, 'config.json');
  var CAPTION_DIR = path.join(DATA_DIR, 'captions');
  var TEMP_DIR = path.join(NODE.os.tmpdir(), 'CaptionAI');

  var XOR_KEY = 'caption-ai-local-v1';

  /* Bump when stored settings change shape. v2: characters-per-line became
     words-per-line. v3: the default model moved to the fast tier. v4: "max
     lines" became "lines per caption" (default 1) and words per line is capped
     at 4, so a caption is 2 words on one line unless asked otherwise. */
  var CONFIG_VERSION = 4;

  var DEFAULTS = {
    configVersion: CONFIG_VERSION,
    apiKey: '',
    model: 'gemini-3.5-flash-lite',
    language: 'auto',
    scope: 'auto',
    wordsPerLine: 2,
    maxLines: 1,
    snapPauses: true,
    autoImport: true,
    ffmpegPath: '',
    chunkSec: 30,
    concurrency: 3,
    silenceDb: -35
  };

  function ensureDirs() {
    [DATA_DIR, CAPTION_DIR, TEMP_DIR].forEach(function (dir) {
      try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      } catch (e) { /* non-fatal */ }
    });
  }

  function xorBuffer(text) {
    var buf = Buffer.from(text, 'utf8');
    var out = Buffer.alloc(buf.length);
    for (var i = 0; i < buf.length; i++) {
      out[i] = buf[i] ^ XOR_KEY.charCodeAt(i % XOR_KEY.length);
    }
    return out;
  }

  function encodeKey(plain) {
    if (!plain) return '';
    return 'enc1:' + xorBuffer(plain).toString('base64');
  }

  function decodeKey(stored) {
    if (!stored) return '';
    if (stored.indexOf('enc1:') !== 0) return stored; // legacy / plain
    try {
      return xorBuffer(Buffer.from(stored.slice(5), 'base64')).toString('utf8');
    } catch (e) {
      return '';
    }
  }

  function load() {
    ensureDirs();
    var raw = {};
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      }
    } catch (e) {
      raw = {};
    }

    var merged = {};
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) {
        merged[k] = (raw[k] === undefined) ? DEFAULTS[k] : raw[k];
      }
    }
    merged.apiKey = decodeKey(raw.apiKey || '');

    /* --- migration -----------------------------------------------------
       v1 saved a character budget (maxChars) and remembered a literal range
       such as "selection". Convert the width to words and send the range
       back to auto so an old choice cannot silently transcribe the wrong
       part of a new sequence. */
    var storedVersion = Number(raw.configVersion) || 1;
    var hadConfig = false;
    for (var rk in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, rk)) { hadConfig = true; break; }
    }

    if (hadConfig && storedVersion < CONFIG_VERSION) {
      if (storedVersion < 2) {
        if (raw.wordsPerLine === undefined && raw.maxChars !== undefined) {
          // ~8 characters per spoken word + space, so 42 chars ≈ 4-5 words,
          // capped at the 4 the control now offers.
          var legacyChars = Number(raw.maxChars);
          merged.wordsPerLine = Math.max(2, Math.min(4,
            Math.round((isFinite(legacyChars) && legacyChars > 0 ? legacyChars : 42) / 8)));
        }
        merged.scope = 'auto';
      }

      // v3: this model accepted requests but took ~100s to answer a 1.2s clip
      // on the free tier; flash-lite answered the same probe in ~2s.
      if (merged.model === 'gemini-3.8-flash') merged.model = 'gemini-3.5-flash-lite';

      merged.configVersion = CONFIG_VERSION;
      save(merged); // rewrite in the new shape exactly once
    }

    // The two controls are selects now. Keep hand-edited or legacy values
    // inside the options that actually exist, so the panel never shows blank.
    merged.wordsPerLine = Math.min(4, Math.max(1,
      Math.round(Number(merged.wordsPerLine) || DEFAULTS.wordsPerLine)));
    merged.maxLines = Math.min(3, Math.max(1,
      Math.round(Number(merged.maxLines) || DEFAULTS.maxLines)));

    merged.configVersion = CONFIG_VERSION;

    return merged;
  }

  function save(settings) {
    ensureDirs();
    var onDisk = {};
    for (var k in settings) {
      if (!Object.prototype.hasOwnProperty.call(settings, k)) continue;
      if (k === 'apiKey') {
        onDisk.apiKey = encodeKey(settings.apiKey);
      } else {
        onDisk[k] = settings[k];
      }
    }
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(onDisk, null, 2), 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function sanitizeName(name) {
    return String(name || 'sequence')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'sequence';
  }

  function timestamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
           p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  return {
    ok: true,
    DEFAULTS: DEFAULTS,
    DATA_DIR: DATA_DIR,
    CONFIG_FILE: CONFIG_FILE,
    CAPTION_DIR: CAPTION_DIR,
    TEMP_DIR: TEMP_DIR,
    ensureDirs: ensureDirs,
    load: load,
    save: save,
    sanitizeName: sanitizeName,
    timestamp: timestamp
  };
})();

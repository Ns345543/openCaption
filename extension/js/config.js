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

  var MOGRT_DEFAULTS = {
    activeMode: '',
    selectedPath: '',
    selectedStylePath: '',
    paramIndex: 0,
    fillMode: 'split',
    trackMode: 'auto',
    position: 'lower',
    positionY: 82,
    fitToScreen: true,
    textCase: 'as-is',
    clampOverlaps: true,
    replaceExisting: true,
    autoApply: false,
    autoStyleOnTranscribe: true,
    activeFilter: 'all',
    customCategories: [],
    itemCategories: {}
  };

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
    silenceDb: -35,
    theme: 'mono',
    customTheme: null,
    cornerRadius: 0,
    uiMotion: true,
    liquidGlass: false,
    mogrt: MOGRT_DEFAULTS,
    ambient: {
      creature: 'butterflies',
      byCreature: {}
    },
    collapsedCards: {},
    activeTab: 'transcribe'
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

    var rawMogrt = (raw.mogrt && typeof raw.mogrt === 'object') ? raw.mogrt : {};
    var mogrt = {};
    for (var mk in MOGRT_DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(MOGRT_DEFAULTS, mk)) {
        var dv = MOGRT_DEFAULTS[mk];
        var rv = rawMogrt[mk];
        if (Array.isArray(dv)) {
          mogrt[mk] = Array.isArray(rv) ? rv.slice() : dv.slice();
        } else if (dv && typeof dv === 'object') {
          mogrt[mk] = (rv && typeof rv === 'object' && !Array.isArray(rv)) ? Object.assign({}, rv) : Object.assign({}, dv);
        } else {
          mogrt[mk] = (rv === undefined) ? dv : rv;
        }
      }
    }
    merged.mogrt = mogrt;
    if (mogrt.activeMode !== 'mogrt' && mogrt.activeMode !== 'style') {
      if (mogrt.selectedStylePath) {
        mogrt.activeMode = 'style';
      } else if (mogrt.selectedPath) {
        mogrt.activeMode = 'mogrt';
      } else {
        mogrt.activeMode = '';
      }
    }

    var rawAmbient = (raw.ambient && typeof raw.ambient === 'object') ? raw.ambient : {};
    var byCreature = {};
    if (rawAmbient.byCreature && typeof rawAmbient.byCreature === 'object') {
      for (var ck in rawAmbient.byCreature) {
        if (Object.prototype.hasOwnProperty.call(rawAmbient.byCreature, ck) &&
            rawAmbient.byCreature[ck] && typeof rawAmbient.byCreature[ck] === 'object') {
          byCreature[ck] = Object.assign({}, rawAmbient.byCreature[ck]);
        }
      }
    }
    merged.ambient = {
      creature: typeof rawAmbient.creature === 'string' && rawAmbient.creature ? rawAmbient.creature : DEFAULTS.ambient.creature,
      byCreature: byCreature
    };

    var rawCollapsed = (raw.collapsedCards && typeof raw.collapsedCards === 'object') ? raw.collapsedCards : {};
    var collapsedCards = {};
    for (var cc in rawCollapsed) {
      if (Object.prototype.hasOwnProperty.call(rawCollapsed, cc) && rawCollapsed[cc]) {
        collapsedCards[cc] = true;
      }
    }
    merged.collapsedCards = collapsedCards;
    // Keys never contain whitespace; strip anything a paste picked up so an
    // old saved value cannot fail every request.
    merged.apiKey = decodeKey(raw.apiKey || '').replace(/[\s\u00a0\u200b-\u200f\ufeff]+/g, '');

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

    // Keep hand-edited or legacy values inside sane numeric bounds.
    merged.wordsPerLine = Math.min(50, Math.max(1,
      Math.round(Number(merged.wordsPerLine) || DEFAULTS.wordsPerLine)));
    merged.maxLines = Math.min(20, Math.max(1,
      Math.round(Number(merged.maxLines) || DEFAULTS.maxLines)));

    var rad = Number(merged.cornerRadius);
    merged.cornerRadius = isFinite(rad) ? Math.min(16, Math.max(0, Math.round(rad))) : 0;
    merged.uiMotion = merged.uiMotion !== false;
    merged.liquidGlass = !!merged.liquidGlass;

    merged.configVersion = CONFIG_VERSION;

    return merged;
  }

  function readStoredKey() {
    try {
      if (!fs.existsSync(CONFIG_FILE)) return '';
      var raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return (raw && typeof raw.apiKey === 'string') ? raw.apiKey : '';
    } catch (e) {
      return '';
    }
  }

  /**
   * Writes the settings. `opts.clearKey` is the only way to erase a saved key:
   * a plain save with an empty key means the caller has not loaded the key
   * (a second panel instance, or settings captured before the key was typed),
   * so the encoded key already on disk is kept instead of being blanked.
   */
  function save(settings, opts) {
    ensureDirs();
    opts = opts || {};

    var keepKey = '';
    if (!opts.clearKey && !settings.apiKey) keepKey = readStoredKey();

    var onDisk = {};
    for (var k in settings) {
      if (!Object.prototype.hasOwnProperty.call(settings, k)) continue;
      if (k === 'apiKey') {
        onDisk.apiKey = keepKey || encodeKey(settings.apiKey);
      } else {
        onDisk[k] = settings[k];
      }
    }
    if (onDisk.apiKey === undefined) onDisk.apiKey = keepKey || '';

    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(onDisk, null, 2), 'utf8');
      return { ok: true, keyKept: !!keepKey };
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

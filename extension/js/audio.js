/*
 * audio.js — pulls audio straight out of the timeline's source media.
 *
 * No rendering, no Media Encoder. For a given sequence time window we read the
 * overlapping clips, seek into each clip's original media file with ffmpeg, and
 * paste the PCM back together at the exact sequence offset. Gaps stay silent, so
 * timestamps from the model line up with the timeline 1:1.
 */
var Audio = (function () {
  if (!NODE.ok) return { ok: false, error: NODE.error };

  var fs = NODE.fs;
  var path = NODE.path;
  var spawnSync = NODE.child_process.spawnSync;

  var SAMPLE_RATE = 16000;

  var ffmpegPath = '';
  var lastError = '';

  function exists(p) {
    try { return !!p && fs.existsSync(p); } catch (e) { return false; }
  }

  function run(exe, args) {
    try {
      return spawnSync(exe, args, {
        maxBuffer: 512 * 1024 * 1024,
        windowsHide: true,
        encoding: 'buffer'
      });
    } catch (e) {
      return { error: e, status: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
  }

  /** Runs "<exe> -version" and reports exactly why it did or didn't work. */
  function probe(exe) {
    if (!exe) return { ok: false, detail: 'empty path' };
    if (!exists(exe)) return { ok: false, detail: 'not found: ' + exe };

    var r = run(exe, ['-hide_banner', '-version']);
    if (r.error) return { ok: false, detail: 'cannot run: ' + (r.error.message || String(r.error)) };
    if (r.status !== 0) {
      var err = (r.stderr || Buffer.alloc(0)).toString('utf8').trim().slice(0, 140);
      return { ok: false, detail: 'exit ' + r.status + (err ? ': ' + err : '') };
    }
    var out = (r.stdout || Buffer.alloc(0)).toString('utf8');
    if (out.indexOf('ffmpeg version') < 0) {
      return { ok: false, detail: 'not ffmpeg: ' + out.slice(0, 80) };
    }
    return { ok: true, detail: out.split(/\r?\n/)[0] };
  }

  function isWorkingFfmpeg(exe) {
    return probe(exe).ok;
  }

  function whereFfmpeg() {
    // `where` is the Windows lookup command; other platforms use `which`.
    var finder = (NODE.process && NODE.process.platform &&
                  NODE.process.platform !== 'win32') ? 'which' : 'where';
    var r = run(finder, ['ffmpeg']);
    if (r.status !== 0 || !r.stdout) return '';
    var lines = r.stdout.toString('utf8').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    for (var i = 0; i < lines.length; i++) {
      if (isWorkingFfmpeg(lines[i])) return lines[i];
    }
    return '';
  }

  /** Every plausible root of the extension, most reliable first. */
  function extensionRoots() {
    var roots = [];

    // 1. Node knows where this script lives (extension/js). That is the
    //    installation folder itself, so nothing here depends on the user name
    //    or on where this copy of the panel happens to be installed.
    try {
      if (typeof __dirname === 'string' && __dirname) {
        roots.push(path.resolve(__dirname, '..'));
      }
    } catch (e0) { /* ignore */ }

    // 2. CEP's own answer.
    try {
      if (window.__adobe_cep__ && window.__adobe_cep__.getSystemPath) {
        var viaCep = window.__adobe_cep__.getSystemPath('extension');
        if (viaCep) roots.push(viaCep);
      }
    } catch (e1) { /* ignore */ }

    // 3. Our CSInterface shim.
    try {
      var viaShim = new CSInterface().getSystemPath(SystemPath.EXTENSION);
      if (viaShim) roots.push(viaShim);
    } catch (e2) { /* ignore */ }

    // 4. Where index.html was actually loaded from. Works even if CEP's path
    //    API misbehaves, and it follows the junction to the real folder.
    try {
      var loc = window.location && window.location.pathname ? String(window.location.pathname) : '';
      if (loc) {
        var decoded = decodeURIComponent(loc).replace(/^\/+/, '').replace(/\//g, '\\');
        var cut = decoded.toLowerCase().lastIndexOf('\\index.html');
        if (cut > 0) roots.push(decoded.slice(0, cut));
      }
    } catch (e3) { /* ignore */ }

    // 5. Node's working directory, in case CEP launched us from the extension dir.
    try {
      var cwd = NODE.process && NODE.process.cwd ? NODE.process.cwd() : '';
      if (cwd) roots.push(cwd);
    } catch (e4) { /* ignore */ }

    // 6. The installed CEP location for this extension id. APPDATA is read
    //    from the current process, never from a path baked into the package.
    try {
      roots.push(path.join(NODE.appData, 'Adobe', 'CEP', 'extensions', 'com.captionai.panel'));
    } catch (e5) { /* ignore */ }

    var unique = [];
    for (var i = 0; i < roots.length; i++) {
      if (!roots[i]) continue;
      var root = String(roots[i]).replace(/[\\\/]+$/, '');
      // Resolve a development junction to the folder that really holds tools/.
      try {
        if (fs.existsSync(root)) root = fs.realpathSync(root);
      } catch (eR) { /* keep the unresolved path */ }
      if (unique.indexOf(root) === -1) unique.push(root);
    }
    return unique;
  }

  function bundledCandidates() {
    var list = [];
    var roots = extensionRoots();
    var names = ['ffmpeg.exe', 'ffmpeg'];
    for (var i = 0; i < roots.length; i++) {
      for (var n = 0; n < names.length; n++) {
        list.push(path.join(roots[i], 'tools', 'ffmpeg', names[n]));
        list.push(path.join(roots[i], 'tools', 'ffmpeg', 'bin', names[n]));
      }
    }
    return list;
  }

  /** Everything resolve() tries, with the reason each one failed. */
  function diagnose(customPath) {
    var lines = [];
    var roots = extensionRoots();
    lines.push('extension roots:');
    if (!roots.length) lines.push('  (none discovered)');
    for (var i = 0; i < roots.length; i++) lines.push('  ' + roots[i]);

    var candidates = [];
    if (customPath) candidates.push(customPath);
    candidates = candidates.concat(bundledCandidates());

    lines.push('candidates:');
    for (var c = 0; c < candidates.length; c++) {
      var p = probe(candidates[c]);
      lines.push('  ' + (p.ok ? '[ok] ' : '[--] ') + candidates[c] + (p.ok ? '' : '  ← ' + p.detail));
    }

    var onPath = whereFfmpeg();
    lines.push('on PATH: ' + (onPath || '(none)'));
    return lines;
  }

  /** Resolves and caches the ffmpeg binary. Returns '' when nothing works. */
  function resolve(customPath) {
    if (ffmpegPath && isWorkingFfmpeg(ffmpegPath)) return ffmpegPath;

    var candidates = [];
    if (customPath) candidates.push(customPath);
    candidates = candidates.concat(bundledCandidates());

    for (var i = 0; i < candidates.length; i++) {
      if (isWorkingFfmpeg(candidates[i])) {
        ffmpegPath = candidates[i];
        lastError = '';
        return ffmpegPath;
      }
    }

    var fromPath = whereFfmpeg();
    if (fromPath) {
      ffmpegPath = fromPath;
      lastError = '';
      return ffmpegPath;
    }

    ffmpegPath = '';
    lastError = 'ffmpeg.exe was not found. Reinstall openCaption so the bundled copy is restored, ' +
                'or point the panel at ffmpeg.exe under Advanced.';
    return '';
  }

  function ffmpegError(r) {
    var err = (r.stderr || Buffer.alloc(0)).toString('utf8').trim();
    if (!err) err = (r.stdout || Buffer.alloc(0)).toString('utf8').trim();
    var lines = err.split(/\r?\n/).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : 'ffmpeg exited with code ' + r.status;
  }

  /** atempo only accepts 0.5-2 per instance; chain it for extreme speeds. */
  function atempoFilter(tempo) {
    var parts = [];
    var t = tempo;
    while (t > 2) { parts.push('atempo=2'); t /= 2; }
    while (t < 0.5) { parts.push('atempo=0.5'); t /= 0.5; }
    parts.push('atempo=' + t.toFixed(6));
    return parts.join(',');
  }

  /** Returns raw s16le mono PCM for [start, start+dur) of the given media file. */
  function extractPcm(file, start, dur, tempo) {
    if (!ffmpegPath) throw new Error(lastError || 'ffmpeg is not configured.');
    var args = [
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-ss', Math.max(0, start).toFixed(3),
      '-t', Math.max(0.05, dur).toFixed(3),
      '-i', file,
      '-vn', '-map', '0:a:0'
    ];
    if (tempo && Math.abs(tempo - 1) > 0.001) args.push('-af', atempoFilter(tempo));
    args.push(
      '-ac', '1', '-ar', String(SAMPLE_RATE),
      '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'
    );
    var r = run(ffmpegPath, args);
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(ffmpegError(r));
    return r.stdout || Buffer.alloc(0);
  }

  /** True when the media file has at least one audio stream. */
  function hasAudio(file) {
    if (!ffmpegPath) return false;
    var r = run(ffmpegPath, ['-hide_banner', '-nostdin', '-i', file]);
    var text = ((r.stderr || Buffer.alloc(0)).toString('utf8'));
    return /Stream #\d+:\d+.*: Audio:/.test(text);
  }

  /**
   * Builds a PCM buffer covering [from, to) of the sequence.
   * plan: array of { track, start, end, in, out, speed, path, name }
   */
  function renderChunk(plan, from, to, onWarn) {
    var total = Math.max(1, Math.round((to - from) * SAMPLE_RATE));
    var out = Buffer.alloc(total * 2);
    var filled = new Uint8Array(total);

    var pieces = plan.filter(function (c) { return c.end > from && c.start < to; });
    pieces.sort(function (a, b) { return (a.track - b.track) || (a.start - b.start); });

    for (var i = 0; i < pieces.length; i++) {
      var c = pieces[i];
      var s = Math.max(c.start, from);
      var e = Math.min(c.end, to);
      if (e - s < 0.05) continue;

      var speed = (c.speed && c.speed > 0) ? c.speed : 1;
      var srcStart = c.srcIn + (s - c.start) * speed;
      var dur = e - s;

      var pcm;
      try {
        /* A speed-changed clip occupies dur seconds of timeline but speed*dur
           seconds of its source. Read that whole span and tempo-match it back,
           otherwise the slice is truncated and every word after it is early. */
        pcm = extractPcm(c.path, srcStart, dur * speed, speed !== 1 ? 1 / speed : 1);
      } catch (err) {
        if (onWarn) onWarn('Could not read "' + (c.name || path.basename(c.path)) + '": ' + err.message);
        continue;
      }
      if (!pcm.length) {
        if (onWarn) onWarn('No audio returned for "' + (c.name || path.basename(c.path)) + '".');
        continue;
      }

      var offset = Math.round((s - from) * SAMPLE_RATE);
      var count = Math.min(Math.floor(pcm.length / 2), total - offset);
      for (var n = 0; n < count; n++) {
        if (filled[offset + n]) continue;   // a higher-priority track already covers this sample
        out.writeInt16LE(pcm.readInt16LE(n * 2), (offset + n) * 2);
        filled[offset + n] = 1;
      }
    }
    return out;
  }

  /** Peak amplitude as a fraction of full scale. */
  function peak(pcm) {
    var max = 0;
    for (var i = 0; i + 1 < pcm.length; i += 2) {
      var v = Math.abs(pcm.readInt16LE(i));
      if (v > max) max = v;
    }
    return max / 32768;
  }

  function wavBuffer(pcm) {
    var header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);          // fmt chunk size
    header.writeUInt16LE(1, 20);           // PCM
    header.writeUInt16LE(1, 22);           // mono
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
    header.writeUInt16LE(2, 32);           // block align
    header.writeUInt16LE(16, 34);          // bits per sample
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
  }

  function writeWavFile(pcm, file) {
    var dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, wavBuffer(pcm));
    return file;
  }

  /* ------------------------------------------------------- speech envelope */

  var ENV_FRAME = 320;   // 20 ms at 16 kHz
  var ENV_HOP = 160;     // 10 ms between frames
  var ENV_BRIDGE = 0.12; // merge speech runs separated by less than this
  var ENV_MIN = 0.06;    // drop blips shorter than this
  var ENV_PAD = 0.03;    // give each run a hair of margin at both ends

  /**
   * Finds the spans of a PCM chunk that actually contain audible speech.
   *
   * The model's cue timestamps drift by a few hundred milliseconds, so the
   * panel does not use them as the final answer. It measures the audio we
   * already hold: a 10 ms RMS envelope, thresholded at the user's noise floor,
   * gives the exact places where sound starts and stops. Word timing is then
   * allocated inside those spans, which removes most of the latency error.
   *
   * Returns [{ start, end }] in seconds from the first sample.
   */
  function speechSegments(pcm, opts) {
    opts = opts || {};
    if (!pcm || pcm.length < ENV_FRAME * 2) return [];

    var limit = (typeof opts.db === 'number') ? opts.db : -35;
    var total = pcm.length / 2;

    var frames = [];
    for (var pos = 0; pos + ENV_FRAME <= total; pos += ENV_HOP) {
      var sum = 0;
      for (var i = 0; i < ENV_FRAME; i++) {
        var v = pcm.readInt16LE((pos + i) * 2) / 32768;
        sum += v * v;
      }
      var rms = Math.sqrt(sum / ENV_FRAME);
      frames.push(20 * Math.log10(Math.max(rms, 1e-6)));
    }
    if (!frames.length) return [];

    /* The preset is the user's call: raise it for a noisy room, lower it for
       quiet dialogue. Adapting to the slice's own level would misread
       continuous speech as a loud noise floor. */
    var threshold = Math.min(-10, limit);

    /* 3-frame mean smooths single-frame spikes without moving edges much. */
    var voiced = new Array(frames.length);
    for (var f = 0; f < frames.length; f++) {
      var a = frames[Math.max(0, f - 1)];
      var b = frames[f];
      var c = frames[Math.min(frames.length - 1, f + 1)];
      voiced[f] = ((a + b + c) / 3) > threshold;
    }

    var hop = ENV_HOP / SAMPLE_RATE;
    var bridgeFrames = Math.max(1, Math.round(ENV_BRIDGE / hop));
    var minFrames = Math.max(1, Math.round(ENV_MIN / hop));

    var runs = [];
    for (var g = 0; g < voiced.length; g++) {
      if (!voiced[g]) continue;
      var start = g;
      while (g + 1 < voiced.length && voiced[g + 1]) g++;
      runs.push([start, g + 1]);            // [first frame, one past last]
    }

    var merged = [];
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      if (merged.length && run[0] - merged[merged.length - 1][1] <= bridgeFrames) {
        merged[merged.length - 1][1] = run[1];
      } else {
        merged.push(run);
      }
    }

    var duration = total / SAMPLE_RATE;
    var out = [];
    for (var m = 0; m < merged.length; m++) {
      if (merged[m][1] - merged[m][0] < minFrames) continue;
      var s = Math.max(0, merged[m][0] * hop - ENV_PAD);
      var e = Math.min(duration, merged[m][1] * hop + ENV_PAD);
      if (e - s >= 0.03) out.push({ start: s, end: e });
    }
    return out;
  }

  function tempFile(name) {
    var dir = path.join(NODE.os.tmpdir(), 'CaptionAI');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
  }

  function cleanup(file) {
    try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch (e) { /* ignore */ }
  }

  return {
    ok: true,
    SAMPLE_RATE: SAMPLE_RATE,
    resolve: resolve,
    diagnose: diagnose,
    status: function () { return { path: ffmpegPath, error: lastError }; },
    extractPcm: extractPcm,
    hasAudio: hasAudio,
    renderChunk: renderChunk,
    peak: peak,
    wavBuffer: wavBuffer,
    writeWavFile: writeWavFile,
    speechSegments: speechSegments,
    tempFile: tempFile,
    cleanup: cleanup
  };
})();

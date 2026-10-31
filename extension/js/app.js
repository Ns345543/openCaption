/*
 * app.js — UI wiring and the end-to-end caption pipeline.
 *
 *   timeline  ->  clip list (ExtendScript)
 *             ->  30s PCM slices pulled from source media (ffmpeg)
 *             ->  Gemini transcription per slice
 *             ->  cue clean-up / pause snapping (Srt)
 *             ->  .srt on disk
 *             ->  caption track in the sequence (ExtendScript)
 */
(function () {
  'use strict';

  var els = {};
  var settings = null;
  var running = false;
  var activeRun = null;
  var cs = new CSInterface();

  var VERSION = '1.2.0';

  function $(id) { return document.getElementById(id); }

  function clamp(v, lo, hi) {
    v = Number(v);
    if (!isFinite(v)) v = lo;
    return Math.min(hi, Math.max(lo, v));
  }

  function fmtTime(sec) {
    sec = Math.max(0, sec);
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    var cs10 = Math.floor((sec - Math.floor(sec)) * 10);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + '.' + cs10;
  }

  var SCOPE_LABELS = {
    auto: 'auto-detected range',
    selection: 'selected clips',
    workarea: 'work area',
    sequence: 'whole sequence'
  };

  /** Human-readable resolved range, e.g. "work area (auto)". */
  function scopeLabel(info) {
    var effective = (info && info.scope) || 'sequence';
    var requested = (info && info.requestedScope) || effective;
    var text = SCOPE_LABELS[effective] || effective;
    return requested === 'auto' ? text + ' — auto' : text;
  }

  function log(msg, cls) {
    var line = document.createElement('div');
    if (cls) line.className = 'l-' + cls;
    line.textContent = msg;
    els.log.appendChild(line);
    els.log.scrollTop = els.log.scrollHeight;
  }

  function clearLog() { els.log.innerHTML = ''; }

  function progress(pct, label) {
    els.bar.style.width = clamp(pct, 0, 100) + '%';
    if (label !== undefined) els.progressLabel.textContent = label;
  }

  /* ------------------------------------------------------------ settings */

  function wordCount(value, min, max, fallback) {
    var n = Math.round(Number(value));
    if (!isFinite(n)) n = fallback;
    return Math.min(max, Math.max(min, n));
  }

  /** Mirrors the two selects into one sentence: "2 lines of 3 words". */
  function updateCaptionShape() {
    if (!els.captionShape) return;
    var per = wordCount(els.wordsPerLine.value, 1, 4, 2);
    var lines = wordCount(els.maxLines.value, 1, 3, 1);

    if (lines === 1) {
      els.captionShape.textContent = per + (per === 1 ? ' word' : ' words') +
        ' in one line — one short caption at a time.';
    } else {
      els.captionShape.textContent = lines + ' lines of ' + per +
        (per === 1 ? ' word' : ' words') + ' — up to ' + (per * lines) +
        ' words in one caption.';
    }
  }

  function readForm() {
    var modelSelect = els.model.value;
    settings.model = (modelSelect === '__custom')
      ? (els.customModel.value.trim() || Config.DEFAULTS.model)
      : modelSelect;
    settings.language = els.language.value;
    settings.scope = document.querySelector('#scope button.active').dataset.scope;
    settings.wordsPerLine = wordCount(els.wordsPerLine.value, 1, 4, 2);
    settings.maxLines = wordCount(els.maxLines.value, 1, 3, 1);
    settings.snapPauses = els.snapPauses.checked;
    settings.autoImport = els.autoImport.checked;
    settings.ffmpegPath = els.ffmpegPath.value.trim();
    settings.chunkSec = clamp(els.chunkSec.value, 10, 120);
    settings.concurrency = clamp(els.concurrency.value, 1, 6);
    settings.silenceDb = clamp(els.silenceDb.value, -60, -10);
  }

  function persist() {
    readForm();
    var res = Config.save(settings);
    if (!res.ok) log('! Could not save settings: ' + res.error, 'warn');
  }

  function applyToForm() {
    els.model.value = settings.model;
    if (els.model.value !== settings.model) {
      els.model.value = '__custom';
      els.customModel.value = settings.model;
      els.customModelWrap.classList.remove('hidden');
    }
    els.language.value = settings.language;
    if (!els.language.value) els.language.value = 'auto';

    var scopeButtons = document.querySelectorAll('#scope button');
    for (var i = 0; i < scopeButtons.length; i++) {
      scopeButtons[i].classList.toggle('active', scopeButtons[i].dataset.scope === settings.scope);
    }

    els.wordsPerLine.value = String(wordCount(settings.wordsPerLine, 1, 4, 2));
    els.maxLines.value = String(wordCount(settings.maxLines, 1, 3, 1));
    updateCaptionShape();
    els.snapPauses.checked = !!settings.snapPauses;
    els.autoImport.checked = !!settings.autoImport;
    els.ffmpegPath.value = settings.ffmpegPath || '';
    els.chunkSec.value = settings.chunkSec;
    els.concurrency.value = settings.concurrency;
    els.silenceDb.value = settings.silenceDb;

    els.apiKey.value = settings.apiKey || '';
    setKeyBadge(!!settings.apiKey);
  }

  function setKeyBadge(hasKey) {
    els.keyBadge.textContent = hasKey ? 'saved' : 'not set';
    els.keyBadge.className = 'badge' + (hasKey ? ' ok' : '');
  }

  /* ------------------------------------------------------------- models */

  /** Rebuilds the model dropdown from what the API says this key can use. */
  function populateModels(ids, silent) {
    var usable = Gemini.audioModels(ids);
    if (!usable.length) {
      if (!silent) log('! The API returned no usable Gemini models for this key.', 'warn');
      return;
    }

    var previous = settings.model;

    els.model.innerHTML = '';
    usable.forEach(function (id) {
      var opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      els.model.appendChild(opt);
    });
    var custom = document.createElement('option');
    custom.value = '__custom';
    custom.textContent = 'Custom…';
    els.model.appendChild(custom);

    if (usable.indexOf(previous) >= 0) {
      els.model.value = previous;
    } else {
      var pick = usable.filter(function (m) { return /flash/.test(m); })[0] || usable[0];
      els.model.value = pick;
      settings.model = pick;
      if (!silent) {
        log('Model set to "' + pick + '"' +
            (previous ? ' — "' + previous + '" is not available to this key.' : '.'), 'warn');
      }
    }

    persist();
  }

  async function testSelectedModel() {
    var key = els.apiKey.value.trim() || (settings && settings.apiKey) || '';
    if (!key) { log('! Enter your API key first.', 'warn'); return; }

    var model = (els.model.value === '__custom')
      ? els.customModel.value.trim()
      : els.model.value;
    if (!model) { log('! Pick a model first.', 'warn'); return; }

    els.testModel.disabled = true;
    try {
      // Two probes: text proves the key and the model work, audio proves the
      // path that Generate actually uses. A model can pass one and hang on the
      // other, which is exactly the "no response" case this is meant to expose.
      log('Text probe: sending a few words to "' + model + '"…', 'dim');
      var text = await Gemini.testModel(key, model);
      var tSecs = (text.ms / 1000).toFixed(1);

      if (!text.ok) {
        log('! Text probe failed after ' + tSecs + 's — ' + text.error, 'err');
        return;
      }
      log('Text probe: answered in ' + tSecs + 's ("' + String(text.text || '').slice(0, 30) + '").', 'ok');

      log('Audio probe: sending 1.2s of synthetic audio…', 'dim');
      var audio = await Gemini.testAudio(key, model);
      var aSecs = (audio.ms / 1000).toFixed(1);

      if (!audio.ok) {
        log('! Audio probe failed after ' + aSecs + 's — ' + audio.error, 'err');
        log('  Text works but audio does not. Pick a flash-lite model: it answered this probe in ~2s.', 'warn');
        return;
      }

      var fb = (audio.firstByteMs || 0) / 1000;
      log('Audio probe: ' + aSecs + 's total, first byte at ' + fb.toFixed(1) + 's, ' + audio.cues + ' cue(s).', 'ok');
      log('Model looks healthy — Generate should work.', 'dim');
    } catch (e) {
      log('! ' + e.message, 'err');
    } finally {
      els.testModel.disabled = false;
    }
  }

  async function refreshModelList(silent) {
    var key = els.apiKey.value.trim() || (settings && settings.apiKey) || '';
    if (!key) {
      if (!silent) log('! Enter your API key first.', 'warn');
      return;
    }

    els.refreshModels.disabled = true;
    try {
      var res = await Gemini.validateKey(key);
      if (!res.ok) {
        if (!silent) log('! ' + res.error, 'err');
        return;
      }
      populateModels(res.models, silent);
      if (!silent) log('Loaded ' + Gemini.audioModels(res.models).length + ' models from the API.', 'dim');
    } catch (e) {
      if (!silent) log('! ' + e.message, 'err');
    } finally {
      els.refreshModels.disabled = false;
    }
  }

  /* --------------------------------------------------------------- key */

  async function saveKey() {
    var key = els.apiKey.value.trim();
    settings.apiKey = key;
    persist();
    setKeyBadge(!!key);
    if (!key) { log('API key cleared.', 'dim'); return; }
    log('API key saved locally.', 'ok');
    await testKey();
  }

  async function testKey() {
    var key = els.apiKey.value.trim();
    if (!key) { log('! Enter a key first.', 'warn'); return; }
    els.testKey.disabled = true;
    els.keyBadge.textContent = 'checking…';
    els.keyBadge.className = 'badge';
    try {
      var res = await Gemini.validateKey(key);
      if (res.ok) {
        els.keyBadge.textContent = 'valid';
        els.keyBadge.className = 'badge ok';
        log('Key is valid. ' + Gemini.audioModels(res.models).length + ' usable models found.', 'ok');
        populateModels(res.models, true);
      } else {
        els.keyBadge.textContent = 'invalid';
        els.keyBadge.className = 'badge err';
        log('! ' + res.error, 'err');
      }
    } catch (e) {
      els.keyBadge.textContent = 'error';
      els.keyBadge.className = 'badge err';
      log('! ' + e.message, 'err');
    } finally {
      els.testKey.disabled = false;
    }
  }

  /* ------------------------------------------------------------ pipeline */

  function preparePlan(info, warn) {
    var plan = [];
    var missing = 0;

    for (var i = 0; i < info.clips.length; i++) {
      var c = info.clips[i];
      var exists = false;
      try { exists = NODE.fs.existsSync(c.path); } catch (e) { exists = false; }
      if (!exists) {
        missing++;
        warn('Missing media for "' + c.name + '": ' + c.path);
        continue;
      }
      plan.push(c);
    }

    if (!plan.length) {
      throw new Error('None of the clips in this range could be read from disk (' + missing + ' missing file(s)).');
    }
    return plan;
  }

  /** Marker error: the run was stopped by the user, not by a failure. */
  function cancelledError() {
    var e = new Error('Cancelled by user.');
    e.cancelled = true;
    return e;
  }

  function requestCancel() {
    if (!running || !activeRun || activeRun.token.cancelled) return;

    activeRun.token.cancelled = true;
    Gemini.cancel(activeRun.token);   // hangs up on every open request

    els.cancel.disabled = true;
    els.cancel.textContent = 'Stopping…';
    progress(parseFloat(els.bar.style.width) || 0, 'stopping…');
    log('Stopping — closing the open requests…', 'warn');
  }

  async function generate() {
    if (running) return;

    running = true;
    activeRun = { token: { cancelled: false } };
    var token = activeRun.token;

    els.generate.disabled = true;
    els.cancel.classList.remove('hidden');
    els.cancel.disabled = false;
    els.cancel.textContent = 'Stop';

    clearLog();
    progress(0, 'starting…');

    var startedAt = Date.now();

    try {
      readForm();
      Config.save(settings);

      if (!settings.apiKey) throw new Error('Add your Gemini API key first (step 1).');

      var ffmpeg = Audio.resolve(settings.ffmpegPath);
      if (!ffmpeg) {
        Audio.diagnose(settings.ffmpegPath).forEach(function (line) { log('  ' + line, 'dim'); });
        throw new Error(Audio.status().error);
      }
      log('ffmpeg: ' + ffmpeg, 'dim');

      progress(3, 'reading timeline…');
      await Premiere.ensureHost();
      if (token.cancelled) throw cancelledError();
      var info = await Premiere.getSequenceInfo(settings.scope);
      if (token.cancelled) throw cancelledError();
      if (!info.ok) throw new Error(info.error);

      (info.warnings || []).forEach(function (w) { log('! ' + w, 'warn'); });

      var seq = info.sequence;
      var rangeStart = seq.rangeStart;
      var rangeEnd = seq.rangeEnd;
      var duration = rangeEnd - rangeStart;

      log('Sequence "' + seq.name + '"  ·  ' + scopeLabel(seq), 'dim');
      log(fmtTime(rangeStart) + '–' + fmtTime(rangeEnd) + '  ·  ' + info.clips.length +
          ' audio clip(s)', 'dim');

      var plan = preparePlan(info, function (m) { log('! ' + m, 'warn'); });

      var chunkSec = settings.chunkSec;
      var chunkCount = Math.max(1, Math.ceil(duration / chunkSec));

      var collected = [];
      var tokens = 0;
      var failures = [];
      var completed = 0;
      var concurrency = Math.max(1, Math.min(6, Math.round(settings.concurrency || 3)));
      var workerCount = Math.min(concurrency, chunkCount);

      log('Sending ' + chunkCount + ' slice(s) of ~' + chunkSec + 's to ' + settings.model +
          ' · ' + workerCount + ' in parallel.', 'dim');

      if (/transcribe/i.test(settings.model)) {
        log('  ' + settings.model + ' returns a timestamp for every word, so pauses stay gaps.', 'dim');
        if (settings.language !== 'auto') {
          log('  It picks the language and script itself; Language is a hint only.', 'dim');
        }
      }

      async function processSlice(i) {
        if (token.cancelled) return;

        var t0 = rangeStart + i * chunkSec;
        var t1 = Math.min(rangeEnd, t0 + chunkSec);
        if (t1 - t0 < 0.4) return;

        var label = 'slice ' + (i + 1) + '/' + chunkCount;
        progress(5 + (completed / chunkCount) * 90, label + ' — extracting…');

        var pcm = Audio.renderChunk(plan, t0, t1, function (w) { log('! ' + w, 'warn'); });
        if (token.cancelled) return;
        if (Audio.peak(pcm) < 0.004) {
          log('· ' + fmtTime(t0) + '–' + fmtTime(t1) + '  silence, skipped', 'dim');
          return;
        }

        var wavFile = Audio.tempFile('slice_' + ('000' + i).slice(-4) + '.wav');
        Audio.writeWavFile(pcm, wavFile);
        progress(5 + (completed / chunkCount) * 90, label + ' — transcribing…');

        /* Measure where speech actually is before the model's phrase times are
           used. Captions and word edges get pinned to these spans, which is
           what removes the visible lag between mouth and subtitle. */
        var speech = settings.snapPauses
          ? Audio.speechSegments(pcm, { db: settings.silenceDb })
          : null;

        try {
          var res = await Gemini.transcribe({
            apiKey: settings.apiKey,
            model: settings.model,
            wavBuffer: NODE.fs.readFileSync(wavFile),
            duration: t1 - t0,
            language: settings.language,
            wordsPerLine: settings.wordsPerLine,
            maxLines: settings.maxLines,
            token: token,
            onRetry: function (attempt, msg) {
              log('… ' + label + ' retry ' + attempt + ': ' + msg, 'warn');
            },
            onNote: function (msg) {
              log('! ' + label + ' ' + msg, 'warn');
            }
          });

          if (token.cancelled) return;

          if (res.usage && res.usage.totalTokenCount) tokens += res.usage.totalTokenCount;

          var modelCues = res.cues;
          var transcript = (res.transcript || '').trim();
          var fromTranscript = false;

          /* Dedicated *-transcribe models normally return a timestamp for every
             word. If that request fails they fall back to plain text, which the
             waveform timing below still turns into cues. */
          if (!modelCues.length && transcript) {
            fromTranscript = true;
            modelCues = [{ start: 0, end: t1 - t0, text: transcript }];
          }

          if (!modelCues.length) {
            if ((res.raw || '').trim()) {
              log('! ' + fmtTime(t0) + '–' + fmtTime(t1) +
                  '  model replied without cue JSON: ' + res.raw.trim().slice(0, 120), 'warn');
            } else {
              log('· ' + fmtTime(t0) + '–' + fmtTime(t1) + '  no speech', 'dim');
            }
            return;
          }

          var local;
          var fromWords = false;
          if (res.words && res.words.length) {
            /* Transcribe models report when every word is spoken. Those times
               are exact, so captions are built straight from them — including
               the blank space while the speaker is silent. */
            fromWords = true;
            local = Srt.cuesFromWords(res.words, {
              wordsPerLine: settings.wordsPerLine,
              maxLines: settings.maxLines,
              duration: t1 - t0,
              holdMs: 80,
              splitGapMs: 280
            });
          } else if (speech) {
            local = Srt.alignCues(modelCues, speech, {
              wordsPerLine: settings.wordsPerLine,
              maxLines: settings.maxLines,
              duration: t1 - t0,
              holdMs: 120,
              splitGapMs: 420
            });
          } else if (fromTranscript) {
            local = Srt.alignCues(modelCues, [{ start: 0, end: t1 - t0 }], {
              wordsPerLine: settings.wordsPerLine,
              maxLines: settings.maxLines,
              duration: t1 - t0,
              holdMs: 120,
              splitGapMs: 420
            });
          } else {
            local = Srt.normalize(modelCues, {
              wordsPerLine: settings.wordsPerLine,
              maxLines: settings.maxLines,
              totalDuration: t1 - t0
            });
          }

          for (var k = 0; k < local.length; k++) {
            collected.push({
              start: t0 + local[k].start,
              end: t0 + local[k].end,
              text: local[k].text
            });
          }

          var first = (res.firstByteMs === null || res.firstByteMs === undefined)
            ? ''
            : ' · first byte ' + (res.firstByteMs / 1000).toFixed(1) + 's';
          log('· ' + fmtTime(t0) + '–' + fmtTime(t1) + '  ' + local.length + ' cue(s)' +
              (fromWords ? ' · word timings' : fromTranscript ? ' · text timed from waveform' : '') + '  (' +
              ((res.ms || 0) / 1000).toFixed(1) + 's' + first + ')', 'ok');
        } finally {
          Audio.cleanup(wavFile);
        }
      }

      var queue = [];
      for (var qi = 0; qi < chunkCount; qi++) queue.push(qi);

      // A model that answers with silence once will do it for every slice.
      // Stop the queue instead of waiting out a timeout per slice.
      var fatal = null;

      var workers = [];
      for (var wi = 0; wi < workerCount; wi++) {
        workers.push((async function () {
          while (queue.length) {
            if (fatal || token.cancelled) break;
            var idx = queue.shift();
            try {
              await processSlice(idx);
            } catch (e) {
              if (e && e.cancelled) { fatal = e; break; }
              var message = (e && e.message) ? e.message : String(e);
              failures.push(message);
              log('! ' + fmtTime(rangeStart + idx * chunkSec) + '  slice failed: ' + message, 'err');
              if (/no output|produced no output/i.test(message)) fatal = message;
              /* Every slice will hit the same cap; stop the queue instead of
                 failing the rest one by one. */
              if (/quota|rate limit|resource[ _]exhausted/i.test(message)) fatal = message;
            }
            completed++;
            progress(5 + (completed / chunkCount) * 90,
                     'completed ' + completed + '/' + chunkCount);
          }
        })());
      }

      await Promise.all(workers);

      if (token.cancelled) throw cancelledError();

      if (fatal && !collected.length) {
        throw new Error(String(fatal.message || fatal));
      }

      if (!collected.length) {
        if (failures.length) throw new Error('Every slice failed. First error: ' + failures[0]);
        throw new Error('No speech was transcribed. Check the audio tracks are audible and not muted.');
      }
      if (failures.length) {
        log('! ' + failures.length + ' slice(s) failed and were skipped.', 'warn');
      }

      if (token.cancelled) throw cancelledError();

      /* Dedicated transcribe models answer in Devanagari whatever the language
         setting says. When the user asked for Hinglish, rewrite those lines in
         Roman letters before they become captions. */
      if (settings.language === 'Hinglish' &&
          collected.some(function (c) { return Roman.hasDevanagari(c.text); })) {
        progress(94, 'converting to Roman Hinglish…');
        var roman = await Roman.convert(collected.map(function (c) { return c.text; }), {
          apiKey: settings.apiKey,
          model: Roman.pickModel(settings.model),
          token: token
        });
        for (var rc = 0; rc < collected.length; rc++) collected[rc].text = roman.lines[rc];
        if (roman.error) {
          log('! Roman conversion fell back to the built-in transliterator: ' + roman.error, 'warn');
        } else if (roman.model) {
          log('Rewrote ' + collected.length + ' cue(s) in Roman Hinglish via ' + roman.model + '.', 'dim');
        }
        if (token.cancelled) throw cancelledError();
      }

      progress(97, 'building subtitles…');
      var finalCues = Srt.finalize(collected, {
        wordsPerLine: settings.wordsPerLine,
        maxLines: settings.maxLines,
        totalDuration: rangeEnd
      });
      var srtText = Srt.build(finalCues);

      var fileName = Config.sanitizeName(seq.name) + '_' + Config.timestamp() + '.srt';
      var srtPath = NODE.path.join(Config.CAPTION_DIR, fileName);
      NODE.fs.writeFileSync(srtPath, srtText, 'utf8');

      if (token.cancelled) throw cancelledError();

      log('Wrote ' + finalCues.length + ' cues to ' + srtPath, 'ok');

      if (settings.autoImport && !token.cancelled) {
        progress(99, 'importing caption track…');
        var imp = await Premiere.importCaptions(srtPath);
        if (!imp.ok) {
          log('! Could not create the caption track: ' + imp.error, 'warn');
          log('  The SRT is still on disk — drag it into the project panel, or use File > Import.', 'dim');
        } else if (imp.created) {
          log('Caption track created on "' + imp.sequence + '"; SRT filed in "' + (imp.bin || '99 openCaption') + '".', 'ok');
        } else {
          log('! Premiere imported the file but did not report a caption track. Drag the SRT onto the sequence.', 'warn');
        }
      }

      var seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      progress(100, 'done — ' + finalCues.length + ' cues in ' + seconds + 's');
      log('');
      log('Done. ' + finalCues.length + ' cues' + (tokens ? ' · ' + tokens.toLocaleString() + ' tokens' : '') +
          ' · ' + seconds + 's', 'ok');

      els.lastSrtPath = srtPath;
    } catch (e) {
      if (e && e.cancelled) {
        progress(0, 'stopped');
        log('');
        log('Stopped by you. Partial captions were discarded — nothing was written or imported.', 'warn');
        els.lastSrtPath = '';
      } else {
        progress(0, 'failed');
        log('');
        var message = (e && e.message) ? e.message : String(e);
        log('Stopped: ' + message, 'err');
        if (/NOT_FOUND|no longer available|not found for API version|not supported/i.test(message)) {
          log('  Press "refresh" next to Model — the API will report which models this key can use.', 'warn');
        }
        if (/produced no output|no output for/i.test(message)) {
          log('  The key and network are fine; this model just never answers. Press "test", then pick a flash-lite model — they answer in ~2s.', 'warn');
        }
      }
    } finally {
      running = false;
      activeRun = null;
      els.generate.disabled = false;
      els.cancel.classList.add('hidden');
      els.cancel.disabled = false;
      els.cancel.textContent = 'Stop';
    }
  }

  /* ---------------------------------------------------------------- shell */

  function openFolder(dir) {
    try {
      NODE.child_process.spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
    } catch (e) {
      log('! Could not open folder: ' + e.message, 'warn');
    }
  }

  function browseFfmpeg() {
    var picked = cs.showOpenDialog('Locate ffmpeg.exe', 'C:\\', ['exe']);
    if (!picked) return;
    els.ffmpegPath.value = picked;
    persist();
    resolveAndReport();
  }

  function resolveAndReport() {
    var p = Audio.resolve(settings.ffmpegPath);
    if (p) {
      log('ffmpeg ready: ' + p, 'ok');
      return true;
    }
    log('! ' + Audio.status().error, 'warn');
    Audio.diagnose(settings.ffmpegPath).forEach(function (line) { log('  ' + line, 'dim'); });
    return false;
  }

  /* ----------------------------------------------------------------- boot */

  function bind() {
    document.querySelectorAll('#scope button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('#scope button').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        persist();
      });
    });

    els.model.addEventListener('change', function () {
      var custom = els.model.value === '__custom';
      els.customModelWrap.classList.toggle('hidden', !custom);
      persist();
    });

    ['language', 'wordsPerLine', 'maxLines', 'snapPauses', 'autoImport', 'chunkSec', 'silenceDb', 'concurrency']
      .forEach(function (id) { els[id].addEventListener('change', persist); });

    els.wordsPerLine.addEventListener('change', updateCaptionShape);
    els.maxLines.addEventListener('change', updateCaptionShape);

    els.ffmpegPath.addEventListener('change', function () { persist(); resolveAndReport(); });

    els.saveKey.addEventListener('click', saveKey);
    els.testKey.addEventListener('click', testKey);
    els.clearKey.addEventListener('click', function () {
      els.apiKey.value = '';
      settings.apiKey = '';
      persist();
      setKeyBadge(false);
      log('API key removed.', 'dim');
    });

    els.toggleKey.addEventListener('click', function () {
      var showing = els.apiKey.type === 'text';
      els.apiKey.type = showing ? 'password' : 'text';
      els.toggleKey.textContent = showing ? 'show' : 'hide';
    });

    els.browseFfmpeg.addEventListener('click', browseFfmpeg);
    els.refreshModels.addEventListener('click', function () { refreshModelList(false); });
    els.testModel.addEventListener('click', testSelectedModel);
    els.openDataFolder.addEventListener('click', function () { openFolder(Config.DATA_DIR); });
    els.openCaptionFolder.addEventListener('click', function () { openFolder(Config.CAPTION_DIR); });

    els.generate.addEventListener('click', generate);
    els.cancel.addEventListener('click', requestCancel);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && running) {
        e.preventDefault();
        requestCancel();
      }
    });

    document.querySelectorAll('[data-ext="link"]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        cs.openURLInDefaultBrowser(a.getAttribute('href'));
      });
    });

    els.apiKey.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveKey();
    });
  }

  function boot() {
    ['apiKey', 'toggleKey', 'saveKey', 'testKey', 'clearKey', 'keyBadge', 'model', 'customModel',
     'customModelWrap', 'language', 'scope', 'wordsPerLine', 'maxLines', 'captionShape',
     'snapPauses', 'autoImport',
     'generate', 'cancel', 'bar', 'progressLabel', 'log', 'ffmpegPath', 'browseFfmpeg', 'chunkSec',
     'concurrency', 'silenceDb', 'openDataFolder', 'openCaptionFolder', 'version', 'hostInfo',
     'refreshModels', 'testModel']
      .forEach(function (id) { els[id] = $(id); });

    els.version.textContent = 'openCaption v' + VERSION;

    if (!Config.ok) {
      els.generate.disabled = true;
      log('! ' + Config.error, 'err');
      return;
    }

    settings = Config.load();
    applyToForm();
    bind();

    log('Ready. Open a sequence, then press Generate.', 'dim');

    /* On a fresh install the two things that can stop a run are the key and
       the audio helper; say so now instead of failing on the first click. */
    if (!settings.apiKey) {
      log('No API key yet — paste one in "01 · API access" and press Save key.', 'warn');
    }
    if (!Audio.resolve(settings.ffmpegPath)) {
      log('! ffmpeg was not found. Reinstall, or pick an ffmpeg.exe under Advanced.', 'warn');
    }

    // Ask the API which models this key can actually use. Google retires model
    // names regularly, so the dropdown is never trusted as the source of truth.
    if (settings.apiKey) refreshModelList(true);

    Premiere.ensureHost().then(function (loaded) {
      if (!loaded) {
        log('! Could not auto-load host.jsx. If commands fail, restart Premiere once.', 'warn');
      }
      return Premiere.ping();
    }).then(function (res) {
      if (res && res.ok) {
        els.hostInfo.textContent = 'Premiere ' + res.version + (res.project ? ' · ' + res.project : '');
        if (!res.sequence) log('No active sequence yet — open one before generating.', 'dim');
      } else {
        els.hostInfo.textContent = 'not connected';
        log('! ' + (res && res.error ? res.error : 'Could not reach Premiere.'), 'err');
      }
    }).catch(function (e) {
      els.hostInfo.textContent = 'not connected';
      log('! ' + e.message, 'err');
    });

    resolveAndReport();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();

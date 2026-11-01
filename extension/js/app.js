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

  var VERSION = '1.5.3';

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

  function syncLogButtons() {
    if (!els.log) return;
    var empty = els.log.textContent.trim() === '';
    if (els.clearLogBtn) els.clearLogBtn.disabled = empty;
    if (els.copyLogBtn) els.copyLogBtn.disabled = empty;
  }

  var LOG_BADGES = { ok: 'DONE', warn: 'NOTE', err: 'ERROR', info: 'INFO' };

  /**
   * Append one log entry.
   *   log('message')                 plain update, marked with a dot
   *   log('message', 'ok')           finished step, green DONE badge
   *   log('message', 'warn')         heads-up, amber NOTE badge
   *   log('message', 'err')          problem, red ERROR badge
   *   log('technical line', 'dim')   secondary detail, no badge
   *   log('message', 'ok', detail)   secondary technical detail under the line
   */
  function log(msg, cls, detail) {
    if (msg === '' || msg === null || msg === undefined) {
      var gap = document.createElement('div');
      gap.className = 'log-gap';
      els.log.appendChild(gap);
      els.log.scrollTop = els.log.scrollHeight;
      return;
    }

    var kind = cls || 'info';
    if (kind !== 'dim' && !LOG_BADGES[kind]) kind = 'info';

    // Older call sites prefix messages with "!", "·" or "…". Drop the marker:
    // the badge now carries the meaning.
    var text = String(msg).replace(/^\s*[!·…]\s*/, '').trim();
    if (!text) return;

    var row = document.createElement('div');
    row.className = 'log-row l-' + kind;

    if (kind === 'info') {
      var dot = document.createElement('span');
      dot.className = 'log-dot';
      dot.setAttribute('aria-hidden', 'true');
      row.appendChild(dot);
    } else if (kind !== 'dim') {
      var badge = document.createElement('span');
      badge.className = 'log-badge';
      badge.textContent = LOG_BADGES[kind];
      row.appendChild(badge);
    }

    var body = document.createElement('div');
    body.className = 'log-text';
    body.appendChild(document.createTextNode(text));
    if (detail) {
      var sub = document.createElement('span');
      sub.className = 'log-detail';
      sub.textContent = String(detail);
      body.appendChild(sub);
    }
    row.appendChild(body);

    els.log.appendChild(row);
    els.log.scrollTop = els.log.scrollHeight;
    syncLogButtons();
  }

  /** A numbered phase heading, e.g. "02 Reading your timeline". */
  function logPhase(step, title, subtitle) {
    var row = document.createElement('div');
    row.className = 'log-phase';

    var num = document.createElement('span');
    num.className = 'log-step';
    num.textContent = ('0' + step).slice(-2);

    var body = document.createElement('div');
    body.className = 'log-phase-text';
    var heading = document.createElement('strong');
    heading.textContent = title;
    body.appendChild(heading);
    if (subtitle) {
      var sub = document.createElement('span');
      sub.textContent = subtitle;
      body.appendChild(sub);
    }

    row.appendChild(num);
    row.appendChild(body);
    els.log.appendChild(row);
    els.log.scrollTop = els.log.scrollHeight;
    syncLogButtons();
  }

  /** The run summary: a DONE line with a little more weight. */
  function logFinish(title, detail) {
    log(title, 'ok', detail);
    var last = els.log.lastElementChild;
    if (last) last.classList.add('log-finish');
  }

  function count(n, noun) {
    return n + ' ' + noun + (n === 1 ? '' : 's');
  }

  function clearLog() {
    els.log.innerHTML = '';
    syncLogButtons();
  }

  /** The log as plain text, one line per entry, with Windows line endings. */
  function logText() {
    var out = [];
    for (var i = 0; i < els.log.children.length; i++) {
      var el = els.log.children[i];

      if (el.classList.contains('log-gap')) {
        out.push('');
        continue;
      }

      if (el.classList.contains('log-phase')) {
        var step = el.querySelector('.log-step');
        var title = el.querySelector('strong');
        var sub = el.querySelector('.log-phase-text span');
        out.push('');
        out.push('[' + (step ? step.textContent : '--') + '] ' + (title ? title.textContent : ''));
        if (sub) out.push('     ' + sub.textContent);
        continue;
      }

      if (!el.classList.contains('log-row')) continue;
      var badge = el.querySelector('.log-badge');
      var textEl = el.querySelector('.log-text');
      if (!textEl) continue;

      var detail = textEl.querySelector('.log-detail');
      var main = textEl.cloneNode(true);
      var cloneDetail = main.querySelector('.log-detail');
      if (cloneDetail) main.removeChild(cloneDetail);

      var prefix = badge ? badge.textContent : '';
      while (prefix.length < 6) prefix += ' ';
      var line = prefix + main.textContent.trim();
      if (detail) line += '  (' + detail.textContent + ')';
      out.push(line);
    }
    return out.join('\r\n');
  }

  /**
   * Put text on the clipboard. execCommand runs synchronously inside the click
   * handler, which is the reliable path in CEP; navigator.clipboard is a
   * fallback for builds where execCommand is disabled.
   */
  function copyText(text) {
    var textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);

    var copied = false;
    try {
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      copied = document.execCommand('copy');
    } catch (e) {
      copied = false;
    }
    document.body.removeChild(textarea);

    if (copied) return Promise.resolve();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return Promise.reject(new Error('the clipboard is unavailable'));
  }

  var copyLabelTimer = 0;

  function flashCopy(label) {
    if (!els.copyLogBtn) return;
    els.copyLogBtn.textContent = label;
    els.copyLogBtn.disabled = true;
    if (copyLabelTimer) clearTimeout(copyLabelTimer);
    copyLabelTimer = setTimeout(function () {
      copyLabelTimer = 0;
      els.copyLogBtn.textContent = 'copy';
      syncLogButtons();
    }, 1400);
  }

  function copyLog() {
    var text = logText();
    if (!text) return;
    copyText(text).then(function () {
      flashCopy('copied');
      log('Activity log copied. You can paste it into a message.', 'dim');
    }).catch(function (err) {
      flashCopy('failed');
      log('The activity log could not be copied.', 'warn', (err && err.message) || 'clipboard unavailable');
    });
  }

  var progressCloseTimer = 0;

  function progress(pct, label) {
    var p = clamp(pct, 0, 100);
    els.bar.style.width = p + '%';
    els.progressTrack.classList.toggle('done', p >= 100);
    if (label !== undefined) els.progressLabel.textContent = label;
  }

  function resetProgress() {
    clearTimeout(progressCloseTimer);
    els.progressTrack.classList.remove('closed', 'done');
  }

  function closeProgress(delay) {
    clearTimeout(progressCloseTimer);
    progressCloseTimer = setTimeout(function () {
      els.progressTrack.classList.add('closed');
    }, delay);
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
    if (!res.ok) log('Settings could not be saved.', 'warn', res.error);
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
      if (!silent) log('This API key cannot use any Gemini models.', 'warn');
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
        log('The saved model is not available to this key.', 'warn',
            (previous ? previous + ' → ' : '') + 'now using ' + pick);
      }
    }

    persist();
  }

  async function testSelectedModel() {
    var key = els.apiKey.value.trim() || (settings && settings.apiKey) || '';
    if (!key) { log('Add your Gemini API key first.', 'warn'); return; }

    var model = (els.model.value === '__custom')
      ? els.customModel.value.trim()
      : els.model.value;
    if (!model) { log('Choose a model first.', 'warn'); return; }

    els.testModel.disabled = true;
    try {
      // Two probes: text proves the key and the model work, audio proves the
      // path that Generate actually uses. A model can pass one and hang on the
      // other, which is exactly the "no response" case this is meant to expose.
      log('Step 1 of 2: sending a few words to "' + model + '"…', 'info');
      var text = await Gemini.testModel(key, model);
      var tSecs = (text.ms / 1000).toFixed(1);

      if (!text.ok) {
        log('The model did not answer a text message.', 'err', 'gave up after ' + tSecs + 's · ' + text.error);
        return;
      }
      log('Step 1 passed — the model replied in ' + tSecs + 's.', 'ok',
          '"' + String(text.text || '').slice(0, 30) + '"');

      log('Step 2 of 2: sending 1.2 seconds of test audio…', 'info');
      var audio = await Gemini.testAudio(key, model);
      var aSecs = (audio.ms / 1000).toFixed(1);

      if (!audio.ok) {
        log('The model did not answer the audio test.', 'err', 'gave up after ' + aSecs + 's · ' + audio.error);
        log('Text worked but audio did not. Pick a flash-lite model — it answered this test in about 2s.', 'warn');
        return;
      }

      var fb = (audio.firstByteMs || 0) / 1000;
      log('The model handled audio in ' + aSecs + 's and found ' + count(audio.cues, 'caption line') + '.', 'ok',
          'first response after ' + fb.toFixed(1) + 's');
      log('This model looks healthy — Generate captions should work.', 'info');
    } catch (e) {
      log('The model test could not finish.', 'err', e.message);
    } finally {
      els.testModel.disabled = false;
    }
  }

  async function refreshModelList(silent) {
    var key = els.apiKey.value.trim() || (settings && settings.apiKey) || '';
    if (!key) {
      if (!silent) log('Add your Gemini API key first.', 'warn');
      return;
    }

    els.refreshModels.disabled = true;
    try {
      var res = await Gemini.validateKey(key);
      if (!res.ok) {
        if (!silent) log('The model list could not be loaded.', 'err', res.error);
        return;
      }
      populateModels(res.models, silent);
      if (!silent) {
        log('Model list refreshed.', 'ok', Gemini.audioModels(res.models).length + ' models available to this key');
      }
    } catch (e) {
      if (!silent) log('The model list could not be loaded.', 'err', e.message);
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
    if (!key) { log('API key removed from this computer.', 'dim'); return; }
    log('API key saved on this computer.', 'ok');
    await testKey();
  }

  async function testKey() {
    var key = els.apiKey.value.trim();
    if (!key) { log('Add your Gemini API key first.', 'warn'); return; }
    els.testKey.disabled = true;
    els.keyBadge.textContent = 'checking…';
    els.keyBadge.className = 'badge';
    try {
      var res = await Gemini.validateKey(key);
      if (res.ok) {
        els.keyBadge.textContent = 'valid';
        els.keyBadge.className = 'badge ok';
        log('Your API key works.', 'ok', Gemini.audioModels(res.models).length + ' models available');
        populateModels(res.models, true);
      } else {
        els.keyBadge.textContent = 'invalid';
        els.keyBadge.className = 'badge err';
        log('This API key was rejected.', 'err', res.error);
      }
    } catch (e) {
      els.keyBadge.textContent = 'error';
      els.keyBadge.className = 'badge err';
      log('The API key could not be checked.', 'err', e.message);
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
        warn('The clip "' + c.name + '" is missing from disk.', c.path);
        continue;
      }
      plan.push(c);
    }

    if (!plan.length) {
      throw new Error('None of the clips in this range could be read from disk (' + count(missing, 'missing file') + ').');
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
    log('Stopping…', 'warn', 'closing the open requests');
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
    resetProgress();
    progress(0, 'getting ready…');

    var startedAt = Date.now();

    try {
      readForm();
      Config.save(settings);

      logPhase(1, 'Checking your setup', 'API key, audio tools and Premiere');

      if (!settings.apiKey) {
        throw new Error('Your Gemini API key is missing. Paste it under "API access", then press Save key.');
      }

      var ffmpeg = Audio.resolve(settings.ffmpegPath);
      if (!ffmpeg) {
        Audio.diagnose(settings.ffmpegPath).forEach(function (line) { log(line, 'dim'); });
        throw new Error('The audio tool (ffmpeg) is missing. Run setup-ffmpeg.ps1 once, then press Generate again.');
      }
      log('Setup is complete.', 'ok', ffmpeg);

      progress(3, 'reading your timeline…');
      await Premiere.ensureHost();
      if (token.cancelled) throw cancelledError();
      var info = await Premiere.getSequenceInfo(settings.scope);
      if (token.cancelled) throw cancelledError();
      if (!info.ok) throw new Error(info.error);

      logPhase(2, 'Reading your timeline', 'Finding the clips and the audio to use');

      (info.warnings || []).forEach(function (w) { log(w, 'warn'); });

      var seq = info.sequence;
      var rangeStart = seq.rangeStart;
      var rangeEnd = seq.rangeEnd;
      var duration = rangeEnd - rangeStart;

      log('Working on sequence "' + seq.name + '"', 'info', scopeLabel(seq) + ' · ' + count(info.clips.length, 'audio clip'));
      log('Time range: ' + fmtTime(rangeStart) + ' to ' + fmtTime(rangeEnd), 'info');

      var plan = preparePlan(info, function (m, d) { log(m, 'warn', d); });

      var chunkSec = settings.chunkSec;
      var chunkCount = Math.max(1, Math.ceil(duration / chunkSec));

      var collected = [];
      var tokens = 0;
      var failures = [];
      var completed = 0;
      var concurrency = Math.max(1, Math.min(6, Math.round(settings.concurrency || 3)));
      var workerCount = Math.min(concurrency, chunkCount);

      logPhase(3, 'Transcribing with Gemini', count(chunkCount, 'part') + ' of about ' + chunkSec + ' seconds each');
      if (settings.language === 'auto') {
        log('Caption language: the spoken language, detected automatically.', 'info');
      } else if (settings.language === 'Hinglish') {
        log('Caption language: Hinglish, written in Roman letters.', 'info');
      } else {
        log('Caption language: ' + settings.language + ' — speech in other languages is translated.', 'info');
      }
      log('Model: ' + settings.model + ' · ' + count(workerCount, 'part') + ' at a time.', 'dim');

      if (/transcribe/i.test(settings.model)) {
        log('This model reports when every word is spoken, so pauses stay as gaps in the captions.', 'dim');
        if (settings.language !== 'auto') {
          log(settings.language === 'Hinglish'
            ? 'Its output is rewritten in Roman Hinglish afterwards.'
            : 'Its output is translated to ' + settings.language + ' afterwards.', 'dim');
        }
      }

      async function processSlice(i) {
        if (token.cancelled) return;

        var t0 = rangeStart + i * chunkSec;
        var t1 = Math.min(rangeEnd, t0 + chunkSec);
        if (t1 - t0 < 0.4) return;

        var label = 'part ' + (i + 1) + ' of ' + chunkCount;
        progress(5 + (completed / chunkCount) * 90, label + ' — getting the audio…');

        var pcm = Audio.renderChunk(plan, t0, t1, function (w) { log(w, 'warn'); });
        if (token.cancelled) return;
        if (Audio.peak(pcm) < 0.004) {
          log(label.charAt(0).toUpperCase() + label.slice(1) + ' has no speech — skipped.', 'dim',
            fmtTime(t0) + ' to ' + fmtTime(t1));
          return;
        }

        var wavFile = Audio.tempFile('slice_' + ('000' + i).slice(-4) + '.wav');
        Audio.writeWavFile(pcm, wavFile);
        progress(5 + (completed / chunkCount) * 90, label + ' — listening…');

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
              log('Part ' + (i + 1) + ' of ' + chunkCount + ' took longer than expected — retrying (attempt ' +
                attempt + ').', 'warn', msg);
            },
            onNote: function (msg) {
              log('Gemini sent a note while working on part ' + (i + 1) + ' of ' + chunkCount + '.', 'warn', msg);
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
              log('Part ' + (i + 1) + ' of ' + chunkCount +
                  ' came back in an unexpected format and was skipped.', 'warn',
                  'Model reply: ' + res.raw.trim().slice(0, 120));
            } else {
              log('Part ' + (i + 1) + ' of ' + chunkCount + ' has no speech — skipped.', 'dim',
                  fmtTime(t0) + ' to ' + fmtTime(t1));
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

          var detail = fmtTime(t0) + ' to ' + fmtTime(t1) + ' · ' +
            ((res.ms || 0) / 1000).toFixed(1) + 's';
          if (fromWords) detail += ' · word-level timing';
          else if (fromTranscript) detail += ' · timing matched to the audio';
          log('Part ' + (i + 1) + ' of ' + chunkCount + ' finished — ' + count(local.length, 'caption line') + '.', 'ok', detail);
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
              log('Part ' + (idx + 1) + ' of ' + chunkCount + ' could not be transcribed.', 'err',
                fmtTime(rangeStart + idx * chunkSec) + ' · ' + message);
              if (/no output|produced no output/i.test(message)) fatal = message;
              /* Every slice will hit the same cap; stop the queue instead of
                 failing the rest one by one. */
              if (/quota|rate limit|resource[ _]exhausted/i.test(message)) fatal = message;
            }
            completed++;
            progress(5 + (completed / chunkCount) * 90,
                     'finished ' + completed + ' of ' + chunkCount + ' parts');
          }
        })());
      }

      await Promise.all(workers);

      if (token.cancelled) throw cancelledError();

      if (fatal && !collected.length) {
        throw new Error(String(fatal.message || fatal));
      }

      if (!collected.length) {
        if (failures.length) throw new Error('None of the audio could be transcribed. First error: ' + failures[0]);
        throw new Error('No speech was found in the selected range. Check that the audio tracks are not muted, then try again.');
      }
      if (failures.length) {
        log('Some parts could not be transcribed and were skipped.', 'warn',
            count(failures.length, 'failed part'));
      }

      if (token.cancelled) throw cancelledError();

      logPhase(4, 'Building captions', 'Cleaning up the lines and their timing');

      /* Slices finish in parallel, so `collected` is in completion order rather
         than time order. Both rewrites below read neighbouring lines as context,
         so hand them a chronological copy and write results back to the same
         cue objects (timings are untouched). */
      var orderedCues = collected.slice().sort(function (a, b) {
        return a.start - b.start || a.end - b.end;
      });

      /* Dedicated transcribe models answer in Devanagari whatever the language
         setting says. When the user asked for Hinglish, rewrite those lines in
         Roman letters before they become captions. */
      if (settings.language === 'Hinglish' &&
          orderedCues.some(function (c) { return Roman.hasDevanagari(c.text); })) {
        progress(94, 'writing Hinglish in Roman letters…');
        var roman = await Roman.convert(orderedCues.map(function (c) { return c.text; }), {
          apiKey: settings.apiKey,
          model: Roman.pickModel(settings.model),
          token: token
        });
        for (var rc = 0; rc < orderedCues.length; rc++) orderedCues[rc].text = roman.lines[rc];
        if (roman.error) {
          log('Hinglish was converted with the built-in method instead.', 'warn', roman.error);
        } else if (roman.model) {
          log('Captions written in Roman Hinglish.', 'ok',
            count(orderedCues.length, 'line') + ' · ' + roman.model);
        }
        if (token.cancelled) throw cancelledError();
      }

      /* The selected language is the caption language, not a guess about the
         audio. Dedicated *-transcribe models always answer in the spoken
         language, and a general model can ignore the translate instruction
         when the scripts differ. Rewrite those cues before they are split into
         caption lines; their timings do not change. */
      if (settings.language !== 'auto' && settings.language !== 'Hinglish') {
        var captionTexts = orderedCues.map(function (c) { return c.text; });
        var canTranslate = typeof Translate !== 'undefined' && Translate.ok;
        var mustTranslate = /transcribe/i.test(settings.model) ||
          (canTranslate && Translate.needsFix(settings.language, captionTexts));

        if (mustTranslate && !canTranslate) {
          log('The captions could not be translated to ' + settings.language + '.', 'err',
            (typeof Translate !== 'undefined' && Translate.error) || 'translation is not available');
          log('They stay in the spoken language. Try again, or pick a general model.', 'dim');
        } else if (mustTranslate) {
          progress(95, 'translating to ' + settings.language + '…');
          log('Translating ' + count(captionTexts.length, 'caption line') + ' to ' + settings.language + '…', 'info');
          var translated = await Translate.convert(settings.language, captionTexts, {
            apiKey: settings.apiKey,
            model: Translate.pickModel(settings.model),
            token: token
          });
          if (token.cancelled) throw cancelledError();
          if (translated.error) {
            log('The captions could not be translated to ' + settings.language + '.', 'err', translated.error);
            log('They stay in the spoken language. Try again, or pick a general model.', 'dim');
          } else {
            for (var tc = 0; tc < orderedCues.length; tc++) orderedCues[tc].text = translated.lines[tc];
            log('Captions translated to ' + settings.language + '.', 'ok',
              count(orderedCues.length, 'line') + ' · ' + translated.model);
          }
        }
      }

      progress(97, 'building subtitles…');
      var finalCues = Srt.finalize(collected, {
        wordsPerLine: settings.wordsPerLine,
        maxLines: settings.maxLines,
        totalDuration: rangeEnd
      });
      var srtText = Srt.build(finalCues);
      log('Caption timing and line breaks are set.', 'ok', count(finalCues.length, 'caption line'));

      logPhase(5, 'Saving your captions', 'Writing the file and adding the caption track');

      var fileName = Config.sanitizeName(seq.name) + '_' + Config.timestamp() + '.srt';
      var srtPath = NODE.path.join(Config.CAPTION_DIR, fileName);
      NODE.fs.writeFileSync(srtPath, srtText, 'utf8');

      if (token.cancelled) throw cancelledError();

      log('Caption file saved.', 'ok', fileName);

      var imported = false;

      if (settings.autoImport && !token.cancelled) {
        progress(99, 'importing caption track…');
        var imp = await Premiere.importCaptions(srtPath);
        if (!imp.ok) {
          log('The caption track could not be added automatically.', 'warn', imp.error);
          log('The .srt file is saved. Drag it into the Project panel, or use File > Import.', 'dim');
        } else if (imp.created) {
          imported = true;
          if (imp.numbered) {
            log('Caption track added to "' + imp.sequence + '".', 'ok',
              'Filed in "' + (imp.bin || '99 openCaption') + '" as "' + imp.item + '"');
          } else {
            log('Caption track added to "' + imp.sequence + '".', 'ok',
              'SRT "' + imp.item + '" filed in "' + (imp.bin || '99 openCaption') + '"');
            log('This Premiere build did not accept the numbered item name; rename it in the Project panel if you want it numbered.', 'dim');
          }
        } else {
          log('Premiere imported the file but did not add a caption track.', 'warn', 'Drag the .srt onto the sequence.');
        }
      }

      var seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      progress(100, 'done — ' + count(finalCues.length, 'caption') + ' in ' + seconds + 's');
      log('');
      logFinish(count(finalCues.length, 'caption') + (finalCues.length === 1 ? ' is' : ' are') +
        ' ready in ' + seconds + 's.',
        tokens ? tokens.toLocaleString() + ' tokens used' : '');
      if (imported) {
        log('They are on your timeline as an editable caption track.', 'info');
      }

      els.lastSrtPath = srtPath;
    } catch (e) {
      if (e && e.cancelled) {
        progress(0, 'stopped');
        log('');
        log('Stopped at your request.', 'warn', 'Nothing was saved and no captions were added.');
        els.lastSrtPath = '';
      } else {
        progress(0, 'failed');
        log('');
        var message = (e && e.message) ? e.message : String(e);
        log('Captions were not created.', 'err', message);

        var advised = false;
        if (/NOT_FOUND|no longer available|not found for API version|not supported/i.test(message)) {
          log('Next step: press refresh next to Model, then choose one from the list.', 'info');
          advised = true;
        }
        if (/produced no output|no output for/i.test(message)) {
          log('Next step: press Test, then pick a flash-lite model — they answer in about 2 seconds.', 'info');
          advised = true;
        }
        if (/quota|rate limit|resource[ _]exhausted/i.test(message)) {
          log('Next step: the API quota is used up. Wait a while, or use another key.', 'info');
          advised = true;
        }
        if (/network|ENOTFOUND|ETIMEDOUT|ECONNRESET|offline|socket/i.test(message)) {
          log('Next step: check your internet connection, then try again.', 'info');
          advised = true;
        }
        if (!advised) {
          log('Next step: read the message above and try again. If it repeats, press Test next to Model.', 'info');
        }
      }
    } finally {
      running = false;
      activeRun = null;
      els.generate.disabled = false;
      els.cancel.classList.add('hidden');
      els.cancel.disabled = false;
      els.cancel.textContent = 'Stop';
      // Let the 100% state read for a moment, then close the strip.
      closeProgress(900);
    }
  }

  /* ---------------------------------------------------------------- shell */

  function openFolder(dir) {
    try {
      var platform = (NODE.process && NODE.process.platform) || 'win32';
      var command = platform === 'win32' ? 'explorer.exe'
                  : platform === 'darwin' ? 'open'
                  : 'xdg-open';
      NODE.child_process.spawn(command, [dir], { detached: true, stdio: 'ignore' }).unref();
    } catch (e) {
      log('The folder could not be opened.', 'warn', e.message);
    }
  }

  function browseFfmpeg() {
    // Start where ffmpeg is likely to be on this machine, never at a path
    // copied from another install or another user's profile.
    var start = '';
    try {
      start = settings.ffmpegPath ? NODE.path.dirname(settings.ffmpegPath) : '';
    } catch (e1) { start = ''; }
    if (!start) {
      try { start = NODE.os.homedir(); } catch (e2) { start = ''; }
    }
    var picked = cs.showOpenDialog('Locate ffmpeg.exe', start, ['exe']);
    if (!picked) return;
    els.ffmpegPath.value = picked;
    persist();
    resolveAndReport();
  }

  function resolveAndReport() {
    var p = Audio.resolve(settings.ffmpegPath);
    if (p) {
      log('Audio tools are ready.', 'ok', p);
      return true;
    }
    log('The audio tool (ffmpeg) was not found.', 'warn', Audio.status().error);
    Audio.diagnose(settings.ffmpegPath).forEach(function (line) { log(line, 'dim'); });
    return false;
  }

  /* -------------------------------------------------------- custom theme */

  var themeEditorOpen = false;

  function themeColorInputs() {
    return [
      { picker: els.customBg, hex: els.customBgHex },
      { picker: els.customPanel, hex: els.customPanelHex },
      { picker: els.customAccent, hex: els.customAccentHex },
      { picker: els.customText, hex: els.customTextHex }
    ];
  }

  function readThemeColors() {
    var pairs = themeColorInputs();
    var keys = ['bg', 'panel', 'accent', 'text'];
    var colors = {};
    for (var i = 0; i < pairs.length; i++) {
      var value = Theme.parseHex(pairs[i].hex.value);
      if (!value) return null;
      colors[keys[i]] = value;
    }
    return colors;
  }

  function updateThemePreview() {
    var colors = readThemeColors();
    if (!colors) return;
    var vars = Theme.derive(colors);
    els.tpBg.style.background = colors.bg;
    els.tpCard.style.background = colors.panel;
    els.tpCard.style.borderColor = vars['--line-strong'];
    els.tpText.style.color = colors.text;
    els.tpMuted.style.color = vars['--muted'];
    els.tpAccent.style.background = colors.accent;
    els.tpAccent.style.color = vars['--on-accent'];
  }

  function bindThemeEditor() {
    themeColorInputs().forEach(function (pair) {
      pair.picker.addEventListener('input', function () {
        pair.hex.value = pair.picker.value;
        updateThemePreview();
      });
      pair.hex.addEventListener('input', function () {
        var value = Theme.parseHex(pair.hex.value);
        if (!value) return;
        pair.picker.value = value;
        updateThemePreview();
      });
      pair.hex.addEventListener('blur', function () {
        var value = Theme.parseHex(pair.hex.value);
        pair.hex.value = value || pair.picker.value;
      });
    });
  }

  function openThemeEditor() {
    var saved = Theme.getCustom();
    var colors = saved;
    if (!colors) {
      // Start from the palette on screen so "custom" is a nudge, not a blank canvas.
      var style = getComputedStyle(document.documentElement);
      colors = {
        bg: Theme.parseHex(style.getPropertyValue('--bg')) || '#0b0b0b',
        panel: Theme.parseHex(style.getPropertyValue('--panel')) || '#161616',
        accent: Theme.parseHex(style.getPropertyValue('--accent')) || '#ffffff',
        text: Theme.parseHex(style.getPropertyValue('--text')) || '#f2f2f2'
      };
    }

    els.customThemeName.value = saved ? saved.name : '';
    var values = [colors.bg, colors.panel, colors.accent, colors.text];
    themeColorInputs().forEach(function (pair, i) {
      pair.picker.value = values[i];
      pair.hex.value = values[i];
    });
    els.customThemeDelete.disabled = !saved;

    updateThemePreview();
    els.themeEditor.classList.remove('hidden');
    els.customThemeBtn.classList.add('active');
    themeEditorOpen = true;
    els.themeEditor.scrollIntoView({ block: 'nearest' });
  }

  function closeThemeEditor() {
    els.themeEditor.classList.add('hidden');
    els.customThemeBtn.classList.remove('active');
    themeEditorOpen = false;
  }

  function saveCustomTheme() {
    var colors = readThemeColors();
    if (!colors) {
      log('One of the theme colours is not a valid hex value.', 'warn', 'use the format #rrggbb');
      return;
    }
    colors.name = els.customThemeName.value;
    var saved = Theme.setCustom(colors);
    Theme.apply('custom');
    settings.customTheme = saved;
    settings.theme = 'custom';
    persist();
    closeThemeEditor();
    log('Custom theme applied.', 'dim', saved.name);
  }

  function deleteCustomTheme() {
    if (!Theme.getCustom()) {
      log('No custom theme to delete.', 'dim');
      return;
    }
    if (!window.confirm('Delete the saved custom theme?')) return;
    var active = Theme.current();
    Theme.setCustom(null);
    // Only leave the palette if it was the one being deleted.
    Theme.apply(active === 'custom' ? 'mono' : active);
    settings.customTheme = null;
    settings.theme = Theme.current();
    persist();
    closeThemeEditor();
    log('Custom theme deleted.', 'dim');
  }

  /* --------------------------------------------------------------- updates */

  var pendingUpdate = null;
  var updateBusy = false;
  var updateDismissed = false;
  var updateLaunched = false;

  function updateSub(text) {
    if (els.updateSub) els.updateSub.textContent = text;
  }

  function showUpdate(res) {
    pendingUpdate = res;
    updateDismissed = false;

    var latest = res.latest || {};
    els.updateTitle.textContent = 'Update available — v' + (latest.version || '');
    updateSub(res.prepared
      ? 'v' + latest.version + ' is downloaded and verified. Close Premiere Pro to finish installing.'
      : 'You are on v' + res.current + '.');

    els.updateNotes.textContent = latest.notes || 'No release notes were included with this release.';
    els.updateNotes.classList.add('hidden');
    els.updateNotesToggle.textContent = "What's new";
    els.updateMeter.classList.add('hidden');
    els.updateFill.style.width = '0%';
    els.updatePct.textContent = '0%';
    els.updateNow.disabled = false;
    els.updateNotesToggle.disabled = false;
    els.updateNow.textContent = res.prepared ? 'Finish update' : 'Update now';

    if (res.canSelfUpdate && !res.canSelfUpdate.ok) {
      els.updateNow.textContent = 'Open download';
      updateSub('Automatic install is unavailable: ' + (res.canSelfUpdate.reason || 'unknown reason') +
        ' This button opens the release page.');
      log('Automatic install is not available here.', 'dim', res.canSelfUpdate.reason);
    }

    els.updateBar.classList.remove('hidden');
  }

  function launchPrepared(prep) {
    if (updateLaunched) return;

    var launched = Updater.installPrepared(prep);
    if (!launched.ok) {
      var reason = launched.error || 'The update helper could not be started.';
      els.updateNow.disabled = false;
      els.updateNow.textContent = 'Retry';
      els.updateMeter.classList.add('hidden');
      updateSub(reason);
      log('The update could not start.', 'err', reason);
      return;
    }

    updateLaunched = true;
    els.updateNow.disabled = true;
    els.updateNotesToggle.disabled = false;
    els.updateNow.textContent = 'Waiting';
    els.updateTitle.textContent = 'Update ready — v' + prep.version;
    updateSub('Close Premiere Pro to finish installing. It will reopen automatically. Your API key and settings are kept.');
    log('Update v' + prep.version + ' is downloaded and verified.', 'ok', 'close Premiere Pro to install it');
  }

  function onUpdateNow() {
    if (!pendingUpdate || updateBusy || updateLaunched) return;
    var res = pendingUpdate;

    if (!res.canSelfUpdate || !res.canSelfUpdate.ok) {
      var url = Updater.openReleasePage(res.latest);
      var opened = cs.openURLInDefaultBrowser(url);
      if (opened) {
        log('Opened the release page in your browser.', 'dim', url);
      } else {
        updateSub('Could not open a browser. Download it from ' + url);
        log('A browser could not be opened.', 'warn', 'download from ' + url);
      }
      return;
    }

    if (res.prepared) {
      launchPrepared(res.prepared);
      return;
    }

    updateBusy = true;
    els.updateNow.disabled = true;
    els.updateNotesToggle.disabled = true;
    els.updateNow.textContent = 'Updating';
    els.updateMeter.classList.remove('hidden');
    els.updateNotes.classList.add('hidden');
    els.updateFill.style.width = '0%';
    els.updatePct.textContent = '0%';

    Updater.prepare(res.latest, function (pct, label) {
      els.updateFill.style.width = pct + '%';
      els.updatePct.textContent = pct + '%';
      if (label) updateSub(label + ' — v' + res.latest.version);
    }).then(function (prep) {
      updateBusy = false;
      res.prepared = prep;
      els.updateMeter.classList.add('hidden');
      els.updateNotesToggle.disabled = false;
      launchPrepared(prep);
    }).catch(function (err) {
      updateBusy = false;
      var message = (err && err.message) ? err.message : 'Unknown error.';
      els.updateNow.disabled = false;
      els.updateNow.textContent = 'Retry';
      els.updateNotesToggle.disabled = false;
      els.updateMeter.classList.add('hidden');
      updateSub(message);
      log('The update failed.', 'err', message);
      log('You can install it by hand from the release page.', 'dim', Updater.openReleasePage(res.latest));
    });
  }

  function manualUpdateCheck() {
    if (updateBusy || updateLaunched) return;
    if (typeof Updater === 'undefined' || !Updater.ok) {
      log('Updates are unavailable.', 'warn',
          (typeof Updater !== 'undefined' && Updater.error) || 'the updater did not load');
      return;
    }

    log('Checking GitHub for a newer version…', 'info');
    Updater.check(VERSION, true).then(function (res) {
      if (!res || !res.ok) {
        log('GitHub could not be checked for updates.', 'warn', (res && res.error) || 'unknown error');
        return;
      }
      if (res.updateAvailable) {
        showUpdate(res);
        log('A newer version is available: v' + res.latest.version + '.', 'ok', 'use the update banner to install it');
      } else if (res.stale) {
        els.updateBar.classList.add('hidden');
        pendingUpdate = null;
        log('GitHub could not be reached.', 'warn',
            'last known release: v' + ((res.latest && res.latest.version) || 'unknown'));
      } else {
        els.updateBar.classList.add('hidden');
        pendingUpdate = null;
        log('openCaption v' + VERSION + ' is up to date.', 'ok');
      }
    }).catch(function (e) {
      log('GitHub could not be checked for updates.', 'warn', e.message);
    });
  }

  function initUpdater() {
    if (typeof Updater === 'undefined' || !Updater.ok) {
      if (typeof Updater !== 'undefined' && Updater.error) log('Updates are unavailable.', 'warn', Updater.error);
      return;
    }

    // The helper writes its result next to the settings; report it once.
    var result = Updater.readResult();
    if (result) {
      if (result.status === 'ok') {
        log('Updated to openCaption v' + result.version + '.', 'ok');
      } else if (result.status === 'error') {
        log('The last update did not install.', 'err', result.message);
      } else if (result.status === 'timeout') {
        log('The last update was not installed because Premiere stayed open.', 'warn');
      }
    }

    // Startup checks are silent: an offline machine should not see errors.
    var cap = Updater.capability();
    if (cap && cap.ok) {
      if (cap.fallback) log('This copy of the panel is read-only; updates go to a writable folder.', 'dim', cap.root);
      else if (cap.link) log('The panel is installed through a shortcut; updates follow it.', 'dim', cap.root);
    } else if (cap && cap.reason) {
      log('Automatic install is not available here.', 'dim', cap.reason);
    }

    Updater.check(VERSION).then(function (res) {
      if (!res || !res.ok || !res.updateAvailable) return;
      if (updateDismissed || updateLaunched) return;
      showUpdate(res);
      log('A newer version is available: v' + res.latest.version + '.', 'ok', 'use the update banner to install it');
    }).catch(function () { /* silent at startup */ });
  }

  /* ----------------------------------------------------------------- boot */

  function bind() {
    function toggleApiCard() {
      var collapsed = els.apiCard.classList.toggle('collapsed');
      els.apiHead.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      els.apiHead.title = collapsed ? 'Expand API access' : 'Collapse API access';
    }

    els.apiHead.addEventListener('click', toggleApiCard);
    els.apiHead.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleApiCard();
      }
    });

    els.customThemeBtn.addEventListener('click', function () {
      if (themeEditorOpen) closeThemeEditor();
      else openThemeEditor();
    });
    els.themeEditorClose.addEventListener('click', closeThemeEditor);
    els.customThemeCancel.addEventListener('click', closeThemeEditor);
    els.customThemeSave.addEventListener('click', saveCustomTheme);
    els.customThemeDelete.addEventListener('click', deleteCustomTheme);
    bindThemeEditor();

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
    els.copyLogBtn.addEventListener('click', copyLog);
    els.clearLogBtn.addEventListener('click', clearLog);

    els.updateNow.addEventListener('click', onUpdateNow);
    els.updateLater.addEventListener('click', function () {
      updateDismissed = true;
      els.updateBar.classList.add('hidden');
    });
    els.updateNotesToggle.addEventListener('click', function () {
      var hidden = els.updateNotes.classList.toggle('hidden');
      els.updateNotesToggle.textContent = hidden ? "What's new" : 'Hide notes';
    });
    els.checkUpdates.addEventListener('click', manualUpdateCheck);

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (running) {
        e.preventDefault();
        requestCancel();
        return;
      }
      if (themeEditorOpen) {
        e.preventDefault();
        closeThemeEditor();
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
    ['apiCard', 'apiHead', 'apiKey', 'toggleKey', 'saveKey', 'testKey', 'clearKey', 'keyBadge', 'model', 'customModel',
     'customModelWrap', 'language', 'scope', 'wordsPerLine', 'maxLines', 'captionShape',
     'snapPauses', 'autoImport',
     'generate', 'cancel', 'bar', 'progressTrack', 'progressLabel', 'log', 'copyLogBtn', 'clearLogBtn', 'ffmpegPath', 'browseFfmpeg', 'chunkSec',
     'concurrency', 'silenceDb', 'openDataFolder', 'openCaptionFolder', 'version', 'hostInfo',
     'refreshModels', 'testModel', 'themes', 'themeName',
     'customThemeBtn', 'themeEditor', 'themeEditorClose', 'customThemeName',
     'customBg', 'customBgHex', 'customPanel', 'customPanelHex',
     'customAccent', 'customAccentHex', 'customText', 'customTextHex',
     'customThemeSave', 'customThemeDelete', 'customThemeCancel',
     'tpBg', 'tpCard', 'tpText', 'tpMuted', 'tpAccent',
     'updateBar', 'updateTitle', 'updateSub', 'updateNow', 'updateNotesToggle',
     'updateLater', 'updateMeter', 'updateFill', 'updatePct', 'updateNotes', 'checkUpdates']
      .forEach(function (id) { els[id] = $(id); });

    els.version.textContent = 'openCaption v' + VERSION;

    if (!Config.ok) {
      els.generate.disabled = true;
      log('openCaption could not load its settings folder.', 'err', Config.error);
      return;
    }

    settings = Config.load();
    // config.json is the source of truth; localStorage is only the pre-paint hint.
    Theme.setCustom(settings.customTheme || null);
    settings.theme = Theme.apply(settings.theme);
    applyToForm();
    Theme.mount(els.themes, function (id) {
      settings.theme = id;
      persist();
    });
    bind();

    log('openCaption is ready.', 'dim', 'open a sequence, then press Generate captions');

    /* On a fresh install the two things that can stop a run are the key and
       the audio helper; say so now instead of failing on the first click. */
    if (!settings.apiKey) {
      log('No API key yet.', 'warn', 'paste one in "01 · API access" and press Save key');
    }
    if (!Audio.resolve(settings.ffmpegPath)) {
      log('The audio tool (ffmpeg) was not found.', 'warn', 'reinstall openCaption, or choose ffmpeg.exe under Advanced');
    }

    initUpdater();

    // Ask the API which models this key can actually use. Google retires model
    // names regularly, so the dropdown is never trusted as the source of truth.
    if (settings.apiKey) refreshModelList(true);

    Premiere.ensureHost().then(function (loaded) {
      if (!loaded) {
        log('Premiere did not finish connecting.', 'warn', 'if commands fail, restart Premiere once');
      }
      return Premiere.ping();
    }).then(function (res) {
      if (res && res.ok) {
        els.hostInfo.textContent = 'Premiere ' + res.version + (res.project ? ' · ' + res.project : '');
        els.hostInfo.title = els.hostInfo.textContent;
        if (!res.sequence) log('No active sequence yet — open one before generating.', 'dim');
      } else {
        els.hostInfo.textContent = 'not connected';
        log('Premiere could not be reached.', 'err', (res && res.error) || 'no response');
      }
    }).catch(function (e) {
      els.hostInfo.textContent = 'not connected';
      log('Premiere could not be reached.', 'err', e.message);
    });

    resolveAndReport();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();

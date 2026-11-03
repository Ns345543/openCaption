/*
 * silenceDetector.js — measures real sequence audio with the bundled FFmpeg.
 *
 * The sequence mix is rebuilt from the source media exactly the way caption
 * generation already does it (Audio.renderChunk), then a 10 ms RMS envelope
 * (Audio.speechSegments) marks where sound is present. Silent ranges are the
 * gaps between those speech spans, with padding kept on both sides.
 *
 * Nothing here trusts AI-supplied intervals: the model supplies thresholds,
 * and this file measures the audio itself.
 */
var SilenceDetector = (function () {
  'use strict';

  var CHUNK_SECONDS = 120;
  var MIN_CHUNK = 0.25;

  function finite(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function normalize(raw) {
    raw = raw || {};
    return {
      thresholdDb: finite(raw.thresholdDb) ? clamp(raw.thresholdDb, -80, -5) : -35,
      minSilenceSeconds: finite(raw.minSilenceSeconds) ? clamp(raw.minSilenceSeconds, 0.1, 60) : 0.5,
      paddingSeconds: finite(raw.paddingSeconds) ? clamp(raw.paddingSeconds, 0, 2) : 0.08,
      minSpeechSeconds: finite(raw.minSpeechSeconds) ? clamp(raw.minSpeechSeconds, 0, 2) : 0.15,
      includeLeading: raw.includeLeading !== false,
      includeTrailing: raw.includeTrailing !== false,
      ripple: raw.ripple !== false,
      scope: raw.scope === 'audio' ? 'audio' : 'sequence',
      audioTrackIndex: finite(raw.audioTrackIndex) ? Math.max(0, Math.round(raw.audioTrackIndex)) : 0
    };
  }

  function delay() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  function cancelledError() {
    var e = new Error('Cancelled by user.');
    e.cancelled = true;
    return e;
  }

  /* A click or breath shorter than minSpeechSeconds must not split one long
     silence into two. Drop those blips and close gaps between speech spans
     that are shorter than the same threshold, so the inversion below sees the
     speech the listener actually hears. */
  function speechSpans(spans, minSpeechSeconds) {
    spans.sort(function (a, b) { return a.start - b.start; });
    var kept = [];
    var min = Math.max(0.001, Number(minSpeechSeconds) || 0);
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      if (s.end - s.start < min) continue;
      kept.push({ start: s.start, end: s.end });
    }

    var out = [];
    for (var k = 0; k < kept.length; k++) {
      var span = kept[k];
      if (!out.length || span.start > out[out.length - 1].end + min) {
        out.push({ start: span.start, end: span.end });
      } else if (span.end > out[out.length - 1].end) {
        out[out.length - 1].end = span.end;
      }
    }
    return out;
  }

  function invert(speech, from, to) {
    var raw = [];
    var cursor = from;
    for (var i = 0; i < speech.length; i++) {
      var s = Math.max(from, speech[i].start);
      var e = Math.min(to, speech[i].end);
      if (e <= s) continue;
      if (s > cursor) raw.push({ start: cursor, end: s });
      if (e > cursor) cursor = e;
    }
    if (cursor < to) raw.push({ start: cursor, end: to });
    return raw;
  }

  function analyze(plan, from, to, params, token, onProgress, warnings) {
    var speech = [];
    var total = to - from;
    var index = 0;

    function step() {
      if (token && token.cancelled) return Promise.reject(cancelledError());
      var a = from + index * CHUNK_SECONDS;
      if (a >= to - MIN_CHUNK) return Promise.resolve(speechSpans(speech, params.minSpeechSeconds));
      var b = Math.min(to, a + CHUNK_SECONDS);

      var pcm = Audio.renderChunk(plan, a, b, function (message) {
        if (warnings.indexOf(message) === -1) warnings.push(message);
      });
      var spans = Audio.speechSegments(pcm, { db: params.thresholdDb });
      for (var i = 0; i < spans.length; i++) {
        speech.push({ start: a + spans[i].start, end: a + spans[i].end });
      }

      index++;
      if (onProgress) {
        onProgress(Math.min(1, (b - from) / Math.max(0.001, total)), b - from, total);
      }
      return delay().then(step);
    }

    return step();
  }

  function detect(params, options) {
    options = options || {};
    var p = normalize(params);
    var token = options.token || { cancelled: false };

    if (typeof NODE === 'undefined' || !NODE.ok) {
      return Promise.reject(new Error('This panel build has no Node/FFmpeg bridge.'));
    }
    if (typeof Audio === 'undefined' || !Audio.ok) {
      return Promise.reject(new Error('The FFmpeg audio module did not load.'));
    }
    var ffmpeg = Audio.resolve('');
    if (!ffmpeg) {
      return Promise.reject(new Error(Audio.status().error || 'ffmpeg.exe could not be found.'));
    }

    return Premiere.ensureHost().then(function (hostOk) {
      if (!hostOk) throw new Error('The Premiere bridge did not load. Restart Premiere Pro, then reopen the panel.');
      return Premiere.action('getContext', { includeClips: false, includeEffects: false });
    }).then(function (contextResult) {
      if (!contextResult || !contextResult.ok) {
        throw new Error((contextResult && contextResult.error) || 'Premiere did not return the active sequence.');
      }
      var zero = contextResult.context && contextResult.context.sequence
        ? Number(contextResult.context.sequence.zeroPoint) || 0
        : 0;
      if (Math.abs(zero) > 0.001) {
        throw new Error('This sequence starts at ' + zero.toFixed(3) +
          's, not 00:00:00:00. Silence removal currently supports zero-based sequences only, ' +
          'so it cannot cut the wrong place. Move the sequence to 00:00:00:00 and try again.');
      }
      return Premiere.getSequenceInfo('sequence');
    }).then(function (info) {
      if (!info || !info.ok) {
        throw new Error((info && info.error) || 'The sequence audio could not be read.');
      }

      var seq = info.sequence;
      var from = Number(seq.rangeStart);
      var to = Number(seq.rangeEnd);
      if (!isFinite(from) || !isFinite(to) || to <= from + 0.1) {
        throw new Error('The sequence range is empty.');
      }

      var warnings = (info.warnings || []).slice();
      var plan = [];
      for (var i = 0; i < info.clips.length; i++) {
        var clip = info.clips[i];
        try {
          if (!NODE.fs.existsSync(clip.path)) {
            var message = 'Missing media for "' + clip.name + '": ' + clip.path;
            if (warnings.indexOf(message) === -1) warnings.push(message);
            continue;
          }
        } catch (e) {
          continue;
        }
        plan.push(clip);
      }
      if (!plan.length) {
        throw new Error('No readable audio clips were found in the active sequence.');
      }

      return analyze(plan, from, to, p, token, options.onProgress, warnings).then(function (speech) {
        if (token.cancelled) throw cancelledError();

        var fps = Number(seq.fps) > 0 ? Number(seq.fps) : 25;
        var raw = invert(speech, from, to);
        var silences = [];
        var removedTotal = 0;

        for (var s = 0; s < raw.length; s++) {
          var range = raw[s];
          if (!p.includeLeading && range.start <= from + 0.001) continue;
          if (!p.includeTrailing && range.end >= to - 0.001) continue;

          var paddedStart = Math.min(range.end, range.start + p.paddingSeconds);
          var paddedEnd = Math.max(paddedStart, range.end - p.paddingSeconds);
          if (paddedEnd - paddedStart <= p.minSilenceSeconds) continue;

          /* Snap outward to frame boundaries so the razor lands on frames.
             Padding still keeps at least paddingSeconds of room on each side. */
          var snappedStart = Math.max(0, Math.floor(paddedStart * fps) / fps);
          var snappedEnd = Math.ceil(paddedEnd * fps) / fps;
          if (snappedEnd - snappedStart <= p.minSilenceSeconds) continue;

          silences.push({
            start: snappedStart,
            end: snappedEnd,
            duration: snappedEnd - snappedStart
          });
          removedTotal += snappedEnd - snappedStart;
        }

        if (!speech.length) {
          warnings.push('No speech was detected above ' + p.thresholdDb + ' dB. ' +
            'The whole analyzed range may be silent.');
        }
        if (removedTotal > (to - from) * 0.8) {
          warnings.push('The silent ranges cover more than 80% of the sequence. Review them carefully before executing.');
        }

        return {
          enabled: true,
          ffmpeg: ffmpeg,
          sequence: {
            name: String(seq.name || ''),
            fps: fps,
            rangeStart: from,
            rangeEnd: to,
            duration: to - from
          },
          params: p,
          speechCount: speech.length,
          silenceCount: silences.length,
          totalSilenceSeconds: removedTotal,
          silences: silences,
          warnings: warnings
        };
      });
    });
  }

  function remove(params, options) {
    options = options || {};
    var p = normalize(params);
    return detect(p, options).then(function (detection) {
      if (!detection.silences.length) {
        return {
          ok: true,
          nothingToDo: true,
          detection: detection,
          removal: null
        };
      }

      var intervals = detection.silences.map(function (range) {
        return { start: range.start, end: range.end };
      });

      return Premiere.action('removeRanges', {
        intervals: intervals,
        scope: p.scope,
        audioTrackIndex: p.audioTrackIndex,
        ripple: p.ripple
      }).then(function (reply) {
        if (!reply) {
          return {
            ok: false,
            nothingToDo: false,
            detection: detection,
            removal: null,
            error: 'Premiere returned no result for the removal.'
          };
        }
        return {
          ok: !!reply.ok,
          nothingToDo: false,
          detection: detection,
          removal: reply.result || null,
          error: reply.ok ? '' : String(reply.error || 'Premiere did not remove every silent range.')
        };
      });
    });
  }

  return {
    detect: detect,
    remove: remove,
    normalize: normalize,
    _speechSpans: speechSpans,
    _invert: invert
  };
})();

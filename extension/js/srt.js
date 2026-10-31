/*
 * srt.js — cue clean-up, line wrapping, pause snapping and SRT serialisation.
 *
 * Gemini's timings are approximate. Everything here exists to turn loose model
 * output into subtitles that actually sit still on screen: monotonic times, no
 * overlaps, minimum duration, readable line breaks, and optional snapping of cue
 * edges onto real pauses detected in the audio.
 */
var Srt = (function () {

  var MIN_DUR = 0.70;   // target reading time, used only when there is room
  var MIN_GAP = 0.04;
  var MAX_DUR = 8.0;
  var SQUEEZE_DUR = 0.30; // what a cue may shrink to before the next one moves

  /* Words that end a clause or a sentence: the places a caption may break. */
  var PAUSE_END = /[,.;:!?…]["')\]]?$/;

  function toMs(seconds) {
    return Math.max(0, Math.round(seconds * 1000));
  }

  function formatTime(seconds) {
    var ms = toMs(seconds);
    var h = Math.floor(ms / 3600000);
    ms -= h * 3600000;
    var m = Math.floor(ms / 60000);
    ms -= m * 60000;
    var s = Math.floor(ms / 1000);
    ms -= s * 1000;
    function pad(n, len) {
      var str = String(n);
      while (str.length < len) str = '0' + str;
      return str;
    }
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + ',' + pad(ms, 3);
  }

  function cleanText(text) {
    return String(text || '')
      .replace(/\r/g, ' ')
      .replace(/\n+/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/^\s*-\s*\[\s*\]\s*/, '')   // strip stray "[ ]" markers
      .trim();
  }

  function isPauseWord(word) {
    return PAUSE_END.test(String(word || ''));
  }

  /** Splits `n` words into `k` parts, as even as possible, so a caption does
   *  not end with a lonely word. The caller guarantees k ≤ n. */
  function evenSizes(n, k) {
    var sizes = [];
    if (k < 1) return [n];
    var base = Math.floor(n / k);
    var extra = n % k;
    for (var i = 0; i < k; i++) sizes.push(base + (i < extra ? 1 : 0));
    return sizes;
  }

  /**
   * Moves each break by up to one word so it lands just after a comma or a full
   * stop. "phir hum review karenge" split at three words would break before the
   * verb; one step earlier lands on a natural phrase end instead. If the nudge
   * would exceed the words-per-line budget, the even split is kept.
   */
  function snapSizes(words, sizes, max) {
    if (sizes.length < 2) return sizes;

    var ends = [];
    var acc = 0;
    for (var i = 0; i < sizes.length; i++) { acc += sizes[i]; ends.push(acc); }

    for (var e = 0; e < ends.length - 1; e++) {
      var from = (e === 0 ? 0 : ends[e - 1]) + 1;
      var to = ends[e + 1] - 1;
      var best = -1;
      var bestDist = 99;
      for (var cand = from; cand <= to; cand++) {
        if (!isPauseWord(words[cand - 1])) continue;
        var d = Math.abs(cand - ends[e]);
        if (d <= 1 && d < bestDist) { bestDist = d; best = cand; }
      }
      if (best > 0) ends[e] = best;
    }

    var out = [];
    var prev = 0;
    for (var b = 0; b < ends.length; b++) {
      out.push(ends[b] - prev);
      prev = ends[b];
    }
    for (var z = 0; z < out.length; z++) {
      if (out[z] < 1 || out[z] > max) return sizes; // nudge broke the budget
    }
    return out;
  }

  /**
   * Lays one caption's words out over at most `maxLines` balanced lines of at
   * most `wordsPerLine` words each.
   */
  function wrapLines(text, wordsPerLine, maxLines) {
    var words = cleanText(text).split(' ').filter(Boolean);
    if (!words.length) return [];

    var per = Math.max(1, Math.min(12, Number(wordsPerLine) || 2));
    var lines = Math.max(1, Math.min(4, Number(maxLines) || 1));
    var count = Math.min(lines, Math.ceil(words.length / per));
    var sizes = evenSizes(words.length, count);

    // Text that cannot fit in the budget keeps all its words: longer lines beat
    // dropping dialogue, so the even split is kept instead of snapping.
    if (words.length <= per * count) sizes = snapSizes(words, sizes, per);

    var out = [];
    var at = 0;
    for (var i = 0; i < sizes.length; i++) {
      out.push(words.slice(at, at + sizes[i]).join(' '));
      at += sizes[i];
    }
    return out;
  }

  /**
   * Splits cues that carry more words than one caption can hold
   * (wordsPerLine × maxLines). Chunks are balanced and break on punctuation
   * where possible, so a sentence is not chopped mid-phrase.
   */
  function splitLongCues(cues, wordsPerLine, maxLines) {
    var per = Math.max(1, Number(wordsPerLine) || 2);
    var lines = Math.max(1, Number(maxLines) || 1);
    var limit = per * lines;
    var result = [];

    for (var i = 0; i < cues.length; i++) {
      var cue = cues[i];
      var words = cue.text.split(' ').filter(Boolean);
      if (words.length <= limit) { result.push(cue); continue; }

      var groups = Math.ceil(words.length / limit);
      var sizes = snapSizes(words, evenSizes(words.length, groups), limit);

      var span = Math.max(0.3, cue.end - cue.start);
      var totalWords = words.length;
      var at = 0;
      var spoken = 0;

      for (var g = 0; g < sizes.length; g++) {
        var start = cue.start + (spoken / totalWords) * span;
        spoken += sizes[g];
        var end = (g === sizes.length - 1)
          ? cue.end
          : cue.start + (spoken / totalWords) * span;

        result.push({
          start: start,
          end: Math.max(end, start + 0.05),
          text: words.slice(at, at + sizes[g]).join(' ')
        });
        at += sizes[g];
      }
    }
    return result;
  }

  /** Clamps, sorts, removes overlaps and enforces minimum durations. */
  function tidy(cues, totalDuration) {
    var list = cues
      .map(function (c) {
        return {
          start: Math.max(0, Number(c.start) || 0),
          end: Number(c.end) || 0,
          text: cleanText(c.text)
        };
      })
      .filter(function (c) { return c.text && c.text.length > 0; })
      .sort(function (a, b) { return a.start - b.start || a.end - b.end; });

    if (typeof totalDuration === 'number' && totalDuration > 0) {
      list.forEach(function (c) {
        c.start = Math.min(c.start, totalDuration);
        c.end = Math.min(c.end, totalDuration);
      });
    }

    list.forEach(function (c) {
      if (c.end <= c.start) c.end = c.start + MIN_DUR;
      if (c.end - c.start > MAX_DUR) c.end = c.start + MAX_DUR;
    });

    /* Two captions on screen at once look broken in Premiere. Prefer
       shortening the earlier cue; if that would leave it unreadable, push the
       later one along instead. Extending the earlier cue to MIN_DUR without
       this check is what used to create overlaps on long, fast sentences. */
    for (var i = 1; i < list.length; i++) {
      var a = list[i - 1];
      var b = list[i];
      var latest = b.start - MIN_GAP;
      if (a.end <= latest) continue;

      if (latest - a.start >= SQUEEZE_DUR) {
        a.end = latest;
      } else {
        var shift = (a.start + SQUEEZE_DUR) - latest;
        b.start += shift;
        b.end += shift;
        a.end = b.start - MIN_GAP;
      }
    }

    /* Give a short cue a little more screen time, but never at the cost of the
       next cue's start. */
    for (var j = 0; j < list.length; j++) {
      var c = list[j];
      if (c.end - c.start >= MIN_DUR) continue;

      var room;
      if (j + 1 < list.length) {
        room = list[j + 1].start - MIN_GAP;
      } else if (typeof totalDuration === 'number' && totalDuration > c.start) {
        room = totalDuration;
      } else {
        room = c.start + MIN_DUR;
      }

      if (room > c.start) c.end = Math.max(c.end, Math.min(c.start + MIN_DUR, room));
      if (c.end <= c.start) c.end = c.start + 0.05;
    }

    return list;
  }

  /* ------------------------------------------------- speech-anchored timing */

  var HOLD_SEC = 0.12;     // keep a caption on screen a beat after its last word
  var SPLIT_GAP_SEC = 0.42; // a pause this long always ends a caption
  var LEAD_SEC = 0.35;     // how far before its cue a phrase may really start
  var TAIL_SEC = 0.60;     // how far after its cue a phrase may really end

  /** Normalises raw cues into sorted, clamped, non-empty records. */
  function cueList(cues, totalDuration) {
    var list = [];
    for (var i = 0; i < (cues || []).length; i++) {
      var c = cues[i] || {};
      var text = cleanText(c.text);
      var start = Number(c.start);
      var end = Number(c.end);
      if (!text || !isFinite(start) || !isFinite(end)) continue;

      if (end < start) { var swap = start; start = end; end = swap; }
      start = Math.max(0, start);
      if (end - start < 0.08) end = start + 0.08;
      if (typeof totalDuration === 'number' && totalDuration > 0) {
        if (start >= totalDuration - 0.001) continue;
        end = Math.min(end, totalDuration);
      }

      list.push({ start: start, end: end, text: text });
    }
    list.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    return list;
  }

  /**
   * How long a word takes relative to its neighbours: a rough syllable count.
   * Works for Latin (Hinglish, English) and for Devanagari and CJK, where the
   * vowel test finds nothing and character count stands in for syllables.
   */
  function wordWeight(token) {
    var s = String(token || '').replace(/[^0-9A-Za-z\u0900-\u097F\u3040-\u30FF\u4E00-\u9FFF]/g, '');
    if (!s) return 0.5;
    if (/[\u3040-\u30FF\u4E00-\u9FFF]/.test(s)) return Math.max(1, s.length);
    var syl = (s.match(/[aeiouy]+/gi) || []).length;
    if (!syl) syl = Math.ceil(s.length / 2.5);
    var w = Math.max(1, syl);
    return s.length >= 9 ? w + 1 : w;
  }

  /**
   * Spreads one cue's words over the speech segments it overlaps.
   *
   * Words never sit in silence: each one gets a slice of the audible time it
   * belongs to, sized by its syllable weight. With no speech to work from the
   * words are spread proportionally across the cue's own window instead.
   */
  function allocateWords(tokens, segments, fallbackStart, fallbackEnd) {
    var weights = [];
    var totalWeight = 0;
    var i;
    for (i = 0; i < tokens.length; i++) {
      var w = wordWeight(tokens[i]);
      weights.push(w);
      totalWeight += w;
    }

    var totalSpeech = 0;
    for (i = 0; i < segments.length; i++) totalSpeech += segments[i].end - segments[i].start;

    var words = [];
    if (!segments.length || totalSpeech < 0.06) {
      var span = Math.max(0.1, fallbackEnd - fallbackStart);
      var acc = 0;
      for (i = 0; i < tokens.length; i++) {
        var s = fallbackStart + (acc / totalWeight) * span;
        acc += weights[i];
        var e = fallbackStart + (acc / totalWeight) * span;
        words.push({ text: tokens[i], start: s, end: Math.max(e, s + 0.03) });
      }
      return words;
    }

    var segIndex = 0;
    var pos = segments[0].start;
    for (i = 0; i < tokens.length; i++) {
      var need = totalSpeech * (weights[i] / totalWeight);
      var wordStart = null;
      var wordEnd = null;
      var guard = 0;
      while (need > 0.001 && segIndex < segments.length && guard++ < 2000) {
        var seg = segments[segIndex];
        var avail = seg.end - pos;
        if (avail <= 0.001) {
          segIndex++;
          if (segIndex < segments.length) pos = segments[segIndex].start;
          continue;
        }
        var use = Math.min(avail, need);
        if (wordStart === null) wordStart = pos;
        pos += use;
        wordEnd = pos;
        need -= use;

        if (need > 0.001) {
          /* The word ran out of audible time before its share did. End it with
             the sound instead of stretching it across the pause; the next word
             picks up at the next speech run. */
          need = 0;
          segIndex++;
          if (segIndex < segments.length) pos = segments[segIndex].start;
        } else if (pos >= seg.end - 0.001) {
          segIndex++;
          if (segIndex < segments.length) pos = segments[segIndex].start;
        }
      }
      if (wordStart === null) {
        var last = words.length ? words[words.length - 1].end : fallbackStart;
        wordStart = last;
        wordEnd = last + 0.05;
      }
      if (wordEnd === null || wordEnd <= wordStart) wordEnd = wordStart + 0.05;
      words.push({ text: tokens[i], start: wordStart, end: wordEnd });
    }
    return words;
  }

  /**
   * Turns model cues into caption cues pinned to audible speech.
   *
   * For every cue, the words are laid out across the speech segments found in
   * that slice (see Audio.speechSegments). Caption boundaries are the first and
   * last word's actual times, so a caption appears when the speaker starts and
   * disappears when they stop — no padding, no drifting starts. A pause longer
   * than `splitGapMs` always breaks a caption even when the word budget would
   * let more words in.
   */
  function alignCues(cues, segments, opts) {
    opts = opts || {};
    var per = Math.max(1, Math.min(12, Number(opts.wordsPerLine) || 2));
    var lines = Math.max(1, Math.min(4, Number(opts.maxLines) || 1));
    var maxWords = per * lines;
    var hold = (opts.holdMs === undefined) ? HOLD_SEC : Math.max(0, opts.holdMs / 1000);
    var splitGap = (opts.splitGapMs === undefined) ? SPLIT_GAP_SEC
      : Math.max(0.1, opts.splitGapMs / 1000);
    var duration = (typeof opts.duration === 'number' && opts.duration > 0) ? opts.duration : null;

    var list = cueList(cues, duration);
    if (!list.length) return [];

    var speech = [];
    for (var q = 0; q < (segments || []).length; q++) {
      var sg = segments[q];
      if (sg && isFinite(sg.start) && isFinite(sg.end) && sg.end - sg.start >= 0.03) {
        speech.push({ start: Math.max(0, sg.start), end: sg.end });
      }
    }
    speech.sort(function (a, b) { return a.start - b.start; });

    var out = [];
    var cursor = 0;

    for (var i = 0; i < list.length; i++) {
      var cue = list[i];
      var next = list[i + 1] || null;
      var tokens = cue.text.split(' ').filter(Boolean);
      if (!tokens.length) continue;

      var cueStart = Math.max(cursor, cue.start);
      var cueEnd = Math.max(cue.end, cueStart + 0.2);

      var inner = [];
      if (speech.length) {
        var lo = Math.max(cursor, cueStart - LEAD_SEC, 0);
        var hi = cueEnd + TAIL_SEC;
        if (next) hi = Math.min(hi, (cue.end + Math.max(next.start, cueEnd)) / 2);
        if (duration) hi = Math.min(hi, duration);
        if (hi <= lo + 0.05) hi = lo + 0.3;

        for (var s = 0; s < speech.length; s++) {
          var seg = speech[s];
          if (seg.start > hi) break;
          var a = Math.max(seg.start, lo);
          var b = Math.min(seg.end, hi);
          if (b - a >= 0.04) inner.push({ start: a, end: b });
        }
      }

      var words = allocateWords(tokens, inner, cueStart, cueEnd);

      /* Group into captions. A silence in the middle of a phrase is a better
         boundary than the word budget: viewers expect the caption to go away
         while nobody is talking. */
      var group = [];
      for (var w = 0; w < words.length; w++) {
        var word = words[w];
        if (group.length) {
          var lastWord = group[group.length - 1];
          if (group.length >= maxWords || word.start - lastWord.end > splitGap) {
            out.push({
              start: group[0].start,
              end: group[group.length - 1].end + hold,
              text: group.map(function (x) { return x.text; }).join(' ')
            });
            group = [];
          }
        }
        group.push(word);
      }
      if (group.length) {
        out.push({
          start: group[0].start,
          end: group[group.length - 1].end + hold,
          text: group.map(function (x) { return x.text; }).join(' ')
        });
      }

      cursor = Math.max(cursor, words[words.length - 1].end);
    }

    /* A hold may reach into the next caption when speech is very fast; trim the
       earlier one rather than moving the later one off its speech. */
    for (var o = 0; o < out.length; o++) {
      var nextStart = (o + 1 < out.length) ? out[o + 1].start : Infinity;
      var limit = nextStart - 0.02;
      out[o].end = Math.min(out[o].end, limit);
      if (out[o].end <= out[o].start) out[o].end = out[o].start + 0.06;
      if (duration) out[o].end = Math.min(out[o].end, duration);
    }

    return out;
  }

  /**
   * Builds captions from words that already carry their own timestamps.
   *
   * The dedicated transcribe model reports when every word is spoken, so no
   * estimation is needed: a caption starts on its first word's onset and ends
   * just after its last word. A pause longer than `splitGapMs` always closes
   * the caption, which leaves the screen empty while nobody is talking.
   */
  function cuesFromWords(words, opts) {
    opts = opts || {};
    var per = Math.max(1, Math.min(12, Number(opts.wordsPerLine) || 2));
    var lines = Math.max(1, Math.min(4, Number(opts.maxLines) || 1));
    var maxWords = per * lines;
    var hold = (opts.holdMs === undefined) ? 0.08 : Math.max(0, opts.holdMs / 1000);
    var splitGap = (opts.splitGapMs === undefined) ? 0.28
      : Math.max(0.05, opts.splitGapMs / 1000);
    var duration = (typeof opts.duration === 'number' && opts.duration > 0) ? opts.duration : null;

    var list = [];
    for (var i = 0; i < (words || []).length; i++) {
      var w = words[i] || {};
      var text = cleanText(w.text);
      var start = Number(w.start);
      var end = Number(w.end);
      if (!text || !isFinite(start) || !isFinite(end)) continue;

      if (end < start) { var swap = start; start = end; end = swap; }
      start = Math.max(0, start);
      if (duration) {
        if (start >= duration - 0.001) continue;
        end = Math.min(end, duration);
      }
      if (end - start < 0.02) end = start + 0.02;
      list.push({ start: start, end: end, text: text });
    }
    if (!list.length) return [];
    list.sort(function (a, b) { return a.start - b.start || a.end - b.end; });

    var out = [];
    var group = [];

    function flush() {
      if (!group.length) return;
      out.push({
        start: group[0].start,
        end: group[group.length - 1].end + hold,
        text: group.map(function (x) { return x.text; }).join(' ')
      });
      group = [];
    }

    var half = Math.max(2, Math.ceil(maxWords / 2));

    for (var k = 0; k < list.length; k++) {
      var word = list[k];
      if (group.length) {
        var last = group[group.length - 1];
        var pause = word.start - last.end;
        var sentenceEnd = /[.!?…।]["')\]]?$/.test(last.text);
        var clauseEnd = /[,;:]["')\]]?$/.test(last.text);

        if (pause > splitGap ||
            group.length >= maxWords ||
            (sentenceEnd && group.length >= half - 1) ||
            (clauseEnd && maxWords >= 3 && group.length >= maxWords - 1)) {
          flush();
        }
      }
      group.push(word);
    }
    flush();

    for (var o = 0; o < out.length; o++) {
      var nextStart = (o + 1 < out.length) ? out[o + 1].start : Infinity;
      out[o].end = Math.min(out[o].end, nextStart - 0.02);
      if (out[o].end <= out[o].start) out[o].end = out[o].start + 0.06;
      if (duration) out[o].end = Math.min(out[o].end, duration);
    }

    return out;
  }

  /**
   * Last pass over all slices: sort, clamp, remove overlaps by trimming the
   * earlier cue's tail (never by delaying a later cue, which is what used to
   * push captions behind the speech), and lay out the lines.
   */
  function finalize(cues, opts) {
    opts = opts || {};
    var per = Math.max(1, Math.min(12, Number(opts.wordsPerLine) || 2));
    var lines = Math.max(1, Math.min(4, Number(opts.maxLines) || 1));
    var list = cueList(cues, opts.totalDuration);

    for (var i = 1; i < list.length; i++) {
      var prev = list[i - 1];
      var cur = list[i];
      if (prev.end > cur.start - 0.02) {
        prev.end = Math.max(prev.start + 0.05, cur.start - 0.02);
      }
    }

    list.forEach(function (c) {
      c.lines = wrapLines(c.text, per, lines);
    });
    return list;
  }

  function normalize(cues, opts) {
    opts = opts || {};
    var wordsPerLine = opts.wordsPerLine || 2;
    var maxLines = opts.maxLines || 1;
    var total = opts.totalDuration;

    var list = tidy(cues, total);
    list = splitLongCues(list, wordsPerLine, maxLines);
    list = tidy(list, total);

    list.forEach(function (c) {
      c.lines = wrapLines(c.text, wordsPerLine, maxLines);
    });

    return list;
  }

  function build(cues) {
    var out = [];
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      var text = (c.lines && c.lines.length) ? c.lines.join('\n') : cleanText(c.text);
      out.push(String(i + 1));
      out.push(formatTime(c.start) + ' --> ' + formatTime(c.end));
      out.push(text);
      out.push('');
    }
    return out.join('\r\n') + '\r\n';
  }

  return {
    MIN_DUR: MIN_DUR,
    formatTime: formatTime,
    wrapLines: wrapLines,
    splitLongCues: splitLongCues,
    tidy: tidy,
    alignCues: alignCues,
    cuesFromWords: cuesFromWords,
    finalize: finalize,
    normalize: normalize,
    build: build,
    cleanText: cleanText
  };
})();

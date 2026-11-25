/*
 * host.jsx — ExtendScript side of the panel (runs inside Premiere Pro).
 *
 * Every public function returns a JSON string so the panel can parse it.
 * Kept to ES3 (no Array.map/filter/forEach) because ExtendScript is old.
 *
 * ExtendScript is also an ES3 engine: some Premiere builds have no JSON object
 * at all. Load the bundled polyfill first so every reply can be serialised.
 * $.fileName is this script's own path, whether CEP loaded it through
 * ScriptPath or the panel evaluated it with $.evalFile().
 */
(function loadJsonPolyfill() {
  if (typeof JSON !== 'undefined' && JSON &&
      typeof JSON.stringify === 'function' &&
      typeof JSON.parse === 'function') {
    return;
  }

  var candidates = [];
  try {
    if (typeof $ !== 'undefined' && $.fileName) {
      var scriptFile = new File($.fileName);
      if (scriptFile && scriptFile.parent) {
        candidates.push(scriptFile.parent.fsName + '/json2.js');
      }
    }
  } catch (e0) { /* no $.fileName: fall through to the check in j() */ }

  for (var i = 0; i < candidates.length; i++) {
    try {
      var polyfill = new File(candidates[i]);
      if (polyfill.exists) {
        $.evalFile(polyfill);
        if (typeof JSON !== 'undefined' && JSON &&
            typeof JSON.stringify === 'function' &&
            typeof JSON.parse === 'function') {
          return;
        }
      }
    } catch (e1) { /* try the next candidate */ }
  }
})();

var CaptionAI = (function () {

  var TICKS_PER_SECOND = 254016000000;
  var CAPTION_BIN_NAME = '99 openCaption';

  function jsonReady() {
    // Responses only need stringify. parse is loaded too, but a host that
    // already has a working stringify must not be rejected over it.
    return (typeof JSON !== 'undefined') && JSON &&
      (typeof JSON.stringify === 'function');
  }

  /* Used only if JSON.stringify itself throws, so the reply stays valid JSON. */
  function quote(text) {
    var s = String(text);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var code = s.charCodeAt(i);
      if (c === '"') out += '\\"';
      else if (c === '\\') out += '\\\\';
      else if (code < 32) out += '\\u' + ('0000' + code.toString(16)).slice(-4);
      else out += c;
    }
    return '"' + out + '"';
  }

  function j(obj) {
    if (!jsonReady()) {
      return '{"ok":false,"error":' +
        quote('JSON.stringify is missing in ExtendScript and jsx/json2.js did not load. ' +
              'Reinstall openCaption so the bundled polyfill is restored.') + '}';
    }
    try {
      return JSON.stringify(obj);
    } catch (e) {
      return '{"ok":false,"error":' +
        quote('Could not serialise response: ' + e) + '}';
    }
  }

  function fail(msg) {
    return j({ ok: false, error: String(msg) });
  }

  function clipName(clip) {
    var name = '';
    try { name = clip.name || ''; } catch (e) { name = ''; }
    if (!name) {
      try { name = clip.projectItem.name || ''; } catch (e2) { name = ''; }
    }
    return name || '(unnamed clip)';
  }

  function overlapsAny(start, end, ranges) {
    for (var i = 0; i < ranges.length; i++) {
      if (start < ranges[i][1] && end > ranges[i][0]) return true;
    }
    return false;
  }

  function mergeRanges(ranges) {
    var out = [];
    for (var i = 0; i < ranges.length; i++) {
      var r = ranges[i];
      if (!out.length || r[0] > out[out.length - 1][1] + 0.05) {
        out.push([r[0], r[1]]);
      } else if (r[1] > out[out.length - 1][1]) {
        out[out.length - 1][1] = r[1];
      }
    }
    return out;
  }

  function isBinItem(item) {
    try { if (item.type !== undefined && Number(item.type) === 2) return true; } catch (e) {}
    var mediaPath = '';
    try { mediaPath = item.getMediaPath() || ''; } catch (e2) { mediaPath = ''; }
    if (mediaPath) return false;
    try { return !!item.children; } catch (e3) { return false; }
  }

  function findDirectChildBin(parent, name) {
    var children;
    try { children = parent.children; } catch (e) { return null; }
    if (!children) return null;
    for (var i = 0; i < children.numItems; i++) {
      var item = children[i];
      var itemName = '';
      try { itemName = String(item.name || ''); } catch (e1) { itemName = ''; }
      if (itemName === name && isBinItem(item)) return item;
    }
    return null;
  }

  /* Captions live in one bin at the project root so a long session does not
     scatter SRTs through the user's own bins. */
  function ensureCaptionBin() {
    var root = app.project.rootItem;
    var bin = findDirectChildBin(root, CAPTION_BIN_NAME);
    if (bin) return bin;
    try { bin = root.createBin(CAPTION_BIN_NAME); } catch (e) { bin = null; }
    // Some builds create the bin but do not return it.
    if (!bin) bin = findDirectChildBin(root, CAPTION_BIN_NAME);
    return bin || null;
  }

  /* Caption SRTs in the bin are numbered 01, 02, 03… per project. The number
     is taken from the highest numeric name already in the bin, so deleting one
     never renumbers the others. */
  function isCaptionNumber(name) {
    return /^0*\d+(?:\.srt)?$/i.test(String(name || ''));
  }

  function captionNumber(name) {
    var m = String(name || '').match(/^0*(\d+)(?:\.srt)?$/i);
    return m ? Number(m[1]) : 0;
  }

  function captionLabel(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function captionItems(bin) {
    var list = [];
    var children;
    try { children = bin.children; } catch (e) { return list; }
    if (!children) return list;
    for (var i = 0; i < children.numItems; i++) {
      var item = children[i];
      if (isBinItem(item)) continue;
      var mediaPath = '';
      try { mediaPath = item.getMediaPath() || ''; } catch (e1) { mediaPath = ''; }
      if (/\.srt$/i.test(mediaPath)) list.push(item);
    }
    return list;
  }

  /* Names every SRT in the bin that is not numbered yet, in bin order. On the
     first run after this feature this also tidies the older descriptive items;
     numbered items are never touched, so numbers stay stable. */
  function numberCaptionItems(bin) {
    var list = captionItems(bin);
    var max = 0;
    for (var i = 0; i < list.length; i++) {
      var name = '';
      try { name = String(list[i].name || ''); } catch (e0) { name = ''; }
      if (isCaptionNumber(name)) {
        var n = captionNumber(name);
        if (n > max) max = n;
      }
    }

    var next = max + 1;
    for (var j = 0; j < list.length; j++) {
      var current = '';
      try { current = String(list[j].name || ''); } catch (e1) { current = ''; }
      if (isCaptionNumber(current)) continue;
      try {
        list[j].name = captionLabel(next);
        next++;
      } catch (e2) { /* older builds may refuse the rename */ }
    }
  }

  function findItemByPath(bin, wanted) {
    var children;
    try { children = bin.children; } catch (e) { return null; }
    if (!children) return null;

    var target = null;
    try { target = new File(wanted).fsName; } catch (e1) { target = wanted; }
    if (target) target = String(target).toLowerCase().replace(/\\/g, '/');

    for (var i = 0; i < children.numItems; i++) {
      var item = children[i];
      var mediaPath = '';
      try { mediaPath = item.getMediaPath() || ''; } catch (e2) { mediaPath = ''; }
      if (mediaPath) {
        var normalised = String(mediaPath).toLowerCase().replace(/\\/g, '/');
        if (normalised === target) return item;
      }
      var found = findItemByPath(item, wanted);
      if (found) return found;
    }
    return null;
  }

  return {

    /* ---------------------------------------------------------------- ping */
    ping: function () {
      try {
        var pkgPath = '';
        try {
          if (typeof Folder !== 'undefined' && Folder.appPackage) pkgPath = String(Folder.appPackage.fsName || '');
        } catch (ePkg) {}
        if (!pkgPath) {
          try { pkgPath = String(app.path || ''); } catch (eAp) {}
        }
        return j({
          ok: true,
          version: String(app.version || ''),
          appPath: pkgPath,
          project: (app.project ? String(app.project.name || '') : ''),
          sequence: (app.project && app.project.activeSequence)
            ? String(app.project.activeSequence.name || '')
            : ''
        });
      } catch (e) {
        return fail(e);
      }
    },

    /* ------------------------------------------------------- sequence scan */
    getSequenceInfo: function (opts) {
      try {
        opts = opts || {};
        if (!app.project) return fail('No project is open.');
        var seq = app.project.activeSequence;
        if (!seq) return fail('No active sequence. Open a sequence in the Timeline first.');

        var scope = opts.scope || 'sequence';

        /* --- timeline origin ---------------------------------------------
           Sequences can start at e.g. 01:00:00:00. Clip times are absolute,
           so everything is normalised against the sequence zero point and the
           SRT is written in sequence-relative seconds. */
        var base = 0;
        try {
          var zp = Number(seq.zeroPoint);
          if (isFinite(zp) && zp > 0) base = zp / TICKS_PER_SECOND;
        } catch (e0) { base = 0; }

        /* --- collect every usable audio clip ------------------------------ */
        var warnings = [];
        var all = [];
        var maxClipEnd = 0;
        var tracks = seq.audioTracks;

        for (var t = 0; t < tracks.numTracks; t++) {
          var track = tracks[t];

          var muted = false;
          try { muted = !!track.isMuted(); } catch (e1) {
            try { muted = !!track.mute; } catch (e2) { muted = false; }
          }
          if (muted) continue;

          var clipCount = track.clips.numItems;
          for (var c = 0; c < clipCount; c++) {
            var clip = track.clips[c];

            var start, end;
            try {
              start = Number(clip.start.seconds) - base;
              end = Number(clip.end.seconds) - base;
            } catch (e3) { continue; }
            if (!isFinite(start) || !isFinite(end) || end <= start) continue;
            if (end > maxClipEnd) maxClipEnd = end;

            var disabled = false;
            try { disabled = !!clip.disabled; } catch (e4) { disabled = false; }
            if (disabled) continue;

            var mediaPath = '';
            try { mediaPath = clip.projectItem.getMediaPath() || ''; } catch (e5) { mediaPath = ''; }

            if (!mediaPath) {
              all.push({
                track: t,
                name: clipName(clip),
                path: '',
                start: start,
                end: end,
                warning: 'Skipped "' + clipName(clip) + '" on A' + (t + 1) +
                         ': it has no source file (nested sequence or generated media).'
              });
              continue;
            }

            var inPoint = 0, outPoint = 0;
            try {
              inPoint = Number(clip.inPoint.seconds);
              outPoint = Number(clip.outPoint.seconds);
            } catch (e6) { inPoint = 0; outPoint = 0; }

            var srcDur = outPoint - inPoint;
            var tlDur = end - start;
            var speed = (tlDur > 0.01) ? (srcDur / tlDur) : 1;

            /* Premiere quantises clip edges to frames, so a normal clip can
               differ from its source by a frame or two. Only treat a real
               speed change as one; frame noise must not distort the mapping. */
            if (Math.abs(srcDur - tlDur) <= Math.max(0.08, tlDur * 0.05)) speed = 1;

            all.push({
              track: t,
              name: clipName(clip),
              path: mediaPath,
              start: start,
              end: end,
              srcIn: inPoint,
              srcOut: outPoint,
              speed: speed
            });
          }
        }

        /* --- sequence length ---------------------------------------------
           Sequence.end is a STRING of ticks, not a Time object. .seconds does
           not exist on it, which silently produced NaN. */
        var seqEnd = 0;
        try {
          var endTicks = Number(seq.end);
          if (isFinite(endTicks) && endTicks > 0) seqEnd = endTicks / TICKS_PER_SECOND - base;
        } catch (e7) { seqEnd = 0; }
        if (!isFinite(seqEnd) || seqEnd <= 0) seqEnd = maxClipEnd;
        if (!isFinite(seqEnd) || seqEnd <= 0) {
          return fail('Premiere reports this sequence as zero length and no audio clips were found.');
        }

        /* --- caption range ------------------------------------------------
           The panel usually asks for 'auto', which picks the most specific
           range that actually exists: selected clips, else the work area if
           it is enabled, else the whole sequence. */
        var requestedScope = opts.scope || 'auto';
        var scope = requestedScope;
        var selRanges = [];
        var rangeStart = 0;
        var rangeEnd = seqEnd;

        function readSelection() {
          var out = [];
          var sel;
          try { sel = seq.getSelection(); } catch (eSel) { return out; }
          if (!sel) return out;
          for (var s = 0; s < sel.length; s++) {
            var a, b;
            try {
              a = Number(sel[s].start.seconds) - base;
              b = Number(sel[s].end.seconds) - base;
            } catch (eS) { continue; }
            if (isFinite(a) && isFinite(b) && b > a + 0.05) out.push([a, b]);
          }
          out.sort(function (x, y) { return x[0] - y[0]; });
          return mergeRanges(out);
        }

        function readWorkArea() {
          var enabled = true;
          try {
            if (typeof seq.isWorkAreaEnabled === 'function') enabled = !!seq.isWorkAreaEnabled();
          } catch (eW) { enabled = true; }
          if (!enabled) return null;
          try {
            var wi = Number(seq.getWorkAreaInPointAsTime().seconds) - base;
            var wo = Number(seq.getWorkAreaOutPointAsTime().seconds) - base;
            if (!isFinite(wi) || !isFinite(wo) || wo <= wi + 0.1) return null;
            var start = Math.max(0, wi);
            var end = Math.min(seqEnd, wo);
            // A work area spanning the whole sequence is not a narrower range.
            if (start <= 0.05 && end >= seqEnd - 0.05) return null;
            return [start, end];
          } catch (eW2) { return null; }
        }

        if (scope === 'auto') {
          selRanges = readSelection();
          if (selRanges.length) {
            scope = 'selection';
          } else {
            var waAuto = readWorkArea();
            if (waAuto) {
              scope = 'workarea';
              rangeStart = waAuto[0];
              rangeEnd = waAuto[1];
            } else {
              scope = 'sequence';
            }
          }
        }

        if (scope === 'workarea') {
          var wa = readWorkArea();
          if (wa) {
            rangeStart = wa[0];
            rangeEnd = wa[1];
          }
        } else if (scope === 'selection') {
          if (!selRanges.length) selRanges = readSelection();
          if (!selRanges.length) {
            return fail('Nothing usable is selected in the timeline. Select clips, or switch the range to Auto or Whole sequence.');
          }
          rangeStart = selRanges[0][0];
          rangeEnd = selRanges[selRanges.length - 1][1];
        }

        if (!isFinite(rangeStart) || !isFinite(rangeEnd) || rangeEnd <= rangeStart + 0.1) {
          return fail('The caption range is empty (start ' + rangeStart + 's, end ' + rangeEnd + 's).');
        }

        /* --- keep only clips inside the range ----------------------------- */
        var clips = [];
        var seenWarnings = {};
        for (var k = 0; k < all.length; k++) {
          var entry = all[k];
          if (entry.end <= rangeStart || entry.start >= rangeEnd) continue;
          if (scope === 'selection' && !overlapsAny(entry.start, entry.end, selRanges)) continue;

          if (!entry.path) {
            if (entry.warning && !seenWarnings[entry.warning]) {
              seenWarnings[entry.warning] = true;
              warnings.push(entry.warning);
            }
            continue;
          }
          clips.push(entry);
        }

        if (!clips.length) {
          return fail('No usable audio clips found in this range. Check that the audio tracks are not muted and that the clips point to real media files.');
        }

        var timebase = 0;
        try { timebase = Number(seq.timebase); } catch (e7) { timebase = 0; }
        var fps = timebase > 0 ? (TICKS_PER_SECOND / timebase) : 25;

        return j({
          ok: true,
          sequence: {
            name: String(seq.name || 'sequence'),
            end: seqEnd,
            fps: fps,
            scope: scope,
            requestedScope: requestedScope,
            rangeStart: rangeStart,
            rangeEnd: rangeEnd
          },
          clips: clips,
          warnings: warnings
        });
      } catch (e) {
        return fail(e);
      }
    },

    /* ------------------------------------------------- import + caption track */
    importCaptions: function (opts) {
      try {
        opts = opts || {};
        if (!opts.path) return fail('No SRT path supplied.');
        if (!app.project) return fail('No project is open.');
        var seq = app.project.activeSequence;
        if (!seq) return fail('No active sequence.');

        var file = new File(opts.path);
        if (!file.exists) return fail('SRT file not found: ' + opts.path);

        if (!seq.createCaptionTrack) {
          return fail('This Premiere version does not expose createCaptionTrack. Import the SRT manually.');
        }

        /* A bin keeps every caption SRT in one place. If this Premiere build
           cannot make one, fall back to importing at the project root. */
        var bin = ensureCaptionBin();
        var destination = bin || app.project.rootItem;

        /* If an earlier run imported this SRT outside the bin, adopt it rather
           than importing a second copy. */
        var item = findItemByPath(destination, file.fsName);
        if (!item && bin) {
          var existing = findItemByPath(app.project.rootItem, file.fsName);
          if (existing) {
            try { existing.moveBin(bin); } catch (eM) { /* keep it where it is */ }
            item = existing;
          }
        }

        if (!item) {
          var imported = false;
          try {
            imported = app.project.importFiles([file.fsName], true, destination, false);
          } catch (e1) {
            return fail('Premiere could not import the SRT: ' + e1);
          }
          if (!imported) return fail('Premiere reported the SRT import as failed.');
          item = findItemByPath(destination, file.fsName) || findItemByPath(app.project.rootItem, file.fsName);
        }
        if (!item) return fail('The SRT was imported but could not be located in the project panel.');

        /* Name the project item 01, 02, 03… so the caption bin stays ordered.
           The SRT on disk keeps its descriptive, unique filename. This happens
           before createCaptionTrack so the track inherits the same number. */
        var beforeName = String(item.name || '');
        var itemName = beforeName;
        if (bin && !isCaptionNumber(itemName)) {
          numberCaptionItems(bin);
          try { itemName = String(item.name || ''); } catch (e3) { itemName = beforeName; }
        }
        var renamed = itemName !== beforeName;

        var created = false;
        try {
          created = seq.createCaptionTrack(item, 0);
        } catch (e2) {
          return fail('createCaptionTrack failed: ' + e2);
        }

        return j({
          ok: true,
          created: !!created,
          item: itemName,
          numbered: isCaptionNumber(itemName),
          renamed: renamed,
          bin: bin ? CAPTION_BIN_NAME : '',
          sequence: String(seq.name || '')
        });
      } catch (e) {
        return fail(e);
      }
    },

    /* ---------------------------------------------------- MOGRT captioning */
    prepareMogrtTrack: function (opts) {
      try {
        opts = opts || {};
        if (!app.project) return fail('No project is open.');
        var seq = app.project.activeSequence;
        if (!seq) return fail('No active sequence. Open a sequence in the Timeline first.');

        var base = 0;
        try {
          var zp = Number(seq.zeroPoint);
          if (isFinite(zp) && zp > 0) base = zp / TICKS_PER_SECOND;
        } catch (eBase) { base = 0; }

        var startAbs = base + Number(opts.startAt || 0);
        var endAbs = base + Number(opts.endAt || 0);
        if (!isFinite(endAbs) || endAbs <= startAbs) endAbs = startAbs + 1;
        var replaceExisting = !!opts.replaceExisting;

        function secOf(t) {
          if (t === null || t === undefined) return null;
          try {
            if (typeof t.seconds === 'number' && isFinite(t.seconds)) return t.seconds;
            if (t.ticks !== undefined) {
              var n = Number(t.ticks);
              if (isFinite(n)) return n / TICKS_PER_SECOND;
            }
          } catch (e0) {}
          return null;
        }

        function isMogrtClip(clip) {
          try {
            if (typeof clip.isMGT === 'function') return !!clip.isMGT();
          } catch (e1) {}
          try {
            return !!clip.getMGTComponent();
          } catch (e2) {}
          return false;
        }

        function trackBusy(track) {
          var clips;
          try { clips = track.clips; } catch (e0) { return true; }
          if (!clips) return false;
          for (var c = 0; c < clips.numItems; c++) {
            var clip = clips[c];
            if (replaceExisting && isMogrtClip(clip)) continue;
            var a = secOf(clip.start);
            var b = secOf(clip.end);
            if (a === null || b === null) continue;
            if (a < endAbs - 0.02 && b > startAbs + 0.02) return true;
          }
          return false;
        }

        function tryAddTrack() {
          try {
            if (typeof app.enableQE === 'function') app.enableQE();
            if (typeof qe !== 'undefined' && qe && qe.project && typeof qe.project.getActiveSequence === 'function') {
              var qseq = qe.project.getActiveSequence();
              if (qseq && typeof qseq.addTracks === 'function') {
                qseq.addTracks(1, seq.videoTracks.numTracks, 0, 0);
                return true;
              }
            }
          } catch (eQe) {}
          return false;
        }

        var tracks = seq.videoTracks;
        var mode = String(opts.trackMode || 'auto');
        var trackIndex = -1;

        if (mode === 'auto') {
          for (var t = 1; t < tracks.numTracks; t++) {
            if (!trackBusy(tracks[t])) { trackIndex = t; break; }
          }
          if (trackIndex < 0) {
            var beforeCount = tracks.numTracks;
            if (tryAddTrack() && seq.videoTracks.numTracks > beforeCount) {
              trackIndex = beforeCount;
            }
          }
          if (trackIndex < 0 && tracks.numTracks > 0 && !trackBusy(tracks[0])) {
            trackIndex = 0;
          }
          if (trackIndex < 0) {
            return fail('Every video track has clips in this range. Add an empty video track above your footage or pick a track manually.');
          }
        } else {
          var wanted = parseInt(mode, 10);
          if (!isFinite(wanted) || wanted < 0) wanted = 1;
          while (seq.videoTracks.numTracks <= wanted) {
            var prev = seq.videoTracks.numTracks;
            if (!tryAddTrack() || seq.videoTracks.numTracks <= prev) break;
          }
          if (wanted >= seq.videoTracks.numTracks) {
            return fail('Video track V' + (wanted + 1) + ' does not exist in this sequence. Add a video track first or pick Auto.');
          }
          trackIndex = wanted;
        }

        var removed = 0;
        if (replaceExisting) {
          var targetTrack = seq.videoTracks[trackIndex];
          var list = targetTrack.clips;
          for (var i = list.numItems - 1; i >= 0; i--) {
            var item = list[i];
            if (!isMogrtClip(item)) continue;
            var cs = secOf(item.start);
            var ce = secOf(item.end);
            if (cs === null || ce === null) continue;
            if (cs < endAbs - 0.02 && ce > startAbs + 0.02) {
              try {
                item.remove(false, false);
                removed++;
              } catch (eRem) {}
            }
          }
        }

        var fps = 30;
        try {
          var tb = Number(seq.timebase);
          if (isFinite(tb) && tb > 0) fps = TICKS_PER_SECOND / tb;
        } catch (eFps) { fps = 30; }

        return j({
          ok: true,
          trackIndex: trackIndex,
          trackName: 'V' + (trackIndex + 1),
          removed: removed,
          base: base,
          fps: fps,
          sequence: String(seq.name || '')
        });
      } catch (e) {
        return fail(e);
      }
    },

    applyMogrtCue: function (opts) {
      try {
        opts = opts || {};
        if (!app.project) return fail('No project is open.');
        var seq = app.project.activeSequence;
        if (!seq) return fail('No active sequence.');
        if (!seq.importMGT) return fail('This Premiere version does not expose importMGT.');

        var file = new File(opts.path || '');
        if (!file.exists) return fail('MOGRT file not found: ' + (opts.path || ''));

        var trackIndex = parseInt(opts.trackIndex, 10);
        if (!isFinite(trackIndex) || trackIndex < 0 || trackIndex >= seq.videoTracks.numTracks) {
          return fail('Target video track V' + (trackIndex + 1) + ' is out of range.');
        }

        var base = 0;
        try {
          var zp = Number(seq.zeroPoint);
          if (isFinite(zp) && zp > 0) base = zp / TICKS_PER_SECOND;
        } catch (eBase) { base = 0; }

        var startAbs = base + Number(opts.start || 0);
        var endAbs = base + Number(opts.end || 0);
        var wantDur = endAbs - startAbs;
        if (!isFinite(wantDur) || wantDur < 0.04) {
          return fail('Cue duration is too short.');
        }

        function secOf(t) {
          if (t === null || t === undefined) return null;
          try {
            if (typeof t.seconds === 'number' && isFinite(t.seconds)) return t.seconds;
            if (t.ticks !== undefined) {
              var n = Number(t.ticks);
              if (isFinite(n)) return n / TICKS_PER_SECOND;
            }
          } catch (e0) {}
          return null;
        }

        function ticksStr(seconds) {
          return String(Math.round(seconds * TICKS_PER_SECOND));
        }

        function setClipTime(clip, prop, seconds) {
          var tStr = ticksStr(seconds);
          var tries = [
            function () {
              var tm = new Time();
              tm.seconds = seconds;
              clip[prop] = tm;
            },
            function () { clip[prop].seconds = seconds; },
            function () { clip[prop].ticks = tStr; },
            function () { clip[prop] = tStr; },
            function () { clip[prop] = seconds; }
          ];
          for (var i = 0; i < tries.length; i++) {
            try {
              tries[i]();
              var actual = secOf(clip[prop]);
              if (actual !== null && Math.abs(actual - seconds) <= 0.12) return true;
            } catch (e1) {}
          }
          return false;
        }

        function hostSleep(ms) {
          if (!ms || ms <= 0) return;
          try {
            if (typeof $ !== 'undefined' && typeof $.sleep === 'function') $.sleep(ms);
          } catch (eSlp) {}
        }

        var isAfterEffects = !!opts.isAfterEffects;
        var heavyGpu = !!opts.heavyGpu;

        var startTicks = ticksStr(startAbs);
        var audioIndex = parseInt(opts.audioTrackIndex, 10);
        if (!isFinite(audioIndex) || audioIndex < 0) audioIndex = 0;

        var clip = null;
        try {
          clip = seq.importMGT(file.fsName, startTicks, trackIndex, audioIndex);
        } catch (eImp) {
          return fail('importMGT failed: ' + eImp);
        }

        if (!clip) {
          var list = seq.videoTracks[trackIndex].clips;
          for (var c = list.numItems - 1; c >= 0; c--) {
            var cand = list[c];
            var cs = secOf(cand.start);
            if (cs !== null && Math.abs(cs - startAbs) < 0.08) {
              clip = cand;
              break;
            }
          }
        }
        if (!clip) {
          return fail('Premiere did not place the MOGRT clip on V' + (trackIndex + 1) + '.');
        }

        // Wait briefly for AE / Essential Graphics host initialization before mutating clip properties.
        var mgt = null;
        try { mgt = clip.getMGTComponent(); } catch (eMgt0) { mgt = null; }
        if (!mgt) {
          var maxTries = heavyGpu ? 8 : (isAfterEffects ? 5 : 2);
          for (var w = 0; w < maxTries && !mgt; w++) {
            hostSleep(45);
            try { mgt = clip.getMGTComponent(); } catch (eMgtW) { mgt = null; }
          }
        }
        if (heavyGpu) {
          hostSleep(70);
        } else if (isAfterEffects) {
          hostSleep(35);
        }

        // Trim or extend clip end to match cue duration.
        var curEnd = secOf(clip.end);
        if (curEnd === null || Math.abs(curEnd - endAbs) > 0.03) {
          var endOk = setClipTime(clip, 'end', endAbs);
          if (!endOk) {
            var inSec = secOf(clip.inPoint);
            if (inSec === null) inSec = 0;
            setClipTime(clip, 'outPoint', inSec + wantDur);
          }
          if (heavyGpu) hostSleep(40);
          else if (isAfterEffects) hostSleep(20);
        }

        // Update MOGRT text parameter(s) (supports single field and multi-field arrays).
        var textValue = String(opts.text === undefined || opts.text === null ? '' : opts.text);
        var textsArr = (opts.texts && typeof opts.texts === 'object' && typeof opts.texts.length === 'number')
          ? opts.texts
          : null;
        var paramIndex = parseInt(opts.paramIndex, 10);
        var paramName = String(opts.paramName || '');
        var paramNames = (opts.paramNames && typeof opts.paramNames === 'object' && typeof opts.paramNames.length === 'number')
          ? opts.paramNames
          : null;
        var refreshUI = !!opts.refreshUI || isAfterEffects || heavyGpu;
        var textSet = false;
        var warning = '';

        function nameAllowed(disp) {
          if (paramNames && paramNames.length) {
            for (var ni = 0; ni < paramNames.length; ni++) {
              if (String(paramNames[ni] || '') === disp) return true;
            }
          }
          return !!paramName && disp === paramName;
        }

        function parseJsonEntry(prop) {
          var rawVal = null;
          try { rawVal = prop.getValue(); } catch (eVal) { rawVal = null; }
          if (typeof rawVal === 'string' && rawVal.charAt(0) === '{') {
            try {
              var parsed = JSON.parse(rawVal);
              if (parsed && typeof parsed === 'object' && ('textEditValue' in parsed)) {
                return { prop: prop, json: parsed };
              }
            } catch (eJson) {}
          }
          return { prop: prop, json: null, raw: rawVal };
        }

        function writePropValue(entry, valStr, updateUi) {
          var s = String(valStr === undefined || valStr === null ? '' : valStr);
          if (entry.json) {
            // AE GPU effects (Light Sweep, Gradient) can fault on 0-length text bounds or mismatched run arrays.
            var safeText = s.length ? s : ' ';
            entry.json.textEditValue = safeText;
            if (entry.json.fontTextRunLength && typeof entry.json.fontTextRunLength.length === 'number') {
              entry.json.fontTextRunLength = [safeText.length];
            }
            if (entry.json.fontEditValue && typeof entry.json.fontEditValue.length === 'number' && entry.json.fontEditValue.length > 1) {
              entry.json.fontEditValue = [entry.json.fontEditValue[0]];
            }
            entry.prop.setValue(JSON.stringify(entry.json), !!updateUi);
          } else {
            entry.prop.setValue(s, !!updateUi);
          }
        }

        if (!mgt) {
          try { mgt = clip.getMGTComponent(); } catch (eMgt) { mgt = null; }
        }
        if (!mgt && clip.components) {
          for (var ci = 0; ci < clip.components.numItems; ci++) {
            var comp = clip.components[ci];
            if (comp && comp.properties && comp.properties.numItems > 0) {
              try {
                for (var pi = 0; pi < comp.properties.numItems; pi++) {
                  var pv = comp.properties[pi].getValue();
                  if (typeof pv === 'string' && pv.indexOf('textEditValue') >= 0) {
                    mgt = comp;
                    break;
                  }
                }
              } catch (eScan) {}
            }
            if (mgt) break;
          }
        }

        if (mgt && mgt.properties) {
          var props = mgt.properties;
          var targets = [];

          // Fast path: match known displayNames from definition.json without reading all 30+ sliders/colors.
          for (var p = 0; p < props.numItems; p++) {
            var prop = props[p];
            var disp = '';
            try { disp = String(prop.displayName || ''); } catch (eName) { disp = ''; }
            if (nameAllowed(disp)) {
              targets.push(parseJsonEntry(prop));
            }
          }

          // Fallback path: scan all properties if displayNames were localized or missing.
          if (!targets.length) {
            for (var p2 = 0; p2 < props.numItems; p2++) {
              var entry = parseJsonEntry(props[p2]);
              if (entry.json) targets.push(entry);
            }
          }

          var hasTransformAfter = (!!opts.fitToScreen || String(opts.positionMode || 'template') !== 'template');

          if (textsArr && textsArr.length && targets.length) {
            var updatedCount = 0;
            var limit = Math.min(targets.length, textsArr.length);
            for (var ti = 0; ti < limit; ti++) {
              try {
                var isFinalWrite = refreshUI && !hasTransformAfter && (ti === limit - 1);
                writePropValue(targets[ti], textsArr[ti], isFinalWrite);
                updatedCount++;
              } catch (eMulti) {
                if (!warning) warning = 'Placed clip, but updating text field ' + (ti + 1) + ' failed: ' + eMulti;
              }
            }
            textSet = updatedCount > 0;
          } else {
            var picked = null;
            if (targets.length) {
              var idx = (isFinite(paramIndex) && paramIndex >= 0 && paramIndex < targets.length) ? paramIndex : 0;
              picked = targets[idx];
            } else if (paramName && typeof props.getParamForDisplayName === 'function') {
              try {
                var byName = props.getParamForDisplayName(paramName);
                if (byName) picked = parseJsonEntry(byName);
              } catch (eByName) {}
            }

            if (picked && picked.prop) {
              try {
                writePropValue(picked, textValue, refreshUI && !hasTransformAfter);
                textSet = true;
              } catch (eSet) {
                warning = 'Placed clip, but text parameter update failed: ' + eSet;
              }
            } else {
              warning = 'Placed clip, but no editable text control was found in this MOGRT.';
            }
          }
        } else {
          warning = 'Placed clip, but Premiere did not expose MGT properties on this MOGRT.';
        }

        // Fit caption to sequence frame + position (upper / middle / lower).
        var positionMode = String(opts.positionMode || 'template');
        var positionY = Number(opts.positionY);
        if (!isFinite(positionY)) positionY = 0.82;
        positionY = Math.max(0.08, Math.min(0.92, positionY));
        var fitToScreen = !!opts.fitToScreen;

        if (textSet && (heavyGpu || isAfterEffects) && (fitToScreen || positionMode !== 'template')) {
          hostSleep(heavyGpu ? 45 : 20);
        }

        if ((fitToScreen || positionMode !== 'template') && clip.components) {
          var motionComp = null;
          for (var mi = 0; mi < clip.components.numItems; mi++) {
            var mc = clip.components[mi];
            var mName = '';
            var dName = '';
            try { mName = String(mc.matchName || ''); } catch (eMn) {}
            try { dName = String(mc.displayName || ''); } catch (eDn) {}
            if (mName === 'AE.ADBE Motion' || dName === 'Motion') {
              motionComp = mc;
              break;
            }
          }

          if (motionComp && motionComp.properties) {
            var seqW = 1920;
            var seqH = 1080;
            try {
              var sw = Number(seq.frameSizeHorizontal);
              var sh = Number(seq.frameSizeVertical);
              if (isFinite(sw) && sw > 0) seqW = sw;
              if (isFinite(sh) && sh > 0) seqH = sh;
            } catch (eSeqSz) {}

            var posProp = null;
            var scaleProp = null;
            for (var mp = 0; mp < motionComp.properties.numItems; mp++) {
              var mProp = motionComp.properties[mp];
              var pMatch = '';
              var pDisp = '';
              try { pMatch = String(mProp.matchName || ''); } catch (ePm) {}
              try { pDisp = String(mProp.displayName || ''); } catch (ePd) {}
              if (!posProp && (pMatch === 'AE.ADBE Position' || pDisp === 'Position')) posProp = mProp;
              if (!scaleProp && (pMatch === 'AE.ADBE Scale' || pDisp === 'Scale')) scaleProp = mProp;
            }

            if (fitToScreen && scaleProp) {
              try {
                var mogrtW = Number(opts.mogrtWidth) || 1920;
                var mogrtH = Number(opts.mogrtHeight) || 1080;
                if (!isFinite(mogrtW) || mogrtW <= 0) mogrtW = 1920;
                if (!isFinite(mogrtH) || mogrtH <= 0) mogrtH = 1080;

                var resScale = Math.min((seqW * 0.94) / mogrtW, (seqH * 0.94) / mogrtH) * 100;

                var measureSource = (textsArr && textsArr.length) ? textsArr.join('\n') : textValue;
                var linesArr = measureSource.split(/\r?\n/);
                var maxChars = 0;
                for (var li = 0; li < linesArr.length; li++) {
                  var len = linesArr[li].replace(/^\s+|\s+$/g, '').length;
                  if (len > maxChars) maxChars = len;
                }
                var textFactor = maxChars > 24 ? Math.max(0.45, 24 / maxChars) : 1;
                var targetScale = Math.max(20, Math.min(250, Math.round(resScale * textFactor * 10) / 10));

                var curScale = scaleProp.getValue();
                var scaleDiff = true;
                if (typeof curScale === 'number') {
                  scaleDiff = Math.abs(curScale - targetScale) >= 0.5;
                } else if (curScale && typeof curScale === 'object' && curScale.length >= 1) {
                  scaleDiff = Math.abs(Number(curScale[0]) - targetScale) >= 0.5;
                }
                if (scaleDiff) {
                  var scaleUi = refreshUI && (positionMode === 'template' || !posProp);
                  if (curScale && typeof curScale === 'object' && curScale.length >= 2) {
                    scaleProp.setValue([targetScale, targetScale], scaleUi);
                  } else {
                    scaleProp.setValue(targetScale, scaleUi);
                  }
                }
              } catch (eScale) {}
            }

            if (positionMode !== 'template' && posProp) {
              try {
                var curPos = posProp.getValue();
                var isNorm = curPos && curPos.length >= 2 &&
                  Math.abs(Number(curPos[0])) <= 1.5 && Math.abs(Number(curPos[1])) <= 1.5;
                var targetPos = isNorm
                  ? [0.5, positionY]
                  : [seqW * 0.5, seqH * positionY];
                var tol = isNorm ? 0.004 : 2.0;
                var posDiff = !curPos || curPos.length < 2 ||
                  Math.abs(Number(curPos[0]) - targetPos[0]) > tol ||
                  Math.abs(Number(curPos[1]) - targetPos[1]) > tol;
                if (posDiff) posProp.setValue(targetPos, refreshUI);
              } catch (ePos) {}
            }
          }
        }

        return j({
          ok: true,
          placed: true,
          textSet: textSet,
          warning: warning
        });
      } catch (e) {
        return fail(e);
      }
    },

    /* ---------------------------------------------------- .prtextstyle bin */
    importTextStyle: function (opts) {
      try {
        opts = opts || {};
        if (!opts.path) return fail('No .prtextstyle path supplied.');
        if (!app.project) return fail('No project is open.');

        var file = new File(opts.path);
        if (!file.exists) return fail('Text style file not found: ' + opts.path);

        var parentBin = ensureCaptionBin() || app.project.rootItem;
        var styleBinName = 'Text Styles';
        var styleBin = findDirectChildBin(parentBin, styleBinName);
        if (!styleBin && parentBin && parentBin.createBin) {
          try { styleBin = parentBin.createBin(styleBinName); } catch (eB) { styleBin = null; }
          if (!styleBin) styleBin = findDirectChildBin(parentBin, styleBinName);
        }
        var destination = styleBin || parentBin || app.project.rootItem;

        var wantedNames = [];
        var baseName = String(file.displayName || file.name || '').replace(/\.prtextstyle$/i, '');
        if (opts.styleName) wantedNames.push(String(opts.styleName).toLowerCase());
        if (baseName) wantedNames.push(baseName.toLowerCase());
        if (file.name) wantedNames.push(String(file.name).toLowerCase());

        function findStyleByName(bin) {
          var children;
          try { children = bin.children; } catch (eC) { return null; }
          if (!children) return null;
          for (var ci = 0; ci < children.numItems; ci++) {
            var it = children[ci];
            if (!isBinItem(it)) {
              var nm = '';
              try { nm = String(it.name || '').toLowerCase(); } catch (eN) {}
              var nmNoExt = nm.replace(/\.prtextstyle$/i, '');
              for (var wi = 0; wi < wantedNames.length; wi++) {
                if (nm === wantedNames[wi] || nmNoExt === wantedNames[wi]) return it;
              }
            } else {
              var subHit = findStyleByName(it);
              if (subHit) return subHit;
            }
          }
          return null;
        }

        var existing = findItemByPath(destination, file.fsName) ||
                       findItemByPath(app.project.rootItem, file.fsName) ||
                       findStyleByName(destination) ||
                       findStyleByName(app.project.rootItem);
        var alreadyInProject = !!existing;
        var item = existing;
        var actualBinLabel = styleBin ? (CAPTION_BIN_NAME + ' / ' + styleBinName) : (parentBin === app.project.rootItem ? 'Project root' : CAPTION_BIN_NAME);

        if (!item) {
          var beforeCount = 0;
          try { beforeCount = (destination.children && destination.children.numItems) || 0; } catch (eBc) {}
          var imported = false;
          try {
            imported = app.project.importFiles([file.fsName], true, destination, false);
          } catch (eImp) {
            imported = false;
          }
          item = findItemByPath(destination, file.fsName) ||
                 findStyleByName(destination);
          if (!item && destination.children && destination.children.numItems > beforeCount) {
            try { item = destination.children[destination.children.numItems - 1]; } catch (eLast) {}
          }
          if (!imported && !item && destination !== app.project.rootItem) {
            var rootBefore = 0;
            try { rootBefore = (app.project.rootItem.children && app.project.rootItem.children.numItems) || 0; } catch (eRb) {}
            try {
              imported = app.project.importFiles([file.fsName], true, app.project.rootItem, false);
            } catch (eImpRoot) {
              return fail('Premiere could not import the .prtextstyle: ' + eImpRoot);
            }
            item = findItemByPath(app.project.rootItem, file.fsName) || findStyleByName(app.project.rootItem);
            if (!item && app.project.rootItem.children && app.project.rootItem.children.numItems > rootBefore) {
              try { item = app.project.rootItem.children[app.project.rootItem.children.numItems - 1]; } catch (eRlast) {}
            }
            if (item || imported) actualBinLabel = 'Project root';
          }
          if (!imported && !item) {
            return fail('Premiere reported the .prtextstyle import as failed.');
          }
        }

        var itemName = '';
        try { itemName = item ? String(item.name || '') : (opts.styleName || file.displayName || file.name); } catch (eNm) { itemName = file.name; }

        return j({
          ok: true,
          imported: true,
          alreadyInProject: alreadyInProject,
          item: itemName,
          bin: actualBinLabel
        });
      } catch (e) {
        return fail(e);
      }
    },

    /* -------------------------------------------------------- misc utilities */
    revealInExplorer: function (opts) {
      try {
        var p = (opts && opts.path) ? opts.path : '';
        if (!p) return fail('No path supplied.');
        var f = new File(p);
        if (!f.exists) return fail('Path does not exist: ' + p);
        var dir = f.parent ? f.parent.fsName : f.fsName;
        try {
          system.callSystem('explorer /select,"' + f.fsName + '"');
        } catch (e1) {
          new Folder(dir).execute();
        }
        return j({ ok: true });
      } catch (e) {
        return fail(e);
      }
    }
  };
})();

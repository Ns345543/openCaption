/*
 * host.jsx — ExtendScript side of the panel (runs inside Premiere Pro).
 *
 * Every public function returns a JSON string so the panel can parse it.
 * Kept to ES3 (no Array.map/filter/forEach) because ExtendScript is old.
 */
var CaptionAI = (function () {

  var TICKS_PER_SECOND = 254016000000;
  var CAPTION_BIN_NAME = '99 Caption AI';

  function j(obj) {
    try {
      return JSON.stringify(obj);
    } catch (e) {
      return '{"ok":false,"error":"Could not serialise response: ' + String(e) + '"}';
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
        return j({
          ok: true,
          version: String(app.version || ''),
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

        var created = false;
        try {
          created = seq.createCaptionTrack(item, 0);
        } catch (e2) {
          return fail('createCaptionTrack failed: ' + e2);
        }

        return j({
          ok: true,
          created: !!created,
          item: String(item.name || ''),
          bin: bin ? CAPTION_BIN_NAME : '',
          sequence: String(seq.name || '')
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

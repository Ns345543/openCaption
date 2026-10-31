/*
 * premiere-diagnose.jsx
 *
 * Standalone ExtendScript check for the parts of the API the panel depends on.
 * Run it inside Premiere:  File > Scripts > Run Script File...
 *
 * It never modifies the project. It reports:
 *   - version / active sequence
 *   - every audio clip the panel would use, with its source path and trim
 *   - clips the panel must skip (no media path, speed changes)
 *   - whether createCaptionTrack() is available on this build
 */
(function () {
  var TICKS_PER_SECOND = 254016000000;
  var lines = [];

  function say(s) { lines.push(s); }
  function clipName(clip) {
    var n = '';
    try { n = clip.name || ''; } catch (e) { n = ''; }
    if (!n) { try { n = clip.projectItem.name || ''; } catch (e2) { n = ''; } }
    return n || '(unnamed)';
  }
  function r2(n) { return Math.round(n * 100) / 100; }

  try {
    say('Premiere Pro ' + app.version);

    var project = app.project;
    if (!project) {
      say('');
      say('No project open.');
      alert(lines.join('\n'));
      return;
    }

    var seq = project.activeSequence;
    if (!seq) {
      say('Project: ' + project.name);
      say('');
      say('No active sequence. Open one in the Timeline and run this again.');
      alert(lines.join('\n'));
      return;
    }

    var tb = Number(seq.timebase);
    var fps = tb > 0 ? (TICKS_PER_SECOND / tb) : 0;
    // Sequence.end is a string of ticks, not a Time object.
    var endTicks = Number(seq.end);
    var endSeconds = isFinite(endTicks) ? (endTicks / TICKS_PER_SECOND) : 0;

    say('Project   : ' + project.name);
    say('Sequence  : ' + seq.name);
    say('Duration  : ' + r2(endSeconds) + ' s   (' + (fps ? r2(fps) + ' fps' : 'unknown timebase') + ')');

    var waEnabled = false;
    try { waEnabled = seq.isWorkAreaEnabled(); } catch (e) { waEnabled = false; }
    say('Work area : ' + (waEnabled ? 'enabled' : 'disabled'));

    say('');
    say('createCaptionTrack : ' + (typeof seq.createCaptionTrack === 'function' ? 'AVAILABLE' : 'MISSING'));

    say('');
    say('AUDIO TRACKS');
    var tracks = seq.audioTracks;
    var usable = 0, skipped = 0;

    for (var t = 0; t < tracks.numTracks; t++) {
      var track = tracks[t];
      var muted = false;
      try { muted = !!track.isMuted(); } catch (e1) { muted = false; }

      say('');
      say('  A' + (t + 1) + (muted ? '   [MUTED - panel will skip]' : ''));

      for (var c = 0; c < track.clips.numItems; c++) {
        var clip = track.clips[c];
        var start = Number(clip.start.seconds);
        var end = Number(clip.end.seconds);

        var mediaPath = '';
        try { mediaPath = clip.projectItem.getMediaPath() || ''; } catch (e2) { mediaPath = ''; }

        var srcDur = 0;
        try { srcDur = Number(clip.outPoint.seconds) - Number(clip.inPoint.seconds); } catch (e3) { srcDur = 0; }
        var speed = (end - start) > 0.01 ? (srcDur / (end - start)) : 1;

        var flags = [];
        if (!mediaPath) { flags.push('NO MEDIA PATH - skipped'); skipped++; }
        else { usable++; }
        if (Math.abs(speed - 1) > 0.02) flags.push('SPEED ' + r2(speed) + 'x - timing drifts');

        say('    "' + clipName(clip) + '"');
        say('      timeline ' + r2(start) + ' - ' + r2(end) + ' s' +
            (srcDur ? '   source in ' + r2(Number(clip.inPoint.seconds)) : ''));
        say('      ' + (mediaPath || '(none)'));
        if (flags.length) say('      !! ' + flags.join(' | '));
      }
      if (!track.clips.numItems) say('    (empty)');
    }

    say('');
    say('SUMMARY');
    say('  usable clips   : ' + usable);
    say('  skipped clips  : ' + skipped);

    var missing = 0;
    for (var t2 = 0; t2 < tracks.numTracks; t2++) {
      var tr = tracks[t2];
      for (var c2 = 0; c2 < tr.clips.numItems; c2++) {
        var p = '';
        try { p = tr.clips[c2].projectItem.getMediaPath() || ''; } catch (e4) { p = ''; }
        if (p && !(new File(p)).exists) missing++;
      }
    }
    say('  offline media  : ' + missing + (missing ? '  <-- these will fail to transcribe' : ''));

    say('');
    say('If the numbers above look right, the panel can read this timeline.');
  } catch (err) {
    lines.push('');
    lines.push('ERROR: ' + err);
  }

  alert(lines.join('\n'));
})();

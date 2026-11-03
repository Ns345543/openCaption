/*
 * actions.jsx — the Premiere side of the openCaption Action Engine.
 *
 * Every function here is called by the panel through
 * CaptionActions.dispatch(JSON.stringify({ name, params })).  Only functions
 * listed in the API object below can be reached; the AI never supplies
 * ExtendScript, and unknown names are rejected.
 *
 * ES3 only: ExtendScript has no Array.prototype.map/filter/forEach and some
 * builds have no JSON global (jsx/json2.js provides one).
 */
var CaptionActions = (function () {

  var TICKS_PER_SECOND = 254016000000;

  /* ------------------------------------------------------------- helpers */

  function j(obj) {
    try {
      return JSON.stringify(obj);
    } catch (e) {
      return '{"ok":false,"error":"Could not serialise the action result."}';
    }
  }

  function fail(message, extra) {
    var out = { ok: false, error: String(message) };
    if (extra) {
      for (var k in extra) {
        if (extra.hasOwnProperty(k)) out[k] = extra[k];
      }
    }
    return j(out);
  }

  function parseJson(text) {
    if (text && typeof text === 'object') return text;
    if (!text) return {};
    try { return JSON.parse(String(text)); } catch (e) { return null; }
  }

  function isArray(value) {
    return Object.prototype.toString.call(value) === '[object Array]';
  }

  function finite(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function round(value, places) {
    var p = Math.pow(10, places || 3);
    return Math.round(value * p) / p;
  }

  function secondsOf(time) {
    if (time === null || time === undefined) return null;
    if (typeof time === 'number') return isFinite(time) ? time : null;
    try {
      var s = Number(time.seconds);
      if (isFinite(s)) return s;
    } catch (e1) { /* try ticks */ }
    try {
      var t = Number(time.ticks);
      if (isFinite(t)) return t / TICKS_PER_SECOND;
    } catch (e2) { /* give up */ }
    return null;
  }

  function activeSequence() {
    if (!app.project) throw new Error('No project is open in Premiere.');
    var seq = app.project.activeSequence;
    if (!seq) throw new Error('No active sequence. Open a sequence in the Timeline first.');
    return seq;
  }

  function sequenceFps(seq) {
    var timebase = 0;
    try { timebase = Number(seq.timebase); } catch (e) { timebase = 0; }
    if (timebase > 0) {
      var fps = TICKS_PER_SECOND / timebase;
      if (isFinite(fps) && fps > 0) return fps;
    }
    return 25;
  }

  function sequenceDuration(seq) {
    var end = 0;
    try { end = Number(seq.end); } catch (e) { end = 0; }
    var zero = 0;
    try { zero = Number(seq.zeroPoint); } catch (e2) { zero = 0; }
    var duration = (isFinite(end) && isFinite(zero)) ? (end - zero) / TICKS_PER_SECOND : 0;
    if (!isFinite(duration) || duration <= 0) {
      duration = 0;
      var vt = seq.videoTracks;
      var at = seq.audioTracks;
      var t, c, e3;
      for (t = 0; t < vt.numTracks; t++) {
        for (c = 0; c < vt[t].clips.numItems; c++) {
          e3 = secondsOf(vt[t].clips[c].end);
          if (e3 !== null && e3 > duration) duration = e3;
        }
      }
      for (t = 0; t < at.numTracks; t++) {
        for (c = 0; c < at[t].clips.numItems; c++) {
          e3 = secondsOf(at[t].clips[c].end);
          if (e3 !== null && e3 > duration) duration = e3;
        }
      }
    }
    return duration;
  }

  function playheadSeconds(seq) {
    try {
      var pos = seq.getPlayerPosition();
      var seconds = secondsOf(pos);
      if (seconds !== null) {
        var zero = 0;
        try { zero = Number(seq.zeroPoint); } catch (e) { zero = 0; }
        return seconds - (isFinite(zero) ? zero / TICKS_PER_SECOND : 0);
      }
    } catch (e2) { /* ignore */ }
    return null;
  }

  /* Clip times in this file are read from Time objects without subtracting the
     sequence zero point, exactly like clip.start.seconds in the standard DOM.
     For a sequence that starts at e.g. 01:00:00:00, that makes relative range
     math (sequenceDuration, playheadSeconds) disagree with clip positions, and
     a QE razor timecode is ambiguous. Rather than risk cutting the wrong place,
     every mutating action refuses non-zero-based sequences with a clear
     message. Read-only context still works. */
  function writableSequence() {
    var seq = activeSequence();
    var zero = 0;
    try { zero = Number(seq.zeroPoint); } catch (e) { zero = 0; }
    if (isFinite(zero) && Math.abs(zero) > 0.0001) {
      throw new Error('This sequence starts at ' + round(zero / TICKS_PER_SECOND, 3) +
        's, not 00:00:00:00. openCaption 1.8 edits zero-based sequences only, so it cannot cut ' +
        'the wrong place. Move the sequence to 00:00:00:00 and try again.');
    }
    return seq;
  }

  function trackLabel(type, index) {
    return (type === 'audio' ? 'A' : 'V') + (index + 1);
  }

  function trackLocked(track) {
    try {
      if (typeof track.isLocked === 'function') return !!track.isLocked();
    } catch (e1) { /* next form */ }
    try {
      if (track.locked !== undefined && track.locked !== null) return !!track.locked;
    } catch (e2) { /* unknown */ }
    return null;
  }

  function trackMuted(track) {
    try {
      if (typeof track.isMuted === 'function') return !!track.isMuted();
    } catch (e1) { /* next form */ }
    try {
      if (track.mute !== undefined && track.mute !== null) return !!track.mute;
    } catch (e2) { /* unknown */ }
    return null;
  }

  function clipName(clip) {
    try { if (clip.name) return String(clip.name); } catch (e1) { /* next */ }
    try { if (clip.projectItem && clip.projectItem.name) return String(clip.projectItem.name); } catch (e2) { /* next */ }
    return '(unnamed clip)';
  }

  function projectItemInfo(clip) {
    var item = null;
    try { item = clip.projectItem; } catch (e) { item = null; }
    if (!item) return null;
    var out = { name: '', nodeId: '', mediaPath: '', offline: null };
    try { out.name = String(item.name || ''); } catch (e2) { /* ignore */ }
    try { out.nodeId = String(item.nodeId || ''); } catch (e3) { /* ignore */ }
    try { out.mediaPath = String(item.getMediaPath() || ''); } catch (e4) { /* ignore */ }
    try { if (typeof item.isOffline === 'function') out.offline = !!item.isOffline(); } catch (e5) { /* ignore */ }
    return out;
  }

  function componentList(clip, includeProperties) {
    var out = [];
    var comps;
    try { comps = clip.components; } catch (e) { return out; }
    if (!comps) return out;
    var count = 0;
    try { count = comps.numItems; } catch (e2) { count = 0; }
    for (var i = 0; i < count && i < 24; i++) {
      var comp = comps[i];
      var entry = { displayName: '', matchName: '', enabled: null, properties: [] };
      try { entry.displayName = String(comp.displayName || ''); } catch (e3) { /* ignore */ }
      try { entry.matchName = String(comp.matchName || ''); } catch (e4) { /* ignore */ }
      try { entry.enabled = !!comp.enabled; } catch (e5) { /* ignore */ }
      if (includeProperties) {
        var props;
        try { props = comp.properties; } catch (e6) { props = null; }
        var pcount = 0;
        try { pcount = props.numItems; } catch (e7) { pcount = 0; }
        for (var p = 0; p < pcount && p < 40; p++) {
          var param = props[p];
          var prop = { displayName: '', value: null };
          try { prop.displayName = String(param.displayName || ''); } catch (e8) { /* ignore */ }
          try {
            var value = param.getValue();
            if (value === null || value === undefined) prop.value = null;
            else if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') prop.value = value;
            else prop.value = null;
          } catch (e9) { prop.value = null; }
          entry.properties.push(prop);
        }
      }
      out.push(entry);
    }
    return out;
  }

  function clipInfo(clip, type, trackIndex, clipIndex, deep) {
    var start = secondsOf(clip.start);
    var end = secondsOf(clip.end);
    var inPoint = secondsOf(clip.inPoint);
    var outPoint = secondsOf(clip.outPoint);
    var info = {
      nodeId: '',
      name: clipName(clip),
      trackType: type,
      trackIndex: trackIndex,
      track: trackLabel(type, trackIndex),
      clipIndex: clipIndex,
      start: start === null ? null : round(start),
      end: end === null ? null : round(end),
      duration: (start === null || end === null) ? null : round(end - start),
      inPoint: inPoint === null ? null : round(inPoint),
      outPoint: outPoint === null ? null : round(outPoint),
      isAdjustmentLayer: false,
      selected: false,
      disabled: false,
      projectItem: projectItemInfo(clip)
    };
    try { info.nodeId = String(clip.nodeId || ''); } catch (e) { info.nodeId = ''; }
    try { info.isAdjustmentLayer = !!clip.isAdjustmentLayer(); } catch (e2) { info.isAdjustmentLayer = false; }
    try { info.selected = !!clip.isSelected(); } catch (e3) { info.selected = false; }
    try { info.disabled = !!clip.disabled; } catch (e4) { info.disabled = false; }
    if (deep) info.components = componentList(clip, true);
    return info;
  }

  function trackInfo(track, type, index) {
    var count = 0;
    try { count = track.clips.numItems; } catch (e) { count = 0; }
    var name = '';
    try { name = String(track.name || ''); } catch (e2) { name = ''; }
    return {
      type: type,
      index: index,
      name: name || trackLabel(type, index),
      muted: trackMuted(track),
      locked: trackLocked(track),
      clipCount: count
    };
  }

  function allTracks(seq) {
    var out = [];
    var t;
    for (t = 0; t < seq.videoTracks.numTracks; t++) {
      out.push({ type: 'video', index: t, track: seq.videoTracks[t] });
    }
    for (t = 0; t < seq.audioTracks.numTracks; t++) {
      out.push({ type: 'audio', index: t, track: seq.audioTracks[t] });
    }
    return out;
  }

  function trackAt(seq, type, index) {
    var collection = (type === 'audio') ? seq.audioTracks : seq.videoTracks;
    if (index < 0 || index >= collection.numTracks) return null;
    return collection[index];
  }

  function findClipByNodeId(seq, nodeId) {
    var wanted = String(nodeId || '');
    if (!wanted) return null;
    var tracks = allTracks(seq);
    for (var i = 0; i < tracks.length; i++) {
      var entry = tracks[i];
      var clips;
      try { clips = entry.track.clips; } catch (e) { continue; }
      for (var c = 0; c < clips.numItems; c++) {
        var clip = clips[c];
        var id = '';
        try { id = String(clip.nodeId || ''); } catch (e2) { id = ''; }
        if (id === wanted) {
          return {
            clip: clip,
            track: entry.track,
            trackType: entry.type,
            trackIndex: entry.index,
            clipIndex: c,
            info: clipInfo(clip, entry.type, entry.index, c, false)
          };
        }
      }
    }
    return null;
  }

  function selectedTargets(seq) {
    var out = [];
    var seen = {};
    function add(clip, type, index, clipIndex) {
      var id = '';
      try { id = String(clip.nodeId || ''); } catch (e) { id = ''; }
      var key = id || (type + ':' + index + ':' + clipIndex);
      if (seen[key]) return;
      seen[key] = true;
      out.push({
        clip: clip,
        track: trackAt(seq, type, index),
        trackType: type,
        trackIndex: index,
        clipIndex: clipIndex,
        info: clipInfo(clip, type, index, clipIndex, false)
      });
    }
    var tracks = allTracks(seq);
    for (var i = 0; i < tracks.length; i++) {
      var entry = tracks[i];
      for (var c = 0; c < entry.track.clips.numItems; c++) {
        var clip = entry.track.clips[c];
        var selected = false;
        try { selected = !!clip.isSelected(); } catch (e2) { selected = false; }
        if (selected) add(clip, entry.type, entry.index, c);
      }
    }
    return out;
  }

  function resolveTarget(seq, params) {
    if (params.nodeId) {
      var found = findClipByNodeId(seq, params.nodeId);
      if (!found) throw new Error('The requested clip is no longer in the active sequence. Read the timeline again.');
      return found;
    }
    var selected = selectedTargets(seq);
    if (!selected.length) {
      throw new Error('Nothing is selected in the Timeline. Select a clip, or name the target explicitly.');
    }
    if (selected.length > 1) {
      throw new Error(selected.length + ' clips are selected. Select exactly one, or target a clip by nodeId.');
    }
    return selected[0];
  }

  function ensureWritable(target) {
    var locked = trackLocked(target.track);
    if (locked === true) {
      throw new Error('Track ' + trackLabel(target.trackType, target.trackIndex) + ' is locked. Unlock it in Premiere and try again.');
    }
    if (target.info && target.info.projectItem && target.info.projectItem.offline === true) {
      throw new Error('The media for "' + (target.info.name || 'this clip') + '" is offline. ' +
        'Relink it in Premiere (File > Link Media), then try again.');
    }
  }

  /* ------------------------------------------------------------ QE helpers */

  function enableQE() {
    try { app.enableQE(); } catch (e) { /* already enabled on some builds */ }
    if (typeof qe === 'undefined' || !qe || !qe.project) {
      throw new Error('The QE editing interface is not available in this Premiere build. ' +
        'openCaption cannot perform this operation safely without it.');
    }
    return qe;
  }

  function activateForQE(seq) {
    var q = enableQE();
    var active = app.project.activeSequence;
    var same = false;
    try { same = (active === seq || (active && seq && active.sequenceID === seq.sequenceID)); } catch (e) { same = false; }
    if (!same) {
      try { app.project.activeSequence = seq; } catch (e2) {
        throw new Error('The sequence is not the active Timeline tab. Open "' + String(seq.name || 'the sequence') +
          '" in the Timeline and try again.');
      }
    }
    var qeSeq = q.project.getActiveSequence();
    if (!qeSeq) throw new Error('Premiere did not expose the active sequence through QE.');
    return { qe: q, qeSeq: qeSeq };
  }

  function qeTrackFor(qeSeq, type, index) {
    try {
      return type === 'audio' ? qeSeq.getAudioTrackAt(index) : qeSeq.getVideoTrackAt(index);
    } catch (e) {
      return null;
    }
  }

  function qeItemSeconds(item, which) {
    var time = null;
    try { time = item[which]; } catch (e) { time = null; }
    return secondsOf(time);
  }

  function qeClipFor(qeTrack, startSeconds, endSeconds, tolerance) {
    if (!qeTrack) return null;
    var count = 0;
    try { count = qeTrack.numItems; } catch (e) { count = 0; }
    for (var i = 0; i < count; i++) {
      var item = null;
      try { item = qeTrack.getItemAt(i); } catch (e2) { item = null; }
      if (!item) continue;
      var type = '';
      try { type = String(item.type || ''); } catch (e3) { type = ''; }
      if (type && type !== 'Clip') continue;
      var start = qeItemSeconds(item, 'start');
      var end = qeItemSeconds(item, 'end');
      if (start === null || end === null) continue;
      if (Math.abs(start - startSeconds) <= tolerance && Math.abs(end - endSeconds) <= tolerance) return item;
    }
    return null;
  }

  function qeTimecode(seconds, fps) {
    var nominal = Math.max(1, Math.round(fps));
    var totalFrames = Math.round(seconds * fps);
    var ff = totalFrames % nominal;
    var totalSeconds = Math.floor(totalFrames / nominal);
    var ss = totalSeconds % 60;
    var totalMinutes = Math.floor(totalSeconds / 60);
    var mm = totalMinutes % 60;
    var hh = Math.floor(totalMinutes / 60);
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return pad(hh) + ':' + pad(mm) + ':' + pad(ss) + ':' + pad(ff);
  }

  function ticksString(seconds) {
    return String(Math.round(seconds * TICKS_PER_SECOND));
  }

  function razor(qeTrack, seconds, fps) {
    if (!qeTrack) return false;
    var before = 0;
    try { before = qeTrack.numItems; } catch (e) { before = 0; }
    var tc = qeTimecode(seconds, fps);
    try {
      qeTrack.razor(tc);
    } catch (e1) {
      try { qeTrack.razor(ticksString(seconds)); } catch (e2) { return false; }
    }
    var after = before;
    try { after = qeTrack.numItems; } catch (e3) { after = before; }
    return after > before;
  }

  function razorSequence(qeSeq, seconds, fps) {
    var tc = qeTimecode(seconds, fps);
    try {
      qeSeq.razor(tc);
      return true;
    } catch (e1) {
      try { qeSeq.razor(ticksString(seconds)); return true; } catch (e2) { return false; }
    }
  }

  function snapToFrame(seconds, fps) {
    if (!isFinite(fps) || fps <= 0) return seconds;
    return Math.round(seconds * fps) / fps;
  }

  /* ----------------------------------------------------- clip time writes */

  function timeWriteForms(property, seconds) {
    return [
      function (clip) { clip[property] = ticksString(seconds); },
      function (clip) { clip[property] = seconds; },
      function (clip) { clip[property].ticks = ticksString(seconds); },
      function (clip) { clip[property].seconds = seconds; },
      function (clip) {
        var t = new Time();
        t.seconds = seconds;
        clip[property] = t;
      }
    ];
  }

  function setClipTime(clip, property, seconds) {
    var forms = timeWriteForms(property, seconds);
    for (var i = 0; i < forms.length; i++) {
      try {
        forms[i](clip);
        var actual = secondsOf(clip[property]);
        if (actual !== null && Math.abs(actual - seconds) <= 0.2) return true;
      } catch (e) { /* try the next form */ }
    }
    return false;
  }

  function shiftClip(clip, delta) {
    var start = secondsOf(clip.start);
    var end = secondsOf(clip.end);
    if (start === null || end === null) return false;
    var newStart = start + delta;
    var newEnd = end + delta;
    if (newStart < -0.01) return false;
    var okStart, okEnd;
    if (delta < 0) {
      okStart = setClipTime(clip, 'start', newStart);
      okEnd = okStart ? setClipTime(clip, 'end', newEnd) : false;
    } else {
      okEnd = setClipTime(clip, 'end', newEnd);
      okStart = okEnd ? setClipTime(clip, 'start', newStart) : false;
    }
    return okStart && okEnd;
  }

  function removeClip(clip) {
    var attempts = [
      function () { clip.remove(false, true); },
      function () { clip.remove(true, true); },
      function () { clip.remove(false, false); },
      function () { clip.remove(0, 0); }
    ];
    for (var i = 0; i < attempts.length; i++) {
      try {
        attempts[i]();
        return true;
      } catch (e) { /* next form */ }
    }
    return false;
  }

  function pairedTargets(seq, target) {
    var out = [];
    var itemId = '';
    try { itemId = String(target.clip.projectItem.nodeId || ''); } catch (e) { itemId = ''; }
    if (!itemId) return out;
    var start = secondsOf(target.clip.start);
    var end = secondsOf(target.clip.end);
    if (start === null || end === null) return out;

    var tracks = allTracks(seq);
    for (var i = 0; i < tracks.length; i++) {
      var entry = tracks[i];
      if (entry.type === target.trackType && entry.index === target.trackIndex) continue;
      for (var c = 0; c < entry.track.clips.numItems; c++) {
        var clip = entry.track.clips[c];
        var cid = '';
        try { cid = String(clip.projectItem.nodeId || ''); } catch (e2) { cid = ''; }
        if (cid !== itemId) continue;
        var cs = secondsOf(clip.start);
        var ce = secondsOf(clip.end);
        if (cs === null || ce === null) continue;
        if (Math.abs(cs - start) > 0.05 || Math.abs(ce - end) > 0.05) continue;
        out.push({
          clip: clip,
          track: entry.track,
          trackType: entry.type,
          trackIndex: entry.index,
          info: clipInfo(clip, entry.type, entry.index, c, false)
        });
      }
    }
    return out;
  }

  function linkedTargets(seq, target) {
    var out = [];
    var linked = null;
    try { linked = target.clip.getLinkedItems(); } catch (e) { linked = null; }
    var count = 0;
    try { count = linked ? linked.numItems : 0; } catch (e2) { count = 0; }
    for (var i = 0; i < count; i++) {
      var item = null;
      try { item = linked[i]; } catch (e3) { item = null; }
      if (!item) continue;
      var id = '';
      try { id = String(item.nodeId || ''); } catch (e4) { id = ''; }
      if (!id || (id === target.info.nodeId)) continue;
      var found = findClipByNodeId(seq, id);
      if (found) out.push(found);
    }
    /* QE's razor drops the link relation on the new halves. When Premiere
       reports no links, fall back to a clip on another track with the same
       source media and identical start/end so A/V stay in sync. */
    if (!out.length) return pairedTargets(seq, target);
    return out;
  }

  function clipsOnTrack(track) {
    var out = [];
    try {
      for (var i = 0; i < track.clips.numItems; i++) out.push(track.clips[i]);
    } catch (e) { /* empty */ }
    return out;
  }

  function overlappingClip(track, start, end, ignoreNodeId) {
    var list = clipsOnTrack(track);
    for (var i = 0; i < list.length; i++) {
      var clip = list[i];
      var id = '';
      try { id = String(clip.nodeId || ''); } catch (e) { id = ''; }
      if (ignoreNodeId && id === ignoreNodeId) continue;
      var s = secondsOf(clip.start);
      var e = secondsOf(clip.end);
      if (s === null || e === null) continue;
      if (s < end - 0.001 && e > start + 0.001) return clipInfo(clip, '', 0, i, false);
    }
    return null;
  }

  function countTrackClips(track) {
    try { return track.clips.numItems; } catch (e) { return 0; }
  }

  function countAll(seq) {
    var total = 0;
    var tracks = allTracks(seq);
    for (var i = 0; i < tracks.length; i++) total += countTrackClips(tracks[i].track);
    return total;
  }

  /* --------------------------------------------------------- context reads */

  function contextFor(seq, includeClips, includeEffects) {
    var fps = sequenceFps(seq);
    var duration = sequenceDuration(seq);
    var context = {
      project: '',
      projectPath: '',
      sequence: {
        name: '',
        sequenceID: '',
        duration: round(duration),
        fps: round(fps, 3),
        frameWidth: null,
        frameHeight: null,
        zeroPoint: 0,
        playhead: null,
        videoTrackCount: 0,
        audioTrackCount: 0
      },
      videoTracks: [],
      audioTracks: [],
      selectedClips: [],
      clips: [],
      effects: [],
      undo: null,
      warnings: []
    };
    try { context.project = String(app.project.name || ''); } catch (e) { context.project = ''; }
    try { context.projectPath = String(app.project.path || ''); } catch (e1) { context.projectPath = ''; }
    try { context.sequence.name = String(seq.name || ''); } catch (e2) { /* ignore */ }
    try { context.sequence.sequenceID = String(seq.sequenceID || ''); } catch (e3) { /* ignore */ }
    try { context.sequence.frameWidth = Number(seq.frameSizeHorizontal) || null; } catch (e4) { /* ignore */ }
    try { context.sequence.frameHeight = Number(seq.frameSizeVertical) || null; } catch (e5) { /* ignore */ }
    try { context.sequence.zeroPoint = Number(seq.zeroPoint) / TICKS_PER_SECOND || 0; } catch (e6) { /* ignore */ }
    context.sequence.playhead = playheadSeconds(seq);
    try { context.sequence.videoTrackCount = seq.videoTracks.numTracks; } catch (e7) { /* ignore */ }
    try { context.sequence.audioTrackCount = seq.audioTracks.numTracks; } catch (e8) { /* ignore */ }

    var tracks = allTracks(seq);
    var i, c;
    for (i = 0; i < tracks.length; i++) {
      var entry = tracks[i];
      var info = trackInfo(entry.track, entry.type, entry.index);
      if (entry.type === 'audio') context.audioTracks.push(info);
      else context.videoTracks.push(info);

      var selected = false;
      for (c = 0; c < entry.track.clips.numItems && c < 300; c++) {
        var clip = entry.track.clips[c];
        try { selected = !!clip.isSelected(); } catch (e9) { selected = false; }
        if (selected && context.selectedClips.length < 20) {
          context.selectedClips.push(clipInfo(clip, entry.type, entry.index, c, false));
        }
        if (includeClips && context.clips.length < 300) {
          context.clips.push(clipInfo(clip, entry.type, entry.index, c, false));
        }
      }
    }

    if (includeEffects) {
      var q;
      try { q = enableQE(); } catch (e10) { q = null; }
      if (q) {
        try {
          var list = q.project.getVideoEffectList();
          if (list) {
            for (var e = 0; e < list.length && context.effects.length < 200; e++) {
              var effect = list[e];
              var name = '';
              try { name = effect.name ? String(effect.name) : String(effect); } catch (e11) { name = ''; }
              if (name) context.effects.push(name);
            }
          }
        } catch (e12) { context.warnings.push('The video effect list could not be read.'); }
      }
    }

    try {
      var q2 = enableQE();
      if (typeof q2.project.undoStackIndex === 'function') {
        context.undo = { index: q2.project.undoStackIndex() };
      }
    } catch (e13) { context.undo = null; }

    return context;
  }

  /* --------------------------------------------------------------- actions */

  var API = {};

  API.getContext = function (argsJson) {
    try {
      var params = parseJson(argsJson) || {};
      var seq = activeSequence();
      var context = contextFor(seq, !!params.includeClips, !!params.includeEffects);
      return j({ ok: true, context: context });
    } catch (e) { return fail(e.message || e); }
  };

  API.getSelectedClips = function (argsJson) {
    try {
      var seq = activeSequence();
      var selected = selectedTargets(seq);
      var list = [];
      for (var i = 0; i < selected.length; i++) {
        list.push(clipInfo(selected[i].clip, selected[i].trackType, selected[i].trackIndex, selected[i].clipIndex, true));
      }
      return j({
        ok: true,
        sequence: String(seq.name || ''),
        playhead: playheadSeconds(seq),
        selected: list
      });
    } catch (e) { return fail(e.message || e); }
  };

  API.splitClip = function (argsJson) {
    try {
      var params = parseJson(argsJson) || {};
      var seq = writableSequence();
      var target = resolveTarget(seq, params);
      ensureWritable(target);

      var fps = sequenceFps(seq);
      var at = finite(params.atSeconds) ? params.atSeconds : playheadSeconds(seq);
      if (at === null) return fail('The playhead position could not be read. Give a time in seconds instead.');
      at = snapToFrame(at, fps);
      var start = secondsOf(target.clip.start);
      var end = secondsOf(target.clip.end);
      if (start === null || end === null) return fail('The clip start/end could not be read.');
      if (at <= start + 0.02 || at >= end - 0.02) {
        return fail('The split point ' + round(at) + 's is outside "' + clipName(target.clip) +
          '" (' + round(start) + 's–' + round(end) + 's).', { clip: target.info });
      }

      var q = activateForQE(seq);
      var qeTrack = qeTrackFor(q.qeSeq, target.trackType, target.trackIndex);
      if (!qeTrack) return fail('QE did not expose track ' + trackLabel(target.trackType, target.trackIndex) + '.');

      var before = countTrackClips(target.track);
      var razored = razor(qeTrack, at, fps);
      var after = countTrackClips(target.track);

      var linked = linkedTargets(seq, target);
      var linkedResults = [];
      for (var i = 0; i < linked.length; i++) {
        var link = linked[i];
        var linkLocked = trackLocked(link.track);
        if (linkLocked === true) {
          linkedResults.push({ nodeId: link.info.nodeId, track: trackLabel(link.trackType, link.trackIndex), split: false, error: 'locked' });
          continue;
        }
        var lt = qeTrackFor(q.qeSeq, link.trackType, link.trackIndex);
        var lb = countTrackClips(link.track);
        var lr = razor(lt, at, fps);
        var la = countTrackClips(link.track);
        linkedResults.push({ nodeId: link.info.nodeId, track: trackLabel(link.trackType, link.trackIndex), split: lr, countBefore: lb, countAfter: la });
      }

      var verified = after === before + 1;
      if (!verified) {
        return fail('Premiere did not split the clip at ' + round(at, 2) + 's. The track may be locked, or the razor call was rejected.', {
          sequence: String(seq.name || ''),
          clip: target.info,
          atSeconds: at,
          countBefore: before,
          countAfter: after,
          razored: razored,
          linked: linkedResults
        });
      }

      return j({
        ok: true,
        result: {
          sequence: String(seq.name || ''),
          clip: target.info,
          atSeconds: at,
          track: trackLabel(target.trackType, target.trackIndex),
          countBefore: before,
          countAfter: after,
          verified: true,
          linked: linkedResults
        }
      });
    } catch (e) { return fail(e.message || e); }
  };

  API.deleteClip = function (argsJson) {
    try {
      var params = parseJson(argsJson) || {};
      var seq = writableSequence();
      var targets;
      if (params.nodeId) {
        var one = findClipByNodeId(seq, params.nodeId);
        if (!one) return fail('The requested clip is no longer in the active sequence.');
        targets = [one];
      } else {
        targets = selectedTargets(seq);
      }
      if (!targets.length) return fail('Nothing is selected in the Timeline.');

      var results = [];
      var removed = 0;
      for (var i = 0; i < targets.length; i++) {
        var target = targets[i];
        var locked = trackLocked(target.track);
        if (locked === true) {
          results.push({ nodeId: target.info.nodeId, name: target.info.name, removed: false, error: 'Track is locked.' });
          continue;
        }
        var before = countTrackClips(target.track);
        var ok = removeClip(target.clip);
        var after = countTrackClips(target.track);
        var verified = ok && after < before;
        if (verified) removed++;
        results.push({
          nodeId: target.info.nodeId,
          name: target.info.name,
          track: trackLabel(target.trackType, target.trackIndex),
          removed: verified,
          countBefore: before,
          countAfter: after
        });
      }

      return j({
        ok: removed === targets.length,
        result: {
          sequence: String(seq.name || ''),
          requested: targets.length,
          removed: removed,
          results: results
        }
      });
    } catch (e) { return fail(e.message || e); }
  };

  API.moveClip = function (argsJson) {
    try {
      var params = parseJson(argsJson) || {};
      if (!finite(params.startSeconds)) return fail('startSeconds is required.');
      var seq = writableSequence();
      var target = resolveTarget(seq, params);
      ensureWritable(target);

      var start = secondsOf(target.clip.start);
      var end = secondsOf(target.clip.end);
      if (start === null || end === null) return fail('The clip start/end could not be read.');
      var duration = end - start;
      var newStart = snapToFrame(params.startSeconds, sequenceFps(seq));
      var newEnd = newStart + duration;
      if (newStart < 0) return fail('The new start cannot be before 00:00:00:00.');

      var conflict = overlappingClip(target.track, newStart, newEnd, target.info.nodeId);
      if (conflict) {
        return fail('Moving "' + target.info.name + '" to ' + round(newStart, 2) +
          's would overlap "' + conflict.name + '". Move the other clip first.', { conflict: conflict });
      }

      var delta = newStart - start;
      var linked = linkedTargets(seq, target);
      var linkConflicts = [];
      for (var i = 0; i < linked.length; i++) {
        var link = linked[i];
        if (trackLocked(link.track) === true) {
          return fail('Linked clip on ' + trackLabel(link.trackType, link.trackIndex) + ' is locked.');
        }
        var ls = secondsOf(link.clip.start);
        var le = secondsOf(link.clip.end);
        if (ls !== null && le !== null) {
          var c = overlappingClip(link.track, ls + delta, le + delta, link.info.nodeId);
          if (c) linkConflicts.push({ track: trackLabel(link.trackType, link.trackIndex), conflict: c });
        }
      }
      if (linkConflicts.length) {
        return fail('Moving the clip would make a linked clip overlap another clip.', { conflicts: linkConflicts });
      }

      if (!shiftClip(target.clip, delta)) {
        return fail('Premiere rejected the move on ' + trackLabel(target.trackType, target.trackIndex) + '.');
      }
      var linkResults = [];
      for (var l = 0; l < linked.length; l++) {
        var moved = shiftClip(linked[l].clip, delta);
        linkResults.push({ nodeId: linked[l].info.nodeId, track: trackLabel(linked[l].trackType, linked[l].trackIndex), moved: moved });
      }

      var actual = secondsOf(target.clip.start);
      return j({
        ok: actual !== null && Math.abs(actual - newStart) <= 0.2,
        result: {
          sequence: String(seq.name || ''),
          clip: target.info,
          fromSeconds: start,
          toSeconds: newStart,
          deltaSeconds: delta,
          actualStart: actual,
          track: trackLabel(target.trackType, target.trackIndex),
          linked: linkResults,
          verified: actual !== null && Math.abs(actual - newStart) <= 0.2
        }
      });
    } catch (e) { return fail(e.message || e); }
  };

  function snapshotClipIds(seq) {
    var ids = {};
    var tracks = allTracks(seq);
    for (var i = 0; i < tracks.length; i++) {
      for (var c = 0; c < tracks[i].track.clips.numItems; c++) {
        var id = '';
        try { id = String(tracks[i].track.clips[c].nodeId || ''); } catch (e) { id = ''; }
        if (id) ids[id] = true;
      }
    }
    return ids;
  }

  /* Track.insertClip also lands the clip's audio on another audio track in
     Premiere 26.5. Remove only clips that appeared during this insertion, so
     a duplicate never leaves silent stray copies behind. */
  function removeStrayClips(seq, beforeIds, keepType, keepIndex, at, itemId) {
    var removed = [];
    var remaining = [];
    var tracks = allTracks(seq);
    for (var t = 0; t < tracks.length; t++) {
      var entry = tracks[t];
      if (entry.type === keepType && entry.index === keepIndex) continue;
      for (var c = entry.track.clips.numItems - 1; c >= 0; c--) {
        var clip = entry.track.clips[c];
        var id = '';
        try { id = String(clip.nodeId || ''); } catch (e) { id = ''; }
        if (!id || beforeIds[id]) continue;
        var cid = '';
        try { cid = String(clip.projectItem.nodeId || ''); } catch (e2) { cid = ''; }
        if (itemId && cid !== itemId) continue;
        var cs = secondsOf(clip.start);
        if (cs === null || Math.abs(cs - at) > 0.5) continue;
        var info = { nodeId: id, track: trackLabel(entry.type, entry.index), name: '' };
        try { info.name = String(clip.name || ''); } catch (e3) { info.name = ''; }
        removeClip(clip);
        var stillThere = false;
        try {
          for (var k = 0; k < entry.track.clips.numItems; k++) {
            if (String(entry.track.clips[k].nodeId || '') === id) { stillThere = true; break; }
          }
        } catch (e4) { stillThere = true; }
        if (stillThere) remaining.push(info); else removed.push(info);
      }
    }
    return { removed: removed, remaining: remaining };
  }

  function findInsertedClip(track, at, itemId) {
    for (var c = track.clips.numItems - 1; c >= 0; c--) {
      var clip = track.clips[c];
      var cid = '';
      try { cid = String(clip.projectItem.nodeId || ''); } catch (e) { cid = ''; }
      var cs = secondsOf(clip.start);
      if ((!itemId || cid === itemId) && cs !== null && Math.abs(cs - at) <= 0.3) {
        return { clip: clip, index: c };
      }
    }
    return null;
  }

  API.duplicateClip = function (argsJson) {
    try {
      var params = parseJson(argsJson) || {};
      var seq = writableSequence();
      var target = resolveTarget(seq, params);
      ensureWritable(target);

      var item = null;
      try { item = target.clip.projectItem; } catch (e) { item = null; }
      if (!item) return fail('The clip has no source project item, so it cannot be duplicated.');

      var start = secondsOf(target.clip.start);
      var end = secondsOf(target.clip.end);
      var at = finite(params.startSeconds) ? params.startSeconds : (end === null ? null : end);
      if (at === null) return fail('A target start time could not be determined.');
      at = snapToFrame(at, sequenceFps(seq));
      if (start === null || end === null) return fail('The clip start/end could not be read.');
      var duration = end - start;
      var sourceIn = secondsOf(target.clip.inPoint);

      var conflict = overlappingClip(target.track, at, at + duration, null);
      if (conflict) {
        return fail('Track ' + trackLabel(target.trackType, target.trackIndex) +
          ' already has "' + conflict.name + '" at that time. Nothing was inserted.', { conflict: conflict });
      }

      var itemId = '';
      try { itemId = String(item.nodeId || ''); } catch (e3) { itemId = ''; }

      var before = countTrackClips(target.track);
      var beforeIds = snapshotClipIds(seq);
      try {
        var t = new Time();
        t.seconds = at;
        target.track.insertClip(item, t);
      } catch (e2) {
        return fail('Premiere rejected the insert: ' + (e2.message || e2));
      }
      var after = countTrackClips(target.track);
      if (after <= before) {
        return fail('Premiere did not insert a copy on ' + trackLabel(target.trackType, target.trackIndex) + '.');
      }

      var stray = removeStrayClips(seq, beforeIds, target.trackType, target.trackIndex, at, itemId);
      var placed = findInsertedClip(target.track, at, itemId);
      if (stray.remaining.length || !placed) {
        if (placed) removeClip(placed.clip);
        return fail('Premiere inserted the copy but also created extra clips that could not be cleaned up. ' +
          'The inserted copy was removed so the timeline is unchanged.', {
          strayRemaining: stray.remaining,
          strayRemoved: stray.removed
        });
      }
      var newClip = placed.clip;
      var newClipIndex = placed.index;

      var inOk = true;
      if (sourceIn !== null) inOk = setClipTime(newClip, 'inPoint', sourceIn);
      var endOk = setClipTime(newClip, 'end', at + duration);
      var trimmed = inOk && endOk;
      var actualStart = secondsOf(newClip.start);
      var actualEnd = secondsOf(newClip.end);
      var verified = trimmed && actualStart !== null && actualEnd !== null &&
        Math.abs(actualStart - at) <= 0.2 && Math.abs(actualEnd - (at + duration)) <= 0.2;

      return j({
        ok: verified,
        result: {
          sequence: String(seq.name || ''),
          source: target.info,
          atSeconds: at,
          track: trackLabel(target.trackType, target.trackIndex),
          countBefore: before,
          countAfter: after,
          newClip: newClip ? clipInfo(newClip, target.trackType, target.trackIndex, newClipIndex, false) : null,
          verified: verified,
          sourceInPreserved: sourceIn === null ? null : trimmed,
          straysRemoved: stray.removed,
          rippled: false
        }
      });
    } catch (e) { return fail(e.message || e); }
  };

  function highestUsedVideoTrack(seq) {
    var highest = -1;
    for (var i = 0; i < seq.videoTracks.numTracks; i++) {
      if (countTrackClips(seq.videoTracks[i]) > 0) highest = i;
    }
    return highest;
  }

  function findEmptyVideoTrackAbove(seq, aboveIndex) {
    for (var i = aboveIndex + 1; i < seq.videoTracks.numTracks; i++) {
      if (countTrackClips(seq.videoTracks[i]) === 0) return i;
    }
    return -1;
  }

  function findNewProjectItem(seq, beforeIds, countBefore) {
    var children;
    try { children = app.project.rootItem.children; } catch (e) { return null; }
    if (!children || children.numItems <= countBefore) return null;
    var i, item, id;
    for (i = children.numItems - 1; i >= 0; i--) {
      item = children[i];
      id = '';
      try { id = String(item.nodeId || ''); } catch (e2) { id = ''; }
      if (id && !beforeIds[id]) return item;
    }
    for (i = children.numItems - 1; i >= 0; i--) {
      item = children[i];
      var name = '';
      try { name = String(item.name || ''); } catch (e3) { name = ''; }
      if (name.toLowerCase().indexOf('adjustment') !== -1) return item;
    }
    return null;
  }

  var ADJUSTMENT_ITEM_NAME = 'openCaption Adjustment Layer';

  function snapshotProjectIds() {
    var ids = {};
    try {
      var children = app.project.rootItem.children;
      for (var i = 0; i < children.numItems; i++) {
        var id = '';
        try { id = String(children[i].nodeId || ''); } catch (e) { id = ''; }
        if (id) ids[id] = true;
      }
    } catch (e2) { /* empty snapshot is harmless */ }
    return ids;
  }

  function isAdjustmentItem(item) {
    try { if (item && item.isAdjustmentLayer() === true) return true; } catch (e) { /* fall through */ }
    var name = '';
    try { name = String(item && item.name || ''); } catch (e2) { name = ''; }
    return name.toLowerCase().indexOf('adjustment') !== -1;
  }

  function findAdjustmentItemByName(name) {
    try {
      var children = app.project.rootItem.children;
      for (var i = 0; i < children.numItems; i++) {
        var item = children[i];
        var itemName = '';
        try { itemName = String(item.name || ''); } catch (e) { itemName = ''; }
        if (itemName === name && isAdjustmentItem(item)) return item;
      }
    } catch (e2) { /* treat as not found */ }
    return null;
  }

  /* Premiere 26.5 has no scripting call that creates an adjustment layer.
     The panel ships a media-free template project containing one, imports it
     once per project, and then reuses that item. Native creation is preferred
     when a future build exposes it. */
  function adjustmentTemplatePath() {
    var here = '';
    try { here = String($.fileName || ''); } catch (e) { here = ''; }
    if (!here) return '';
    try {
      var file = new File(File(here).parent.parent.fsName + '/templates/adjustment-layer.prproj');
      if (file.exists) return file.fsName;
    } catch (e2) { /* fall through */ }
    return '';
  }

  function ensureAdjustmentLayerItem(q) {
    var existing = findAdjustmentItemByName(ADJUSTMENT_ITEM_NAME);
    if (existing) return { item: existing, added: false };

    if (q && q.qe && q.qe.project && typeof q.qe.project.newAdjustmentLayer === 'function') {
      var nativeIds = snapshotProjectIds();
      var nativeCount = app.project.rootItem.children.numItems;
      var createError = null;
      try { q.qe.project.newAdjustmentLayer(); } catch (e1) { createError = e1.message || String(e1); }
      if (!createError) {
        var created = findNewProjectItem(null, nativeIds, nativeCount);
        if (created && isAdjustmentItem(created)) {
          try { created.name = ADJUSTMENT_ITEM_NAME; } catch (e2) { /* name is cosmetic */ }
          return { item: created, added: true };
        }
      }
    }

    var template = adjustmentTemplatePath();
    if (!template) {
      return {
        item: null,
        added: false,
        error: 'The bundled adjustment-layer template is missing. Reinstall openCaption, ' +
          'or add the layer with New Item > Adjustment Layer in Premiere.'
      };
    }

    var beforeIds = snapshotProjectIds();
    var countBefore = app.project.rootItem.children.numItems;
    var importError = '';
    try {
      app.project.importFiles([template], true, app.project.rootItem, false);
    } catch (e3) {
      importError = e3.message || String(e3);
    }
    var item = findNewProjectItem(null, beforeIds, countBefore);
    if (!item) item = findAdjustmentItemByName(ADJUSTMENT_ITEM_NAME);
    if (!item) {
      return {
        item: null,
        added: false,
        error: 'Premiere could not import the adjustment-layer template' +
          (importError ? ': ' + importError : '.')
      };
    }
    if (!isAdjustmentItem(item)) {
      return {
        item: null,
        added: true,
        error: 'The adjustment-layer template imported, but its item is not an adjustment layer.'
      };
    }
    try { item.name = ADJUSTMENT_ITEM_NAME; } catch (e4) { /* name is cosmetic */ }
    return { item: item, added: true };
  }

  API.addAdjustmentLayer = function (argsJson) {
    try {
      var params = parseJson(argsJson) || {};
      var seq = writableSequence();
      var fps = sequenceFps(seq);
      var duration = sequenceDuration(seq);
      var selected = selectedTargets(seq);

      var align = params.align || 'sequence';
      var start = 0;
      var length = duration;
      if (align === 'selection' && selected.length) {
        var minStart = null;
        var maxEnd = null;
        for (var s = 0; s < selected.length; s++) {
          var ss = secondsOf(selected[s].clip.start);
          var se = secondsOf(selected[s].clip.end);
          if (ss !== null && (minStart === null || ss < minStart)) minStart = ss;
          if (se !== null && (maxEnd === null || se > maxEnd)) maxEnd = se;
        }
        if (minStart !== null && maxEnd !== null) { start = minStart; length = maxEnd - minStart; }
      }
      if (finite(params.startSeconds)) start = params.startSeconds;
      if (finite(params.durationSeconds)) length = params.durationSeconds;
      if (!finite(length) || length <= 0.05) return fail('The adjustment layer needs a positive duration.');
      start = Math.max(0, snapToFrame(start, fps));
      length = snapToFrame(length, fps);
      if (duration > 0 && start + length > duration + 0.05) {
        length = Math.max(0.05, duration - start);
      }

      var q = activateForQE(seq);

      var trackIndex;
      if (finite(params.trackIndex)) {
        trackIndex = Math.round(params.trackIndex);
        if (trackIndex < 0 || trackIndex >= seq.videoTracks.numTracks) {
          return fail('Video track V' + (trackIndex + 1) + ' does not exist. The sequence has ' +
            seq.videoTracks.numTracks + ' video track(s).', { trackIndex: trackIndex });
        }
      } else {
        var reference = highestUsedVideoTrack(seq);
        var selectedVideoTrack = -1;
        if (align === 'selection') {
          for (var v = 0; v < selected.length; v++) {
            if (selected[v].trackType !== 'video') continue;
            if (selected[v].trackIndex > selectedVideoTrack) selectedVideoTrack = selected[v].trackIndex;
          }
          if (selectedVideoTrack >= 0) reference = selectedVideoTrack;
        }
        trackIndex = findEmptyVideoTrackAbove(seq, reference);
        if (trackIndex < 0) {
          if (align === 'selection' && selectedVideoTrack >= 0) {
            return fail('The selected clips sit on V' + (selectedVideoTrack + 1) +
              ', and every video track above it already has clips. Add a video track in Premiere, then ask again.',
              { highestSelectedTrack: 'V' + (selectedVideoTrack + 1) });
          }
          if (reference < 0) return fail('The sequence has no empty video track.');
          return fail('Every video track above V' + (reference + 1) +
            ' already has clips. Add a video track in Premiere, then ask again.',
            { highestUsedTrack: 'V' + (reference + 1) });
        }
      }

      var targetTrack = seq.videoTracks[trackIndex];
      var locked = trackLocked(targetTrack);
      if (locked === true) return fail('Video track V' + (trackIndex + 1) + ' is locked.');
      var conflict = overlappingClip(targetTrack, start, start + length, null);
      if (conflict) {
        return fail('Video track V' + (trackIndex + 1) + ' already has "' + conflict.name +
          '" in that range. An adjustment layer was not inserted, so nothing was overwritten.', { conflict: conflict });
      }

      var ensured = ensureAdjustmentLayerItem(q);
      if (!ensured.item) return fail(ensured.error || 'The adjustment layer could not be created.');
      var item = ensured.item;

      var qeTrack = qeTrackFor(q.qeSeq, 'video', trackIndex);
      var placeBefore = countTrackClips(targetTrack);
      var placed = false;
      var placeError = '';

      /* The DOM insert works for adjustment layers on 26.5.2, where QE
         insert/overwrite silently do nothing. */
      try {
        var t = new Time();
        t.seconds = start;
        targetTrack.insertClip(item, t);
        placed = countTrackClips(targetTrack) > placeBefore;
      } catch (e5) {
        placeError = e5.message || String(e5);
      }
      if (!placed && qeTrack) {
        try {
          qeTrack.insert(item, ticksString(start));
          placed = countTrackClips(targetTrack) > placeBefore;
        } catch (e6) {
          placeError += ' / ' + (e6.message || String(e6));
        }
      }
      if (!placed) {
        return fail('The adjustment layer was created in the project but could not be placed on V' +
          (trackIndex + 1) + ': ' + (placeError || 'Premiere did not add a clip.'), { projectItem: item.name || '' });
      }

      var nodeId = '';
      try { nodeId = String(item.nodeId || ''); } catch (e7) { nodeId = ''; }
      var placedClip = null;
      for (var c = targetTrack.clips.numItems - 1; c >= 0; c--) {
        var candidate = targetTrack.clips[c];
        var cid = '';
        try { cid = String(candidate.projectItem.nodeId || ''); } catch (e8) { cid = ''; }
        var candidateAdj = false;
        try { candidateAdj = !!candidate.isAdjustmentLayer(); } catch (e9) { candidateAdj = false; }
        var cs = secondsOf(candidate.start);
        var matchesItem = (nodeId && cid === nodeId) || candidateAdj;
        if (matchesItem && cs !== null && Math.abs(cs - start) <= 0.5) {
          placedClip = candidate;
          break;
        }
      }
      if (!placedClip) {
        return fail('The adjustment layer was placed, but it could not be located to set its duration. ' +
          'Check V' + (trackIndex + 1) + ' in Premiere.', { projectItem: item.name || '' });
      }

      var end = start + length;
      var trimmedStart = setClipTime(placedClip, 'start', start);
      var trimmedEnd = trimmedStart ? setClipTime(placedClip, 'end', end) : false;
      var actualStart = secondsOf(placedClip.start);
      var actualEnd = secondsOf(placedClip.end);
      var verified = trimmedStart && trimmedEnd && actualStart !== null && actualEnd !== null &&
        Math.abs(actualStart - start) <= 0.2 && Math.abs(actualEnd - end) <= 0.2;
      var adjustmentVerified = false;
      try { adjustmentVerified = !!placedClip.isAdjustmentLayer(); } catch (e10) { adjustmentVerified = false; }

      if (!verified) {
        removeClip(placedClip);
        return fail('Premiere inserted the adjustment layer but rejected its duration. ' +
          'The inserted clip was removed so the timeline is unchanged.', {
          requestedStart: start,
          requestedEnd: end,
          actualStart: actualStart,
          actualEnd: actualEnd,
          adjustmentVerified: adjustmentVerified
        });
      }

      return j({
        ok: true,
        result: {
          sequence: String(seq.name || ''),
          track: 'V' + (trackIndex + 1),
          trackIndex: trackIndex,
          start: actualStart,
          end: actualEnd,
          duration: actualEnd - actualStart,
          projectItem: String(item.name || ''),
          isAdjustmentLayer: adjustmentVerified,
          verified: verified && adjustmentVerified
        }
      });
    } catch (e) { return fail(e.message || e); }
  };

  function normalizeEffectName(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function effectCatalog() {
    var q = enableQE();
    var names = [];
    try {
      var list = q.project.getVideoEffectList();
      if (list) {
        for (var i = 0; i < list.length; i++) {
          var e = list[i];
          var name = '';
          try { name = e.name ? String(e.name) : String(e); } catch (e2) { name = ''; }
          if (name) names.push(name);
        }
      }
    } catch (e3) { /* use direct lookup below */ }
    return names;
  }

  function resolveEffect(name) {
    var wanted = normalizeEffectName(name);
    if (!wanted) return null;
    var names = effectCatalog();
    var exact = null;
    var partial = null;
    for (var i = 0; i < names.length; i++) {
      var n = normalizeEffectName(names[i]);
      if (n === wanted) { exact = names[i]; break; }
      if (!partial && (n.indexOf(wanted) !== -1 || wanted.indexOf(n) !== -1)) partial = names[i];
    }
    var chosen = exact || partial;
    if (!chosen) return null;
    var q = enableQE();
    var obj = null;
    try { obj = q.project.getVideoEffectByName(chosen); } catch (e) { obj = null; }
    if (!obj) return null;
    return { name: chosen, object: obj };
  }

  function findComponent(clip, effectName) {
    var wanted = normalizeEffectName(effectName);
    var comps = componentList(clip, false);
    for (var i = 0; i < comps.length; i++) {
      var n = normalizeEffectName(comps[i].displayName);
      var m = normalizeEffectName(comps[i].matchName);
      if (n === wanted || m === wanted || (wanted && (n.indexOf(wanted) !== -1 || m.indexOf(wanted) !== -1))) {
        return { index: i, info: comps[i] };
      }
    }
    return null;
  }

  function findProperty(comp, propertyName) {
    var wanted = normalizeEffectName(propertyName);
    var props;
    try { props = comp.properties; } catch (e) { return null; }
    if (!props) return null;
    var count = 0;
    try { count = props.numItems; } catch (e2) { count = 0; }
    for (var i = 0; i < count; i++) {
      var param = props[i];
      var name = '';
      try { name = String(param.displayName || ''); } catch (e3) { name = ''; }
      var n = normalizeEffectName(name);
      if (n === wanted || (wanted && n.indexOf(wanted) !== -1)) return { index: i, param: param, displayName: name };
    }
    return null;
  }

  API.applyEffect = function (argsJson) {
    try {
      var params = parseJson(argsJson) || {};
      if (!params.effectName) return fail('effectName is required.');
      var seq = writableSequence();
      var target = resolveTarget(seq, params);
      if (target.trackType !== 'video') return fail('Video effects can only be applied to video clips.');
      ensureWritable(target);

      var effect = resolveEffect(params.effectName);
      if (!effect) {
        var names = effectCatalog();
        var sample = [];
        for (var i = 0; i < names.length && sample.length < 12; i++) {
          var n = normalizeEffectName(names[i]);
          var w = normalizeEffectName(params.effectName);
          if (n.indexOf(w) !== -1 || w.indexOf(n) !== -1) sample.push(names[i]);
        }
        if (!sample.length) for (var s = 0; s < names.length && s < 8; s++) sample.push(names[s]);
        return fail('Premiere has no video effect named "' + params.effectName + '".', { availableSample: sample });
      }

      var q = activateForQE(seq);
      var qeTrack = qeTrackFor(q.qeSeq, 'video', target.trackIndex);
      var clipStart = secondsOf(target.clip.start);
      var clipEnd = secondsOf(target.clip.end);
      var qeClip = qeClipFor(qeTrack, clipStart, clipEnd, 0.25);
      if (!qeClip) return fail('QE did not expose the clip on ' + target.info.track + '. It may be locked or still loading.');

      var before = componentList(target.clip, false).length;
      try { qeClip.addVideoEffect(effect.object); } catch (e2) {
        return fail('Premiere rejected "' + effect.name + '": ' + (e2.message || e2));
      }
      var after = componentList(target.clip, false);
      var added = after.length > before;
      var comp = findComponent(target.clip, effect.name);
      if (!added && !comp) {
        return fail('Premiere did not register "' + effect.name + '" on the clip. Nothing was changed.');
      }

      var appliedParams = [];
      if (isArray(params.parameters) && comp) {
        var comps;
        try { comps = target.clip.components; } catch (e3) { comps = null; }
        var component = comps ? comps[comp.index] : null;
        for (var p = 0; p < params.parameters.length && p < 12; p++) {
          var spec = params.parameters[p] || {};
          var prop = findProperty(component, spec.name);
          if (!prop) {
            appliedParams.push({ name: String(spec.name || ''), applied: false, error: 'Parameter not found.' });
            continue;
          }
          try {
            prop.param.setValue(spec.value, true);
            var actual = prop.param.getValue();
            appliedParams.push({
              name: prop.displayName,
              requested: spec.value,
              actual: (typeof actual === 'number' || typeof actual === 'string' || typeof actual === 'boolean') ? actual : null,
              applied: true
            });
          } catch (e4) {
            appliedParams.push({ name: String(spec.name || ''), applied: false, error: String(e4.message || e4) });
          }
        }
      }

      return j({
        ok: true,
        result: {
          sequence: String(seq.name || ''),
          clip: target.info,
          effect: effect.name,
          component: comp ? comp.info.displayName : '',
          componentCountBefore: before,
          componentCountAfter: after.length,
          verified: added || !!comp,
          parameters: appliedParams
        }
      });
    } catch (e) { return fail(e.message || e); }
  };

  API.setEffectParameter = function (argsJson) {
    try {
      var params = parseJson(argsJson) || {};
      if (!params.parameterName) return fail('parameterName is required.');
      var seq = writableSequence();
      var target = resolveTarget(seq, params);
      ensureWritable(target);

      var comps;
      try { comps = target.clip.components; } catch (e) { comps = null; }
      if (!comps) return fail('This clip does not expose effect controls.');

      var compIndex = -1;
      if (params.effectName) {
        var found = findComponent(target.clip, params.effectName);
        if (!found) return fail('The clip has no effect named "' + params.effectName + '".', { components: componentList(target.clip, false) });
        compIndex = found.index;
      }

      var prop = null;
      var usedComponent = '';
      for (var i = 0; i < comps.numItems; i++) {
        if (compIndex >= 0 && i !== compIndex) continue;
        var candidate = comps[i];
        var foundProp = findProperty(candidate, params.parameterName);
        if (foundProp) {
          prop = foundProp;
          try { usedComponent = String(candidate.displayName || ''); } catch (e2) { usedComponent = ''; }
          break;
        }
      }
      if (!prop) {
        return fail('No parameter named "' + params.parameterName + '" was found' +
          (params.effectName ? ' on "' + params.effectName + '"' : ' on this clip') + '.', { components: componentList(target.clip, true) });
      }

      var before = null;
      try {
        var oldValue = prop.param.getValue();
        if (typeof oldValue === 'number' || typeof oldValue === 'string' || typeof oldValue === 'boolean') before = oldValue;
      } catch (e3) { before = null; }

      try { prop.param.setValue(params.value, true); } catch (e4) {
        return fail('Premiere rejected the value: ' + (e4.message || e4));
      }
      var after = null;
      try {
        var newValue = prop.param.getValue();
        if (typeof newValue === 'number' || typeof newValue === 'string' || typeof newValue === 'boolean') after = newValue;
      } catch (e5) { after = null; }

      var verified = after !== null;
      if (verified && typeof params.value === 'number' && typeof after === 'number') {
        verified = Math.abs(after - params.value) <= Math.max(0.01, Math.abs(params.value) * 0.01);
      }
      return j({
        ok: verified,
        result: {
          sequence: String(seq.name || ''),
          clip: target.info,
          component: usedComponent,
          parameter: prop.displayName,
          before: before,
          requested: params.value,
          after: after,
          verified: verified
        }
      });
    } catch (e) { return fail(e.message || e); }
  };

  API.setAudioVolume = function (argsJson) {
    try {
      var params = parseJson(argsJson) || {};
      if (!finite(params.db) && !finite(params.deltaDb)) return fail('Provide db or deltaDb.');
      var seq = writableSequence();
      var target = resolveTarget(seq, params);
      if (target.trackType !== 'audio') return fail('Volume can only be set on an audio clip.');
      ensureWritable(target);

      var comps;
      try { comps = target.clip.components; } catch (e) { comps = null; }
      if (!comps) return fail('This audio clip does not expose effect controls.');

      var volumeComp = null;
      var prop = null;
      for (var i = 0; i < comps.numItems; i++) {
        var comp = comps[i];
        var compName = '';
        try { compName = String(comp.displayName || ''); } catch (e2) { compName = ''; }
        if (normalizeEffectName(compName).indexOf('volume') === -1) continue;
        var found = findProperty(comp, 'Level');
        if (!found) found = findProperty(comp, 'Volume');
        if (found) { volumeComp = comp; prop = found; break; }
      }
      if (!prop) {
        return fail('No Volume > Level control was found on this clip.', { components: componentList(target.clip, true) });
      }

      var current = null;
      try {
        var value = prop.param.getValue();
        if (typeof value === 'number' && value > 0) current = 20 * Math.log(value) / Math.LN10;
        else if (value === 0) current = -96;
      } catch (e3) { current = null; }
      if (current === null) return fail('The current volume level could not be read, so it was not changed.');

      var next = finite(params.db) ? params.db : (current + params.deltaDb);
      next = clamp(next, -96, 15);
      var linear = Math.pow(10, next / 20);
      try { prop.param.setValue(linear, true); } catch (e4) {
        return fail('Premiere rejected the volume value: ' + (e4.message || e4));
      }
      var after = null;
      try {
        var got = prop.param.getValue();
        if (typeof got === 'number') after = got > 0 ? 20 * Math.log(got) / Math.LN10 : -96;
      } catch (e5) { after = null; }
      var verified = after !== null && Math.abs(after - next) <= 0.2;

      return j({
        ok: verified,
        result: {
          sequence: String(seq.name || ''),
          clip: target.info,
          component: String(volumeComp.displayName || ''),
          parameter: prop.displayName,
          beforeDb: current,
          requestedDb: next,
          afterDb: after,
          verified: verified
        }
      });
    } catch (e) { return fail(e.message || e); }
  };

  /* ------------------------------------------------------- range removal */

  function participatingTracks(seq, scope, audioTrackIndex) {
    var out = [];
    var i;
    if (scope === 'audio') {
      var index = finite(audioTrackIndex) ? Math.round(audioTrackIndex) : 0;
      var track = trackAt(seq, 'audio', index);
      if (!track) throw new Error('Audio track A' + (index + 1) + ' does not exist.');
      out.push({ type: 'audio', index: index, track: track });
      return out;
    }
    for (i = 0; i < seq.videoTracks.numTracks; i++) out.push({ type: 'video', index: i, track: seq.videoTracks[i] });
    for (i = 0; i < seq.audioTracks.numTracks; i++) out.push({ type: 'audio', index: i, track: seq.audioTracks[i] });
    return out;
  }

  function validateIntervals(intervals, duration) {
    if (!isArray(intervals) || !intervals.length) throw new Error('No time ranges were supplied.');
    var list = [];
    for (var i = 0; i < intervals.length; i++) {
      var raw = intervals[i] || {};
      var start = Number(raw.start);
      var end = Number(raw.end);
      if (!isFinite(start) || !isFinite(end) || end <= start + 0.01) {
        throw new Error('Range ' + (i + 1) + ' is empty or backwards.');
      }
      if (start < -0.01 || (duration > 0 && end > duration + 0.5)) {
        throw new Error('Range ' + (i + 1) + ' is outside the sequence (0–' + round(duration) + 's).');
      }
      list.push({ start: Math.max(0, start), end: end });
    }
    list.sort(function (a, b) { return a.start - b.start; });
    for (var k = 1; k < list.length; k++) {
      if (list[k].start < list[k - 1].end - 0.005) {
        throw new Error('The time ranges overlap. Split them into separate ranges first.');
      }
    }
    return list;
  }

  function removeRangesInternal(seq, intervals, options) {
    var fps = sequenceFps(seq);
    var tolerance = Math.max(0.03, 0.6 / fps);
    var scope = options.scope === 'audio' ? 'audio' : 'sequence';
    var tracks = participatingTracks(seq, scope, options.audioTrackIndex);
    var i, t;

    for (i = 0; i < tracks.length; i++) {
      var locked = trackLocked(tracks[i].track);
      if (locked === true) {
        throw new Error('Track ' + trackLabel(tracks[i].type, tracks[i].index) +
          ' is locked. Unlock it before removing time ranges.');
      }
    }

    var q = activateForQE(seq);
    var durationBefore = sequenceDuration(seq);
    var details = [];
    var completed = 0;
    var totalRemoved = 0;
    var aborted = false;

    for (i = intervals.length - 1; i >= 0; i--) {
      if (aborted) break;
      var start = snapToFrame(intervals[i].start, fps);
      var end = snapToFrame(intervals[i].end, fps);
      var length = end - start;
      if (length <= 0.02) {
        details.push({ start: start, end: end, ok: false, error: 'Range is shorter than one frame.' });
        continue;
      }

      var detail = { start: start, end: end, duration: length, removedClips: 0, shiftedClips: 0, ok: false };
      try {
        if (scope === 'sequence') {
          razorSequence(q.qeSeq, start, fps);
          razorSequence(q.qeSeq, end, fps);
        } else {
          var onlyQe = qeTrackFor(q.qeSeq, 'audio', tracks[0].index);
          razor(onlyQe, start, fps);
          razor(onlyQe, end, fps);
        }

        var spanning = null;
        var failedRemove = false;
        for (t = 0; t < tracks.length; t++) {
          var track = tracks[t].track;
          var clips = clipsOnTrack(track);
          for (var c = clips.length - 1; c >= 0; c--) {
            var clip = clips[c];
            var cs = secondsOf(clip.start);
            var ce = secondsOf(clip.end);
            if (cs === null || ce === null) continue;
            if (cs < start - tolerance && ce > end + tolerance) {
              spanning = {
                name: clipName(clip),
                track: trackLabel(tracks[t].type, tracks[t].index)
              };
              break;
            }
            var inside = cs >= start - tolerance && ce <= end + tolerance &&
              ce > start + tolerance && cs < end - tolerance;
            if (!inside) continue;
            if (removeClip(clip)) {
              detail.removedClips++;
              totalRemoved++;
            } else {
              failedRemove = true;
            }
          }
          if (spanning) break;
        }

        if (spanning) {
          detail.error = 'The razor did not split "' + spanning.name + '" on ' + spanning.track +
            '. Nothing after this range was moved.';
          details.push(detail);
          aborted = true;
          continue;
        }
        if (failedRemove) {
          detail.error = 'Some clips inside the range could not be removed. Nothing after this range was moved.';
          details.push(detail);
          aborted = true;
          continue;
        }

        if (options.ripple !== false) {
          for (t = 0; t < tracks.length; t++) {
            var list = clipsOnTrack(tracks[t].track);
            list.sort(function (a, b) {
              var as = secondsOf(a.start);
              var bs = secondsOf(b.start);
              return (as === null ? 0 : as) - (bs === null ? 0 : bs);
            });
            for (var k = 0; k < list.length; k++) {
              var moving = list[k];
              var ms = secondsOf(moving.start);
              if (ms === null || ms < end - tolerance) continue;
              if (shiftClip(moving, -length)) detail.shiftedClips++;
              else {
                detail.error = 'A clip could not be moved to close the gap. Check the timeline before continuing.';
                aborted = true;
                break;
              }
            }
            if (aborted) break;
          }
          if (aborted) {
            details.push(detail);
            continue;
          }
        }

        detail.ok = true;
        completed++;
        details.push(detail);
      } catch (e) {
        detail.error = String(e.message || e);
        details.push(detail);
        aborted = true;
      }
    }

    var durationAfter = sequenceDuration(seq);
    var expected = durationBefore;
    for (i = 0; i < details.length; i++) {
      if (details[i].ok && options.ripple !== false) expected -= details[i].duration;
    }

    return {
      sequence: String(seq.name || ''),
      scope: scope,
      requestedRanges: intervals.length,
      completedRanges: completed,
      removedClips: totalRemoved,
      durationBefore: durationBefore,
      durationAfter: durationAfter,
      expectedDuration: expected,
      durationVerified: Math.abs(durationAfter - expected) <= Math.max(0.2, intervals.length / fps),
      aborted: aborted,
      details: details
    };
  }

  API.removeRanges = function (argsJson) {
    try {
      var params = parseJson(argsJson) || {};
      var seq = writableSequence();
      var fps = sequenceFps(seq);
      var duration = sequenceDuration(seq);
      var intervals = validateIntervals(params.intervals, duration);
      var result = removeRangesInternal(seq, intervals, {
        scope: params.scope,
        audioTrackIndex: params.audioTrackIndex,
        ripple: params.ripple !== false
      });
      result.verified = result.completedRanges === intervals.length && !result.aborted && result.durationVerified;
      return j({ ok: result.verified, result: result });
    } catch (e) { return fail(e.message || e); }
  };

  /* -------------------------------------------------------------- gaps */

  function mergedSpans(seq, tracks) {
    var spans = [];
    var i, c;
    for (i = 0; i < tracks.length; i++) {
      var track = tracks[i].track;
      for (c = 0; c < track.clips.numItems; c++) {
        var clip = track.clips[c];
        var s = secondsOf(clip.start);
        var e = secondsOf(clip.end);
        if (s !== null && e !== null && e > s) spans.push({ start: s, end: e });
      }
    }
    spans.sort(function (a, b) { return a.start - b.start; });
    var merged = [];
    for (i = 0; i < spans.length; i++) {
      if (!merged.length || spans[i].start > merged[merged.length - 1].end + 0.02) {
        merged.push({ start: spans[i].start, end: spans[i].end });
      } else if (spans[i].end > merged[merged.length - 1].end) {
        merged[merged.length - 1].end = spans[i].end;
      }
    }
    return merged;
  }

  function gapsFromSpans(merged, duration, includeHead, includeTail) {
    var gaps = [];
    var cursor = 0;
    var i;
    for (i = 0; i < merged.length; i++) {
      if (merged[i].start > cursor + 0.05) {
        if (cursor > 0 || includeHead) gaps.push({ start: cursor, end: merged[i].start });
      }
      if (merged[i].end > cursor) cursor = merged[i].end;
    }
    if (includeTail && duration > cursor + 0.05) gaps.push({ start: cursor, end: duration });
    return gaps;
  }

  function gapRanges(seq, params) {
    var duration = sequenceDuration(seq);
    var scope = params.scope === 'track' ? 'track' : 'sequence';
    if (scope === 'sequence') {
      var merged = mergedSpans(seq, allTracks(seq));
      return gapsFromSpans(merged, duration, params.includeHead !== false, false);
    }
    var type = params.trackType === 'audio' ? 'audio' : 'video';
    var index = finite(params.trackIndex) ? Math.round(params.trackIndex) : 0;
    var track = trackAt(seq, type, index);
    if (!track) throw new Error(trackLabel(type, index) + ' does not exist.');
    var one = mergedSpans(seq, [{ type: type, index: index, track: track }]);
    return gapsFromSpans(one, duration, !!params.includeHead, false);
  }

  API.getGaps = function (argsJson) {
    try {
      var params = parseJson(argsJson) || {};
      var seq = activeSequence();
      var ranges = gapRanges(seq, params);
      var out = [];
      for (var i = 0; i < ranges.length && i < 500; i++) {
        out.push({
          start: round(ranges[i].start),
          end: round(ranges[i].end),
          duration: round(ranges[i].end - ranges[i].start)
        });
      }
      return j({
        ok: true,
        result: {
          sequence: String(seq.name || ''),
          scope: params.scope === 'track' ? 'track' : 'sequence',
          gapCount: out.length,
          gaps: out
        }
      });
    } catch (e) { return fail(e.message || e); }
  };

  API.removeGaps = function (argsJson) {
    try {
      var params = parseJson(argsJson) || {};
      var seq = writableSequence();
      var scope = params.scope === 'track' ? 'track' : 'sequence';
      var ranges = gapRanges(seq, params);
      if (!ranges.length) return j({ ok: true, result: { sequence: String(seq.name || ''), gapCount: 0, removed: 0, removedClips: 0 } });

      if (scope === 'sequence') {
        var result = removeRangesInternal(seq, ranges, { scope: 'sequence', ripple: true });
        result.gapCount = ranges.length;
        result.verified = result.completedRanges === ranges.length && !result.aborted && result.durationVerified;
        return j({ ok: result.verified, result: result });
      }

      /* Track-scoped gaps: shift later clips (and their linked partners)
         earlier by the gap length. No clips are razor-cut or removed. */
      var type = params.trackType === 'audio' ? 'audio' : 'video';
      var index = finite(params.trackIndex) ? Math.round(params.trackIndex) : 0;
      var track = trackAt(seq, type, index);
      if (!track) return fail(trackLabel(type, index) + ' does not exist.');
      if (trackLocked(track) === true) return fail(trackLabel(type, index) + ' is locked.');

      var fps = sequenceFps(seq);
      var tolerance = Math.max(0.03, 0.6 / fps);
      var details = [];
      var completed = 0;
      var aborted = false;
      for (var g = ranges.length - 1; g >= 0; g--) {
        if (aborted) break;
        var gap = ranges[g];
        var length = gap.end - gap.start;
        var detail = { start: gap.start, end: gap.end, shiftedClips: 0, ok: false };

        var conflict = overlappingClip(track, gap.start, gap.end, null);
        if (conflict) {
          detail.error = 'The gap contains a clip by the time it is processed; nothing was moved.';
          details.push(detail);
          aborted = true;
          continue;
        }

        var moved = {};
        var list = clipsOnTrack(track);
        list.sort(function (a, b) {
          var as = secondsOf(a.start);
          var bs = secondsOf(b.start);
          return (as === null ? 0 : as) - (bs === null ? 0 : bs);
        });
        for (var c = 0; c < list.length; c++) {
          var clip = list[c];
          var cs = secondsOf(clip.start);
          if (cs === null || cs < gap.end - tolerance) continue;
          if (!shiftClip(clip, -length)) {
            detail.error = 'A clip on ' + trackLabel(type, index) + ' could not be moved.';
            aborted = true;
            break;
          }
          detail.shiftedClips++;
          var cid = '';
          try { cid = String(clip.nodeId || ''); } catch (e) { cid = ''; }
          if (cid) moved[cid] = true;
          var links = null;
          try { links = clip.getLinkedItems(); } catch (e2) { links = null; }
          if (links) {
            for (var l = 0; l < links.numItems; l++) {
              var linkClip = links[l];
              var lid = '';
              try { lid = String(linkClip.nodeId || ''); } catch (e3) { lid = ''; }
              if (!lid || moved[lid]) continue;
              moved[lid] = true;
              if (!shiftClip(linkClip, -length)) {
                detail.error = 'A linked clip could not be moved; sync may be affected.';
                aborted = true;
                break;
              }
              detail.shiftedClips++;
            }
          }
          if (aborted) break;
        }
        if (!aborted) { detail.ok = true; completed++; }
        details.push(detail);
      }

      return j({
        ok: completed === ranges.length && !aborted,
        result: {
          sequence: String(seq.name || ''),
          scope: 'track',
          track: trackLabel(type, index),
          gapCount: ranges.length,
          completedRanges: completed,
          aborted: aborted,
          details: details
        }
      });
    } catch (e) { return fail(e.message || e); }
  };

  /* ------------------------------------------------------------ project */

  API.getUndoState = function () {
    try {
      var q = enableQE();
      var index = null;
      var redo = null;
      try { index = q.project.undoStackIndex(); } catch (e) { index = null; }
      try { redo = q.project.redoStackIndex ? q.project.redoStackIndex() : null; } catch (e2) { redo = null; }
      return j({ ok: true, result: { index: index, redo: redo } });
    } catch (e) { return fail(e.message || e); }
  };

  API.undoSteps = function (argsJson) {
    try {
      var params = parseJson(argsJson) || {};
      var count = finite(params.count) ? Math.round(params.count) : 1;
      if (count < 1 || count > 20) return fail('count must be between 1 and 20.');
      var q = enableQE();
      var before = null;
      try { before = q.project.undoStackIndex(); } catch (e) { before = null; }
      var done = 0;
      for (var i = 0; i < count; i++) {
        try { q.project.undo(); done++; } catch (e2) { break; }
      }
      var after = null;
      try { after = q.project.undoStackIndex(); } catch (e3) { after = null; }
      return j({
        ok: done > 0,
        result: { requested: count, undone: done, undoIndexBefore: before, undoIndexAfter: after }
      });
    } catch (e) { return fail(e.message || e); }
  };

  API.saveProject = function () {
    try {
      var path = '';
      try { path = String(app.project.path || ''); } catch (e) { path = ''; }
      if (!path) return fail('This project has never been saved. Use File > Save As in Premiere first.');
      app.project.save();
      return j({ ok: true, result: { path: path } });
    } catch (e) { return fail(e.message || e); }
  };

  /* ----------------------------------------------------------- dispatch */

  API.dispatch = function (argsJson) {
    var req = parseJson(argsJson);
    if (!req || !req.name) return fail('No action name was supplied.');
    var name = String(req.name);
    if (name === 'dispatch' || name === 'constructor' || !API[name] || typeof API[name] !== 'function') {
      return fail('Unknown action: ' + name);
    }
    var params = req.params || {};
    return API[name](JSON.stringify(params));
  };

  return API;
})();

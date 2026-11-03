/*
 * premiereContext.js — reads the smallest useful snapshot of the live project.
 *
 * The planner only sees what this file produces: project/sequence identity,
 * frame rate, duration, playhead, track state, and the clips (with nodeId) that
 * an action can target. It never guesses at the rest of the project.
 */
var PremiereContext = (function () {
  'use strict';

  var MAX_CLIPS_IN_TEXT = 100;
  var MAX_SELECTED_IN_TEXT = 20;

  function read(options) {
    options = options || {};
    return Premiere.ensureHost().then(function (hostOk) {
      if (!hostOk) {
        throw new Error('The Premiere bridge did not load. Restart Premiere Pro, then reopen the panel.');
      }
      return Premiere.action('getContext', {
        includeClips: options.includeClips !== false,
        includeEffects: options.includeEffects === true
      });
    }).then(function (res) {
      if (!res || !res.ok) {
        throw new Error((res && res.error) || 'Premiere did not return the active sequence.');
      }
      return res.context;
    });
  }

  function selectedDetail() {
    return Premiere.ensureHost().then(function (hostOk) {
      if (!hostOk) throw new Error('The Premiere bridge did not load.');
      return Premiere.action('getSelectedClips', {});
    }).then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.error) || 'Premiere did not return the selection.');
      return res;
    });
  }

  function num(value, digits) {
    if (typeof value !== 'number' || !isFinite(value)) return '?';
    return value.toFixed(digits === undefined ? 2 : digits);
  }

  function trackFlags(track) {
    var flags = [];
    if (track.locked === true) flags.push('locked');
    if (track.muted === true) flags.push('muted');
    return flags.length ? ' (' + flags.join(', ') + ')' : '';
  }

  function clipLine(clip, markSelected) {
    var where = '[' + (clip.track || '?') + ']';
    var times = num(clip.start) + '–' + num(clip.end) + 's';
    var kind = clip.isAdjustmentLayer ? ' adjustment-layer' : '';
    var sel = markSelected && clip.selected ? ' *selected*' : '';
    var id = clip.nodeId ? ' nodeId=' + clip.nodeId : '';
    return '- ' + where + ' "' + (clip.name || '(unnamed)') + '" ' + times + kind + sel + id;
  }

  /**
   * Formats the context for a model prompt. Plain text with stable field names
   * is more portable across seven providers than a large JSON blob, and it
   * keeps the token cost predictable.
   */
  function format(context) {
    if (!context || !context.sequence) return 'No active sequence.';

    var lines = [];
    var seq = context.sequence;

    lines.push('Project: ' + (context.project || '(unsaved project)'));
    lines.push('Active sequence: "' + (seq.name || '(unnamed)') + '"');
    lines.push('Duration: ' + num(seq.duration) + 's · Frame rate: ' + num(seq.fps, 3) + ' fps' +
      (seq.frameWidth && seq.frameHeight ? ' · ' + seq.frameWidth + 'x' + seq.frameHeight : ''));
    lines.push('Playhead: ' + (seq.playhead === null || seq.playhead === undefined ? 'unavailable' : num(seq.playhead) + 's'));

    var v = [];
    var a = [];
    var i;
    for (i = 0; i < (context.videoTracks || []).length; i++) {
      var vt = context.videoTracks[i];
      v.push('V' + (vt.index + 1) + ' (' + vt.clipCount + ' clips' + trackFlags(vt) + ')');
    }
    for (i = 0; i < (context.audioTracks || []).length; i++) {
      var at = context.audioTracks[i];
      a.push('A' + (at.index + 1) + ' (' + at.clipCount + ' clips' + trackFlags(at) + ')');
    }
    lines.push('Video tracks: ' + (v.join(', ') || 'none'));
    lines.push('Audio tracks: ' + (a.join(', ') || 'none'));

    var selected = context.selectedClips || [];
    lines.push('');
    lines.push('Selected clips: ' + (selected.length ? selected.length : 'none'));
    for (i = 0; i < selected.length && i < MAX_SELECTED_IN_TEXT; i++) {
      lines.push(clipLine(selected[i], false));
    }
    if (selected.length > MAX_SELECTED_IN_TEXT) {
      lines.push('- … ' + (selected.length - MAX_SELECTED_IN_TEXT) + ' more selected clips');
    }

    var clips = context.clips || [];
    lines.push('');
    lines.push('Timeline clips: ' + clips.length);
    for (i = 0; i < clips.length && i < MAX_CLIPS_IN_TEXT; i++) {
      lines.push(clipLine(clips[i], true));
    }
    if (clips.length > MAX_CLIPS_IN_TEXT) {
      lines.push('- … ' + (clips.length - MAX_CLIPS_IN_TEXT) + ' more clips (ask the user to select one)');
    }

    if (context.effects && context.effects.length) {
      lines.push('');
      lines.push('Installed video effects (sample): ' + context.effects.slice(0, 60).join(', '));
    }

    if (context.warnings && context.warnings.length) {
      lines.push('');
      lines.push('Warnings:');
      for (i = 0; i < context.warnings.length; i++) lines.push('- ' + context.warnings[i]);
    }

    return lines.join('\n');
  }

  function sequenceLabel(context) {
    return (context && context.sequence && context.sequence.name) ? context.sequence.name : 'the active sequence';
  }

  function needsEffectList(text) {
    return /\b(effect|effects|blur|sharpen|lumetri|brightness|contrast|saturation|glow|colour|color)\b/i.test(String(text || ''));
  }

  return {
    read: read,
    selectedDetail: selectedDetail,
    format: format,
    sequenceLabel: sequenceLabel,
    needsEffectList: needsEffectList,
    maxClips: MAX_CLIPS_IN_TEXT
  };
})();

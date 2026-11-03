/*
 * actionRegistry.js — the complete set of editing actions openCaption will run.
 *
 * This list is the allowlist. The planner can only name an action that appears
 * here, and the validator rejects any parameter that is not declared in the
 * action's schema. Nothing in this file executes anything; handlers live in
 * actions.jsx (Premiere) or silenceDetector.js (FFmpeg analysis).
 */
var ActionRegistry = (function () {
  'use strict';

  var ACTIONS = {
    get_active_sequence: {
      label: 'Read active sequence',
      host: 'getContext',
      kind: 'read',
      destructive: false,
      description: 'Project name, active sequence, frame rate, duration, playhead, tracks and selected clips.',
      params: {},
      call: function (params) { return { includeClips: false, includeEffects: false }; }
    },

    get_selected_clips: {
      label: 'Read selected clips',
      host: 'getSelectedClips',
      kind: 'read',
      destructive: false,
      description: 'Full details of every clip selected in the Timeline, including effect controls.',
      params: {}
    },

    get_timeline_context: {
      label: 'Read timeline',
      host: 'getContext',
      kind: 'read',
      destructive: false,
      description: 'All clips on every track, optionally with the installed video effects list.',
      params: {
        includeClips: { type: 'boolean' },
        includeEffects: { type: 'boolean' }
      },
      call: function (params) {
        return {
          includeClips: params.includeClips !== false,
          includeEffects: params.includeEffects === true
        };
      }
    },

    split_clip: {
      label: 'Split clip',
      host: 'splitClip',
      kind: 'edit',
      destructive: false,
      description: 'Split one clip at a time. Target the selected clip, or pass a nodeId; defaults to the playhead.',
      params: {
        nodeId: { type: 'string', max: 200 },
        atSeconds: { type: 'number', min: 0, max: 86400 }
      },
      summary: function (p) {
        return 'Split ' + (p.nodeId ? 'clip ' + shortId(p.nodeId) : 'the selected clip') +
          ' at ' + timeText(p.atSeconds === undefined ? 'the playhead' : p.atSeconds) + '.';
      }
    },

    move_clip: {
      label: 'Move clip',
      host: 'moveClip',
      kind: 'edit',
      destructive: false,
      description: 'Move one clip to an absolute start time on its own track. Linked audio/video moves with it.',
      params: {
        nodeId: { type: 'string', max: 200 },
        startSeconds: { type: 'number', min: 0, max: 86400, required: true }
      },
      summary: function (p) {
        return 'Move ' + (p.nodeId ? 'clip ' + shortId(p.nodeId) : 'the selected clip') +
          ' to ' + timeText(p.startSeconds) + '.';
      }
    },

    delete_clip: {
      label: 'Delete clip',
      host: 'deleteClip',
      kind: 'edit',
      destructive: true,
      description: 'Delete one clip by nodeId. With no nodeId, deletes every selected clip.',
      params: {
        nodeId: { type: 'string', max: 200 }
      },
      summary: function (p) {
        return p.nodeId ? 'Delete clip ' + shortId(p.nodeId) + '.' : 'Delete every selected clip.';
      }
    },

    duplicate_clip: {
      label: 'Duplicate clip',
      host: 'duplicateClip',
      kind: 'edit',
      destructive: false,
      description: 'Insert a second copy of the clip on the same track, by default immediately after it.',
      params: {
        nodeId: { type: 'string', max: 200 },
        startSeconds: { type: 'number', min: 0, max: 86400 }
      },
      summary: function (p) {
        return 'Duplicate ' + (p.nodeId ? 'clip ' + shortId(p.nodeId) : 'the selected clip') +
          (p.startSeconds === undefined ? ' after itself.' : ' at ' + timeText(p.startSeconds) + '.');
      }
    },

    add_adjustment_layer: {
      label: 'Add adjustment layer',
      host: 'addAdjustmentLayer',
      kind: 'edit',
      destructive: false,
      description: 'Create a real adjustment layer project item and place it on a free video track. ' +
        'Use align "selection" to cover the selected clips, or give startSeconds/durationSeconds.',
      params: {
        align: { type: 'string', enum: ['sequence', 'selection'] },
        startSeconds: { type: 'number', min: 0, max: 86400 },
        durationSeconds: { type: 'number', min: 0.1, max: 86400 },
        trackIndex: { type: 'integer', min: 0, max: 63 }
      },
      summary: function (p) {
        var where = p.startSeconds === undefined
          ? (p.align === 'selection' ? 'over the selected clips' : 'over the whole sequence')
          : 'at ' + timeText(p.startSeconds);
        var long = p.durationSeconds === undefined ? '' : ' for ' + timeText(p.durationSeconds);
        return 'Add an adjustment layer ' + where + long + '.';
      }
    },

    apply_effect: {
      label: 'Apply effect',
      host: 'applyEffect',
      kind: 'edit',
      destructive: false,
      description: 'Add a real Premiere video effect to one video clip. Effect names must exist in Premiere. ' +
        'Optionally set parameters by their displayed names.',
      params: {
        nodeId: { type: 'string', max: 200 },
        effectName: { type: 'string', max: 120, required: true },
        parameters: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'object',
            fields: {
              name: { type: 'string', max: 120, required: true },
              value: { type: 'scalar', required: true }
            }
          }
        }
      },
      summary: function (p) {
        return 'Apply "' + p.effectName + '" to ' +
          (p.nodeId ? 'clip ' + shortId(p.nodeId) : 'the selected clip') + '.' +
          (p.parameters && p.parameters.length ? ' Set ' + p.parameters.length + ' parameter(s).' : '');
      }
    },

    set_effect_parameter: {
      label: 'Set effect parameter',
      host: 'setEffectParameter',
      kind: 'edit',
      destructive: false,
      description: 'Change one parameter on an effect that is already on a clip.',
      params: {
        nodeId: { type: 'string', max: 200 },
        effectName: { type: 'string', max: 120 },
        parameterName: { type: 'string', max: 120, required: true },
        value: { type: 'scalar', required: true }
      },
      summary: function (p) {
        return 'Set "' + p.parameterName + '" to ' + String(p.value) + ' on ' +
          (p.nodeId ? 'clip ' + shortId(p.nodeId) : 'the selected clip') + '.';
      }
    },

    set_audio_volume: {
      label: 'Set audio volume',
      host: 'setAudioVolume',
      kind: 'edit',
      destructive: false,
      description: 'Set an audio clip\'s Volume > Level in dB, or change it by deltaDb. Give exactly one.',
      params: {
        nodeId: { type: 'string', max: 200 },
        db: { type: 'number', min: -96, max: 15 },
        deltaDb: { type: 'number', min: -111, max: 111 }
      },
      summary: function (p) {
        var change = (p.deltaDb !== undefined)
          ? (p.deltaDb >= 0 ? '+' : '') + p.deltaDb + ' dB'
          : (p.db !== undefined ? p.db + ' dB' : '');
        return 'Set the volume of ' + (p.nodeId ? 'clip ' + shortId(p.nodeId) : 'the selected audio clip') +
          ' to ' + change + '.';
      }
    },

    detect_silence: {
      label: 'Detect silence',
      js: true,
      kind: 'read',
      destructive: false,
      description: 'Measure the real sequence audio with FFmpeg and list silent ranges. ' +
        'This only reads; it never changes the timeline.',
      params: silenceParams(false),
      summary: function (p) {
        return 'Detect silent ranges longer than ' + numberText(p.minSilenceSeconds, 0.5) + 's' +
          ' below ' + numberText(p.thresholdDb, -35) + ' dB.';
      }
    },

    remove_silence: {
      label: 'Remove silence',
      js: true,
      kind: 'edit',
      destructive: true,
      description: 'Measure the real sequence audio, then ripple-delete every silent range. ' +
        'By default all tracks are cut together so audio and video stay in sync.',
      params: silenceParams(true),
      summary: function (p) {
        return 'Remove silent ranges longer than ' + numberText(p.minSilenceSeconds, 0.5) + 's' +
          ' below ' + numberText(p.thresholdDb, -35) + ' dB' +
          (p.scope === 'audio' ? ' from audio track A' + ((p.audioTrackIndex || 0) + 1) : ', all tracks');
      }
    },

    remove_timeline_gaps: {
      label: 'Remove timeline gaps',
      host: 'removeGaps',
      kind: 'edit',
      destructive: true,
      description: 'Close empty gaps across all tracks, or on one named track.',
      params: {
        scope: { type: 'string', enum: ['sequence', 'track'] },
        trackType: { type: 'string', enum: ['video', 'audio'] },
        trackIndex: { type: 'integer', min: 0, max: 63 },
        includeHead: { type: 'boolean' }
      },
      summary: function (p) {
        if (p.scope === 'track') {
          return 'Close gaps on ' + (p.trackType === 'audio' ? 'A' : 'V') + ((p.trackIndex || 0) + 1) + '.';
        }
        return 'Close every empty gap across the sequence.';
      }
    }
  };

  function silenceParams(allowRipple) {
    var params = {
      thresholdDb: { type: 'number', min: -80, max: -5 },
      minSilenceSeconds: { type: 'number', min: 0.1, max: 60 },
      paddingSeconds: { type: 'number', min: 0, max: 2 },
      minSpeechSeconds: { type: 'number', min: 0, max: 2 },
      includeLeading: { type: 'boolean' },
      includeTrailing: { type: 'boolean' }
    };
    if (allowRipple) {
      params.ripple = { type: 'boolean' };
      params.scope = { type: 'string', enum: ['sequence', 'audio'] };
      params.audioTrackIndex = { type: 'integer', min: 0, max: 63 };
    }
    return params;
  }

  function timeText(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'number' || !isFinite(value)) return String(value);
    var s = Math.max(0, value);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    var body = (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec.toFixed(2);
    return h ? h + ':' + body : body;
  }

  function shortId(value) {
    var text = String(value || '');
    return text.length > 14 ? text.slice(0, 12) + '…' : text;
  }

  function numberText(value, fallback) {
    var n = (typeof value === 'number' && isFinite(value)) ? value : fallback;
    return String(n);
  }

  function get(name) {
    return ACTIONS.hasOwnProperty(name) ? ACTIONS[name] : null;
  }

  function ids() {
    var out = [];
    for (var key in ACTIONS) {
      if (ACTIONS.hasOwnProperty(key)) out.push(key);
    }
    return out;
  }

  function all() {
    return ids().map(function (id) {
      var def = ACTIONS[id];
      return {
        id: id,
        label: def.label,
        kind: def.kind,
        destructive: !!def.destructive,
        description: def.description
      };
    });
  }

  /* The catalog is generated from the same objects the validator uses, so the
     model can never be told about an action the panel would reject. */
  function catalogText() {
    return ids().map(function (id) {
      var def = ACTIONS[id];
      var shape = {};
      for (var key in def.params) {
        if (!def.params.hasOwnProperty(key)) continue;
        var p = def.params[key];
        var text;
        if (p.type === 'array') {
          text = '<array of {name:string,value:number|string|boolean}>';
        } else if (p.type === 'object') {
          text = '<object>';
        } else if (p.type === 'scalar') {
          text = 'string|number|boolean';
        } else {
          text = p.enum ? '<' + p.enum.join('|') + '>' : p.type;
        }
        shape[key] = text + (p.required ? '' : '?');
      }
      return '- ' + id + ' ' + JSON.stringify(shape) + ' — ' + def.description;
    }).join('\n');
  }

  return {
    get: get,
    ids: ids,
    all: all,
    catalogText: catalogText,
    timeText: timeText
  };
})();

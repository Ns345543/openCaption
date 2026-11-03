/*
 * actionExecutor.js — runs a validated plan, one step at a time.
 *
 * Safety rules enforced here:
 *   - only registered actions are dispatched,
 *   - the first failed step stops the plan,
 *   - a destructive step is never retried automatically,
 *   - results come from Premiere's read-back, never from assumptions,
 *   - execution can be cancelled between steps and between audio chunks.
 */
var ActionExecutor = (function () {
  'use strict';

  function delay() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  function cancelledError() {
    var e = new Error('Cancelled by user.');
    e.cancelled = true;
    return e;
  }

  function timeText(value) {
    return ActionRegistry.timeText(value);
  }

  function replyResult(reply) {
    if (!reply || typeof reply !== 'object') {
      return { ok: false, error: 'Premiere returned no usable reply.', result: null };
    }
    return {
      ok: !!reply.ok,
      error: reply.ok ? '' : String(reply.error || 'Premiere reported that the action did not complete.'),
      result: reply.result || null,
      extra: reply.ok ? null : reply
    };
  }

  function preflight(step) {
    if (step.action !== 'add_adjustment_layer') return Promise.resolve(null);
    var params = step.params || {};
    if (params.align !== 'selection') return Promise.resolve(null);
    if (typeof params.startSeconds === 'number') return Promise.resolve(null);

    return Premiere.action('getSelectedClips', {}).then(function (reply) {
      if (!reply || !reply.ok) return null;
      if (!reply.selected || !reply.selected.length) {
        throw new Error('No clips are selected in the Timeline, so there is no selection to cover. ' +
          'Select the clips, or ask for a start time and duration.');
      }
      return null;
    });
  }

  function runStep(step, options) {
    var def = ActionRegistry.get(step.action);
    if (!def) {
      return Promise.reject(new Error('Unknown action: ' + step.action));
    }

    var token = options.token || { cancelled: false };

    if (step.action === 'detect_silence') {
      return SilenceDetector.detect(step.params, {
        token: token,
        onProgress: options.onAnalysis
      }).then(function (detection) {
        return { ok: true, error: '', result: detection };
      });
    }

    if (step.action === 'remove_silence') {
      return SilenceDetector.remove(step.params, {
        token: token,
        onProgress: options.onAnalysis
      }).then(function (out) {
        return {
          ok: !!out.ok,
          error: String(out.error || ''),
          result: {
            nothingToDo: !!out.nothingToDo,
            detection: out.detection || null,
            removal: out.removal || null
          }
        };
      });
    }

    return preflight(step).then(function () {
      var params = def.call ? def.call(step.params) : step.params;
      return Premiere.action(def.host, params || {});
    }).then(replyResult);
  }

  /**
   * plan: { title, summary, steps:[{action, params}] }
   * options: { token, onProgress(index, state, record), onAnalysis(fraction, done, total) }
   */
  function execute(plan, options) {
    options = options || {};
    var token = options.token || { cancelled: false };
    var results = [];
    var cancelled = false;

    if (typeof ActionValidator === 'undefined' || !ActionValidator.validatePlan) {
      return Promise.reject(new Error('The action validator did not load, so nothing was run.'));
    }
    var checked = ActionValidator.validatePlan(plan);
    if (!checked.ok || !checked.plan) {
      return Promise.reject(new Error('This plan did not pass validation, so nothing was run: ' +
        checked.errors.join('; ')));
    }
    plan = checked.plan;

    function report(index, state, record) {
      if (options.onProgress) {
        try { options.onProgress(index, state, record || null); } catch (e) { /* UI must not break execution */ }
      }
    }

    return Premiere.ensureHost().then(function (hostOk) {
      if (!hostOk) throw new Error('The Premiere bridge did not load. Restart Premiere Pro, then reopen the panel.');

      var chain = Promise.resolve();
      var stopped = false;

      plan.steps.forEach(function (step, index) {
        chain = chain.then(function () {
          if (stopped) return;
          if (token.cancelled) {
            cancelled = true;
            stopped = true;
            return;
          }

          report(index, 'running');
          var startedAt = Date.now();
          return runStep(step, options).then(function (out) {
            var record = {
              index: index,
              action: step.action,
              label: (ActionRegistry.get(step.action) || {}).label || step.action,
              ok: !!out.ok,
              error: out.error || '',
              result: out.result || null,
              startedAt: startedAt,
              finishedAt: Date.now()
            };
            results.push(record);
            report(index, record.ok ? 'done' : 'failed', record);
            if (!record.ok) stopped = true;
            return delay();
          }, function (err) {
            var record = {
              index: index,
              action: step.action,
              label: (ActionRegistry.get(step.action) || {}).label || step.action,
              ok: false,
              error: String((err && err.message) || err),
              cancelled: !!(err && err.cancelled),
              result: null,
              startedAt: startedAt,
              finishedAt: Date.now()
            };
            results.push(record);
            if (record.cancelled) cancelled = true;
            report(index, record.cancelled ? 'cancelled' : 'failed', record);
            stopped = true;
          });
        });
      });

      return chain.then(function () {
        var stoppedAt = -1;
        for (var i = 0; i < results.length; i++) {
          if (!results[i].ok) { stoppedAt = results[i].index; break; }
        }
        var allRan = results.length === plan.steps.length;
        var allOk = allRan && results.every(function (r) { return r.ok; });
        return {
          ok: allOk && !cancelled,
          cancelled: cancelled,
          stoppedAtIndex: stoppedAt,
          results: results,
          summary: summarize({
            ok: allOk && !cancelled,
            cancelled: cancelled,
            stoppedAtIndex: stoppedAt,
            results: results,
            plan: plan
          })
        };
      });
    });
  }

  function fmt(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '?';
    return value.toFixed(2);
  }

  function clipName(record) {
    var r = record.result || {};
    if (r.clip && r.clip.name) return '"' + r.clip.name + '"';
    if (r.source && r.source.name) return '"' + r.source.name + '"';
    if (r.newClip && r.newClip.name) return '"' + r.newClip.name + '"';
    return 'the clip';
  }

  function describe(record) {
    var r = record.result || {};
    switch (record.action) {
      case 'get_active_sequence':
        return 'Read "' + ((r.sequence && r.sequence.name) || 'the active sequence') + '".';
      case 'get_selected_clips':
        return 'Read ' + ((r.selected && r.selected.length) || 0) + ' selected clip(s).';
      case 'get_timeline_context':
        return 'Read the timeline (' + ((r.clips && r.clips.length) || 0) + ' clips).';

      case 'split_clip':
        return 'Split ' + clipName(record) + ' at ' + fmt(r.atSeconds) + 's.';

      case 'move_clip':
        return 'Moved ' + clipName(record) + ' from ' + fmt(r.fromSeconds) + 's to ' + fmt(r.actualStart) + 's.';

      case 'delete_clip':
        return 'Deleted ' + (typeof r.removed === 'number' ? r.removed : 0) + ' of ' +
          (typeof r.requested === 'number' ? r.requested : 1) + ' clip(s).';

      case 'duplicate_clip':
        return 'Inserted a copy of ' + clipName(record) + ' at ' + fmt(r.atSeconds) + 's.';

      case 'add_adjustment_layer':
        return 'Added an adjustment layer on ' + (r.track || 'a video track') +
          ' from ' + fmt(r.start) + 's to ' + fmt(r.end) + 's (' + fmt(r.duration) + 's).';

      case 'apply_effect':
        return 'Applied "' + (r.effect || 'the effect') + '" to ' + clipName(record) + '.';

      case 'set_effect_parameter':
        return 'Set "' + (r.parameter || 'the parameter') + '" to ' + String(r.after) + '.';

      case 'set_audio_volume':
        return 'Set volume to ' + String(r.afterDb) + ' dB (was ' + String(r.beforeDb) + ' dB).';

      case 'detect_silence':
        return 'Found ' + (r.silenceCount || 0) + ' silent range(s), ' +
          fmt(r.totalSilenceSeconds) + 's in total.';

      case 'remove_silence':
        if (r.nothingToDo) return 'No silent ranges matched, so nothing was removed.';
        if (r.removal) {
          return 'Removed ' + (r.removal.completedRanges || 0) + ' of ' +
            (r.removal.requestedRanges || 0) + ' silent range(s). Sequence length: ' +
            fmt(r.removal.durationBefore) + 's → ' + fmt(r.removal.durationAfter) + 's.';
        }
        return 'Silence removal returned no details.';

      case 'remove_timeline_gaps':
        return 'Closed ' + (r.completedRanges || 0) + ' of ' + (r.gapCount || 0) + ' gap(s).';

      default:
        return 'Completed ' + record.action + '.';
    }
  }

  function summarize(out) {
    var lines = [];
    var results = out.results || [];
    var total = out.plan && out.plan.steps ? out.plan.steps.length : results.length;

    if (out.cancelled) {
      lines.push('**Stopped.** The remaining steps were not run.');
    } else if (out.ok) {
      lines.push('**Done.** ' + results.length + ' of ' + total + ' step(s) completed.');
    } else {
      lines.push('**Stopped after a failure.** ' + results.length + ' of ' + total + ' step(s) ran.');
    }

    for (var i = 0; i < results.length; i++) {
      var record = results[i];
      if (record.ok) {
        lines.push('- ' + describe(record));
      } else {
        lines.push('- Step ' + (record.index + 1) + ' (' + record.label + ') **failed**: ' + record.error);
      }
    }

    var failed = results.filter(function (r) { return !r.ok; });
    if (failed.length && results.length > failed.length) {
      lines.push('');
      lines.push('Earlier steps stay applied. Premiere\'s undo history is limited and may not reverse ' +
        'every step in one action, so check the timeline before retrying.');
    }
    if (out.cancelled) {
      lines.push('');
      lines.push('No further steps were started after the stop request.');
    }

    return lines.join('\n');
  }

  return {
    execute: execute,
    summarize: summarize,
    describeStep: describe
  };
})();

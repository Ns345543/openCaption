/*
 * actionValidator.js — strict validation for AI-produced action plans.
 *
 * Nothing from a model reaches Premiere until it passes this file:
 *   - the plan must contain 1–8 steps,
 *   - every step must name a registered action,
 *   - every parameter must be declared for that action and have the right type,
 *   - unknown actions and unknown parameters are errors, not ignored.
 *
 * The validator only inspects data. It never calls Premiere.
 */
var ActionValidator = (function () {
  'use strict';

  var MAX_STEPS = 8;
  var MAX_TEXT = 4000;
  var MAX_TOKEN = 200;

  function own(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function typeError(path, expected, value) {
    var got = Array.isArray(value) ? 'array' : (value === null ? 'null' : typeof value);
    return path + ' must be ' + expected + ' (got ' + got + ')';
  }

  function checkScalar(value) {
    return typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean';
  }

  function checkValue(path, value, schema, errors) {
    if (schema.type === 'number') {
      if (typeof value !== 'number' || !isFinite(value)) {
        errors.push(typeError(path, 'a finite number', value));
        return;
      }
      if (schema.min !== undefined && value < schema.min) {
        errors.push(path + ' must be at least ' + schema.min + ' (got ' + value + ')');
      }
      if (schema.max !== undefined && value > schema.max) {
        errors.push(path + ' must be at most ' + schema.max + ' (got ' + value + ')');
      }
      return;
    }

    if (schema.type === 'integer') {
      if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value) {
        errors.push(typeError(path, 'an integer', value));
        return;
      }
      if (schema.min !== undefined && value < schema.min) {
        errors.push(path + ' must be at least ' + schema.min + ' (got ' + value + ')');
      }
      if (schema.max !== undefined && value > schema.max) {
        errors.push(path + ' must be at most ' + schema.max + ' (got ' + value + ')');
      }
      return;
    }

    if (schema.type === 'boolean') {
      if (typeof value !== 'boolean') errors.push(typeError(path, 'true or false', value));
      return;
    }

    if (schema.type === 'string') {
      if (typeof value !== 'string') {
        errors.push(typeError(path, 'a string', value));
        return;
      }
      if (value.length > (schema.max || MAX_TEXT)) {
        errors.push(path + ' is longer than ' + (schema.max || MAX_TEXT) + ' characters');
      }
      if (schema.enum && schema.enum.indexOf(value) === -1) {
        errors.push(path + ' must be one of: ' + schema.enum.join(', '));
      }
      return;
    }

    if (schema.type === 'scalar') {
      if (!checkScalar(value)) errors.push(typeError(path, 'a string, number or boolean', value));
      return;
    }

    if (schema.type === 'array') {
      if (!Array.isArray(value)) {
        errors.push(typeError(path, 'an array', value));
        return;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(path + ' has more than ' + schema.maxItems + ' items');
      }
      if (schema.items) {
        for (var i = 0; i < value.length; i++) {
          checkValue(path + '[' + i + ']', value[i], schema.items, errors);
        }
      }
      return;
    }

    if (schema.type === 'object') {
      if (!isPlainObject(value)) {
        errors.push(typeError(path, 'an object', value));
        return;
      }
      var fields = schema.fields || {};
      for (var key in value) {
        if (!own(value, key)) continue;
        if (!own(fields, key)) {
          errors.push(path + ' contains unexpected field "' + key + '"');
        }
      }
      for (var f in fields) {
        if (!own(fields, f)) continue;
        var fieldSchema = fields[f];
        if (!own(value, f) || value[f] === undefined || value[f] === null) {
          if (fieldSchema.required) errors.push(path + '.' + f + ' is required');
          continue;
        }
        checkValue(path + '.' + f, value[f], fieldSchema, errors);
      }
      return;
    }

    errors.push(path + ' uses an unknown schema type');
  }

  function validateParams(name, params, path, errors, warnings) {
    var def = ActionRegistry.get(name);
    if (!def) {
      errors.push(path + ': unknown action "' + name + '"');
      return;
    }

    var value = params === undefined ? {} : params;
    if (!isPlainObject(value)) {
      errors.push(typeError(path, 'an object', value));
      return;
    }

    var declared = def.params || {};
    for (var key in value) {
      if (!own(value, key)) continue;
      if (!own(declared, key)) {
        errors.push(path + ': "' + key + '" is not a parameter of ' + name);
      }
    }

    for (var nameKey in declared) {
      if (!own(declared, nameKey)) continue;
      var schema = declared[nameKey];
      var v = value[nameKey];
      if (v === undefined || v === null) {
        if (schema.required) errors.push(path + '.' + nameKey + ' is required');
        continue;
      }
      checkValue(path + '.' + nameKey, v, schema, errors);
    }

    /* Cross-field rules the per-parameter schema cannot express. */
    if (name === 'set_audio_volume') {
      var hasDb = value.db !== undefined && value.db !== null;
      var hasDelta = value.deltaDb !== undefined && value.deltaDb !== null;
      if (hasDb === hasDelta) {
        errors.push(path + ': give exactly one of db or deltaDb');
      }
    }

    if (name === 'delete_clip' && (value.nodeId === undefined || value.nodeId === '')) {
      warnings.push('Delete will act on every selected clip.');
    }

    if (name === 'remove_silence' && value.scope === 'audio' && value.audioTrackIndex === undefined) {
      warnings.push('Audio-only silence removal will use audio track A1.');
    }

    if (name === 'apply_effect' && value.parameters) {
      for (var p = 0; p < value.parameters.length; p++) {
        var spec = value.parameters[p];
        if (spec && typeof spec.value === 'string' && spec.value.length > 200) {
          warnings.push(path + '.parameters[' + p + '].value is unusually long.');
        }
      }
    }
  }

  function sanitizeStep(raw, index, errors, warnings) {
    if (!isPlainObject(raw)) {
      errors.push('steps[' + index + '] must be an object');
      return null;
    }

    var allowed = { action: true, params: true, reason: true, label: true };
    for (var key in raw) {
      if (!own(raw, key)) continue;
      if (!allowed[key]) errors.push('steps[' + index + '] contains unexpected field "' + key + '"');
    }

    var action = raw.action;
    if (typeof action !== 'string' || !action) {
      errors.push('steps[' + index + '].action must be a non-empty string');
      return null;
    }

    var path = 'steps[' + index + '] (' + action + ')';
    var params = raw.params === undefined ? {} : raw.params;
    validateParams(action, params, path, errors, warnings);

    var reason = '';
    if (raw.reason !== undefined) {
      if (typeof raw.reason !== 'string') errors.push('steps[' + index + '].reason must be a string');
      else reason = raw.reason.slice(0, 500);
    }

    var label = '';
    if (raw.label !== undefined) {
      if (typeof raw.label !== 'string') errors.push('steps[' + index + '].label must be a string');
      else label = raw.label.slice(0, 120);
    }

    return { action: action, params: params, reason: reason, label: label };
  }

  function validatePlan(raw) {
    var errors = [];
    var warnings = [];

    if (!isPlainObject(raw)) {
      return { ok: false, errors: ['The plan must be a JSON object'], warnings: warnings, plan: null };
    }
    if (raw.kind !== undefined && raw.kind !== 'plan') {
      errors.push('kind must be "plan" for an action plan');
    }

    var title = '';
    if (raw.title !== undefined) {
      if (typeof raw.title !== 'string') errors.push('title must be a string');
      else title = raw.title.slice(0, 120);
    }

    var summary = '';
    if (raw.summary !== undefined) {
      if (typeof raw.summary !== 'string') errors.push('summary must be a string');
      else summary = raw.summary.slice(0, MAX_TEXT);
    }

    if (!Array.isArray(raw.steps) || !raw.steps.length) {
      errors.push('steps must be a non-empty array');
      return { ok: false, errors: errors, warnings: warnings, plan: null };
    }
    if (raw.steps.length > MAX_STEPS) {
      errors.push('A plan may contain at most ' + MAX_STEPS + ' steps (got ' + raw.steps.length + ')');
    }

    var steps = [];
    for (var i = 0; i < raw.steps.length && i < MAX_STEPS; i++) {
      var step = sanitizeStep(raw.steps[i], i, errors, warnings);
      if (step) steps.push(step);
    }

    var hasEdit = steps.some(function (s) {
      var def = ActionRegistry.get(s.action);
      return def && def.kind === 'edit';
    });
    if (!hasEdit) warnings.push('This plan only reads the timeline and changes nothing.');

    var plan = {
      title: title || 'Editing plan',
      summary: summary,
      steps: steps
    };

    return {
      ok: errors.length === 0,
      errors: errors,
      warnings: warnings,
      plan: errors.length === 0 ? plan : null
    };
  }

  function validateAnswer(raw) {
    if (!isPlainObject(raw)) {
      return { ok: false, error: 'The response must be a JSON object', text: '' };
    }
    if (raw.kind !== 'answer') {
      return { ok: false, error: 'kind must be "answer"', text: '' };
    }
    if (typeof raw.text !== 'string' || !raw.text.trim()) {
      return { ok: false, error: 'text must be a non-empty string', text: '' };
    }
    return { ok: true, error: '', text: raw.text.slice(0, 20000) };
  }

  return {
    MAX_STEPS: MAX_STEPS,
    validatePlan: validatePlan,
    validateAnswer: validateAnswer,
    validateParams: function (name, params) {
      var errors = [];
      var warnings = [];
      validateParams(name, params || {}, 'params', errors, warnings);
      return { ok: errors.length === 0, errors: errors, warnings: warnings };
    },
    tokenLength: MAX_TOKEN
  };
})();

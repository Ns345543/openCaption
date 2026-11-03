/*
 * actionPlanner.js — provider-independent intent → action-plan conversion.
 *
 * Every provider is asked for one JSON object using the same prompt. No
 * provider gets a special tool-calling path, so a plan behaves identically
 * whether it came from Gemini, OpenAI, Claude, Grok, DeepSeek, Kimi or Groq.
 *
 * The planner never runs an action. It returns a validated plan that the chat
 * UI must show and the user must approve.
 */
var ActionPlanner = (function () {
  'use strict';

  var MAX_HISTORY = 16;
  var MAX_HISTORY_CHARS = 48000;
  var MAX_ASSISTANT_CHARS = 3000;

  var SHAPE =
    'Return EXACTLY one JSON object and nothing else (no markdown, no code fences, no commentary).\n' +
    'One of these two shapes:\n' +
    '{"kind":"answer","text":"..."}\n' +
    '{"kind":"plan","title":"...","summary":"...","steps":[{"action":"...","params":{},"reason":"..."}]}\n';

  var RULES =
    'RULES\n' +
    '- Use "answer" for questions, explanations, advice, or when the request is ambiguous.\n' +
    '- Use "plan" only when the user asks you to change the Premiere Pro timeline.\n' +
    '- Use ONLY the registered actions below. Never invent an action or a parameter.\n' +
    '- All times are seconds (numbers), not timecodes.\n' +
    '- Target a clip with its nodeId from the timeline context, or omit nodeId to target the current selection.\n' +
    '- If no clip is selected and the user did not name one, ask which clip to use. Never pick a clip at random.\n' +
    '- If several clips are selected and the operation needs exactly one, ask the user to select one or name a nodeId.\n' +
    '- Keep a plan minimal and ordered: read-only steps first, then the edit steps. At most 8 steps.\n' +
    '- Do not add destructive steps (delete_clip, remove_silence, remove_timeline_gaps) unless the user clearly asked for them.\n' +
    '- For silence, call remove_silence with thresholds; never supply silence intervals yourself.\n' +
    '- The panel shows the plan for confirmation and then executes it. You are planning only: never claim that anything has run.\n' +
    '- Do not include API keys, file paths that are not in the context, or instructions to run scripts.\n';

  function buildSystemPrompt(contextText) {
    return 'You are openCaption\'s editor planner for Adobe Premiere Pro.\n' +
      'You cannot see the screen. The timeline context below is the only state you may assume.\n\n' +
      SHAPE + '\n' + RULES + '\n' +
      'REGISTERED ACTIONS\n' + ActionRegistry.catalogText() + '\n\n' +
      'CURRENT TIMELINE CONTEXT\n' + (contextText || 'No active sequence.') + '\n';
  }

  function historyMessages(messages) {
    var out = [];
    var chars = 0;
    for (var i = messages.length - 1; i >= 0 && out.length < MAX_HISTORY; i--) {
      var m = messages[i] || {};
      if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content) continue;
      var content = m.content;
      if (m.role === 'assistant' && content.length > MAX_ASSISTANT_CHARS) {
        content = content.slice(0, MAX_ASSISTANT_CHARS) + '…';
      }
      if (chars + content.length > MAX_HISTORY_CHARS && out.length) break;
      chars += content.length;
      out.unshift({ role: m.role, content: content });
    }
    return out;
  }

  function buildMessages(messages, contextText) {
    var result = [{ role: 'system', content: buildSystemPrompt(contextText) }];
    return result.concat(historyMessages(messages || []));
  }

  function extractJson(text) {
    var raw = String(text || '').trim();
    if (!raw) return null;
    raw = raw.replace(/^\uFEFF/, '');
    if (raw.charAt(0) === '`') {
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    }
    if (raw.charAt(0) === '{') {
      try { return JSON.parse(raw); } catch (e) { /* try the inner object */ }
    }
    var start = raw.indexOf('{');
    var end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(raw.slice(start, end + 1)); } catch (e2) { return null; }
    }
    return null;
  }

  function normalizedKind(raw) {
    if (raw.kind === 'plan' || raw.kind === 'answer') return raw.kind;
    if (Array.isArray(raw.steps)) return 'plan';
    if (typeof raw.text === 'string') return 'answer';
    return '';
  }

  function parseResponse(response) {
    var text = String((response && response.text) || '').trim();
    if (!text) {
      return { ok: false, error: 'The model returned an empty response.' };
    }

    var raw = extractJson(text);
    if (!raw) {
      /* A reply that obviously tried to be JSON must not be shown as a normal
         answer, because the user would think a plan was prepared. Show an
         error instead. */
      if (text.charAt(0) === '{' || /"kind"\s*:/.test(text)) {
        return {
          ok: false,
          error: 'The model returned malformed JSON, so no action plan was prepared.',
          rawText: text.slice(0, 2000)
        };
      }

      /* A plain-text reply is a legitimate answer, but it is never treated as
         an executable plan. */
      return {
        ok: true,
        kind: 'answer',
        text: text,
        plan: null,
        warnings: ['The model replied in plain text, so no editing plan was prepared.'],
        usage: response.usage || null,
        model: response.model || '',
        provider: response.provider || ''
      };
    }

    var kind = normalizedKind(raw);
    if (!kind) {
      return {
        ok: false,
        error: 'The model returned JSON that was neither an answer nor an action plan.',
        rawText: text.slice(0, 2000)
      };
    }

    if (kind === 'answer') {
      var answer = ActionValidator.validateAnswer(raw.kind === 'answer' ? raw : {
        kind: 'answer',
        text: raw.text
      });
      if (!answer.ok) {
        return { ok: false, error: answer.error, rawText: text.slice(0, 2000) };
      }
      return {
        ok: true,
        kind: 'answer',
        text: answer.text,
        plan: null,
        warnings: [],
        usage: response.usage || null,
        model: response.model || '',
        provider: response.provider || ''
      };
    }

    var checked = ActionValidator.validatePlan(raw.kind === 'plan' ? raw : {
      kind: 'plan',
      title: raw.title,
      summary: raw.summary,
      steps: raw.steps
    });
    if (!checked.ok) {
      return {
        ok: false,
        error: 'The model returned an invalid action plan. Nothing was changed.',
        details: checked.errors,
        rawText: text.slice(0, 2000)
      };
    }

    return {
      ok: true,
      kind: 'plan',
      text: checked.plan.summary || '',
      plan: checked.plan,
      warnings: checked.warnings,
      usage: response.usage || null,
      model: response.model || '',
      provider: response.provider || ''
    };
  }

  /**
   * opts: { adapter, apiKey, model, messages, contextText, token, temperature }
   */
  function plan(opts) {
    opts = opts || {};
    var adapter = opts.adapter;
    if (!adapter || typeof adapter.complete !== 'function') {
      return Promise.reject(new Error('This provider cannot produce an editing plan.'));
    }
    if (!opts.apiKey) return Promise.reject(new Error('The provider key is missing.'));
    if (!opts.model) return Promise.reject(new Error('Choose a model before asking the assistant to edit.'));

    var messages = buildMessages(opts.messages, opts.contextText);
    return adapter.complete({
      apiKey: opts.apiKey,
      model: opts.model,
      messages: messages,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.15,
      token: opts.token
    }).then(parseResponse);
  }

  return {
    plan: plan,
    buildMessages: buildMessages,
    buildSystemPrompt: buildSystemPrompt,
    parseResponse: parseResponse,
    extractJson: extractJson
  };
})();

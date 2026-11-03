/*
 * actionPreview.js — the confirmation card shown inside an AI Chat message.
 *
 * A plan is never executed by the planner or by simply rendering this card.
 * The user must press Execute. While a plan runs, the card shows real
 * per-step state from ActionExecutor; after it finishes, it shows Premiere's
 * own result values instead of a success message.
 */
var ActionPreview = (function () {
  'use strict';

  var STATE_LABEL = {
    pending: 'Awaiting confirmation',
    running: 'Running',
    done: 'Completed',
    failed: 'Stopped',
    cancelled: 'Cancelled'
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function timeText(value) {
    return ActionRegistry.timeText(value);
  }

  function stepDetail(step) {
    var def = ActionRegistry.get(step.action);
    if (!def) return 'Unknown action';
    if (typeof def.summary === 'function') {
      try { return def.summary(step.params || {}); } catch (e) { return def.label; }
    }
    return def.label;
  }

  function destructiveCount(action) {
    var count = 0;
    for (var i = 0; i < action.steps.length; i++) {
      var def = ActionRegistry.get(action.steps[i].action);
      if (def && def.destructive) count++;
    }
    return count;
  }

  function resultFor(action, index) {
    var results = action.results || [];
    for (var i = 0; i < results.length; i++) {
      if (results[i] && results[i].index === index) return results[i];
    }
    return null;
  }

  function stateFor(action, index) {
    var record = resultFor(action, index);
    if (record) {
      if (record.cancelled) return 'cancelled';
      return record.ok ? 'done' : 'failed';
    }
    if (action.status === 'running') {
      if (typeof action.runningIndex === 'number') return index === action.runningIndex ? 'running' : 'pending';
      return 'pending';
    }
    if (action.status === 'cancelled') return 'cancelled';
    return 'pending';
  }

  function renderButtons(card, action, handlers) {
    var row = el('div', 'action-buttons');

    if (action.status === 'pending') {
      var run = el('button', 'btn primary sm', 'Execute');
      run.type = 'button';
      run.addEventListener('click', function () {
        run.disabled = true;
        if (handlers && handlers.onExecute) handlers.onExecute(action);
      });

      var cancel = el('button', 'btn sm ghost', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', function () {
        if (handlers && handlers.onCancel) handlers.onCancel(action);
      });

      row.appendChild(run);
      row.appendChild(cancel);
    } else if (action.status === 'running') {
      var stop = el('button', 'btn sm ghost', 'Stop');
      stop.type = 'button';
      stop.addEventListener('click', function () {
        stop.disabled = true;
        stop.textContent = 'Stopping…';
        if (handlers && handlers.onStop) handlers.onStop(action);
      });
      row.appendChild(stop);
    } else {
      var note = el('span', 'action-outcome', STATE_LABEL[action.status] || 'Finished');
      row.appendChild(note);
    }

    card.appendChild(row);
  }

  function render(action, handlers) {
    var card = el('div', 'action-card');
    card.setAttribute('data-action-status', action.status || 'pending');

    var head = el('div', 'action-head');
    var badge = el('span', 'action-badge', action.status === 'pending' ? 'EDIT PLAN' : 'ACTION');
    var title = el('span', 'action-title', action.title || 'Editing plan');
    var state = el('span', 'action-state state-' + (action.status || 'pending'),
      STATE_LABEL[action.status] || 'Awaiting confirmation');
    head.appendChild(badge);
    head.appendChild(title);
    head.appendChild(state);
    card.appendChild(head);

    if (action.summary) {
      card.appendChild(el('p', 'action-summary', action.summary));
    }

    var destructive = destructiveCount(action);
    if (destructive && action.status === 'pending') {
      card.appendChild(el('p', 'action-warning',
        'This plan changes the timeline' + (destructive > 1 ? ' in ' + destructive + ' destructive steps' : '') +
        '. Check every target below before pressing Execute. Premiere\'s undo history is limited.'));
    }

    var list = el('ol', 'action-steps');
    for (var i = 0; i < action.steps.length; i++) {
      var step = action.steps[i];
      var item = el('li', 'action-step');
      var stepState = stateFor(action, i);
      item.setAttribute('data-step-state', stepState);

      var dot = el('span', 'action-step-dot');
      var body = el('div', 'action-step-body');
      var label = el('div', 'action-step-label', String(i + 1) + '. ' + (step.label || (ActionRegistry.get(step.action) || {}).label || step.action));
      var detail = el('div', 'action-step-detail', stepDetail(step));
      body.appendChild(label);
      body.appendChild(detail);

      if (step.reason) body.appendChild(el('div', 'action-step-reason', step.reason));

      var record = resultFor(action, i);
      if (record) {
        if (record.ok) {
          body.appendChild(el('div', 'action-step-result', ActionExecutor.describeStep(record)));
        } else {
          body.appendChild(el('div', 'action-step-error', record.error || 'The step did not complete.'));
        }
      } else if (stepState === 'running') {
        body.appendChild(el('div', 'action-step-result', 'Working…'));
      }

      item.appendChild(dot);
      item.appendChild(body);
      list.appendChild(item);
    }
    card.appendChild(list);

    if (action.status === 'running' && action.analysisProgress) {
      card.appendChild(el('div', 'action-progress', action.analysisProgress));
    }

    if (action.error) {
      card.appendChild(el('p', 'action-error', action.error));
    }

    if (action.warnings && action.warnings.length) {
      var notes = el('div', 'action-warnings');
      for (var w = 0; w < action.warnings.length; w++) {
        notes.appendChild(el('div', 'action-warning-line', action.warnings[w]));
      }
      card.appendChild(notes);
    }

    renderButtons(card, action, handlers);
    return card;
  }

  function mount(slot, action, handlers) {
    if (!slot) return;
    slot.innerHTML = '';
    if (!action || !action.steps || !action.steps.length) return;
    slot.appendChild(render(action, handlers));
  }

  return {
    mount: mount,
    render: render,
    stepDetail: stepDetail
  };
})();

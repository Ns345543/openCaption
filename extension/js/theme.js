/*
 * theme.js — palette registry and instant theme application.
 *
 * Loaded in <head> so the saved palette is on <html> before the panel paints;
 * otherwise a dark theme would flash white for a frame at every reload.
 *
 * The settings file stays the source of truth (Config.theme). localStorage is
 * only the pre-paint hint — it is written on every apply and read once here.
 */
var Theme = (function () {
  'use strict';

  var THEMES = [
    { id: 'mono',   name: 'Mono',   swatchBg: '#0b0b0b', swatchAccent: '#ffffff' },
    { id: 'void',   name: 'Void',   swatchBg: '#0b0818', swatchAccent: '#a78bfa' },
    { id: 'ember',  name: 'Ember',  swatchBg: '#150c06', swatchAccent: '#fb923c' },
    { id: 'matrix', name: 'Matrix', swatchBg: '#061208', swatchAccent: '#4ade80' },
    { id: 'paper',  name: 'Paper',  swatchBg: '#f8f6f0', swatchAccent: '#d92d20' }
  ];

  var STORE_KEY = 'openCaption.theme';
  var DEFAULT = 'mono';
  var ids = THEMES.map(function (t) { return t.id; });

  function normalize(name) {
    return ids.indexOf(name) >= 0 ? name : DEFAULT;
  }

  function current() {
    return normalize(document.documentElement.getAttribute('data-theme'));
  }

  function apply(name) {
    var id = normalize(name);
    document.documentElement.setAttribute('data-theme', id);

    try { localStorage.setItem(STORE_KEY, id); } catch (e) { /* private mode */ }

    var label = document.getElementById('themeName');
    if (label) label.textContent = id;

    var buttons = document.querySelectorAll('.theme-swatch');
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute('data-theme') === id;
      buttons[i].classList.toggle('active', on);
      buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    return id;
  }

  /** Builds the swatch rail. onChange receives the new theme id. */
  function mount(container, onChange) {
    container.innerHTML = '';
    THEMES.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'theme-swatch';
      b.setAttribute('data-theme', t.id);
      b.setAttribute('aria-label', t.name + ' theme');
      b.title = t.name;
      b.style.setProperty('--sw-bg', t.swatchBg);
      b.style.setProperty('--sw-accent', t.swatchAccent);
      b.appendChild(document.createElement('i'));
      b.addEventListener('click', function () {
        var id = apply(t.id);
        if (onChange) onChange(id);
      });
      container.appendChild(b);
    });
    apply(current());
  }

  var saved = DEFAULT;
  try { saved = localStorage.getItem(STORE_KEY) || DEFAULT; } catch (e) { saved = DEFAULT; }
  apply(saved);

  return {
    THEMES: THEMES,
    ids: ids,
    apply: apply,
    current: current,
    mount: mount
  };
})();

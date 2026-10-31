/*
 * theme.js — palette registry, custom theme derivation, instant application.
 *
 * Loaded in <head> so the saved palette is on <html> before the panel paints;
 * otherwise a dark theme would flash light for a frame at every reload.
 *
 * Config is the source of truth (Theme.theme / Config.customTheme).
 * localStorage is only the pre-paint hint, written on every apply.
 */
var Theme = (function () {
  'use strict';

  var THEMES = [
    { id: 'mono',     name: 'Mono',     swatchBg: '#0b0b0b', swatchAccent: '#ffffff' },
    { id: 'premiere', name: 'Premiere', swatchBg: '#1d1d1d', swatchAccent: '#005cc8',
      title: 'Premiere Pro — sky blue on black' },
    { id: 'void',   name: 'Void',   swatchBg: '#0b0818', swatchAccent: '#a78bfa' },
    { id: 'ember',  name: 'Ember',  swatchBg: '#150c06', swatchAccent: '#fb923c' },
    { id: 'matrix', name: 'Matrix', swatchBg: '#061208', swatchAccent: '#4ade80' },
    { id: 'paper',  name: 'Paper',  swatchBg: '#f8f6f0', swatchAccent: '#d92d20' }
  ];

  var STORE_KEY = 'openCaption.theme';
  var CUSTOM_KEY = 'openCaption.customTheme';
  var DEFAULT = 'mono';
  var ids = THEMES.map(function (t) { return t.id; });

  var custom = null;
  var mounted = null;
  var mountedCb = null;
  var styleEl = null;

  /* ------------------------------------------------------------ colour */

  function parseHex(value) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || '').trim());
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    return '#' + h.toLowerCase();
  }

  function toRgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }

  function toHex(r, g, b) {
    function part(v) {
      var n = Math.max(0, Math.min(255, Math.round(v))).toString(16);
      return n.length === 1 ? '0' + n : n;
    }
    return '#' + part(r) + part(g) + part(b);
  }

  /** t = 0 returns a, t = 1 returns b. */
  function mix(a, b, t) {
    var A = toRgb(a), B = toRgb(b);
    return toHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
  }

  function rgba(hex, alpha) {
    var c = toRgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
  }

  function luminance(hex) {
    var c = toRgb(hex).map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  /* ------------------------------------------------------- custom theme */

  function normalizeCustom(obj) {
    if (!obj || typeof obj !== 'object') return null;
    var bg = parseHex(obj.bg);
    var panel = parseHex(obj.panel);
    var accent = parseHex(obj.accent);
    var text = parseHex(obj.text);
    if (!bg || !panel || !accent || !text) return null;
    var name = String(obj.name || 'Custom').replace(/\s+/g, ' ').trim().slice(0, 18) || 'Custom';
    return { name: name, bg: bg, panel: panel, accent: accent, text: text };
  }

  /* Everything except the four chosen colours is derived so a custom theme
     stays as complete and as legible as the built-in palettes. */
  function derive(c) {
    var light = luminance(c.bg) > 0.5;
    return {
      '--bg': c.bg,
      '--bg-soft': mix(c.bg, c.panel, 0.5),
      '--panel': c.panel,
      '--panel-2': mix(c.panel, c.text, 0.05),
      '--fill': mix(c.panel, c.text, 0.08),
      '--fill-2': mix(c.panel, c.text, 0.14),
      '--input-bg': light ? mix(c.panel, '#ffffff', 0.5) : mix(c.bg, '#000000', 0.35),
      '--log-bg': light ? mix(c.panel, '#ffffff', 0.6) : mix(c.bg, '#000000', 0.4),
      '--line': rgba(c.text, light ? 0.20 : 0.14),
      '--line-strong': rgba(c.text, light ? 0.50 : 0.36),
      '--text': c.text,
      '--muted': mix(c.text, c.bg, 0.38),
      '--muted-2': mix(c.text, c.bg, 0.58),
      '--placeholder': mix(c.text, c.bg, 0.68),
      '--accent': c.accent,
      '--accent-2': mix(c.accent, c.text, 0.30),
      '--on-accent': luminance(c.accent) > 0.5 ? '#000000' : '#ffffff',
      '--ok': light ? '#15803d' : '#4ade80',
      '--warn': light ? '#a16207' : '#fbbf24',
      '--err': light ? '#b91c1c' : '#f87171',
      '--shadow': light ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.95)',
      '--grid': rgba(c.text, light ? 0.08 : 0.06),
      '--beam': rgba(c.accent, light ? 0.12 : 0.16),
      '--scroll': rgba(c.text, 0.35),
      '--glow': rgba(c.accent, 0.35)
    };
  }

  function buildCss(c) {
    var vars = derive(c);
    var lines = ['html[data-theme="custom"] {'];
    lines.push('  color-scheme: ' + (luminance(c.bg) > 0.5 ? 'light' : 'dark') + ';');
    for (var k in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, k)) lines.push('  ' + k + ': ' + vars[k] + ';');
    }
    lines.push('}');
    return lines.join('\n');
  }

  function ensureStyle() {
    if (styleEl && styleEl.parentNode) return styleEl;
    styleEl = document.getElementById('themeCustomVars');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'themeCustomVars';
      document.head.appendChild(styleEl);
    }
    return styleEl;
  }

  /** Saves or removes the custom palette. Pass persist=false for boot. */
  function setCustom(obj, persist) {
    custom = normalizeCustom(obj);
    var el = ensureStyle();
    el.textContent = custom ? buildCss(custom) : '';
    if (persist !== false) {
      try {
        if (custom) localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
        else localStorage.removeItem(CUSTOM_KEY);
      } catch (e) { /* private mode */ }
    }
    if (mounted) render();
    return custom;
  }

  function getCustom() { return custom; }

  /* ------------------------------------------------------------- apply */

  function resolve(name) {
    if (name === 'custom') return custom ? 'custom' : DEFAULT;
    return ids.indexOf(name) >= 0 ? name : DEFAULT;
  }

  function current() {
    return resolve(document.documentElement.getAttribute('data-theme'));
  }

  function label(id) {
    if (id === 'custom' && custom) return custom.name;
    for (var i = 0; i < THEMES.length; i++) {
      if (THEMES[i].id === id) return THEMES[i].name;
    }
    return id;
  }

  function apply(name) {
    var id = resolve(name);
    document.documentElement.setAttribute('data-theme', id);

    try { localStorage.setItem(STORE_KEY, id); } catch (e) { /* private mode */ }

    var nameEl = document.getElementById('themeName');
    if (nameEl) nameEl.textContent = label(id);

    var buttons = document.querySelectorAll('.theme-swatch');
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute('data-theme') === id;
      buttons[i].classList.toggle('active', on);
      buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    return id;
  }

  /* ------------------------------------------------------------- rail */

  function addSwatch(container, t, isCustom) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme-swatch';
    b.setAttribute('data-theme', t.id);
    b.setAttribute('aria-label', t.title || t.name);
    b.title = t.title || t.name;
    b.style.setProperty('--sw-bg', t.swatchBg);
    b.style.setProperty('--sw-accent', t.swatchAccent);
    if (isCustom) b.classList.add('theme-swatch-custom');
    b.appendChild(document.createElement('i'));
    b.addEventListener('click', function () {
      var id = apply(t.id);
      if (mountedCb) mountedCb(id);
    });
    container.appendChild(b);
  }

  function render() {
    if (!mounted) return;
    mounted.innerHTML = '';
    THEMES.forEach(function (t) { addSwatch(mounted, t, false); });
    if (custom) {
      addSwatch(mounted, {
        id: 'custom',
        name: custom.name,
        title: custom.name + ' — custom theme',
        swatchBg: custom.panel,
        swatchAccent: custom.accent
      }, true);
    }
    apply(current());
  }

  /** Rebuilds the rail after the custom palette changed. */
  function refresh() {
    render();
    return current();
  }

  /** Builds the swatch rail. onChange receives the new theme id. */
  function mount(container, onChange) {
    mounted = container;
    mountedCb = onChange;
    render();
  }

  /* ------------------------------------------------------------ pre-paint */

  var saved = DEFAULT;
  try {
    saved = localStorage.getItem(STORE_KEY) || DEFAULT;
    var rawCustom = localStorage.getItem(CUSTOM_KEY);
    if (rawCustom) setCustom(JSON.parse(rawCustom), false);
  } catch (e) {
    saved = DEFAULT;
  }
  apply(saved);

  return {
    THEMES: THEMES,
    ids: ids,
    apply: apply,
    current: current,
    mount: mount,
    refresh: refresh,
    setCustom: setCustom,
    getCustom: getCustom,
    parseHex: parseHex,
    derive: derive
  };
})();

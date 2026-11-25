/*
 * ambient.js — Interactive ASCII animals & paper airplane canvas engine.
 *
 * Ported from sushilbyte7/ascii-animals-extension (Apache-2.0) and Stephen's
 * ascii-animals (MIT, Copyright (c) 2026 drewdi / Sushil Kumar):
 *   - Fixed-timestep Flock physics + spatial separation + startle / koi-feeding AI
 *   - Character-cell ASCII shader (CellRenderer + Pen) with 5-point supersampled
 *     edge anti-aliasing, iridescence shimmer, cellular sparkle, and diffusing
 *     trailing energy field
 *   - All 7 original creatures (Butterfly, Crane, Dragonfly, Koi, Jellyfish,
 *     Crab, Frog) plus Paper Airplane rendered on the same shader
 *   - Adapted for transparent overlay over openCaption themes & Liquid Glass,
 *     Chromium 74+ (Premiere CEP) compatibility, and Config persistence
 */
var Ambient = (function () {
  'use strict';

  var TAU = Math.PI * 2;
  var STEP = 1 / 60;
  var MAX_SUBSTEPS = 4;
  var STARTLE_RADIUS = 240;
  var REF_BASE = 160;
  var TRAIL_BUCKETS = 6;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function randRange(lo, hi) { return lo + Math.random() * (hi - lo); }
  function fract(x) { return x - Math.floor(x); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(a, b, x) {
    var t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function angleDiff(from, to) {
    var d = (to - from) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    return d;
  }
  function hash3(x, y, z) {
    var h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function segDist(px, py, ax, ay, bx, by, out) {
    var dx = bx - ax;
    var dy = by - ay;
    var t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    if (out) out.t = t;
    return Math.hypot(px - ax - dx * t, py - ay - dy * t);
  }
  function inEllipse(x, y, cx, cy, rx, ry) {
    var nx = (x - cx) / rx;
    var ny = (y - cy) / ry;
    return nx * nx + ny * ny <= 1;
  }
  function spotPattern(x, y, cell, radius, seed) {
    var gx = x / cell;
    var gy = y / cell;
    var ix = Math.floor(gx);
    var iy = Math.floor(gy);
    var ox = 0.25 + 0.5 * hash3(ix, iy, seed);
    var oy = 0.25 + 0.5 * hash3(ix, iy, seed + 11);
    var r = (radius / cell) * (0.6 + 0.6 * hash3(ix, iy, seed + 23));
    return (gx - ix - ox) * (gx - ix - ox) + (gy - iy - oy) * (gy - iy - oy) < r * r;
  }

  /* ---------------------------------------------------------------- tuning */

  var BASE_TUNING = {
    density: 1,
    corner: false,
    direction: 49,
    speed: 1,
    sway: 0.04,
    spread: 0.06,
    size: 1,
    farthest: 0.45,
    farBias: 1.6,
    grip: 2,
    separation: 300,
    hueShift: 0,
    shimmer: 0.3,
    sparkle: 0.12,
    fog: 0.75,
    trail: 1,
    trailFade: 1.3,
    grid: 1.05,
    detail: 1.3,
    opacity: 0.92
  };

  var SHARED_CONTROLS = {
    movement: [
      { key: 'density', label: 'Density', min: 0.1, max: 4, step: 0.05, hint: 'How many are on screen.' },
      { key: 'corner', label: 'Corner to corner', toggle: true, hint: 'Cross from bottom-left to top-right regardless of panel shape. Turn off to set Direction yourself.' },
      { key: 'direction', label: 'Direction (\u00b0)', min: 0, max: 360, step: 1, disabledWhen: 'corner', hint: 'Travel angle in degrees: 0 is right, 90 is up (active when Corner to corner is off).' },
      { key: 'speed', label: 'Speed', min: 0.1, max: 3, step: 0.05, hint: 'How fast they travel.' },
      { key: 'sway', label: 'Sway', min: 0, max: 0.6, step: 0.01, hint: 'How much the whole group slowly drifts left and right off course.' },
      { key: 'spread', label: 'Spread', min: 0, max: 0.8, step: 0.01, hint: 'How far each individual path can stray from the group course.' },
      { key: 'size', label: 'Size', min: 0.3, max: 2.5, step: 0.05, hint: 'How big they are.' },
      { key: 'farthest', label: 'Farthest depth', min: 0.1, max: 1, step: 0.01, hint: 'How small and faint distant ones get. 1 makes them all equally close.' },
      { key: 'farBias', label: 'Far bias', min: 0.3, max: 3, step: 0.05, hint: 'Depth distribution: higher puts more creatures in the distance.' },
      { key: 'grip', label: 'Hold course', min: 0.2, max: 5, step: 0.05, hint: 'How strongly they steer back onto course after drifting.' },
      { key: 'separation', label: 'Separation', min: 0, max: 1000, step: 10, hint: 'How strongly neighbours keep their distance from each other.' }
    ],
    look: [
      { key: 'hueShift', label: 'Hue shift (\u00b0)', min: -180, max: 180, step: 1, hint: 'Rotates colours around the colour wheel in degrees.' },
      { key: 'shimmer', label: 'Shimmer', min: 0, max: 1, step: 0.01, hint: 'Iridescent wave intensity across surfaces as they turn.' },
      { key: 'sparkle', label: 'Sparkle', min: 0, max: 0.5, step: 0.01, hint: 'How often cells flash bright like light catching wings or scales.' },
      { key: 'opacity', label: 'Opacity', min: 0.15, max: 1, step: 0.01, hint: 'Overall canvas opacity behind UI cards.' },
      { key: 'fog', label: 'Distance fade', min: 0, max: 1, step: 0.01, hint: 'How much far-away ones fade toward the background.' },
      { key: 'trail', label: 'Trail', min: 0, max: 4, step: 0.05, hint: 'How much trail glow, scales, ripples or footprints they leave behind.' },
      { key: 'trailFade', label: 'Trail fade', min: 0.05, max: 6, step: 0.05, hint: 'How quickly trails fade. Lower lingers longer.' },
      { key: 'grid', label: 'Grid', min: 0, max: 4, step: 0.05, hint: 'Visibility of the character-aligned background grid.' },
      { key: 'detail', label: 'ASCII detail', min: 0.5, max: 2, step: 0.05, hint: 'ASCII grid resolution. Higher means smaller characters and finer shapes.' }
    ]
  };

  /* ---------------------------------------------------------------- flock */

  function Flock(animal, tuning, count) {
    this.width = 0;
    this.height = 0;
    this.time = 0;
    this.creatures = [];
    this.events = [];
    this.base = 120;
    this.acc = { x: 0, y: 0 };
    this.nextId = 1;
    this.animal = animal;
    this.tuning = tuning;
    this.count = count;
  }

  Flock.prototype.resize = function (w, h) {
    var first = this.width === 0;
    this.width = w;
    this.height = h;
    this.base = clamp(Math.min(w, h) * 0.2, 80, 190) * this.animal.scale;
    if (first) this.populate(true);
  };

  Flock.prototype.getCourse = function () {
    var t = this.tuning;
    return t.corner ? Math.atan2(-this.height, this.width) : (-t.direction * Math.PI) / 180;
  };

  Flock.prototype.getHeading = function () {
    var t = this.time;
    return this.getCourse() + this.tuning.sway * (Math.sin(t * 0.13) + 0.5 * Math.sin(t * 0.31 + 1.7));
  };

  Flock.prototype.getTarget = function () {
    if (this.count !== undefined && this.count !== null) return this.count;
    // Clamp effective scale factor on compact Premiere sidebars so small panels do not overcrowd
    var rel = Math.max(0.62, this.base / this.animal.scale / REF_BASE);
    var scaleSq = rel * rel;
    var maxCap = (this.animal.max !== undefined) ? this.animal.max : 200;
    return clamp(Math.round((this.width * this.height) / (this.animal.area * scaleSq) * this.tuning.density), 1, maxCap);
  };

  Flock.prototype.depthOf = function (roll) {
    var t = this.tuning;
    return t.farthest + (1 - t.farthest) * Math.pow(roll, t.farBias);
  };

  Flock.prototype.cruise = function (c) {
    return this.animal.speed * (0.55 + 0.45 * c.depth) * this.tuning.speed;
  };

  Flock.prototype.startle = function (x, y) {
    if (this.animal.tap) {
      this.animal.tap(x, y, this);
      return;
    }
    this.events.push({ x: x, y: y, radius: 6, amount: 1.4 });
    for (var i = 0; i < this.creatures.length; i++) {
      var c = this.creatures[i];
      var dx = c.x - x;
      var dy = c.y - y;
      var dist = Math.hypot(dx, dy) || 1;
      if (dist > STARTLE_RADIUS) continue;
      var power = 1 - dist / STARTLE_RADIUS;
      if (this.animal.startle) {
        this.animal.startle(c, dx / dist, dy / dist, power, this);
      } else {
        var impulse = power * 420 * c.depth;
        c.vx += (dx / dist) * impulse;
        c.vy += (dy / dist) * impulse;
        c.startledUntil = this.time + randRange(0.6, 1.2);
      }
    }
  };

  Flock.prototype.step = function (dt) {
    this.time += dt;
    this.populate(false);
    var i;
    for (i = 0; i < this.creatures.length; i++) {
      var c = this.creatures[i];
      c.depth = this.depthOf(c.roll);
      c.span = this.base * c.depth * this.tuning.size;
    }
    if (this.animal.prepare) this.animal.prepare(this, dt);
    for (i = 0; i < this.creatures.length; i++) {
      this.animal.update(this.creatures[i], this, dt);
    }
  };

  Flock.prototype.populate = function (initial) {
    var want = this.getTarget();
    while (this.creatures.length > want) {
      var idx = Math.floor(Math.random() * this.creatures.length);
      var removed = this.creatures.splice(idx, 1)[0];
      if (removed) removed.gone = true;
    }
    while (this.creatures.length < want) {
      var c = this.spawn();
      if (initial || Math.random() < 0.5) {
        c.x = randRange(0, this.width);
        c.y = randRange(0, this.height);
        if (this.animal.enter) this.animal.enter(c, this);
      }
      this.insert(c);
    }
  };

  Flock.prototype.insert = function (c) {
    var idx = -1;
    for (var i = 0; i < this.creatures.length; i++) {
      if (this.creatures[i].roll > c.roll) { idx = i; break; }
    }
    this.creatures.splice(idx < 0 ? this.creatures.length : idx, 0, c);
  };

  Flock.prototype.spawn = function () {
    var base = {
      id: this.nextId++,
      roll: Math.random(),
      depth: 1,
      span: 0,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      heading: 0,
      bias: 0,
      startledUntil: 0,
      gone: false
    };
    base.depth = this.depthOf(base.roll);
    base.span = this.base * base.depth * this.tuning.size;
    var ent = this.animal.create(base, this);
    this.reenter(ent);
    return ent;
  };

  Flock.prototype.reenter = function (c) {
    var w = this.width;
    var h = this.height;
    var course = this.getCourse();
    var margin = c.span * 0.6;
    var cos = Math.cos(course);
    var sin = Math.sin(course);
    var spanH = h * Math.abs(cos);
    var spanW = w * Math.abs(sin);
    if (Math.random() * (spanH + spanW) < spanH) {
      c.x = cos >= 0 ? -margin : w + margin;
      c.y = randRange(0, h);
    } else {
      c.x = randRange(0, w);
      c.y = sin <= 0 ? h + margin : -margin;
    }
    var spd = this.cruise(c);
    c.heading = course;
    c.vx = cos * spd;
    c.vy = sin * spd;
    c.bias = randRange(-1, 1);
    if (this.animal.enter) this.animal.enter(c, this);
  };

  Flock.prototype.passed = function (c, pad) {
    if (pad === undefined) pad = c.span;
    var w = this.width;
    var h = this.height;
    var course = this.getCourse();
    var cos = Math.cos(course);
    var sin = Math.sin(course);
    var beyond = (cos > 0.05 && c.x > w + pad) ||
                 (cos < -0.05 && c.x < -pad) ||
                 (sin < -0.05 && c.y < -pad) ||
                 (sin > 0.05 && c.y > h + pad);
    var farOut = c.x < -3 * pad || c.x > w + 3 * pad || c.y < -3 * pad || c.y > h + 3 * pad;
    return beyond || farOut;
  };

  Flock.prototype.begin = function () {
    this.acc.x = 0;
    this.acc.y = 0;
    return this.acc;
  };

  Flock.prototype.steer = function (c, angle, speed, gain) {
    this.acc.x += (Math.cos(angle) * speed - c.vx) * gain;
    this.acc.y += (Math.sin(angle) * speed - c.vy) * gain;
  };

  Flock.prototype.separate = function (c, strength, radiusScale) {
    if (strength === undefined) strength = this.tuning.separation;
    if (radiusScale === undefined) radiusScale = 0.42;
    if (strength <= 0) return;
    for (var i = 0; i < this.creatures.length; i++) {
      var o = this.creatures[i];
      if (o === c || Math.abs(o.depth - c.depth) > 0.18) continue;
      var dx = c.x - o.x;
      var dy = c.y - o.y;
      var dist = Math.hypot(dx, dy);
      var minD = (c.span + o.span) * radiusScale;
      if (dist < minD && dist > 0.001) {
        var push = (1 - dist / minD) * strength;
        this.acc.x += (dx / dist) * push;
        this.acc.y += (dy / dist) * push;
      }
    }
  };

  Flock.prototype.move = function (c, dt, maxSpeed) {
    c.vx += this.acc.x * dt;
    c.vy += this.acc.y * dt;
    var spd = Math.hypot(c.vx, c.vy);
    var cap = maxSpeed + (this.time < c.startledUntil ? 300 : 0);
    if (spd > cap) {
      c.vx *= cap / spd;
      c.vy *= cap / spd;
      spd = cap;
    }
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    return spd;
  };

  Flock.prototype.face = function (c, dt, rate, angle) {
    if (rate === undefined) rate = 7;
    if (angle === undefined) angle = Math.atan2(c.vy, c.vx);
    var step = rate * dt;
    c.heading += clamp(angleDiff(c.heading, angle), -step, step);
  };

  /* -------------------------------------------------------------- shader / cell renderer */

  var CELL_GRADIENT = 0;
  var CELL_DARK = 1;
  var CELL_SPECULAR = 2;
  var CELL_SHIMMER = 3;
  var CELL_MEMBRANE = 4;
  var CELL_VEIN = 5;
  var CELL_BODY = 6;
  var CELL_TRANSLUCENT = 7;

  function setInk(ink, r, g, b, kind, glyphs) {
    ink.r = r;
    ink.g = g;
    ink.b = b;
    ink.kind = (kind === undefined) ? CELL_GRADIENT : kind;
    ink.glyphs = (glyphs === undefined) ? null : glyphs;
    return true;
  }

  var THEMES = {
    light: { background: [246, 243, 236], grid: [30, 34, 60, 0.07], trailAlpha: 0.7, ink: [42, 42, 59] },
    dark:  { background: [6, 7, 12],      grid: [255, 255, 255, 0.055], trailAlpha: 0.85, ink: [150, 160, 200] }
  };

  var RAMP_GRADIENT = '.:;+=*%#';
  var RAMP_DARK = '#%@';
  var RAMP_SPECULAR = 'o*';
  var RAMP_BODY = '8#@';
  var RAMP_VEIN = '.:+*';
  var RAMP_EDGE_HI = ':;';
  var RAMP_EDGE_LO = ".'`,";
  var SPARKLES = [[255, 255, 255], [228, 246, 255], [200, 244, 255]];

  var FLAG_EMPTY = 0;
  var FLAG_SOLID = 1;
  var FLAG_GLYPH = 2;

  var SUB_OFFSETS = [0.25, 0.3, 0.75, 0.3, 0.25, 0.72, 0.75, 0.72];

  function hueMatrix(deg) {
    var rad = (deg * Math.PI) / 180;
    var c = Math.cos(rad);
    var s = Math.sin(rad);
    return [
      0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
      0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
      0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072
    ];
  }

  function rgbCss(r, g, b) {
    return 'rgb(' + clamp(Math.round(r), 0, 255) + ',' + clamp(Math.round(g), 0, 255) + ',' + clamp(Math.round(b), 0, 255) + ')';
  }

  function packRgb(r, g, b) {
    return (clamp(Math.round(r), 0, 255) << 16) | (clamp(Math.round(g), 0, 255) << 8) | clamp(Math.round(b), 0, 255);
  }

  function angleGlyph(rad) {
    var a = rad % Math.PI;
    if (a < 0) a += Math.PI;
    return a < Math.PI / 8 || a >= (7 * Math.PI) / 8 ? '-'
         : a < (3 * Math.PI) / 8 ? '\\'
         : a < (5 * Math.PI) / 8 ? '|'
         : '/';
  }

  function parseCssColor(str) {
    if (!str) return null;
    var m = String(str).match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?/i);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : 1];
    var hex = String(str).trim().match(/^#([0-9a-f]{6})$/i);
    if (hex) {
      var n = parseInt(hex[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
    }
    return null;
  }

  function Pen(renderer) {
    this.ink = { r: 0, g: 0, b: 0, kind: 0, glyphs: null, au: 0, av: 0 };
    this.t = 0;
    this.theme = 'dark';
    this.a = { x: 0, y: 0 };
    this.b = { x: 0, y: 0 };
    this.r = renderer;
  }
  Object.defineProperty(Pen.prototype, 'cw', { get: function () { return this.r.cw; } });
  Object.defineProperty(Pen.prototype, 'ch', { get: function () { return this.r.ch; } });
  Object.defineProperty(Pen.prototype, 'cols', { get: function () { return this.r.cols; } });
  Object.defineProperty(Pen.prototype, 'rows', { get: function () { return this.r.rows; } });
  Object.defineProperty(Pen.prototype, 'contrast', { get: function () { return this.r.palette.ink; } });

  Pen.prototype.toWorld = function (pose, u, v, out) {
    var c = Math.cos(pose.heading);
    var s = Math.sin(pose.heading);
    out.x = pose.x + (u * c - v * s) * pose.span;
    out.y = pose.y + (u * s + v * c) * pose.span;
    return out;
  };
  Pen.prototype.fogFor = function (depth) { return (1 - depth) * this.r.tuning.fog; };
  Pen.prototype.shape = function (pose, radius, fn, opts) { this.r.shape(pose, radius, fn, opts || {}); };
  Pen.prototype.line = function (x1, y1, x2, y2, rgb, depth, tipCh, fog) {
    this.r.line(x1, y1, x2, y2, rgb, fog === undefined ? this.fogFor(depth) : fog, tipCh);
  };
  Pen.prototype.lineBody = function (pose, u1, v1, u2, v2, rgb, tipCh) {
    var p1 = this.toWorld(pose, u1, v1, this.a);
    var p2 = this.toWorld(pose, u2, v2, this.b);
    this.r.line(p1.x, p1.y, p2.x, p2.y, rgb, this.fogFor(pose.depth), tipCh);
  };
  Pen.prototype.dot = function (x, y, ch, rgb, depth, fog) {
    this.r.dot(x, y, ch, rgb, fog === undefined ? this.fogFor(depth) : fog);
  };
  Pen.prototype.spot = function (x, y, ch, fg, bg, depth) {
    this.r.spot(x, y, ch, fg, bg, this.fogFor(depth));
  };
  Pen.prototype.shed = function (x, y, amount) {
    if (!this.r.tuning.trail) return;
    this.r.shed(x, y, amount * this.r.tuning.trail);
  };
  Pen.prototype.cellIndex = function (x, y) { return this.r.cellIndex(x, y); };

  function CellRenderer(canvas, tuning) {
    this.cw = 12;
    this.ch = 18;
    this.cols = 0;
    this.rows = 0;
    this.palette = { background: [6, 7, 12], grid: [255, 255, 255, 0.055], trailAlpha: 0.85, ink: [150, 160, 200] };
    this.pen = new Pen(this);
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this.fontFamily = '"Cascadia Mono", Consolas, ui-monospace, Menlo, monospace';
    this.theme = 'dark';
    this.animal = null;
    this.energy = new Float32Array(0);
    this.energyTmp = new Float32Array(0);
    this.trailStyles = [];
    this.hue = hueMatrix(0);
    this.hueOn = false;
    this.cellFlag = new Uint8Array(0);
    this.cellFill = new Uint32Array(0);
    this.cellColor = new Uint32Array(0);
    this.cellGlyph = new Uint16Array(0);

    this.canvas = canvas;
    this.tuning = tuning;
    var ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.syncPaletteFromCss();
  }

  CellRenderer.prototype.setFontFamily = function (f) { if (f) this.fontFamily = f; };

  CellRenderer.prototype.syncPaletteFromCss = function () {
    var rootStyle = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
    var bodyStyle = (typeof getComputedStyle === 'function' && document.body) ? getComputedStyle(document.body) : null;
    var scheme = rootStyle && rootStyle.colorScheme === 'light' ? 'light' : 'dark';
    this.theme = scheme;
    this.pen.theme = scheme;
    var base = THEMES[scheme];
    var bgRgb = parseCssColor(bodyStyle && bodyStyle.backgroundColor) || parseCssColor(rootStyle && rootStyle.getPropertyValue('--bg')) || base.background;
    var gridRgba = parseCssColor(rootStyle && rootStyle.getPropertyValue('--grid')) || base.grid;
    this.palette = {
      background: [bgRgb[0], bgRgb[1], bgRgb[2]],
      grid: [gridRgba[0], gridRgba[1], gridRgba[2], gridRgba[3] !== undefined ? gridRgba[3] : base.grid[3]],
      trailAlpha: base.trailAlpha,
      ink: base.ink
    };
    this.restyle();
  };

  CellRenderer.prototype.setTheme = function (t) {
    this.theme = t;
    this.pen.theme = t;
    this.syncPaletteFromCss();
  };

  CellRenderer.prototype.setAnimal = function (animal, tuning) {
    this.animal = animal;
    this.tuning = tuning;
    this.energy.fill(0);
    this.restyle();
  };

  CellRenderer.prototype.restyle = function () {
    var pal = this.palette;
    var trailRgb = (this.animal && this.animal.trail && this.animal.trail[this.theme]) ? this.animal.trail[this.theme] : pal.ink;
    this.hue = hueMatrix(this.tuning.hueShift);
    this.hueOn = (this.tuning.hueShift % 360) !== 0;
    var rotated = this.turn(trailRgb[0], trailRgb[1], trailRgb[2]);
    var r = clamp(Math.round(rotated[0]), 0, 255);
    var g = clamp(Math.round(rotated[1]), 0, 255);
    var b = clamp(Math.round(rotated[2]), 0, 255);
    this.trailStyles = [];
    for (var i = 0; i < TRAIL_BUCKETS; i++) {
      this.trailStyles.push('rgba(' + r + ',' + g + ',' + b + ',' + ((pal.trailAlpha * (i + 1)) / TRAIL_BUCKETS).toFixed(3) + ')');
    }
    if (this.canvas && this.canvas.style) {
      this.canvas.style.opacity = String(this.tuning.opacity !== undefined ? this.tuning.opacity : 0.92);
    }
  };

  CellRenderer.prototype.turn = function (r, g, b) {
    if (!this.hueOn) return [r, g, b];
    var m = this.hue;
    return [
      m[0] * r + m[1] * g + m[2] * b,
      m[3] * r + m[4] * g + m[5] * b,
      m[6] * r + m[7] * g + m[8] * b
    ];
  };

  CellRenderer.prototype.fade = function (r, g, b, fog) {
    var bg = this.palette.background;
    return packRgb(r + (bg[0] - r) * fog, g + (bg[1] - g) * fog, b + (bg[2] - b) * fog);
  };

  CellRenderer.prototype.resize = function (w, h, dpr) {
    var prevCols = this.cols;
    var prevRows = this.rows;
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    this.cw = clamp(Math.round(Math.min(w, h) / 124 / this.tuning.detail), 4, 24);
    this.ch = Math.round(this.cw * 1.45);
    this.cols = Math.ceil(w / this.cw);
    this.rows = Math.ceil(h / this.ch);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    var total = this.cols * this.rows;
    if (this.cols !== prevCols || this.rows !== prevRows) {
      this.energy = new Float32Array(total);
      this.energyTmp = new Float32Array(total);
      this.cellFlag = new Uint8Array(total);
      this.cellFill = new Uint32Array(total);
      this.cellColor = new Uint32Array(total);
      this.cellGlyph = new Uint16Array(total);
    }
  };

  CellRenderer.prototype.drawGrid = function () {
    var gridAmt = this.tuning.grid;
    if (gridAmt <= 0) return;
    var g = this.palette.grid;
    var alpha = Math.min(0.65, g[3] * gridAmt);
    if (alpha <= 0.002) return;
    var ctx = this.ctx;
    var w = this.width;
    var h = this.height;
    var cw = this.cw;
    var ch = this.ch;
    var dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = 'rgba(' + Math.round(g[0]) + ',' + Math.round(g[1]) + ',' + Math.round(g[2]) + ',' + alpha.toFixed(3) + ')';
    ctx.lineWidth = 1;
    ctx.beginPath();
    var xCols = Math.ceil(w / cw);
    for (var cx = 0; cx <= xCols; cx++) {
      var px = Math.round(cx * cw * dpr) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h * dpr);
    }
    var yRows = Math.ceil(h / ch);
    for (var ry = 0; ry <= yRows; ry++) {
      var py = Math.round(ry * ch * dpr) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(w * dpr, py);
    }
    ctx.stroke();
  };

  CellRenderer.prototype.render = function (flock, dt) {
    if (this.cols === 0) return;
    var ctx = this.ctx;
    this.pen.t = flock.time;
    for (var ei = 0; ei < flock.events.length; ei++) {
      var ev = flock.events[ei];
      this.stamp(ev.x, ev.y, ev.radius, ev.amount);
    }
    flock.events.length = 0;
    this.diffuse(dt);
    this.cellFlag.fill(FLAG_EMPTY);

    var animal = flock.animal;
    if (animal.drawAll) {
      animal.drawAll(flock, this.pen);
    } else if (animal.draw) {
      for (var i = 0; i < flock.creatures.length; i++) {
        animal.draw(flock.creatures[i], this.pen, flock);
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawGrid();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawTrail(flock.time);
    ctx.font = '600 ' + Math.round(this.ch * 0.74) + 'px ' + this.fontFamily;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    this.drawCells();
  };

  CellRenderer.prototype.cellIndex = function (x, y) {
    var col = Math.floor(x / this.cw);
    var row = Math.floor(y / this.ch);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return -1;
    return row * this.cols + col;
  };

  CellRenderer.prototype.shed = function (x, y, amount) {
    var idx = this.cellIndex(x, y);
    if (idx < 0) return;
    this.energy[idx] = Math.min(1.4, this.energy[idx] + amount * 0.55);
  };

  CellRenderer.prototype.stamp = function (x, y, rad, amount) {
    var energy = this.energy;
    var cx = Math.floor(x / this.cw);
    var cy = Math.floor(y / this.ch);
    for (var row = cy - rad; row <= cy + rad; row++) {
      for (var col = cx - rad; col <= cx + rad; col++) {
        if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) continue;
        var dist = Math.hypot(col - cx, (row - cy) * 1.4);
        if (dist > rad + 0.5) continue;
        var idx = row * this.cols + col;
        energy[idx] = Math.min(1.6, energy[idx] + amount * (1 - dist / (rad + 1)));
      }
    }
  };

  CellRenderer.prototype.diffuse = function (dt) {
    var cols = this.cols;
    var rows = this.rows;
    var src = this.energy;
    var dst = this.energyTmp;
    var decay = Math.exp(-dt * this.tuning.trailFade);
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var idx = r * cols + c;
        var l = c > 0 ? src[idx - 1] : src[idx];
        var ri = c < cols - 1 ? src[idx + 1] : src[idx];
        var u = r > 0 ? src[idx - cols] : src[idx];
        var d = r < rows - 1 ? src[idx + cols] : src[idx];
        dst[idx] = (src[idx] * 4 + l + ri + u + d) * 0.125 * decay;
      }
    }
    this.energy = dst;
    this.energyTmp = src;
  };

  CellRenderer.prototype.drawTrail = function (t) {
    var ctx = this.ctx;
    var cols = this.cols;
    var cw = this.cw;
    var ch = this.ch;
    var energy = this.energy;
    var flag = this.cellFlag;
    var dotBase = Math.max(2, Math.round(cw * 0.19));
    for (var b = 0; b < TRAIL_BUCKETS; b++) {
      ctx.fillStyle = this.trailStyles[b];
      for (var idx = 0; idx < energy.length; idx++) {
        var val = energy[idx];
        if (val < 0.12 || flag[idx] === FLAG_SOLID) continue;
        var col = idx % cols;
        var row = (idx / cols) | 0;
        var flicker = 0.75 + 0.25 * Math.sin(t * 5 + hash3(col, row, 3) * 40);
        if (clamp(Math.floor(val * flicker * 4 * TRAIL_BUCKETS) - 1, 0, TRAIL_BUCKETS - 1) !== b) continue;
        var sz = val > 0.6 ? dotBase + 1 : dotBase;
        ctx.fillRect(Math.round(col * cw + cw * 0.5 - sz / 2), Math.round(row * ch + ch * 0.6 - sz / 2), sz, sz);
      }
    }
  };

  CellRenderer.prototype.probe = function (fn, pose, cos, sin, wx, wy) {
    var ink = this.pen.ink;
    var dx = wx - pose.x;
    var dy = wy - pose.y;
    var u = (dx * cos + dy * sin) / pose.span;
    var v = (dy * cos - dx * sin) / pose.span;
    ink.glyphs = null;
    ink.au = u;
    ink.av = v;
    return fn(u, v, wx, wy);
  };

  CellRenderer.prototype.shape = function (pose, radiusFrac, fn, opts) {
    var light = opts && opts.light !== undefined ? opts.light : 1;
    var tilt = opts && opts.tilt !== undefined ? opts.tilt : 0;
    var fog = opts && opts.fog !== undefined ? opts.fog : (1 - pose.depth) * this.tuning.fog;

    var flag = this.cellFlag;
    var fill = this.cellFill;
    var color = this.cellColor;
    var glyph = this.cellGlyph;
    var cw = this.cw;
    var ch = this.ch;
    var cols = this.cols;
    var rows = this.rows;
    var ink = this.pen.ink;
    var t = this.pen.t;
    var shimmer = this.tuning.shimmer;
    var sparkle = this.tuning.sparkle;
    var span = pose.span;
    var cos = Math.cos(pose.heading);
    var sin = Math.sin(pose.heading);
    var reach = radiusFrac * span;
    var c0 = Math.max(0, Math.floor((pose.x - reach) / cw));
    var c1 = Math.min(cols - 1, Math.floor((pose.x + reach) / cw));
    var r0 = Math.max(0, Math.floor((pose.y - reach) / ch));
    var r1 = Math.min(rows - 1, Math.floor((pose.y + reach) / ch));

    for (var row = r0; row <= r1; row++) {
      for (var col = c0; col <= c1; col++) {
        var x0 = col * cw;
        var y0 = row * ch;
        var centerHit = this.probe(fn, pose, cos, sin, x0 + cw / 2, y0 + ch / 2);
        var hits = centerHit ? 1 : 0;
        var ir = ink.r, ig = ink.g, ib = ink.b;
        var kind = ink.kind;
        var customGlyphs = ink.glyphs;
        var au = ink.au;
        var av = ink.av;

        for (var si = 0; si < SUB_OFFSETS.length; si += 2) {
          if (this.probe(fn, pose, cos, sin, x0 + SUB_OFFSETS[si] * cw, y0 + SUB_OFFSETS[si + 1] * ch)) {
            if (hits === 0) { ir = ink.r; ig = ink.g; ib = ink.b; }
            hits++;
          }
        }
        if (hits === 0) continue;

        var cov = hits / 5;
        var idx = row * cols + col;
        var solid = centerHit && cov >= 0.6;
        if (!solid && flag[idx] === FLAG_SOLID) continue;

        var rot = this.turn(ir, ig, ib);
        ir = rot[0]; ig = rot[1]; ib = rot[2];
        var shade = light * (1 + (hash3(col, row, Math.floor(t * 6)) - 0.5) * 0.06);
        if (solid && kind === CELL_SHIMMER) {
          shade *= 1 - 0.4 * shimmer + shimmer * Math.sin(t * 2.2 + au * 9 + av * 6 + tilt + pose.heading * 2);
        }
        ir *= shade; ig *= shade; ib *= shade;

        var cellSeed = (hash3(Math.round((au * span) / (cw * 0.9)), Math.round((av * span) / (cw * 0.9)), pose.id) * 4294967295) >>> 0;
        if (!solid) {
          var edgeStr = cov >= 0.5 ? RAMP_EDGE_HI : RAMP_EDGE_LO;
          flag[idx] = FLAG_GLYPH;
          color[idx] = this.fade(ir, ig, ib, Math.min(1, fog + 0.55 - 0.45 * cov));
          glyph[idx] = edgeStr.charCodeAt((cellSeed >>> 8) % edgeStr.length);
          continue;
        }

        if (kind === CELL_VEIN) {
          if (flag[idx] === FLAG_SOLID) continue;
          var vLum = (0.3 * ir + 0.59 * ig + 0.11 * ib) / 255;
          var vStr = customGlyphs || RAMP_VEIN;
          flag[idx] = FLAG_GLYPH;
          color[idx] = this.fade(ir, ig, ib, fog);
          glyph[idx] = vStr.charCodeAt(customGlyphs ? (cellSeed >>> 8) % vStr.length : clamp(Math.floor(vLum * vStr.length), 0, vStr.length - 1));
          continue;
        }

        flag[idx] = FLAG_SOLID;
        var spk = hash3(cellSeed, Math.floor(t * 2.4 + (cellSeed % 997) / 97), 7);
        var chStr, fgR, fgG, fgB;

        if (kind === CELL_MEMBRANE) {
          fill[idx] = this.fade(ir, ig, ib, Math.min(1, 0.62 + fog * 0.38));
          chStr = customGlyphs || RAMP_GRADIENT;
          color[idx] = this.fade(ir, ig, ib, fog);
          glyph[idx] = chStr.charCodeAt((cellSeed >>> 8) % chStr.length);
          if (spk < sparkle) color[idx] = packRgb.apply(null, SPARKLES[cellSeed % SPARKLES.length]);
          continue;
        }

        if (kind === CELL_TRANSLUCENT) {
          fill[idx] = this.fade(ir * 0.58, ig * 0.58, ib * 0.58, fog);
          chStr = customGlyphs || '.:*';
          color[idx] = spk < sparkle
            ? packRgb.apply(null, SPARKLES[cellSeed % SPARKLES.length])
            : this.fade(Math.min(255, ir * 1.05 + 50), Math.min(255, ig * 1.05 + 50), Math.min(255, ib * 1.05 + 50), fog);
          glyph[idx] = chStr.charCodeAt((cellSeed >>> 8) % chStr.length);
          continue;
        }

        var faded = this.fade(ir, ig, ib, fog);
        fill[idx] = faded;
        var fr = faded >>> 16;
        var fg = (faded >>> 8) & 255;
        var fb = faded & 255;

        if (kind === CELL_BODY) {
          chStr = customGlyphs || RAMP_BODY;
          fgR = fr * 1.6 + 44; fgG = fg * 1.6 + 40; fgB = fb * 1.6 + 36;
        } else if (kind === CELL_DARK) {
          chStr = customGlyphs || RAMP_DARK;
          fgR = fr * 1.7 + 34; fgG = fg * 1.7 + 30; fgB = fb * 1.7 + 30;
        } else if (kind === CELL_SPECULAR) {
          chStr = customGlyphs || RAMP_SPECULAR;
          fgR = fr * 0.4; fgG = fg * 0.4; fgB = fb * 0.4;
        } else {
          chStr = customGlyphs || RAMP_GRADIENT;
          fgR = fr * 0.42; fgG = fg * 0.42; fgB = fb * 0.42;
        }

        var chCode;
        if (customGlyphs || (kind !== CELL_GRADIENT && kind !== CELL_SHIMMER)) {
          chCode = chStr.charCodeAt((cellSeed >>> 8) % chStr.length);
        } else {
          var lum = (0.3 * fr + 0.59 * fg + 0.11 * fb) / 255;
          var jitter = ((cellSeed >>> 4) % 3) - 1;
          chCode = chStr.charCodeAt(clamp(Math.floor((1 - lum) * (chStr.length - 0.01)) + jitter, 0, chStr.length - 1));
        }
        glyph[idx] = chCode;
        var spkRate = kind === CELL_SHIMMER ? sparkle : (kind === CELL_GRADIENT ? sparkle / 3 : 0);
        color[idx] = spk < spkRate ? packRgb.apply(null, SPARKLES[cellSeed % SPARKLES.length]) : packRgb(fgR, fgG, fgB);
      }
    }
  };

  CellRenderer.prototype.line = function (x1, y1, x2, y2, rgb, fog, tipCh) {
    var rot = this.turn(rgb[0], rgb[1], rgb[2]);
    var packed = this.fade(rot[0], rot[1], rot[2], fog);
    var chCode = angleGlyph(Math.atan2(y2 - y1, x2 - x1)).charCodeAt(0);
    var steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (this.cw * 0.5)));
    var lastIdx = -1;
    for (var s = 1; s <= steps; s++) {
      var idx = this.cellIndex(x1 + ((x2 - x1) * s) / steps, y1 + ((y2 - y1) * s) / steps);
      if (idx < 0 || this.cellFlag[idx] === FLAG_SOLID) continue;
      this.cellFlag[idx] = FLAG_GLYPH;
      this.cellColor[idx] = packed;
      this.cellGlyph[idx] = chCode;
      lastIdx = idx;
    }
    if (tipCh && lastIdx >= 0) this.cellGlyph[lastIdx] = tipCh.charCodeAt(0);
  };

  CellRenderer.prototype.dot = function (x, y, ch, rgb, fog) {
    var idx = this.cellIndex(x, y);
    if (idx < 0 || this.cellFlag[idx] === FLAG_SOLID) return;
    var rot = this.turn(rgb[0], rgb[1], rgb[2]);
    this.cellFlag[idx] = FLAG_GLYPH;
    this.cellColor[idx] = this.fade(rot[0], rot[1], rot[2], fog);
    this.cellGlyph[idx] = ch.charCodeAt(0);
  };

  CellRenderer.prototype.spot = function (x, y, ch, fg, bg, fog) {
    var idx = this.cellIndex(x, y);
    if (idx < 0) return;
    var frot = this.turn(fg[0], fg[1], fg[2]);
    var brot = this.turn(bg[0], bg[1], bg[2]);
    this.cellFlag[idx] = FLAG_SOLID;
    this.cellFill[idx] = this.fade(brot[0], brot[1], brot[2], fog);
    this.cellColor[idx] = this.fade(frot[0], frot[1], frot[2], fog);
    this.cellGlyph[idx] = ch.charCodeAt(0);
  };

  CellRenderer.prototype.drawCells = function () {
    var ctx = this.ctx;
    var cols = this.cols;
    var cw = this.cw;
    var ch = this.ch;
    var flag = this.cellFlag;
    var fill = this.cellFill;
    var color = this.cellColor;
    var glyph = this.cellGlyph;
    var total = cols * this.rows;
    for (var i = 0; i < total; i++) {
      var fl = flag[i];
      if (!fl) continue;
      var x = (i % cols) * cw;
      var y = ((i / cols) | 0) * ch;
      if (fl === FLAG_SOLID) {
        var f = fill[i];
        ctx.fillStyle = rgbCss(f >>> 16, (f >>> 8) & 255, f & 255);
        ctx.fillRect(x + 1, y + 1, cw - 1, ch - 1);
      }
      var c = color[i];
      ctx.fillStyle = rgbCss(c >>> 16, (c >>> 8) & 255, c & 255);
      ctx.fillText(String.fromCharCode(glyph[i]), x + cw / 2, y + ch / 2 + 1);
    }
  };

  /* ---------------------------------------------------------------- creatures */

  // 1. BUTTERFLY (exact Pn from ascii-animals-extension)
  var BF_FORE = { from: -0.3, to: 1, reach: 0.56, peak: 0.55, round: 0.5, scallop: 0 };
  var BF_HIND = { from: -1.45, to: 0.15, reach: 0.44, peak: 0.48, round: 0.42, scallop: 0.04 };
  var BF_BODY = [30, 30, 42];
  var bfProbe = { t: 0, r: 0 };
  function bfWingArc(w, ang, t) {
    if (t <= 0 || t >= 1) return 0;
    var s = t < w.peak ? (t / w.peak) * 0.5 : 0.5 + ((t - w.peak) / (1 - w.peak)) * 0.5;
    var r = w.reach * Math.pow(Math.sin(Math.PI * s), w.round);
    return w.scallop ? r * (1 - w.scallop * (0.5 + 0.5 * Math.cos(t * Math.PI * 14))) : r;
  }
  function bfBodyHalfW(x) {
    if (x > 0.17 || x < -0.32) return 0;
    if (x > 0.11) return Math.sqrt(Math.max(0, 0.03 * 0.03 - (x - 0.14) * (x - 0.14)));
    if (x > -0.04) return 0.034;
    return 0.03 * (1 - 0.6 * ((-0.04 - x) / 0.28));
  }
  function bfInWing(w, u, v) {
    var ang = Math.atan2(u, v);
    var t = (ang - w.from) / (w.to - w.from);
    var maxR = bfWingArc(w, ang, t);
    var r = Math.hypot(u, v);
    if (r > maxR) return false;
    bfProbe.t = t;
    bfProbe.r = r / maxR;
    return true;
  }
  var Butterflies = {
    key: 'butterflies',
    label: 'Butterfly',
    swatch: [50, 135, 255],
    defaults: Object.assign({}, BASE_TUNING, {
      density: 1.05, speed: 1.05, sway: 0, spread: 0, size: 1.25, farthest: 0.18,
      farBias: 1.7, grip: 5, separation: 700, trail: 0, trailFade: 0.8,
      flutter: 0, glide: 2.75, flapRate: 1
    }),
    controls: [['Flight', [
      { key: 'flutter', label: 'Flutter', min: 0, max: 3, step: 0.05, hint: 'How much their path zigzags.' },
      { key: 'glide', label: 'Glide', min: 0, max: 4, step: 0.05, hint: 'How often they stop flapping and glide with wings flat.' },
      { key: 'flapRate', label: 'Flap rate', min: 0.2, max: 3, step: 0.05, hint: 'How fast their wings beat.' }
    ]]],
    area: 48000,
    scale: 1,
    speed: 90,
    trail: { light: [70, 118, 226], dark: [96, 156, 255] },
    create: function (base) {
      return Object.assign({}, base, { phase: randRange(0, TAU), open: 1, glide: 0, glideUntil: 0, flutterX: 0, flutterY: 0 });
    },
    enter: function (c) { c.flutterX = 0; c.flutterY = 0; },
    update: function (c, flock, dt) {
      var tu = flock.tuning;
      var t = flock.time;
      var sp = flock.cruise(c);
      var acc = flock.begin();
      flock.steer(c, flock.getHeading() + c.bias * tu.spread, sp, tu.grip);
      var j = Math.sqrt(dt) * 520 * 1.3 * tu.flutter * (1 - 0.8 * c.glide) * (0.5 + 0.5 * c.depth);
      c.flutterX += -c.flutterX * 3 * dt + (Math.random() * 2 - 1) * j;
      c.flutterY += -c.flutterY * 3 * dt + (Math.random() * 2 - 1) * j;
      acc.x += c.flutterX;
      acc.y += c.flutterY;
      var stroke = Math.max(0, -Math.sin(c.phase)) * (1 - c.glide);
      acc.x += Math.cos(c.heading) * stroke * sp * 1.4;
      acc.y += Math.sin(c.heading) * stroke * sp * 1.4;
      flock.separate(c);
      var mv = flock.move(c, dt, sp * 2.2);
      if (flock.passed(c)) flock.reenter(c);
      if (mv > 12) flock.face(c, dt);
      if (c.glide < 0.5 && t > c.glideUntil && mv > sp * 0.5 && Math.random() < 0.35 * tu.glide * dt) {
        c.glideUntil = t + randRange(0.5, 1.4);
      }
      c.glide += ((t < c.glideUntil ? 1 : 0) - c.glide) * Math.min(1, dt * 6);
      var pace = clamp(mv / (sp * 2), 0, 1);
      c.phase += dt * TAU * 2.6 * tu.flapRate * (0.8 + 0.6 * pace) * (1 - 0.9 * c.glide);
      var beat = Math.pow(0.5 + 0.5 * Math.cos(c.phase), 0.8);
      c.open = 0.1 + 0.9 * (beat * (1 - c.glide) + 0.96 * c.glide);
    },
    startle: function (c, nx, ny, power, flock) {
      var imp = power * 420 * c.depth;
      c.vx += nx * imp;
      c.vy += ny * imp;
      c.startledUntil = flock.time + randRange(0.6, 1.2);
      c.glideUntil = 0;
    },
    draw: function (c, pen) {
      var span = c.span;
      var open = Math.max(0.08, c.open);
      var ink = pen.ink;
      var pose = { x: c.x, y: c.y, heading: c.heading + 0.06 * Math.sin(c.phase), span: span, depth: c.depth, id: c.id };
      var bodyPad = pen.cw * 0.4;
      pen.shape(pose, 0.75, function (u, v) {
        var av = Math.abs(v);
        var bw = bfBodyHalfW(u);
        if (bw > 0 && av * span <= Math.max(bw * span, bodyPad)) return setInk(ink, BF_BODY[0], BF_BODY[1], BF_BODY[2], CELL_BODY);
        var rv = av / open;
        var which;
        if (bfInWing(BF_FORE, u - 0.06, rv)) which = 0;
        else if (bfInWing(BF_HIND, u + 0.02, rv)) which = 1;
        else return false;
        var wt = bfProbe.t;
        var wr = bfProbe.r;
        if (wr > 0.86) {
          return (which === 0 && wr < 0.95 && Math.abs(fract(wt * 5) - 0.5) < 0.14)
            ? setInk(ink, 236, 240, 255, CELL_SPECULAR)
            : setInk(ink, 22, 28, 62, CELL_DARK);
        }
        if (wr < 0.08) return setInk(ink, 26, 44, 110, CELL_DARK);
        if (which === 0 && wt > 0.9) return setInk(ink, 30, 50, 120, CELL_DARK);
        return setInk(ink, 50 + 70 * wr, 135 + 60 * wr, 255, CELL_SHIMMER);
      }, { light: 0.6 + 0.4 * c.open, tilt: c.open * 3 });

      var sway = 0.012 * Math.sin(pen.t * 3 + c.id);
      var sides = [-1, 1];
      for (var si = 0; si < 2; si++) {
        var s = sides[si];
        pen.lineBody(pose, 0.16, 0.012 * s, 0.37 + sway, (0.12 + sway) * s, pen.contrast, span > 120 ? 'o' : undefined);
      }
      var stroke = Math.max(0, -Math.sin(c.phase)) * (1 - c.glide);
      var tipA = BF_FORE.from + (BF_FORE.to - BF_FORE.from) * BF_FORE.peak;
      var tipU = 0.06 + Math.sin(tipA) * BF_FORE.reach * 0.95;
      var tipV = Math.cos(tipA) * BF_FORE.reach * 0.95 * c.open;
      var wp = { x: 0, y: 0 };
      for (var wi = 0; wi < 2; wi++) {
        pen.toWorld(pose, tipU, tipV * sides[wi], wp);
        pen.shed(wp.x, wp.y, (0.02 + 0.1 * stroke) * c.depth);
      }
    }
  };

  // 2. PAPER AIRPLANE (built on the exact same CellRenderer shader & Flock physics)
  var Airplane = {
    key: 'airplane',
    label: 'Airplane',
    swatch: [156, 208, 255],
    defaults: Object.assign({}, BASE_TUNING, {
      density: 0.85, speed: 1.35, sway: 0.08, spread: 0.05, size: 1.2, farthest: 0.3,
      farBias: 1.4, grip: 2.8, separation: 420, trail: 1.4, trailFade: 1.2,
      sparkle: 0.16, shimmer: 0.45, swoop: 1.0, bankRate: 1.0, contrail: 1.0
    }),
    controls: [['Flight', [
      { key: 'swoop', label: 'Swoop', min: 0, max: 2.5, step: 0.05, hint: 'Gentle soaring pitch and speed swells.' },
      { key: 'bankRate', label: 'Bank speed', min: 0.2, max: 3, step: 0.05, hint: 'How quickly the wings tilt side to side while gliding.' },
      { key: 'contrail', label: 'Wingtip trail', min: 0, max: 3, step: 0.05, hint: 'Crisp vapor trail shed from folded wingtips.' }
    ]]],
    area: 54000,
    scale: 1.15,
    speed: 105,
    trail: { light: [95, 148, 220], dark: [156, 208, 255] },
    create: function (base) {
      return Object.assign({}, base, { phase: randRange(0, TAU), bank: 0 });
    },
    enter: function (c) { c.bank = 0; },
    update: function (c, flock, dt) {
      var tu = flock.tuning;
      var t = flock.time;
      var sp = flock.cruise(c);
      var surge = 1 + 0.24 * tu.swoop * Math.sin(c.phase * 0.7);
      var course = flock.getHeading() + c.bias * tu.spread + 0.12 * tu.swoop * Math.sin(t * 0.8 + c.id);
      flock.begin();
      flock.steer(c, course, sp * surge, tu.grip);
      flock.separate(c, tu.separation, 0.48);
      var mv = flock.move(c, dt, sp * 2.2);
      if (flock.passed(c)) flock.reenter(c);
      if (mv > 8) flock.face(c, dt, 4.5);
      c.phase += dt * TAU * 0.42 * tu.bankRate;
      c.bank = 0.65 * Math.sin(c.phase);
    },
    startle: function (c, nx, ny, power, flock) {
      var dir = Math.atan2(ny, nx);
      var boost = flock.cruise(c) * (1.8 + 1.8 * power);
      c.vx = Math.cos(dir) * boost;
      c.vy = Math.sin(dir) * boost;
      c.heading = dir;
      c.startledUntil = flock.time + randRange(0.7, 1.3);
    },
    draw: function (c, pen, flock) {
      var tu = flock.tuning;
      var pose = { x: c.x, y: c.y, heading: c.heading, span: c.span, depth: c.depth, id: c.id };
      var ink = pen.ink;
      var roll = 0.84 + 0.16 * Math.cos(c.phase);
      pen.shape(pose, 0.65, function (u, v) {
        if (u > 0.46 || u < -0.34) return false;
        var norm = (0.46 - u) / 0.8; // 0 nose -> 1 tail
        var sideShift = c.bank * 0.08 * (1 - norm);
        var vs = (v - sideShift) / roll;
        var av = Math.abs(vs);
        var wingW = 0.025 + 0.36 * norm;
        if (av > wingW) return false;
        // Center tail delta cutout
        if (u < -0.20 && av < (-0.20 - u) * 0.85) return false;
        // Center folded paper keel crease
        var creaseW = 0.042 * (1 - 0.35 * norm) + 0.012;
        if (av <= creaseW) return setInk(ink, 82, 114, 174, CELL_DARK);
        // Leading wing bevel trim
        if (av > wingW * 0.86) return setInk(ink, 198, 228, 255, CELL_SHIMMER);
        // Left / right folded paper panes
        if (vs < 0) return setInk(ink, 234, 242, 255, CELL_SHIMMER);
        return setInk(ink, 162, 196, 238, CELL_GRADIENT);
      }, { light: 0.92 + 0.14 * Math.sin(c.phase), tilt: c.bank * 2 });

      // Crisp fuselage highlight line & wingtip vapor trail
      pen.lineBody(pose, 0.45, 0, -0.2, 0, [215, 232, 255]);
      var wp = { x: 0, y: 0 };
      var tips = [-1, 1];
      for (var i = 0; i < 2; i++) {
        pen.toWorld(pose, -0.33, 0.36 * roll * tips[i], wp);
        pen.shed(wp.x, wp.y, 0.035 * tu.contrail * c.depth);
      }
    }
  };

  // 3. CRAB (exact Wn from ascii-animals-extension)
  var CRAB_SHELL = [204, 82, 52];
  var CRAB_HI = [232, 132, 92];
  var CRAB_SPOT = [140, 46, 32];
  var CRAB_CLAW = [214, 92, 56];
  var CRAB_TIP = [60, 30, 30];
  var CRAB_LEG = [186, 72, 44];
  var CRAB_LEG_BASES = [0.07, -0.01, -0.08, -0.14];
  var Crabs = {
    key: 'crabs',
    label: 'Crab',
    swatch: CRAB_SHELL,
    defaults: Object.assign({}, BASE_TUNING, {
      detail: 1.7, fog: 0.12, density: 1.8, sway: 0, spread: 0, farthest: 0.25,
      farBias: 0.7, grip: 3, separation: 400, trail: 1.2, trailFade: 0.35,
      shimmer: 0.1, sparkle: 0.03, burst: 1, rest: 1, legSpeed: 1, scare: 0.55
    }),
    controls: [['Scuttling', [
      { key: 'burst', label: 'Burst length', min: 0.2, max: 4, step: 0.05, hint: 'How long each scuttle lasts.' },
      { key: 'rest', label: 'Pause length', min: 0, max: 4, step: 0.05, hint: 'How long they pause between scuttles. 0 means never stop.' },
      { key: 'legSpeed', label: 'Leg speed', min: 0.2, max: 3, step: 0.05, hint: 'How fast the legs step.' },
      { key: 'scare', label: 'Scare', min: 0, max: 3, step: 0.05, hint: 'How fast and far crabs bolt when you tap near them.' }
    ]]],
    area: 70000,
    scale: 0.8,
    speed: 95,
    trail: { light: [176, 146, 104], dark: [206, 178, 136] },
    create: function (base) {
      return Object.assign({}, base, {
        running: true, until: 0, facing: Math.random() < 0.5 ? 1 : -1,
        gait: randRange(0, TAU), alarm: 0, fleeDir: 0, fleeSpeed: 0, fleeFrom: 0
      });
    },
    enter: function (c, flock) {
      c.running = true;
      c.until = flock.time + randRange(0.3, 1.2);
      c.heading = flock.getCourse() - (c.facing * Math.PI) / 2;
    },
    update: function (c, flock, dt) {
      var tu = flock.tuning;
      var t = flock.time;
      if (t >= c.until) {
        c.running = !c.running || tu.rest <= 0;
        c.until = t + (c.running ? randRange(0.5, 1.6) * tu.burst : randRange(0.3, 1.4) * tu.rest);
      }
      var sp = flock.cruise(c);
      var target = flock.getHeading() + c.bias * tu.spread;
      var fleeing = t < c.startledUntil;
      var fprog = fleeing ? (t - c.fleeFrom) / (c.startledUntil - c.fleeFrom) : 1;
      var aimDir = fleeing ? c.fleeDir : target;
      flock.begin();
      if (fleeing) {
        flock.steer(c, c.fleeDir, Math.max(sp, c.fleeSpeed * (1 - fprog * fprog)), 8);
      } else {
        flock.steer(c, target, c.running ? sp : 0, tu.grip * 2);
      }
      flock.separate(c);
      var mv = flock.move(c, dt, fleeing ? Math.max(sp * 2, c.fleeSpeed) : sp * 2);
      if (flock.passed(c)) flock.reenter(c);
      var turnDir = fleeing && Math.abs(angleDiff(c.heading + (c.facing * Math.PI) / 2, aimDir)) > Math.PI / 2 ? -c.facing : c.facing;
      var desiredHeading = aimDir - (turnDir * Math.PI) / 2;
      var turnCap = (fleeing ? 10 : 3) * dt;
      c.heading += Math.max(-turnCap, Math.min(turnCap, angleDiff(c.heading, desiredHeading)));
      c.gait += (dt * mv * tu.legSpeed) / Math.max(4, c.span * 0.09);
      c.alarm = Math.max(0, c.alarm - dt * 0.7);
    },
    startle: function (c, nx, ny, power, flock) {
      var tu = flock.tuning;
      if (tu.scare <= 0) return;
      c.fleeDir = Math.atan2(ny, nx) + randRange(-0.35, 0.35);
      c.fleeSpeed = flock.cruise(c) * (2.5 + 3 * power) * tu.scare;
      c.fleeFrom = flock.time;
      c.startledUntil = flock.time + (1 + 1.5 * power) * Math.sqrt(tu.scare);
      c.vx = Math.cos(c.fleeDir) * c.fleeSpeed;
      c.vy = Math.sin(c.fleeDir) * c.fleeSpeed;
      c.running = true;
      c.until = c.startledUntil + randRange(0.3, 1);
      c.alarm = 1;
    },
    draw: function (c, pen) {
      var span = c.span;
      var ink = pen.ink;
      var pose = { x: c.x, y: c.y, heading: c.heading, span: span, depth: c.depth, id: c.id };
      var foot = { x: 0, y: 0 };
      var sides = [-1, 1];
      for (var si = 0; si < 2; si++) {
        var side = sides[si];
        for (var li = 0; li < CRAB_LEG_BASES.length; li++) {
          var baseU = CRAB_LEG_BASES[li];
          var ph = c.gait + li * Math.PI * 0.5 + (side > 0 ? Math.PI : 0);
          var lift = Math.max(0, Math.sin(ph));
          var stepX = 0.04 * Math.cos(ph);
          var spreadU = (li - 1.5) * 0.06;
          var ku = baseU + spreadU * 0.6;
          var kv = (0.36 - 0.03 * lift) * side;
          var fu = baseU + spreadU * 1.4 + stepX;
          var fv = (0.52 + 0.03 * Math.cos(ph) - 0.06 * lift) * side;
          pen.lineBody(pose, baseU, 0.22 * side, ku, kv, CRAB_LEG);
          pen.lineBody(pose, ku, kv, fu, fv, CRAB_LEG);
          if (lift < 0.05 && Math.cos(ph) > 0.9) {
            pen.toWorld(pose, fu, fv, foot);
            pen.shed(foot.x, foot.y, 0.12 * c.depth);
          }
        }
      }
      var al = c.alarm;
      pen.shape(pose, 0.62, function (u, v) {
        var av = Math.abs(v);
        var nu = Math.abs(u / 0.17);
        var nv = av / 0.27;
        var teeth = u > 0.06 ? 0.06 * (0.5 + 0.5 * Math.cos(nv * Math.PI * 7)) : 0;
        if (Math.pow(nu, 2.2) + Math.pow(nv, 2.4) <= 1 - teeth) {
          if (spotPattern(u, v, 0.05, 0.012, c.id)) return setInk(ink, CRAB_SPOT[0], CRAB_SPOT[1], CRAB_SPOT[2], CELL_DARK);
          if (Math.abs(av - 0.08) < 0.01 && u > -0.08 && u < 0.05) return setInk(ink, CRAB_SPOT[0], CRAB_SPOT[1], CRAB_SPOT[2], CELL_DARK, '|');
          if (inEllipse(u, av, 0.01, 0, 0.1, 0.13)) return setInk(ink, CRAB_HI[0], CRAB_HI[1], CRAB_HI[2]);
          return setInk(ink, CRAB_SHELL[0], CRAB_SHELL[1], CRAB_SHELL[2]);
        }
        var cu = 0.26 + 0.07 * al;
        var cv = 0.25 + 0.05 * al;
        if (segDist(u, av, 0.12, 0.17, cu, cv) < 0.034) return setInk(ink, CRAB_CLAW[0], CRAB_CLAW[1], CRAB_CLAW[2], CELL_GRADIENT);
        var pu = 0.34 + 0.08 * al;
        var pv = 0.19 + 0.04 * al;
        var ps = 1 + 0.15 * al;
        var ang = 0.55;
        var rx = ((u - pu) * Math.cos(ang) - (av - pv) * Math.sin(ang)) / ps;
        var ry = ((u - pu) * Math.sin(ang) + (av - pv) * Math.cos(ang)) / ps;
        if ((rx / 0.09) * (rx / 0.09) + (ry / 0.055) * (ry / 0.055) <= 1) {
          var gap = 0.15 + 0.55 * al;
          if (rx > 0.02 && Math.abs(ry) < gap * (rx - 0.02)) return false;
          return rx > 0.06 ? setInk(ink, CRAB_TIP[0], CRAB_TIP[1], CRAB_TIP[2], CELL_DARK) : setInk(ink, CRAB_CLAW[0], CRAB_CLAW[1], CRAB_CLAW[2], CELL_GRADIENT);
        }
        return false;
      });
      var eyeSpread = Math.min(0.14, Math.max(0.06, (pen.cw * 0.55) / span));
      for (var ei = 0; ei < 2; ei++) {
        pen.toWorld(pose, 0.2, eyeSpread * sides[ei], foot);
        pen.spot(foot.x, foot.y, '\u25cf', [255, 252, 246], [14, 10, 10], c.depth);
      }
    }
  };

  // 4. CRANE (exact jn from ascii-animals-extension)
  var CR_SHOULDER = 0.045;
  var CR_WRIST = 0.25;
  var CR_SPAN = 0.5;
  var CR_WHITE = [236, 238, 242];
  var CR_BLACK = [32, 32, 38];
  var CR_NECK = [78, 78, 92];
  var CR_RED = [226, 36, 36];
  var CR_BEAK = [196, 196, 150];
  var CR_LEG = [60, 60, 66];
  var crPt = { x: 0, y: 0 };
  var crWingProbe = { s: 0, q: 0 };
  var crPose = { arm: 1, hand: 1, sweep: 0, lift: 0 };
  var crFold = { u: 0, v: 0 };
  function crWingShape(u, v) {
    if (v < CR_SHOULDER || v > CR_SPAN) return false;
    var s = (v - CR_SHOULDER) / (CR_SPAN - CR_SHOULDER);
    var lead = 0.12 + 0.03 * s - 0.09 * s * s;
    var trail = (-0.075 + 0.03 * s) * 1.2;
    if (s < 0.78) trail += 0.012 * (0.5 + 0.5 * Math.cos(s * TAU * 9));
    var back = s > 0.72 ? lerp(trail, lead - 0.015, Math.pow((s - 0.72) / 0.28, 1.4)) : trail;
    if (u > lead || u < back) return false;
    var q = (u - back) / (lead - back);
    if (s > 0.78 && q < 0.92 && fract(q * 6) < 0.24) return false;
    crWingProbe.s = s;
    crWingProbe.q = q;
    return true;
  }
  function crUpdateFold(c, foldFlap) {
    if (!foldFlap) {
      var beat = Math.pow(0.5 + 0.5 * Math.cos(c.phase), 0.8);
      var ext = Math.max(0.12, 0.25 + 0.75 * (beat * (1 - c.glide) + c.glide));
      crPose.arm = ext; crPose.hand = ext; crPose.sweep = 0; crPose.lift = 0;
      return;
    }
    var p = fract(c.phase / TAU);
    var downFrac = 0.6;
    var maxUp = 0.85;
    var maxDown = -0.6;
    var smooth = function (x) { return 0.5 - 0.5 * Math.cos(Math.PI * x); };
    var ang, sw, wristFold;
    if (p < downFrac) {
      var k = p / downFrac;
      ang = lerp(maxUp, maxDown, smooth(k));
      sw = -0.12 * Math.sin(Math.PI * k);
      wristFold = 0;
      crPose.lift = Math.sin(Math.PI * k);
    } else {
      var k2 = (p - downFrac) / (1 - downFrac);
      ang = lerp(maxDown, maxUp, smooth(k2));
      sw = 1.05 * Math.sin(Math.PI * k2);
      wristFold = 0.45 * Math.sin(Math.PI * k2);
      crPose.lift = 0;
    }
    var g = c.glide;
    ang = lerp(ang, 0.1, g);
    crPose.sweep = lerp(sw, 0, g);
    crPose.arm = Math.cos(ang);
    crPose.hand = Math.max(0.2, Math.cos(ang + Math.sign(ang || 1) * wristFold * (1 - g)));
    crPose.lift *= (1 - g);
  }
  function crUnfold(u, v) {
    var elbowV = CR_SHOULDER + (CR_WRIST - CR_SHOULDER) * crPose.arm;
    var pivotU = 0.03;
    var du = u - pivotU;
    var dv = v - elbowV;
    var cs = Math.cos(crPose.sweep);
    var sn = Math.sin(crPose.sweep);
    var along = -du * sn + dv * cs;
    if (v <= elbowV || along < 0) {
      crFold.u = u;
      crFold.v = CR_SHOULDER + (v - CR_SHOULDER) / crPose.arm;
    } else {
      crFold.u = pivotU + du * cs + dv * sn;
      crFold.v = CR_WRIST + along / crPose.hand;
    }
    return crFold;
  }
  var Cranes = {
    key: 'cranes',
    label: 'Crane',
    swatch: [214, 220, 238],
    defaults: Object.assign({}, BASE_TUNING, {
      detail: 1.7, density: 0.8, speed: 1.5, sway: 0, spread: 0, farthest: 0.35,
      farBias: 1.3, grip: 3, separation: 150, trail: 0, shimmer: 0.1, sparkle: 0.04,
      wingbeat: 1, glide: 1, foldFlap: false
    }),
    controls: [['Flight', [
      { key: 'wingbeat', label: 'Wingbeat', min: 0.3, max: 2.5, step: 0.05, hint: 'How fast they flap.' },
      { key: 'glide', label: 'Glide', min: 0, max: 4, step: 0.05, hint: 'How often they stop flapping and glide.' },
      { key: 'foldFlap', label: 'Folding flap', toggle: true, hint: 'Articulated wrist fold on quick upstroke.' }
    ]]],
    area: 55000,
    scale: 1.45,
    speed: 85,
    trail: { light: [150, 152, 170], dark: [200, 204, 226] },
    create: function (base) {
      return Object.assign({}, base, { phase: randRange(0, TAU), pace: 0.8 + 0.4 * hash3(base.id, 5, 9), glide: 0, glideUntil: 0 });
    },
    update: function (c, flock, dt) {
      var tu = flock.tuning;
      var t = flock.time;
      var sp = flock.cruise(c);
      var aim = flock.getHeading() + c.bias * tu.spread;
      flock.begin();
      flock.steer(c, aim, sp, tu.grip);
      flock.separate(c, tu.separation, 0.45);
      flock.move(c, dt, sp * 1.6);
      if (flock.passed(c)) flock.reenter(c);
      flock.face(c, dt, 2, aim);
      if (c.glide < 0.5 && t > c.glideUntil && Math.random() < 0.25 * tu.glide * dt) {
        c.glideUntil = t + randRange(1, 2.5);
      }
      c.glide += ((t < c.glideUntil ? 1 : 0) - c.glide) * Math.min(1, dt * 3);
      c.phase += dt * TAU * 1.25 * tu.wingbeat * c.pace * (1 - 0.92 * c.glide);
    },
    draw: function (c, pen, flock) {
      crUpdateFold(c, flock.tuning.foldFlap);
      var span = c.span * (1 + 0.025 * crPose.lift);
      var ink = pen.ink;
      var pose = { x: c.x, y: c.y, heading: c.heading, span: span, depth: c.depth, id: c.id };
      var neckW = Math.max(0.018, (pen.cw * 0.45) / span);
      var headR = Math.max(0.032, (pen.cw * 0.6) / span);
      var sides = [-1, 1];
      for (var li = 0; li < 2; li++) pen.lineBody(pose, -0.2, 0.014 * sides[li], -0.62, 0.022 * sides[li], CR_LEG);
      pen.lineBody(pose, 0.47, 0, 0.6, 0, CR_BEAK);
      pen.shape(pose, 0.66, function (u, v) {
        var av = Math.abs(v);
        if (Math.hypot(u - 0.44, av) < headR) return setInk(ink, CR_BLACK[0], CR_BLACK[1], CR_BLACK[2], CELL_DARK);
        if (u > 0.12 && u < 0.43 && av < neckW) return u > 0.28 ? setInk(ink, CR_NECK[0], CR_NECK[1], CR_NECK[2], CELL_DARK) : setInk(ink, CR_WHITE[0], CR_WHITE[1], CR_WHITE[2]);
        if (inEllipse(u, av, -0.19, 0, 0.08, 0.045 + 0.4 * Math.pow(Math.max(0, -0.12 - u), 1.2))) return setInk(ink, CR_WHITE[0], CR_WHITE[1], CR_WHITE[2]);
        if (inEllipse(u, av, 0, 0, 0.16, 0.055)) return setInk(ink, CR_WHITE[0], CR_WHITE[1], CR_WHITE[2]);
        if (av <= CR_SHOULDER) return false;
        var p = crUnfold(u, av);
        if (!crWingShape(p.u, p.v)) return false;
        if (crWingProbe.q < 0.42 && crWingProbe.s < 0.7) return setInk(ink, CR_BLACK[0], CR_BLACK[1], CR_BLACK[2], CELL_DARK);
        var b = 0.9 + 0.1 * crWingProbe.q;
        return setInk(ink, CR_WHITE[0] * b, CR_WHITE[1] * b, CR_WHITE[2] * b, CELL_GRADIENT);
      }, { light: 0.82 + 0.18 * crPose.arm });

      pen.toWorld(pose, 0.445, 0, crPt);
      pen.spot(crPt.x, crPt.y, '@', [255, 214, 200], CR_RED, c.depth);
      if (0.064 * span >= pen.cw * 1.2) {
        var eyeV = Math.max(0.032, pen.cw / span);
        for (var ei = 0; ei < 2; ei++) {
          pen.toWorld(pose, 0.44, eyeV * sides[ei], crPt);
          pen.spot(crPt.x, crPt.y, '\u25cf', [255, 252, 246], [14, 12, 16], c.depth);
        }
      }
    }
  };

  // 5. DRAGONFLY (exact ks / As from ascii-animals-extension)
  var DF_FORE = { u: 0.11, v: 0.02, angle: 0.08, length: 0.5, width: 0.062, broad: 0 };
  var DF_HIND = { u: 0.06, v: 0.02, angle: -0.05, length: 0.48, width: 0.07, broad: 0.5 };
  var dfProbe = { s: 0, x: 0 };
  function dfInWing(w, u, v) {
    var du = u - w.u;
    var dv = v - w.v;
    var sn = Math.sin(w.angle);
    var cs = Math.cos(w.angle);
    var along = (du * sn + dv * cs) / w.length;
    if (along < 0 || along > 1) return false;
    var across = du * cs - dv * sn;
    var maxW = w.width * Math.pow(Math.sin(Math.PI * (0.1 + 0.9 * along)), 0.45) * (1 + w.broad * (1 - along) * (1 - along));
    if (Math.abs(across) > maxW) return false;
    dfProbe.s = along;
    dfProbe.x = across / maxW;
    return true;
  }
  var dfEyePt = { x: 0, y: 0 };
  var Dragonflies = {
    key: 'dragonflies',
    label: 'Dragonfly',
    swatch: [50, 220, 120],
    defaults: Object.assign({}, BASE_TUNING, {
      fog: 0.26, density: 2.1, sway: 0, spread: 0, farthest: 0.32, farBias: 3,
      grip: 5, separation: 720, trail: 0.6, trailFade: 1.2, sparkle: 0.18,
      hover: 1.3, cruising: 0.5, dart: 1.5, wingbeat: 1
    }),
    hide: ['shimmer'],
    controls: [['Flight', [
      { key: 'hover', label: 'Hover time', min: 0.1, max: 4, step: 0.05, hint: 'Average hover pause duration.' },
      { key: 'cruising', label: 'Cruising', min: 0, max: 1, step: 0.01, hint: 'How often they cruise instead of hovering.' },
      { key: 'dart', label: 'Dart speed', min: 0.2, max: 3, step: 0.05, hint: 'How fast each sudden dart is.' },
      { key: 'wingbeat', label: 'Wingbeat', min: 0.2, max: 2, step: 0.05, hint: 'How fast the wings flicker.' }
    ]]],
    area: 150000,
    scale: 2.1,
    speed: 70,
    trail: { light: [40, 160, 100], dark: [140, 255, 190] },
    create: function (base) { return Object.assign({}, base, { phase: randRange(0, TAU), mode: 'hover', until: 0, aim: 0 }); },
    enter: function (c, flock) { c.mode = 'hover'; c.until = flock.time + randRange(0, 0.6); c.aim = flock.getCourse(); },
    update: function (c, flock, dt) {
      var tu = flock.tuning;
      var t = flock.time;
      var sp = flock.cruise(c);
      if (t >= c.until) {
        var prev = c.mode;
        var next = prev === 'hover' ? 'dart' : prev === 'dart' ? (Math.random() < tu.cruising ? 'cruise' : 'hover') : (Math.random() < 0.35 ? 'dart' : 'hover');
        c.mode = next;
        if (next === 'dart') {
          c.until = t + randRange(0.15, 0.45);
          if (prev === 'cruise') c.aim = c.heading + randRange(-0.4, 0.4) * (tu.spread + 0.2);
        } else if (next === 'cruise') {
          c.until = t + randRange(1.2, 4.5);
          c.aim = flock.getHeading() + c.bias * tu.spread + randRange(-0.5, 0.5) * tu.spread;
        } else {
          c.until = t + Math.min(3, Math.max(0.15, -Math.log(1 - Math.random()) * 0.7)) * tu.hover;
          c.aim = flock.getHeading() + c.bias * tu.spread * 0.5 + randRange(-1, 1) * tu.spread * 1.6;
        }
      }
      var acc = flock.begin();
      if (c.mode === 'dart') {
        flock.steer(c, c.aim, sp * 4 * tu.dart, 10);
      } else if (c.mode === 'cruise') {
        c.aim += randRange(-1, 1) * dt * 1.2;
        c.aim += (flock.getHeading() + c.bias * tu.spread - c.aim) * Math.min(1, dt * 0.8);
        flock.steer(c, c.aim, sp * 1.8, 3);
      } else {
        flock.steer(c, flock.getHeading(), sp * 0.25, 4 * tu.grip);
        acc.x += Math.cos(t * 3 + c.id) * 40;
        acc.y += Math.sin(t * 4.3 + c.id * 2) * 40;
      }
      flock.separate(c);
      flock.move(c, dt, sp * 4.5 * tu.dart);
      if (flock.passed(c)) flock.reenter(c);
      if (c.mode === 'cruise') flock.face(c, dt, 4);
      else flock.face(c, dt, c.mode === 'dart' ? 14 : 2.5, c.aim);
      c.phase += dt * TAU * 7 * tu.wingbeat;
    },
    startle: function (c, nx, ny, power, flock) {
      c.mode = 'dart';
      c.aim = flock.getHeading() + c.bias * flock.tuning.spread;
      c.until = flock.time + 0.25 + 0.3 * power;
      c.startledUntil = c.until;
    },
    draw: function (c, pen) {
      var span = c.span;
      var pose = { x: c.x, y: c.y, heading: c.heading, span: span, depth: c.depth, id: c.id };
      var ink = pen.ink;
      var f1 = 0.86 + 0.14 * Math.cos(c.phase);
      var f2 = 0.86 + 0.14 * Math.cos(c.phase + 1.7);
      var tailPad = pen.cw * 0.38;
      var glint = fract(c.phase / TAU);
      var ftick = Math.floor(pen.t * 24);
      var sides = [-1, 1];
      for (var li = 0; li < 2; li++) {
        var s = sides[li];
        pen.lineBody(pose, 0.14, 0.03 * s, 0.2, 0.07 * s, [40, 60, 44]);
        pen.lineBody(pose, 0.1, 0.03 * s, 0.12, 0.08 * s, [40, 60, 44]);
      }
      var wings = [[DF_FORE, f1], [DF_HIND, f2]];
      pen.shape(pose, 0.74, function (u, v) {
        var av = Math.abs(v);
        var tu = (u - 0.12) / 0.07;
        var tv = av / 0.046;
        if (tu * tu + tv * tv <= 1) {
          var col = fract((u + av) * 22) < 0.5 ? [96, 232, 130] : [28, 70, 44];
          return setInk(ink, col[0], col[1], col[2], CELL_TRANSLUCENT, '#8');
        }
        if (u < 0.06 && u > -0.74) {
          var bodyW = Math.max(0.017 - 0.006 * ((0.06 - u) / 0.8), tailPad / span);
          if (av <= bodyW) {
            if (u < -0.66) return setInk(ink, 18, 40, 28, CELL_DARK);
            var seg = fract(u * 20);
            if (seg < 0.1) return setInk(ink, 200, 255, 220, CELL_TRANSLUCENT, '-');
            if (seg < 0.45) return setInk(ink, 50, 220, 120, CELL_TRANSLUCENT, '=');
            return setInk(ink, 24, 72, 46, CELL_TRANSLUCENT, ':=');
          }
        }
        for (var wi = 0; wi < 2; wi++) {
          var wg = wings[wi][0];
          var wl = wings[wi][1];
          if (!dfInWing(wg, u, av / wl)) continue;
          var sign = v >= 0 ? 1 : -1;
          var mainVein = angleGlyph(c.heading + Math.atan2(sign * Math.cos(wg.angle), Math.sin(wg.angle)));
          var crossVein = angleGlyph(c.heading + Math.atan2(-sign * Math.sin(wg.angle), Math.cos(wg.angle)));
          var ws = dfProbe.s;
          var wx = dfProbe.x;
          if (ws > 0.82 && ws < 0.9 && wx > 0.35) return setInk(ink, 176, 70, 40, CELL_TRANSLUCENT, '#');
          if (wx > 0.72) return setInk(ink, 236, 168, 70, CELL_VEIN, mainVein);
          if (Math.abs(ws - glint) < 0.05 && hash3(Math.round(u * 60), Math.round(v * 60), ftick) > 0.45) return setInk(ink, 255, 255, 255, CELL_VEIN, '*+');
          var lattice = Math.abs(wx + 0.15) < 0.09 || Math.abs(wx - 0.35) < 0.07 || wx < -0.85 || ws > 0.97;
          var rib = fract(ws * 9) < 0.09;
          if (lattice) return setInk(ink, 226, 236, 214, CELL_VEIN, rib ? '+' : mainVein);
          if (rib) return setInk(ink, 226, 236, 214, CELL_VEIN, crossVein);
          if (ws < 0.18) return setInk(ink, 90, 220, 140, CELL_MEMBRANE, '.');
          return hash3(Math.round(u * 50), Math.round(v * 50), c.id) > 0.6 && setInk(ink, 226, 236, 214, CELL_VEIN, '.');
        }
        return false;
      }, { light: 0.92 + 0.08 * f1 });

      if (0.068 * span >= pen.cw) {
        for (var ei = 0; ei < 2; ei++) {
          pen.toWorld(pose, 0.2, 0.034 * sides[ei], dfEyePt);
          pen.spot(dfEyePt.x, dfEyePt.y, '\u25cf', [10, 10, 12], [240, 240, 232], c.depth);
        }
      }
      if (c.mode === 'dart') pen.shed(c.x, c.y, 0.06 * c.depth);
    }
  };

  // 6. FROG (exact _s / qs from ascii-animals-extension)
  var FR_BACK_FOLD = [[-0.16, 0.11], [0, 0.22], [-0.19, 0.25], [-0.04, 0.31]];
  var FR_BACK_EXT  = [[-0.17, 0.09], [-0.38, 0.15], [-0.56, 0.13], [-0.68, 0.15]];
  var FR_BACK_W = [0.056, 0.04, 0.026];
  var FR_FRONT_REST = [[0.06, 0.1], [0.09, 0.19], [0.18, 0.2]];
  var FR_FRONT_TUCK = [[0.06, 0.1], [0.02, 0.16], [-0.06, 0.15]];
  var FR_FRONT_REACH = [[0.08, 0.11], [0.16, 0.19], [0.27, 0.19]];
  var FR_FRONT_W = [0.028, 0.022];
  var FR_JUMP_SCALES = [1, 0.8, 1.2, 0.65, 1.35];
  var frProbe = { t: 0 };
  var frPt = { x: 0, y: 0 };
  function frLerpPose(a, b, k) {
    var out = [];
    for (var i = 0; i < a.length; i++) out.push([lerp(a[i][0], b[i][0], k), lerp(a[i][1], b[i][1], k)]);
    return out;
  }
  function frBodyW(u, puff) {
    var rear = 0.155 * Math.sqrt(Math.max(0, 1 - ((u + 0.1) / 0.18) * ((u + 0.1) / 0.18)));
    var chest = 0.15 * puff * Math.sqrt(Math.max(0, 1 - ((u - 0.12) / 0.18) * ((u - 0.12) / 0.18)));
    if (u > 0.18) chest *= 1 - 0.5 * ((u - 0.18) / 0.12) * ((u - 0.18) / 0.12);
    return Math.max(rear, chest);
  }
  function frOnLimb(pts, widths, u, v) {
    for (var i = 0; i < pts.length - 1; i++) {
      var d = segDist(u, v, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], frProbe);
      if (d <= widths[i] * (1 - 0.25 * frProbe.t)) {
        frProbe.t = (i + frProbe.t) / (pts.length - 1);
        return true;
      }
    }
    return false;
  }
  function frStartLeap(c, flock, angle, mult, clampToCourse) {
    if (clampToCourse === undefined) clampToCourse = true;
    var tu = flock.tuning;
    if (clampToCourse) angle = flock.getHeading() + clamp(angleDiff(flock.getHeading(), angle), -0.35, 0.35);
    var cs = Math.cos(angle);
    var sn = Math.sin(angle);
    var dist = c.span * randRange(2.4, 3.6) * tu.leap * tu.speed * mult;
    var chosen = dist;
    if (clampToCourse && tu.separation > 0) {
      var bestClear = -1;
      for (var si = 0; si < FR_JUMP_SCALES.length; si++) {
        var sc = FR_JUMP_SCALES[si];
        var tx = c.x + cs * dist * sc;
        var ty = c.y + sn * dist * sc;
        var minGap = Infinity;
        for (var ci = 0; ci < flock.creatures.length; ci++) {
          var o = flock.creatures[ci];
          if (o === c || Math.abs(o.depth - c.depth) > 0.2) continue;
          var ox = o.leaping ? o.toX : o.x;
          var oy = o.leaping ? o.toY : o.y;
          minGap = Math.min(minGap, Math.hypot(tx - ox, ty - oy) / (c.span + o.span));
        }
        if (minGap > bestClear) { bestClear = minGap; chosen = dist * sc; }
        if (minGap >= 0.6 * (tu.separation / 300)) break;
      }
    }
    c.leaping = true;
    c.s = 0;
    c.dur = randRange(0.42, 0.55) * Math.sqrt(tu.leap) * (mult > 1 ? 0.8 : 1);
    c.heading = angle;
    c.fromX = c.x; c.fromY = c.y;
    c.toX = c.x + cs * chosen; c.toY = c.y + sn * chosen;
    c.vx = (c.toX - c.fromX) / c.dur;
    c.vy = (c.toY - c.fromY) / c.dur;
  }
  var Frogs = {
    key: 'frogs',
    label: 'Frog',
    swatch: [104, 184, 76],
    defaults: Object.assign({}, BASE_TUNING, {
      fog: 0, size: 1.2, density: 1.3, sway: 0, spread: 0, farthest: 0.35, farBias: 1.4,
      separation: 450, trail: 3.45, trailFade: 0.4, shimmer: 0.15, sparkle: 0.05,
      hop: 1, leap: 0.45, height: 1
    }),
    hide: ['grip'],
    controls: [['Leaping', [
      { key: 'hop', label: 'How often', min: 0.2, max: 4, step: 0.05, hint: 'How often they leap.' },
      { key: 'leap', label: 'Leap length', min: 0.3, max: 2.5, step: 0.05, hint: 'How far each leap travels.' },
      { key: 'height', label: 'Leap height', min: 0, max: 2.5, step: 0.05, hint: 'Arc height: frogs enlarge near the apex.' }
    ]]],
    area: 75000,
    scale: 0.95,
    speed: 80,
    trail: { light: [80, 150, 170], dark: [110, 200, 220] },
    create: function (base) {
      return Object.assign({}, base, { leaping: false, until: 0, aim: 0, s: 0, dur: 0.5, fromX: 0, fromY: 0, toX: 0, toY: 0 });
    },
    enter: function (c, flock) {
      c.leaping = false; c.s = 0; c.vx = 0; c.vy = 0;
      c.aim = flock.getHeading() + c.bias * flock.tuning.spread;
      c.heading = c.aim;
      c.until = flock.time + randRange(0, 1.5);
    },
    update: function (c, flock, dt) {
      var tu = flock.tuning;
      var t = flock.time;
      if (!c.leaping) {
        c.vx = 0; c.vy = 0;
        flock.face(c, dt, 2.5, c.aim);
        if (t >= c.until) frStartLeap(c, flock, c.aim, 1);
        return;
      }
      c.s += dt / c.dur;
      if (c.s >= 1) {
        c.leaping = false;
        c.x = c.toX; c.y = c.toY; c.vx = 0; c.vy = 0;
        c.until = t + randRange(0.5, 2.2) / (tu.hop * tu.speed);
        c.aim = flock.getHeading() + (c.bias + randRange(-0.7, 0.7)) * tu.spread;
        flock.events.push({ x: c.x, y: c.y, radius: 2, amount: 0.7 * c.depth * tu.trail });
        if (flock.passed(c)) flock.reenter(c);
        return;
      }
      c.x = lerp(c.fromX, c.toX, c.s);
      c.y = lerp(c.fromY, c.toY, c.s);
    },
    startle: function (c, nx, ny, power, flock) {
      if (c.leaping) return;
      frStartLeap(c, flock, Math.atan2(ny, nx), 1 + power, false);
      c.startledUntil = flock.time + c.dur;
    },
    draw: function (c, pen, flock) {
      var tu = flock.tuning;
      var lp = c.leaping ? c.s : 0;
      var arc = 4 * lp * (1 - lp) * tu.height;
      var span = c.span * (1 + 0.35 * arc);
      var pose = { x: c.x, y: c.y, heading: c.heading, span: span, depth: c.depth, id: c.id };
      var ink = pen.ink;
      var legExt = c.leaping ? smoothstep(0, 0.16, lp) * (1 - smoothstep(0.72, 1, lp)) : 0;
      var backLeg = frLerpPose(FR_BACK_FOLD, FR_BACK_EXT, legExt);
      var frontLeg = c.leaping
        ? (lp < 0.6 ? frLerpPose(FR_FRONT_REST, FR_FRONT_TUCK, smoothstep(0, 0.2, lp)) : frLerpPose(FR_FRONT_TUCK, FR_FRONT_REACH, smoothstep(0.6, 0.95, lp)))
        : FR_FRONT_REST;
      var puff = c.leaping ? 1 : 1 + 0.045 * Math.sin(pen.t * 6 + c.id);
      var blink = !c.leaping && fract(pen.t * 0.21 + c.id * 0.37) < 0.035;
      var sides = [-1, 1];
      function drawToes(a, b, count, len, fan, side) {
        var dir = Math.atan2(b[1] - a[1], b[0] - a[0]);
        for (var k = 0; k < count; k++) {
          var th = dir + (k / (count - 1) - 0.5) * fan;
          pen.lineBody(pose, b[0], b[1] * side, b[0] + Math.cos(th) * len, (b[1] + Math.sin(th) * len) * side, [120, 190, 90]);
        }
      }
      for (var si = 0; si < 2; si++) {
        drawToes(backLeg[2], backLeg[3], 4, 0.075, 1.2, sides[si]);
        drawToes(frontLeg[1], frontLeg[2], 3, 0.045, 1.1, sides[si]);
      }
      pen.shape(pose, 0.9, function (u, v) {
        var av = Math.abs(v);
        var bw = frBodyW(u, puff);
        if (av <= bw && u > -0.29 && u < 0.3) {
          if (Math.abs(av - 0.11) < 0.012 && u > -0.22 && u < 0.14) return setInk(ink, 206, 226, 150, CELL_TRANSLUCENT);
          if (u < 0.1) {
            if (spotPattern(u, v, 0.085, 0.024, c.id)) return setInk(ink, 30, 70, 30, CELL_DARK);
            if (spotPattern(u, v, 0.085, 0.036, c.id)) return setInk(ink, 190, 222, 130, CELL_TRANSLUCENT);
          }
          var sh = 0.9 + 0.2 * (1 - av / Math.max(bw, 0.001));
          return setInk(ink, 104 * sh, 184 * sh, 76 * sh, CELL_TRANSLUCENT);
        }
        var b3 = backLeg[3];
        var b2 = backLeg[2];
        var ang = Math.atan2(b3[1] - b2[1], b3[0] - b2[0]);
        var rel = Math.atan2(av - b3[1], u - b3[0]) - ang;
        if (Math.hypot(u - b3[0], av - b3[1]) < 0.06 && Math.abs(Math.atan2(Math.sin(rel), Math.cos(rel))) < 0.5) {
          return setInk(ink, 120, 190, 90, CELL_MEMBRANE, '.');
        }
        if (frOnLimb(backLeg, FR_BACK_W, u, av) || frOnLimb(frontLeg, FR_FRONT_W, u, av)) {
          return fract(frProbe.t * 4.5) < 0.3 ? setInk(ink, 36, 80, 32, CELL_DARK) : setInk(ink, 92, 164, 66, CELL_TRANSLUCENT);
        }
        return false;
      }, { light: 1 + 0.15 * arc });
      for (var ei = 0; ei < 2; ei++) {
        pen.toWorld(pose, 0.18, 0.1 * sides[ei], frPt);
        if (blink) pen.spot(frPt.x, frPt.y, '-', [20, 30, 16], [104, 184, 76], c.depth);
        else pen.spot(frPt.x, frPt.y, '\u25cf', [16, 16, 12], [240, 240, 228], c.depth);
      }
    }
  };

  // 7. JELLYFISH (exact ni / ii / ai from ascii-animals-extension)
  var JF_PT1 = { x: 0, y: 0 };
  var JF_PT2 = { x: 0, y: 0 };
  function jfLerpColor(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function jfPulseGlow(c) {
    var p = fract(c.phase / TAU);
    return p < 0.16 ? smoothstep(0, 0.16, p) : Math.exp(-(p - 0.16) * 4.5);
  }
  function drawJellyfish(c, pen, flock) {
    var tu = flock.tuning;
    var span = c.span;
    var sq = c.squeeze;
    var t = pen.t;
    var pose = { x: c.x, y: c.y, heading: c.heading, span: span, depth: c.depth, id: c.id };
    var tentLen = tu.tentacles;
    var baseFog = pen.fogFor(c.depth);
    var bellLen = 0.32 * (1 + 0.14 * sq);
    var bellRad = 0.3 * (1 - 0.2 * sq);
    var bellRoot = -0.04;
    var turnBend = clamp(-c.turn * 0.5, -0.5, 0.5);
    var glow = jfPulseGlow(c) * tu.pulseGlow;
    var m;

    // 8 trailing tentacles
    for (m = 0; m < 8; m++) {
      var off = (m / 7 - 0.5) * 2 * bellRad * 0.6;
      var pu = bellRoot - 0.02;
      var pv = off;
      var segs = 14;
      var len = 1.5 * tentLen * (0.75 + 0.35 * hash3(c.id, m, 4));
      for (var k = 1; k <= segs; k++) {
        var f = k / segs;
        var nu = bellRoot - 0.02 - f * len * (1 - 0.12 * sq);
        var nv = off * (1 - 0.3 * f) + 0.04 * Math.sin(c.phase - f * 3.5 + m * 1.3) * f + turnBend * f * f * 0.4;
        pen.toWorld(pose, pu, pv, JF_PT1);
        pen.toWorld(pose, nu, nv, JF_PT2);
        pen.line(JF_PT1.x, JF_PT1.y, JF_PT2.x, JF_PT2.y, [232, 100, 204], c.depth, undefined, Math.min(0.95, baseFog + 0.45 + 0.35 * f));
        pu = nu; pv = nv;
      }
    }

    // 4 frilly oral arms
    var ruffleChars = '{}~\u00a7';
    var sides = [-1, 1];
    for (m = 0; m < 4; m++) {
      var offO = (m / 3 - 0.5) * 0.11;
      var stepsO = 26;
      var lenO = 1.05 * tentLen * (0.8 + 0.3 * hash3(c.id, m, 7));
      for (var step = 1; step <= stepsO; step++) {
        var frac = step / stepsO;
        var u = bellRoot - frac * lenO;
        var v = offO * (1 - 0.4 * frac) + 0.05 * Math.sin(c.phase * 0.9 - frac * 4.5 + m * 1.7) * frac + turnBend * frac * 0.25;
        var frill = 0.055 * (1 - 0.5 * frac) * Math.cos(frac * 9 + m * 1.3 + t * 0.6);
        var armFog = Math.min(0.95, baseFog + 0.3 * frac);
        pen.toWorld(pose, u, v, JF_PT1);
        pen.dot(JF_PT1.x, JF_PT1.y, step % 3 ? ':' : '|', [204, 56, 172], c.depth, Math.min(0.95, armFog + 0.15));
        for (var si = 0; si < 2; si++) {
          pen.toWorld(pose, u, v + frill * sides[si], JF_PT1);
          pen.dot(JF_PT1.x, JF_PT1.y, ruffleChars[(step + m + (sides[si] > 0 ? 1 : 0)) % 4], [255, 214, 240], c.depth, armFog);
        }
      }
      pen.toWorld(pose, bellRoot - lenO, offO, JF_PT1);
      pen.shed(JF_PT1.x, JF_PT1.y, 0.015 * c.depth);
    }

    var ink = pen.ink;
    var halo = 1.3 * (1 + 0.18 * glow);
    pen.shape(pose, 0.32 * halo + 0.1, function (u, v) {
      return Math.hypot((u - bellRoot) / (bellLen * halo), v / (bellRad * halo)) < 1 && u > bellRoot - 0.08 && setInk(ink, 255, 200, 240, CELL_VEIN, '.');
    }, { fog: clamp(baseFog + 0.55 - 0.3 * glow, 0, 0.95) });

    pen.shape(pose, 0.42, function (u, v) {
      var nu = (u - bellRoot) / bellLen;
      var nv = v / bellRad;
      var r2 = nu * nu + nv * nv;
      var rimU = bellRoot - 0.04 * nv * nv;
      if (r2 > 1 || u < rimU) {
        if (Math.abs(nv) > 1 || u > rimU || u < rimU - 0.04) return false;
        var sc = 0.04 * Math.sin(fract((nv + 1) * 5.5) * Math.PI);
        return u > rimU - sc && setInk(ink, 255, 214, 244, CELL_TRANSLUCENT, 'o');
      }
      var dist = Math.sqrt(r2);
      if (dist > 0.88) return setInk(ink, 255, 200, 240, CELL_TRANSLUCENT, ':;');
      var ang = Math.atan2(nv, nu);
      if (nu > 0.3) {
        var gu = Math.round(nu * 11);
        var gv = Math.round(nv * 13);
        if (Math.hypot(nu * 11 - gu, nv * 13 - gv) < 0.32 && hash3(gu, gv, c.id) > 0.45) {
          return setInk(ink, 255, 240, 250, CELL_TRANSLUCENT, ".'");
        }
      }
      if (dist > 0.35 && fract((ang / Math.PI) * 6) < 0.1) return setInk(ink, 255, 200, 240, CELL_TRANSLUCENT, '|');
      var br = 0.75 + 0.25 * Math.max(clamp(nu, 0, 1), r2);
      var col = jfLerpColor([232, 56, 182], [255, 168, 230], clamp(nu, 0, 1) * 0.8);
      return setInk(ink, col[0] * br, col[1] * br, col[2] * br, CELL_TRANSLUCENT, ' .');
    }, { light: (0.92 + 0.18 * sq) * (1 + 0.6 * glow) });
  }
  function drawPlankton(flock, pen) {
    var count = Math.round((flock.width * flock.height) / 6000);
    var t = pen.t;
    for (var i = 0; i < count; i++) {
      var sp = 3 + 9 * hash3(i, 3, 1);
      var x = hash3(i, 1, 1) * flock.width + Math.sin(t * 0.25 + i) * 6;
      var y = (((hash3(i, 2, 1) * flock.height - t * sp) % flock.height) + flock.height) % flock.height;
      var tw = 0.5 + 0.5 * Math.sin(t * (0.8 + 1.6 * hash3(i, 4, 1)) + i);
      var big = hash3(i, 5, 1) > 0.92;
      pen.dot(x, y, big ? '*' : '.', [255, 170, 226], 1, Math.min(0.95, 0.35 + 0.5 * (1 - tw) + (big ? 0 : 0.15)));
    }
  }
  var Jellyfish = {
    key: 'jellyfish',
    label: 'Jellyfish',
    swatch: [232, 56, 182],
    defaults: Object.assign({}, BASE_TUNING, {
      speed: 1.05, sway: 0.04, spread: 0.08, farthest: 0.3, farBias: 1.4, grip: 1.4,
      trail: 0.8, trailFade: 0.6, sparkle: 0.1,
      pulseRate: 1, pulsePower: 1, pulseGlow: 1, tentacles: 1
    }),
    hide: ['shimmer'],
    controls: [['Swimming', [
      { key: 'pulseRate', label: 'Pulse rate', min: 0.2, max: 3, step: 0.05, hint: 'How often the bell pulses.' },
      { key: 'pulsePower', label: 'Pulse power', min: 0.2, max: 3, step: 0.05, hint: 'How strongly each bell pulse pushes forward.' },
      { key: 'pulseGlow', label: 'Pulse glow', min: 0, max: 3, step: 0.05, hint: 'Halo glow when the bell pulses. 0 turns it off.' },
      { key: 'tentacles', label: 'Arm length', min: 0, max: 2.5, step: 0.05, hint: 'Length of frilly oral arms and tentacles.' }
    ]]],
    area: 95000,
    scale: 1.6,
    speed: 55,
    trail: { light: [200, 80, 170], dark: [255, 130, 214] },
    create: function (base) { return Object.assign({}, base, { phase: randRange(0, TAU), squeeze: 0, turn: 0 }); },
    update: function (c, flock, dt) {
      var tu = flock.tuning;
      c.phase += dt * TAU * 0.6 * tu.pulseRate * (0.9 + 0.2 * c.roll);
      var p = fract(c.phase / TAU);
      c.squeeze = p < 0.22 ? smoothstep(0, 0.22, p) : 1 - smoothstep(0.22, 1, p);
      var aim = flock.getHeading() + c.bias * tu.spread;
      var prev = c.heading;
      c.heading += clamp(angleDiff(c.heading, aim), -0.6 * tu.grip * dt, 0.6 * tu.grip * dt);
      c.turn += (angleDiff(prev, c.heading) / dt - c.turn) * Math.min(1, dt * 3);
      var sp = flock.cruise(c);
      var acc = flock.begin();
      var kick = p < 0.22 ? 6.2 * sp * tu.pulsePower : 0;
      acc.x += Math.cos(c.heading) * kick - c.vx * 1.4;
      acc.y += Math.sin(c.heading) * kick - c.vy * 1.4;
      flock.separate(c, tu.separation, 0.5);
      flock.move(c, dt, sp * 3);
      if (flock.passed(c, c.span * 1.4)) flock.reenter(c);
    },
    startle: function (c, nx, ny, power, flock) {
      c.phase = Math.floor(c.phase / TAU) * TAU + TAU;
      var imp = 260 * power * c.depth;
      c.vx += Math.cos(c.heading) * imp;
      c.vy += Math.sin(c.heading) * imp;
      c.startledUntil = flock.time + 0.8;
    },
    drawAll: function (flock, pen) {
      drawPlankton(flock, pen);
      for (var i = 0; i < flock.creatures.length; i++) drawJellyfish(flock.creatures[i], pen, flock);
    }
  };

  // 8. KOI (exact gi / mi / fi from ascii-animals-extension, including click-to-feed!)
  var KOI_NODES = 14;
  var KOI_FOOD_TTL = 14;
  var KOI_VARIETIES = ['kohaku', 'sanke', 'showa', 'ogon', 'chagoi'];
  var koiFoodStore = new WeakMap();
  function getKoiFood(flock) {
    var arr = koiFoodStore.get(flock);
    if (!arr) { arr = []; koiFoodStore.set(flock, arr); }
    return arr;
  }
  function koiWidth(s) {
    if (s < 0.12) return 0.1 * Math.pow(Math.sin((s / 0.12) * (Math.PI / 2)), 0.6);
    if (s < 0.35) return 0.1 + 0.016 * Math.sin(((s - 0.12) / 0.23) * (Math.PI / 2));
    if (s < 0.82) return 0.116 - 0.088 * smoothstep(0.35, 0.82, s);
    return 0.028 + ((s - 0.82) / 0.18) * 0.1;
  }
  function koiPatch(s, d, seed) {
    return Math.sin(s * 11 + seed) * Math.cos(d * 22 + seed * 1.3) +
           0.6 * Math.sin(s * 23 + d * 15 + seed * 2.1) +
           0.35 * Math.sin(s * 5 - seed * 0.7);
  }
  var koiFoodProx = 0;
  function nearestFood(c, flock, range) {
    var best = null;
    var bestDist = range;
    var food = getKoiFood(flock);
    for (var i = 0; i < food.length; i++) {
      var d = Math.hypot(food[i].x - c.x, food[i].y - c.y);
      if (d < bestDist) { bestDist = d; best = food[i]; }
    }
    koiFoodProx = best ? 1 - bestDist / range : 0;
    return best;
  }
  function drawKoi(c, pen, flock) {
    var tu = flock.tuning;
    var span = c.span;
    var nodes = c.nodes;
    var ink = pen.ink;
    var kind = KOI_VARIETIES[c.variety];
    var patSeed = c.id * 1.37;
    var whiteBase = pen.theme === 'light' ? [222, 217, 206] : [244, 240, 230];
    var finCol = pen.theme === 'light' ? [206, 196, 182] : [236, 226, 214];
    var swayNodes = new Float32Array(KOI_NODES * 2);
    var arcLen = new Float32Array(KOI_NODES);
    for (var i = 0; i < KOI_NODES; i++) {
      var s = i / (KOI_NODES - 1);
      var iPrev = Math.max(0, i - 1);
      var iNext = Math.min(KOI_NODES - 1, i + 1);
      var tx = nodes[iPrev * 2] - nodes[iNext * 2];
      var ty = nodes[iPrev * 2 + 1] - nodes[iNext * 2 + 1];
      var mag = Math.hypot(tx, ty) || 1;
      tx /= mag; ty /= mag;
      var wag = span * 0.06 * Math.pow(s, 1.6) * Math.sin(c.phase - s * 4.5) * Math.min(1.5, tu.tailBeat);
      swayNodes[i * 2] = nodes[i * 2] - ty * wag;
      swayNodes[i * 2 + 1] = nodes[i * 2 + 1] + tx * wag;
      if (i > 0) arcLen[i] = arcLen[i - 1] + Math.hypot(swayNodes[i * 2] - swayNodes[i * 2 - 2], swayNodes[i * 2 + 1] - swayNodes[i * 2 - 1]);
    }
    var totalLen = arcLen[KOI_NODES - 1] || 1;
    var mid = (KOI_NODES / 2) | 0;
    var pose = { x: swayNodes[mid * 2], y: swayNodes[mid * 2 + 1], heading: c.heading, span: span, depth: c.depth, id: c.id };
    var finBeat = 0.8 + 0.2 * Math.sin(c.phase * 0.7);

    pen.shape(pose, 0.72, function (u, v, wx, wy) {
      var bestD2 = Infinity;
      var sk = 0, dv = 0, tailPast = 0;
      for (var k = 0; k < KOI_NODES - 1; k++) {
        var ax = swayNodes[k * 2];
        var ay = swayNodes[k * 2 + 1];
        var dx = swayNodes[k * 2 + 2] - ax;
        var dy = swayNodes[k * 2 + 3] - ay;
        var l2 = dx * dx + dy * dy || 1;
        var proj = ((wx - ax) * dx + (wy - ay) * dy) / l2;
        var t = clamp(proj, 0, 1);
        var segL = Math.sqrt(l2);
        if (k === KOI_NODES - 2 && proj > 1) {
          var cross = Math.abs(dx * (wy - ay) - dy * (wx - ax)) / segL;
          if (cross * cross < bestD2) {
            bestD2 = cross * cross;
            sk = 1;
            tailPast = ((proj - 1) * segL) / span;
            dv = (cross / span) * (dx * (wy - ay) - dy * (wx - ax) >= 0 ? 1 : -1);
          }
          continue;
        }
        var d2 = (wx - ax - dx * t) * (wx - ax - dx * t) + (wy - ay - dy * t) * (wy - ay - dy * t);
        if (d2 < bestD2) {
          bestD2 = d2;
          sk = (arcLen[k] + t * segL) / totalLen;
          dv = (Math.sqrt(d2) / span) * (dx * (wy - ay) - dy * (wx - ax) >= 0 ? 1 : -1);
          tailPast = 0;
        }
      }
      var absD = Math.abs(dv);
      var hw = koiWidth(sk);
      ink.au = sk;
      ink.av = dv;
      if (tailPast > 0) return false;
      var pecFin = sk > 0.17 && sk < 0.34 && absD < hw + 0.1 * finBeat * Math.sin(((sk - 0.17) / 0.17) * Math.PI);
      var pelFin = sk > 0.48 && sk < 0.6 && absD < hw + 0.05 * Math.sin(((sk - 0.48) / 0.12) * Math.PI);
      if (absD > hw) return (pecFin || pelFin) && setInk(ink, finCol[0], finCol[1], finCol[2], CELL_MEMBRANE, '-=');
      if (sk > 0.82) {
        if (sk > 0.93 && absD < ((sk - 0.93) / 0.07) * 0.06) return false;
        return setInk(ink, finCol[0], finCol[1], finCol[2], CELL_MEMBRANE, sk > 0.9 ? '/\\' : '=');
      }
      var redPatch = koiPatch(sk, dv, patSeed) > 0.25;
      var relD = absD / hw;
      if (kind === 'kohaku') return redPatch && sk < 0.8 ? setInk(ink, 222, 66, 40) : setInk(ink, whiteBase[0], whiteBase[1], whiteBase[2]);
      if (kind === 'sanke') {
        if (hash3(Math.round(sk * 30), Math.round(dv * 60), c.id) > 0.9 && sk > 0.15) return setInk(ink, 34, 34, 40, CELL_DARK);
        return redPatch && sk < 0.8 ? setInk(ink, 222, 66, 40) : setInk(ink, whiteBase[0], whiteBase[1], whiteBase[2]);
      }
      if (kind === 'showa') {
        if (koiPatch(sk, dv, patSeed + 4) > 0.55) return setInk(ink, whiteBase[0], whiteBase[1], whiteBase[2]);
        return redPatch ? setInk(ink, 222, 66, 40) : setInk(ink, 34, 34, 40, CELL_DARK, '%#');
      }
      if (kind === 'ogon') return setInk(ink, 238, 182, 64, CELL_SHIMMER);
      return setInk(ink, 236 * (1 - 0.15 * relD), 124 * (1 - 0.15 * relD), 44, CELL_SHIMMER);
    });

    var headHalf = koiWidth(0.09) * 0.55 * span;
    if (2 * headHalf >= pen.cw) {
      var targetArc = 0.09 * totalLen;
      var seg = 0;
      while (seg < KOI_NODES - 2 && arcLen[seg + 1] < targetArc) seg++;
      var segSpan = arcLen[seg + 1] - arcLen[seg] || 1;
      var frac = (targetArc - arcLen[seg]) / segSpan;
      var ux = (swayNodes[seg * 2 + 2] - swayNodes[seg * 2]) / segSpan;
      var uy = (swayNodes[seg * 2 + 3] - swayNodes[seg * 2 + 1]) / segSpan;
      var ex = swayNodes[seg * 2] + ux * frac * segSpan;
      var ey = swayNodes[seg * 2 + 1] + uy * frac * segSpan;
      var sides = [-1, 1];
      for (var ei = 0; ei < 2; ei++) {
        pen.spot(ex - uy * headHalf * sides[ei], ey + ux * headHalf * sides[ei], '\u25cf', [255, 252, 246], [14, 12, 16], c.depth);
      }
    }
    pen.shed(swayNodes[(KOI_NODES - 2) * 2], swayNodes[(KOI_NODES - 2) * 2 + 1], 0.02 * c.depth);
  }
  var Koi = {
    key: 'koi',
    label: 'Koi',
    swatch: [244, 196, 44],
    defaults: Object.assign({}, BASE_TUNING, {
      fog: 0.64, density: 1.6, speed: 1.6, spread: 0, sway: 0, farthest: 0.33,
      farBias: 1.3, grip: 2.65, separation: 780, trail: 4, trailFade: 0.4,
      shimmer: 0.35, sparkle: 0.08, meander: 0.4, foodRange: 200, tailBeat: 1
    }),
    controls: [
      ['Swimming', [
        { key: 'meander', label: 'Meander', min: 0, max: 3, step: 0.05, hint: 'How much they weave in lazy S-curves.' },
        { key: 'tailBeat', label: 'Tail beat', min: 0.2, max: 3, step: 0.05, hint: 'How fast and wide the tail swishes.' }
      ]],
      ['Feeding', [
        { key: 'foodRange', label: 'Food range', min: 0, max: 500, step: 10, hint: 'How close a koi has to be to spot food pellets you drop on click.' }
      ]]
    ],
    area: 75000,
    scale: 1.15,
    speed: 50,
    trail: { light: [90, 140, 190], dark: [110, 170, 220] },
    create: function (base) {
      return Object.assign({}, base, {
        nodes: new Float32Array(KOI_NODES * 2),
        phase: randRange(0, TAU),
        variety: Math.floor(hash3(base.id, 7, 3) * KOI_VARIETIES.length)
      });
    },
    enter: function (c) {
      var seg = c.span / (KOI_NODES - 1);
      for (var i = 0; i < KOI_NODES; i++) {
        c.nodes[i * 2] = c.x - Math.cos(c.heading) * seg * i;
        c.nodes[i * 2 + 1] = c.y - Math.sin(c.heading) * seg * i;
      }
    },
    prepare: function (flock, dt) {
      var food = getKoiFood(flock);
      for (var i = food.length - 1; i >= 0; i--) {
        var f = food[i];
        f.vx *= Math.exp(-dt * 0.8);
        f.vy *= Math.exp(-dt * 0.8);
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        if (flock.time - f.born > KOI_FOOD_TTL) food.splice(i, 1);
      }
    },
    tap: function (x, y, flock) {
      var food = getKoiFood(flock);
      var cnt = 7 + Math.floor(Math.random() * 5);
      for (var i = 0; i < cnt; i++) {
        var th = randRange(0, TAU);
        var rad = 70 * Math.sqrt(Math.random());
        var pellet = { x: x + Math.cos(th) * rad, y: y + Math.sin(th) * rad, vx: Math.cos(th) * randRange(4, 14), vy: Math.sin(th) * randRange(4, 14), born: flock.time };
        food.push(pellet);
        flock.events.push({ x: pellet.x, y: pellet.y, radius: 1, amount: 0.5 });
      }
      if (food.length > 60) food.splice(0, food.length - 60);
    },
    update: function (c, flock, dt) {
      var tu = flock.tuning;
      var t = flock.time;
      var food = nearestFood(c, flock, tu.foodRange);
      var chase = food ? 0.25 + 0.75 * koiFoodProx : 0;
      var aim = food
        ? Math.atan2(food.y - c.y, food.x - c.x)
        : flock.getHeading() + c.bias * tu.spread + tu.meander * 0.6 * Math.sin(t * 0.35 + c.id * 1.7);
      var acc = flock.begin();
      flock.separate(c, tu.separation, 0.5);
      if (acc.x || acc.y) {
        var baseSp = flock.cruise(c);
        aim = Math.atan2(Math.sin(aim) * baseSp + acc.y * 0.3, Math.cos(aim) * baseSp + acc.x * 0.3);
      }
      var maxTurn = lerp(0.9 * tu.grip, 2.6, chase) * dt;
      c.heading += clamp(angleDiff(c.heading, aim), -maxTurn, maxTurn);
      var spd = flock.cruise(c) * lerp(0.85 + 0.25 * Math.sin(t * 0.5 + c.id), 1.8, chase);
      c.vx = Math.cos(c.heading) * spd;
      c.vy = Math.sin(c.heading) * spd;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.phase += dt * (2 + spd / 25) * tu.tailBeat;
      var nodes = c.nodes;
      var seg = c.span / (KOI_NODES - 1);
      nodes[0] = c.x;
      nodes[1] = c.y;
      var prevAng = c.heading + Math.PI;
      for (var i = 1; i < KOI_NODES; i++) {
        var ang = Math.atan2(nodes[i * 2 + 1] - nodes[i * 2 - 1], nodes[i * 2] - nodes[i * 2 - 2]);
        ang = prevAng + clamp(angleDiff(prevAng, ang), -0.22, 0.22);
        nodes[i * 2] = nodes[i * 2 - 2] + Math.cos(ang) * seg;
        nodes[i * 2 + 1] = nodes[i * 2 - 1] + Math.sin(ang) * seg;
        prevAng = ang;
      }
      if (food && Math.hypot(food.x - c.x, food.y - c.y) < c.span * 0.1 + 6) {
        var list = getKoiFood(flock);
        var idx = list.indexOf(food);
        if (idx >= 0) list.splice(idx, 1);
        flock.events.push({ x: food.x, y: food.y, radius: 1, amount: 0.7 });
      }
      if (flock.passed(c, c.span * 1.3)) flock.reenter(c);
    },
    drawAll: function (flock, pen) {
      var food = getKoiFood(flock);
      for (var fi = 0; fi < food.length; fi++) {
        var f = food[fi];
        var age = (flock.time - f.born) / KOI_FOOD_TTL;
        pen.dot(f.x, f.y, age < 0.7 ? 'o' : '.', [232, 178, 104], 1, Math.min(0.9, Math.max(0, age - 0.5) * 1.6));
      }
      for (var i = 0; i < flock.creatures.length; i++) drawKoi(flock.creatures[i], pen, flock);
    }
  };

  /* ---------------------------------------------------------------- registry & stage */

  var CREATURES = [
    { id: 'off',         label: 'Off',       rgb: [150, 150, 160], animal: null },
    { id: 'butterflies', label: 'Butterfly', rgb: Butterflies.swatch, animal: Butterflies },
    { id: 'airplane',    label: 'Airplane',  rgb: Airplane.swatch,    animal: Airplane },
    { id: 'dragonflies', label: 'Dragonfly', rgb: Dragonflies.swatch, animal: Dragonflies },
    { id: 'cranes',      label: 'Crane',     rgb: Cranes.swatch,      animal: Cranes },
    { id: 'koi',         label: 'Koi',       rgb: Koi.swatch,         animal: Koi },
    { id: 'jellyfish',   label: 'Jellyfish', rgb: Jellyfish.swatch,   animal: Jellyfish },
    { id: 'crabs',       label: 'Crab',      rgb: Crabs.swatch,       animal: Crabs },
    { id: 'frogs',       label: 'Frog',      rgb: Frogs.swatch,       animal: Frogs }
  ];

  var CREATURE_ALIAS = {
    butterfly: 'butterflies',
    dragonfly: 'dragonflies',
    crane: 'cranes',
    crab: 'crabs',
    frog: 'frogs'
  };

  function findCreature(id) {
    var mapped = CREATURE_ALIAS[id] || id;
    for (var i = 0; i < CREATURES.length; i++) {
      if (CREATURES[i].id === mapped) return CREATURES[i];
    }
    return null;
  }

  /* ---------------------------------------------------------------- controller / UI */

  var canvas = null;
  var flock = null;
  var renderer = null;
  var activeTuning = null;
  var activeAnimal = null;
  var cfg = null;
  var onPersist = null;
  var built = false;
  var rafId = 0;
  var lastTime = 0;
  var lastRender = 0;
  var accTime = 0;
  var resizeObs = null;
  var themeObs = null;
  var ui = {};
  var uiUpdaters = [];

  function $(id) { return document.getElementById(id); }

  function stepDecimals(step) {
    return step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  }

  function formatKnobValue(ctrl, val) {
    var dec = stepDecimals(ctrl.step);
    var txt = Number(val).toFixed(dec);
    if (ctrl.key === 'direction') return activeTuning && activeTuning.corner ? 'auto' : txt + '\u00b0';
    if (ctrl.key === 'hueShift') return (val > 0 ? '+' : '') + txt + '\u00b0';
    if (ctrl.key === 'opacity' || ctrl.key === 'shimmer' || ctrl.key === 'sparkle' || ctrl.key === 'fog') {
      return Math.round(Number(val) * 100) + '%';
    }
    if (ctrl.key === 'density' || ctrl.key === 'speed' || ctrl.key === 'size') {
      return txt.replace(/\.?0+$/, '') + 'x';
    }
    return txt;
  }

  function ensureCfg() {
    if (!cfg) cfg = {};
    if (!cfg.creature) cfg.creature = 'butterflies';
    cfg.creature = CREATURE_ALIAS[cfg.creature] || cfg.creature;
    if (!findCreature(cfg.creature)) cfg.creature = 'butterflies';
    if (!cfg.byCreature || typeof cfg.byCreature !== 'object') cfg.byCreature = {};
  }

  function buildTuningFor(id) {
    var entry = findCreature(id);
    if (!entry || !entry.animal) return null;
    var animal = entry.animal;
    var overrides = cfg.byCreature[entry.id] || {};
    var out = Object.assign({}, animal.defaults);
    for (var k in overrides) {
      if (Object.prototype.hasOwnProperty.call(overrides, k) && k in out && overrides[k] !== undefined) {
        out[k] = overrides[k];
      }
    }
    return out;
  }

  function saveKnobOverride(key, val) {
    if (!activeAnimal) return;
    if (!cfg.byCreature[activeAnimal.key]) cfg.byCreature[activeAnimal.key] = {};
    if (val === activeAnimal.defaults[key]) {
      delete cfg.byCreature[activeAnimal.key][key];
    } else {
      cfg.byCreature[activeAnimal.key][key] = val;
    }
  }

  function updateGridAttr() {
    if (!cfg || cfg.creature === 'off') {
      document.documentElement.removeAttribute('data-ambient-grid');
    } else {
      document.documentElement.setAttribute('data-ambient-grid', 'active');
    }
  }

  function syncTheme() {
    updateGridAttr();
    if (renderer) renderer.syncPaletteFromCss();
  }

  function syncUi() {
    ensureCfg();
    updateGridAttr();

    var entry = findCreature(cfg.creature) || CREATURES[1];
    if (ui.badge) {
      ui.badge.textContent = entry.label;
      ui.badge.className = 'badge' + (entry.id !== 'off' ? ' ok' : '');
    }

    if (ui.creatureGrid) {
      var btns = ui.creatureGrid.querySelectorAll('.ambient-choice');
      for (var i = 0; i < btns.length; i++) {
        var on = btns[i].getAttribute('data-creature') === entry.id;
        btns[i].classList.toggle('active', on);
        btns[i].setAttribute('aria-checked', on ? 'true' : 'false');
      }
    }

    if (ui.tweaksBody) ui.tweaksBody.classList.toggle('hidden', entry.id === 'off');
    for (var u = 0; u < uiUpdaters.length; u++) uiUpdaters[u]();
  }

  function rebuildTweaksUi() {
    uiUpdaters = [];
    if (!ui.tweaksBody) return;
    ui.tweaksBody.innerHTML = '';
    if (!activeAnimal || !activeTuning) return;

    var hidden = activeAnimal.hide || [];
    var isHidden = function (k) { return hidden.indexOf(k) >= 0; };
    var sections = [
      ['Movement', SHARED_CONTROLS.movement.filter(function (c) { return !isHidden(c.key); })]
    ];
    for (var ci = 0; ci < activeAnimal.controls.length; ci++) {
      sections.push(activeAnimal.controls[ci]);
    }
    sections.push(['Look', SHARED_CONTROLS.look.filter(function (c) { return !isHidden(c.key); })]);

    function applyKnob(key, val) {
      activeTuning[key] = val;
      saveKnobOverride(key, val);
      if (renderer && flock) {
        if (key === 'detail') resizeStage();
        else if (key === 'hueShift' || key === 'grid' || key === 'opacity') renderer.restyle();
      }
      for (var u = 0; u < uiUpdaters.length; u++) uiUpdaters[u]();
    }

    sections.forEach(function (sec, idx) {
      var title = sec[0];
      var list = sec[1];
      if (!list || !list.length) return;

      var wrap = document.createElement('details');
      wrap.className = 'ambient-details';
      if (idx === 1 || idx === 0) wrap.setAttribute('open', '');

      var sum = document.createElement('summary');
      var chev = document.createElement('span');
      chev.className = 'chev';
      chev.textContent = '\u203a';
      sum.appendChild(chev);
      sum.appendChild(document.createTextNode(' ' + title));
      wrap.appendChild(sum);

      var toggles = list.filter(function (c) { return !!c.toggle; });
      var ranges = list.filter(function (c) { return !c.toggle; });

      if (toggles.length) {
        var swWrap = document.createElement('div');
        swWrap.className = 'switches ambient-switches';
        toggles.forEach(function (ctrl) {
          var lbl = document.createElement('label');
          lbl.className = 'switch';
          lbl.title = (ctrl.hint || ctrl.label) + ' (Double-click label to reset)';
          var inp = document.createElement('input');
          inp.type = 'checkbox';
          inp.id = 'amb_' + ctrl.key;
          var trk = document.createElement('span');
          trk.className = 'track';
          var knb = document.createElement('span');
          knb.className = 'knob';
          trk.appendChild(knb);
          var txt = document.createElement('span');
          txt.className = 'switch-label';
          txt.textContent = ctrl.label;
          inp.addEventListener('change', function () {
            applyKnob(ctrl.key, !!inp.checked);
            save();
          });
          txt.addEventListener('dblclick', function (ev) {
            ev.preventDefault();
            applyKnob(ctrl.key, activeAnimal.defaults[ctrl.key]);
            save();
          });
          uiUpdaters.push(function () { inp.checked = !!activeTuning[ctrl.key]; });
          lbl.appendChild(inp);
          lbl.appendChild(trk);
          lbl.appendChild(txt);
          swWrap.appendChild(lbl);
        });
        wrap.appendChild(swWrap);
      }

      if (ranges.length) {
        var grid = document.createElement('div');
        grid.className = 'grid2 ambient-sliders';
        ranges.forEach(function (ctrl) {
          var field = document.createElement('label');
          field.className = 'field';
          field.title = (ctrl.hint || ctrl.label) + ' (Double-click name to reset)';

          var head = document.createElement('span');
          head.className = 'field-head';
          var nameSpan = document.createElement('span');
          nameSpan.textContent = ctrl.label;
          var valSpan = document.createElement('span');
          valSpan.className = 'range-val';
          valSpan.id = 'amb_' + ctrl.key + '_val';
          head.appendChild(nameSpan);
          head.appendChild(valSpan);

          var rng = document.createElement('input');
          rng.type = 'range';
          rng.className = 'range';
          rng.id = 'amb_' + ctrl.key;
          rng.min = String(ctrl.min);
          rng.max = String(ctrl.max);
          rng.step = String(ctrl.step);

          rng.addEventListener('input', function () {
            applyKnob(ctrl.key, Number(rng.value));
          });
          rng.addEventListener('change', save);
          nameSpan.addEventListener('dblclick', function (ev) {
            ev.preventDefault();
            applyKnob(ctrl.key, activeAnimal.defaults[ctrl.key]);
            save();
          });

          uiUpdaters.push(function () {
            var v = activeTuning[ctrl.key];
            rng.value = String(v);
            var pct = ctrl.max > ctrl.min ? ((v - ctrl.min) / (ctrl.max - ctrl.min)) * 100 : 0;
            rng.style.setProperty('--pct', Math.max(0, Math.min(100, pct)) + '%');
            var isDis = !!(ctrl.disabledWhen && activeTuning[ctrl.disabledWhen]);
            rng.disabled = isDis;
            field.classList.toggle('is-disabled', isDis);
            valSpan.textContent = formatKnobValue(ctrl, v);
          });

          field.appendChild(head);
          field.appendChild(rng);
          grid.appendChild(field);
        });
        wrap.appendChild(grid);
      }

      ui.tweaksBody.appendChild(wrap);
    });

    for (var u = 0; u < uiUpdaters.length; u++) uiUpdaters[u]();
  }

  function resizeStage() {
    if (!canvas || !renderer || !flock) return;
    var rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
    var w = rect && rect.width >= 1 ? rect.width : (window.innerWidth || 420);
    var h = rect && rect.height >= 1 ? rect.height : (window.innerHeight || 680);
    if (w < 1 || h < 1) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.resize(w, h, dpr);
    flock.resize(w, h);
  }

  function stepFrame(now) {
    rafId = 0;
    if (!flock || !renderer || cfg.creature === 'off' || document.hidden) return;
    rafId = requestAnimationFrame(stepFrame);

    if (lastRender && now - lastRender < 26) return; // cap ~38fps for Premiere headroom
    var dt = lastTime ? Math.min(0.1, (now - lastTime) / 1000) : STEP;
    lastTime = now;
    lastRender = now;

    accTime += dt;
    var sub = 0;
    while (accTime >= STEP && sub < MAX_SUBSTEPS) {
      flock.step(STEP);
      accTime -= STEP;
      sub++;
    }
    if (sub === MAX_SUBSTEPS) accTime = 0;
    if (sub === 0) flock.step(STEP);
    renderer.render(flock, dt);
  }

  function startLoop() {
    if (rafId || !flock || !renderer || cfg.creature === 'off' || document.hidden) return;
    lastTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    lastRender = 0;
    accTime = 0;
    rafId = requestAnimationFrame(stepFrame);
  }

  function stopLoop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (renderer && renderer.ctx && canvas) {
      renderer.ctx.setTransform(1, 0, 0, 1, 0, 0);
      renderer.ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  function activateCreature(id) {
    var entry = findCreature(id) || CREATURES[0];
    cfg.creature = entry.id;
    stopLoop();

    if (entry.id === 'off' || !entry.animal || !canvas) {
      activeAnimal = null;
      activeTuning = null;
      flock = null;
      rebuildTweaksUi();
      syncUi();
      return;
    }

    activeAnimal = entry.animal;
    activeTuning = buildTuningFor(entry.id);
    if (!renderer) {
      try {
        renderer = new CellRenderer(canvas, activeTuning);
        if (typeof getComputedStyle === 'function') {
          renderer.setFontFamily(getComputedStyle(canvas).fontFamily);
        }
      } catch (e) {
        renderer = null;
        return;
      }
    }
    flock = new Flock(activeAnimal, activeTuning);
    renderer.setAnimal(activeAnimal, activeTuning);
    renderer.syncPaletteFromCss();
    resizeStage();
    rebuildTweaksUi();
    syncUi();
    startLoop();
  }

  function renderChoices() {
    if (!ui.creatureGrid) return;
    ui.creatureGrid.innerHTML = '';
    CREATURES.forEach(function (c) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ambient-choice';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('data-creature', c.id);

      var dot = document.createElement('span');
      dot.className = 'ambient-dot';
      dot.style.background = c.id === 'off'
        ? 'transparent'
        : ('rgb(' + c.rgb[0] + ',' + c.rgb[1] + ',' + c.rgb[2] + ')');
      if (c.id === 'off') dot.style.borderStyle = 'dashed';

      var lbl = document.createElement('span');
      lbl.textContent = c.label;

      btn.appendChild(dot);
      btn.appendChild(lbl);
      btn.addEventListener('click', function () {
        activateCreature(c.id);
        save();
      });
      ui.creatureGrid.appendChild(btn);
    });
  }

  function save() {
    if (typeof onPersist === 'function') onPersist();
  }

  function serializeTuning() {
    if (!activeAnimal || !activeTuning) return '{}';
    var diff = {};
    for (var k in activeAnimal.defaults) {
      if (Object.prototype.hasOwnProperty.call(activeAnimal.defaults, k)) {
        if (activeTuning[k] !== activeAnimal.defaults[k]) diff[k] = activeTuning[k];
      }
    }
    return JSON.stringify({ creature: activeAnimal.key, tuning: diff }, null, 2);
  }

  function onPointerDown(e) {
    if (!flock || cfg.creature === 'off') return;
    var tgt = e && e.target;
    if (tgt && typeof tgt.closest === 'function') {
      if (tgt.closest('button, input, select, textarea, a, label, summary, .cue')) return;
    }
    var x = e && isFinite(e.clientX) ? e.clientX : null;
    var y = e && isFinite(e.clientY) ? e.clientY : null;
    if (x === null || y === null) return;
    var rect = canvas && canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
    flock.startle(x - (rect ? rect.left || 0 : 0), y - (rect ? rect.top || 0 : 0));
  }

  function bind() {
    if (ui.reset) {
      ui.reset.addEventListener('click', function () {
        if (!activeAnimal) return;
        cfg.byCreature[activeAnimal.key] = {};
        activateCreature(activeAnimal.key);
        save();
      });
    }

    if (ui.copy) {
      ui.copy.addEventListener('click', function () {
        var json = serializeTuning();
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(json).then(function () {
            ui.copy.textContent = 'Copied';
            setTimeout(function () { ui.copy.textContent = 'Copy'; }, 1400);
          }).catch(function () {});
        } else {
          ui.copy.textContent = 'Copied';
          setTimeout(function () { ui.copy.textContent = 'Copy'; }, 1400);
        }
      });
    }

    if (canvas && typeof ResizeObserver === 'function') {
      resizeObs = new ResizeObserver(resizeStage);
      resizeObs.observe(canvas);
    }
    window.addEventListener('resize', resizeStage);
    window.addEventListener('pointerdown', onPointerDown, { passive: true });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && cfg.creature !== 'off') startLoop();
    });

    if (typeof MutationObserver === 'function' && document.documentElement) {
      themeObs = new MutationObserver(syncTheme);
      themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'data-glass'] });
    }
  }

  function init(ambientSettings, persistFn) {
    if (built) return;
    built = true;
    cfg = ambientSettings || {};
    onPersist = persistFn;
    ensureCfg();

    canvas = $('ambientCanvas');
    ui = {
      badge: $('ambientBadge'),
      copy: $('ambientCopy'),
      reset: $('ambientReset'),
      creatureGrid: $('ambientCreatures'),
      tweaksBody: $('ambientTweaksBody')
    };

    renderChoices();
    bind();
    activateCreature(cfg.creature);
  }

  return {
    CREATURES: CREATURES,
    init: init,
    syncUi: syncUi,
    syncTheme: syncTheme
  };
})();

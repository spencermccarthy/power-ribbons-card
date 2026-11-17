/*
 * Power Ribbons Card for Home Assistant
 *
 * Draws one ribbon per power source (e.g. Solar, Grid, Battery) over today.
 * Each ribbon is centred on its own line: its thickness is how much power the
 * source supplied, and it is split into coloured layers for where that power
 * went (e.g. House, Battery, Grid).
 *
 * MIT licence. https://github.com/spencermccarthy/power-ribbons-card
 */

const VERSION = '0.1.0';

const DEFAULT_COLOURS = {
  house: '#fb8c00',
  home: '#fb8c00',
  battery: '#43a047',
  grid: '#1e88e5',
  export: '#1e88e5',
};
const PALETTE = ['#8e24aa', '#00acc1', '#f4511e', '#7cb342', '#5e35b1', '#c0ca33'];
const HOUR = 3600000;
const DAY = 24 * HOUR;

class PowerRibbonsCard extends HTMLElement {
  static getStubConfig() {
    return {
      title: 'Where power came from and went today',
      destinations: {
        house: { name: 'House' },
        battery: { name: 'Battery' },
        grid: { name: 'Grid (export)' },
      },
      sources: [
        { name: 'Solar', flows: [{ entity: 'sensor.solar_to_house', to: 'house' }] },
      ],
    };
  }

  setConfig(config) {
    if (!config || !Array.isArray(config.sources) || !config.sources.length) {
      throw new Error('power-ribbons-card: "sources" is required');
    }
    for (const s of config.sources) {
      if (!s.name || !Array.isArray(s.flows) || !s.flows.length) {
        throw new Error('power-ribbons-card: every source needs "name" and "flows"');
      }
      for (const f of s.flows) {
        if (!f.entity || !f.to) throw new Error('power-ribbons-card: every flow needs "entity" and "to"');
      }
    }
    this._config = {
      bin_minutes: 10,
      height: 200,
      refresh_minutes: 5,
      opacity: 0.85,
      min_scale_kw: 1,
      label_width: 64,
      ...config,
    };
    this._destinations = this._buildDestinations(config);
    this._data = null;
    this._error = null;
    this._lastFetch = 0;
    this._buildShell();
  }

  set hass(hass) {
    this._hass = hass;
    const due = Date.now() - this._lastFetch > this._config.refresh_minutes * 60000;
    if (due && !this._fetching) this._fetch();
  }

  getCardSize() {
    return Math.ceil((this._config?.height || 200) / 50) + 2;
  }

  getGridOptions() {
    return { columns: 'full', min_columns: 6, rows: 'auto' };
  }

  connectedCallback() {
    if (!this._ro && this._plot) {
      this._ro = new ResizeObserver(() => this._draw());
      this._ro.observe(this._plot);
    }
  }

  disconnectedCallback() {
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
  }

  // ---------- setup ----------

  _buildDestinations(config) {
    const keys = [];
    for (const s of config.sources) for (const f of s.flows) if (!keys.includes(f.to)) keys.push(f.to);
    const out = {};
    let p = 0;
    for (const k of keys) {
      const c = (config.destinations || {})[k] || {};
      out[k] = {
        name: c.name || k.charAt(0).toUpperCase() + k.slice(1),
        color: c.color || DEFAULT_COLOURS[k] || PALETTE[p++ % PALETTE.length],
      };
    }
    return out;
  }

  _buildShell() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const c = this._config;
    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 12px 16px 12px; overflow: hidden; }
        .title { font-size: 16px; font-weight: 500; color: var(--primary-text-color); margin: 0 0 6px; line-height: 1.4; }
        .plot { position: relative; width: 100%; height: ${c.height}px; touch-action: pan-y; }
        svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
        .msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
               color: var(--secondary-text-color); font-size: 13px; }
        .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 6px; font-size: 12px;
                  color: var(--secondary-text-color); }
        .legend span { display: inline-flex; align-items: center; gap: 5px; }
        .legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
        .tip { position: absolute; pointer-events: none; display: none; z-index: 2; min-width: 150px;
               background: var(--card-background-color, #fff); color: var(--primary-text-color);
               border: 1px solid var(--divider-color, #ddd); border-radius: 8px; padding: 6px 8px;
               font-size: 12px; line-height: 1.45; box-shadow: 0 2px 8px rgba(0,0,0,.15); }
        .tip b { font-weight: 600; }
        .tip .src { margin-top: 3px; }
        .tip .row { display: flex; align-items: center; gap: 5px; color: var(--secondary-text-color); padding-left: 6px; }
        .tip .row i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
      </style>
      <ha-card>
        ${c.title ? `<div class="title"></div>` : ''}
        <div class="plot">
          <svg></svg>
          <div class="msg">Loading…</div>
          <div class="tip"></div>
        </div>
        <div class="legend"></div>
      </ha-card>`;
    if (c.title) this.shadowRoot.querySelector('.title').textContent = c.title;
    this._plot = this.shadowRoot.querySelector('.plot');
    this._svg = this.shadowRoot.querySelector('svg');
    this._msg = this.shadowRoot.querySelector('.msg');
    this._tip = this.shadowRoot.querySelector('.tip');

    const legend = this.shadowRoot.querySelector('.legend');
    const intro = document.createElement('span');
    intro.textContent = c.legend_text ?? 'Thickness = how much each source supplied. Colour = where it went:';
    legend.appendChild(intro);
    for (const d of Object.values(this._destinations)) {
      const s = document.createElement('span');
      const i = document.createElement('i');
      i.style.background = d.color;
      s.append(i, document.createTextNode(d.name));
      legend.appendChild(s);
    }

    this._plot.addEventListener('pointermove', (e) => this._hover(e));
    this._plot.addEventListener('pointerdown', (e) => this._hover(e));
    this._plot.addEventListener('pointerleave', () => this._hideHover());

    if (this._ro) this._ro.disconnect();
    this._ro = new ResizeObserver(() => this._draw());
    this._ro.observe(this._plot);
  }

  // ---------- data ----------

  _scale(entity) {
    const unit = this._hass?.states?.[entity]?.attributes?.unit_of_measurement;
    if (unit === 'W') return 0.001;
    if (unit === 'MW') return 1000;
    return 1; // kW or unknown
  }

  async _fetch() {
    if (!this._hass) return;
    this._fetching = true;
    this._lastFetch = Date.now();
    try {
      const c = this._config;
      const bin = c.bin_minutes * 60000;
      const day = new Date(); day.setHours(0, 0, 0, 0);
      const start = day.getTime();
      const end = Date.now();
      const nb = Math.max(1, Math.ceil((end - start) / bin));
      const ids = [];
      for (const s of c.sources) for (const f of s.flows) if (!ids.includes(f.entity)) ids.push(f.entity);

      const path = `history/period/${new Date(start).toISOString()}`
        + `?filter_entity_id=${encodeURIComponent(ids.join(','))}`
        + `&end_time=${encodeURIComponent(new Date(end).toISOString())}`
        + '&minimal_response&no_attributes';
      const hist = await this._hass.callApi('GET', path);

      const series = {};
      for (const rows of hist || []) {
        if (!rows || !rows.length) continue;
        const id = rows[0].entity_id;
        const k = this._scale(id);
        const sum = new Float64Array(nb), dur = new Float64Array(nb);
        for (let i = 0; i < rows.length; i++) {
          const v = parseFloat(rows[i].state);
          if (!isFinite(v)) continue;
          let a = Math.max(start, new Date(rows[i].last_changed || rows[i].lu * 1000).getTime());
          const nextRow = rows[i + 1];
          const b = nextRow ? new Date(nextRow.last_changed || nextRow.lu * 1000).getTime() : end;
          while (a < b) {
            const idx = Math.floor((a - start) / bin);
            const be = Math.min(b, start + (idx + 1) * bin);
            if (idx >= 0 && idx < nb) { sum[idx] += Math.max(0, v) * k * (be - a); dur[idx] += be - a; }
            a = be;
          }
        }
        series[id] = Array.from(sum, (s, i) => (dur[i] ? s / dur[i] : 0));
      }

      const times = Array.from({ length: nb }, (_, i) => Math.min(end, start + i * bin + bin / 2));
      const sources = c.sources.map((s) => {
        const layers = s.flows.map((f) => ({ to: f.to, values: series[f.entity] || new Array(nb).fill(0) }));
        const total = times.map((_, i) => layers.reduce((acc, l) => acc + l.values[i], 0));
        return { name: s.name, layers, total };
      });
      this._data = { start, end, times, sources };
      this._error = null;
    } catch (err) {
      this._error = (err && (err.message || err.body?.message)) || String(err);
    } finally {
      this._fetching = false;
      this._draw();
    }
  }

  // ---------- drawing ----------

  _geometry() {
    const c = this._config;
    const W = this._plot.clientWidth;
    const H = c.height;
    const padL = c.label_width, padR = 8, padT = 4, axisH = 20;
    const n = c.sources.length;
    const rowH = (H - padT - axisH) / n;
    const d = this._data;
    let maxKw = c.max_kw || 0;
    if (!maxKw) {
      maxKw = c.min_scale_kw;
      for (const s of d.sources) for (const v of s.total) if (v > maxKw) maxKw = v;
    }
    const pxPerKw = (rowH * 0.92) / maxKw;
    const x = (t) => padL + ((t - d.start) / DAY) * (W - padL - padR);
    const centre = (i) => padT + rowH * (i + 0.5);
    return { W, H, padL, padR, padT, axisH, rowH, pxPerKw, x, centre };
  }

  _draw() {
    if (!this._svg || !this._plot) return;
    const W = this._plot.clientWidth;
    if (!W) return;
    if (this._error) { this._msg.textContent = `Couldn't load history: ${this._error}`; this._msg.style.display = 'flex'; return; }
    if (!this._data) return;
    this._msg.style.display = 'none';

    const g = this._geometry();
    const d = this._data;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = this._svg;
    svg.setAttribute('viewBox', `0 0 ${g.W} ${g.H}`);
    svg.innerHTML = '';
    const el = (tag, attrs, parent = svg) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      parent.appendChild(e);
      return e;
    };

    // x positions: ribbon starts at midnight edge, ends at "now"
    const xs = [g.x(d.start), ...d.times.map(g.x), g.x(d.end)];
    const pad = (arr) => [arr[0], ...arr, arr[arr.length - 1]];

    // hour grid + axis labels
    const plotW = g.W - g.padL - g.padR;
    const step = plotW < 420 ? 6 : plotW < 700 ? 3 : 2;
    for (let h = 0; h <= 24; h += step) {
      const xx = g.x(d.start + h * HOUR);
      el('line', { x1: xx, x2: xx, y1: g.padT, y2: g.H - g.axisH, stroke: 'var(--divider-color, #e0e0e0)', 'stroke-width': 1, opacity: 0.5 });
      if (h < 24) {
        const t = el('text', { x: xx, y: g.H - 5, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--secondary-text-color)' });
        t.textContent = `${String(h).padStart(2, '0')}:00`;
      }
    }

    // ribbons
    d.sources.forEach((s, i) => {
      const cy = g.centre(i);
      el('line', { x1: g.padL, x2: g.W - g.padR, y1: cy, y2: cy, stroke: 'var(--secondary-text-color)', 'stroke-width': 1, 'stroke-dasharray': '3 4', opacity: 0.35 });
      const label = el('text', { x: g.padL - 10, y: cy, 'text-anchor': 'end', 'dominant-baseline': 'central', 'font-size': 12, 'font-weight': 600, fill: 'var(--secondary-text-color)' });
      label.textContent = s.name;

      // cumulative edges, top to bottom, centred on cy
      let edge = pad(s.total.map((t) => cy - (t * g.pxPerKw) / 2));
      for (const layer of s.layers) {
        const vals = pad(layer.values.map((v) => v * g.pxPerKw));
        const next = edge.map((y, k) => y + vals[k]);
        const path = smoothPath(xs, edge) + ' ' + smoothPath(xs.slice().reverse(), next.slice().reverse(), true) + ' Z';
        el('path', { d: path, fill: this._destinations[layer.to].color, 'fill-opacity': this._config.opacity, stroke: 'none' });
        edge = next;
      }
    });

    // now marker
    const nx = g.x(d.end);
    el('line', { x1: nx, x2: nx, y1: g.padT, y2: g.H - g.axisH, stroke: 'var(--primary-color, #03a9f4)', 'stroke-width': 1.5, 'stroke-dasharray': '4 3' });

    this._hoverLine = el('line', { x1: 0, x2: 0, y1: g.padT, y2: g.H - g.axisH, stroke: 'var(--primary-text-color)', 'stroke-width': 1, opacity: 0, 'pointer-events': 'none' });
  }

  _hover(e) {
    if (!this._data || !this._hoverLine) return;
    const g = this._geometry();
    const rect = this._plot.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const d = this._data;
    const t = d.start + ((px - g.padL) / (g.W - g.padL - g.padR)) * DAY;
    if (t < d.start || t > d.end) { this._hideHover(); return; }
    const bin = this._config.bin_minutes * 60000;
    const idx = Math.min(d.times.length - 1, Math.max(0, Math.floor((t - d.start) / bin)));
    const xx = g.x(d.times[idx]);
    this._hoverLine.setAttribute('x1', xx);
    this._hoverLine.setAttribute('x2', xx);
    this._hoverLine.setAttribute('opacity', 0.4);

    const binStart = new Date(d.start + idx * bin);
    const fmt = (dt) => `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
    const kw = (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + ' kW';
    const tip = this._tip;
    tip.innerHTML = '';
    const head = document.createElement('b');
    head.textContent = `${fmt(binStart)}–${fmt(new Date(Math.min(d.end, binStart.getTime() + bin)))}`;
    tip.appendChild(head);
    for (const s of d.sources) {
      if (s.total[idx] < 0.05) continue;
      const src = document.createElement('div');
      src.className = 'src';
      src.textContent = `${s.name}: ${kw(s.total[idx])}`;
      tip.appendChild(src);
      for (const l of s.layers) {
        if (l.values[idx] < 0.05) continue;
        const row = document.createElement('div');
        row.className = 'row';
        const i = document.createElement('i');
        i.style.background = this._destinations[l.to].color;
        row.append(i, document.createTextNode(`${this._destinations[l.to].name} ${kw(l.values[idx])}`));
        tip.appendChild(row);
      }
    }
    if (tip.childElementCount === 1) {
      const none = document.createElement('div');
      none.className = 'src';
      none.textContent = 'No flow';
      tip.appendChild(none);
    }
    tip.style.display = 'block';
    const tw = tip.offsetWidth;
    const left = xx + 12 + tw > rect.width ? xx - 12 - tw : xx + 12;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = '4px';
  }

  _hideHover() {
    if (this._tip) this._tip.style.display = 'none';
    if (this._hoverLine) this._hoverLine.setAttribute('opacity', 0);
  }
}

// Monotone-ish smoothing: Catmull-Rom -> cubic Bézier, clamped so curves never overshoot between points.
function smoothPath(xs, ys, continueLine = false) {
  let p = `${continueLine ? 'L' : 'M'} ${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`;
  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = xs[Math.max(0, i - 1)], y0 = ys[Math.max(0, i - 1)];
    const x1 = xs[i], y1 = ys[i];
    const x2 = xs[i + 1], y2 = ys[i + 1];
    const x3 = xs[Math.min(xs.length - 1, i + 2)], y3 = ys[Math.min(ys.length - 1, i + 2)];
    const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
    const c1x = x1 + (x2 - x0) / 6, c1y = Math.min(hi, Math.max(lo, y1 + (y2 - y0) / 6));
    const c2x = x2 - (x3 - x1) / 6, c2y = Math.min(hi, Math.max(lo, y2 - (y3 - y1) / 6));
    p += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }
  return p;
}

if (!customElements.get('power-ribbons-card')) {
  customElements.define('power-ribbons-card', PowerRibbonsCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'power-ribbons-card',
    name: 'Power Ribbons Card',
    description: 'One ribbon per power source over today, coloured by where the power went.',
    preview: false,
  });
  console.info(`%c POWER-RIBBONS-CARD %c ${VERSION} `, 'color:#fff;background:#fb8c00;font-weight:600', 'color:#fb8c00;background:#fff');
}

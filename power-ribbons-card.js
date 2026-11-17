/*
 * Power Ribbons Card for Home Assistant
 *
 * Shows where power came from and where it went today.
 * "All" tab: one centred ribbon per source (e.g. Solar, Grid, Battery), with a
 * ribbon per destination (e.g. House, Battery, Grid) as thick as the power sent there.
 * Source tabs: actual vs the plan at 00:00 (and the latest plan), with hourly bars
 * of where the power went (actual) and is expected to go (forecast split).
 *
 * Visual style (header, pill tabs, fading fills, tooltip) is modelled on
 * Predbat Card by mimikm, https://github.com/mimikm/Predbat-Card (MIT).
 *
 * MIT licence. https://github.com/spencermccarthy/power-ribbons-card
 */

const VERSION = '0.5.5';

const DEFAULT_COLOURS = {
  house: '#fb8c00',
  home: '#fb8c00',
  battery: '#43a047',
  grid: '#1e88e5',
  export: '#1e88e5',
};
const SOURCE_COLOURS = { solar: '#f9a825', grid: '#546e7a', battery: '#8e24aa' };
const SLOT = 5 * 60000;
const PALETTE = ['#8e24aa', '#00acc1', '#f4511e', '#7cb342', '#5e35b1', '#c0ca33'];
const HOUR = 3600000;
const DAY = 24 * HOUR;
const NS = 'http://www.w3.org/2000/svg';

class PowerRibbonsCard extends HTMLElement {
  static getStubConfig() {
    return {
      title: 'Power flows today',
      destinations: { house: { name: 'House' }, battery: { name: 'Battery' }, grid: { name: 'Grid (export)' } },
      sources: [{ name: 'Solar', flows: [{ entity: 'sensor.solar_to_house', to: 'house' }] }],
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
      mode: 'overlap',
      opacity: 0.85,
      fill_opacity: 0.35,
      stroke_width: 2,
      min_scale_kw: 1,
      label_width: 64,
      tabs: true,
      detail_height: 300,
      ...config,
    };
    this._destinations = this._buildDestinations(config);
    let sc = 0;
    this._sourceInfo = {};
    for (const s of config.sources) {
      const lname = s.name.toLowerCase();
      const role = s.role || (['solar', 'grid', 'battery'].includes(lname) ? lname : null);
      this._sourceInfo[s.name] = { role, color: s.color || SOURCE_COLOURS[role] || PALETTE[sc++ % PALETTE.length] };
    }
    this._startPlan = null;
    this._startPlanDay = null;
    this._tab = this._tab && (this._tab === 'all' || config.sources.some((s) => s.name === this._tab)) ? this._tab : 'all';
    this._data = null;
    this._error = null;
    this._lastFetch = 0;
    this._uid = Math.random().toString(36).slice(2, 8);
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

  // ---------------------------------------------------------------- setup

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
        :host { --prc-muted: var(--secondary-text-color, #6b6f76);
                --prc-line: color-mix(in srgb, var(--primary-text-color, #000) 12%, transparent);
                --prc-tile: color-mix(in srgb, var(--primary-text-color, #000) 4%, transparent); }
        ha-card { padding: 14px 16px 12px; overflow: hidden; display: flex; flex-direction: column; gap: 8px; }
        .head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; min-height: 30px; }
        .ttl { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--prc-muted); }
        .tabs { display: inline-flex; gap: 2px; padding: 3px; border-radius: 999px; background: var(--prc-tile);
                border: 1px solid var(--prc-line); max-width: 100%; overflow-x: auto; scrollbar-width: none; }
        .tabs::-webkit-scrollbar { display: none; }
        .tabs button { border: none; background: none; color: var(--prc-muted); font: inherit; font-size: 13px; font-weight: 600;
                       padding: 4px 12px; border-radius: 999px; cursor: pointer; white-space: nowrap; flex: none; }
        .tabs button.on { background: var(--card-background-color, #fff); color: var(--primary-text-color);
                          box-shadow: 0 1px 3px rgba(0,0,0,.15); }
        .summary { font-size: 13px; color: var(--prc-muted); font-variant-numeric: tabular-nums; min-height: 18px; }
        .summary b { color: var(--primary-text-color); font-weight: 650; }
        .summary .chip { display: inline-flex; align-items: center; gap: 5px; margin-left: 12px; white-space: nowrap; }
        .summary .chip i { width: 10px; height: 10px; border-radius: 3px; background: var(--c); }
        .plot { position: relative; width: 100%; height: ${c.height}px; touch-action: pan-y; }
        svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
        svg .axis { font-size: 11px; fill: var(--prc-muted); font-variant-numeric: tabular-nums; }
        svg .grid { stroke: var(--prc-line); stroke-width: 1; }
        svg .lbl { font-size: 12px; font-weight: 600; fill: var(--prc-muted); }
        .msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
               color: var(--prc-muted); font-size: 13px; text-align: center; }
        .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--prc-muted); }
        .legend span { display: inline-block; white-space: nowrap; }
        .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; background: var(--c); vertical-align: -1px; }
        .legend i.line { height: 3px; border-radius: 2px; vertical-align: 2px; }
        .legend i.none { display: none; }
        .legend i.dot { height: 0; width: 14px; border-top: 2px dotted var(--c); background: none; border-radius: 0; vertical-align: 3px; opacity: .6; }
        .legend b { color: var(--primary-text-color); font-weight: 600; }
        .legend i.dash { height: 0; width: 14px; border-top: 2px dashed var(--c); background: none; border-radius: 0; vertical-align: 3px; }
        .tip { position: absolute; top: 4px; pointer-events: none; z-index: 2; display: none;
               background: var(--card-background-color, #fff); color: var(--primary-text-color);
               border: 1px solid var(--prc-line); border-radius: 10px; padding: 8px 11px; font-size: 12px;
               box-shadow: 0 4px 16px rgba(0,0,0,.15); white-space: nowrap; font-variant-numeric: tabular-nums; line-height: 1.5; }
        .tip b { font-weight: 650; }
        .tip .row { display: flex; justify-content: space-between; gap: 14px; }
        .tip .row.sub { color: var(--prc-muted); padding-left: 8px; }
        .tip .row i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; background: var(--c); }
        .tip .sep { height: 4px; }
      </style>
      <ha-card>
        <div class="head"><div class="ttl"></div><div class="tabs" role="tablist"></div></div>
        <div class="summary"></div>
        <div class="plot">
          <svg></svg>
          <div class="msg">Loading…</div>
          <div class="tip"></div>
        </div>
        <div class="legend"></div>
      </ha-card>`;
    const $ = (s) => this.shadowRoot.querySelector(s);
    $('.ttl').textContent = c.title || '';
    this._tabsEl = $('.tabs');
    this._summary = $('.summary');
    this._plot = $('.plot');
    this._svg = $('svg');
    this._msg = $('.msg');
    this._tip = $('.tip');
    this._legend = $('.legend');

    const tabs = c.tabs ? [['all', c.all_label || 'All'], ...c.sources.map((s) => [s.name, s.name])] : [];
    this._tabsEl.style.display = tabs.length ? '' : 'none';
    for (const [key, label] of tabs) {
      const b = document.createElement('button');
      b.setAttribute('role', 'tab');
      b.dataset.tab = key;
      b.textContent = label;
      b.addEventListener('click', () => { this._tab = key; this._hideHover(); this._render(); });
      this._tabsEl.appendChild(b);
    }

    this._plot.addEventListener('pointermove', (e) => this._hover(e));
    this._plot.addEventListener('pointerdown', (e) => this._hover(e));
    this._plot.addEventListener('pointerleave', () => this._hideHover());

    if (this._ro) this._ro.disconnect();
    this._ro = new ResizeObserver(() => this._draw());
    this._ro.observe(this._plot);
    this._render();
  }

  _render() {
    const all = this._tab === 'all';
    this._plot.style.height = `${all ? this._config.height : this._config.detail_height}px`;
    // source tabs: forecast/actual key sits above the chart (it describes the top half),
    // the where-it-went key sits below (it describes the mirrored bars)
    this._plot.style.order = 2;
    this._legend.style.order = all ? 3 : 1;
    this._summary.style.order = all ? 1 : 3;
    for (const b of this._tabsEl.children) {
      const on = b.dataset.tab === this._tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on);
    }
    this._renderLegend();
    this._renderSummary();
    this._draw();
  }

  _source() {
    return this._data?.sources.find((s) => s.name === this._tab) || null;
  }

  _renderLegend() {
    const lg = this._legend;
    lg.innerHTML = '';
    const all = this._tab === 'all';
    const chip = (cls, colour, html) => {
      const s = document.createElement('span');
      const i = document.createElement('i');
      if (cls) i.className = cls;
      i.style.setProperty('--c', colour);
      s.append(i);
      s.insertAdjacentHTML('beforeend', html);
      lg.appendChild(s);
    };
    if (all) {
      const intro = document.createElement('span');
      intro.textContent = this._config.legend_text ?? 'Each colour is where that source’s power went; thickness = how much:';
      if (intro.textContent) lg.appendChild(intro);
      for (const k of Object.keys(this._destinations)) chip('', this._destinations[k].color, escapeHtml(this._destinations[k].name));
      return;
    }
    const s = this._source();
    const m = s ? this._sourceModel(s) : null;
    if (!m) return;
    const k = (v) => `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} kWh`;
    const fc = m.fc;
    if (fc && fc.kind === 'solar') {
      chip('line', m.color, `Forecast <b>${k(fc.total)}</b>`);
      if (fc.total10 !== null && fc.total90 !== null) chip('', `color-mix(in srgb, ${m.color} 35%, transparent)`, `10–90% <b>${k(fc.total10)}–${k(fc.total90)}</b>`);
      if (fc.left !== null) chip('none', 'transparent', `Left today <b>${k(fc.left)}</b>${fc.left10 !== null && fc.left90 !== null ? ` (${fc.left10.toFixed(1)}–${fc.left90.toFixed(1)})` : ''}`);
    } else if (fc) {
      chip('line', m.color, `Start-of-day estimate <b>${k(fc.total)}</b>`);
    }
    const pct = m.forecastSoFar > 0.05 ? ` (${Math.round((m.actualSoFar / m.forecastSoFar) * 100)}%)` : '';
    chip('', m.actualColor, `Actual <b>${k(m.actualSoFar)}</b>${fc ? ` vs ${k(m.forecastSoFar)} ${fc.kind === 'solar' ? 'forecast' : 'estimated'} so far${pct}` : ''}`);
    if (fc && fc.kind === 'solar' && fc.raw !== null && fc.calibrated) chip('dash', 'var(--prc-muted)', `Before calibration ${k(fc.raw)}`);
    if (fc && fc.kind === 'plan' && m.latestRest !== null) chip('dash', m.color, `Latest plan, rest of today <b>${k(m.latestRest)}</b>`);
    if (fc) chip('dot', m.color, 'Forecast mirrored below the line');
  }

  _renderSummary() {
    const el = this._summary;
    el.innerHTML = '';
    if (!this._data) return;
    const hours = this._config.bin_minutes / 60;
    const kwh = (arr) => arr.reduce((a, v) => a + v, 0) * hours;
    const fmt = (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));
    if (this._tab === 'all') {
      const parts = this._data.sources.map((s) => `${escapeHtml(s.name)} <b>${fmt(kwh(s.total))}</b>`);
      el.innerHTML = `Today (kWh): ${parts.join(' · ')}`;
      return;
    }
    const s = this._source();
    if (!s) return;
    const m = this._sourceModel(s);
    const withPlan = m && m.hasPlanDest;
    const head = document.createElement('span');
    head.textContent = withPlan ? 'Where it went so far vs the start-of-day estimate (kWh):' : 'Where it went so far (kWh):';
    el.appendChild(head);
    for (const l of s.layers) {
      const d = this._destinations[l.to];
      const c = document.createElement('span');
      c.className = 'chip';
      c.style.setProperty('--c', d.color);
      const plan = withPlan
        ? ` <span>vs ${fmt(m.planDestSoFar[l.to] || 0)} · day ${fmt(m.planDestDay[l.to] || 0)}</span>`
        : '';
      c.innerHTML = `<i></i>${escapeHtml(d.name)} <b>${fmt(kwh(l.values))}</b>${plan}`;
      el.appendChild(c);
    }
  }

  // ---------------------------------------------------------------- data

  _scale(entity) {
    const unit = this._hass?.states?.[entity]?.attributes?.unit_of_measurement;
    if (unit === 'W') return 0.001;
    if (unit === 'MW') return 1000;
    return 1;
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
      if (c.forecast && this._startPlanDay !== start) await this._fetchStartPlan(start);
      this._error = null;
    } catch (err) {
      this._error = (err && (err.message || err.body?.message)) || String(err);
    } finally {
      this._fetching = false;
      this._render();
    }
  }

  // ---------------------------------------------------------------- forecast

  // The plan as it stood at midnight, read back from HA history (attributes kept by the recorder).
  async _fetchStartPlan(start) {
    const fc = this._config.forecast || {};
    const attr = fc.attribute || 'results';
    const roles = ['solar', 'grid', 'battery'].filter((r) => fc[r]);
    if (!roles.length) return;
    try {
      const ids = roles.map((r) => fc[r]);
      const path = `history/period/${new Date(start - 30 * 60000).toISOString()}`
        + `?filter_entity_id=${encodeURIComponent(ids.join(','))}`
        + `&end_time=${encodeURIComponent(new Date(start + 15 * 60000).toISOString())}`
        + '&significant_changes_only=0';
      const hist = await this._hass.callApi('GET', path);
      const plan = {};
      for (const rows of hist || []) {
        if (!rows || !rows.length) continue;
        const id = rows[0].entity_id;
        const role = roles.find((r) => fc[r] === id);
        let pick = null;
        for (const r of rows) {
          const t = new Date(r.last_updated || r.last_changed).getTime();
          if (t <= start + 5 * 60000 && r.attributes?.[attr]) pick = r;
        }
        if (!pick) pick = rows.find((r) => r.attributes?.[attr]) || null;
        if (pick && role) plan[role] = parsePlan(pick.attributes[attr]);
      }
      this._startPlan = plan;
      this._startPlanDay = start;
    } catch (err) {
      this._startPlan = null;
    }
  }

  _latestPlan() {
    const fc = this._config.forecast || {};
    const attr = fc.attribute || 'results';
    const out = {};
    for (const r of ['solar', 'grid', 'battery']) {
      const st = fc[r] && this._hass?.states?.[fc[r]];
      if (!st) continue;
      const key = st.last_updated;
      this._latestCache = this._latestCache || {};
      if (this._latestCache[r]?.key !== key) this._latestCache[r] = { key, pts: parsePlan(st.attributes?.[attr]) };
      out[r] = this._latestCache[r].pts;
    }
    return out;
  }

  // Power a source supplies at time t according to a plan (kW, or null outside the plan).
  // Plans: solar = PV power, grid = + import / - export, battery = + discharge / - charge.
  _supplyAt(plan, role, t) {
    const v = stepAt(plan?.[role], t);
    return v === null ? null : Math.max(0, v);
  }

  // Estimated destination split of a plan at time t, using the inverter's usual priority:
  // solar -> house, battery, grid; battery -> house, grid; grid -> house, battery.
  _splitAt(plan, t) {
    const pv = stepAt(plan?.solar, t), g = stepAt(plan?.grid, t), b = stepAt(plan?.battery, t);
    if (pv === null || g === null || b === null) return null;
    const solar = Math.max(0, pv);
    const load = Math.max(0, solar + g + b);
    const imp = Math.max(0, g), dis = Math.max(0, b), chg = Math.max(0, -b);
    const s2h = Math.min(solar, load); let rest = load - s2h;
    const b2h = Math.min(dis, rest); rest -= b2h;
    const g2h = Math.min(imp, rest);
    const g2b = Math.min(imp - g2h, chg);
    const s2b = Math.min(solar - s2h, Math.max(0, chg - g2b));
    return {
      solar: { house: s2h, battery: s2b, grid: Math.max(0, solar - s2h - s2b) },
      grid: { house: g2h, battery: g2b },
      battery: { house: b2h, grid: Math.max(0, dis - b2h) },
    };
  }

  // ---------------------------------------------------------------- drawing

  _frame() {
    const c = this._config;
    const W = this._plot.clientWidth;
    const all = this._tab === 'all';
    const H = all ? c.height : c.detail_height;
    const padL = all ? c.label_width : 40, padR = 8, padT = 6, axisH = 20;
    const d = this._data;
    const x = (t) => padL + ((t - d.start) / DAY) * (W - padL - padR);
    return { W, H, padL, padR, padT, axisH, x, bottom: H - axisH };
  }

  _draw() {
    if (!this._svg || !this._plot) return;
    const W = this._plot.clientWidth;
    if (!W) return;
    if (this._error) { this._msg.textContent = `Couldn't load history: ${this._error}`; this._msg.style.display = 'flex'; return; }
    if (!this._data) return;
    this._msg.style.display = 'none';

    const f = this._frame();
    const svg = this._svg;
    svg.setAttribute('viewBox', `0 0 ${f.W} ${f.H}`);
    svg.innerHTML = '';
    this._defs = el('defs', {}, svg);
    this._timeAxis(f);
    if (this._tab === 'all') this._drawAll(f);
    else this._drawSource(f, this._source());

    const nx = f.x(this._data.end);
    el('line', { x1: nx, x2: nx, y1: f.padT, y2: f.bottom, stroke: 'var(--primary-color, #03a9f4)', 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }, svg);
    this._hoverLine = el('line', { x1: 0, x2: 0, y1: f.padT, y2: f.bottom, class: 'grid', 'stroke-width': 1, opacity: 0, 'pointer-events': 'none', style: 'stroke: var(--primary-text-color)' }, svg);
    this._hoverDots = el('g', { 'pointer-events': 'none' }, svg);
  }

  _timeAxis(f) {
    const d = this._data;
    const plotW = f.W - f.padL - f.padR;
    const step = plotW < 420 ? 6 : plotW < 700 ? 3 : 2;
    for (let h = 0; h <= 24; h += step) {
      const xx = f.x(d.start + h * HOUR);
      el('line', { x1: xx, x2: xx, y1: f.padT, y2: f.bottom, class: 'grid', opacity: 0.6 }, this._svg);
      if (h < 24) {
        const t = el('text', { x: xx, y: f.H - 5, 'text-anchor': 'middle', class: 'axis' }, this._svg);
        t.textContent = `${String(h).padStart(2, '0')}:00`;
      }
    }
  }

  _gradient(colour, kind, y1, y2) {
    const id = `prc-${this._uid}-${this._gid = (this._gid || 0) + 1}`;
    const g = el('linearGradient', { id, x1: 0, x2: 0, y1, y2, gradientUnits: 'userSpaceOnUse' }, this._defs);
    const op = this._config.fill_opacity;
    const stops = kind === 'down'
      ? [[0, op], [1, 0]]
      : [[0, op * 0.25], [0.5, op], [1, op * 0.25]];
    for (const [o, a] of stops) el('stop', { offset: o, 'stop-color': colour, 'stop-opacity': a }, g);
    return `url(#${id})`;
  }

  _drawAll(f) {
    const c = this._config;
    const d = this._data;
    const n = d.sources.length;
    const rowH = (f.bottom - f.padT) / n;
    let maxKw = c.max_kw || 0;
    if (!maxKw) {
      maxKw = c.min_scale_kw;
      for (const s of d.sources) {
        const arrays = c.mode === 'stack' ? [s.total] : s.layers.map((l) => l.values);
        for (const arr of arrays) for (const v of arr) if (v > maxKw) maxKw = v;
      }
    }
    const pxPerKw = (rowH * 0.92) / maxKw;
    const xs = [f.x(d.start), ...d.times.map(f.x), f.x(d.end)];
    this._allGeom = { rowH, pxPerKw };

    d.sources.forEach((s, i) => {
      const cy = f.padT + rowH * (i + 0.5);
      el('line', { x1: f.padL, x2: f.W - f.padR, y1: cy, y2: cy, class: 'grid', 'stroke-dasharray': '3 4' }, this._svg);
      const label = el('text', { x: f.padL - 10, y: cy, 'text-anchor': 'end', 'dominant-baseline': 'central', class: 'lbl' }, this._svg);
      label.textContent = s.name;
      const half = rowH * 0.46;

      if (c.mode === 'stack') {
        let edge = pad(s.total.map((t) => cy - (t * pxPerKw) / 2));
        for (const layer of s.layers) {
          const vals = pad(layer.values.map((v) => v * pxPerKw));
          const next = edge.map((y, k) => y + vals[k]);
          const path = smoothPath(xs, edge) + ' ' + smoothPath(xs.slice().reverse(), next.slice().reverse(), true) + ' Z';
          el('path', { d: path, fill: this._destinations[layer.to].color, 'fill-opacity': c.opacity }, this._svg);
          edge = next;
        }
        return;
      }

      const order = s.layers.slice().sort((a, b) => sumOf(b.values) - sumOf(a.values));
      for (const layer of order) {
        const colour = this._destinations[layer.to].color;
        const fill = this._gradient(colour, 'centre', cy - half, cy + half);
        const hw = pad(layer.values.map((v) => (v * pxPerKw) / 2));
        for (const [a, b] of runs(hw, 0.4)) {
          const sx = xs.slice(a, b + 1);
          const top = hw.slice(a, b + 1).map((h) => cy - h);
          const bot = hw.slice(a, b + 1).map((h) => cy + h);
          el('path', {
            d: smoothPath(sx, top) + ' ' + smoothPath(sx.slice().reverse(), bot.slice().reverse(), true) + ' Z',
            fill, stroke: colour, 'stroke-width': c.stroke_width, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
          }, this._svg);
        }
      }
    });
  }

  // Detail model for one source, in fixed periods (default 30 min) across today.
  _sourceModel(s) {
    const d = this._data;
    const c = this._config;
    const fcCfg = c.forecast || {};
    const info = this._sourceInfo[s.name] || {};
    const role = info.role;
    const detailId = role === 'solar' ? fcCfg.solar_detail : null;
    const detailSt = detailId ? this._hass?.states?.[detailId] : null;
    const latestSt = role && fcCfg[role] ? this._hass?.states?.[fcCfg[role]] : null;
    const key = [s.name, d.end, this._startPlanDay, detailSt?.last_updated, latestSt?.last_updated].join('|');
    if (this._modelCache?.key === key) return this._modelCache.m;

    const P = (c.period_minutes || 30) * 60000;
    const bin = c.bin_minutes * 60000;
    const n = Math.round(DAY / P);
    const per = Array.from({ length: n }, (_, k) => ({ t: d.start + k * P, actual: null, dest: {}, fdest: {}, f: null, f10: null, f90: null, raw: null, latest: null }));

    // actual: average kW over the elapsed part of each period
    for (const p of per) {
      const i0 = Math.floor((p.t - d.start) / bin), i1 = Math.min(d.times.length, Math.floor((p.t + P - d.start) / bin));
      if (i1 <= i0) continue;
      let sum = 0;
      for (let i = i0; i < i1; i++) sum += s.total[i];
      p.actual = sum / (i1 - i0);
      for (const l of s.layers) {
        let v = 0;
        for (let i = i0; i < i1; i++) v += l.values[i];
        p.dest[l.to] = v / (i1 - i0);
      }
    }

    // forecast for the whole day
    let fc = null;
    const num = (v) => { const x = parseFloat(v); return isFinite(x) ? x : null; };
    if (detailSt) {
      const a = detailSt.attributes || {};
      let list = a.detailedForecast || a.detailed_forecast || [];
      if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = []; } }
      const total = num(a.total ?? a.estimate), totalCL = num(a.totalCL), state = num(detailSt.state);
      const calibrated = totalCL !== null && total !== null && Math.abs(totalCL - total) > 0.05;
      for (const q of Array.isArray(list) ? list : []) {
        const t = new Date(String(q.period_start).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')).getTime();
        const k = Math.round((t - d.start) / P);
        if (k < 0 || k >= n || Math.abs(t - per[k].t) > P / 3) continue;
        const v = num(q.pv_estimate), cl = num(q.pv_estimateCL);
        per[k].f = calibrated && cl !== null ? cl : v;
        per[k].raw = calibrated ? v : null;
        per[k].f10 = num(q.pv_estimate10);
        per[k].f90 = num(q.pv_estimate90);
      }
      fc = {
        kind: 'solar', calibrated,
        total: state ?? (calibrated ? totalCL : total), raw: total,
        total10: num(a.total10 ?? a.estimate10), total90: num(a.total90 ?? a.estimate90),
        left: num(calibrated ? a.remainingCL : a.remaining), left10: num(a.remaining10), left90: num(a.remaining90),
      };
    } else if (role && this._startPlan?.[role]) {
      let total = 0;
      for (const p of per) {
        let sum = 0, cnt = 0;
        for (let t = p.t; t < p.t + P; t += SLOT) { const v = this._supplyAt(this._startPlan, role, t + SLOT / 2); if (v !== null) { sum += v; cnt++; } }
        p.f = cnt ? sum / cnt : null;
        if (p.f !== null) total += p.f * (P / HOUR);
      }
      fc = { kind: 'plan', total };
    }

    // latest plan: rest of today, plus the forecast split by destination
    const latest = c.forecast ? this._latestPlan() : null;
    let latestRest = null;
    const canSplit = role && latest && latest.solar && latest.grid && latest.battery;
    for (const p of per) {
      const from = Math.max(p.t, d.end), to = p.t + P;
      if (from >= to) continue;
      let sum = 0, cnt = 0;
      const split = {};
      let scnt = 0;
      for (let t = from; t < to; t += SLOT) {
        const mid = Math.min(to, t + SLOT / 2);
        if (role && latest?.[role]) { const v = this._supplyAt(latest, role, mid); if (v !== null) { sum += v; cnt++; } }
        if (canSplit) {
          const sp = this._splitAt(latest, mid);
          if (sp && sp[role]) { scnt++; for (const l of s.layers) split[l.to] = (split[l.to] || 0) + (sp[role][l.to] || 0); }
        }
      }
      if (cnt) {
        p.latest = sum / cnt;
        if (fc?.kind === 'plan') latestRest = (latestRest || 0) + p.latest * ((to - from) / HOUR);
      }
      if (scnt) for (const l of s.layers) p.fdest[l.to] = (split[l.to] || 0) / scnt;
    }

    // what each destination was expected to take, from the 00:00 plan (same split rules as the forecast)
    const sp0 = this._startPlan;
    const planDestSoFar = {}, planDestDay = {};
    let hasPlanDest = false;
    if (role && sp0 && sp0.solar && sp0.grid && sp0.battery) {
      for (const p of per) {
        const acc = {};
        let cnt = 0;
        for (let t = p.t; t < p.t + P; t += SLOT) {
          const sp = this._splitAt(sp0, t + SLOT / 2);
          if (!sp || !sp[role]) continue;
          cnt++;
          for (const l of s.layers) acc[l.to] = (acc[l.to] || 0) + (sp[role][l.to] || 0);
        }
        if (!cnt) continue;
        hasPlanDest = true;
        p.pdest = {};
        const overlap = Math.max(0, Math.min(p.t + P, d.end) - p.t);
        for (const l of s.layers) {
          const v = (acc[l.to] || 0) / cnt;
          p.pdest[l.to] = v;
          planDestDay[l.to] = (planDestDay[l.to] || 0) + v * (P / HOUR);
          planDestSoFar[l.to] = (planDestSoFar[l.to] || 0) + v * (overlap / HOUR);
        }
      }
    }

    const hours = c.bin_minutes / 60;
    const actualSoFar = s.total.reduce((a, v) => a + v, 0) * hours;
    let forecastSoFar = 0;
    for (const p of per) {
      if (p.f === null) continue;
      const overlap = Math.max(0, Math.min(p.t + P, d.end) - p.t);
      forecastSoFar += p.f * (overlap / HOUR);
    }
    const m = { role, P, per, fc, latestRest, actualSoFar, forecastSoFar, color: info.color,
      hasPlanDest, planDestSoFar, planDestDay,
      actualColor: c.actual_color || 'color-mix(in srgb, var(--primary-text-color) 38%, transparent)' };
    this._modelCache = { key, m };
    return m;
  }

  _drawSource(f, s) {
    if (!s) return;
    const d = this._data;
    const m = this._sourceModel(s);
    const svg = this._svg;
    const per = m.per;

    let up = 0.5;
    for (const p of per) for (const v of [p.actual, p.f, p.f90, p.raw, p.latest]) if (v !== null && v > up) up = v;
    const upMax = niceCeil(up * 1.08);
    // the forecast that matters for the rest of today: solar = the forecast line, others = latest plan
    // the main forecast line (solar forecast, or the plan at 00:00), falling back to the latest plan
    const forecastVal = (p) => p.f ?? p.latest;
    let low = 0.25;
    for (const p of per) {
      let a = Object.values(p.dest).reduce((x, v) => x + v, 0);
      a = Math.max(a, forecastVal(p) || 0);
      if (a > low) low = a;
    }
    const lowMax = Math.max(low * 1.08, upMax * 0.25);
    const px = (f.bottom - f.padT) / (upMax + lowMax);
    const axisY = f.padT + upMax * px;
    const Y = (v) => axisY - v * px;
    const YD = (v) => axisY + v * px;
    this._srcGeom = { Y, YD, axisY };

    // past shading
    el('rect', { x: f.x(d.start), y: f.padT, width: Math.max(0, f.x(d.end) - f.x(d.start)), height: f.bottom - f.padT,
      fill: 'var(--primary-text-color)', 'fill-opacity': 0.035 }, svg);

    // upper ticks (left)
    const niceSteps = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50];
    const ticks = [3, 4, 5, 6, 2].find((k) => niceSteps.some((st) => Math.abs(upMax / k - st) < 1e-9)) || 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (upMax * i) / ticks;
      const yy = Y(v);
      if (i) el('line', { x1: f.padL, x2: f.W - f.padR, y1: yy, y2: yy, class: 'grid' }, svg);
      const t = el('text', { x: f.padL - 6, y: yy + 4, 'text-anchor': 'end', class: 'axis' }, svg);
      t.textContent = i === 0 ? '0 kW' : fmtNum(v);
    }
    // lower tick: same kW scale, mirrored
    const lowTick = niceFloor(lowMax);
    if (lowTick > 0) {
      el('line', { x1: f.padL, x2: f.W - f.padR, y1: YD(lowTick), y2: YD(lowTick), class: 'grid', 'stroke-dasharray': '2 4' }, svg);
      const t = el('text', { x: f.padL - 6, y: YD(lowTick) + 4, 'text-anchor': 'end', class: 'axis' }, svg);
      t.textContent = fmtNum(lowTick);
    }

    const mid = (p) => f.x(p.t + m.P / 2);
    const pw = f.x(d.start + m.P) - f.x(d.start);
    const bw = Math.max(1.5, pw * 0.78);
    const bx = (p) => f.x(p.t) + (pw - bw) / 2;

    // 10-90% band
    const band = per.filter((p) => p.f10 !== null && p.f90 !== null);
    if (band.length > 1) {
      const xs = band.map(mid);
      el('path', { d: smoothPath(xs, band.map((p) => Y(p.f90))) + ' ' + smoothPath(xs.slice().reverse(), band.map((p) => Y(p.f10)).reverse(), true) + ' Z',
        fill: m.color, 'fill-opacity': 0.18 }, svg);
    }

    // actual bars (up) and where it went (down)
    for (const p of per) {
      if (p.actual !== null && p.actual > 0.001) {
        el('rect', { x: bx(p), y: Y(p.actual), width: bw, height: Math.max(0.5, axisY - Y(p.actual)), rx: 2, fill: m.actualColor, 'fill-opacity': 0.85 }, svg);
      }
      let acc = 0;
      for (const l of s.layers) {
        const v = p.dest[l.to] || 0;
        if (v <= 0.001) continue;
        el('rect', { x: bx(p), y: YD(acc), width: bw, height: Math.max(0.5, YD(acc + v) - YD(acc)), rx: 1.5, fill: this._destinations[l.to].color, 'fill-opacity': 0.85 }, svg);
        acc += v;
      }
    }

    // the forecast line mirrored below the axis (dotted, whole day) so actual vs forecast reads on both sides
    const mir = per.filter((p) => forecastVal(p) !== null);
    if (mir.length > 1) {
      const xs = [f.x(d.start), ...mir.map(mid), f.x(d.start + DAY)];
      const ys = [YD(forecastVal(mir[0])), ...mir.map((p) => YD(forecastVal(p))), YD(forecastVal(mir[mir.length - 1]))];
      el('path', { d: smoothPath(xs, ys), fill: 'none', stroke: m.color, 'stroke-width': 2.2,
        'stroke-dasharray': '0.1 4.5', 'stroke-linecap': 'round', opacity: 0.95 }, svg);
    }

    // forecast line with fading fill
    const fpts = per.filter((p) => p.f !== null);
    if (fpts.length > 1) {
      const xs = [f.x(d.start), ...fpts.map(mid), f.x(d.start + DAY)];
      const ys = [Y(fpts[0].f), ...fpts.map((p) => Y(p.f)), Y(fpts[fpts.length - 1].f)];
      const line = smoothPath(xs, ys);
      el('path', { d: `${line} L ${xs[xs.length - 1].toFixed(1)} ${axisY} L ${xs[0].toFixed(1)} ${axisY} Z`,
        fill: this._gradient(m.color, 'down', f.padT, axisY) }, svg);
      el('path', { d: line, fill: 'none', stroke: m.color, 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    }
    // before calibration (solar) / latest plan (others)
    const dashed = per.filter((p) => (m.fc?.kind === 'solar' ? p.raw : p.latest) !== null);
    if (dashed.length > 1) {
      const val = (p) => (m.fc?.kind === 'solar' ? p.raw : p.latest);
      el('path', { d: smoothPath(dashed.map(mid), dashed.map((p) => Y(val(p)))), fill: 'none',
        stroke: m.fc?.kind === 'solar' ? 'var(--primary-text-color)' : m.color, 'stroke-width': 1.4, 'stroke-dasharray': '4 3',
        opacity: m.fc?.kind === 'solar' ? 0.7 : 0.95 }, svg);
    }

    // axis line
    el('line', { x1: f.padL, x2: f.W - f.padR, y1: axisY, y2: axisY, stroke: 'var(--prc-muted)', 'stroke-width': 1, opacity: 0.6 }, svg);

    // "Now" label and the forecast value at now
    const nx = f.x(d.end);
    const nl = el('text', { x: nx + 4, y: f.padT + 10, class: 'axis' }, svg);
    nl.textContent = 'Now';
    const cur = per[Math.min(per.length - 1, Math.floor((d.end - d.start) / m.P))];
    const curV = cur ? (cur.latest ?? cur.f) : null;
    if (curV !== null && curV !== undefined) {
      el('circle', { cx: nx, cy: Y(curV), r: 3.5, fill: 'var(--card-background-color, #fff)', stroke: m.color, 'stroke-width': 2 }, svg);
      const vl = el('text', { x: nx, y: Y(curV) - 8, 'text-anchor': 'middle', class: 'axis', style: 'font-weight:700; fill: var(--primary-text-color)' }, svg);
      vl.textContent = `${curV.toFixed(1)} kW`;
    }
  }

  _axisTicks(f, top, Y, unit) {
    const niceSteps = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50];
    const ticks = [4, 5, 3, 6, 2].find((n) => niceSteps.some((st) => Math.abs(top / n - st) < 1e-9)) || 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (top * i) / ticks;
      const yy = Y(v);
      el('line', { x1: f.padL, x2: f.W - f.padR, y1: yy, y2: yy, class: 'grid' }, this._svg);
      const t = el('text', { x: f.W - f.padR + 6, y: yy + 4, class: 'axis' }, this._svg);
      t.textContent = i === ticks ? `${fmtNum(v)} ${unit}` : fmtNum(v);
    }
  }

  // ---------------------------------------------------------------- hover

  _hover(e) {
    if (!this._data || !this._hoverLine) return;
    const f = this._frame();
    const rect = this._plot.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const d = this._data;
    const t = d.start + ((px - f.padL) / (f.W - f.padL - f.padR)) * DAY;
    const all = this._tab === 'all';
    if (t < d.start || t > (all ? d.end : d.start + DAY)) { this._hideHover(); return; }
    const kw = (v) => `${v >= 10 ? v.toFixed(0) : v.toFixed(2)} kW`;
    const hm = (ms) => { const dt = new Date(ms); return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`; };
    this._hoverDots.innerHTML = '';
    let xx;
    const rows = [];

    if (all) {
      const bin = this._config.bin_minutes * 60000;
      const idx = Math.min(d.times.length - 1, Math.max(0, Math.floor((t - d.start) / bin)));
      xx = f.x(d.times[idx]);
      const bs = d.start + idx * bin;
      rows.push(`<b>${hm(bs)}–${hm(Math.min(d.end, bs + bin))}</b>`);
      for (const s of d.sources) {
        if (s.total[idx] < 0.05) continue;
        rows.push(`<div class="sep"></div><div class="row"><span>${escapeHtml(s.name)}</span><b>${kw(s.total[idx])}</b></div>`);
        for (const l of s.layers) {
          if (l.values[idx] < 0.05) continue;
          const dd = this._destinations[l.to];
          rows.push(`<div class="row sub"><span><i style="--c:${dd.color}"></i>${escapeHtml(dd.name)}</span><span>${kw(l.values[idx])}</span></div>`);
        }
      }
      if (rows.length === 1) rows.push('<div class="row sub"><span>No flow</span></div>');
    } else {
      const s = this._source();
      if (!s) return;
      const m = this._sourceModel(s);
      const g = this._srcGeom;
      const k = Math.min(m.per.length - 1, Math.max(0, Math.floor((t - d.start) / m.P)));
      const p = m.per[k];
      xx = f.x(p.t + m.P / 2);
      rows.push(`<b>${hm(p.t)}–${hm(p.t + m.P)}</b>`);
      const solar = m.fc?.kind === 'solar';
      if (p.f !== null) {
        rows.push(`<div class="row"><span><i style="--c:${m.color}"></i>${solar ? 'Forecast' : 'Start-of-day estimate'}</span><b>${kw(p.f)}</b></div>`);
        if (g) el('circle', { cx: xx, cy: g.Y(p.f), r: 3.5, fill: 'var(--card-background-color, #fff)', stroke: m.color, 'stroke-width': 2 }, this._hoverDots);
      }
      if (p.f10 !== null && p.f90 !== null) rows.push(`<div class="row sub"><span>10–90%</span><span>${p.f10.toFixed(2)}–${kw(p.f90)}</span></div>`);
      if (solar && p.raw !== null) rows.push(`<div class="row sub"><span>Before calibration</span><span>${kw(p.raw)}</span></div>`);
      if (!solar && p.latest !== null) rows.push(`<div class="row sub"><span>Latest plan</span><span>${kw(p.latest)}</span></div>`);
      if (p.actual !== null) rows.push(`<div class="row"><span><i style="--c:${m.actualColor}"></i>Actual${p.t + m.P > d.end ? ' so far' : ''}</span><b>${kw(p.actual)}</b></div>`);
      const hasAct = Object.keys(p.dest).length > 0;
      if (hasAct || p.pdest) {
        rows.push(`<div class="sep"></div><div class="row"><span>${hasAct ? 'Went to' : 'Expected to go to'}</span>${hasAct && p.pdest ? '<span>actual · estimate</span>' : ''}</div>`);
        for (const l of s.layers) {
          const dd = this._destinations[l.to];
          const a = hasAct ? kw(p.dest[l.to] || 0) : '';
          const pl = p.pdest ? kw(p.pdest[l.to] || 0) : '';
          const val = hasAct && p.pdest ? `${a} · ${pl}` : (a || pl);
          rows.push(`<div class="row sub"><span><i style="--c:${dd.color}"></i>${escapeHtml(dd.name)}</span><span>${val}</span></div>`);
        }
      }
    }
    this._hoverLine.setAttribute('x1', xx);
    this._hoverLine.setAttribute('x2', xx);
    this._hoverLine.setAttribute('opacity', 0.35);
    const tip = this._tip;
    tip.innerHTML = rows.join('');
    tip.style.display = 'block';
    const tw = tip.offsetWidth;
    const left = xx + 14 + tw > rect.width ? xx - 14 - tw : xx + 14;
    tip.style.left = `${Math.max(0, left)}px`;
  }

  _hideHover() {
    if (this._tip) this._tip.style.display = 'none';
    if (this._hoverLine) this._hoverLine.setAttribute('opacity', 0);
    if (this._hoverDots) this._hoverDots.innerHTML = '';
  }
}

// ------------------------------------------------------------------ helpers

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

// Predbat-style forecast attribute: { "2026-11-17T12:05:00+0000": 1.5, ... } -> sorted [[ms, value]]
function parsePlan(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const pts = [];
  for (const [k, v] of Object.entries(obj)) {
    const t = new Date(String(k).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')).getTime();
    const n = parseFloat(v);
    if (isFinite(t) && isFinite(n)) pts.push([t, n]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  return pts.length ? pts : null;
}

// Value in force at time t for a change-point series (null before it starts).
function stepAt(pts, t) {
  if (!pts || !pts.length || t < pts[0][0]) return null;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid][0] <= t) lo = mid; else hi = mid - 1;
  }
  return pts[lo][1];
}

function niceFloor(v) {
  const steps = [0.25, 0.5, 1, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50];
  let best = 0;
  for (const st of steps) if (st <= v) best = st;
  return best;
}

function pad(arr) {
  return [arr[0], ...arr, arr[arr.length - 1]];
}

function sumOf(arr) {
  let s = 0;
  for (const v of arr) s += v;
  return s;
}

function niceCeil(v) {
  const steps = [0.5, 1, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50];
  for (const s of steps) if (v <= s) return s;
  return Math.ceil(v / 10) * 10;
}

function fmtNum(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Index ranges where the half-thickness is visible, widened by one point each
// side so a ribbon tapers to the centre line rather than starting with a cliff.
function runs(half, minPx) {
  const out = [];
  let a = -1;
  for (let i = 0; i < half.length; i++) {
    if (half[i] >= minPx) {
      if (a < 0) a = Math.max(0, i - 1);
    } else if (a >= 0) {
      out.push([a, i]);
      a = -1;
    }
  }
  if (a >= 0) out.push([a, half.length - 1]);
  return out;
}

// Catmull-Rom -> cubic Bézier, clamped so curves never overshoot between points.
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
    description: 'Where power came from and went today: centred ribbons per source, with a tab per source.',
    preview: false,
  });
  console.info(`%c POWER-RIBBONS-CARD %c ${VERSION} `, 'color:#fff;background:#fb8c00;font-weight:600', 'color:#fb8c00;background:#fff');
}

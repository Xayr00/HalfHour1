'use strict';

(() => {
  const DB_NAME = 'halfhour-local';
  const DB_VERSION = 1;
  const SCHEMA_VERSION = 1;
  const CACHE_NAME = 'halfhour-shell-v1';
  const EMPTY_COLOR = '#e9ede7';
  const STATUSES = ['none', 'done', 'skipped', 'moved'];
  const STATUS_LABELS = { none: 'None', done: 'Done', skipped: 'Skipped', moved: 'Moved' };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  let db = null;
  let toastTimer = null;
  let importBusy = false;
  let state = {
    settings: { theme: 'light', defaultStartHour: 6, selectedDate: localDateKey(new Date()) },
    actions: [], templates: [], schedules: {}, activeView: 'day', templateEditorId: null, offlineReady: false
  };

  function localDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  function parseDateKey(key) {
    const [y, m, d] = String(key).split('-').map(Number);
    if (!y || !m || !d) return null;
    const date = new Date(y, m - 1, d, 12, 0, 0, 0);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
    return date;
  }
  function shiftDateKey(key, amount) {
    const date = parseDateKey(key) || new Date();
    date.setDate(date.getDate() + amount);
    return localDateKey(date);
  }
  function formatLongDate(key) {
    const date = parseDateKey(key);
    return date ? new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(date) : key;
  }
  function formatShortDate(key) {
    const date = parseDateKey(key);
    return date ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date) : key;
  }
  function makeId(prefix) {
    const random = globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return `${prefix}-${random}`;
  }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  }
  function isHexColor(value) { return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value); }
  function normalizeHex(value) { return isHexColor(value) ? value.toLowerCase() : null; }
  function hexRgb(hex) {
    const clean = (normalizeHex(hex) || '#e9ede7').slice(1);
    return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
  }
  function relativeLuminance(hex) {
    const rgb = hexRgb(hex).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  }
  function contrastText(hex) { return relativeLuminance(hex) > 0.22 ? '#202620' : '#ffffff'; }
  function formatTime(totalMinutes) {
    const mins = ((totalMinutes % 1440) + 1440) % 1440;
    const hour24 = Math.floor(mins / 60);
    const minute = mins % 60;
    const hour12 = hour24 % 12 || 12;
    return `${hour12}:${String(minute).padStart(2, '0')} ${hour24 >= 12 ? 'PM' : 'AM'}`;
  }
  function formatHour(totalMinutes) {
    const mins = ((totalMinutes % 1440) + 1440) % 1440;
    const hour24 = Math.floor(mins / 60);
    return `${hour24 % 12 || 12} ${hour24 >= 12 ? 'PM' : 'AM'}`;
  }
  function formatTimeRange(start, end) {
    const a = ((start % 1440) + 1440) % 1440;
    const b = ((end % 1440) + 1440) % 1440;
    const periodA = a >= 720 ? 'PM' : 'AM';
    const periodB = b >= 720 ? 'PM' : 'AM';
    const hhmm = (mins) => {
      const h = Math.floor(mins / 60) % 12 || 12;
      return `${h}:${String(mins % 60).padStart(2, '0')}`;
    };
    if (periodA === periodB) return `${hhmm(a)}–${hhmm(b)} ${periodA}`;
    return `${formatTime(a)}–${formatTime(b)}`;
  }
  function startHourLabel(hour) { return formatTime((hour % 24) * 60); }
  function emptySlot() { return { actionId: null, label: null, color: null, status: 'none' }; }
  function emptySlots() { return Array.from({ length: 48 }, emptySlot); }
  function makeEmptySchedule(date, startHour = state.settings.defaultStartHour, templateId = null) {
    return { date, startHour, templateId: templateId || null, slots: emptySlots() };
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function resolvedSlot(slot, actions = state.actions) {
    const action = slot?.actionId ? actions.find(item => item.id === slot.actionId) : null;
    const label = slot?.label !== null && slot?.label !== undefined ? slot.label : (action?.label ?? null);
    const color = slot?.color !== null && slot?.color !== undefined ? slot.color : (action?.color ?? null);
    return { label: label || null, color: color || null, action };
  }
  function plannedCount(slots, actions = state.actions) {
    return slots.reduce((count, slot) => count + (resolvedSlot(slot, actions).label?.trim() ? 1 : 0), 0);
  }
  function getSchedule(date = state.settings.selectedDate) {
    return state.schedules[date] || makeEmptySchedule(date, state.settings.defaultStartHour);
  }
  function statusCount(slots, status) { return slots.filter(slot => slot.status === status).length; }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('The local database could not be written.'));
      tx.onabort = () => reject(tx.error || new Error('The local database transaction was cancelled.'));
    });
  }
  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not read local data.'));
    });
  }
  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('This browser does not support local structured storage. Open HalfHour in a recent version of Safari or Chrome.'));
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('actions')) database.createObjectStore('actions', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('templates')) database.createObjectStore('templates', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('schedules')) database.createObjectStore('schedules', { keyPath: 'date' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('HalfHour could not open its on-device database.'));
      request.onblocked = () => reject(new Error('Close other HalfHour tabs and refresh this one to finish opening local storage.'));
    });
  }
  async function loadDatabase() {
    const tx = db.transaction(['meta', 'actions', 'templates', 'schedules'], 'readonly');
    const settingsReq = tx.objectStore('meta').get('settings');
    const actionsReq = tx.objectStore('actions').getAll();
    const templatesReq = tx.objectStore('templates').getAll();
    const schedulesReq = tx.objectStore('schedules').getAll();
    const [settingsRow, actions, templates, schedules] = await Promise.all([
      requestResult(settingsReq), requestResult(actionsReq), requestResult(templatesReq), requestResult(schedulesReq)
    ]);
    await txDone(tx);
    return {
      settings: settingsRow?.value || null,
      actions: Array.isArray(actions) ? actions : [],
      templates: Array.isArray(templates) ? templates : [],
      schedules: Object.fromEntries((Array.isArray(schedules) ? schedules : []).map(item => [item.date, item]))
    };
  }
  async function putRecord(storeName, record) {
    const tx = db.transaction([storeName], 'readwrite');
    tx.objectStore(storeName).put(record);
    await txDone(tx);
  }
  async function removeRecord(storeName, key) {
    const tx = db.transaction([storeName], 'readwrite');
    tx.objectStore(storeName).delete(key);
    await txDone(tx);
  }
  async function replaceAllData(data) {
    const tx = db.transaction(['meta', 'actions', 'templates', 'schedules'], 'readwrite');
    const meta = tx.objectStore('meta');
    const actionsStore = tx.objectStore('actions');
    const templatesStore = tx.objectStore('templates');
    const schedulesStore = tx.objectStore('schedules');
    meta.clear(); actionsStore.clear(); templatesStore.clear(); schedulesStore.clear();
    meta.put({ id: 'settings', value: clone(data.settings) });
    for (const action of data.actions) actionsStore.put(clone(action));
    for (const template of data.templates) templatesStore.put(clone(template));
    const schedules = Array.isArray(data.schedules) ? data.schedules : Object.values(data.schedules || {});
    for (const schedule of schedules) schedulesStore.put(clone(schedule));
    await txDone(tx);
  }

  function starterActions() {
    return [
      { id: 'starter-study', name: 'Study', label: 'Study', color: '#8fb3e8', starter: true },
      { id: 'starter-school', name: 'School', label: 'School', color: '#a6cfae', starter: true },
      { id: 'starter-break', name: 'Break', label: 'Break', color: '#f0c786', starter: true },
      { id: 'starter-prayer', name: 'Prayer', label: 'Prayer', color: '#c0afe8', starter: true },
      { id: 'starter-exercise', name: 'Exercise', label: 'Exercise', color: '#e9a19a', starter: true },
      { id: 'starter-reading', name: 'Reading', label: 'Read', color: '#91c9bf', starter: true },
      { id: 'starter-rest', name: 'Rest', label: 'Rest', color: '#bdc5cf', starter: true }
    ];
  }
  function clockIndex(startHour, hour, minute = 0) {
    return (((hour * 60 + minute) - startHour * 60 + 1440) % 1440) / 30;
  }
  function starterTemplate(id, name, startHour, events) {
    const slots = emptySlots();
    for (const event of events) {
      const [hourText, minuteText = '00'] = event.at.split(':');
      const startIndex = clockIndex(startHour, Number(hourText), Number(minuteText));
      const duration = Math.max(1, Math.round(event.minutes / 30));
      for (let offset = 0; offset < duration; offset++) {
        const index = (startIndex + offset) % 48;
        slots[index] = { actionId: event.actionId || null, label: event.label ?? null, color: event.color || null, status: 'none' };
      }
    }
    return { id, name, startHour, slots, starter: true, createdAt: new Date().toISOString() };
  }
  function initialData() {
    const actions = starterActions();
    const templates = [
      starterTemplate('starter-school-day', 'School Day', 6, [
        { at: '06:00', minutes: 30, actionId: 'starter-rest', label: 'Wake up' },
        { at: '06:30', minutes: 60, actionId: 'starter-break', label: 'Get ready' },
        { at: '07:30', minutes: 300, actionId: 'starter-school' },
        { at: '12:30', minutes: 60, actionId: 'starter-break', label: 'Lunch' },
        { at: '14:30', minutes: 90, actionId: 'starter-study' },
        { at: '16:00', minutes: 30, actionId: 'starter-prayer' },
        { at: '17:00', minutes: 60, actionId: 'starter-exercise' },
        { at: '18:00', minutes: 60, actionId: 'starter-break', label: 'Dinner' },
        { at: '19:00', minutes: 90, actionId: 'starter-study' },
        { at: '20:30', minutes: 60, actionId: 'starter-reading' },
        { at: '21:30', minutes: 90, actionId: 'starter-rest', label: 'Wind down' }
      ]),
      starterTemplate('starter-thursday', 'Thursday', 7, [
        { at: '07:00', minutes: 60, actionId: 'starter-rest', label: 'Slow morning' },
        { at: '08:00', minutes: 90, actionId: 'starter-study' },
        { at: '09:30', minutes: 30, actionId: 'starter-break' },
        { at: '10:00', minutes: 120, actionId: 'starter-study' },
        { at: '12:00', minutes: 60, actionId: 'starter-break', label: 'Lunch' },
        { at: '14:00', minutes: 60, actionId: 'starter-exercise' },
        { at: '16:00', minutes: 60, actionId: 'starter-prayer' },
        { at: '18:00', minutes: 60, actionId: 'starter-break', label: 'Dinner' },
        { at: '19:00', minutes: 60, actionId: 'starter-reading' },
        { at: '21:00', minutes: 90, actionId: 'starter-rest' }
      ]),
      starterTemplate('starter-friday', 'Friday', 8, [
        { at: '08:00', minutes: 60, actionId: 'starter-rest', label: 'Easy start' },
        { at: '09:00', minutes: 60, actionId: 'starter-break', label: 'Breakfast' },
        { at: '10:00', minutes: 60, actionId: 'starter-reading' },
        { at: '12:00', minutes: 60, actionId: 'starter-break', label: 'Lunch' },
        { at: '14:00', minutes: 60, actionId: 'starter-rest', label: 'Rest' },
        { at: '16:00', minutes: 60, actionId: 'starter-exercise' },
        { at: '18:00', minutes: 60, actionId: 'starter-prayer' },
        { at: '19:00', minutes: 60, actionId: 'starter-break', label: 'Family time' },
        { at: '20:00', minutes: 60, actionId: 'starter-reading' }
      ]),
      starterTemplate('starter-saturday', 'Saturday', 7, [
        { at: '07:00', minutes: 60, actionId: 'starter-rest', label: 'Morning' },
        { at: '08:00', minutes: 90, actionId: 'starter-break', label: 'Breakfast' },
        { at: '10:00', minutes: 90, actionId: 'starter-exercise' },
        { at: '12:00', minutes: 60, actionId: 'starter-study' },
        { at: '13:00', minutes: 60, actionId: 'starter-break', label: 'Lunch' },
        { at: '15:00', minutes: 60, actionId: 'starter-reading' },
        { at: '17:00', minutes: 60, actionId: 'starter-prayer' },
        { at: '18:00', minutes: 60, actionId: 'starter-study' },
        { at: '20:00', minutes: 60, actionId: 'starter-break', label: 'Free time' },
        { at: '21:00', minutes: 60, actionId: 'starter-rest' }
      ])
    ];
    return {
      settings: { theme: 'light', defaultStartHour: 6, selectedDate: localDateKey(new Date()) },
      actions,
      templates,
      schedules: []
    };
  }

  async function boot() {
    try {
      db = await openDatabase();
      let stored = await loadDatabase();
      if (!stored.settings) {
        const hasOtherData = stored.actions.length > 0 || stored.templates.length > 0 || Object.keys(stored.schedules).length > 0;
        if (!hasOtherData) {
          const initial = initialData();
          await replaceAllData(initial);
          stored = await loadDatabase();
        } else {
          // A missing preference row is recoverable. Do not erase otherwise valid
          // Actions, Templates, or schedules just because settings are absent.
          stored.settings = { theme: 'light', defaultStartHour: 6, selectedDate: localDateKey(new Date()) };
          await putRecord('meta', { id: 'settings', value: stored.settings });
        }
      }
      const rawSettings = stored.settings && typeof stored.settings === 'object' && !Array.isArray(stored.settings) ? stored.settings : {};
      const settings = { theme: 'light', defaultStartHour: 6, selectedDate: localDateKey(new Date()), ...rawSettings };
      if (!['light', 'dark'].includes(settings.theme)) settings.theme = 'light';
      if (!Number.isInteger(settings.defaultStartHour) || settings.defaultStartHour < 0 || settings.defaultStartHour > 23) settings.defaultStartHour = 6;
      if (!parseDateKey(settings.selectedDate)) settings.selectedDate = localDateKey(new Date());
      if (JSON.stringify(settings) !== JSON.stringify(rawSettings)) await putRecord('meta', { id: 'settings', value: settings });
      const repaired = repairLoadedCollections(stored, settings);
      state.settings = settings;
      state.actions = repaired.actions;
      state.templates = repaired.templates;
      state.schedules = repaired.schedules;
      document.documentElement.dataset.theme = state.settings.theme;
      render();
      registerServiceWorker();
    } catch (error) {
      console.error(error);
      $('#main-content').innerHTML = `<section class="empty-state"><span class="empty-state-mark">${icon('database')}</span><h3>HalfHour couldn't open local storage</h3><p>${escapeHtml(error.message || 'Your browser may be blocking site data. Open this app from its hosted HTTPS address, then refresh.')}</p><button class="button button-primary" type="button" data-action="retry-boot">Try again</button></section>`;
      $('#storage-indicator').innerHTML = '<span class="status-dot" style="background:var(--danger)"></span><span>Storage unavailable</span>';
    }
  }

  function icon(name) {
    const icons = {
      plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
      arrowLeft: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
      arrowRight: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
      back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6M9 12h11"/></svg>',
      calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M7.5 3.5v3M16.5 3.5v3M3.5 9.5h17"/></svg>',
      clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></svg>',
      copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/></svg>',
      edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5 5 5M4 20l4.2-.9L19.4 7.9a2.1 2.1 0 0 0-3-3L5.2 16.1 4 20Z"/></svg>',
      trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5"/></svg>',
      check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7"/></svg>',
      database: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6M4 11.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>',
      download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 19v2h16v-2"/></svg>',
      upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m-5 5 5-5 5 5M4 19v2h16v-2"/></svg>',
      close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
      template: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="7" height="7" rx="1.7"/><rect x="13.5" y="4" width="7" height="7" rx="1.7"/><rect x="3.5" y="14" width="7" height="6" rx="1.7"/><rect x="13.5" y="14" width="7" height="6" rx="1.7"/></svg>'
    };
    return icons[name] || '';
  }

  function render() {
    document.documentElement.dataset.theme = state.settings.theme;
    const themeMeta = $('meta[name="theme-color"]');
    if (themeMeta) themeMeta.content = state.settings.theme === 'dark' ? '#151916' : '#f7f7f4';
    const main = $('#main-content');
    if (state.activeView === 'day') main.innerHTML = renderDay();
    else if (state.activeView === 'actions') main.innerHTML = renderActions();
    else if (state.activeView === 'templates' && state.templateEditorId) main.innerHTML = renderTemplateEditor();
    else if (state.activeView === 'templates') main.innerHTML = renderTemplates();
    else main.innerHTML = renderSettings();
    $$('.nav-item').forEach(button => {
      const active = button.dataset.nav === state.activeView && !(state.activeView === 'settings');
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    if (state.activeView === 'settings') {
      $('#storage-indicator').innerHTML = `<span class="status-dot" style="${state.offlineReady ? '' : 'background:#bd9b59'}"></span><span>${state.offlineReady ? 'Offline-ready shell' : 'On this device'}</span>`;
    } else {
      $('#storage-indicator').innerHTML = '<span class="status-dot"></span><span>On this device</span>';
    }
  }

  function renderDay() {
    const date = state.settings.selectedDate;
    const schedule = getSchedule(date);
    const planned = plannedCount(schedule.slots);
    const done = statusCount(schedule.slots, 'done');
    const skipped = statusCount(schedule.slots, 'skipped');
    const today = localDateKey(new Date());
    return `
      <section class="day-view" aria-labelledby="day-title">
        <div class="screen-heading">
          <div><p class="eyebrow">Your day, in half-hours</p><h1 id="day-title">Plan at your own pace.</h1><p class="subheading">Forty-eight small spaces. Leave any of them empty — your time is yours.</p></div>
          <div class="heading-actions"><button class="button button-primary" type="button" data-action="start-time">${icon('clock')} Start at ${escapeHtml(startHourLabel(schedule.startHour))}</button></div>
        </div>
        <div class="date-toolbar">
          <div class="date-controls">
            <button class="icon-plain" type="button" data-action="previous-day" aria-label="Previous day" title="Previous day">${icon('arrowLeft')}</button>
            <div class="date-title"><strong>${escapeHtml(formatLongDate(date))}${date === today ? ' <span class="pill" style="vertical-align:middle;margin-left:5px">TODAY</span>' : ''}</strong><small>${date === today ? 'Your selected day' : 'A separate plan for this date'}</small></div>
            <button class="icon-plain" type="button" data-action="next-day" aria-label="Next day" title="Next day">${icon('arrowRight')}</button>
          </div>
          <div class="heading-actions">
            <label class="button date-picker-button" title="Choose a date">${icon('calendar')} Choose date<input aria-label="Choose a date" type="date" value="${escapeHtml(date)}" data-input="selected-date"></label>
            ${date !== today ? `<button class="button" type="button" data-action="today">Today</button>` : ''}
          </div>
        </div>
        <div class="day-toolbar">
          <div class="stat-list" aria-label="Daily overview">
            <div class="stat"><strong>${planned}</strong><span>Planned</span></div>
            <div class="stat done"><strong>${done}</strong><span>Done</span></div>
            <div class="stat skipped"><strong>${skipped}</strong><span>Skipped</span></div>
            <div class="stat"><strong>${48 - planned}</strong><span>Open spaces</span></div>
          </div>
          <button class="button start-time-button" type="button" data-action="apply-template-shortcut">${icon('template')} Use a template</button>
        </div>
        <section class="timeline-shell" aria-label="24-hour timeline">
          <div class="timeline-topline"><strong>24-hour timeline</strong><span>Swipe sideways to move through all 24 hours · tap a slot to edit it</span></div>
          <div class="timeline-scroller" tabindex="0" role="region" aria-label="Scrollable 24-hour timeline">
            ${renderTimeline(schedule.slots, schedule.startHour, 'date', date)}
          </div>
          <div class="timeline-legend"><span class="legend-item"><i class="legend-dot done"></i>Done</span><span class="legend-item"><i class="legend-dot skipped"></i>Skipped</span><span class="legend-item"><i class="legend-dot moved"></i>Moved</span><span class="legend-item">Status is always set manually.</span></div>
        </section>
        <p class="day-note">This plan belongs to ${escapeHtml(formatShortDate(date))}. Editing it won't change any other date or the template it came from.</p>
      </section>`;
  }

  function renderTimeline(slots, startHour, context, dateKey = '') {
    const groups = [];
    for (let hourIndex = 0; hourIndex < 24; hourIndex++) {
      const groupStart = (startHour * 60 + hourIndex * 60) % 1440;
      const indexA = hourIndex * 2;
      const indexB = indexA + 1;
      groups.push(`<div class="hour-group" aria-label="Hour starting ${escapeHtml(formatHour(groupStart))}">
        <div class="hour-label">${escapeHtml(formatHour(groupStart))}</div>
        <div class="slot-stack">${renderSlot(slots[indexA] || emptySlot(), indexA, startHour, context, dateKey)}${renderSlot(slots[indexB] || emptySlot(), indexB, startHour, context, dateKey)}</div>
      </div>`);
    }
    return `<div class="timeline-track">${groups.join('')}</div>`;
  }
  function renderSlot(slot, index, startHour, context, dateKey) {
    const resolved = resolvedSlot(slot);
    const label = resolved.label;
    const color = resolved.color;
    const filled = Boolean(label);
    const startMinutes = startHour * 60 + index * 30;
    const endMinutes = startMinutes + 30;
    const range = formatTimeRange(startMinutes, endMinutes);
    const status = STATUSES.includes(slot.status) ? slot.status : 'none';
    const statusText = status !== 'none' ? `<span class="slot-status status-${status}">${escapeHtml(STATUS_LABELS[status])}</span>` : '';
    const bg = color || EMPTY_COLOR;
    const fg = contrastText(bg);
    const style = filled || color ? `style="--slot-bg:${bg};--slot-fg:${fg}"` : '';
    const classNames = ['slot-card', (filled || color) ? 'is-filled' : '', status !== 'none' ? `has-status status-${status}` : ''].filter(Boolean).join(' ');
    const accessibleLabel = `${formatTime(startMinutes)} to ${formatTime(endMinutes)}, ${label ? label : 'empty'}, ${STATUS_LABELS[status] === 'None' ? 'no status' : STATUS_LABELS[status]}, edit slot`;
    return `<button type="button" class="${classNames}" ${style} data-action="edit-slot" data-slot-index="${index}" data-context="${context}" ${dateKey ? `data-date="${escapeHtml(dateKey)}"` : ''} aria-label="${escapeHtml(accessibleLabel)}" title="${escapeHtml(`${range}${label ? ` · ${label}` : ''}${status !== 'none' ? ` · ${STATUS_LABELS[status]}` : ''}`)}">
      <span class="slot-time">${escapeHtml(range)}</span>
      ${filled ? `<span class="slot-label">${escapeHtml(label)}</span>` : `<span class="slot-empty-label">Add activity</span>`}
      ${statusText}
    </button>`;
  }

  function renderActions() {
    const list = state.actions.slice().sort((a, b) => a.name.localeCompare(b.name));
    const cards = list.map(action => `
      <article class="entity-card">
        <div class="entity-top"><span class="entity-swatch" style="--swatch:${escapeHtml(action.color)}"></span><div class="entity-details"><h3>${escapeHtml(action.name)}</h3><p>Slot label: <strong>${escapeHtml(action.label)}</strong></p><div class="entity-meta">${action.starter ? '<span class="pill">STARTER EXAMPLE</span>' : '<span class="pill">REUSABLE ACTION</span>'}</div></div>
        </div>
        <div class="preview-row" style="--preview-bg:${escapeHtml(action.color)};--preview-fg:${contrastText(action.color)}"><span class="preview-swatch" style="--preview-bg:${escapeHtml(action.color)}"></span><div class="preview-copy"><strong>${escapeHtml(action.label)}</strong><small>Default slot appearance</small></div></div>
        <div class="entity-actions"><button class="button" type="button" data-action="edit-action" data-id="${escapeHtml(action.id)}">${icon('edit')} Edit</button><button class="button button-danger" type="button" data-action="delete-action" data-id="${escapeHtml(action.id)}">${icon('trash')} Delete</button></div>
      </article>`).join('');
    return `<section aria-labelledby="actions-title">
      <div class="screen-heading"><div><p class="eyebrow">Reusable activities</p><h1 id="actions-title">Actions</h1><p class="subheading">Save the activities you use often. Each slot can still have its own label and colour.</p></div><div class="heading-actions"><button class="button button-primary" type="button" data-action="new-action">${icon('plus')} New action</button></div></div>
      <section class="content-panel"><div class="panel-header"><div><h2>Your actions</h2><p>${list.length} ${list.length === 1 ? 'reusable activity' : 'reusable activities'} · edits won't erase slot-specific overrides.</p></div></div>
        ${cards ? `<div class="action-list">${cards}</div>` : `<div class="empty-state"><span class="empty-state-mark">${icon('plus')}</span><h3>Start with one activity</h3><p>Create an Action for something you plan regularly, or keep assigning one-off labels directly to slots.</p><button class="button button-primary" data-action="new-action" type="button">Create an action</button></div>`}
      </section>
    </section>`;
  }

  function renderTemplates() {
    const list = state.templates.slice().sort((a, b) => a.name.localeCompare(b.name));
    const cards = list.map(template => {
      const count = plannedCount(template.slots);
      return `<article class="entity-card"><div class="entity-top"><span class="entity-swatch" style="--swatch:var(--accent)"></span><div class="entity-details"><h3>${escapeHtml(template.name)}</h3><p>Starts at ${escapeHtml(startHourLabel(template.startHour))} · ${count} planned ${count === 1 ? 'slot' : 'slots'}</p><div class="entity-meta"><span class="pill">48 SLOTS</span>${template.starter ? '<span class="pill">STARTER EXAMPLE</span>' : '<span class="pill">EDITABLE</span>'}</div></div></div>
        <div class="entity-actions"><button class="button button-primary" type="button" data-action="open-template" data-id="${escapeHtml(template.id)}">Open & edit</button><button class="button" type="button" data-action="apply-template" data-id="${escapeHtml(template.id)}">Apply to date</button><button class="button" type="button" data-action="duplicate-template" data-id="${escapeHtml(template.id)}">${icon('copy')} Duplicate</button><button class="button button-danger" type="button" data-action="delete-template" data-id="${escapeHtml(template.id)}">${icon('trash')} Delete</button></div>
      </article>`;
    }).join('');
    return `<section aria-labelledby="templates-title"><div class="screen-heading"><div><p class="eyebrow">Plans you can reuse</p><h1 id="templates-title">Templates</h1><p class="subheading">A template is a starting point, not a live link. Once applied, a date can be edited independently.</p></div><div class="heading-actions"><button class="button" type="button" data-action="template-from-day">${icon('copy')} From selected day</button><button class="button button-primary" type="button" data-action="new-template">${icon('plus')} New template</button></div></div>
      <section class="content-panel"><div class="panel-header"><div><h2>Your templates</h2><p>Applying a template copies its 48 slots to the selected date.</p></div></div>${cards ? `<div class="template-list">${cards}</div>` : `<div class="empty-state"><span class="empty-state-mark">${icon('template')}</span><h3>No templates yet</h3><p>Create a blank template, or save the selected day's schedule as a starting point.</p><button class="button button-primary" type="button" data-action="new-template">Create a template</button></div>`}</section></section>`;
  }

  function renderTemplateEditor() {
    const template = state.templates.find(item => item.id === state.templateEditorId);
    if (!template) { state.templateEditorId = null; return renderTemplates(); }
    const count = plannedCount(template.slots);
    return `<section aria-labelledby="template-edit-title"><div class="template-editor-bar"><div class="template-editor-title"><button class="icon-plain" type="button" data-action="back-to-templates" aria-label="Back to templates">${icon('back')}</button><div><p class="eyebrow">Template editor</p><h1 id="template-edit-title">${escapeHtml(template.name)}</h1><p>${count} planned slots · ${escapeHtml(startHourLabel(template.startHour))} start · changes stay inside this template.</p></div></div><div class="template-editor-actions"><button class="button" type="button" data-action="rename-template" data-id="${escapeHtml(template.id)}">${icon('edit')} Rename</button><button class="button" type="button" data-action="start-time" data-context="template">${icon('clock')} Start time</button><button class="button button-primary" type="button" data-action="apply-template" data-id="${escapeHtml(template.id)}">Apply to date</button></div></div>
      <section class="timeline-shell" aria-label="Template timeline"><div class="timeline-topline"><strong>Template timeline</strong><span>Tap a slot to change the template · edits never change dates already using it</span></div><div class="timeline-scroller" tabindex="0" role="region" aria-label="Scrollable template timeline">${renderTimeline(template.slots, template.startHour, 'template')}</div><div class="timeline-legend"><span class="legend-item">Changes here affect future applications only.</span></div></section>
      <div class="heading-actions" style="justify-content:flex-start;margin-top:14px"><button class="button" type="button" data-action="duplicate-template" data-id="${escapeHtml(template.id)}">${icon('copy')} Make a copy</button><button class="button button-danger" type="button" data-action="delete-template" data-id="${escapeHtml(template.id)}">${icon('trash')} Delete template</button></div>
    </section>`;
  }

  function renderSettings() {
    const defaultHour = state.settings.defaultStartHour;
    const offlineText = state.offlineReady ? 'The app shell is cached on this device. After a successful online load, you can test launching it offline.' : 'The app has not verified a complete offline cache yet. Keep this page online until the first load and cache have completed.';
    return `<section aria-labelledby="settings-title"><div class="screen-heading"><div><p class="eyebrow">Your preferences and data</p><h1 id="settings-title">Settings</h1><p class="subheading">Your schedule stays on this device. Export a backup before changing devices or clearing browser data.</p></div></div>
      <div class="settings-layout">
        <section class="settings-section"><div class="settings-heading"><h2>Appearance & defaults</h2><p>Choose how HalfHour looks and where new timelines begin.</p></div><div class="settings-body">
          <div class="setting-row"><div class="setting-copy"><strong>Appearance</strong><small>Switch between light and dark themes.</small></div><div class="setting-control"><select class="inline-select" data-input="theme" aria-label="Appearance"><option value="light" ${state.settings.theme === 'light' ? 'selected' : ''}>Light</option><option value="dark" ${state.settings.theme === 'dark' ? 'selected' : ''}>Dark</option></select></div></div>
          <div class="setting-row"><div class="setting-copy"><strong>Default start time</strong><small>Used for dates that don't have a saved schedule yet. Existing dates keep their own start time.</small></div><div class="setting-control"><select class="inline-select" data-input="default-start" aria-label="Default start time">${hourOptions(defaultHour)}</select></div></div>
        </div></section>
        <section class="settings-section"><div class="settings-heading"><h2>Offline & privacy</h2><p>No account, advertising, analytics, or external database.</p></div><div class="settings-body">
          <div class="setting-row"><div class="setting-copy"><strong>Data location</strong><small>Your Actions, Templates, and date schedules live in this website's IndexedDB storage in this browser on this device.</small></div><div class="setting-control"><span class="pill">ON DEVICE</span></div></div>
          <div class="setting-row"><div class="setting-copy"><strong>Offline app shell</strong><small>${escapeHtml(offlineText)}</small></div><div class="setting-control"><span class="pill">${state.offlineReady ? 'CACHE CHECKED' : 'NOT VERIFIED'}</span></div></div>
          <div class="privacy-note">This is a web app, not a native iOS app. Website storage does not sync to other devices and can be lost if site data is cleared or storage is removed. Keep a JSON backup somewhere safe.</div>
        </div></section>
        <section class="settings-section"><div class="settings-heading"><h2>Backup & restore</h2><p>Export a full copy of your planning data or restore a previous backup.</p></div><div class="settings-body">
          <div class="setting-row"><div class="setting-copy"><strong>Export backup</strong><small>Creates a JSON file with Actions, Templates, schedules, colours, statuses, and settings.</small></div><div class="setting-control"><button class="button" type="button" data-action="export-backup">${icon('download')} Export JSON</button></div></div>
          <div class="setting-row"><div class="setting-copy"><strong>Import backup</strong><small>Validates the file before replacing current data. Invalid files leave your data untouched.</small></div><div class="setting-control"><button class="button" type="button" data-action="choose-import">${icon('upload')} Choose file</button><input id="import-backup-input" class="file-input" type="file" accept=".json,application/json" aria-label="Choose HalfHour backup"></div></div>
        </div></section>
        <section class="settings-section"><div class="settings-heading"><h2>Reset</h2><p>Start over on this device.</p></div><div class="settings-body"><div class="setting-row"><div class="setting-copy"><strong>Reset HalfHour data</strong><small>Deletes your schedules and changes, then restores the original editable starter examples. Export a backup first if you may need anything later.</small></div><div class="setting-control"><button class="button button-danger" type="button" data-action="reset-data">${icon('trash')} Reset data</button></div></div></div></section>
      </div></section>`;
  }

  function hourOptions(selected) {
    return Array.from({ length: 24 }, (_, hour) => `<option value="${hour}" ${Number(selected) === hour ? 'selected' : ''}>${escapeHtml(startHourLabel(hour))}</option>`).join('');
  }

  function showToast(message, type = 'success') {
    const root = $('#toast-root');
    root.innerHTML = `<div role="status" class="toast ${type === 'error' ? 'is-error' : ''}">${escapeHtml(message)}</div>`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { root.innerHTML = ''; }, 3600);
  }
  function showModal({ title, description = '', body = '', footer = '', wide = false, closeLabel = 'Close' }) {
    $('#modal-root').innerHTML = `<div class="modal-overlay" role="presentation"><section class="modal-card ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title" ${description ? 'aria-describedby="modal-description"' : ''}><header class="modal-header"><div><h2 id="modal-title">${escapeHtml(title)}</h2>${description ? `<p id="modal-description">${escapeHtml(description)}</p>` : ''}</div><button type="button" class="modal-close" data-action="close-modal" aria-label="${escapeHtml(closeLabel)}">${icon('close')}</button></header><div class="modal-body">${body}</div>${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}</section></div>`;
    const focusTarget = $('#modal-root input:not([type="hidden"]), #modal-root select, #modal-root button:not(.modal-close), #modal-root textarea');
    if (focusTarget) setTimeout(() => focusTarget.focus({ preventScroll: true }), 25);
  }
  function closeModal() { $('#modal-root').innerHTML = ''; }
  function standardFooter(saveLabel = 'Save', extraLeft = '') {
    return `${extraLeft}<div class="modal-footer-right"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit" form="modal-form">${escapeHtml(saveLabel)}</button></div>`;
  }

  function openSlotEditor(index, context = 'date') {
    const targetDate = state.settings.selectedDate;
    const schedule = context === 'template' ? state.templates.find(t => t.id === state.templateEditorId) : getSchedule(targetDate);
    if (!schedule || !Number.isInteger(index) || index < 0 || index > 47) return;
    const slot = clone(schedule.slots[index] || emptySlot());
    const existingAction = slot.actionId ? state.actions.find(item => item.id === slot.actionId) : null;
    const resolved = resolvedSlot(slot);
    const customColor = Boolean(slot.color);
    const start = schedule.startHour * 60 + index * 30;
    const body = `<form id="modal-form" class="form-stack" data-form="slot" data-index="${index}" data-context="${context}" data-date="${escapeHtml(targetDate)}" data-template-id="${context === 'template' ? escapeHtml(schedule.id) : ''}">
      <div class="form-field"><label for="slot-action">Saved Action <span style="font-weight:400">(optional)</span></label><select id="slot-action" name="actionId"><option value="">No saved Action — one-off activity</option>${state.actions.slice().sort((a,b) => a.name.localeCompare(b.name)).map(action => `<option value="${escapeHtml(action.id)}" ${action.id === existingAction?.id ? 'selected' : ''}>${escapeHtml(action.name)} · ${escapeHtml(action.label)}</option>`).join('')}</select><span class="field-hint">Using an Action keeps its default label and colour connected until you override them.</span></div>
      <div class="form-field"><label for="slot-label">Activity label</label><input id="slot-label" name="label" maxlength="100" value="${escapeHtml(resolved.label || '')}" placeholder="Leave blank for an empty slot" autocomplete="off"><span class="field-hint">A label can be saved without creating an Action.</span></div>
      <div class="form-field"><span class="field-label">Colour</span><label class="check-row"><input id="slot-custom-color" name="customColor" type="checkbox" ${customColor ? 'checked' : ''}> Use a custom colour for this slot</label><div class="color-row"><input id="slot-color" class="color-input" type="color" name="color" value="${escapeHtml(resolved.color || '#e9ede7')}" ${customColor ? '' : 'disabled'} aria-label="Slot background colour"><span class="color-value" id="slot-color-value">${escapeHtml(resolved.color || '#e9ede7')}</span><button class="button button-small" type="button" data-action="reset-slot-color">Use default colour</button></div><span class="field-hint">If unchecked, the slot uses its Action's default colour or the standard empty colour.</span></div>
      <div class="form-field"><label for="slot-status">Status</label><select id="slot-status" name="status">${STATUSES.map(status => `<option value="${status}" ${status === (STATUSES.includes(slot.status) ? slot.status : 'none') ? 'selected' : ''}>${STATUS_LABELS[status]}</option>`).join('')}</select><span class="field-hint">Statuses are always manual. Time passing never changes them.</span></div>
      <div class="preview-row" id="slot-preview" style="--preview-bg:${escapeHtml(resolved.color || EMPTY_COLOR)};--preview-fg:${contrastText(resolved.color || EMPTY_COLOR)}"><span class="preview-swatch" id="slot-preview-swatch" style="--preview-bg:${escapeHtml(resolved.color || EMPTY_COLOR)}"></span><div class="preview-copy" id="slot-preview-copy"><strong id="slot-preview-label">${escapeHtml(resolved.label || 'Empty slot')}</strong><small>${escapeHtml(formatTime(start))} – ${escapeHtml(formatTime(start + 30))} · live preview</small></div></div>
    </form>`;
    showModal({ title: `${formatTime(start)} – ${formatTime(start + 30)}`, description: context === 'template' ? 'Edit this template slot. Existing date schedules stay unchanged.' : `Editing ${formatLongDate(targetDate)}. Other dates remain untouched.`, wide: true, body, footer: `<button class="button button-danger" type="button" data-action="clear-slot" data-index="${index}" data-context="${context}" data-template-id="${context === 'template' ? escapeHtml(schedule.id) : ''}" data-date="${escapeHtml(targetDate)}">Clear slot</button><div class="modal-footer-right"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit" form="modal-form">Save slot</button></div>` });
  }

  function openActionEditor(action = null) {
    const isEdit = Boolean(action);
    const value = action || { name: '', label: '', color: '#8fb3e8' };
    const body = `<form id="modal-form" class="form-stack" data-form="action" data-id="${isEdit ? escapeHtml(action.id) : ''}">
      <div class="form-field"><label for="action-name">Action name</label><input id="action-name" name="name" maxlength="80" required value="${escapeHtml(value.name)}" placeholder="e.g. Study" autocomplete="off"></div>
      <div class="form-field"><label for="action-label">Default slot label</label><input id="action-label" name="label" maxlength="100" value="${escapeHtml(value.label)}" placeholder="e.g. Study" required autocomplete="off"><span class="field-hint">This is shown in slots that use the Action and have no label override.</span></div>
      <div class="form-field"><label for="action-color">Default colour</label><div class="color-row"><input id="action-color" class="color-input" name="color" type="color" value="${escapeHtml(value.color)}"><span class="color-value" id="action-color-value">${escapeHtml(value.color)}</span></div></div>
      <div class="preview-row" id="action-preview" style="--preview-bg:${escapeHtml(value.color)};--preview-fg:${contrastText(value.color)}"><span class="preview-swatch" id="action-preview-swatch" style="--preview-bg:${escapeHtml(value.color)}"></span><div class="preview-copy" id="action-preview-copy"><strong id="action-preview-label">${escapeHtml(value.label || 'Your activity')}</strong><small>Live slot preview</small></div></div>
    </form>`;
    showModal({ title: isEdit ? 'Edit Action' : 'New Action', description: isEdit ? 'Changes to defaults leave slot-specific overrides in place.' : 'Create a reusable activity. You can still edit every slot independently.', body, footer: standardFooter(isEdit ? 'Save changes' : 'Create Action') });
  }

  function openTemplateEditorForm({ template = null, fromDay = false } = {}) {
    const sourceSchedule = getSchedule();
    const isEdit = Boolean(template);
    const initialName = template?.name || (fromDay ? `Plan · ${formatShortDate(state.settings.selectedDate)}` : 'New template');
    const startingHour = template?.startHour ?? sourceSchedule.startHour;
    const body = `<form id="modal-form" class="form-stack" data-form="template-meta" data-id="${isEdit ? escapeHtml(template.id) : ''}" data-from-day="${fromDay ? 'yes' : 'no'}">
      <div class="form-field"><label for="template-name">Template name</label><input id="template-name" name="name" maxlength="80" required value="${escapeHtml(initialName)}" autocomplete="off" placeholder="e.g. School Day"></div>
      ${(!isEdit && !fromDay) ? `<div class="form-field"><label for="template-start">Timeline starts at</label><select id="template-start" name="startHour">${hourOptions(startingHour)}</select></div>` : ''}
      ${fromDay ? `<div class="privacy-note">This creates a copy of ${escapeHtml(formatLongDate(state.settings.selectedDate))}. Future edits to the date and template will be independent.</div>` : `<div class="privacy-note">${isEdit ? 'Rename this template here; use Start time to change its clock alignment.' : 'The new template has 48 empty slots. You can edit its schedule next.'}</div>`}
    </form>`;
    showModal({ title: isEdit ? 'Rename template' : (fromDay ? 'Save day as template' : 'New template'), description: fromDay ? 'Give this reusable copy a name.' : 'Templates are reusable copies, separate from individual dates.', body, footer: standardFooter(isEdit ? 'Save name' : (fromDay ? 'Create template' : 'Create template')) });
  }

  function openStartTimeModal(context = 'date') {
    let item;
    if (context === 'template') item = state.templates.find(template => template.id === state.templateEditorId);
    else item = getSchedule();
    if (!item) return;
    const currentHour = item.startHour;
    const body = `<form id="modal-form" class="form-stack" data-form="start-time" data-context="${context}" data-template-id="${context === 'template' ? escapeHtml(item.id) : ''}" data-date="${escapeHtml(state.settings.selectedDate)}">
      <div class="form-field"><label for="new-start-hour">New starting time</label><select id="new-start-hour" name="startHour">${hourOptions(currentHour)}</select></div>
      <div class="form-field"><span class="field-label">How should existing activities move?</span><div class="radio-options">
        <label class="radio-card"><input type="radio" name="mode" value="shift" checked><span><strong>Shift the whole schedule</strong><small>Keep slot order and move all activities by the same time difference. Changing 6:00 AM to 5:00 AM moves a 9:00 AM activity to 8:00 AM.</small></span></label>
        <label class="radio-card"><input type="radio" name="mode" value="clock"><span><strong>Preserve actual clock times</strong><small>Keep activities at their original clock times, moving each activity to the matching slot in the new timeline.</small></span></label>
      </div></div>
      <p class="warning-copy">This affects only ${context === 'template' ? `the template “${escapeHtml(item.name)}”` : formatLongDate(state.settings.selectedDate)}. Nothing changes until you save.</p>
    </form>`;
    showModal({ title: 'Change starting time', description: 'A day always has 48 consecutive half-hour slots, even when it crosses midnight.', body, footer: standardFooter('Apply starting time') });
  }

  function openApplyTemplateModal(template) {
    if (!template) return;
    const date = state.settings.selectedDate;
    const body = `<form id="modal-form" class="form-stack" data-form="apply-template" data-id="${escapeHtml(template.id)}" data-date="${escapeHtml(date)}">
      <p class="warning-copy">Apply <strong>${escapeHtml(template.name)}</strong> to <strong>${escapeHtml(formatLongDate(date))}</strong>?</p>
      <p class="warning-copy">This copies the template's starting time and all 48 slots into this date. It will replace the current plan for this date only. The template and every other date remain unchanged.</p>
      <label class="check-row"><input type="checkbox" name="confirmReplace" required> I understand this replaces the selected date's current plan.</label>
    </form>`;
    showModal({ title: 'Apply template', description: 'The selected date becomes an independent copy.', body, footer: standardFooter('Apply template') });
  }

  function openConfirm({ title, description = '', message, confirmLabel = 'Confirm', danger = false, onConfirm }) {
    const body = `<p class="warning-copy">${message}</p>`;
    showModal({ title, description, body, footer: `<div></div><div class="modal-footer-right"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button ${danger ? 'button-danger' : 'button-primary'}" type="button" data-action="confirm-callback">${escapeHtml(confirmLabel)}</button></div>` });
    $('#modal-root [data-action="confirm-callback"]').addEventListener('click', async () => {
      closeModal();
      try { await onConfirm(); } catch (error) { console.error(error); showToast(error.message || 'That change could not be saved.', 'error'); }
    }, { once: true });
  }

  function rotateSlots(slots, oldStart, newStart, mode) {
    if (mode === 'shift') return clone(slots);
    const next = emptySlots();
    for (let oldIndex = 0; oldIndex < 48; oldIndex++) {
      const absoluteMinutes = oldStart * 60 + oldIndex * 30;
      const newIndex = (((absoluteMinutes - newStart * 60) % 1440) + 1440) % 1440 / 30;
      next[newIndex] = clone(slots[oldIndex] || emptySlot());
    }
    return next;
  }

  function repairLoadedCollections(stored, settings) {
    // IndexedDB can outlive app updates and user actions can leave stale records.
    // Normalize in memory so the UI stays usable without rewriting good records
    // or destructively "resetting" data while opening the app.
    const actions = [];
    const actionIds = new Set();
    for (const raw of (Array.isArray(stored.actions) ? stored.actions : [])) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      let id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : makeId('recovered-action');
      if (actionIds.has(id)) id = makeId('recovered-action');
      actionIds.add(id);
      const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'Recovered Action';
      const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 100) : name;
      actions.push({ id, name, label, color: normalizeHex(raw.color) || '#bdc5cf', ...(raw.starter ? { starter: true } : {}) });
    }
    const normalizeSlots = (slots) => Array.from({ length: 48 }, (_, index) => {
      const source = Array.isArray(slots) ? slots[index] : null;
      const slot = normalizeSlot(source);
      if (slot.actionId && !actionIds.has(slot.actionId)) {
        slot.actionId = null;
        if (!slot.label) slot.label = 'Action unavailable';
      }
      return slot;
    });
    const templates = [];
    const templateIds = new Set();
    for (const raw of (Array.isArray(stored.templates) ? stored.templates : [])) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      let id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : makeId('recovered-template');
      if (templateIds.has(id)) id = makeId('recovered-template');
      templateIds.add(id);
      const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'Recovered template';
      const startHour = Number.isInteger(raw.startHour) && raw.startHour >= 0 && raw.startHour <= 23 ? raw.startHour : settings.defaultStartHour;
      templates.push({ id, name, startHour, slots: normalizeSlots(raw.slots), ...(raw.starter ? { starter: true } : {}), ...(raw.createdAt ? { createdAt: String(raw.createdAt) } : {}) });
    }
    const templateIdsValid = new Set(templates.map(template => template.id));
    const schedules = {};
    for (const [key, raw] of Object.entries(stored.schedules || {})) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const date = parseDateKey(raw.date) ? raw.date : (parseDateKey(key) ? key : null);
      if (!date || schedules[date]) continue;
      const startHour = Number.isInteger(raw.startHour) && raw.startHour >= 0 && raw.startHour <= 23 ? raw.startHour : settings.defaultStartHour;
      schedules[date] = {
        date, startHour,
        templateId: typeof raw.templateId === 'string' && templateIdsValid.has(raw.templateId) ? raw.templateId : null,
        slots: normalizeSlots(raw.slots)
      };
    }
    return { actions, templates, schedules };
  }

  async function saveSettings(nextSettings) {
    const item = { ...nextSettings };
    await putRecord('meta', { id: 'settings', value: item });
    state.settings = item;
  }
  async function saveSchedule(schedule) {
    const safe = normalizeSchedule(schedule);
    await putRecord('schedules', safe);
    state.schedules[safe.date] = safe;
  }
  function normalizeSchedule(schedule) {
    return { date: schedule.date, startHour: schedule.startHour, templateId: schedule.templateId || null, slots: Array.from({ length: 48 }, (_, i) => normalizeSlot(schedule.slots?.[i])) };
  }
  function normalizeSlot(slot) {
    const source = slot || {};
    return {
      actionId: typeof source.actionId === 'string' && source.actionId ? source.actionId : null,
      label: typeof source.label === 'string' && source.label.trim() ? source.label.trim().slice(0, 100) : null,
      color: normalizeHex(source.color),
      status: STATUSES.includes(source.status) ? source.status : 'none'
    };
  }
  async function saveTemplate(template) {
    const safe = { ...template, startHour: Number(template.startHour), slots: Array.from({ length: 48 }, (_, i) => normalizeSlot(template.slots?.[i])) };
    await putRecord('templates', safe);
    const index = state.templates.findIndex(item => item.id === safe.id);
    if (index >= 0) state.templates[index] = safe; else state.templates.push(safe);
  }
  async function saveAction(action) {
    await putRecord('actions', action);
    const index = state.actions.findIndex(item => item.id === action.id);
    if (index >= 0) state.actions[index] = action; else state.actions.push(action);
  }

  async function deleteActionAndDetach(actionId) {
    const action = state.actions.find(item => item.id === actionId);
    if (!action) return;
    const nextTemplates = state.templates.map(template => {
      const slots = template.slots.map(slot => {
        if (slot.actionId !== actionId) return slot;
        const rendered = resolvedSlot(slot, state.actions);
        return { ...slot, actionId: null, label: rendered.label, color: rendered.color };
      });
      return { ...template, slots };
    });
    const nextSchedules = Object.fromEntries(Object.entries(state.schedules).map(([date, schedule]) => [date, {
      ...schedule,
      slots: schedule.slots.map(slot => {
        if (slot.actionId !== actionId) return slot;
        const rendered = resolvedSlot(slot, state.actions);
        return { ...slot, actionId: null, label: rendered.label, color: rendered.color };
      })
    }]));
    const tx = db.transaction(['actions', 'templates', 'schedules'], 'readwrite');
    tx.objectStore('actions').delete(actionId);
    for (const template of nextTemplates) tx.objectStore('templates').put(template);
    for (const schedule of Object.values(nextSchedules)) tx.objectStore('schedules').put(schedule);
    await txDone(tx);
    state.actions = state.actions.filter(item => item.id !== actionId);
    state.templates = nextTemplates;
    state.schedules = nextSchedules;
  }

  async function deleteTemplate(templateId) {
    const nextSchedules = Object.fromEntries(Object.entries(state.schedules).map(([date, schedule]) => [date, schedule.templateId === templateId ? { ...schedule, templateId: null } : schedule]));
    const tx = db.transaction(['templates', 'schedules'], 'readwrite');
    tx.objectStore('templates').delete(templateId);
    for (const schedule of Object.values(nextSchedules)) if (schedule.templateId !== (state.schedules[schedule.date]?.templateId)) tx.objectStore('schedules').put(schedule);
    await txDone(tx);
    state.templates = state.templates.filter(item => item.id !== templateId);
    state.schedules = nextSchedules;
    if (state.templateEditorId === templateId) state.templateEditorId = null;
    render();
  }

  async function saveSlotFromForm(form) {
    const data = new FormData(form);
    const index = Number(form.dataset.index);
    const context = form.dataset.context;
    const actionId = String(data.get('actionId') || '') || null;
    const action = actionId ? state.actions.find(item => item.id === actionId) : null;
    if (actionId && !action) throw new Error('That saved Action no longer exists. Choose another Action and try again.');
    const labelText = String(data.get('label') || '').trim().slice(0, 100);
    const customColor = data.get('customColor') === 'on';
    const colorText = String(data.get('color') || '').toLowerCase();
    if (customColor && !isHexColor(colorText)) throw new Error('Choose a valid slot colour.');
    const nextSlot = {
      actionId,
      label: action ? (labelText && labelText !== action.label ? labelText : null) : (labelText || null),
      color: customColor ? colorText : null,
      status: STATUSES.includes(String(data.get('status'))) ? String(data.get('status')) : 'none'
    };
    if (context === 'template') {
      const template = state.templates.find(item => item.id === form.dataset.templateId);
      if (!template) throw new Error('This template could not be found.');
      const updated = { ...template, slots: template.slots.map((slot, i) => i === index ? nextSlot : slot) };
      await saveTemplate(updated);
    } else {
      const date = form.dataset.date || state.settings.selectedDate;
      const schedule = clone(state.schedules[date] || makeEmptySchedule(date));
      schedule.slots[index] = nextSlot;
      await saveSchedule(schedule);
    }
    closeModal(); render(); showToast('Slot saved.');
  }

  async function clearSlot(index, context, templateId, date) {
    if (context === 'template') {
      const template = state.templates.find(item => item.id === templateId);
      if (!template) throw new Error('This template could not be found.');
      const updated = { ...template, slots: template.slots.map((slot, i) => i === index ? emptySlot() : slot) };
      await saveTemplate(updated);
    } else {
      const schedule = clone(state.schedules[date] || makeEmptySchedule(date));
      schedule.slots[index] = emptySlot();
      await saveSchedule(schedule);
    }
    closeModal(); render(); showToast('Slot cleared.');
  }

  async function submitForm(form) {
    const formType = form.dataset.form;
    const submitButton = $(`button[type="submit"][form="${form.id}"]`, document) || $('button[type="submit"]', form);
    if (submitButton) submitButton.disabled = true;
    try {
      const data = new FormData(form);
      if (formType === 'slot') {
        await saveSlotFromForm(form);
      } else if (formType === 'action') {
        const name = String(data.get('name') || '').trim();
        const label = String(data.get('label') || '').trim();
        const color = normalizeHex(data.get('color'));
        if (!name || !label) throw new Error('Enter both an Action name and a slot label.');
        if (!color) throw new Error('Choose a valid colour.');
        const id = form.dataset.id || makeId('action');
        const original = state.actions.find(item => item.id === id);
        await saveAction({ id, name: name.slice(0, 80), label: label.slice(0, 100), color, ...(original?.starter ? { starter: true } : {}) });
        closeModal(); render(); showToast(original ? 'Action updated.' : 'Action created.');
      } else if (formType === 'template-meta') {
        const name = String(data.get('name') || '').trim();
        const startHour = Number(data.get('startHour'));
        if (!name) throw new Error('Enter a name for this template.');
        if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) throw new Error('Choose a valid starting hour.');
        const isEdit = Boolean(form.dataset.id);
        if (isEdit) {
          const original = state.templates.find(item => item.id === form.dataset.id);
          if (!original) throw new Error('This template could not be found.');
          await saveTemplate({ ...original, name: name.slice(0, 80) });
          closeModal(); render(); showToast('Template renamed.');
        } else {
          const fromDay = form.dataset.fromDay === 'yes';
          const source = fromDay ? getSchedule() : null;
          const template = { id: makeId('template'), name: name.slice(0, 80), startHour: fromDay ? source.startHour : startHour, slots: fromDay ? clone(source.slots) : emptySlots(), createdAt: new Date().toISOString() };
          await saveTemplate(template);
          closeModal(); state.activeView = 'templates'; state.templateEditorId = template.id; render(); showToast(fromDay ? 'Template created from this day.' : 'Template created.');
        }
      } else if (formType === 'start-time') {
        const startHour = Number(data.get('startHour'));
        const mode = String(data.get('mode') || 'shift');
        if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23 || !['shift', 'clock'].includes(mode)) throw new Error('Choose a valid starting time and change mode.');
        if (form.dataset.context === 'template') {
          const original = state.templates.find(item => item.id === form.dataset.templateId);
          if (!original) throw new Error('This template could not be found.');
          const updated = { ...original, startHour, slots: rotateSlots(original.slots, original.startHour, startHour, mode) };
          await saveTemplate(updated);
        } else {
          const date = form.dataset.date || state.settings.selectedDate;
          const original = clone(state.schedules[date] || makeEmptySchedule(date));
          const updated = { ...original, startHour, slots: rotateSlots(original.slots, original.startHour, startHour, mode) };
          await saveSchedule(updated);
        }
        closeModal(); render(); showToast(mode === 'shift' ? 'Starting time changed; slot order kept.' : 'Starting time changed; clock times preserved.');
      } else if (formType === 'apply-template') {
        if (data.get('confirmReplace') !== 'on') throw new Error('Please confirm that the selected date’s current plan will be replaced.');
        const template = state.templates.find(item => item.id === form.dataset.id);
        if (!template) throw new Error('This template could not be found.');
        const date = form.dataset.date || state.settings.selectedDate;
        const schedule = { date, startHour: template.startHour, templateId: template.id, slots: clone(template.slots) };
        await saveSchedule(schedule);
        closeModal(); state.activeView = 'day'; state.templateEditorId = null; render(); showToast(`Template applied to ${formatShortDate(date)}.`);
      }
    } catch (error) {
      console.error(error);
      showToast(error.message || 'That change could not be saved. Your existing data was kept.', 'error');
      if (submitButton) submitButton.disabled = false;
    }
  }

  async function changeDate(date) {
    if (!parseDateKey(date)) return;
    try {
      const next = { ...state.settings, selectedDate: date };
      await saveSettings(next);
      state.activeView = 'day'; state.templateEditorId = null;
      closeModal(); render();
    } catch (error) { showToast('Could not save the selected date.', 'error'); }
  }

  async function doExportBackup() {
    try {
      const data = {
        app: 'HalfHour', schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(),
        settings: clone(state.settings), actions: clone(state.actions), templates: clone(state.templates), schedules: clone(Object.values(state.schedules))
      };
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `halfhour-backup-${localDateKey(new Date())}.json`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      showToast('Backup exported. Keep the file somewhere safe.');
    } catch (error) {
      console.error(error); showToast('The backup could not be exported in this browser.', 'error');
    }
  }

  function validateBackup(input) {
    const fail = message => { throw new Error(message); };
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('The selected file is not a HalfHour backup object.');
    if (input.app !== 'HalfHour') fail('This file was not exported by HalfHour.');
    if (input.schemaVersion !== SCHEMA_VERSION) fail(`Backup version ${String(input.schemaVersion)} is not supported by this app version.`);
    if (!input.settings || typeof input.settings !== 'object') fail('The backup is missing settings.');
    if (!Array.isArray(input.actions) || !Array.isArray(input.templates) || !Array.isArray(input.schedules)) fail('The backup is missing its Actions, Templates, or schedules list.');
    const settings = input.settings;
    if (!['light', 'dark'].includes(settings.theme)) fail('The backup theme is invalid.');
    if (!Number.isInteger(settings.defaultStartHour) || settings.defaultStartHour < 0 || settings.defaultStartHour > 23) fail('The backup default start time is invalid.');
    if (!parseDateKey(settings.selectedDate)) fail('The backup selected date is invalid.');
    const actionIds = new Set();
    const actions = input.actions.map((action) => {
      if (!action || typeof action.id !== 'string' || !action.id.trim() || actionIds.has(action.id)) fail('The backup has a missing or duplicate Action ID.');
      if (typeof action.name !== 'string' || !action.name.trim() || action.name.length > 80) fail('An Action has an invalid name.');
      if (typeof action.label !== 'string' || !action.label.trim() || action.label.length > 100) fail('An Action has an invalid slot label.');
      if (!isHexColor(action.color)) fail('An Action has an invalid colour.');
      actionIds.add(action.id);
      return { id: action.id, name: action.name, label: action.label, color: action.color.toLowerCase(), ...(action.starter ? { starter: true } : {}) };
    });
    const validateSlots = (slots, owner) => {
      if (!Array.isArray(slots) || slots.length !== 48) fail(`${owner} must contain exactly 48 slots.`);
      return slots.map((slot, index) => {
        if (!slot || typeof slot !== 'object' || Array.isArray(slot)) fail(`${owner}, slot ${index + 1} is malformed.`);
        if (slot.actionId !== null && slot.actionId !== undefined && (typeof slot.actionId !== 'string' || !actionIds.has(slot.actionId))) fail(`${owner}, slot ${index + 1} refers to a missing Action.`);
        if (slot.label !== null && slot.label !== undefined && (typeof slot.label !== 'string' || slot.label.length > 100)) fail(`${owner}, slot ${index + 1} has an invalid label.`);
        if (slot.color !== null && slot.color !== undefined && !isHexColor(slot.color)) fail(`${owner}, slot ${index + 1} has an invalid colour.`);
        if (slot.status !== undefined && !STATUSES.includes(slot.status)) fail(`${owner}, slot ${index + 1} has an invalid status.`);
        return normalizeSlot(slot);
      });
    };
    const templateIds = new Set();
    const templates = input.templates.map(template => {
      if (!template || typeof template.id !== 'string' || !template.id.trim() || templateIds.has(template.id)) fail('The backup has a missing or duplicate template ID.');
      if (typeof template.name !== 'string' || !template.name.trim() || template.name.length > 80) fail('A template has an invalid name.');
      if (!Number.isInteger(template.startHour) || template.startHour < 0 || template.startHour > 23) fail(`Template “${template.name}” has an invalid starting time.`);
      templateIds.add(template.id);
      return { id: template.id, name: template.name, startHour: template.startHour, slots: validateSlots(template.slots, `Template “${template.name}”`), ...(template.starter ? { starter: true } : {}), ...(template.createdAt ? { createdAt: String(template.createdAt) } : {}) };
    });
    const dates = new Set();
    const schedules = input.schedules.map(schedule => {
      if (!schedule || typeof schedule.date !== 'string' || !parseDateKey(schedule.date) || dates.has(schedule.date)) fail('The backup has an invalid or duplicate schedule date.');
      if (!Number.isInteger(schedule.startHour) || schedule.startHour < 0 || schedule.startHour > 23) fail(`The schedule for ${schedule.date} has an invalid starting time.`);
      if (schedule.templateId !== null && schedule.templateId !== undefined && (typeof schedule.templateId !== 'string' || !templateIds.has(schedule.templateId))) fail(`The schedule for ${schedule.date} refers to a missing template.`);
      dates.add(schedule.date);
      return { date: schedule.date, startHour: schedule.startHour, templateId: schedule.templateId || null, slots: validateSlots(schedule.slots, `Schedule ${schedule.date}`) };
    });
    return { settings: { theme: settings.theme, defaultStartHour: settings.defaultStartHour, selectedDate: settings.selectedDate }, actions, templates, schedules };
  }

  async function importBackupFile(file) {
    if (!file || importBusy) return;
    importBusy = true;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('This backup is larger than 10 MB, so HalfHour did not import it.');
      const text = await file.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch (_error) { throw new Error('This file is not valid JSON. Your existing data was not changed.'); }
      const validated = validateBackup(parsed);
      openConfirm({
        title: 'Replace current data?',
        description: 'The backup has passed its format checks.',
        message: `This backup contains ${validated.actions.length} Actions, ${validated.templates.length} Templates, and ${validated.schedules.length} saved date schedules. Importing will replace all current HalfHour data on this device. Export your current data first if you may need it.`,
        confirmLabel: 'Import & replace', danger: true,
        onConfirm: async () => {
          await replaceAllData(validated);
          state.settings = clone(validated.settings);
          state.actions = clone(validated.actions);
          state.templates = clone(validated.templates);
          state.schedules = Object.fromEntries(validated.schedules.map(schedule => [schedule.date, clone(schedule)]));
          state.activeView = 'day'; state.templateEditorId = null;
          render(); showToast('Backup imported successfully.');
        }
      });
    } catch (error) {
      console.error(error); showToast(error.message || 'This backup could not be imported.', 'error');
    } finally {
      importBusy = false;
      const input = $('#import-backup-input'); if (input) input.value = '';
    }
  }

  async function resetAllData() {
    const initial = initialData();
    await replaceAllData(initial);
    state.settings = initial.settings;
    state.actions = initial.actions;
    state.templates = initial.templates;
    state.schedules = {};
    state.activeView = 'day'; state.templateEditorId = null;
    render(); showToast('HalfHour has been reset to its starter examples.');
  }

  async function handleClick(event) {
    const button = event.target.closest('button[data-action], button[data-nav], a[data-nav]');
    if (!button) {
      if (event.target.classList.contains('modal-overlay')) closeModal();
      return;
    }
    if (button.matches('a[data-nav]')) event.preventDefault();
    if (button.dataset.nav) {
      const view = button.dataset.nav;
      state.activeView = view;
      if (view !== 'templates') state.templateEditorId = null;
      closeModal(); render();
      return;
    }
    const action = button.dataset.action;
    try {
      switch (action) {
        case 'retry-boot': await boot(); break;
        case 'close-modal': closeModal(); break;
        case 'previous-day': await changeDate(shiftDateKey(state.settings.selectedDate, -1)); break;
        case 'next-day': await changeDate(shiftDateKey(state.settings.selectedDate, 1)); break;
        case 'today': await changeDate(localDateKey(new Date())); break;
        case 'edit-slot': openSlotEditor(Number(button.dataset.slotIndex), button.dataset.context || 'date'); break;
        case 'start-time': openStartTimeModal(button.dataset.context || 'date'); break;
        case 'reset-slot-color': {
          const check = $('#slot-custom-color'); const color = $('#slot-color');
          if (check) check.checked = false;
          if (color) color.disabled = true;
          const selected = $('#slot-action')?.value;
          const actionItem = state.actions.find(item => item.id === selected);
          const defaultColor = actionItem?.color || EMPTY_COLOR;
          if (color) color.value = defaultColor;
          const label = $('#slot-color-value'); if (label) label.textContent = defaultColor;
          updateSlotPreview(); break;
        }
        case 'clear-slot': await clearSlot(Number(button.dataset.index), button.dataset.context || 'date', button.dataset.templateId, button.dataset.date || state.settings.selectedDate); break;
        case 'new-action': openActionEditor(); break;
        case 'edit-action': openActionEditor(state.actions.find(item => item.id === button.dataset.id)); break;
        case 'delete-action': {
          const item = state.actions.find(actionItem => actionItem.id === button.dataset.id); if (!item) break;
          openConfirm({ title: 'Delete Action?', description: 'Existing activities will be kept.', message: `Delete “${escapeHtml(item.name)}”? Any slots or templates using it will be detached while preserving their currently displayed label, colour, and status.`, confirmLabel: 'Delete Action', danger: true, onConfirm: async () => { await deleteActionAndDetach(item.id); render(); showToast('Action deleted. Existing slots were preserved.'); } }); break;
        }
        case 'new-template': openTemplateEditorForm(); break;
        case 'template-from-day': openTemplateEditorForm({ fromDay: true }); break;
        case 'open-template': state.activeView = 'templates'; state.templateEditorId = button.dataset.id; render(); break;
        case 'back-to-templates': state.templateEditorId = null; render(); break;
        case 'rename-template': openTemplateEditorForm({ template: state.templates.find(item => item.id === button.dataset.id) }); break;
        case 'duplicate-template': {
          const original = state.templates.find(item => item.id === button.dataset.id); if (!original) break;
          const copyTemplate = { ...clone(original), id: makeId('template'), name: `${original.name} copy`.slice(0, 80), starter: false, createdAt: new Date().toISOString() };
          await saveTemplate(copyTemplate); state.activeView = 'templates'; state.templateEditorId = copyTemplate.id; render(); showToast('Template duplicated.'); break;
        }
        case 'apply-template': openApplyTemplateModal(state.templates.find(item => item.id === button.dataset.id)); break;
        case 'delete-template': {
          const item = state.templates.find(template => template.id === button.dataset.id); if (!item) break;
          openConfirm({ title: 'Delete template?', description: 'Existing schedules are independent copies.', message: `Delete “${escapeHtml(item.name)}”? Any past or future date schedules that used it will be preserved. Their template association will be removed; their 48 slots will not be deleted.`, confirmLabel: 'Delete template', danger: true, onConfirm: async () => { await deleteTemplate(item.id); showToast('Template deleted. Date schedules were preserved.'); } }); break;
        }
        case 'apply-template-shortcut': state.activeView = 'templates'; state.templateEditorId = null; render(); break;
        case 'export-backup': await doExportBackup(); break;
        case 'choose-import': $('#import-backup-input')?.click(); break;
        case 'reset-data': openConfirm({ title: 'Reset HalfHour?', description: 'This cannot be undone.', message: 'All saved date schedules, custom Actions, custom Templates, and preferences will be replaced by the original starter examples. Export a backup first if there is anything you may need later.', confirmLabel: 'Reset all data', danger: true, onConfirm: resetAllData }); break;
      }
    } catch (error) {
      console.error(error); showToast(error.message || 'That action could not be completed.', 'error');
    }
  }

  function updateActionPreview() {
    const label = $('#action-label')?.value.trim() || 'Your activity';
    const color = $('#action-color')?.value || '#8fb3e8';
    const preview = $('#action-preview'); const swatch = $('#action-preview-swatch'); const copy = $('#action-preview-copy');
    if (preview) { preview.style.setProperty('--preview-bg', color); preview.style.setProperty('--preview-fg', contrastText(color)); }
    if (swatch) swatch.style.setProperty('--preview-bg', color);
    if (copy) copy.style.color = contrastText(color);
    const labelNode = $('#action-preview-label'); if (labelNode) labelNode.textContent = label;
    const colorNode = $('#action-color-value'); if (colorNode) colorNode.textContent = color;
  }
  function updateSlotPreview() {
    const label = $('#slot-label')?.value.trim() || 'Empty slot';
    const actionId = $('#slot-action')?.value;
    const action = state.actions.find(item => item.id === actionId);
    const colorInput = $('#slot-color');
    const custom = $('#slot-custom-color')?.checked;
    const color = custom ? (colorInput?.value || EMPTY_COLOR) : (action?.color || EMPTY_COLOR);
    const preview = $('#slot-preview'); const swatch = $('#slot-preview-swatch'); const copy = $('#slot-preview-copy');
    if (preview) { preview.style.setProperty('--preview-bg', color); preview.style.setProperty('--preview-fg', contrastText(color)); }
    if (swatch) swatch.style.setProperty('--preview-bg', color);
    if (copy) copy.style.color = contrastText(color);
    const labelNode = $('#slot-preview-label'); if (labelNode) labelNode.textContent = label;
    const colorNode = $('#slot-color-value'); if (colorNode) colorNode.textContent = colorInput?.value || EMPTY_COLOR;
  }

  async function handleChange(event) {
    const target = event.target;
    if (target.matches('[data-input="selected-date"]')) {
      if (target.value) await changeDate(target.value);
    } else if (target.matches('[data-input="theme"]')) {
      try { await saveSettings({ ...state.settings, theme: target.value === 'dark' ? 'dark' : 'light' }); render(); showToast('Appearance saved.'); }
      catch (error) { showToast('Could not save the appearance setting.', 'error'); }
    } else if (target.matches('[data-input="default-start"]')) {
      const hour = Number(target.value);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) return;
      try { await saveSettings({ ...state.settings, defaultStartHour: hour }); render(); showToast('Default start time saved. Existing dates were not changed.'); }
      catch (error) { showToast('Could not save the default start time.', 'error'); }
    } else if (target.matches('#import-backup-input')) {
      await importBackupFile(target.files?.[0]);
    } else if (target.matches('#slot-action')) {
      const action = state.actions.find(item => item.id === target.value);
      const label = $('#slot-label'); const color = $('#slot-color'); const colorCheck = $('#slot-custom-color');
      if (label) label.value = action?.label || '';
      if (color) { color.value = action?.color || EMPTY_COLOR; color.disabled = !colorCheck?.checked; }
      if (colorCheck) colorCheck.checked = false;
      updateSlotPreview();
    } else if (target.matches('#slot-custom-color')) {
      const color = $('#slot-color'); if (color) color.disabled = !target.checked;
      updateSlotPreview();
    } else if (target.matches('#slot-color')) {
      updateSlotPreview();
    } else if (target.matches('#action-color') || target.matches('#action-label')) {
      updateActionPreview();
    }
  }

  function handleInput(event) {
    const target = event.target;
    if (target.matches('#action-name')) updateActionPreview();
    else if (target.matches('#action-label, #action-color')) updateActionPreview();
    else if (target.matches('#slot-label, #slot-color')) updateSlotPreview();
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1')) return;
    navigator.serviceWorker.register('./sw.js').then(async () => {
      await navigator.serviceWorker.ready;
      try {
        if (!('caches' in window)) return;
        const cache = await caches.open(CACHE_NAME);
        const required = ['./index.html', './styles.css', './app.js', './manifest.webmanifest'];
        const results = await Promise.all(required.map(asset => cache.match(new URL(asset, document.baseURI).href)));
        state.offlineReady = results.every(Boolean);
        if (state.activeView === 'settings') render();
      } catch (error) { console.warn('HalfHour could not verify its offline cache.', error); }
    }).catch(error => {
      console.warn('HalfHour service worker registration failed; online use can continue.', error);
      if (state.activeView === 'settings') { state.offlineReady = false; render(); }
    });
  }

  document.addEventListener('click', event => { void handleClick(event); });
  document.addEventListener('submit', event => {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    void submitForm(form);
  });
  document.addEventListener('change', event => { void handleChange(event); });
  document.addEventListener('input', handleInput);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('#modal-root .modal-overlay')) closeModal();
    if (event.key === 'Tab' && $('#modal-root .modal-card')) {
      const modal = $('#modal-root .modal-card');
      const focusable = $$('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]', modal).filter(el => el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });

  boot();
})();

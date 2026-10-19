// app.js - everything the browser does for the fitness tracker.
// Rough order: helpers -> auth -> dashboard -> charts -> wiring up the buttons.

const $ = (selector) => document.querySelector(selector);

const state = {
  user: null,
  metrics: {},   // loaded from /api/config
  days: 7,       // how many days the charts show
  charts: {},    // Chart.js instances, keyed by metric
};

// ---------- helpers ----------

// Talks to our server. Throws an Error with a friendly message if something goes wrong.
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong. Please try again.');
    err.status = res.status;
    throw err;
  }
  return data;
}

// Today's date as YYYY-MM-DD in the user's own timezone (toISOString would give UTC).
function todayISO() {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });

// Anything a user typed must be escaped before it goes into innerHTML.
function esc(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function toast(message, type = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + (type === 'error' ? 'error' : '');
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3200);
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- auth ----------

let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  $('#name-field').hidden = mode !== 'signup';
  $('#auth-submit').textContent = mode === 'signup' ? 'Create account' : 'Log in';
  $('#auth-form').password.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  showError($('#auth-error'), '');
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const button = $('#auth-submit');
  button.disabled = true;
  showError($('#auth-error'), '');

  try {
    const body = { email: form.email.value, password: form.password.value };
    // form.name would give the <form>'s own name attribute, so we go through form.elements
    if (authMode === 'signup') body.name = form.elements.name.value;
    const { user } = await api(`/auth/${authMode}`, { method: 'POST', body });
    form.reset();
    await enterApp(user);
  } catch (err) {
    showError($('#auth-error'), err.message);
  } finally {
    button.disabled = false;
  }
}

async function handleLogout() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  Object.values(state.charts).forEach((c) => c.destroy());
  state.charts = {};
  state.user = null;
  $('#app-view').hidden = true;
  $('#auth-view').hidden = false;
  setAuthMode('login');
}

// ---------- dashboard ----------

async function enterApp(user) {
  state.user = user;
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  $('#greeting').textContent = `Hey, ${user.name}`;
  $('#today-label').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $('#log-form').date.value = todayISO();
  $('#log-form').date.max = todayISO();
  await refresh();
}

// Re-fetches everything the dashboard shows. Called after every add / delete.
async function refresh() {
  try {
    const [summary, { logs }] = await Promise.all([
      api(`/summary?days=${state.days}&to=${todayISO()}`),
      api('/logs?limit=15'),
    ]);
    renderToday(summary);
    renderStats(summary);
    renderCharts(summary);
    renderLogs(logs);
  } catch (err) {
    if (err.status === 401) return handleLogout();
    toast(err.message, 'error');
  }
}

function renderToday(summary) {
  $('#today-cards').innerHTML = Object.entries(state.metrics).map(([type, m]) => {
    const value = summary.today[type];
    const pct = Math.min(100, Math.round((value / m.goal) * 100));
    const chips = m.quick.map((q) =>
      `<button class="chip" data-type="${type}" data-value="${q}">+${fmt(q)}</button>`).join('');
    return `
      <article class="card" style="--c: var(--${type})">
        <div class="card-top">
          <div class="ring" style="--pct: ${pct}"><span>${pct}%</span></div>
          <div>
            <div class="card-title">${m.icon} ${m.label}</div>
            <div class="card-value">${fmt(value)} <small>/ ${fmt(m.goal)} ${m.unit}</small></div>
          </div>
        </div>
        <div class="quick">${chips}</div>
      </article>`;
  }).join('');

  // Nudge the rings from 0 so the fill animation plays on first render.
  document.querySelectorAll('.ring').forEach((ring) => {
    const target = ring.style.getPropertyValue('--pct');
    ring.style.setProperty('--pct', 0);
    requestAnimationFrame(() => requestAnimationFrame(() => ring.style.setProperty('--pct', target)));
  });
}

function renderStats(summary) {
  const { metrics, streak, days } = summary;
  const activeDays = days.filter((d) => Object.keys(state.metrics).some((t) => d[t] > 0)).length;
  const goalsHit = Object.values(metrics).reduce((sum, m) => sum + m.daysHitGoal, 0);

  const tiles = [
    [`${streak} ${streak === 1 ? 'day' : 'days'}`, 'Current streak 🔥'],
    [`${activeDays} / ${summary.span}`, 'Active days'],
    [fmt(metrics.steps.average), 'Avg steps (logged days)'],
    [`${fmt(metrics.sleep.average)} h`, 'Avg sleep (logged nights)'],
    [goalsHit, 'Daily goals reached'],
  ];
  $('#stats').innerHTML = tiles.map(([big, label]) => `<div class="stat"><b>${big}</b><span>${label}</span></div>`).join('');
}

function renderLogs(logs) {
  $('#log-empty').hidden = logs.length > 0;
  $('#log-list').innerHTML = logs.map((log) => {
    const m = state.metrics[log.type];
    const when = parseISO(log.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    return `
      <li class="log-item" style="--c: var(--${log.type})">
        <div class="log-icon">${m.icon}</div>
        <div class="log-main">
          <b>${fmt(log.value)} ${m.unit}</b> <span class="muted">${m.label.toLowerCase()}</span>
          <small>${when}${log.note ? ' · ' + esc(log.note) : ''}</small>
        </div>
        <button class="icon-btn" data-delete="${log.id}" aria-label="Delete entry" title="Delete">✕</button>
      </li>`;
  }).join('');
}

// ---------- charts ----------

function chartLabels(days) {
  return days.map((d) => parseISO(d.date).toLocaleDateString(undefined,
    state.days <= 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' }));
}

function renderCharts(summary) {
  const host = $('#charts');
  // Build the chart cards once; after that we only update their data.
  if (!host.children.length) {
    host.innerHTML = Object.entries(state.metrics).map(([type, m]) => `
      <div class="chart-card">
        <h3>${m.icon} ${m.label} <small>goal: ${fmt(m.goal)} ${m.unit}</small></h3>
        <div class="chart-wrap"><canvas id="chart-${type}" aria-label="${m.label} per day"></canvas></div>
      </div>`).join('');
  }

  const labels = chartLabels(summary.days);
  const textColor = cssVar('--muted');
  const gridColor = cssVar('--line');

  for (const [type, m] of Object.entries(state.metrics)) {
    const values = summary.days.map((d) => d[type]);
    const goalLine = summary.days.map(() => m.goal);
    const existing = state.charts[type];

    if (existing) {
      existing.data.labels = labels;
      existing.data.datasets[0].data = values;
      existing.data.datasets[1].data = goalLine;
      existing.update();
      continue;
    }

    const color = cssVar(`--${type}`);
    state.charts[type] = new Chart($(`#chart-${type}`), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: m.label, data: values, backgroundColor: color, borderRadius: 6, maxBarThickness: 36 },
          { type: 'line', label: 'Goal', data: goalLine, borderColor: textColor, borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => ` ${fmt(ctx.parsed.y)} ${m.unit}` } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: textColor, maxRotation: 0, autoSkip: true } },
          y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: textColor } },
        },
      },
    });
  }
}

// If the user flips their OS between light and dark, rebuild charts so colours match.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  Object.values(state.charts).forEach((c) => c.destroy());
  state.charts = {};
  if (state.user) refresh();
});

// ---------- adding and deleting entries ----------

async function addLog({ type, value, date, note = '' }) {
  await api('/logs', { method: 'POST', body: { type, value, date, note } });
  await refresh();
}

async function handleLogSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const error = $('#log-error');
  showError(error, '');
  try {
    await addLog({ type: form.type.value, value: form.value.value, date: form.date.value, note: form.note.value });
    const m = state.metrics[form.type.value];
    toast(`Added ${fmt(form.value.value)} ${m.unit} of ${m.label.toLowerCase()} ${m.icon}`);
    form.value.value = '';
    form.note.value = '';
    form.value.focus();
  } catch (err) {
    showError(error, err.message);
  }
}

async function handleQuickAdd(chip) {
  const { type, value } = chip.dataset;
  try {
    await addLog({ type, value: Number(value), date: todayISO() });
    const m = state.metrics[type];
    toast(`+${fmt(value)} ${m.unit} ${m.label.toLowerCase()} ${m.icon}`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function handleDelete(id) {
  try {
    await api(`/logs/${id}`, { method: 'DELETE' });
    toast('Entry removed');
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------- start-up ----------

function fillTypeSelect() {
  const select = $('#log-type');
  select.innerHTML = Object.entries(state.metrics)
    .map(([type, m]) => `<option value="${type}">${m.icon} ${m.label}</option>`).join('');
  const updateHint = () => { $('#unit-hint').textContent = `(${state.metrics[select.value].unit})`; };
  select.addEventListener('change', updateHint);
  updateHint();
}

function wireUpEvents() {
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => setAuthMode(tab.dataset.mode)));
  $('#auth-form').addEventListener('submit', handleAuthSubmit);
  $('#logout-btn').addEventListener('click', handleLogout);
  $('#log-form').addEventListener('submit', handleLogSubmit);

  // One listener on the container handles every button inside it, even ones created later.
  $('#today-cards').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) handleQuickAdd(chip);
  });
  $('#log-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-delete]');
    if (btn) handleDelete(btn.dataset.delete);
  });
  $('#range-picker').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.days = Number(btn.dataset.days);
    document.querySelectorAll('#range-picker button').forEach((b) => b.classList.toggle('active', b === btn));
    refresh();
  });
}

async function init() {
  wireUpEvents();
  const { metrics } = await api('/config');
  state.metrics = metrics;
  fillTypeSelect();

  const { user } = await api('/me');
  if (user) await enterApp(user);
  else $('#auth-view').hidden = false; // not logged in
}

init();

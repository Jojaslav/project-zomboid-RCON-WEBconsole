const $ = (selector) => document.querySelector(selector);
const state = { ini: '', sandbox: '', spawnregions: '', spawnpoints: '' };
let currentTab = 'dashboard';
let info = { rconConfigured: false, controlsEnabled: false };
let players = [];
let timers = [];
let logBusy = false;
let challenge = null;
let me = { user: '', builtin: false, twoFactor: false };

class AuthError extends Error {}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !url.startsWith('/api/login')) { showLogin(); throw new AuthError('Session expired. Sign in again.'); }
  if (!response.ok) throw Object.assign(new Error(data.error || 'Request failed.'), { restart: Boolean(data.restart) });
  return data;
}

const fields = [
  ['Zombies', 'Zombie population', 'select', [['1', 'Insane'], ['2', 'High'], ['3', 'Normal'], ['4', 'Low'], ['5', 'None']]],
  ['Distribution', 'Zombie distribution', 'select', [['1', 'Urban focused'], ['2', 'Uniform']]],
  ['PopulationMultiplier', 'Population multiplier', 'number'],
  ['PopRespawnHours', 'Respawn hours', 'number'],
  ['WeaponLootNew', 'Weapon loot', 'number'],
  ['RangedWeaponLootNew', 'Ranged weapon loot', 'number'],
  ['ToolLootNew', 'Tool loot', 'number'],
  ['CarSpawnRate', 'Car spawn rate', 'select', [['1', 'None'], ['2', 'Very low'], ['3', 'Low'], ['4', 'Normal'], ['5', 'High']]],
  ['InitialGas', 'Initial gas', 'number'],
  ['FuelStationGas', 'Fuel station gas', 'number'],
  ['MinutesPerPage', 'Reading time (min/page)', 'number'],
];

const commandLibrary = {
  'Players & access': ['players', 'adduser "username" "password"', 'removeuserfromwhitelist "username"', 'addsteamid "steamid"', 'removesteamid "steamid"', 'banuser "username" -ip -r "reason"', 'banid "steamid"', 'banip "ip-address"', 'kickuser "username" -r "reason"'],
  'Player tools': ['additem "username" "Base.Axe" 1', 'addkey "username" "keyId" "name"', 'addxp "username" Woodwork=2 -true', 'removeitem "Base.Axe" 1', 'godmod -true', 'godmodplayer "username" -true', 'invisible -true', 'invisibleplayer "username" -true', 'noclip "username" -true', 'lightning "username"', 'addvehicle "Base.VanAmbulance" "username"'],
  'World events': ['alarm', 'chopper', 'gunshot', 'createhorde 150 "username"', 'createhorde2', 'removezombies', 'addtosafehouse "title" "username"', 'kickfromsafehouse "title" "username"', 'releasesafehouse "title"', 'removemapsymbolsforuser "username"'],
  'Server administration': ['save', 'quit', 'servermsg Your message here', 'changeoption optionName "newValue"', 'reloadoptions', 'checkModsNeedUpdate', 'reloadlua "filename"', 'reloadalllua "filename"', 'log category level', 'list', 'remove', 'help'],
};

let customActions = [];
try { customActions = JSON.parse(localStorage.getItem('pz-custom-actions') || 'null'); } catch { /* ignore corrupt data */ }
if (!Array.isArray(customActions)) customActions = [{ name: 'Give item…', command: 'additem "username" "Base.Axe" 1' }, { name: 'Announce event', command: 'servermsg Event starting now!' }];

function notice(message, bad = false) { const el = $('#notice'); el.textContent = message; el.classList.toggle('bad', bad); }
function showError(error) { if (!(error instanceof AuthError)) notice(error.message, true); }

const formatBytes = (value) => {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(value); let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
};
const formatDuration = (value) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const s = Math.floor(Number(value));
  const d = Math.floor(s / 86400); const h = Math.floor(s / 3600) % 24; const m = Math.floor(s / 60) % 60;
  return d ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
};
const formatPercent = (value) => (value === null || value === undefined ? '—' : `${Number(value).toFixed(1)}%`);

// ---- Sandbox settings helpers
function luaValue(source, key) { return source.match(new RegExp(`\\b${key}\\s*=\\s*([^,\\r\\n}]+)`))?.[1]?.trim() || ''; }
function updateLua(source, key, value) {
  const re = new RegExp(`(\\b${key}\\s*=\\s*)([^,\\r\\n}]+)`);
  return re.test(source) ? source.replace(re, (_m, prefix) => `${prefix}${value}`) : source;
}
function renderSettings() {
  const form = $('#settings-form');
  form.replaceChildren();
  for (const [key, title, kind, options] of fields) {
    const label = document.createElement('label');
    label.append(title);
    const input = document.createElement(kind === 'select' ? 'select' : 'input');
    input.name = key;
    if (kind === 'number') { input.type = 'number'; input.step = 'any'; } else for (const [value, text] of options) input.add(new Option(text, value));
    input.value = luaValue(state.sandbox, key);
    label.append(input);
    form.append(label);
  }
}

// ---- Config files
async function loadConfig(kind) {
  const data = await api(`/api/config/${kind}`);
  state[kind] = data.content;
  $(`#${kind}-content`).value = data.content;
  if (kind === 'sandbox') renderSettings();
  if (kind === 'ini') renderMods();
}
function renderMods() {
  const mods = state.ini.match(/^Mods=(.*)$/m)?.[1] || '';
  const workshop = state.ini.match(/^WorkshopItems=(.*)$/m)?.[1] || '';
  $('#mods-content').textContent = `Mods\n${mods.split(';').filter(Boolean).join('\n') || '(none)'}\n\nWorkshop items\n${workshop.split(';').filter(Boolean).join('\n') || '(none)'}`;
}
async function saveConfig(kind) {
  state[kind] = $(`#${kind}-content`).value;
  const data = await api(`/api/config/${kind}`, { method: 'PUT', body: JSON.stringify({ content: state[kind] }) });
  notice(`Saved ${kind}${data.backup ? `; backup: ${data.backup}` : ''}`);
  if (kind === 'sandbox') renderSettings();
  if (kind === 'ini') renderMods();
}

// ---- Service status / logs
async function refreshStatus() {
  const data = await api('/api/status');
  const running = data.status === 'active';
  const status = $('#status');
  status.className = `status ${running ? 'online' : 'offline'}`;
  status.replaceChildren(document.createElement('i'), Object.assign(document.createElement('span'), { textContent: running ? 'Service running' : `Service ${data.status || 'unavailable'}` }));
  const ready = running && data.ready;
  const light = $('#ready');
  light.className = `status ${ready ? 'online' : 'offline'}`;
  light.querySelector('span').textContent = ready ? 'SERVER STARTED' : running ? 'Starting up…' : 'Game not started';
  document.querySelectorAll('[data-service]').forEach((b) => { b.disabled = !data.controlsEnabled; });
}
async function loadLogs(manual = false) {
  const box = $('#logs-content');
  const state = $('#logs-state');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  try {
    const text = (await api('/api/logs')).logs || 'No journal entries found.';
    if (text !== box.textContent) {
      box.textContent = text;
      if ($('#logs-follow').checked && (nearBottom || manual || !box.dataset.ready)) box.scrollTop = box.scrollHeight;
    }
    box.dataset.ready = '1';
    state.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    state.textContent = `Update failed: ${error.message}`;
    throw error;
  }
}

// ---- RCON
function addOutput(text, type = 'response') {
  const entry = document.createElement('div');
  entry.className = `entry ${type}`;
  entry.textContent = text;
  const out = $('#output');
  out.append(entry);
  out.scrollTop = out.scrollHeight;
}
async function execute(command, { echo = true } = {}) {
  if (!command.trim()) return null;
  if (echo) addOutput(`> ${command}`, 'command');
  try {
    const r = await api('/api/rcon/command', { method: 'POST', body: JSON.stringify({ command }) });
    if (echo) addOutput(r.response, 'response');
    return r;
  } catch (error) {
    if (echo) addOutput(error.message, 'error'); else showError(error);
    return null;
  }
}
const quote = (x) => `"${String(x).replaceAll('"', '\\"')}"`;

function parsePlayers(text) {
  return [...new Set(text.split(/\r?\n/)
    .map((x) => x.trim().replace(/^[-*]\s*/, '').replace(/^\d+[.)]\s*/, ''))
    .filter((x) => x && /^[\w.\- ]+$/.test(x) && !/^(players?|connected|none|username)\b/i.test(x)))];
}
function renderPlayers(message) {
  const root = $('#players');
  root.replaceChildren();
  if (!players.length) { root.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: message || 'No players online' })); return; }
  for (const name of players) {
    const row = document.createElement('div'); row.className = 'player';
    const avatar = Object.assign(document.createElement('span'), { className: 'avatar', textContent: name[0].toUpperCase() });
    const label = Object.assign(document.createElement('span'), { className: 'player-name', textContent: name });
    const kick = Object.assign(document.createElement('button'), { textContent: 'Kick' });
    const ban = Object.assign(document.createElement('button'), { textContent: 'Ban' });
    kick.onclick = () => playerAction('kick', name);
    ban.onclick = () => playerAction('ban', name);
    row.append(avatar, label, kick, ban);
    root.append(row);
  }
}
async function refreshPlayers() {
  if (!info.rconConfigured) { players = []; renderPlayers('RCON is not configured on the server.'); return; }
  const r = await execute('players', { echo: false });
  if (!r) { players = []; renderPlayers('RCON unavailable.'); $('#player-count').textContent = '—'; return; }
  players = parsePlayers(r.response);
  $('#player-count').textContent = r.response.match(/\((\d+)\)/)?.[1] ?? players.length;
  renderPlayers();
}
function playerAction(action, name) {
  const ban = action === 'ban';
  $('#dialog-title').textContent = ban ? 'Ban player' : 'Kick player';
  $('#dialog-copy').textContent = `${ban ? 'Ban' : 'Kick'} ${name} from the server?`;
  $('#dialog-value').value = '';
  $('#dialog-confirm').onclick = async (e) => {
    e.preventDefault();
    const reason = $('#dialog-value').value.trim();
    $('#player-dialog').close();
    await execute(`${ban ? 'banuser' : 'kickuser'} ${quote(name)}${reason ? ` -r ${quote(reason)}` : ''}`);
    refreshPlayers();
  };
  $('#player-dialog').showModal();
}

function renderCustom() {
  const root = $('#custom-actions');
  root.replaceChildren();
  customActions.forEach((a, i) => {
    const wrap = Object.assign(document.createElement('div'), { className: 'custom-action' });
    const run = Object.assign(document.createElement('button'), { textContent: a.name, title: a.command });
    run.onclick = () => runCustom(a.command);
    const remove = Object.assign(document.createElement('button'), { className: 'remove', textContent: '×', title: 'Remove' });
    remove.onclick = () => { customActions.splice(i, 1); saveCustom(); };
    wrap.append(run, remove);
    root.append(wrap);
  });
}
function saveCustom() { localStorage.setItem('pz-custom-actions', JSON.stringify(customActions)); renderCustom(); }
async function runCustom(command) {
  const r = await execute(command);
  if (r) notice(`Ran: ${command}`);
}

function buildCommandLibrary() {
  const picker = $('#command-picker');
  picker.replaceChildren(new Option('Choose a command template…', ''));
  for (const [group, commands] of Object.entries(commandLibrary)) {
    const section = document.createElement('optgroup');
    section.label = group;
    for (const command of commands) section.append(new Option(command, command));
    picker.append(section);
  }
}

// ---- Metrics
let metricsBusy = false;
async function refreshMetrics() {
  if (metricsBusy) return;
  metricsBusy = true;
  try {
    const m = await api('/api/metrics');
    const server = m.server || {}; const java = m.java || {}; const system = m.system || {}; const memory = system.memory || {};
    $('#metric-uptime').textContent = formatDuration(server.uptimeSeconds);
    $('#metric-java-cpu').textContent = formatPercent(java.cpuPercent);
    $('#metric-rss').textContent = formatBytes(java.rssBytes);
    $('#metric-cpu').textContent = formatPercent(system.cpuPercent);
    $('#metric-ram').textContent = memory.usedBytes == null ? '—' : `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`;
    $('#metric-host-uptime').textContent = formatDuration(m.host?.uptimeSeconds);
    $('#uptime').textContent = formatDuration(server.uptimeSeconds);
    $('#metrics-state').textContent = server.online
      ? `Server online · PID ${server.pid} · updated ${new Date(m.timestamp).toLocaleTimeString()}`
      : 'Project Zomboid process is not running.';
  } catch (error) {
    if (!(error instanceof AuthError)) $('#metrics-state').textContent = `Metrics unavailable: ${error.message}`;
  } finally { metricsBusy = false; }
}

// ---- Tabs, session lifecycle
function selectTab(tab) {
  currentTab = tab;
  document.querySelectorAll('[role=tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((p) => p.classList.toggle('active', p.id === tab));
  if (tab === 'logs') loadLogs().catch(showError);
  if (tab === 'security') loadTwoFactor().then(loadUsers).catch(showError);
  if (tab === 'dashboard') { refreshMetrics(); refreshPlayers(); }
}

function showLogin() {
  timers.forEach(clearInterval); timers = [];
  $('#panel').hidden = true;
  $('#login').hidden = false;
  resetLoginForms();
}

async function boot() {
  $('#login').hidden = true;
  $('#panel').hidden = false;
  info = await api('/api/info');
  const results = await Promise.allSettled([...['ini', 'sandbox', 'spawnregions', 'spawnpoints'].map(loadConfig), refreshStatus(), refreshMetrics(), refreshPlayers()]);
  const failed = results.find((r) => r.status === 'rejected' && !(r.reason instanceof AuthError) && !/^Could not read/.test(r.reason.message));
  if (failed) notice(failed.reason.message, true);
  timers.push(
    setInterval(() => { if (!document.hidden && currentTab === 'logs' && !logBusy) { logBusy = true; loadLogs().catch(() => {}).finally(() => { logBusy = false; }); } }, 1000),
    setInterval(() => { if (!document.hidden && currentTab === 'dashboard') refreshMetrics(); }, 2000),
    setInterval(() => { if (!document.hidden && currentTab === 'dashboard') refreshPlayers(); }, 15000),
    setInterval(() => { if (!document.hidden) refreshStatus().catch(() => {}); }, 3000),
  );
}

// ---- Wiring
const loginPanels = ['login-form', 'code-form', 'enroll-form', 'enroll-codes'];
function showLoginPanel(id) { for (const p of loginPanels) $(`#${p}`).hidden = p !== id; }
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  try {
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#username').value, password: $('#password').value }) });
    if (result.twoFactorRequired) {
      challenge = result.challenge;
      showLoginPanel('code-form');
      $('#login-code').value = '';
      $('#login-code').focus();
      return;
    }
    if (result.enrollRequired) {
      challenge = result.challenge;
      const setup = await api('/api/login/enroll/start', { method: 'POST', body: JSON.stringify({ challenge }) });
      $('#enroll-qr').src = setup.qr;
      $('#enroll-secret').textContent = setup.secret.match(/.{1,4}/g).join(' ');
      $('#enroll-code').value = '';
      showLoginPanel('enroll-form');
      $('#enroll-code').focus();
      return;
    }
    $('#password').value = '';
    await boot();
  } catch (error) { $('#login-error').textContent = error.message; }
});
function resetLoginForms() {
  challenge = null;
  showLoginPanel('login-form');
  $('#password').value = '';
  $('#password').focus();
}
$('#code-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/api/login/2fa', { method: 'POST', body: JSON.stringify({ challenge, code: $('#login-code').value }) });
    resetLoginForms();
    await boot();
  } catch (error) {
    $('#login-error').textContent = error.message;
    if (error.restart) resetLoginForms(); else $('#login-code').select();
  }
});
$('#code-cancel').addEventListener('click', () => { $('#login-error').textContent = ''; resetLoginForms(); });
$('#enroll-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  try {
    const data = await api('/api/login/enroll', { method: 'POST', body: JSON.stringify({ challenge, code: $('#enroll-code').value }) });
    $('#enroll-codes-list').textContent = data.backupCodes.join('\n');
    showLoginPanel('enroll-codes');
  } catch (error) {
    $('#login-error').textContent = error.message;
    if (error.restart) resetLoginForms(); else $('#enroll-code').select();
  }
});
$('#enroll-cancel').addEventListener('click', () => { $('#login-error').textContent = ''; resetLoginForms(); });
$('#enroll-copy').addEventListener('click', () => navigator.clipboard.writeText($('#enroll-codes-list').textContent).catch(() => {}));
$('#enroll-done').addEventListener('click', async () => {
  $('#enroll-codes-list').textContent = '';
  resetLoginForms();
  try { await boot(); } catch (error) { $('#login-error').textContent = error.message; }
});
// ---- Two-factor settings
function tfaView(view) {
  for (const id of ['off', 'setup', 'codes']) $(`#tfa-${id}`).hidden = id !== view;
  $('#tfa-manage').hidden = view !== 'on';
}
async function loadTwoFactor() {
  const s = await api('/api/2fa');
  $('#tfa-status').textContent = s.enabled ? `Enabled · ${s.backupCodesLeft} backup code${s.backupCodesLeft === 1 ? '' : 's'} left` : 'Not enabled';
  tfaView(s.enabled ? 'on' : 'off');
  me = { user: s.user, builtin: s.builtin, twoFactor: s.enabled };
  $('#whoami').textContent = `Signed in as ${s.user}`;
  $('#tfa-disable').hidden = !s.canDisable;
  $('#users-code-note').textContent = s.enabled ? ' and a current code' : '';
}
function showBackupCodes(codes) {
  $('#tfa-codes-list').textContent = codes.join('\n');
  tfaView('codes');
}
$('#tfa-start').addEventListener('click', async () => {
  try {
    const data = await api('/api/2fa/setup', { method: 'POST' });
    $('#tfa-qr').src = data.qr;
    $('#tfa-secret').textContent = data.secret.match(/.{1,4}/g).join(' ');
    $('#tfa-code').value = '';
    tfaView('setup');
  } catch (error) { showError(error); }
});
$('#tfa-enable-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await api('/api/2fa/enable', { method: 'POST', body: JSON.stringify({ code: $('#tfa-code').value }) });
    $('#tfa-status').textContent = 'Enabled';
    showBackupCodes(data.backupCodes);
    notice('Two-factor authentication enabled. Other sessions were signed out.');
  } catch (error) { showError(error); }
});
$('#tfa-copy').addEventListener('click', () => navigator.clipboard.writeText($('#tfa-codes-list').textContent).then(() => notice('Backup codes copied.')).catch(showError));
$('#tfa-codes-done').addEventListener('click', () => { $('#tfa-codes-list').textContent = ''; loadTwoFactor().catch(showError); });
const manageBody = () => JSON.stringify({ password: $('#tfa-manage-password').value, code: $('#tfa-manage-code').value });
const clearManage = () => { $('#tfa-manage-password').value = ''; $('#tfa-manage-code').value = ''; };
$('#tfa-regen').addEventListener('click', async () => {
  try { const data = await api('/api/2fa/backup-codes', { method: 'POST', body: manageBody() }); clearManage(); showBackupCodes(data.backupCodes); } catch (error) { showError(error); }
});
$('#tfa-disable').addEventListener('click', async () => {
  if (!confirm('Disable two-factor authentication?')) return;
  try { await api('/api/2fa/disable', { method: 'POST', body: manageBody() }); clearManage(); notice('Two-factor authentication disabled.'); await loadTwoFactor(); } catch (error) { showError(error); }
});
// ---- Users
const authBody = (extra) => JSON.stringify({ password: $('#users-password').value, code: $('#users-code').value, ...extra });
const clearUsersAuth = () => { $('#users-password').value = ''; $('#users-code').value = ''; };
async function loadUsers() {
  const { users } = await api('/api/users');
  const body = $('#users-table tbody');
  body.textContent = '';
  for (const u of users) {
    const row = body.insertRow();
    row.insertCell().textContent = u.username + (u.builtin ? ' (built-in)' : '') + (u.username === me.user ? ' · you' : '');
    row.insertCell().textContent = u.twoFactor ? 'On' : (u.builtin ? 'Off' : 'Pending first sign-in');
    row.insertCell().textContent = u.createdBy || '—';
    const actions = row.insertCell();
    if (u.builtin || u.username === me.user) continue;
    const reset = document.createElement('button');
    reset.textContent = 'Reset';
    reset.addEventListener('click', () => userAction(`/api/users/${encodeURIComponent(u.username)}/reset`, 'POST', `Reset ${u.username}? Their sessions end, their authenticator is removed, and the temporary password above is set.`, { newPassword: $('#users-new').value }));
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.className = 'warning';
    del.addEventListener('click', () => userAction(`/api/users/${encodeURIComponent(u.username)}`, 'DELETE', `Delete ${u.username}?`, {}));
    actions.append(reset, ' ', del);
  }
}
async function userAction(url, method, question, extra) {
  if (!confirm(question)) return;
  try {
    await api(url, { method, body: authBody(extra) });
    clearUsersAuth(); $('#users-new').value = '';
    notice('Done.');
    await loadUsers();
  } catch (error) { showError(error); }
}
$('#users-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/users', { method: 'POST', body: authBody({ username: $('#users-name').value, newPassword: $('#users-new').value }) });
    clearUsersAuth(); $('#users-name').value = ''; $('#users-new').value = '';
    notice('User added. They will set up their authenticator at first sign-in.');
    await loadUsers();
  } catch (error) { showError(error); }
});
$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/password', { method: 'POST', body: JSON.stringify({ password: $('#pw-current').value, code: $('#pw-code').value, newPassword: $('#pw-new').value }) });
    for (const id of ['pw-current', 'pw-code', 'pw-new']) $(`#${id}`).value = '';
    notice('Password changed. Other sessions were signed out.');
  } catch (error) { showError(error); }
});
$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); showLogin(); });
document.querySelectorAll('[role=tab]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
document.querySelectorAll('[data-reload]').forEach((b) => b.addEventListener('click', () => loadConfig(b.dataset.reload).then(() => notice('Reloaded from disk.')).catch(showError)));
document.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', () => saveConfig(b.dataset.save).catch(showError)));
document.querySelectorAll('[data-backup]').forEach((b) => b.addEventListener('click', async () => {
  try { notice(`Backup created: ${(await api(`/api/config/${b.dataset.backup}/backup`, { method: 'POST' })).backup}`); } catch (error) { showError(error); }
}));
$('#settings-save').addEventListener('click', async () => {
  for (const [key] of fields) state.sandbox = updateLua(state.sandbox, key, document.querySelector(`[name=${key}]`).value);
  $('#sandbox-content').value = state.sandbox;
  await saveConfig('sandbox').catch(showError);
});
$('#refresh-status').addEventListener('click', () => { refreshStatus().catch(showError); refreshMetrics(); refreshPlayers(); });
$('#logs-reload').addEventListener('click', () => loadLogs(true).catch(showError));
$('#logs-follow').addEventListener('change', (e) => { if (e.target.checked) { const box = $('#logs-content'); box.scrollTop = box.scrollHeight; } });
document.querySelectorAll('[data-service]').forEach((b) => b.addEventListener('click', async () => {
  const action = b.dataset.service;
  if (!confirm(`${action[0].toUpperCase()}${action.slice(1)} the Project Zomboid service?`)) return;
  try { await api(`/api/service/${action}`, { method: 'POST' }); notice(`Service ${action} requested.`); setTimeout(() => refreshStatus().catch(showError), 1500); } catch (error) { showError(error); }
}));

$('#command-picker').onchange = () => { const p = $('#command-picker'); if (p.value) { $('#command').value = p.value; p.value = ''; $('#command').focus(); } };
$('#command-form').onsubmit = async (e) => { e.preventDefault(); const c = $('#command').value; $('#command').value = ''; await execute(c); };
$('#chat-form').onsubmit = async (e) => { e.preventDefault(); const m = $('#chat-message').value.trim(); if (m) { $('#chat-message').value = ''; if (await execute(`servermsg ${quote(m)}`, { echo: false })) notice('Message sent.'); } };
document.querySelector('[data-command="save"]').onclick = () => runCustom('save');
$('#announce').onclick = () => runCustom('servermsg "Server restart in 5 minutes."');
$('#restart').onclick = () => { if (confirm('Shut down the Project Zomboid server (RCON quit)?')) runCustom('quit'); };
$('#refresh-players').onclick = refreshPlayers;
$('#clear').onclick = () => $('#output').replaceChildren();
$('#add-custom').onclick = () => {
  const name = prompt('Button label:'); if (!name) return;
  const command = prompt('RCON command to send:'); if (!command) return;
  customActions.push({ name, command }); saveCustom();
};

// Desktop client integration (preload exposes pzClient only inside the installed client).
if (window.pzClient?.switchServer) {
  document.querySelectorAll('.client-only').forEach((el) => { el.hidden = false; el.onclick = () => window.pzClient.switchServer(); });
}

buildCommandLibrary();
renderCustom();
api('/api/session').then((s) => { if (s.authenticated) return boot(); }).catch(showError);

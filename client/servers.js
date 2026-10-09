const fs = require('node:fs/promises');

function normalizeUrl(input) {
  let text = String(input || '').trim();
  if (!text) throw new Error('Enter the server address.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try { url = new URL(text); } catch { throw new Error('That address is not valid.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http:// and https:// addresses are supported.');
  return url.origin;
}

async function checkServer(origin, fetchImpl = fetch) {
  let response;
  try { response = await fetchImpl(`${origin}/api/health`, { signal: AbortSignal.timeout(5000) }); }
  catch (error) { throw new Error(`Cannot reach ${origin}: ${error.cause?.code || error.message}`); }
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.app !== 'pz-control') throw new Error('That address is not a Project Zomboid Control server.');
  return data;
}

async function loadServers(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return { last: typeof data.last === 'string' ? data.last : '', servers: Array.isArray(data.servers) ? data.servers.filter((s) => typeof s === 'string') : [] };
  } catch { return { last: '', servers: [] }; }
}

async function saveServer(file, origin) {
  const data = await loadServers(file);
  data.servers = [origin, ...data.servers.filter((s) => s !== origin)].slice(0, 10);
  data.last = origin;
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

async function forgetServer(file, origin) {
  const data = await loadServers(file);
  data.servers = data.servers.filter((s) => s !== origin);
  if (data.last === origin) data.last = '';
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

module.exports = { normalizeUrl, checkServer, loadServers, saveServer, forgetServer };

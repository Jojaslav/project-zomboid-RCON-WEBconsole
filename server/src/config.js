const fs = require('node:fs');
const path = require('node:path');

const SERVICE_NAME = /^[A-Za-z0-9_.@-]{1,100}$/;

function loadEnvFile(file, env = process.env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && env[match[1]] === undefined) env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

function loadConfig(env = process.env) {
  const root = path.resolve(__dirname, '..');
  const config = {
    root,
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 8080),
    trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY || ''),
    password: env.PZ_ADMIN_PASSWORD,
    dataDir: path.resolve(root, env.PZ_DATA_DIR || './data'),
    serverDir: path.resolve(env.PZ_SERVER_DIR || '/home/pzuser/Zomboid/Server'),
    service: env.PZ_SERVICE || 'project-zomboid',
    commandPrefix: env.SYSTEMCTL_PREFIX || '',
    files: {
      ini: env.PZ_INI_FILE || 'servertest.ini',
      sandbox: env.PZ_SANDBOX_FILE || 'servertest_SandboxVars.lua',
      spawnregions: env.PZ_SPAWN_REGIONS_FILE || 'servertest_spawnregions.lua',
      spawnpoints: env.PZ_SPAWN_POINTS_FILE || 'servertest_spawnpoints.lua',
    },
    rcon: {
      host: env.RCON_HOST || '127.0.0.1',
      port: Number(env.RCON_PORT || 27015),
      password: env.RCON_PASSWORD || '',
    },
  };
  validateConfig(config);
  return config;
}

function validateConfig(config) {
  if (!config.password || config.password === 'change-this-before-starting') {
    throw new Error('Set PZ_ADMIN_PASSWORD before starting the server.');
  }
  if (config.password.length < 12) throw new Error('PZ_ADMIN_PASSWORD must be at least 12 characters.');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT is invalid.');
  if (!Number.isInteger(config.rcon.port) || config.rcon.port < 1 || config.rcon.port > 65535) throw new Error('RCON_PORT is invalid.');
  if (!SERVICE_NAME.test(config.service)) throw new Error('PZ_SERVICE contains invalid characters.');
  if (config.commandPrefix && config.commandPrefix !== 'sudo') throw new Error('SYSTEMCTL_PREFIX must be empty or "sudo".');
  for (const [kind, name] of Object.entries(config.files)) {
    if (name !== path.basename(name)) throw new Error(`File name for ${kind} must not contain a path.`);
  }
}

module.exports = { loadConfig, loadEnvFile, validateConfig };

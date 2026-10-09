const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const util = require('node:util');

const execFileAsync = util.promisify(execFile);

function cleanError(error) {
  return String(error.stderr || error.message || 'Operation failed.').trim().slice(0, 1200);
}

class ServiceControl {
  constructor({ service, commandPrefix }) {
    this.service = service;
    this.sudo = commandPrefix === 'sudo';
  }

  get controlsEnabled() { return this.sudo; }

  run(binary, args) {
    const [command, finalArgs] = this.sudo ? ['sudo', [binary, ...args]] : [binary, args];
    return execFileAsync(command, finalArgs, { timeout: 15_000, maxBuffer: 1024 * 1024 });
  }

  async status() {
    try {
      const { stdout } = await this.run('systemctl', ['is-active', this.service]);
      return { status: stdout.trim() || 'inactive' };
    } catch (error) {
      return { status: error.stdout?.trim() || 'unavailable', detail: cleanError(error) };
    }
  }

  async act(action) {
    if (!['start', 'stop', 'restart'].includes(action)) throw Object.assign(new Error('Unknown action.'), { status: 400 });
    if (!this.sudo) throw Object.assign(new Error('Service controls are disabled. Configure SYSTEMCTL_PREFIX=sudo.'), { status: 403 });
    await this.run('systemctl', [action, this.service]);
  }

  async logs() {
    // One journalctl call per second is shared by every viewer.
    if (this.logCache && Date.now() - this.logCache.at < 1000) return this.logCache.promise;
    const promise = this.run('journalctl', ['-u', this.service, '-n', '250', '--no-pager', '-o', 'short-iso']).then(({ stdout }) => stdout);
    this.logCache = { at: Date.now(), promise };
    promise.catch(() => { if (this.logCache?.promise === promise) this.logCache = null; });
    return promise;
  }

  async mainPid() {
    const { stdout } = await execFileAsync('systemctl', ['show', '-p', 'MainPID', '--value', this.service], { timeout: 5000 });
    return Number(stdout.trim()) || 0;
  }
}

class ConfigFiles {
  constructor({ serverDir, files }) {
    this.serverDir = serverDir;
    this.files = files;
  }

  resolve(kind) {
    return Object.hasOwn(this.files, kind) ? path.join(this.serverDir, this.files[kind]) : null;
  }

  async read(kind) {
    return fs.readFile(this.resolve(kind), 'utf8');
  }

  async write(kind, content) {
    const target = this.resolve(kind);
    let backup = null;
    try { backup = await this.backup(kind); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.writeFile(target, content, 'utf8');
    return backup;
  }

  async backup(kind) {
    const target = this.resolve(kind);
    const backupDir = path.join(this.serverDir, 'pz-admin-backups');
    await fs.mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(backupDir, `${path.basename(target)}.${stamp}.bak`);
    await fs.copyFile(target, backup);
    return path.basename(backup);
  }
}

module.exports = { ServiceControl, ConfigFiles, cleanError };

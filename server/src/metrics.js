const fs = require('node:fs/promises');
const os = require('node:os');

const CLK_TCK = 100;

async function readProc(file) {
  try { return await fs.readFile(file, 'utf8'); } catch { return null; }
}

function parseStat(text) {
  // comm may contain spaces/parens, so split around the last ')'.
  const end = text.lastIndexOf(')');
  const start = text.indexOf('(');
  const rest = text.slice(end + 2).split(' ');
  return { pid: Number(text.slice(0, start).trim()), comm: text.slice(start + 1, end), ppid: Number(rest[1]), utime: Number(rest[11]), stime: Number(rest[12]), starttime: Number(rest[19]) };
}

function parseCpuTotals(text) {
  const values = text.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = values[3] + (values[4] || 0);
  return { idle, total: values.reduce((a, b) => a + b, 0) };
}

async function findJavaPid(mainPid) {
  let entries;
  try { entries = await fs.readdir('/proc'); } catch { return null; }
  const procs = new Map();
  await Promise.all(entries.filter((e) => /^\d+$/.test(e)).map(async (e) => {
    const text = await readProc(`/proc/${e}/stat`);
    if (text) { try { procs.set(Number(e), parseStat(text)); } catch { /* process vanished */ } }
  }));
  const descendants = new Set();
  if (mainPid) {
    descendants.add(mainPid);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of procs.values()) if (!descendants.has(p.pid) && descendants.has(p.ppid)) { descendants.add(p.pid); grew = true; }
    }
  }
  // Build 41 runs under "java"; build 42 uses a native launcher named ProjectZomboid64 (comm is cut to 15 chars).
  const isGame = (p) => p.comm === 'java' || p.comm.startsWith('ProjectZomboid');
  const candidates = [...procs.values()].filter((p) => isGame(p) && (!mainPid || descendants.has(p.pid)));
  return candidates[0]?.pid ?? null;
}

class MetricsCollector {
  constructor({ getMainPid }) {
    this.getMainPid = getMainPid;
    this.prevCpu = null;
    this.prevJava = null;
    this.cache = null;
  }

  async collect() {
    if (this.cache && Date.now() - this.cache.at < 1000) return this.cache.value;
    const value = process.platform === 'linux' ? await this.collectLinux() : await this.collectGeneric();
    this.cache = { at: Date.now(), value };
    return value;
  }

  async collectGeneric() {
    const total = os.totalmem();
    return {
      timestamp: Date.now(),
      server: { online: false, pid: null, uptimeSeconds: null },
      java: {},
      jvm: {},
      system: { cpuPercent: null, cpuCount: os.cpus().length, memory: { usedBytes: total - os.freemem(), totalBytes: total } },
      host: { uptimeSeconds: os.uptime() },
    };
  }

  async collectLinux() {
    const now = Date.now();
    const [statText, memText, uptimeText] = await Promise.all([readProc('/proc/stat'), readProc('/proc/meminfo'), readProc('/proc/uptime')]);
    const cpu = statText ? parseCpuTotals(statText) : null;
    let systemCpu = null;
    if (cpu && this.prevCpu && cpu.total > this.prevCpu.total) {
      systemCpu = (1 - (cpu.idle - this.prevCpu.idle) / (cpu.total - this.prevCpu.total)) * 100;
    }
    if (cpu) this.prevCpu = cpu;

    const mem = {};
    for (const line of (memText || '').split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+) kB/);
      if (m) mem[m[1]] = Number(m[2]) * 1024;
    }
    const hostUptime = uptimeText ? Number(uptimeText.split(' ')[0]) : os.uptime();

    const mainPid = await this.getMainPid().catch(() => 0);
    const javaPid = await findJavaPid(mainPid);
    let server = { online: false, pid: null, uptimeSeconds: null };
    let java = {};
    if (javaPid) {
      const [pstat, pstatus] = await Promise.all([readProc(`/proc/${javaPid}/stat`), readProc(`/proc/${javaPid}/status`)]);
      if (pstat) {
        const p = parseStat(pstat);
        const ticks = p.utime + p.stime;
        let javaCpu = null;
        if (this.prevJava?.pid === javaPid && now > this.prevJava.at) {
          javaCpu = ((ticks - this.prevJava.ticks) / CLK_TCK) / ((now - this.prevJava.at) / 1000) * 100;
        }
        this.prevJava = { pid: javaPid, ticks, at: now };
        const rss = Number(pstatus?.match(/^VmRSS:\s+(\d+) kB/m)?.[1]) * 1024;
        const state = pstatus?.match(/^State:\s+(\S)/m)?.[1];
        const btime = Number(statText?.match(/^btime\s+(\d+)/m)?.[1]);
        // Containers can virtualise /proc/uptime, so prefer boot time + wall clock (what ps does).
        const uptimeSeconds = Number.isFinite(btime) ? now / 1000 - (btime + p.starttime / CLK_TCK) : hostUptime - p.starttime / CLK_TCK;
        server = { online: true, pid: javaPid, uptimeSeconds: Math.max(0, uptimeSeconds) };
        java = { cpuPercent: javaCpu, rssBytes: Number.isFinite(rss) ? rss : null, state };
      }
    } else {
      this.prevJava = null;
    }

    const totalBytes = mem.MemTotal ?? os.totalmem();
    const availableBytes = mem.MemAvailable ?? os.freemem();
    return {
      timestamp: now,
      server,
      java,
      jvm: {},
      system: { cpuPercent: systemCpu, cpuCount: os.cpus().length, memory: { usedBytes: totalBytes - availableBytes, totalBytes } },
      host: { uptimeSeconds: hostUptime },
    };
  }
}

module.exports = { MetricsCollector, parseStat, parseCpuTotals };

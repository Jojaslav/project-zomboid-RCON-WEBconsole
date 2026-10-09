// Builds dist/pz-control-server-installer.sh: a self-extracting installer containing
// the server code and its production node_modules (no npm needed on the target).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const serverDir = path.join(root, 'server');
const dist = path.join(root, 'dist');
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-stage-'));
const payload = path.join(stage, 'pz-control');

try {
  fs.mkdirSync(payload, { recursive: true });
  for (const item of ['src', 'public', 'installer', 'package.json', 'package-lock.json', '.env.example']) {
    if (fs.existsSync(path.join(serverDir, item))) fs.cpSync(path.join(serverDir, item), path.join(payload, item), { recursive: true });
  }
  fs.rmSync(path.join(payload, 'installer', 'stub.sh'), { force: true });
  // Normalise shell scripts to LF so they run on Linux regardless of the build machine.
  const setup = path.join(payload, 'installer', 'setup.sh');
  fs.writeFileSync(setup, fs.readFileSync(setup, 'utf8').replace(/\r\n/g, '\n'));

  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npmArgs = ['ci', '--omit=dev', '--no-audit', '--no-fund'];
  if (fs.existsSync(npmCli)) execFileSync(process.execPath, [npmCli, ...npmArgs], { cwd: payload, stdio: 'inherit' });
  else execFileSync('npm', npmArgs, { cwd: payload, stdio: 'inherit' });

  const archive = path.join(stage, 'payload.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', stage, 'pz-control'], { stdio: 'inherit' });

  const stub = fs.readFileSync(path.join(serverDir, 'installer', 'stub.sh'), 'utf8').replace(/\r\n/g, '\n');
  fs.mkdirSync(dist, { recursive: true });
  const out = path.join(dist, 'pz-control-server-installer.sh');
  fs.writeFileSync(out, Buffer.concat([Buffer.from(stub, 'utf8'), fs.readFileSync(archive)]), { mode: 0o755 });
  console.log(`Built ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

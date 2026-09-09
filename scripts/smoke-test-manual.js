const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const exePath = path.resolve(process.cwd(), 'release/win-unpacked/MusicDL.exe');
console.log('Launching:', exePath);
console.log('Exists:', fs.existsSync(exePath));
console.log('Size:', fs.statSync(exePath).size);

const child = spawn(exePath, [], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false,
});

let stderr = '';
let stdout = '';
child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 2000) stderr = stderr.slice(-2000); });
child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 1000) stdout = stdout.slice(-1000); });

child.on('error', (e) => {
  console.log('SPAWN ERROR:', e.message, 'code:', e.code);
});

child.on('close', (code, signal) => {
  console.log('CLOSED - code:', code, 'signal:', signal);
  if (stderr) console.log('STDERR:', stderr.slice(0, 1500));
  if (stdout) console.log('STDOUT:', stdout.slice(0, 500));
  process.exit(code || 0);
});

setTimeout(() => {
  console.log('TIMEOUT - sending SIGTERM...');
  child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1000);
}, 8000);

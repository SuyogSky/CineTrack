const { execSync } = require('child_process');
const path = require('path');

const psScript = path.join(__dirname, 'build_archive.ps1');
execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psScript}"`, {
  stdio: 'inherit',
});

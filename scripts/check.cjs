const { execFileSync } = require('node:child_process');
const fs = require('node:fs'); const path = require('node:path');
function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, e.name); if (e.isDirectory()) walk(file); else if (/\.(cjs|js)$/.test(file)) { execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' }); console.log('✓', file); } } }
walk('src'); walk('test');

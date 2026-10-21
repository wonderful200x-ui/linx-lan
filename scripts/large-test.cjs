const { spawnSync } = require('node:child_process');
const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=流式大文件', 'test/service.test.cjs'], { stdio: 'inherit', env: { ...process.env, LINX_LARGE_TEST: '1' } });
process.exit(result.status ?? 1);

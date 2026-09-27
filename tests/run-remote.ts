import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const supported = ['postgresql', 'mysql', 'oracle'];
const selected = process.argv[2] ?? process.env.TEST_DIALECT;
if (selected && !supported.includes(selected)) throw new Error(`Unsupported TEST_DIALECT: ${selected}`);
const dialects = selected ? [selected] : supported;
const root = resolve(import.meta.dirname, '..');
const proxyRoot = process.env.DRIZZLE_PROXY_ROOT ?? resolve(root, '../drizzle-proxy');
for (const dialect of dialects) {
  const script = dialect === 'postgresql'
    ? resolve(proxyRoot, 'server/tests/postgresql/drizzle.ts')
    : resolve(root, 'tests/remote-integrity.ts');
  await access(script);
  const entry = process.env.DRIZZLE_DRIVER_ENTRY ?? resolve(root, 'dist/postgresql.js');
  if (dialect === 'postgresql') await access(entry);
  const report = process.env.TEST_REPORT;
  const code = await new Promise<number>((accept, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: root, stdio: 'inherit',
      env: {
        ...process.env, TEST_DIALECT: dialect, DRIZZLE_PROXY_ROOT: proxyRoot, DRIZZLE_DRIVER_ENTRY: entry,
        ...(report ? { TEST_REPORT: selected ? report : `${report}.${dialect}.json` } : {}),
      },
    });
    child.once('error', reject);
    child.once('exit', code => accept(code ?? 1));
  });
  if (code !== 0) process.exitCode = code;
}

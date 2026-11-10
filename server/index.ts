import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { readConfig } from './config.js';

async function start() {
  const config = readConfig();
  const clientRoot = resolve(process.cwd(), 'dist/client');
  const repository = config.source === 'postgres'
    ? new (await import('./postgres.js')).PostgresRepository({ connectionString: config.connectionString!, tenant: config.tenant })
    : undefined;
  const app = await buildApp({
    dbPath: repository ? undefined : config.dbPath,
    repository,
    auth: config.auth,
    staticRoot: existsSync(clientRoot) ? clientRoot : undefined,
    logger: true,
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void app.close().then(() => process.exit(0)));
  try { await app.listen({ host: '127.0.0.1', port: config.port }); }
  catch { await app.close(); throw new Error('管理服务监听失败，请检查端口配置'); }
}
start().catch(error => {
  // Startup errors from configuration are deliberately bounded and contain no environment values.
  const safeMessages = /^(ADMIN_|生产环境|生产管理|PORT |DATABASE_URL |必须指定|数据源尚未|管理服务监听)/;
  process.stderr.write(`${error instanceof Error && safeMessages.test(error.message) ? error.message : '管理服务启动失败，请检查运行配置'}\n`);
  process.exitCode = 1;
});

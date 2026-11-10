import { resolve } from 'node:path';
import { type AuthConfig, validateAuthConfig } from './auth.js';

export interface RuntimeConfig {
  source: 'demo' | 'postgres';
  port: number;
  dbPath: string;
  connectionString?: string;
  tenant: string;
  auth?: AuthConfig;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const source = env.ADMIN_SOURCE ?? (env.NODE_ENV === 'production' ? 'postgres' : 'demo');
  if (source !== 'demo' && source !== 'postgres') throw new Error('ADMIN_SOURCE 只能是 demo 或 postgres');
  if (env.NODE_ENV === 'production' && source !== 'postgres') throw new Error('生产环境不能使用演示数据');
  const port = Number(env.PORT ?? 3102);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口号');
  const tenant = env.ADMIN_TENANT ?? 'szzhhq';
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(tenant)) throw new Error('ADMIN_TENANT 格式不正确');
  if (source === 'demo') return { source, port, tenant, dbPath: env.ADMIN_DB_PATH ?? resolve('.data/admin.sqlite') };
  const auth: AuthConfig = {
    username: env.ADMIN_USERNAME ?? '', passwordHash: env.ADMIN_PASSWORD_HASH ?? '',
    sessionSecret: env.ADMIN_SESSION_SECRET ?? '', origin: env.ADMIN_ORIGIN ?? '',
  };
  validateAuthConfig(auth);
  if (!env.DATABASE_URL) throw new Error('生产环境必须配置 DATABASE_URL');
  let database: URL;
  try { database = new URL(env.DATABASE_URL); } catch { throw new Error('DATABASE_URL 格式不正确'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('DATABASE_URL 必须指向 PostgreSQL');
  return { source, port, tenant, dbPath: '', connectionString: env.DATABASE_URL, auth };
}

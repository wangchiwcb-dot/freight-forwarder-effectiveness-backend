import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { AuthService, hashPassword, validateAuthConfig, type AuthConfig } from './auth.js';
import { readConfig } from './config.js';
import type { Repository } from './repository.js';
import { seedRoutes } from './seed.js';

const password = 'test-only-Long-Password-2026';
const origin = 'https://effective.omfreight.vip';
const host = 'effective.omfreight.vip';
let config: AuthConfig;
let app: FastifyInstance | undefined;
let repository: ReturnType<typeof fakeRepository>;
function fakeRepository() {
  return {
    source: 'postgres' as const,
    ready: vi.fn(async () => {}), close: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({ source: 'postgres' as const, containers: [], routes: [], warehouses: [], audit: [] })),
    publicPreview: vi.fn(async () => ({ source: 'postgres', containers: [] })),
    create: vi.fn(async () => seedRoutes[0]!), update: vi.fn(async () => seedRoutes[0]!),
    publish: vi.fn(async () => seedRoutes[0]!), delete: vi.fn(async () => ({ deleted: true })),
  } satisfies Repository;
}
function cookieOf(value: string | string[] | undefined) { return (Array.isArray(value) ? value[0]! : value!).split(';')[0]!; }
async function login() {
  const response = await app!.inject({ method: 'POST', url: '/api/login', headers: { host, origin }, payload: { username: config.username, password } });
  expect(response.statusCode).toBe(200);
  return { response, cookie: cookieOf(response.headers['set-cookie']) };
}
beforeAll(async () => {
  config = { username: 'admin', passwordHash: await hashPassword(password), sessionSecret: randomBytes(48).toString('base64url'), origin };
});
beforeEach(() => { repository = fakeRepository(); });
afterEach(async () => { await app?.close(); app = undefined; vi.restoreAllMocks(); });

describe('production authentication boundary', () => {
  it('refuses production without authentication or a ready data source', async () => {
    await expect(buildApp({ repository })).rejects.toThrow('必须配置管理员登录');
    expect(repository.ready).not.toHaveBeenCalled();
    repository.ready.mockRejectedValueOnce(new Error('postgres://private-secret'));
    await expect(buildApp({ repository, auth: config })).rejects.toThrow('数据源尚未就绪');
    expect(repository.close).toHaveBeenCalledOnce();
  });
  it('protects every private read and write including localhost and HEAD requests', async () => {
    app = await buildApp({ repository, auth: config });
    for (const url of ['/api/state', '/api/public-preview']) {
      for (const method of ['GET', 'HEAD'] as const) {
        expect((await app.inject({ method, url, headers: { host } })).statusCode).toBe(401);
        expect((await app.inject({ method, url, headers: { host: 'localhost' } })).statusCode).toBe(401);
      }
    }
    expect((await app.inject({ method: 'POST', url: '/api/routes', headers: { host, origin }, payload: {} })).statusCode).toBe(401);
    expect(repository.snapshot).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
    const session = await app.inject({ method: 'GET', url: '/api/session', headers: { host } });
    expect(session.json()).toEqual({ authenticated: false, user: null, source: 'postgres' });
  });
  it('issues a protected cookie and waits for async mutations with the authenticated audit actor', async () => {
    app = await buildApp({ repository, auth: config });
    const { response, cookie } = await login();
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('Secure');
    expect(response.headers['set-cookie']).toContain('SameSite=Strict');
    expect(response.headers['set-cookie']).toContain('Path=/');
    expect(response.headers['set-cookie']).not.toContain('Domain=');
    expect(response.body).not.toContain(password);
    expect(response.json()).toEqual({ authenticated: true, user: 'admin', source: 'postgres' });
    const state = await app.inject({ method: 'GET', url: '/api/state', headers: { host, cookie } });
    expect(state.statusCode).toBe(200);
    const created = await app.inject({ method: 'POST', url: '/api/routes', headers: { host, origin, cookie }, payload: { name: 'new route' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual(seedRoutes[0]);
    expect(repository.create).toHaveBeenCalledWith('routes', { name: 'new route' }, 'admin');
  });
  it('does not accept wrong passwords, altered signatures, or duplicate session cookies', async () => {
    app = await buildApp({ repository, auth: config });
    for (const credentials of [{ username: 'unknown-user', password }, { username: 'admin', password: 'incorrect-password' }]) {
      const denied = await app.inject({ method: 'POST', url: '/api/login', headers: { host, origin }, payload: credentials });
      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toEqual({ message: '用户名或密码不正确' });
      expect(denied.headers['set-cookie']).toBeUndefined();
    }
    const { cookie } = await login();
    for (const forged of [cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A'), `${cookie}; ${cookie}`, '__Host-freight_admin=invalid']) {
      expect((await app.inject({ method: 'GET', url: '/api/state', headers: { host, cookie: forged } })).statusCode).toBe(401);
    }
  });
  it('requires the exact HTTPS origin on login, logout, and all business mutations', async () => {
    app = await buildApp({ repository, auth: config });
    const { cookie } = await login();
    for (const badOrigin of [undefined, 'null', 'https://attacker.example', 'http://effective.omfreight.vip', 'https://effective.omfreight.vip:444', 'https://effective.omfreight.vip/']) {
      for (const url of ['/api/login', '/api/logout', '/api/routes']) {
        const denied = await app.inject({ method: 'POST', url, headers: { host, cookie, ...(badOrigin ? { origin: badOrigin } : {}) }, payload: {} });
        expect(denied.statusCode).toBe(403);
      }
    }
    expect((await app.inject({ method: 'POST', url: '/api/logout', headers: { host, origin, cookie, 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/state', headers: { host: 'attacker.example', cookie } })).statusCode).toBe(403);
  });
  it('revokes the existing server session on logout, including replay of the old cookie', async () => {
    app = await buildApp({ repository, auth: config });
    const { cookie } = await login();
    const logout = await app.inject({ method: 'POST', url: '/api/logout', headers: { host, origin, cookie } });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    expect(logout.json().authenticated).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/state', headers: { host, cookie } })).statusCode).toBe(401);
  });
  it('expires sessions after eight hours and invalidates them on application restart', async () => {
    let now = 1000;
    const auth = new AuthService(config, () => now);
    const { cookie } = await auth.login('admin', password, '127.0.0.1');
    expect(auth.user(cookieOf(cookie))).toBe('admin');
    expect(new AuthService(config).user(cookieOf(cookie))).toBeNull();
    now += 8 * 60 * 60 * 1000;
    expect(auth.user(cookieOf(cookie))).toBeNull();
  });
  it('limits login attempts per client and ignores spoofed forwarding headers from nonlocal clients', async () => {
    app = await buildApp({ repository, auth: config });
    for (let i = 0; i < 5; i++) {
      const result = await app.inject({ method: 'POST', url: '/api/login', remoteAddress: '198.51.100.5', headers: { host, origin, 'x-forwarded-for': `198.51.100.${100 + i}` }, payload: { username: 'admin', password: 'wrong-password' } });
      expect(result.statusCode).toBe(401);
    }
    const limited = await app.inject({ method: 'POST', url: '/api/login', remoteAddress: '198.51.100.5', headers: { host, origin, 'x-forwarded-for': '198.51.100.200' }, payload: { username: 'admin', password } });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
  it('limits total attempts and bounds concurrent password hashing', async () => {
    const auth = new AuthService(config);
    const first = auth.login('admin', 'wrong-password', '192.0.2.1').catch(e => e);
    const second = auth.login('admin', 'wrong-password', '192.0.2.2').catch(e => e);
    await expect(auth.login('admin', password, '192.0.2.3')).rejects.toMatchObject({ statusCode: 429 });
    await Promise.all([first, second]);
    for (let i = 2; i < 30; i += 2) {
      await Promise.all([auth.login('admin', 'wrong-password', `192.0.2.${i + 1}`).catch(() => {}), auth.login('admin', 'wrong-password', `192.0.2.${i + 2}`).catch(() => {})]);
    }
    await expect(auth.login('admin', password, '192.0.2.100')).rejects.toMatchObject({ statusCode: 429 });
  }, 20000);
  it('checks live readiness and does not expose database errors in responses or logging calls', async () => {
    app = await buildApp({ repository, auth: config });
    const ready = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
    expect(ready.json()).toEqual({ status: 'ok', source: 'postgres', productionConnected: true });
    repository.ready.mockRejectedValue(new Error('postgres://sensitive-user:secret@private-host'));
    const unavailable = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body).not.toContain('secret');
    const { cookie } = await login();
    const log = vi.spyOn(app.log, 'error');
    repository.snapshot.mockRejectedValue(new Error('postgres://sensitive-user:secret@private-host'));
    const failed = await app.inject({ method: 'GET', url: '/api/state', headers: { host, cookie } });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('secret');
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  });
});

describe('production runtime configuration', () => {
  const validEnv = () => ({ NODE_ENV: 'production', ADMIN_SOURCE: 'postgres', ADMIN_USERNAME: config.username, ADMIN_PASSWORD_HASH: config.passwordHash, ADMIN_SESSION_SECRET: config.sessionSecret, ADMIN_ORIGIN: origin, DATABASE_URL: 'postgresql://localhost/freight', ADMIN_TENANT: 'szzhhq' });
  it('requires explicit credentials and never falls back to demo in production', () => {
    expect(() => readConfig({ NODE_ENV: 'production' })).toThrow();
    expect(() => readConfig({ NODE_ENV: 'production', ADMIN_SOURCE: 'demo' })).toThrow('生产环境不能使用演示数据');
    expect(() => readConfig({ ...validEnv(), DATABASE_URL: undefined })).toThrow('必须配置 DATABASE_URL');
    expect(readConfig(validEnv())).toMatchObject({ source: 'postgres', tenant: 'szzhhq', auth: { origin } });
  });
  it('rejects weak secrets, untrusted password formats, insecure origins, and invalid ports', () => {
    expect(() => validateAuthConfig({ ...config, sessionSecret: 'short-secret' })).toThrow();
    expect(() => validateAuthConfig({ ...config, passwordHash: 'plaintext-password' })).toThrow();
    expect(() => validateAuthConfig({ ...config, origin: 'http://effective.omfreight.vip' })).toThrow();
    expect(() => readConfig({ ...validEnv(), PORT: 'not-a-port' })).toThrow();
    expect(() => readConfig({ ...validEnv(), ADMIN_TENANT: '../other' })).toThrow();
  });
});

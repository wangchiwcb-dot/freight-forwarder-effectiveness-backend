import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { EntityKind } from '../shared/types.js';
import { ApiError, Store } from './store.js';
import { publicationSchema, versionSchema } from './validation.js';
import { AuthError, AuthService, type AuthConfig } from './auth.js';
import type { Repository } from './repository.js';

declare module 'fastify' { interface FastifyRequest { adminUser: string | null } }
export interface AppOptions {
  dbPath?: string;
  seed?: boolean;
  repository?: Repository;
  staticRoot?: string;
  logger?: boolean;
  auth?: AuthConfig;
}
const entities = new Set(['containers', 'routes', 'warehouses']);
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', 'terminal.local']);
const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const publicApiPaths = new Set(['/api/health', '/api/session', '/api/login', '/api/logout']);
function entityFrom(value: string): EntityKind {
  if (!entities.has(value)) throw new ApiError(404, '未知的管理对象');
  return value as EntityKind;
}
function demoRepository(dbPath: string, seed: boolean): Repository {
  const store = new Store(dbPath, seed);
  return {
    source: 'demo',
    ready: () => { store.db.prepare('SELECT 1').get(); },
    close: () => store.close(),
    snapshot: () => store.snapshot(),
    publicPreview: () => store.publicPreview(),
    create: (kind, body) => store.create(kind, body),
    update: (kind, id, body, version) => store.update(kind, id, body, version),
    publish: (kind, id, published, version) => store.publish(kind, id, published, version),
    delete: (kind, id, version) => store.delete(kind, id, version),
  };
}
function requestHostname(host: string | undefined) {
  if (!host || /[\s/@\\]/.test(host)) throw new ApiError(403, '不允许此请求地址');
  try { return new URL(`http://${host}`).hostname; }
  catch { throw new ApiError(403, '不允许此请求地址'); }
}
export async function buildApp(options: AppOptions) {
  if (!options.repository && !options.dbPath) throw new Error('必须指定数据源，不能自动回退至演示数据');
  if (options.repository?.source === 'postgres' && !options.auth) throw new Error('生产管理服务必须配置管理员登录');
  const auth = options.auth ? new AuthService(options.auth) : null;
  const repository = options.repository ?? demoRepository(options.dbPath!, options.seed ?? true);
  try { await repository.ready(); }
  catch { await repository.close(); throw new Error('数据源尚未就绪，请检查数据库连接与迁移状态'); }
  const production = repository.source === 'postgres';
  const allowedHosts = production
    ? new Set([new URL(options.auth!.origin).hostname, 'localhost', '127.0.0.1', '[::1]'])
    : localHosts;
  const app = Fastify({
    logger: options.logger ? {
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', 'req.body.password', 'password'],
      serializers: { req: request => ({ method: request.method, url: request.url?.split('?')[0], hostname: request.hostname, remoteAddress: request.ip }) },
    } : false,
    // The application only listens on loopback; only the local proxy can supply client forwarding headers.
    trustProxy: ['127.0.0.1', '::1'],
    bodyLimit: 1024 * 1024,
  });
  app.decorateRequest('adminUser', null);
  app.addHook('onClose', async () => { auth?.close(); await repository.close(); });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    const hostname = requestHostname(request.headers.host);
    if (!allowedHosts.has(hostname)) throw new ApiError(403, production ? '不允许此请求地址' : '演示管理后台仅允许本机访问');
    if (mutationMethods.has(request.method)) {
      const origin = request.headers.origin;
      if (auth) {
        if (origin !== auth.config.origin) throw new ApiError(403, '请从管理后台页面发起操作');
      } else if (origin) {
        let parsed: URL;
        try { parsed = new URL(origin); } catch { throw new ApiError(403, '不允许此来源的管理操作'); }
        const requestHost = new URL(`http://${request.headers.host}`);
        if (!['http:', 'https:'].includes(parsed.protocol) || !localHosts.has(parsed.hostname)
          || ![requestHost.port, '4180', '4181', '3102'].includes(parsed.port)) throw new ApiError(403, '不允许此来源的管理操作');
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, '不允许跨站管理操作');
    }
    request.adminUser = auth ? auth.user(request.headers.cookie) : '本地管理员';
    const path = request.url.split('?')[0]!;
    if (auth && (path === '/api' || path.startsWith('/api/')) && !publicApiPaths.has(path) && !request.adminUser)
      throw new AuthError(401, '登录已失效，请重新登录');
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ message: error.issues[0]?.message ?? '提交的数据格式不正确' });
    if (error instanceof ApiError || error instanceof AuthError) {
      if (error instanceof AuthError && error.retryAfter) reply.header('Retry-After', error.retryAfter);
      return reply.code(error.statusCode).send({ message: error.message });
    }
    if (typeof error === 'object' && error && 'statusCode' in error) {
      if (error.statusCode === 400) return reply.code(400).send({ message: '请求内容格式不正确' });
      if (error.statusCode === 413) return reply.code(413).send({ message: '提交内容过大' });
      if (error.statusCode === 415) return reply.code(415).send({ message: '请求格式不支持' });
    }
    // Never serialize database errors or request bodies: driver errors can contain connection details or business data.
    request.log.error({ requestId: request.id }, '管理请求未完成');
    return reply.code(500).send({ message: '操作未完成，请稍后重试' });
  });
  app.get('/api/health', async (_request, reply) => {
    try { await repository.ready(); }
    catch { return reply.code(503).send({ status: 'unavailable', source: repository.source }); }
    return { status: 'ok', source: repository.source, productionConnected: production };
  });
  app.get('/api/session', async request => ({ authenticated: !!request.adminUser, user: request.adminUser, source: repository.source }));
  app.post('/api/login', { bodyLimit: 2048 }, async (request, reply) => {
    if (!auth) return { authenticated: true, user: '本地管理员', source: repository.source };
    const { username, password } = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(256) }).parse(request.body);
    const result = await auth.login(username, password, request.ip);
    reply.header('Set-Cookie', result.cookie);
    return { authenticated: true, user: result.user, source: repository.source };
  });
  app.post('/api/logout', async (request, reply) => {
    if (auth) reply.header('Set-Cookie', auth.logout(request.headers.cookie));
    return { authenticated: !auth, user: auth ? null : '本地管理员', source: repository.source };
  });
  app.get('/api/state', async () => await repository.snapshot());
  app.get('/api/public-preview', async () => await repository.publicPreview());
  app.post<{ Params: { entity: string } }>('/api/:entity', async (request, reply) => {
    const result = await repository.create(entityFrom(request.params.entity), request.body, request.adminUser ?? undefined);
    return reply.code(201).send(result);
  });
  app.put<{ Params: { entity: string; id: string } }>('/api/:entity/:id', async request => {
    const { version } = versionSchema.parse(request.body);
    return await repository.update(entityFrom(request.params.entity), request.params.id, request.body, version, request.adminUser ?? undefined);
  });
  app.patch<{ Params: { entity: string; id: string } }>('/api/:entity/:id/publication', async request => {
    const { version, published } = publicationSchema.parse(request.body);
    return await repository.publish(entityFrom(request.params.entity), request.params.id, published, version, request.adminUser ?? undefined);
  });
  app.delete<{ Params: { entity: string; id: string } }>('/api/:entity/:id', async request => {
    const { version } = versionSchema.parse(request.body);
    return await repository.delete(entityFrom(request.params.entity), request.params.id, version, request.adminUser ?? undefined);
  });
  if (options.staticRoot) {
    await app.register(fastifyStatic, { root: options.staticRoot, prefix: '/', cacheControl: false });
    app.setNotFoundHandler(async (request, reply) => (request.url.split('?')[0] === '/api' || request.url.startsWith('/api/'))
      ? reply.code(404).send({ message: '接口不存在' }) : reply.sendFile('index.html'));
  } else app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ message: '接口不存在' }));
  return app;
}

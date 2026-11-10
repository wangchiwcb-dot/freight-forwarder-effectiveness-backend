#!/usr/bin/env node
/**
 * Read-only production verification (business records are never changed):
 *   BASE_URL=https://effective.omfreight.vip node scripts/verify-admin.mjs --credentials /secure/admin.json
 * The JSON file contains {"username":"...","password":"..."}. Neither is printed.
 *
 * CRUD verification is ONLY for an explicitly isolated staging database:
 *   ADMIN_STAGING_ISOLATED=1 BASE_URL=http://127.0.0.1:3104 node scripts/verify-admin.mjs --credentials /secure/staging.json --staging-write
 * The flag also requires a loopback URL. Test records use a unique QATEST prefix.
 * Authentication always uses ADMIN_ORIGIN (default https://effective.omfreight.vip).
 * A final JSON summary contains assertion names and counts; no response bodies,
 * credentials, cookies, or business record identifiers are written to stdout.
 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

class SmokeFailure extends Error {
  constructor(check, status) { super(check); this.check = check; this.status = status; }
}
const passed = new Set();
const counts = {};
let currentCheck = 'configuration';
let cookie = '';
let api;
let authenticated = false;
let stagingWrite = false;
let credentials;
let activeFixtures = null;
function check(name, condition, status) {
  currentCheck = name;
  if (!condition) throw new SmokeFailure(name, status);
  passed.add(name);
}
function failureCode(error) { return error instanceof SmokeFailure ? error.check : currentCheck; }
function entityInput(record, changes = {}) {
  const { id, version, createdAt, updatedAt, sourceReferenceNo, transportMode, recordStatus, isValidData, eligibleForPublic, ...input } = record;
  return { ...input, ...changes, version, correctionReason: '隔离环境部署验证：检查维护与审计链路' };
}
function visibleContainer(container, routes) {
  return container.published && container.recordStatus !== 'cancelled'
    && (container.transportMode === undefined || container.transportMode === 'sea')
    && container.eligibleForPublic !== false && container.isValidData !== false
    && routes.some(route => route.id === container.routeId && route.enabled && route.published);
}
function visibleDelivery(container, delivery, snapshot) {
  return visibleContainer(container, snapshot.routes) && delivery.published
    && delivery.recordStatus !== 'cancelled' && delivery.eligibleForPublic !== false && delivery.isValidData !== false
    && snapshot.warehouses.some(warehouse => warehouse.id === delivery.warehouseId && warehouse.enabled && warehouse.published);
}
async function main() {
  const args = process.argv.slice(2);
  let credentialsPath;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--credentials') credentialsPath = args[++index];
    else if (args[index] === '--staging-write') stagingWrite = true;
    else throw new SmokeFailure('configuration.unknown-argument');
  }
  check('configuration.credentials-file', typeof credentialsPath === 'string' && credentialsPath.length > 0);
  currentCheck = 'configuration.base-url';
  const base = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:3104');
  check('configuration.base-url', ['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash && ['/', ''].includes(base.pathname));
  const adminOrigin = process.env.ADMIN_ORIGIN ?? 'https://effective.omfreight.vip';
  currentCheck = 'configuration.origin';
  const parsedOrigin = new URL(adminOrigin);
  check('configuration.origin', parsedOrigin.protocol === 'https:' && parsedOrigin.origin === adminOrigin);
  if (stagingWrite) {
    check('configuration.isolated-staging-required', process.env.ADMIN_STAGING_ISOLATED === '1');
    check('configuration.staging-loopback-only', ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
  } else {
    check('configuration.remote-https-required', base.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
  }
  currentCheck = 'configuration.credentials-format';
  credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
  check('configuration.credentials-format', credentials && typeof credentials.username === 'string' && typeof credentials.password === 'string' && credentials.username.length > 0 && credentials.password.length > 0);
  api = async (path, { method = 'GET', body, withCookie = true, origin = adminOrigin, withOrigin = true, expected = 200, name = path, headers = {} } = {}) => {
    currentCheck = name;
    const response = await fetch(new URL(path, base), {
      method,
      headers: { ...(withCookie && cookie ? { cookie } : {}), ...(withOrigin && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? { origin } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(45000),
    });
    if (response.status !== expected) throw new SmokeFailure(name, response.status);
    const payload = method === 'HEAD' ? null : await response.json().catch(() => { throw new SmokeFailure(`${name}.json`); });
    return { response, payload };
  };
  const health = (await api('/api/health', { name: 'health.live-database' })).payload;
  check('health.live-database', health.status === 'ok' && health.source === 'postgres' && health.productionConnected === true);
  for (const path of ['/api/state', '/api/public-preview']) {
    for (const method of ['GET', 'HEAD']) {
      const name = `auth.unauthorized-${method.toLowerCase()}-${path.endsWith('state') ? 'state' : 'preview'}`;
      await api(path, { method, withCookie: false, expected: 401, name });
      passed.add(name);
    }
  }
  const anonymousSession = (await api('/api/session', { withCookie: false, name: 'auth.anonymous-session' })).payload;
  check('auth.anonymous-session', anonymousSession.authenticated === false && anonymousSession.source === 'postgres' && anonymousSession.user === null);
  const signedIn = await api('/api/login', { method: 'POST', body: { username: credentials.username, password: credentials.password }, withCookie: false, name: 'auth.login' });
  check('auth.login', signedIn.payload.authenticated === true && signedIn.payload.user === credentials.username && signedIn.payload.source === 'postgres');
  const setCookie = signedIn.response.headers.get('set-cookie') ?? '';
  check('auth.secure-session-cookie', setCookie.startsWith('__Host-freight_admin=') && /;\s*HttpOnly/i.test(setCookie) && /;\s*Secure/i.test(setCookie) && /;\s*SameSite=Strict/i.test(setCookie) && /;\s*Path=\//i.test(setCookie) && !/;\s*Domain=/i.test(setCookie));
  cookie = setCookie.split(';')[0];
  authenticated = true;
  const session = (await api('/api/session', { name: 'auth.session-restored' })).payload;
  check('auth.session-restored', session.authenticated === true && session.user === credentials.username && session.source === 'postgres');
  // The target is guaranteed unrelated to existing records, so a broken boundary cannot modify business data.
  const nonexistent = randomUUID();
  for (const scenario of [{ name: 'auth.cross-origin-mutation-blocked', origin: 'https://untrusted.invalid' }, { name: 'auth.missing-origin-mutation-blocked', withOrigin: false }, { name: 'auth.cross-site-mutation-blocked', headers: { 'sec-fetch-site': 'cross-site' } }]) {
    await api(`/api/routes/${nonexistent}/publication`, { method: 'PATCH', body: { version: 1, published: false }, expected: 403, ...scenario });
    passed.add(scenario.name);
  }
  const initial = await snapshot('data.production-state');
  const initialCount = { containers: initial.containers.length, routes: initial.routes.length, warehouses: initial.warehouses.length, audit: initial.audit.length };
  Object.assign(counts, initialCount);
  check('data.production-counts-nonzero', initialCount.containers > 0 && initialCount.routes > 0 && initialCount.warehouses > 0);
  for (const kind of ['containers', 'routes', 'warehouses']) check(`data.unique-${kind}`, new Set(initial[kind].map(record => record.id)).size === initial[kind].length);
  check('data.references-resolve', initial.containers.every(container => initial.routes.some(route => route.id === container.routeId) && container.deliveries.every(delivery => initial.warehouses.some(warehouse => warehouse.id === delivery.warehouseId))));
  await verifyProjection(initial);
  if (stagingWrite) await verifyWrites();
  else {
    const after = await snapshot('data.read-only-state-stable');
    check('data.read-only-counts-unchanged', ['containers', 'routes', 'warehouses', 'audit'].every(key => after[key].length === initialCount[key]));
  }
  await verifyLogout();
  return { status: 'passed', mode: stagingWrite ? 'isolated-staging-write' : 'authenticated-read-only', counts, assertions: [...passed] };
}
async function snapshot(name) {
  const result = (await api('/api/state', { name })).payload;
  check(name, result.source === 'postgres' && ['containers', 'routes', 'warehouses', 'audit'].every(key => Array.isArray(result[key])));
  return result;
}
async function preview(name = 'data.public-preview') {
  const result = (await api('/api/public-preview', { name })).payload;
  check(name, result.source === 'postgres' && Array.isArray(result.containers) && Array.isArray(result.routes) && Array.isArray(result.warehouses));
  return result;
}
async function verifyProjection(state) {
  const projection = await preview();
  const expectedContainers = state.containers.filter(container => visibleContainer(container, state.routes));
  const actualIds = new Set(projection.containers.map(container => container.id));
  check('data.public-container-gates', actualIds.size === projection.containers.length && expectedContainers.length === projection.containers.length && expectedContainers.every(container => actualIds.has(container.id)));
  check('data.public-dictionary-gates', projection.routes.length === state.routes.filter(route => route.enabled && route.published).length && projection.warehouses.length === state.warehouses.filter(warehouse => warehouse.enabled && warehouse.published).length);
  let expectedDeliveries = 0;
  let actualDeliveries = 0;
  for (const publicContainer of projection.containers) {
    const source = state.containers.find(container => container.id === publicContainer.id);
    const expected = source.deliveries.filter(delivery => visibleDelivery(source, delivery, state));
    check('data.public-delivery-gates', publicContainer.deliveries.length === expected.length && expected.every(delivery => publicContainer.deliveries.some(actual => actual.id === delivery.id)));
    expectedDeliveries += expected.length;
    actualDeliveries += publicContainer.deliveries.length;
  }
  const forbidden = new Set(['owner', 'notes', 'notes_internal', 'referenceNo', 'sourceReferenceNo', 'audit', 'actor', 'password']);
  const safe = value => !value || typeof value !== 'object' || (Array.isArray(value) ? value.every(safe) : Object.entries(value).every(([key, child]) => !forbidden.has(key) && safe(child)));
  check('data.public-fields-exclude-internal-values', safe(projection));
  check('data.public-counts-bound-by-private-state', projection.containers.length <= state.containers.length && actualDeliveries === expectedDeliveries && actualDeliveries <= state.containers.reduce((sum, container) => sum + container.deliveries.length, 0));
  counts.publicContainers = projection.containers.length;
  counts.publicDeliveries = actualDeliveries;
}
async function update(kind, record, changes, name, expected = 200) {
  return (await api(`/api/${kind}/${record.id}`, { method: 'PUT', body: entityInput(record, changes), name, expected })).payload;
}
async function publish(kind, record, published, name) {
  return (await api(`/api/${kind}/${record.id}/publication`, { method: 'PATCH', body: { version: record.version, published }, name })).payload;
}
async function remove(kind, record, name, expected = 200) {
  return (await api(`/api/${kind}/${record.id}`, { method: 'DELETE', body: { version: record.version }, name, expected })).payload;
}
async function fixtureProjection(name, container, expectedContainer, expectedBatches) {
  const current = (await preview(name)).containers.find(record => record.id === container.id);
  check(name, !!current === expectedContainer && (!current || current.deliveries.length === expectedBatches));
}
async function refreshContainer(record, name) {
  const state = await snapshot(name);
  const current = state.containers.find(container => container.id === record.id);
  check(name, !!current);
  return current;
}
async function verifyWrites() {
  const suffix = randomUUID();
  const trace = `QATEST-${suffix}`;
  const secretNote = `INTERNAL-${suffix}`;
  activeFixtures = { route: null, warehouse: null, container: null };
  let route = (await api('/api/routes', { method: 'POST', body: { name: trace, channel: '隔离验证渠道', carrier: 'QA CARRIER', origin: '上海', destination: '洛杉矶', estimatedDays: 4, enabled: true, published: true }, name: 'write.create-route', expected: 201 })).payload;
  activeFixtures.route = route;
  check('write.new-route-unpublished', route.published === false && route.version === 1);
  let warehouse = (await api('/api/warehouses', { method: 'POST', body: { code: `QATEST${suffix.replaceAll('-', '').slice(0, 20).toUpperCase()}`, name: trace, region: '隔离验证', address: 'Staging only', enabled: true, published: true }, name: 'write.create-warehouse', expected: 201 })).payload;
  activeFixtures.warehouse = warehouse;
  check('write.new-warehouse-unpublished', warehouse.published === false && warehouse.version === 1);
  let container = (await api('/api/containers', { method: 'POST', body: {
    containerNo: `QATU${String(parseInt(suffix.slice(0, 8), 16) % 10000000).padStart(7, '0')}`, referenceNo: trace, routeId: route.id, vessel: 'QA VESSEL', voyage: 'QA001', containerType: '40HQ', owner: '隔离测试', notes: secretNote,
    etd: '2026-11-02', eta: '2026-11-03', loadedAt: '2026-11-01', departedAt: '2026-11-02', arrivedAt: '2026-11-03', dischargedAt: '2026-11-03', availableAt: '2026-11-04', pickedUpAt: '2026-11-04', devannedAt: '2026-11-05',
    inspectionDisposition: 'recorded', inspections: [{ id: randomUUID(), type: '隔离测试查验', startedAt: '2026-11-03', endedAt: '2026-11-04', status: 'resolved', notes: secretNote }],
    deliveries: [{ id: randomUUID(), warehouseId: warehouse.id, batchNo: trace, pieces: 12, cbm: 1.5, plannedAt: '2026-11-06', deliveredAt: '2026-11-06', published: true, notes: secretNote }], manifestComplete: true, published: true,
  }, name: 'write.create-container', expected: 201 })).payload;
  activeFixtures.container = container;
  check('write.new-container-and-batch-unpublished', container.published === false && container.deliveries.length === 1 && container.deliveries[0].published === false && Number.isInteger(container.version) && container.version > 0);
  check('write.inspection-and-lifecycle-retained', container.inspections.length === 1 && container.inspections[0].startedAt === '2026-11-03' && container.inspections[0].endedAt === '2026-11-04' && container.devannedAt === '2026-11-05');
  for (const [kind, record] of [['routes', route], ['warehouses', warehouse]]) {
    await remove(kind, record, `write.referenced-${kind}-delete-blocked`, 409);
    passed.add(`write.referenced-${kind}-delete-blocked`);
  }
  container = await publish('containers', container, true, 'write.publish-container');
  activeFixtures.container = container;
  await fixtureProjection('write.closed-route-hides-container', container, false, 0);
  route = await publish('routes', route, true, 'write.publish-route');
  activeFixtures.route = route;
  container = await refreshContainer(container, 'write.refresh-after-route-publication');
  activeFixtures.container = container;
  await fixtureProjection('write.closed-warehouse-hides-batch', container, true, 0);
  container = await update('containers', container, { deliveries: container.deliveries.map(delivery => ({ ...delivery, published: true })) }, 'write.explicit-batch-publication');
  activeFixtures.container = container;
  check('write.explicit-batch-publication', container.deliveries[0].published === true);
  await fixtureProjection('write.warehouse-still-gates-published-batch', container, true, 0);
  warehouse = await publish('warehouses', warehouse, true, 'write.publish-warehouse');
  activeFixtures.warehouse = warehouse;
  container = await refreshContainer(container, 'write.refresh-after-warehouse-publication');
  activeFixtures.container = container;
  await fixtureProjection('write.all-gates-open', container, true, 1);
  const beforeBad = container;
  await update('containers', container, { arrivedAt: '2026-11-01' }, 'write.reversed-dates-rejected', 400);
  passed.add('write.reversed-dates-rejected');
  await update('containers', container, { inspections: container.inspections.map(inspection => ({ ...inspection, endedAt: '2026-11-02' })) }, 'write.reversed-inspection-rejected', 400);
  passed.add('write.reversed-inspection-rejected');
  const unchanged = (await snapshot('write.failed-update-state')).containers.find(record => record.id === container.id);
  check('write.failed-update-is-atomic', unchanged?.version === beforeBad.version && unchanged?.arrivedAt === beforeBad.arrivedAt && unchanged?.inspections[0]?.endedAt === '2026-11-04');
  container = await update('containers', container, { notes: `${secretNote}-saved` }, 'write.valid-edit');
  activeFixtures.container = container;
  await update('containers', beforeBad, { notes: 'stale-version' }, 'write.stale-version-rejected', 409);
  passed.add('write.stale-version-rejected');
  await api(`/api/containers/${container.id}`, { method: 'PUT', body: { ...entityInput(container, { notes: 'missing-reason-test' }), correctionReason: '' }, name: 'write.correction-reason-required', expected: 400 });
  passed.add('write.correction-reason-required');
  route = await update('routes', route, { enabled: false }, 'write.disable-route');
  activeFixtures.route = route;
  await fixtureProjection('write.disabled-route-hides-container', container, false, 0);
  route = await update('routes', route, { enabled: true }, 'write.enable-route');
  activeFixtures.route = route;
  warehouse = await update('warehouses', warehouse, { enabled: false }, 'write.disable-warehouse');
  activeFixtures.warehouse = warehouse;
  await fixtureProjection('write.disabled-warehouse-hides-batch', container, true, 0);
  warehouse = await update('warehouses', warehouse, { enabled: true }, 'write.enable-warehouse');
  activeFixtures.warehouse = warehouse;
  container = await refreshContainer(container, 'write.refresh-after-dictionary-state-changes');
  activeFixtures.container = container;
  container = await update('containers', container, { deliveries: container.deliveries.map(delivery => ({ ...delivery, published: false })) }, 'write.close-batch');
  activeFixtures.container = container;
  await fixtureProjection('write.closed-batch-hidden', container, true, 0);
  container = await update('containers', container, { deliveries: container.deliveries.map(delivery => ({ ...delivery, published: true })) }, 'write.reopen-batch');
  activeFixtures.container = container;
  const afterReload = await snapshot('write.reload-persisted-data');
  const saved = afterReload.containers.find(record => record.id === container.id);
  check('write.reload-persisted-data', saved?.notes === `${secretNote}-saved` && saved?.version === container.version && saved.deliveries[0].published === true);
  const ownAudit = afterReload.audit.filter(entry => [route.id, warehouse.id, container.id].includes(entry.entityId));
  check('write.audit-actor-and-history', ownAudit.length >= 12 && ownAudit.every(entry => entry.actor === credentials.username) && ownAudit.some(entry => entry.action === 'create') && ownAudit.some(entry => entry.action === 'update') && ownAudit.some(entry => entry.action === 'publish'));
  const safeProjection = await preview('write.public-projection-safe');
  check('write.public-projection-safe', !JSON.stringify(safeProjection).includes(secretNote) && safeProjection.containers.every(record => !Object.hasOwn(record, 'referenceNo') && !Object.hasOwn(record, 'owner') && !Object.hasOwn(record, 'notes')));
  await remove('containers', container, 'write.cancel-container');
  const afterCancel = await snapshot('write.cancelled-state');
  const cancelled = afterCancel.containers.find(record => record.id === container.id);
  check('write.cancelled-container-hidden-or-marked', !cancelled || cancelled.recordStatus === 'cancelled');
  check('write.cancel-audit-retained', afterCancel.audit.some(entry => entry.entityId === container.id && entry.action === 'delete' && entry.actor === credentials.username && entry.before?.id === container.id));
  await fixtureProjection('write.cancelled-container-not-public', container, false, 0);
  activeFixtures.container = null;
  counts.stagingRecordsCreated = 3;
  counts.stagingAuditEntries = afterCancel.audit.filter(entry => [route.id, warehouse.id, container.id].includes(entry.entityId)).length;
  await cleanupFixtures();
}
async function cleanupFixtures() {
  if (!activeFixtures || !authenticated) return;
  const state = await snapshot('write.cleanup-current-state');
  if (activeFixtures.container) {
    const current = state.containers.find(record => record.id === activeFixtures.container.id);
    if (current && current.recordStatus !== 'cancelled') await remove('containers', current, 'write.cleanup-container');
    activeFixtures.container = null;
  }
  for (const [key, kind] of [['route', 'routes'], ['warehouse', 'warehouses']]) {
    if (!activeFixtures[key]) continue;
    const currentState = await snapshot(`write.cleanup-${kind}-state`);
    const current = currentState[kind].find(record => record.id === activeFixtures[key].id);
    if (current) {
      // Historical references may correctly prevent physical dictionary removal.
      try { await remove(kind, current, `write.cleanup-${kind}`); }
      catch (error) {
        if (!(error instanceof SmokeFailure) || error.status !== 409) throw error;
        await update(kind, current, { enabled: false }, `write.cleanup-disable-${kind}`);
      }
    }
    activeFixtures[key] = null;
  }
  passed.add('write.fixtures-cancelled-and-dictionaries-cleaned-or-disabled');
}
async function verifyLogout() {
  const result = (await api('/api/logout', { method: 'POST', name: 'auth.logout' })).payload;
  check('auth.logout', result.authenticated === false && result.user === null);
  authenticated = false;
  await api('/api/state', { expected: 401, name: 'auth.logout-cookie-replay-rejected' });
  passed.add('auth.logout-cookie-replay-rejected');
  const resultSession = (await api('/api/session', { name: 'auth.logged-out-session' })).payload;
  check('auth.logged-out-session', resultSession.authenticated === false);
  cookie = '';
}
let result;
try { result = await main(); }
catch (error) {
  const failedCheck = failureCode(error);
  const responseStatus = error instanceof SmokeFailure ? error.status : undefined;
  let cleanup = stagingWrite && activeFixtures ? 'pending' : 'not-needed';
  if (stagingWrite && activeFixtures && authenticated) {
    try { await cleanupFixtures(); cleanup = 'completed'; } catch { cleanup = 'requires-review'; }
  }
  if (authenticated && api) { try { await verifyLogout(); } catch { /* Preserve the original failure without logging sensitive response data. */ } }
  result = { status: 'failed', mode: stagingWrite ? 'isolated-staging-write' : 'authenticated-read-only', failedCheck, ...(responseStatus ? { responseStatus } : {}), cleanup, counts, assertions: [...passed] };
  process.exitCode = 1;
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

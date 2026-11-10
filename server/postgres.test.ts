import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Container, ShippingRoute, Warehouse } from '../shared/types.js';
import { PostgresRepository, type DatabasePool } from './postgres.js';
import {
  captureSourceSnapshot, createSourceFixtures, fixtureTenant, installSourceSchema,
  type SourceFixtureIds, type SourceSnapshot,
} from './test-support/source-schema.js';

let db: PGlite;
let repository: PostgresRepository;
let ids: SourceFixtureIds;
let beforeMigration: SourceSnapshot;
let beforePublicIds: { containers: string[]; deliveries: string[] };
const actor = 'qa-operator';
const correctionReason = '测试更正原因：已核实原始运输凭据';

async function owner<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('RESET ROLE');
  try { return await fn(); }
  finally { await db.exec('SET ROLE freight_admin_api'); }
}
async function source(table: string, id: string) {
  if (!['shipments', 'deliveries', 'shipment_exceptions', 'source_records', 'field_observations'].includes(table)) throw new Error('Unknown test table');
  return owner(async () => (await db.query<{ value: Record<string, unknown> }>(`SELECT to_jsonb(t) value FROM freight.${table} t WHERE id=$1`, [id])).rows[0]!.value);
}
async function container(name = 'complete') {
  const record = (await repository.snapshot()).containers.find(value => value.id === ids.shipments[name]);
  if (!record) throw new Error(`Fixture container missing: ${name}`);
  return record;
}
function edited<T extends object>(record: T, change: Partial<T> & Record<string, unknown>) {
  return { ...record, correctionReason, ...change };
}
async function publicIds() {
  // Same access and quality boundaries as the existing public PostgreSQL adapter.
  const gate = `s.source_tenant=$1 AND s.is_published AND m.is_published
    AND s.record_status='active' AND s.transport_mode='sea' AND s.atd_date<='2026-11-10'::date
    AND NOT freight.has_metric_issue(s.id,ARRAY['atd_date'])`;
  const containers = (await db.query<{ id: string }>(`SELECT m.id::text id FROM freight.valid_container_metrics m
    JOIN freight.shipments s ON s.id=m.id WHERE ${gate} ORDER BY m.id`, [fixtureTenant])).rows.map(row => row.id);
  const deliveries = (await db.query<{ id: string }>(`SELECT w.id::text id FROM freight.valid_container_metrics m
    JOIN freight.shipments s ON s.id=m.id JOIN freight.valid_amazon_delivery_metrics w ON w.shipment_id=s.id
    WHERE ${gate} AND w.is_published AND w.delivery_scope='amazon_warehouse'
    AND w.delivery_status='delivered' AND w.actual_delivery_date<='2026-11-10'::date ORDER BY w.id`, [fixtureTenant])).rows.map(row => row.id);
  return { containers, deliveries };
}

beforeEach(async () => {
  db = new PGlite();
  await installSourceSchema(db);
  ids = await createSourceFixtures(db);
  beforeMigration = await captureSourceSnapshot(db);
  beforePublicIds = await publicIds();
  await db.exec(await readFile(new URL('../database/baseline/public_api_role.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../database/009_admin.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../database/admin_role.sql', import.meta.url), 'utf8'));
  await db.exec('SET ROLE freight_admin_api');
  const query = <T extends Record<string, unknown>>(sql: string, values?: unknown[]) => db.query<T>(sql, values);
  const pool: DatabasePool = { query, connect: async () => ({ query, release() {} }), end: async () => {} };
  repository = new PostgresRepository({ pool, tenant: fixtureTenant, actor });
  await repository.ready();
}, 20000);
afterEach(async () => { await db?.close(); });

describe('additive production migration and restricted database roles', () => {
  it('preserves every original business column, identity, publication and evidence row', async () => {
    const after = await owner(() => captureSourceSnapshot(db, beforeMigration.columns));
    expect(after.counts).toEqual(beforeMigration.counts);
    expect(after.rows).toEqual(beforeMigration.rows);
    expect(await publicIds()).toEqual(beforePublicIds);
    const migration = await db.query<{ version: number }>('SELECT version FROM freight_admin.migrations');
    expect(migration.rows).toEqual([{ version: 9 }]);
  });

  it('lets the existing public role read gated metrics without internal management data', async () => {
    await db.exec('SET ROLE freight_public_api');
    try {
      expect(await publicIds()).toEqual(beforePublicIds);
      await expect(db.query('SELECT notes_internal FROM freight.shipments')).rejects.toThrow(/permission denied/);
      await expect(db.query('SELECT * FROM freight_admin.containers')).rejects.toThrow(/permission denied/);
      await expect(db.query("UPDATE freight.shipments SET container_no='tampered' WHERE false")).rejects.toThrow(/permission denied|read.only/);
    } finally { await db.exec('SET ROLE freight_admin_api'); }
  });

  it('prevents the application role from changing historical quality flags or deleting audit', async () => {
    for (const sql of [
      'UPDATE freight.shipments SET is_valid_data=true WHERE false',
      "UPDATE freight.shipments SET transport_mode='sea' WHERE false",
      'UPDATE freight.deliveries SET amazon_timing_eligible=true WHERE false',
      'DELETE FROM freight.shipments WHERE false',
      'UPDATE freight.audit_logs SET actor_id=actor_id WHERE false',
      'DELETE FROM freight_admin.audit_logs WHERE false',
    ]) await expect(db.query(sql)).rejects.toThrow(/permission denied/);
  });

  it('enforces batch-to-shipment identity at the database boundary', async () => {
    await expect(db.query('UPDATE freight_admin.deliveries SET shipment_id=$1 WHERE delivery_id=$2',
      [ids.shipments.invalid, ids.deliveries.first])).rejects.toThrow(/foreign key/);
    expect((await source('deliveries', ids.deliveries.first!)).shipment_id).toBe(ids.shipments.complete);
  });
});

describe('production records and manual corrections', () => {
  it('loads all tenant transports while preserving unknowns, source flags and independent batches', async () => {
    const state = await repository.snapshot();
    expect(state.source).toBe('postgres');
    expect(state.containers).toHaveLength(8);
    expect(state.containers.some(value => value.id === ids.shipments.otherTenant)).toBe(false);
    const complete = await container();
    expect(complete.deliveries.filter(value => [ids.deliveries.first, ids.deliveries.secondSameWarehouse].includes(value.id))).toHaveLength(2);
    expect(complete.deliveries.every(value => value.pieces === null && value.cbm === null)).toBe(true);
    expect(complete.inspections.find(value => value.id === ids.inspections.resolvedUnknownDates)).toMatchObject({ status: 'resolved', startedAt: null, endedAt: null });
    expect(complete.inspections.find(value => value.id === ids.inspections.unknownStatus)).toMatchObject({ status: 'unknown', startedAt: null, endedAt: null });
    expect(complete.inspections.some(value => value.id === ids.inspections.candidate || value.id === ids.inspections.rejected)).toBe(false);
    expect(await container('unknown')).toMatchObject({ containerNo: '', departedAt: null, devannedAt: null, isValidData: false, transportMode: 'unknown' });
    expect((await container('inspectionAssessmentOnly')).inspections).toEqual([expect.objectContaining({ startedAt: null, endedAt: null, status: 'unknown' })]);
  });

  it('saves unrelated notes on incomplete or disputed legacy records without inventing missing fields', async () => {
    for (const name of ['unknown', 'legacyChronology']) {
      const original = await source('shipments', ids.shipments[name]!);
      const record = await container(name);
      await repository.update('containers', record.id, edited(record, { notes: '仅补充跟进说明' }), record.version, actor);
      const saved = await source('shipments', record.id);
      for (const field of ['container_no', 'waybill_no', 'reference_no', 'source_waybill_id', 'service_name', 'channel_name',
        'atd_date', 'ata_date', 'devanned_date', 'is_valid_data', 'data_validity', 'invalid_fields', 'record_status', 'transport_mode']) {
        expect(saved[field], `${name}.${field}`).toEqual(original[field]);
      }
      expect(saved.notes_internal).toBe('仅补充跟进说明');
    }
  });

  it('does not normalize untouched legacy text when only the operator changes', async () => {
    await owner(async () => {
      await db.query('UPDATE freight.shipments SET notes_internal=$1,container_no=$2 WHERE id=$3',
        ['  leading and trailing  ', 'test1234567', ids.shipments.complete]);
    });
    const record = await container();
    expect(record).toMatchObject({ notes: '  leading and trailing  ', containerNo: 'test1234567' });
    await repository.update('containers', record.id, { owner: '仅更新跟进人' }, record.version, actor);
    const saved = await source('shipments', record.id);
    expect(saved).toMatchObject({ notes_internal: '  leading and trailing  ', container_no: 'test1234567' });
    const observations = await db.query<{ count: number }>(`SELECT count(*)::int count FROM freight.field_observations
      WHERE shipment_id=$1 AND field_name IN('notes_internal','container_no')`, [record.id]);
    expect(observations.rows[0]!.count).toBe(0);
  });

  it('ignores attempts to turn invalid, cancelled or railway records into valid ocean samples', async () => {
    for (const name of ['invalid', 'rail', 'cancelled']) {
      const record = await container(name);
      const original = await source('shipments', record.id);
      await repository.update('containers', record.id, edited(record, {
        notes: `已复核 ${name}`, transportMode: 'sea', recordStatus: 'active', isValidData: true, eligibleForPublic: true,
      }), record.version, actor);
      const saved = await source('shipments', record.id);
      for (const field of ['transport_mode', 'record_status', 'is_valid_data', 'data_validity', 'invalid_fields'])
        expect(saved[field]).toEqual(original[field]);
      expect((await publicIds()).containers).not.toContain(record.id);
    }
  });

  it('keeps reference/source identifiers distinct and appends attributable selected source evidence', async () => {
    const record = await container();
    const oldSource = await source('source_records', ids.sourceRecord);
    const oldObservation = await source('field_observations', ids.observations.departure!);
    await repository.update('containers', record.id,
      edited(record, { referenceNo: 'BILL-CORRECTED', departedAt: '2026-10-02' }), record.version, actor);
    const raw = await source('shipments', record.id);
    expect(raw).toMatchObject({ waybill_no: 'BILL-CORRECTED', reference_no: 'REFERENCE-complete', source_waybill_id: 'complete', source_system: 'fixture', atd_date: '2026-10-02' });
    expect(await source('source_records', ids.sourceRecord)).toEqual(oldSource);
    expect(await source('field_observations', ids.observations.departure!)).toEqual({ ...oldObservation, is_selected: false, manual_lock: false });
    const selected = await db.query<Record<string, unknown>>(`SELECT f.raw_value,f.normalized_value,f.manual_lock,f.selected_by,f.selection_reason,s.source_type,s.payload_sha256
      FROM freight.field_observations f JOIN freight.source_records s ON s.id=f.source_record_id
      WHERE f.shipment_id=$1 AND f.delivery_id IS NULL AND f.field_name='atd_date' AND f.is_selected`, [record.id]);
    expect(selected.rows).toEqual([expect.objectContaining({ raw_value: '2026-10-02', normalized_value: '2026-10-02', manual_lock: true,
      selected_by: actor, selection_reason: correctionReason, source_type: 'manual', payload_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
    const audit = (await repository.snapshot()).audit[0]!;
    expect(audit).toMatchObject({ entityId: record.id, action: 'update', actor, before: { departedAt: '2026-10-01' }, after: { departedAt: '2026-10-02' } });
  });

  it('rejects missing correction reasons and new date conflicts atomically', async () => {
    const record = await container();
    const before = await owner(() => captureSourceSnapshot(db));
    await expect(repository.update('containers', record.id, { ...record, departedAt: '2026-10-02' }, record.version, actor)).rejects.toMatchObject({ statusCode: 400 });
    await expect(repository.update('containers', record.id, edited(record, { devannedAt: '2026-09-01' }), record.version, actor)).rejects.toThrow();
    const after = await owner(() => captureSourceSnapshot(db, before.columns));
    expect(after.rows).toEqual(before.rows);
    expect((await repository.snapshot()).audit).toHaveLength(0);
  });

  it('uses new transport and child IDs and leaves new records unpublished', async () => {
    const record = await container();
    const batch = record.deliveries.find(value => value.id === ids.deliveries.first)!;
    const draftId = randomUUID();
    const created = await repository.create('containers', {
      ...record, referenceNo: 'BILL-NEW-MANUAL', containerType: '40HQ', published: true,
      inspectionDisposition: 'unknown', inspections: [],
      deliveries: [{ ...batch, id: draftId, batchNo: 'MANUAL-1', published: true }],
    }, actor) as Container;
    expect(created.id).not.toBe(record.id);
    expect(created.published).toBe(false);
    expect(created.deliveries).toHaveLength(1);
    expect(created.deliveries[0]).toMatchObject({ batchNo: 'MANUAL-1', published: false });
    expect(created.deliveries[0]!.id).not.toBe(draftId);
    expect((await source('shipments', created.id))).toMatchObject({ source_system: 'manual_admin', waybill_no: 'BILL-NEW-MANUAL', is_published: false });
    expect((await publicIds()).containers).not.toContain(created.id);
    expect((await source('deliveries', ids.deliveries.first!)).shipment_id).toBe(record.id);
  });

  it('retains non-managed historical batches and source dates when a managed batch is archived', async () => {
    const record = await container();
    const untouchedNames = ['aggregate', 'privateDestination', 'courier', 'unknown'];
    const untouched = await Promise.all(untouchedNames.map(name => source('deliveries', ids.deliveries[name]!)));
    await repository.update('containers', record.id,
      edited(record, { deliveries: record.deliveries.filter(value => value.id !== ids.deliveries.first) }), record.version, actor);
    expect(await source('deliveries', ids.deliveries.first!)).toMatchObject({ delivery_status: 'cancelled', actual_delivery_date: '2026-10-21' });
    expect(await Promise.all(untouchedNames.map(name => source('deliveries', ids.deliveries[name]!)))).toEqual(untouched);
    expect((await container()).deliveries.some(value => value.id === ids.deliveries.first)).toBe(false);
    expect((await publicIds()).deliveries).not.toContain(ids.deliveries.first);
  });

  it('preserves omitted child collections in a partial transport update', async () => {
    const record = await container();
    const before = await owner(() => captureSourceSnapshot(db));
    await repository.update('containers', record.id, { notes: '只提交备注字段', correctionReason }, record.version, actor);
    const saved = await container();
    expect(saved.deliveries).toEqual(record.deliveries);
    expect(saved.inspections).toEqual(record.inspections);
    const after = await owner(() => captureSourceSnapshot(db, before.columns));
    expect(after.rows.deliveries).toEqual(before.rows.deliveries);
    expect(after.rows.shipment_exceptions).toEqual(before.rows.shipment_exceptions);
  });

  it('creates, independently edits and archives inspections while retaining every historical exception', async () => {
    const record = await container();
    const untouchedNames = ['resolvedUnknownDates', 'unknownStatus', 'candidate', 'rejected', 'otherException'];
    const originalExceptions = await Promise.all(untouchedNames.map(name => source('shipment_exceptions', ids.inspections[name]!)));
    const draftId = randomUUID();
    const added = await repository.update('containers', record.id, edited(record, {
      inspections: [...record.inspections, { id: draftId, type: 'X光查验', startedAt: '2026-10-15', endedAt: null, status: 'open', notes: '新增待处理查验' }],
    }), record.version, actor) as Container;
    const newInspection = added.inspections.find(value => !record.inspections.some(previous => previous.id === value.id))!;
    expect(newInspection.id).not.toBe(draftId);
    expect(await source('shipment_exceptions', newInspection.id)).toMatchObject({ confirmation_status: 'confirmed', status: 'open',
      started_date: '2026-10-15', resolved_date: null, confirmed_by: actor });
    const changed = await repository.update('containers', added.id, edited(added, {
      inspections: added.inspections.map(value => value.id === ids.inspections.open
        ? { ...value, endedAt: '2026-10-16', status: 'resolved' as const, notes: '第一次查验已放行' }
        : value.id === newInspection.id ? { ...value, endedAt: '2026-10-17', status: 'resolved' as const, notes: '第二次查验已放行' } : value),
    }), added.version, actor) as Container;
    expect(await source('shipment_exceptions', ids.inspections.open!)).toMatchObject({ status: 'resolved', resolved_date: '2026-10-16' });
    expect(await source('shipment_exceptions', newInspection.id)).toMatchObject({ status: 'resolved', resolved_date: '2026-10-17' });
    const selected = await db.query<{ field_name: string; normalized_value: string }>(`SELECT field_name,normalized_value FROM freight.field_observations
      WHERE shipment_id=$1 AND is_selected AND field_name IN($2,$3) ORDER BY field_name`,
      [record.id, `inspection:${ids.inspections.open}:status`, `inspection:${newInspection.id}:status`]);
    expect(selected.rows).toHaveLength(2);
    expect(selected.rows.every(value => value.normalized_value === 'resolved')).toBe(true);
    await repository.update('containers', changed.id, edited(changed, {
      inspections: changed.inspections.filter(value => value.id !== newInspection.id),
    }), changed.version, actor);
    expect((await container()).inspections.some(value => value.id === newInspection.id)).toBe(false);
    expect(await source('shipment_exceptions', newInspection.id)).toMatchObject({ confirmation_status: 'rejected',
      status: 'resolved', started_date: '2026-10-15', resolved_date: '2026-10-17' });
    expect(await Promise.all(untouchedNames.map(name => source('shipment_exceptions', ids.inspections[name]!)))).toEqual(originalExceptions);
  });

  it('rejects cross-tenant entities and child reparenting without partial changes', async () => {
    const record = await container();
    const before = await owner(() => captureSourceSnapshot(db));
    for (const operation of [
      () => repository.publish('containers', ids.shipments.otherTenant!, false, 1, actor),
      () => repository.delete('containers', ids.shipments.otherTenant!, 1, actor),
      () => repository.update('containers', record.id, edited(record, {
        deliveries: [{ ...record.deliveries[0]!, id: ids.deliveries.otherTenant! }],
      }), record.version, actor),
    ]) await expect(operation()).rejects.toMatchObject({ statusCode: expect.any(Number) });
    expect((await owner(() => captureSourceSnapshot(db, before.columns))).rows).toEqual(before.rows);
    expect((await repository.snapshot()).audit).toHaveLength(0);
  });

  it('invalidates stale editors after manual or external source changes', async () => {
    const original = await container();
    await repository.update('containers', original.id, edited(original, { owner: '新跟进人' }), original.version, actor);
    for (const operation of [
      () => repository.update('containers', original.id, edited(original, { owner: '旧页面覆盖' }), original.version, actor),
      () => repository.publish('containers', original.id, false, original.version, actor),
      () => repository.delete('containers', original.id, original.version, actor),
    ]) await expect(operation()).rejects.toMatchObject({ statusCode: 409 });
    const fresh = await container();
    await owner(async () => { await db.query('UPDATE freight.shipments SET notes_public=$1 WHERE id=$2', ['其他流程更新', original.id]); });
    await expect(repository.update('containers', fresh.id, edited(fresh, { owner: '又一个旧页面' }), fresh.version, actor)).rejects.toMatchObject({ statusCode: 409 });
    expect((await container()).owner).toBe('新跟进人');
  });

  it('archives a transport without deleting dates, batches or source evidence', async () => {
    const record = await container();
    const before = await owner(() => captureSourceSnapshot(db));
    await repository.delete('containers', record.id, record.version, actor);
    expect((await repository.snapshot()).containers.some(value => value.id === record.id)).toBe(false);
    expect(await source('shipments', record.id)).toMatchObject({ record_status: 'cancelled', is_published: false,
      atd_date: '2026-10-01', devanned_date: '2026-10-16' });
    const after = await owner(() => captureSourceSnapshot(db, before.columns));
    for (const table of ['deliveries', 'tracking_events', 'shipment_exceptions']) expect(after.rows[table]).toEqual(before.rows[table]);
    expect(after.counts.shipments).toBe(before.counts.shipments);
    expect((await repository.snapshot()).audit[0]).toMatchObject({ entityId: record.id, action: 'delete', actor, after: null });
    expect((await publicIds()).containers).not.toContain(record.id);
  });
});

describe('production publication and dictionaries', () => {
  it('includes a batch with valid tail timing even when its departure timing is invalid', async () => {
    await owner(async () => {
      await db.query("UPDATE freight.deliveries SET invalid_fields=ARRAY['atd_date'],data_validity='pending_review' WHERE id=$1", [ids.deliveries.first]);
    });
    expect((await publicIds()).deliveries).toContain(ids.deliveries.first);
    const raw = await container();
    expect(raw.deliveries.find(value => value.id === ids.deliveries.first)?.eligibleForPublic).toBe(true);
    const preview = await repository.publicPreview() as { containers: { id: string; deliveries: { id: string; totalDays: number | null; tailDays: number | null }[] }[] };
    const batch = preview.containers.find(value => value.id === raw.id)!.deliveries.find(value => value.id === ids.deliveries.first);
    expect(batch).toMatchObject({ totalDays: null, tailDays: 5 });
  });

  it('masks invalid or future actual dates and metrics in preview while preserving raw editing dates', async () => {
    await owner(async () => {
      await db.query(`UPDATE freight.shipments SET ata_date='2026-10-13',picked_up_date='2026-10-15',devanned_date='2099-01-01',
        invalid_fields=ARRAY['ata_date','picked_up_date'],data_validity='pending_review' WHERE id=$1`, [ids.shipments.complete]);
    });
    const raw = await container();
    expect(raw).toMatchObject({ arrivedAt: '2026-10-13', pickedUpAt: '2026-10-15', devannedAt: '2099-01-01' });
    const preview = await repository.publicPreview() as { containers: { id: string; arrivedAt: string | null; pickedUpAt: string | null; devannedAt: string | null; totalDays: number | null }[] };
    expect(preview.containers.find(value => value.id === raw.id)).toMatchObject({ arrivedAt: null, pickedUpAt: null, devannedAt: null, totalDays: null });
    expect(await source('shipments', raw.id)).toMatchObject({ ata_date: '2026-10-13', picked_up_date: '2026-10-15', devanned_date: '2099-01-01' });
  });

  it('applies route, warehouse, batch and shipment gates to existing public metrics', async () => {
    const initial = await container();
    let state = await repository.snapshot();
    let route = state.routes.find(value => value.id === initial.routeId)!;
    route = await repository.publish('routes', route.id, false, route.version, actor) as ShippingRoute;
    expect((await publicIds()).containers).not.toContain(initial.id);
    await repository.publish('routes', route.id, true, route.version, actor);
    expect((await publicIds()).containers).toContain(initial.id);
    state = await repository.snapshot();
    let warehouse = state.warehouses.find(value => value.id === initial.deliveries.find(d => d.id === ids.deliveries.first)!.warehouseId)!;
    warehouse = await repository.publish('warehouses', warehouse.id, false, warehouse.version, actor) as Warehouse;
    expect((await publicIds()).deliveries).not.toContain(ids.deliveries.first);
    expect((await publicIds()).deliveries).toContain(ids.deliveries.otherWarehouse);
    await repository.publish('warehouses', warehouse.id, true, warehouse.version, actor);
    const fresh = await container();
    await repository.update('containers', fresh.id, edited(fresh, {
      deliveries: fresh.deliveries.map(value => ({ ...value, published: value.id === ids.deliveries.first ? false : value.published })),
    }), fresh.version, actor);
    expect((await publicIds()).deliveries).not.toContain(ids.deliveries.first);
    expect((await publicIds()).deliveries).toContain(ids.deliveries.secondSameWarehouse);
    const latest = await container();
    await repository.publish('containers', latest.id, false, latest.version, actor);
    const remaining = await publicIds();
    expect(remaining.containers).not.toContain(latest.id);
    expect(remaining.deliveries).not.toContain(ids.deliveries.otherWarehouse);
  });

  it('propagates explicit dictionary edits to linked source fields without resetting unrelated quality or tenants', async () => {
    const complete = await container();
    let state = await repository.snapshot();
    const route = state.routes.find(value => value.id === complete.routeId)!;
    const invalidBefore = await source('shipments', ids.shipments.invalid!);
    const otherTenantBefore = await source('shipments', ids.shipments.otherTenant!);
    await repository.update('routes', route.id, edited(route, { name: 'CLX-VERIFIED', channel: '核实后的公司渠道' }), route.version, actor);
    expect(await source('shipments', complete.id)).toMatchObject({ service_name: 'CLX-VERIFIED', channel_name: '核实后的公司渠道' });
    expect(await source('shipments', ids.shipments.invalid!)).toMatchObject({ is_valid_data: invalidBefore.is_valid_data, data_validity: invalidBefore.data_validity });
    expect(await source('shipments', ids.shipments.otherTenant!)).toEqual(otherTenantBefore);
    await expect(repository.update('containers', complete.id, edited(complete, { owner: '旧页面' }), complete.version, actor)).rejects.toMatchObject({ statusCode: 409 });
    state = await repository.snapshot();
    const warehouse = state.warehouses.find(value => value.id === complete.deliveries.find(d => d.id === ids.deliveries.first)!.warehouseId)!;
    const aggregateBefore = await source('deliveries', ids.deliveries.aggregate!);
    await repository.update('warehouses', warehouse.id, edited(warehouse, { name: 'Amazon ONT8 已核实名称' }), warehouse.version, actor);
    expect(await source('deliveries', ids.deliveries.first!)).toMatchObject({ warehouse_name: 'Amazon ONT8 已核实名称' });
    expect(await source('deliveries', ids.deliveries.invalid!)).toMatchObject({ is_valid_data: false, data_validity: 'invalid' });
    expect(await source('deliveries', ids.deliveries.aggregate!)).toEqual(aggregateBefore);
  });

  it('protects referenced dictionaries and removes internal fields from preview output', async () => {
    const record = await container();
    const state = await repository.snapshot();
    const route = state.routes.find(value => value.id === record.routeId)!;
    const warehouse = state.warehouses.find(value => value.id === record.deliveries[0]!.warehouseId)!;
    await expect(repository.delete('routes', route.id, route.version, actor)).rejects.toMatchObject({ statusCode: 409 });
    await expect(repository.delete('warehouses', warehouse.id, warehouse.version, actor)).rejects.toMatchObject({ statusCode: 409 });
    const preview = JSON.stringify(await repository.publicPreview());
    for (const secret of ['历史内部说明', '原始批次备注', 'REFERENCE-complete', 'BILL-complete', 'fixture-reviewer', 'audit', 'sourceReferenceNo']) expect(preview).not.toContain(secret);
  });
});

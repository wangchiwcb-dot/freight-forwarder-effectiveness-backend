import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

/** Minimal interface shared by PGlite and a PostgreSQL test connection adapter. */
export interface SourceFixtureDatabase {
  exec(sql: string): Promise<unknown>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<{ rows: T[] }>;
}

const baselineDirectory = new URL('../../database/baseline/', import.meta.url);
export const fixtureTenant = 'szzhhq';
export const fixtureDate = '2026-11-10T04:00:00.000Z';

/** Execute the real production schema history in a new, isolated test database. */
export async function installSourceSchema(db: SourceFixtureDatabase) {
  await db.exec("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='freight_app') THEN CREATE ROLE freight_app; END IF; END $$;");
  const files = ['schema.sql', ...(await readdir(baselineDirectory))
    .filter(file => /^00[1-8]_.*\.sql$/.test(file)).sort()];
  for (const file of files) await db.exec(await readFile(new URL(file, baselineDirectory), 'utf8'));
  await db.exec('GRANT USAGE ON SCHEMA freight TO freight_app; GRANT SELECT ON ALL TABLES IN SCHEMA freight TO freight_app;');
}

function identifier(value: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`Invalid test fixture SQL identifier: ${value}`);
  return `"${value}"`;
}

async function insert(db: SourceFixtureDatabase, table: string, input: Record<string, unknown>) {
  const columns = Object.keys(input);
  await db.query(`INSERT INTO freight.${identifier(table)} (${columns.map(identifier).join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`, Object.values(input));
  return input.id as string;
}

export interface SourceFixtureIds {
  shipments: Record<string, string>;
  deliveries: Record<string, string>;
  inspections: Record<string, string>;
  observations: Record<string, string>;
  importRun: string;
  sourceRecord: string;
  trackingEvent: string;
  reviewIssue: string;
}

/**
 * Synthetic legacy records deliberately include states absent from the original
 * demo editor. No source data, customer data, or credentials are copied here.
 */
export async function createSourceFixtures(db: SourceFixtureDatabase): Promise<SourceFixtureIds> {
  const ids: SourceFixtureIds = {
    shipments: {}, deliveries: {}, inspections: {}, observations: {},
    importRun: randomUUID(), sourceRecord: randomUUID(), trackingEvent: randomUUID(), reviewIssue: randomUUID(),
  };
  const shipment = async (name: string, overrides: Record<string, unknown> = {}) => {
    const id = randomUUID();
    ids.shipments[name] = id;
    return insert(db, 'shipments', {
      id, source_system: 'fixture', source_tenant: fixtureTenant, source_waybill_id: name,
      waybill_no: `BILL-${name}`, reference_no: `REFERENCE-${name}`, container_no: 'TEST1234567',
      transport_mode: 'sea', record_status: 'active', service_name: 'CLX', service_code: 'CLX',
      channel_name: '美森限时达', carrier_name: '美森', origin_port_name: '宁波', destination_port_name: '长滩',
      vessel_name: 'SYNTHETIC VESSEL', voyage_no: 'TEST-001',
      atd_date: '2026-10-01', ata_date: '2026-10-13', discharged_date: '2026-10-14',
      picked_up_date: '2026-10-15', devanned_date: '2026-10-16',
      is_valid_data: true, data_validity: 'valid', is_published: true,
      published_by: 'fixture-original-publisher', published_at: fixtureDate,
      notes_internal: '历史内部说明，不应进入公开 API', notes_public: '已核实运输节点',
      ...overrides,
    });
  };
  await shipment('complete');
  await shipment('invalid', { is_valid_data: false, data_validity: 'invalid', validity_note: '保留原始无效标志' });
  await shipment('rail', { transport_mode: 'rail' });
  await shipment('cancelled', { record_status: 'cancelled' });
  await shipment('otherTenant', { source_tenant: 'other-tenant' });
  await shipment('unpublished', { is_published: false, published_by: null, published_at: null });
  await shipment('unknown', {
    waybill_no: null, reference_no: null, container_no: null,
    service_name: null, service_code: null, channel_name: null, carrier_name: null,
    origin_port_name: null, destination_port_name: null,
    atd_date: null, ata_date: null, discharged_date: null, picked_up_date: null, devanned_date: null,
    record_status: 'unknown', transport_mode: 'unknown', is_valid_data: false,
  });
  await shipment('legacyChronology', {
    devanned_date: '2026-09-15', data_validity: 'pending_review', invalid_fields: ['devanned_date'],
    is_valid_data: false, validity_note: '历史日期矛盾；不得为了保存备注而改写日期',
  });
  await shipment('inspectionAssessmentOnly', { inspection_assessment: 'inspected', inspection_basis: 'explicit_source' });

  const delivery = async (name: string, overrides: Record<string, unknown> = {}) => {
    const id = randomUUID();
    ids.deliveries[name] = id;
    return insert(db, 'deliveries', {
      id, shipment_id: ids.shipments.complete, delivery_key: `batch-${name}`,
      warehouse_code: 'ONT8', warehouse_name: 'ONT8', destination_type: 'amazon',
      delivery_method: 'truck', delivery_scope: 'amazon_warehouse', amazon_timing_eligible: true,
      completion_class: 'delivered', delivery_status: 'delivered', actual_delivery_date: '2026-10-21',
      is_valid_data: true, delivery_date_basis: 'owner_confirmed_register',
      notes_internal: '原始批次备注', notes_public: '已送仓',
      ...overrides,
    });
  };
  await delivery('first');
  await delivery('secondSameWarehouse', { actual_delivery_date: '2026-10-23' });
  await delivery('otherWarehouse', { warehouse_code: 'LAX9', warehouse_name: 'LAX9' });
  await delivery('invalid', { is_valid_data: false, data_validity: 'invalid' });
  await delivery('aggregate', { is_aggregate: true });
  await delivery('duplicate', { is_valid_data: false, canonical_delivery_id: ids.deliveries.first });
  await delivery('privateDestination', {
    warehouse_code: null, warehouse_name: '合成私人地址', destination_type: 'private',
    delivery_scope: 'private_commercial', amazon_timing_eligible: false,
  });
  await delivery('courier', {
    warehouse_code: 'COURIER', warehouse_name: '快递交付', destination_type: 'other',
    delivery_method: 'courier', delivery_scope: 'courier', amazon_timing_eligible: false,
    completion_class: 'courier_delivered', delivery_status: 'pending', actual_delivery_date: null,
    courier_handover_date: '2026-10-21',
  });
  await delivery('unknown', {
    warehouse_code: null, warehouse_name: null, destination_type: 'unknown', delivery_scope: 'unknown',
    amazon_timing_eligible: null, completion_class: 'unknown', delivery_status: 'unknown',
    actual_delivery_date: null, is_valid_data: false,
  });
  await delivery('cancelled', { delivery_status: 'cancelled', actual_delivery_date: null });
  await delivery('otherTenant', { shipment_id: ids.shipments.otherTenant, warehouse_code: 'OTHER-WH' });

  await insert(db, 'import_runs', {
    id: ids.importRun, source_type: 'waybill', status: 'completed', processed_count: 1,
    started_at: fixtureDate, finished_at: fixtureDate,
  });
  const payload = JSON.stringify({ synthetic: true, containerNo: 'TEST1234567', departedAt: '2026-10-01' });
  await insert(db, 'source_records', {
    id: ids.sourceRecord, first_import_run_id: ids.importRun, last_import_run_id: ids.importRun,
    shipment_id: ids.shipments.complete, source_type: 'waybill', source_record_key: `${fixtureTenant}:complete`,
    source_locator: JSON.stringify({ path: '/synthetic/complete' }), payload,
    payload_sha256: createHash('sha256').update(payload).digest('hex'), parser_version: 'fixture-v1',
  });
  for (const [name, field, value, deliveryId] of [
    ['departure', 'atd_date', '2026-10-01', null],
    ['delivery', 'actual_delivery_date', '2026-10-21', ids.deliveries.first],
  ] as const) {
    ids.observations[name] = randomUUID();
    await insert(db, 'field_observations', {
      id: ids.observations[name], shipment_id: ids.shipments.complete, delivery_id: deliveryId,
      field_name: field, source_record_id: ids.sourceRecord, source_locator: `$.${field}`,
      raw_value: JSON.stringify(value), normalized_value: JSON.stringify(value), parser_version: 'fixture-v1',
      parse_status: 'valid', is_selected: true, selected_by: 'fixture-importer', selected_at: fixtureDate,
    });
  }
  for (const [name, confirmation, status, start, end, type] of [
    ['open', 'confirmed', 'open', '2026-10-14', null, 'inspection'],
    ['resolvedUnknownDates', 'confirmed', 'resolved', null, null, 'inspection'],
    ['unknownStatus', 'confirmed', 'unknown', null, null, 'inspection'],
    ['candidate', 'candidate', 'unknown', null, null, 'inspection'],
    ['rejected', 'rejected', 'resolved', null, null, 'inspection'],
    ['otherException', 'confirmed', 'open', null, null, 'port_congestion'],
  ] as const) {
    ids.inspections[name] = randomUUID();
    await insert(db, 'shipment_exceptions', {
      id: ids.inspections[name], shipment_id: ids.shipments.complete, exception_key: `fixture-${name}`,
      exception_type: type, confirmation_status: confirmation, status, started_date: start, resolved_date: end,
      description: `合成历史异常 ${name}`, source_record_id: ids.sourceRecord, source_locator: `$.exceptions.${name}`,
      confirmed_by: confirmation === 'confirmed' ? 'fixture-reviewer' : null,
      confirmed_at: confirmation === 'confirmed' ? fixtureDate : null,
    });
  }
  await insert(db, 'tracking_events', {
    id: ids.trackingEvent, shipment_id: ids.shipments.complete, event_key: 'fixture-departure',
    event_type: 'departure', event_kind: 'actual', event_date: '2026-10-01',
    time_precision: 'date', description: '合成历史开船节点', source_record_id: ids.sourceRecord,
    source_locator: '$.atd_date', parser_version: 'fixture-v1',
  });
  await insert(db, 'review_issues', {
    id: ids.reviewIssue, shipment_id: ids.shipments.legacyChronology, issue_key: 'fixture-chronology',
    issue_type: 'chronology', severity: 'error', affected_fields: ['devanned_date'],
    affected_metrics: ['departure_to_devanning_days'], description: '合成历史日期错误',
  });
  await insert(db, 'audit_logs', {
    id: randomUUID(), shipment_id: ids.shipments.complete, entity_type: 'shipment',
    entity_id: ids.shipments.complete, action: 'fixture-import', actor_type: 'importer',
    actor_id: 'fixture-importer', changes: JSON.stringify({ before: null, after: { atd_date: '2026-10-01' } }),
  });
  return ids;
}

const sourceTables = [
  'shipments', 'deliveries', 'shipment_exceptions', 'tracking_events', 'source_records',
  'field_observations', 'review_issues', 'audit_logs', 'import_runs', 'delivery_import_items',
] as const;
export type SourceColumnMap = Record<string, string[]>;
export interface SourceSnapshot {
  columns: SourceColumnMap;
  rows: Record<string, Record<string, unknown>[]>;
  counts: Record<string, number>;
}

/**
 * Capture before migration, then pass `before.columns` after migration to compare
 * every original column and UUID while allowing genuinely additive columns.
 */
export async function captureSourceSnapshot(db: SourceFixtureDatabase, originalColumns?: SourceColumnMap): Promise<SourceSnapshot> {
  const columns: SourceColumnMap = originalColumns ?? {};
  const rows: SourceSnapshot['rows'] = {};
  const counts: SourceSnapshot['counts'] = {};
  for (const table of sourceTables) {
    if (!originalColumns) {
      const result = await db.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='freight' AND table_name=$1 ORDER BY ordinal_position", [table],
      );
      columns[table] = result.rows.map(row => row.column_name);
    }
    if (!columns[table]?.length) throw new Error(`Missing original columns for ${table}`);
    const result = await db.query<{ value: Record<string, unknown> }>(`SELECT to_jsonb(t) AS value FROM freight.${identifier(table)} t ORDER BY id`);
    rows[table] = result.rows.map(({ value }) => Object.fromEntries(columns[table].map(column => [column, value[column]])));
    counts[table] = rows[table].length;
  }
  return { columns, rows, counts };
}

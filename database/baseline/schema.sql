-- 柜子时效数据库设计 v1；PostgreSQL >= 15。
-- 仅在新的目标数据库中评审后执行。本文件不连接或修改提单系统。
-- 事务同步、权限、源快照只追加和指标数据质量过滤由应用实施，见设计文档。
BEGIN;
CREATE SCHEMA freight;

CREATE TABLE freight.import_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_type text NOT NULL CHECK (source_type IN ('waybill', 'route', 'excel', 'manual')),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed')),
    parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- 只存分页、筛选、文件哈希等参数，禁止保存认证信息。
    checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
    expected_count integer CHECK (expected_count >= 0),
    processed_count integer NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
    failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    error_summary text,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (status <> 'completed' OR (failed_count = 0 AND finished_at IS NOT NULL))
);

CREATE TABLE freight.shipments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_system text NOT NULL,
    source_tenant text NOT NULL,
    source_waybill_id text NOT NULL CHECK (btrim(source_waybill_id) <> ''),
    waybill_no text,
    reference_no text,
    container_no text,
    transport_mode text NOT NULL DEFAULT 'unknown'
        CHECK (transport_mode IN ('unknown', 'sea', 'rail', 'other')),
    route_code text,
    route_name text,
    service_code text,
    service_name text,
    channel_name text,
    service_tier text,
    carrier_code text,
    carrier_name text,
    vessel_name text,
    voyage_no text,
    origin_port_code text,
    origin_port_name text,
    destination_port_code text,
    destination_port_name text,
    overseas_provider_name text,
    source_status text,
    record_status text NOT NULL DEFAULT 'unknown'
        CHECK (record_status IN ('unknown', 'active', 'cancelled')),
    etd_date date,
    atd_date date,
    eta_date date,
    ata_date date,
    discharged_date date,
    available_for_pickup_date date,
    picked_up_date date,
    devanned_date date,
    reported_delivery_date date,
    inspection_assessment text NOT NULL DEFAULT 'not_inspected'
        CHECK (inspection_assessment IN ('not_inspected', 'inspected')),
    inspection_basis text NOT NULL DEFAULT 'default_no_evidence'
        CHECK (inspection_basis IN ('default_no_evidence', 'explicit_source', 'manual')),
    delivery_manifest_status text NOT NULL DEFAULT 'unknown'
        CHECK (delivery_manifest_status IN ('unknown', 'partial', 'complete')),
    manifest_confirmed_by text,
    manifest_confirmed_at timestamptz,
    notes_internal text,
    notes_public text,
    is_published boolean NOT NULL DEFAULT false,
    published_by text,
    published_at timestamptz,
    source_updated_at timestamptz,
    last_synced_at timestamptz,
    data_validity text NOT NULL DEFAULT 'valid'
        CHECK (data_validity IN ('valid', 'pending_review', 'invalid')),
    invalid_fields text[] NOT NULL DEFAULT '{}',
    validity_note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_system, source_tenant, source_waybill_id),
    CHECK (delivery_manifest_status <> 'complete'
        OR (manifest_confirmed_by IS NOT NULL AND manifest_confirmed_at IS NOT NULL)),
    CHECK (NOT is_published OR (published_by IS NOT NULL AND published_at IS NOT NULL))
);
COMMENT ON TABLE freight.shipments IS '一条提单的一次柜子运输；柜号不唯一';
COMMENT ON COLUMN freight.shipments.channel_name IS '公司渠道名；与具体航线service_name分别存储；依据不足为空';
COMMENT ON COLUMN freight.shipments.inspection_assessment IS '按用户规则，无明确查验默认未查验；inspection_basis 区分默认值与明确证据';
COMMENT ON COLUMN freight.shipments.delivery_manifest_status IS '送仓明细范围完整性，非货物送达状态';
CREATE INDEX shipments_container_idx ON freight.shipments (container_no);
CREATE INDEX shipments_route_departure_idx ON freight.shipments (route_code, atd_date);
CREATE INDEX shipments_service_departure_idx ON freight.shipments (service_code, atd_date);
CREATE INDEX shipments_channel_departure_idx ON freight.shipments (channel_name, atd_date);
CREATE INDEX shipments_carrier_departure_idx ON freight.shipments (carrier_code, atd_date);
CREATE INDEX shipments_source_updated_idx ON freight.shipments (source_updated_at);

CREATE TABLE freight.source_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    first_import_run_id uuid NOT NULL REFERENCES freight.import_runs(id),
    last_import_run_id uuid NOT NULL REFERENCES freight.import_runs(id),
    shipment_id uuid REFERENCES freight.shipments(id),
    source_type text NOT NULL CHECK (source_type IN ('waybill', 'route', 'excel', 'manual')),
    -- key 必须含来源公司；Excel 用文件内容哈希、工作表、行号组合。
    source_record_key text NOT NULL,
    source_locator jsonb NOT NULL,
    payload jsonb NOT NULL,
    payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    parser_version text NOT NULL,
    source_updated_at timestamptz,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_type, source_record_key, payload_sha256),
    UNIQUE (shipment_id, id)
);
COMMENT ON TABLE freight.source_records IS '任务有关的原始业务片段；认证信息不得入库；未匹配 Excel 可无 shipment_id';
CREATE INDEX source_records_shipment_idx ON freight.source_records (shipment_id);

CREATE TABLE freight.deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id uuid NOT NULL REFERENCES freight.shipments(id),
    delivery_key text NOT NULL CHECK (btrim(delivery_key) <> ''),
    source_delivery_id text,
    warehouse_code text,
    warehouse_name text,
    destination_type text NOT NULL DEFAULT 'unknown'
        CHECK (destination_type IN ('unknown', 'amazon', 'overseas', 'private', 'other')),
    delivery_method text NOT NULL DEFAULT 'unknown'
        CHECK (delivery_method IN ('unknown', 'truck', 'courier', 'pickup', 'other')),
    destination_timezone text,
    isa_no text,
    promised_delivery_date date,
    estimated_delivery_date date,
    appointment_date date,
    estimated_delivery_start_date date,
    estimated_delivery_end_date date,
    postal_code text,
    original_appointment_date date,
    appointment_history jsonb NOT NULL DEFAULT '[]',
    appointment_change_count integer NOT NULL DEFAULT 0 CHECK (appointment_change_count >= 0),
    appointment_net_shift_days integer,
    parent_delivery_id uuid REFERENCES freight.deliveries(id),
    is_aggregate boolean NOT NULL DEFAULT false,
    actual_delivery_date date,
    courier_handover_date date,
    stocked_date date,
    delivery_status text NOT NULL DEFAULT 'unknown'
        CHECK (delivery_status IN ('unknown', 'pending', 'partial', 'delivered', 'cancelled')),
    pod_status text NOT NULL DEFAULT 'unknown'
        CHECK (pod_status IN ('unknown', 'pending', 'received')),
    delivery_scope text NOT NULL DEFAULT 'unknown'
        CHECK (delivery_scope IN ('amazon_warehouse', 'fbm_overseas', 'courier', 'full_container', 'private_commercial', 'unknown')),
    amazon_timing_eligible boolean,
    scope_reason text,
    completion_class text NOT NULL DEFAULT 'unknown'
        CHECK (completion_class IN ('unknown', 'delivered', 'courier_delivered', 'full_container_delivered')),
    data_validity text NOT NULL DEFAULT 'valid'
        CHECK (data_validity IN ('valid', 'pending_review', 'invalid')),
    invalid_fields text[] NOT NULL DEFAULT '{}',
    validity_note text,
    notes_internal text,
    notes_public text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (shipment_id, delivery_key),
    UNIQUE (shipment_id, id),
    CHECK (delivery_status <> 'delivered' OR actual_delivery_date IS NOT NULL),
    CHECK (actual_delivery_date IS NULL OR delivery_status = 'delivered')
);
COMMENT ON TABLE freight.deliveries IS '每目的地每批次一行；同柜同仓可多批，改约不新增相同货物批次';
COMMENT ON COLUMN freight.deliveries.promised_delivery_date IS '原始明确承诺基准；不能被最新预计日期或改约自动覆盖';
CREATE UNIQUE INDEX deliveries_source_id_idx
    ON freight.deliveries (shipment_id, source_delivery_id) WHERE source_delivery_id IS NOT NULL;
CREATE INDEX deliveries_warehouse_date_idx ON freight.deliveries (warehouse_code, actual_delivery_date);
CREATE INDEX deliveries_pending_due_idx ON freight.deliveries (promised_delivery_date)
    WHERE delivery_status IN ('unknown', 'pending', 'partial');

CREATE TABLE freight.tracking_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id uuid NOT NULL REFERENCES freight.shipments(id),
    delivery_id uuid,
    event_key text NOT NULL,
    event_type text NOT NULL CHECK (event_type IN (
        'departure', 'arrival', 'discharged', 'available', 'pickup', 'devanning',
        'courier_handover', 'delivery', 'stocked', 'inspection', 'customs_release',
        'appointment_changed', 'note', 'other')),
    event_kind text NOT NULL DEFAULT 'unknown'
        CHECK (event_kind IN ('actual', 'estimated', 'planned', 'unknown')),
    event_date date,
    event_local_time time,
    event_timezone text,
    occurred_at timestamptz,
    time_precision text NOT NULL DEFAULT 'unknown'
        CHECK (time_precision IN ('unknown', 'date', 'minute', 'second')),
    description text,
    source_record_id uuid NOT NULL,
    source_locator text NOT NULL,
    source_recorded_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (shipment_id, event_key),
    FOREIGN KEY (shipment_id, delivery_id) REFERENCES freight.deliveries(shipment_id, id),
    FOREIGN KEY (shipment_id, source_record_id) REFERENCES freight.source_records(shipment_id, id),
    CHECK (time_precision <> 'date' OR (event_date IS NOT NULL AND event_local_time IS NULL)),
    CHECK (time_precision NOT IN ('minute', 'second')
        OR (event_date IS NOT NULL AND event_local_time IS NOT NULL)),
    CHECK (event_local_time IS NULL OR event_date IS NOT NULL),
    CHECK (occurred_at IS NULL OR (event_timezone IS NOT NULL AND event_local_time IS NOT NULL))
);
CREATE INDEX tracking_events_timeline_idx ON freight.tracking_events (shipment_id, event_date, event_local_time);

CREATE TABLE freight.shipment_exceptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id uuid NOT NULL REFERENCES freight.shipments(id),
    delivery_id uuid,
    exception_key text NOT NULL,
    exception_type text NOT NULL CHECK (exception_type IN (
        'inspection', 'delivery_delay', 'appointment_changed', 'port_congestion',
        'weather', 'vehicle_issue', 'customs_hold', 'other')),
    confirmation_status text NOT NULL DEFAULT 'candidate'
        CHECK (confirmation_status IN ('candidate', 'confirmed', 'rejected')),
    status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'open', 'resolved')),
    started_date date,
    resolved_date date,
    affects_stage text,
    reason_code text,
    description text NOT NULL,
    public_description text,
    source_record_id uuid NOT NULL,
    source_locator text NOT NULL,
    confirmed_by text,
    confirmed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (shipment_id, exception_key),
    FOREIGN KEY (shipment_id, delivery_id) REFERENCES freight.deliveries(shipment_id, id),
    FOREIGN KEY (shipment_id, source_record_id) REFERENCES freight.source_records(shipment_id, id),
    CHECK (confirmation_status <> 'confirmed' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))
);
CREATE INDEX shipment_exceptions_lookup_idx
    ON freight.shipment_exceptions (shipment_id, exception_type, confirmation_status, status);

CREATE TABLE freight.field_observations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id uuid NOT NULL REFERENCES freight.shipments(id),
    delivery_id uuid,
    field_name text NOT NULL,
    source_record_id uuid NOT NULL,
    source_locator text NOT NULL,
    raw_value jsonb,
    normalized_value jsonb,
    parser_version text NOT NULL,
    parse_status text NOT NULL CHECK (parse_status IN ('valid', 'ambiguous', 'invalid', 'missing')),
    is_selected boolean NOT NULL DEFAULT false,
    manual_lock boolean NOT NULL DEFAULT false,
    selection_reason text,
    selected_by text,
    selected_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (shipment_id, delivery_id) REFERENCES freight.deliveries(shipment_id, id),
    FOREIGN KEY (shipment_id, source_record_id) REFERENCES freight.source_records(shipment_id, id),
    CHECK (NOT is_selected OR (parse_status = 'valid' AND normalized_value IS NOT NULL
        AND selected_by IS NOT NULL AND selected_at IS NOT NULL)),
    CHECK (NOT manual_lock OR (is_selected AND selection_reason IS NOT NULL))
);
COMMENT ON TABLE freight.field_observations IS '业务字段候选及当前采用值；优先级由来源类型决定；选择切换须与业务字段和审计同事务';
-- NULL delivery_id 代表主表字段；PG15 的 NULLS NOT DISTINCT 防止主表字段多选。
CREATE UNIQUE INDEX field_observations_one_selected_idx
    ON freight.field_observations (shipment_id, delivery_id, field_name) NULLS NOT DISTINCT
    WHERE is_selected;
CREATE UNIQUE INDEX field_observations_source_dedupe_idx
    ON freight.field_observations (shipment_id, delivery_id, field_name, source_record_id, source_locator, parser_version)
    NULLS NOT DISTINCT;

CREATE TABLE freight.review_issues (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id uuid REFERENCES freight.shipments(id),
    delivery_id uuid,
    source_record_id uuid REFERENCES freight.source_records(id),
    issue_key text NOT NULL UNIQUE,
    issue_type text NOT NULL CHECK (issue_type IN (
        'ambiguous_match', 'unmatched_source', 'chronology', 'field_conflict',
        'invalid_date', 'unknown_semantics', 'incomplete_manifest', 'other')),
    severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('warning', 'error')),
    affected_fields text[] NOT NULL DEFAULT '{}',
    affected_metrics text[] NOT NULL DEFAULT '{}',
    description text NOT NULL,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
    resolution text,
    resolved_by text,
    resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (shipment_id, delivery_id) REFERENCES freight.deliveries(shipment_id, id),
    CHECK (shipment_id IS NOT NULL OR source_record_id IS NOT NULL),
    CHECK (delivery_id IS NULL OR shipment_id IS NOT NULL),
    CHECK (status = 'open' OR (resolution IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX review_issues_open_idx ON freight.review_issues (shipment_id, delivery_id) WHERE status = 'open';

CREATE TABLE freight.audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id uuid REFERENCES freight.shipments(id),
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    action text NOT NULL,
    actor_type text NOT NULL CHECK (actor_type IN ('user', 'importer', 'system')),
    actor_id text NOT NULL,
    changes jsonb NOT NULL,
    reason text,
    import_run_id uuid REFERENCES freight.import_runs(id),
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE freight.audit_logs IS '只追加的操作记录；changes 保存本次涉及字段的前后值，应用角色不得改删历史';
CREATE INDEX audit_logs_entity_idx ON freight.audit_logs (entity_type, entity_id, created_at);

-- 内部摘要，不是客户授权视图，也不提供未经质量筛选的时效 KPI。
CREATE VIEW freight.shipment_summary AS
WITH delivery_rollup AS (
    SELECT shipment_id,
        count(*) FILTER (WHERE delivery_status <> 'cancelled') AS delivery_count,
        count(*) FILTER (WHERE delivery_status = 'delivered' AND actual_delivery_date IS NOT NULL) AS delivered_count,
        min(actual_delivery_date) FILTER (WHERE delivery_status = 'delivered') AS first_delivery_date,
        max(actual_delivery_date) FILTER (WHERE delivery_status = 'delivered') AS latest_delivery_date
    FROM freight.deliveries GROUP BY shipment_id
), exception_rollup AS (
    SELECT shipment_id,
        bool_or(exception_type = 'inspection') AS has_inspection,
        bool_or(status = 'open') AS has_open_exception
    FROM freight.shipment_exceptions
    WHERE confirmation_status = 'confirmed'
    GROUP BY shipment_id
), base AS (
    SELECT s.*,
        coalesce(d.delivery_count, 0) AS delivery_count,
        coalesce(d.delivered_count, 0) AS delivered_count,
        d.first_delivery_date,
        CASE WHEN s.delivery_manifest_status = 'complete' AND d.delivery_count > 0
            AND d.delivery_count = d.delivered_count THEN d.latest_delivery_date END AS all_delivered_date,
        (coalesce(e.has_inspection, false) OR s.inspection_assessment = 'inspected') AS is_check,
        coalesce(e.has_open_exception, false) AS has_open_exception,
        EXISTS (SELECT 1 FROM freight.review_issues q WHERE q.shipment_id = s.id AND q.status = 'open') AS has_open_data_issue
    FROM freight.shipments s
    LEFT JOIN delivery_rollup d ON d.shipment_id = s.id
    LEFT JOIN exception_rollup e ON e.shipment_id = s.id
)
SELECT base.*,
    CASE WHEN record_status = 'cancelled' THEN 'cancelled'
        WHEN all_delivered_date IS NOT NULL THEN 'delivered'
        WHEN delivered_count > 0 THEN 'partially_delivered'
        WHEN devanned_date IS NOT NULL THEN 'devanned'
        WHEN picked_up_date IS NOT NULL THEN 'picked_up'
        WHEN available_for_pickup_date IS NOT NULL THEN 'available'
        WHEN discharged_date IS NOT NULL THEN 'discharged'
        WHEN ata_date IS NOT NULL THEN 'arrived'
        WHEN atd_date IS NOT NULL THEN 'departed'
        ELSE 'unknown' END AS current_stage
FROM base;
COMMENT ON VIEW freight.shipment_summary IS '内部可追溯摘要；阶段为最远已知实际节点，不证明中间日期齐全；客户指标需另做权限与质量筛选';
COMMIT;

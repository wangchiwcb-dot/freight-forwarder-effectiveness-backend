BEGIN;
ALTER TABLE freight.shipments ADD COLUMN IF NOT EXISTS is_valid_data boolean NOT NULL DEFAULT false;
ALTER TABLE freight.deliveries
 ADD COLUMN IF NOT EXISTS is_valid_data boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS delivery_date_basis text,
 ADD COLUMN IF NOT EXISTS delivery_interpretation_notes text,
 ADD COLUMN IF NOT EXISTS delivery_reason_tags text[] NOT NULL DEFAULT '{}',
 ADD COLUMN IF NOT EXISTS canonical_delivery_id uuid REFERENCES freight.deliveries(id);
COMMENT ON COLUMN freight.deliveries.is_valid_data IS '客户展示只取 true：运输/目的地匹配、实际交仓日期及顺序可核实、无未解决交仓状态、非重复或汇总行';
COMMENT ON COLUMN freight.shipments.is_valid_data IS '柜子身份及开船至拆柜相关已知日期有效；缺少指标端点时该指标仍为空';
COMMENT ON COLUMN freight.deliveries.delivery_date_basis IS 'explicit_actual / owner_confirmed_register / interpreted_register_note / system：保留实际日期的采用依据';
CREATE TABLE IF NOT EXISTS freight.delivery_import_items (
 id uuid PRIMARY KEY,
 import_run_id uuid NOT NULL REFERENCES freight.import_runs(id),
 source_record_id uuid NOT NULL REFERENCES freight.source_records(id),
 source_locator text NOT NULL,
 source_container_no text,
 shipment_id uuid REFERENCES freight.shipments(id),
 delivery_id uuid REFERENCES freight.deliveries(id),
 warehouse_name text,
 warehouse_code text,
 candidate_delivery_date date,
 adopted_delivery_date date,
 match_method text NOT NULL,
 date_basis text,
 source_notes text,
 reason_tags text[] NOT NULL DEFAULT '{}',
 is_valid_data boolean NOT NULL DEFAULT false,
 validation_errors text[] NOT NULL DEFAULT '{}',
 duplicate_of uuid REFERENCES freight.deliveries(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(import_run_id,source_record_id,source_locator)
);
ALTER TABLE freight.delivery_import_items OWNER TO freight_app;
CREATE INDEX IF NOT EXISTS delivery_import_items_invalid_idx ON freight.delivery_import_items(is_valid_data);
COMMENT ON TABLE freight.delivery_import_items IS '登记表每个仓库日期单元格的处理记录；无法匹配的行也保留，明确标为无效，不强造提单';
CREATE OR REPLACE FUNCTION freight.has_metric_issue(p_shipment uuid, p_fields text[], p_delivery uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (SELECT 1 FROM freight.shipments WHERE id=p_shipment AND
  (NOT is_valid_data OR invalid_fields && p_fields OR (data_validity='invalid' AND cardinality(invalid_fields)=0)))
 OR EXISTS (SELECT 1 FROM freight.deliveries WHERE id=p_delivery AND
  (NOT is_valid_data OR is_aggregate OR invalid_fields && p_fields OR (data_validity='invalid' AND cardinality(invalid_fields)=0)))
 OR EXISTS (SELECT 1 FROM freight.review_issues q WHERE q.shipment_id=p_shipment AND q.status='open'
  AND (q.delivery_id IS NULL OR q.delivery_id=p_delivery)
  AND ((q.severity='error' AND q.affected_fields && p_fields)
    OR (q.issue_type='ambiguous_match' AND q.affected_metrics && p_fields)));
$$;
CREATE OR REPLACE VIEW freight.shipment_metrics AS
SELECT s.id,s.source_waybill_id,s.container_no,s.transport_mode,s.record_status,
 s.route_code,s.route_name,s.service_name,s.service_tier,s.carrier_name,
 s.atd_date,s.ata_date,s.picked_up_date,s.devanned_date,s.reported_delivery_date,
 summary.is_check,s.is_published,
 CASE WHEN s.record_status='active' AND s.transport_mode='sea' AND s.ata_date>=s.atd_date
  AND NOT freight.has_metric_issue(s.id,ARRAY['atd_date','ata_date']) THEN s.ata_date-s.atd_date END AS sea_days,
 CASE WHEN s.record_status='active' AND s.picked_up_date>=s.ata_date
  AND NOT freight.has_metric_issue(s.id,ARRAY['ata_date','picked_up_date']) THEN s.picked_up_date-s.ata_date END AS arrival_to_pickup_days,
 CASE WHEN s.record_status='active' AND s.devanned_date>=s.picked_up_date
  AND NOT freight.has_metric_issue(s.id,ARRAY['picked_up_date','devanned_date']) THEN s.devanned_date-s.picked_up_date END AS pickup_to_devanning_days,
 CASE WHEN s.record_status='active' AND s.transport_mode='sea' AND s.devanned_date>=s.atd_date
  AND NOT freight.has_metric_issue(s.id,ARRAY['atd_date','devanned_date']) THEN s.devanned_date-s.atd_date END AS departure_to_devanning_days,
 CASE WHEN s.record_status='active' AND s.devanned_date IS NOT NULL
  AND NOT freight.has_metric_issue(s.id,ARRAY['devanned_date']) THEN s.devanned_date END AS lifecycle_completed_date,
 s.data_validity,s.invalid_fields,s.is_valid_data
FROM freight.shipments s JOIN freight.shipment_summary summary ON summary.id=s.id;
CREATE OR REPLACE VIEW freight.container_lifecycle AS
SELECT m.id,m.source_waybill_id,m.container_no,m.transport_mode,m.record_status,m.route_code,m.route_name,m.service_name,m.service_tier,m.carrier_name,m.atd_date,m.ata_date,m.picked_up_date,m.devanned_date,m.reported_delivery_date,m.is_check,m.is_published,m.sea_days,m.arrival_to_pickup_days,m.pickup_to_devanning_days,m.departure_to_devanning_days,m.lifecycle_completed_date,m.data_validity,m.invalid_fields,CASE WHEN record_status='cancelled' THEN 'cancelled'
 WHEN lifecycle_completed_date IS NOT NULL THEN 'completed'
 WHEN picked_up_date IS NOT NULL AND NOT freight.has_metric_issue(id,ARRAY['picked_up_date']) THEN 'picked_up'
 WHEN ata_date IS NOT NULL AND NOT freight.has_metric_issue(id,ARRAY['ata_date']) THEN 'arrived'
 WHEN atd_date IS NOT NULL AND NOT freight.has_metric_issue(id,ARRAY['atd_date']) THEN 'departed'
 ELSE 'unknown' END AS lifecycle_status,m.is_valid_data
FROM freight.shipment_metrics m;
COMMENT ON VIEW freight.container_lifecycle IS '柜子/航线生命周期止于拆柜；每提单一次运输一行，不被送仓明细重复加权';
CREATE OR REPLACE VIEW freight.amazon_delivery_metrics AS
SELECT d.id, d.shipment_id, d.warehouse_code, d.warehouse_name,
       d.delivery_scope, d.amazon_timing_eligible, d.completion_class,
       d.estimated_delivery_date, d.estimated_delivery_start_date, d.estimated_delivery_end_date,
       d.actual_delivery_date, d.delivery_status, d.data_validity,
       s.route_name, s.service_name, s.carrier_name, s.is_published,
       CASE WHEN s.record_status='active'

                  AND d.amazon_timing_eligible IS TRUE
                  AND d.delivery_status='delivered' AND NOT d.is_aggregate
                  AND d.actual_delivery_date >= s.atd_date
                  AND NOT freight.has_metric_issue(s.id,ARRAY['atd_date','actual_delivery_date'],d.id)
            THEN d.actual_delivery_date-s.atd_date END AS departure_to_amazon_delivery_days,
       CASE WHEN s.record_status='active'

                  AND d.amazon_timing_eligible IS TRUE
                  AND d.delivery_status='delivered' AND NOT d.is_aggregate
                  AND d.actual_delivery_date >= s.devanned_date
                  AND NOT freight.has_metric_issue(s.id,ARRAY['devanned_date','actual_delivery_date'],d.id)
            THEN d.actual_delivery_date-s.devanned_date END AS devanning_to_amazon_delivery_days,d.is_valid_data,d.delivery_date_basis,d.delivery_reason_tags
FROM freight.deliveries d JOIN freight.shipments s ON s.id=d.shipment_id;
ALTER VIEW freight.amazon_delivery_metrics OWNER TO freight_app;
COMMENT ON VIEW freight.amazon_delivery_metrics IS '亚马逊仓库送仓时效；排除 FBM 海外仓、快递、整柜、私人/商业地址及无效数据';

CREATE OR REPLACE VIEW freight.delivery_metrics AS
SELECT d.id, d.shipment_id, d.warehouse_code, d.warehouse_name,
       d.delivery_status, d.estimated_delivery_date, d.promised_delivery_date, d.actual_delivery_date,
       s.route_name, s.service_name, s.carrier_name, s.is_published,
       CASE WHEN s.record_status='active'
            AND d.delivery_status='delivered' AND NOT d.is_aggregate AND d.actual_delivery_date >= s.atd_date
            AND NOT freight.has_metric_issue(s.id,ARRAY['atd_date','actual_delivery_date'],d.id)
            THEN d.actual_delivery_date-s.atd_date END AS departure_to_delivery_days,
       CASE WHEN s.record_status='active'
            AND d.delivery_status='delivered' AND NOT d.is_aggregate AND d.actual_delivery_date >= s.devanned_date
            AND NOT freight.has_metric_issue(s.id,ARRAY['devanned_date','actual_delivery_date'],d.id)
            THEN d.actual_delivery_date-s.devanned_date END AS devanning_to_delivery_days,
       CASE WHEN s.record_status='active'
            AND d.delivery_status='delivered' AND NOT d.is_aggregate AND d.promised_delivery_date IS NOT NULL
            AND d.actual_delivery_date IS NOT NULL
            AND NOT freight.has_metric_issue(s.id,ARRAY['promised_delivery_date','actual_delivery_date'],d.id)
            THEN greatest(d.actual_delivery_date-d.promised_delivery_date,0) END AS late_days,
       d.delivery_scope, d.amazon_timing_eligible, d.completion_class,
       d.estimated_delivery_start_date, d.estimated_delivery_end_date,d.is_valid_data
FROM freight.deliveries d JOIN freight.shipments s ON s.id=d.shipment_id;

CREATE OR REPLACE VIEW freight.container_delivery_rollup AS
SELECT shipment_id,
 count(*) FILTER (WHERE NOT is_aggregate) AS destination_batches,
 count(*) FILTER (WHERE amazon_timing_eligible AND NOT is_aggregate) AS amazon_batches,
 min(estimated_delivery_date) FILTER (WHERE NOT is_aggregate AND NOT freight.has_metric_issue(shipment_id,ARRAY['estimated_delivery_date'],id)) AS first_estimated_delivery_date,
 max(estimated_delivery_date) FILTER (WHERE NOT is_aggregate AND NOT freight.has_metric_issue(shipment_id,ARRAY['estimated_delivery_date'],id)) AS last_estimated_delivery_date,
 min(actual_delivery_date) FILTER (WHERE NOT is_aggregate AND NOT freight.has_metric_issue(shipment_id,ARRAY['actual_delivery_date'],id)) AS first_actual_delivery_date,
 max(actual_delivery_date) FILTER (WHERE NOT is_aggregate AND NOT freight.has_metric_issue(shipment_id,ARRAY['actual_delivery_date'],id)) AS latest_actual_delivery_date,
 sum(appointment_change_count) FILTER (WHERE NOT is_aggregate) AS appointment_change_count
FROM freight.deliveries GROUP BY shipment_id;
COMMENT ON VIEW freight.container_delivery_rollup IS '仓库日期合并到柜子；latest_actual 不等同全柜送达，仍需完整清单确认';
ALTER VIEW freight.container_lifecycle OWNER TO freight_app;
ALTER VIEW freight.container_delivery_rollup OWNER TO freight_app;

CREATE OR REPLACE VIEW freight.valid_container_metrics AS
SELECT * FROM freight.container_lifecycle WHERE is_valid_data AND record_status='active';
CREATE OR REPLACE VIEW freight.valid_amazon_delivery_metrics AS
SELECT * FROM freight.amazon_delivery_metrics WHERE is_valid_data AND amazon_timing_eligible
 AND (departure_to_amazon_delivery_days IS NOT NULL OR devanning_to_amazon_delivery_days IS NOT NULL);
ALTER VIEW freight.valid_container_metrics OWNER TO freight_app;
ALTER VIEW freight.valid_amazon_delivery_metrics OWNER TO freight_app;
COMMENT ON VIEW freight.valid_amazon_delivery_metrics IS '展示系统专用，只返回有效亚马逊仓实际交仓样本；客户身份及发布权限仍由服务层控制';
COMMIT;

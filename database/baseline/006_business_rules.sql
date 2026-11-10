BEGIN;
ALTER TABLE freight.deliveries
 ADD COLUMN IF NOT EXISTS postal_code text,
 ADD COLUMN IF NOT EXISTS original_appointment_date date,
 ADD COLUMN IF NOT EXISTS appointment_history jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN IF NOT EXISTS appointment_change_count integer NOT NULL DEFAULT 0 CHECK (appointment_change_count>=0),
 ADD COLUMN IF NOT EXISTS appointment_net_shift_days integer,
 ADD COLUMN IF NOT EXISTS parent_delivery_id uuid REFERENCES freight.deliveries(id),
 ADD COLUMN IF NOT EXISTS is_aggregate boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN freight.deliveries.appointment_history IS '按原文顺序保留预约日期；不是改约发生时间，也不是实际送达';
COMMENT ON COLUMN freight.shipments.data_validity IS '存在无效字段标 invalid；有效字段仍可用于与其相关的指标，按 invalid_fields 逐字段过滤';
COMMENT ON COLUMN freight.deliveries.invalid_fields IS '无效字段保留原文/原值供人工补齐；仅影响使用该字段的指标';
CREATE OR REPLACE FUNCTION freight.has_metric_issue(p_shipment uuid, p_fields text[], p_delivery uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (SELECT 1 FROM freight.shipments WHERE id=p_shipment AND
  (invalid_fields && p_fields OR (data_validity='invalid' AND cardinality(invalid_fields)=0)))
 OR EXISTS (SELECT 1 FROM freight.deliveries WHERE id=p_delivery AND
  (is_aggregate OR invalid_fields && p_fields OR (data_validity='invalid' AND cardinality(invalid_fields)=0)))
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
 s.data_validity,s.invalid_fields
FROM freight.shipments s JOIN freight.shipment_summary summary ON summary.id=s.id;
CREATE OR REPLACE VIEW freight.container_lifecycle AS
SELECT m.*,CASE WHEN record_status='cancelled' THEN 'cancelled'
 WHEN lifecycle_completed_date IS NOT NULL THEN 'completed'
 WHEN picked_up_date IS NOT NULL AND NOT freight.has_metric_issue(id,ARRAY['picked_up_date']) THEN 'picked_up'
 WHEN ata_date IS NOT NULL AND NOT freight.has_metric_issue(id,ARRAY['ata_date']) THEN 'arrived'
 WHEN atd_date IS NOT NULL AND NOT freight.has_metric_issue(id,ARRAY['atd_date']) THEN 'departed'
 ELSE 'unknown' END AS lifecycle_status
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
            THEN d.actual_delivery_date-s.devanned_date END AS devanning_to_amazon_delivery_days
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
       d.estimated_delivery_start_date, d.estimated_delivery_end_date
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
COMMIT;

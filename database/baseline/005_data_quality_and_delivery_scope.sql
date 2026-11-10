-- Data quality flags and customer-facing warehouse timing scope.
BEGIN;
ALTER TABLE freight.shipments
  ADD COLUMN IF NOT EXISTS data_validity text NOT NULL DEFAULT 'valid'
    CHECK (data_validity IN ('valid','pending_review','invalid')),
  ADD COLUMN IF NOT EXISTS invalid_fields text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS validity_note text;
ALTER TABLE freight.deliveries
  ADD COLUMN IF NOT EXISTS estimated_delivery_start_date date,
  ADD COLUMN IF NOT EXISTS estimated_delivery_end_date date,
  ADD COLUMN IF NOT EXISTS delivery_scope text NOT NULL DEFAULT 'unknown'
    CHECK (delivery_scope IN ('amazon_warehouse','fbm_overseas','courier','full_container','private_commercial','unknown')),
  ADD COLUMN IF NOT EXISTS amazon_timing_eligible boolean,
  ADD COLUMN IF NOT EXISTS scope_reason text,
  ADD COLUMN IF NOT EXISTS completion_class text NOT NULL DEFAULT 'unknown'
    CHECK (completion_class IN ('unknown','delivered','courier_delivered','full_container_delivered')),
  ADD COLUMN IF NOT EXISTS data_validity text NOT NULL DEFAULT 'valid'
    CHECK (data_validity IN ('valid','pending_review','invalid')),
  ADD COLUMN IF NOT EXISTS invalid_fields text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS validity_note text;
COMMENT ON COLUMN freight.shipments.data_validity IS '整柜生命周期数据质量；invalid 不进入任何时效指标，pending_review 仅在相关字段指标中排除';
COMMENT ON COLUMN freight.deliveries.delivery_scope IS '亚马逊仓、FBM 海外仓、快递、整柜或私人/商业地址；Amazon 仓库时效只取 amazon_warehouse';
COMMENT ON COLUMN freight.deliveries.amazon_timing_eligible IS '是否计入亚马逊仓库送仓时效；NULL 表示目的地仍无法判断';
COMMENT ON COLUMN freight.deliveries.completion_class IS '完成事实分类；courier/full_container 不伪造实际送仓日期';

CREATE OR REPLACE VIEW freight.amazon_delivery_metrics AS
SELECT d.id, d.shipment_id, d.warehouse_code, d.warehouse_name,
       d.delivery_scope, d.amazon_timing_eligible, d.completion_class,
       d.estimated_delivery_date, d.estimated_delivery_start_date, d.estimated_delivery_end_date,
       d.actual_delivery_date, d.delivery_status, d.data_validity,
       s.route_name, s.service_name, s.carrier_name, s.is_published,
       CASE WHEN s.record_status='active' AND s.data_validity <> 'invalid'
                  AND d.data_validity <> 'invalid'
                  AND d.amazon_timing_eligible IS TRUE
                  AND d.delivery_status='delivered'
                  AND d.actual_delivery_date >= s.atd_date
                  AND NOT freight.has_metric_issue(s.id,ARRAY['atd_date','actual_delivery_date'],d.id)
            THEN d.actual_delivery_date-s.atd_date END AS departure_to_amazon_delivery_days,
       CASE WHEN s.record_status='active' AND s.data_validity <> 'invalid'
                  AND d.data_validity <> 'invalid'
                  AND d.amazon_timing_eligible IS TRUE
                  AND d.delivery_status='delivered'
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
       CASE WHEN s.record_status='active' AND s.data_validity <> 'invalid' AND d.data_validity <> 'invalid'
            AND d.delivery_status='delivered' AND d.actual_delivery_date >= s.atd_date
            AND NOT freight.has_metric_issue(s.id,ARRAY['atd_date','actual_delivery_date'],d.id)
            THEN d.actual_delivery_date-s.atd_date END AS departure_to_delivery_days,
       CASE WHEN s.record_status='active' AND s.data_validity <> 'invalid' AND d.data_validity <> 'invalid'
            AND d.delivery_status='delivered' AND d.actual_delivery_date >= s.devanned_date
            AND NOT freight.has_metric_issue(s.id,ARRAY['devanned_date','actual_delivery_date'],d.id)
            THEN d.actual_delivery_date-s.devanned_date END AS devanning_to_delivery_days,
       CASE WHEN s.record_status='active' AND s.data_validity <> 'invalid' AND d.data_validity <> 'invalid'
            AND d.delivery_status='delivered' AND d.promised_delivery_date IS NOT NULL
            AND d.actual_delivery_date IS NOT NULL
            AND NOT freight.has_metric_issue(s.id,ARRAY['promised_delivery_date','actual_delivery_date'],d.id)
            THEN greatest(d.actual_delivery_date-d.promised_delivery_date,0) END AS late_days,
       d.delivery_scope, d.amazon_timing_eligible, d.completion_class,
       d.estimated_delivery_start_date, d.estimated_delivery_end_date
FROM freight.deliveries d JOIN freight.shipments s ON s.id=d.shipment_id;
COMMIT;

BEGIN;
CREATE OR REPLACE FUNCTION freight.has_metric_issue(p_shipment uuid, p_fields text[], p_delivery uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM freight.review_issues q
    WHERE q.shipment_id=p_shipment AND q.status='open'
      AND (q.delivery_id IS NULL OR q.delivery_id=p_delivery)
      AND ((q.severity='error' AND q.affected_fields && p_fields)
        OR (q.issue_type='ambiguous_match' AND q.affected_metrics && p_fields))
  );
$$;

CREATE OR REPLACE VIEW freight.shipment_metrics AS
SELECT s.id, s.source_waybill_id, s.container_no, s.transport_mode, s.record_status,
       s.route_code, s.route_name, s.service_name, s.service_tier, s.carrier_name,
       s.atd_date, s.ata_date, s.picked_up_date, s.devanned_date, s.reported_delivery_date,
       summary.is_check, s.is_published,
       CASE WHEN s.record_status='active' AND s.transport_mode='sea'
            AND s.ata_date >= s.atd_date
            AND NOT freight.has_metric_issue(s.id,ARRAY['atd_date','ata_date'])
            THEN s.ata_date-s.atd_date END AS sea_days,
       CASE WHEN s.record_status='active' AND s.picked_up_date >= s.ata_date
            AND NOT freight.has_metric_issue(s.id,ARRAY['ata_date','picked_up_date'])
            THEN s.picked_up_date-s.ata_date END AS arrival_to_pickup_days,
       CASE WHEN s.record_status='active' AND s.devanned_date >= s.picked_up_date
            AND NOT freight.has_metric_issue(s.id,ARRAY['picked_up_date','devanned_date'])
            THEN s.devanned_date-s.picked_up_date END AS pickup_to_devanning_days
FROM freight.shipments s JOIN freight.shipment_summary summary ON summary.id=s.id;

CREATE OR REPLACE VIEW freight.delivery_metrics AS
SELECT d.id, d.shipment_id, d.warehouse_code, d.warehouse_name, d.delivery_status,
       d.estimated_delivery_date, d.promised_delivery_date, d.actual_delivery_date,
       s.route_name, s.service_name, s.carrier_name, s.is_published,
       CASE WHEN s.record_status='active' AND d.delivery_status='delivered'
            AND d.actual_delivery_date >= s.atd_date
            AND NOT freight.has_metric_issue(s.id,ARRAY['atd_date','actual_delivery_date'],d.id)
            THEN d.actual_delivery_date-s.atd_date END AS departure_to_delivery_days,
       CASE WHEN s.record_status='active' AND d.delivery_status='delivered'
            AND d.actual_delivery_date >= s.devanned_date
            AND NOT freight.has_metric_issue(s.id,ARRAY['devanned_date','actual_delivery_date'],d.id)
            THEN d.actual_delivery_date-s.devanned_date END AS devanning_to_delivery_days,
       CASE WHEN s.record_status='active' AND d.delivery_status='delivered'
            AND d.promised_delivery_date IS NOT NULL AND d.actual_delivery_date IS NOT NULL
            AND NOT freight.has_metric_issue(s.id,ARRAY['promised_delivery_date','actual_delivery_date'],d.id)
            THEN greatest(d.actual_delivery_date-d.promised_delivery_date,0) END AS late_days
FROM freight.deliveries d JOIN freight.shipments s ON s.id=d.shipment_id;
COMMENT ON VIEW freight.shipment_metrics IS '柜级实际时效；排除取消、相关日期矛盾；海运样本不被多仓明细重复加权';
COMMENT ON VIEW freight.delivery_metrics IS '批次实际时效；预计日期不填实际，缺承诺不算逾期；批次关系不明者排除相关指标';
COMMIT;

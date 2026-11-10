-- Company channel names are independent from carrier service codes.
BEGIN;
ALTER TABLE freight.shipments ADD COLUMN IF NOT EXISTS channel_name text;
COMMENT ON COLUMN freight.shipments.channel_name IS '公司渠道名；按确认的船司、起运港和目的地规则归类；与具体航线service_name分别存储；依据不足为空';
CREATE INDEX IF NOT EXISTS shipments_channel_departure_idx ON freight.shipments (channel_name, atd_date);
DO $channel_views$
DECLARE v record; definition text; view_oid regclass;
BEGIN
 FOR v IN SELECT * FROM (VALUES ('shipment_summary','id'),('shipment_transport_info','id'),('shipment_metrics','id'),('container_lifecycle','id'),('valid_container_metrics','id'),('delivery_metrics','shipment_id'),('amazon_delivery_metrics','shipment_id'),('valid_amazon_delivery_metrics','shipment_id')) AS target(name,join_key) LOOP
  view_oid := ('freight.' || v.name)::regclass;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=view_oid AND attname='channel_name' AND NOT attisdropped) THEN
   definition := regexp_replace(pg_get_viewdef(view_oid,true),'[;[:space:]]+$','');
   EXECUTE format('CREATE OR REPLACE VIEW freight.%I AS SELECT q.*, s.channel_name FROM (%s) q JOIN freight.shipments s ON s.id=q.%I',v.name,definition,v.join_key);
  END IF;
 END LOOP;
END $channel_views$;
COMMIT;

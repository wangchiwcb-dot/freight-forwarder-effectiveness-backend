-- Explicit deployment only. Set the password separately; never store credentials here.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='freight_admin_api') THEN
  CREATE ROLE freight_admin_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
 END IF;
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO freight_admin_api',current_database());
END $$;
ALTER ROLE freight_admin_api SET statement_timeout='30s';
ALTER ROLE freight_admin_api SET idle_in_transaction_session_timeout='30s';
GRANT USAGE ON SCHEMA freight,freight_admin TO freight_admin_api;
GRANT SELECT ON ALL TABLES IN SCHEMA freight_admin TO freight_admin_api;
GRANT SELECT,INSERT,UPDATE ON freight_admin.routes,freight_admin.warehouses,freight_admin.containers,
 freight_admin.deliveries,freight_admin.inspections TO freight_admin_api;
GRANT INSERT ON freight_admin.audit_logs TO freight_admin_api;
GRANT SELECT ON freight.shipments,freight.deliveries,freight.shipment_exceptions,
 freight.field_observations,freight.review_issues,freight.source_records,freight.import_runs,
 freight.valid_container_metrics,freight.valid_amazon_delivery_metrics,freight.container_lifecycle,freight.amazon_delivery_metrics TO freight_admin_api;
GRANT INSERT ON freight.shipments,freight.deliveries,freight.shipment_exceptions,
 freight.field_observations,freight.source_records,freight.import_runs,freight.audit_logs TO freight_admin_api;
GRANT UPDATE(container_no,waybill_no,channel_name,service_name,carrier_name,vessel_name,voyage_no,
 origin_port_name,destination_port_name,etd_date,eta_date,atd_date,ata_date,discharged_date,
 available_for_pickup_date,picked_up_date,devanned_date,inspection_assessment,inspection_basis,
 delivery_manifest_status,manifest_confirmed_by,manifest_confirmed_at,notes_internal,record_status,
 is_published,published_by,published_at,updated_at) ON freight.shipments TO freight_admin_api;
GRANT UPDATE(warehouse_code,warehouse_name,estimated_delivery_date,actual_delivery_date,delivery_status,
 notes_internal,updated_at) ON freight.deliveries TO freight_admin_api;
GRANT UPDATE(confirmation_status,status,started_date,resolved_date,reason_code,description,confirmed_by,
 confirmed_at,updated_at) ON freight.shipment_exceptions TO freight_admin_api;
GRANT UPDATE(is_selected,manual_lock) ON freight.field_observations TO freight_admin_api;
GRANT EXECUTE ON FUNCTION freight.has_metric_issue(uuid,text[],uuid),freight_admin.shipment_visible(uuid),
 freight_admin.delivery_visible(uuid) TO freight_admin_api;
COMMIT;

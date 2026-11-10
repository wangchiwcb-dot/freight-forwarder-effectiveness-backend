-- Run only during an explicitly approved deployment, as a database administrator.
-- No credential is stored here. Set a password separately using psql's \password.
-- This file does not publish any shipment or mutate business data.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freight_public_api') THEN
    CREATE ROLE freight_public_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO freight_public_api', current_database());
END $$;
ALTER ROLE freight_public_api SET default_transaction_read_only = on;
ALTER ROLE freight_public_api SET statement_timeout = '10s';
GRANT USAGE ON SCHEMA freight TO freight_public_api;
GRANT SELECT ON freight.valid_container_metrics, freight.valid_amazon_delivery_metrics TO freight_public_api;
GRANT SELECT (id, source_tenant, is_published, record_status, transport_mode, atd_date,
  ata_date, picked_up_date, devanned_date, container_no, service_name, carrier_name,
  channel_name, origin_port_name, destination_port_name, is_valid_data, invalid_fields, data_validity)
  ON freight.shipments TO freight_public_api;
GRANT SELECT (id, is_valid_data, is_aggregate, invalid_fields, data_validity)
  ON freight.deliveries TO freight_public_api;
GRANT SELECT (shipment_id, delivery_id, status, severity, affected_fields, issue_type, affected_metrics)
  ON freight.review_issues TO freight_public_api;
GRANT EXECUTE ON FUNCTION freight.has_metric_issue(uuid, text[], uuid) TO freight_public_api;
COMMIT;

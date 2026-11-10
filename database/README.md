# Management database integration

`baseline/` contains the existing source schema history for isolated tests. It is **not** a production initialization or re-import procedure.

`009_admin.sql` is the explicit additive production migration. It requires the existing `freight` schema through migration 008 and a verified database backup. The application never applies migrations on startup. The migration refuses a second application instead of reseeding management records.

The migration adds `freight_admin` dictionaries and per-record extensions. Existing shipment, delivery, exception, source, observation, and audit rows are unchanged. Existing publication flags and vetted public metric membership remain unchanged: imported dictionary and batch gates initially permit the already-published data, while newly-created records are unpublished. Missing source quantities, dates, route names, container types, and inspection dates stay unknown.

The existing public application's `freight.valid_container_metrics` and `freight.valid_amazon_delivery_metrics` views retain their columns and quality filters, with additional shipment/route/warehouse/batch gates. This is effective for the existing public SQL adapter without exposing management tables. The functions use a fixed search path and return only a visibility boolean. `admin_role.sql` creates the separate management login and grants only required writes; set its password separately.

An existing delivery-date constraint is narrowed to permit cancelled deliveries to retain their known actual delivery date. This enables soft archive without deleting source evidence or erasing dates. Container and batch removal sets cancellation / management archive state; original rows remain. Referenced dictionary records remain protected even when their referring records have been archived.

## Write and provenance contract

- Each production mutation runs in one PostgreSQL transaction and carries the authenticated actor. Source updates invalidate editor versions, including changes from outside this application.
- Explicit field corrections require a reason. Only changed mapped source columns are updated. Existing transport modes, cancellation flags, validity flags, unresolved reviews, aggregate/duplicate classifications, and source identifiers are retained.
- The editor's `referenceNo` displays the waybill number (with a display-only fallback). Changing it changes `waybill_no`; original `reference_no` is returned separately as read-only `sourceReferenceNo`. An unrelated save never writes a fallback into either source field.
- Corrected fields append a manual import/source record, SHA-256 payload, selected observation with a manual lock, and before/after audit evidence. Superseded selections are deselected without modifying the original source payload. An explicit clear is represented by JSON null in the selected observation and preserved in the audit.
- Inspection observations are namespaced by exception ID so multiple inspections cannot overwrite each other's selected provenance. Candidate, rejected and non-inspection exceptions remain outside the managed list and are not removed by a save.
- Only explicitly confirmed Amazon nonaggregate batches are managed. Other destination, aggregate and unidentified source batches remain untouched. Same-container / same-warehouse batches are independent by immutable delivery ID.
- Changing a dictionary's mapped business fields updates its linked source fields and versions with correction evidence. Turning a display gate off changes effective public visibility without changing source quality.
- Fixing a historical invalid date does not automatically clear validity flags or resolve review issues. A separate explicit quality-review workflow is required before those records can become valid public samples.

Future import/synchronization work must honor manual locks, register new source records in these dictionaries/extensions, and respect default-unpublished behavior. The migration is not an incremental synchronizer.

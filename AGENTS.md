# Management application

## Scope and authorization

- Independent repository: https://github.com/wangchiwcb-dot/freight-forwarder-effectiveness-backend.
- User authorized production PostgreSQL integration and deployment on the existing Alibaba Cloud server at `effective.omfreight.vip` on 2026-11-10. This is the current scope; the first local-only prototype restriction is superseded.
- React + TypeScript + Ant Design components, with Tailwind CSS and shared layout tokens. Keep the separate public application at `transit.omfreight.vip` compatible.
- Production requires authenticated administrator access, HTTPS, loopback application/database listeners, and a dedicated restricted database role. Do not expose credentials in logs, Git, client code, or process command arguments.
- Keep demo and production modes explicit. Demo uses synthetic local SQLite data; production uses PostgreSQL and must fail on missing configuration or connection rather than falling back to demo data.

## Business data

- Each shipment is a separate transport identity; container number is not unique. Keep original source identifiers and `waybill_no` distinct from `reference_no`. The editor's fallback label is not permission to write a fabricated identifier.
- Container and carrier-route timing ends at devanning. Amazon timing ends at actual delivery of each independent batch. Same-container / same-warehouse multiple batches are valid. Company channel and carrier route stay separate.
- Unknown dates, quantities, estimated timing and other source fields stay null/unknown. Never substitute estimated dates for actual dates or infer an inspection is open solely because its end date is missing.
- Preserve multiple inspection records and their unknown/open/resolved status, including resolved inspections with unknown dates. Do not modify candidate, rejected or unrelated source exceptions during ordinary edits.
- Newly created entities and batches are unpublished. Effective public visibility requires all applicable parent/child, enabled, quality, mode and cancellation conditions; publication never makes invalid records valid.
- Production writes update only explicitly changed mapped fields. Preserve unmapped source fields, quality/scope/aggregate/duplicate flags, cancelled/rail statuses, evidence, and historical publication metadata. Unchanged historical text must not be normalized by an unrelated edit.
- Manual business corrections require an actor and reason. Append manual source evidence, selected observations / locks, and before/after audit in the same transaction. Do not overwrite original source payloads or resolve review issues implicitly.
- Production deletes soft-archive/cancel business records and retain their dates and evidence. Referenced dictionary records cannot be deleted, including historical references. Validate tenant and child-record ownership and reject stale versions.

## Migrations and verification

- Runtime never applies migrations or seeds PostgreSQL. `database/009_admin.sql` is an explicitly reviewed migration; `database/admin_role.sql` supplies restricted privileges. `database/baseline/` exists only for isolated schema tests and must not be replayed against production.
- Back up and restore-test before database migration. Compare stable original-column checksums, row counts, publication flags, and public metric membership before and after. Keep private baseline artifacts out of Git.
- The valid public views retain their existing columns and quality filters while adding route/warehouse/batch visibility gates. Verify public role access and public statistics after changes.
- Use isolated staging for CRUD smoke tests. Never run write smoke fixtures against production; the smoke tool requires an isolation flag and loopback URL. Production verification is authenticated read-only.
- Run typecheck, meaningful API/auth/repository tests, production build and browser checks appropriate to the change. Use the real baseline schemas and restricted roles in repository tests.
- Follow `README.md` for release, environment locations and rollback. Stop the admin service first when rollback is needed; preserve source data and audit. View/schema rollback requires a separate reviewed plan because public gates may already have changed.
- Future source ingestion must register management links and honor manual locks. The initial migration is not an incremental synchronizer.

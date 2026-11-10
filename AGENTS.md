# Management application

- React + TypeScript + Ant Design components; Tailwind CSS and shared tokens for consistent layout.
- Independent repository for https://github.com/wangchiwcb-dot/freight-forwarder-effectiveness-backend.
- Local demo data must be visibly labeled. Never connect production credentials or modify the existing public application/database as part of this initial implementation.
- Container lifecycle ends at devanning. Amazon delivery batches are independent, including multiple batches to the same warehouse. Company channel and carrier route remain distinct.
- Newly created records are unpublished. Parent and child publication gates all apply. Visibility is separate from valid timing metrics.
- Preserve multiple inspections with start and end dates, unknown dates remain null, reject reversed actual date order. Never substitute estimated dates for actual dates.
- Keep an append-only audit log, transactionally update local SQLite data, reject stale revisions, and protect referenced dictionaries from deletion.
- Run build, meaningful API tests, and browser CRUD checks before delivery. Start and show the local preview.
- Production authentication, database migration/adapter, and public frontend integration are separate follow-up work. Do not imply local switches change transit.omfreight.vip.

# Multi-tenant Data Feeding Guide

## Why you see "details are not available"
That response appears when tenant retrieval returns no usable knowledge context.
Most common causes:
1. `knowledge_chunks` table is missing.
2. `match_knowledge_chunks` RPC is missing.
3. Tenant has zero ingested chunks.
4. Embedding model changed but tenant data was not re-ingested.

## 1) Run database schema
Execute `backend/supabase/schema.sql` in Supabase SQL editor.

## 2) Verify backend DB health
```bash
cd backend
npm run doctor
```
Expected: all tables + RPC show `OK`.

## 3) Add/update a tenant
```bash
cd backend
npm run tenant:add -- \
  --tenant_id=starluxtravels \
  --name="Starlux Travels" \
  --domains=localhost,127.0.0.1,starluxtravels.com,www.starluxtravels.com
```

## 4) Ingest website knowledge for tenant
```bash
cd backend
npm run ingest -- \
  --tenant_id=starluxtravels \
  --urls=https://starluxtravels.com/faq,https://starluxtravels.com/refund \
  --replace=true
```

You can also use sitemap:
```bash
npm run ingest -- --tenant_id=starluxtravels --sitemap=https://starluxtravels.com/sitemap.xml --replace=true
```

## 5) Multi-website pattern
- One tenant per website/customer.
- For each website:
  1. Add tenant row with `allowed_domains`.
  2. Run ingest with that tenant id.
  3. Set frontend `VITE_TENANT_ID` (or map host -> tenant in widget config).

## Open-source mode
Yes. This stack is suitable as open-source multi-tenant chatbot infrastructure.
Recommended packaging:
1. Keep current backend/frontend as reference app.
2. Expose a tenant onboarding page or admin API.
3. Add worker/queue for scheduled re-ingestion.
4. Add simple billing/auth if offering hosted SaaS.

# API Contract Migration Plan

## Goal

Move `optcg-api` from a manually maintained docs inventory to a schema-driven API contract that is:

- explicit for every request and response
- published by the API at stable docs endpoints
- safe to evolve before external clients exist
- strict enough to reduce drift between code, docs, and behavior
- limited to the public API surface exposed under `/health` and `/v1/*`

## Current State

- `/openapi.json` and `/docs` exist on the `api-self-docs` branch.
- Those docs now publish only the public API surface.
- Public route coverage is being migrated to Fastify `schema` objects.
- Public naming is still flexible because there are not yet external clients to preserve.

## Principles

1. Define the contract before encoding it in schemas.
2. Rename public API fields and params now if they are unclear.
3. Keep docs paths stable: `/openapi.json` and `/docs`.
4. Migrate incrementally, starting with low-risk routes.
5. Do not silently change behavior while adding schemas.
6. Freeze naming and shapes once generated docs become the source of truth.

## Phase 1: Contract Definition

Define the concrete contract for each endpoint before implementation:

- path params
- query params
- request body
- success response
- error response
- required vs optional fields
- nullability
- enums
- naming conventions

Deliverables:

- endpoint-by-endpoint contract matrix
- naming rules for paths, params, JSON fields, and schema ids
- list of public renames to make before schema generation

## Phase 2: Shared Schema Primitives

Create reusable schema helpers for:

- `OkEnvelope`
- `ErrorEnvelope`
- `Pagination`
- common path/query params
- auth header / bearer auth
- reusable primitives like ids, timestamps, card numbers, set codes, format names

Deliverables:

- shared schema module(s)
- consistent component naming

## Phase 3: Migrate Simple Public Routes

Start with low-risk public endpoints:

- `/health`
- `/v1/formats`
- `/v1/formats/:format_name`
- `/v1/sets`
- `/v1/sets/:set_code`
- `/v1/prices/:card_number`
- `/v1/don`
- `/v1/don/:id`
- `/v1/random`

Deliverables:

- Fastify schemas on these routes
- generated docs coverage for these endpoints
- validation behavior verified against current handlers

## Phase 4: Generate OpenAPI From Route Schemas

Replace manual contract generation with generated OpenAPI while keeping the public docs endpoints unchanged.

Deliverables:

- `/openapi.json` generated from registered schemas
- `/docs` rendered from generated OpenAPI
- manual `src/apiDocs.ts` retained only as long as needed during overlap

## Phase 5: Admin Validation Cleanup

Next routes:

- `/admin/login`
- `/admin/formats`
- `/admin/formats/:name/bans`
- `/admin/formats/:name/blocks`
- `/admin/stats`
- `/admin/scraper/status`
- `/admin/scraper/logs`
- `/admin/watcher/topics`
- `/admin/prices/run`

Deliverables:

- schema coverage for these endpoints where it improves validation or maintainability
- auth handled consistently in code
- admin request/response shapes made explicit
- no admin endpoints published in `/openapi.json` or `/docs`

## Phase 6: Migrate Complex Routes

Save the highest-complexity routes for last:

- `/v1/cards`
- `/v1/cards/autocomplete`
- `/v1/cards/:card_number`
- `/admin/cards*`
- scan ingestion routes

These need more careful work because they have:

- large nested responses
- partial update payloads
- looser current behavior
- more risk of accidental validation tightening

## Phase 7: Remove Temporary Manual Docs Layer

Only remove the manual docs inventory after generated OpenAPI covers the intended published surface.

Exit criteria:

- `/openapi.json` is generated from route schemas
- `/docs` is generated from the same document
- intended public endpoints are covered
- tests verify docs presence for migrated routes
- manual route inventory is no longer needed

## Naming Decisions To Make Early

Questions to resolve before heavy schema work:

- Should all public JSON fields remain `snake_case`?
- Are any current query params ambiguous and worth renaming now?
- Are any path params too vague, like generic `name` or `id`?
- Do we want stricter distinctions such as `format_name` vs `format_id`?
- Which admin payload fields should be normalized before clients exist?

## Card Identity Rule

The working rule for cards should be:

- a canonical card record is identified by `card_number + language`
- the same `card_number` across different languages is expected and valid
- print variants, alt arts, reprints, promos, SPs, and product-specific differences should remain attached to that localized card record as images / printings / sources
- we should avoid multiple card rows for the same `card_number + language` unless we intentionally redefine the model

Implications:

- public and admin card detail endpoints should be treated as looking up a localized card
- schema and docs work should reflect `language` as part of card identity
- future cleanup should distinguish clearly between a localized card record and its print variants

## Card Endpoint Contract Changes

Most public endpoints can keep their current shape.

The main contract work is in:

- `GET /v1/cards`
- `GET /v1/cards/:card_number`

### `GET /v1/cards`

Keep the current behavior, but document it explicitly:

- `unique=cards` returns card-level results
- `unique=prints` returns variant-level results
- this endpoint intentionally supports two result modes
- both modes must continue to expose the current summary media and market fields used by clients

Search response fields that must be preserved in the contract:

- `image_url`
- `thumbnail_url`
- `scan_url`
- `scan_thumb_url`
- `tcgplayer_url`
- `market_price`
- `low_price`
- `mid_price`
- `high_price`

We should make those two result shapes explicit in the eventual schemas and docs rather than pretending the array has one universal item type.

### `GET /v1/cards/:card_number`

Planned contract cleanup:

- rename `images` to `variants`
- treat each entry as a structured variant record, not just an image
- keep `variant_index` as the per-card variant identifier
- include `is_default` in the response
- group variant data around:
  - variant identity / display metadata
  - product metadata
  - media URLs
  - market / price data

Likely naming fixes:

- `images` -> `variants`
- `scan_thumb_url` -> `scan_thumbnail_url`

Proposed variant shape:

- `variant_index`
- `label`
- `is_default`
- `artist`
- `product`
- `media`
- `market`

### Variant Ordering Rule

The current variant ordering should be changed and then documented explicitly.

Desired order:

1. product release date
2. label priority
3. `variant_index`

This should replace the current behavior that prioritizes label before release chronology.

## Verification

For each migration slice:

- `npm run build`
- route-level tests for new schema-backed docs coverage
- spot checks that validation matches intended current behavior
- explicit review of any public shape changes

## Current Slice

Work already started on this branch:

- shared schema helpers exist under `src/schemas/`
- published docs now intentionally exclude `/admin/*`
- simple public route schemas have been added for:
  - `/health`
  - `/v1/formats`
  - `/v1/formats/:format_name`
  - `/v1/sets`
  - `/v1/sets/:set_code`
  - `/v1/prices/:card_number`
  - `/v1/don`
  - `/v1/don/:id`
  - `/v1/random`
- `/openapi.json` is now generated from registered Fastify route schemas for the migrated routes
- `/docs` now renders from the generated OpenAPI document instead of the old manual route inventory
- public card route schemas now exist for:
  - `/v1/cards`
  - `/v1/cards/autocomplete`
  - `/v1/cards/:card_number`
- `/v1/cards` summary responses now preserve scan and market summary fields in both search modes
- `/v1/cards/:card_number` now exposes `variants` instead of `images`
- card variants are now ordered by release date, then label priority, then `variant_index`
- focused regression checks exist for docs and card summary contract

## Working Checklist

- [ ] Create endpoint contract matrix for public routes
- [ ] Create naming rules for the API contract
- [ ] Decide public renames before clients exist
- [x] Add shared schema primitives
- [x] Add schemas to simple public routes
- [x] Generate `/openapi.json` from route schemas
- [x] Generate `/docs` from the generated OpenAPI
- [x] Add schemas to complex public card routes
- [ ] Add schemas to simple admin routes
- [ ] Add schemas to complex admin and scan routes
- [ ] Remove `src/apiDocs.ts`

## Notes

- The format block legality change already established a useful precedent: derive semantics from authoritative server-side logic, then document that contract explicitly.
- During schema rollout, avoid mixing in unrelated behavior changes unless they are part of the contract cleanup itself.

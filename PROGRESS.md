# PROGRESS.md — Steth_web_backend

## Session: Part A — Critical security & correctness fixes (2026-07-23)

All six Part A findings from `stethset-unified-master-plan.md` are fixed and committed, one commit per item (`git log` has them in order: A1 → A6). No pushing done.

### A1 — `updateAccount` hardcoded user + no auth — DONE
- `updateAccount()` now reads the target user from `req.user._id` instead of a hardcoded `_id` literal.
- `PUT /update-account` now requires `auth`.
- Verified by static/manual trace only (see "Verification gap" below) — the route-guard change and the `req.user._id` substitution are both single-line, low-risk changes matching the exact pattern already used correctly elsewhere (`profileAccess`, `changePass`).

### A2 — Product write routes had no auth/isAdmin — DONE
- Added `auth, isAdmin` to all 6 routes named in the plan: `POST /`, `PUT /:id`, `DELETE /:id`, both image-upload routes, `POST /:id/inventory`.

### A3 — Order admin routes had no auth/isAdmin — DONE
- Added `auth, isAdmin` to `GET /all` and `PUT /update-status/:orderId`.

### A4 — Cancel-order route commented out — DONE (plus a necessary bugfix)
- Uncommented `POST /cancel/:orderId`.
- Found and fixed a bug that would have made the route non-functional even uncommented: `cancelOrder()` read/wrote `order.status`, but the schema field is `orderStatus` — the eligibility check always saw `undefined` (so every cancel attempt would have 400'd) and the cancellation write silently no-opped under Mongoose strict mode. Fixed both references to `orderStatus`.
- Also guarded the ownership check against guest orders (`order.user` can be `null`), which previously threw an unhandled `TypeError` on a guest order instead of a clean 403.

### A5 — CORS wide open — FLAGGED, NOT FIXED (by design, per instruction)
**Decision:** left `app.use(cors())` behavior unchanged. The admin panel (`Steth_admin_Panel`) still calls this API cross-origin from its own separate Vercel deployment — confirmed via grep, ~15+ page files do direct client-side `fetch()` to `https://steth-backend.onrender.com` (e.g. `app/orders/[id]/update-status`, `app/product-management/**`, `app/color-tiles`, `app/hero-images`). Locking CORS down now would break the admin panel in production. This is explicitly deferred to Part D step 2 (merging the admin panel onto one origin).
Added a TODO comment above `app.use(cors())` in `server.js` referencing this plan section and listing what the eventual allowlist needs:
- `Steth_web_frontend`'s production Vercel origin
- `Steth_admin_Panel`'s production Vercel origin — **exact domain not confirmed**, no `.env`/`vercel.json` found checked into either repo. Get this from the user or the Vercel dashboard before implementing the real allowlist.
- Local dev origins (Vite `:5173`, Next `:3000`)

### A6 — Registration never sent/enforced OTP; login never checked isVerified — DONE, with an important caveat
- `registerUser()` now calls the already-imported `sendOtp()` after creating the account (best-effort — logs and continues if the email provider fails, matching the existing best-effort email pattern in `order.controller.js`).
- New endpoint `POST /verify-registration-otp` (new controller function `verifyRegistrationOtp`) checks the OTP and flips `isVerified` to `true`. Kept separate from the existing `/verify-otp`, which is already wired specifically to the password-reset flow in the frontend (`OTP.jsx` expects a `resetToken` back and navigates to `/password-recovery`) — reusing it would have collided with that.
- `loginUser()` now returns `403` with a clear message when `isVerified` is `false`.
- `googleAuthUser()` now sets `isVerified: true` on new Google-authenticated accounts, since they never go through OTP.
- **Migration script added but NOT successfully run:** `src/scripts/backfillIsVerified.js` sets `isVerified: true` for every user that existed before this change (grandfathering — decided with the user rather than locking out every existing local-signup customer). Running it failed in this sandbox with `MongooseServerSelectionError` — TLS handshake to the Atlas cluster fails here (see caveat below). **This must be run successfully — from the user's own machine, from Render, or from wherever the real Mongo connection works — before this reaches an environment where a user with a pre-existing local account would try to log in, or they'll be locked out with no self-serve fix except the `/password-forgot` flow (which also flips `isVerified` true as a side effect).**

## Verification gap — read before assuming these are battle-tested

Per this session's explicit instructions, I was asked to prove each fix with a real request/response, not just claim correctness from reading the diff. I was **not able to do that here**, and want to be upfront about exactly what that means:

- This sandbox could not successfully boot `npm run dev` in a practical amount of time — Node's module resolution across this project's ~700-package `node_modules` tree took many minutes per attempt (I/O-bound, not compute-bound — confirmed via `ps`/`sample`). Even a minimal test harness pulling in only `express` + `jsonwebtoken` + the modified auth middleware didn't bind to a port within 60+ seconds.
- Separately and independently, outbound TLS connections from this sandbox to the MongoDB Atlas cluster (`cluster-steth.mjrsjl5.mongodb.net`) fail during the TLS handshake (`SSL alert 80 / internal error`), even though raw TCP to the same host:port connects fine and normal HTTPS traffic (e.g. to the Brevo email API) works normally. This is a sandbox network-egress characteristic, not a code issue — it means no live database-backed request could succeed here regardless of server-boot time.

What I did instead: syntax-checked every changed file (`node --check`, all clean), and manually traced every changed code path line-by-line against the actual schema/middleware/existing-working-endpoint behavior (documented per-item above and in the session's plan file). That's real verification, but it is **not the same as the live 401/403/200 proof that was asked for**.

**If you want that live proof**, run these yourself in a normal terminal (not this sandbox) after `npm run dev`:
```bash
# A1/A2/A3 — no token should 401 on all of these:
curl -i -X PUT  http://localhost:5000/api/users/update-account
curl -i -X POST http://localhost:5000/api/products
curl -i -X PUT  http://localhost:5000/api/products/000000000000000000000000
curl -i -X DELETE http://localhost:5000/api/products/000000000000000000000000
curl -i -X POST http://localhost:5000/api/products/000000000000000000000000/inventory
curl -i -X GET  http://localhost:5000/api/orders/all
curl -i -X PUT  http://localhost:5000/api/orders/update-status/000000000000000000000000

# A6 — register, then try logging in before verifying (expect 403):
curl -i -X POST http://localhost:5000/api/users/register -H "Content-Type: application/json" \
  -d '{"username":"test_a6","email":"you@example.com","password":"Test123!"}'
curl -i -X POST http://localhost:5000/api/users/login -H "Content-Type: application/json" \
  -d '{"usernameOrEmail":"test_a6","password":"Test123!"}'
# then check the OTP emailed to you, verify, and log in again (expect 200):
curl -i -X POST http://localhost:5000/api/users/verify-registration-otp -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","otp":"<code from email>"}'
```
And run `node src/scripts/backfillIsVerified.js` once before relying on the login gate against real existing users.

## What's left / next session
Per Part D: step 2 — Issue #1 (merge admin panel) + B.2 (RBAC), the natural point to also revisit A5's CORS lockdown and the `req.user.isAdmin` dead-code check in `cancelOrder`.

## Related-but-out-of-scope findings (flagged, not fixed in that session)
- `profileAccessAdmin` (`user.controller.js`, routed unauthenticated at `GET /profile-admin`) has the same hardcoded-id pattern as A1's bug but wasn't named in A1's scope. **Fixed in the next session below.**
- `product.routes.js`'s `PATCH /:id/images/color/:color/:imageId/primary` and `GET /fix-product/:id` are also unguarded mutating/admin-ish routes, not among A2's 6 named routes. **Fixed in the next session below.**
- `cancelOrder`'s `req.user.isAdmin` check is dead code (no such field on `User`, only `role`) — doesn't block A4's required behavior, but worth folding into B.2's real RBAC work. **Still not fixed** (only `getOrderById` had the same bug fixed, see below — `cancelOrder` itself wasn't touched again this session).

---

## Session: Issue #1 (admin panel merge) + Part B.2 (RBAC) (2026-07-23, same day)

Spans all three repos. This repo's half: real RBAC middleware + guards on every admin-facing route the migrated admin screens touch, plus two small supporting pieces (JWT `role` claim, image-proxy route). Commits in order (`git log`, oldest first):

1. **RBAC foundation** — `src/middlewares/auth.middleware.js`: `isAdmin` refactored into a generic `authorize(...allowedRoles)` factory; `isAdmin` is now `authorize('admin')`, a backward-compatible alias, so no existing route needed to change. `src/models/user.model.js`: `role` enum gained `warehouse_manager` and `marketer` (no screen actually needs them yet — see decision below). `user.controller.js`: `role` added to the signed JWT payload in both `loginUser` and `googleAuthUser` (previously only `id`/`username`/`email` — `googleAuthUser` didn't return `role` in its response at all, meaning admin login via Google was silently dead code in the frontend).
2. **Groups A–G** — guarded every admin-facing route the migration's 19 screens actually call, plus a few severe ones that aren't called by any screen but were cheap to close while touching sibling files:
   - A: all 4 `dashboard.routes.js` routes.
   - B: `studentVerification.routes.js` `/pending`, `/:id/approve`, `/:id/reject`.
   - C: `user.routes.js` `GET /profile-admin`, `POST /upload-pic` — bundled fix: `profileAccessAdmin`/`uploadPicture` had the same hardcoded-`_id` bug as A1, now read `req.user._id`.
   - D: `product.routes.js` customers-also-bought add/remove, the primary-image-set PATCH, `fix-product` GET (the last two aren't called by any migrated screen but are clearly admin-only, no plausible anonymous caller).
   - E: `heroImageRoutes.js`/`colorTileRoutes.js` POST/DELETE (GETs stay public, storefront depends on them).
   - F: `subscriberRoutes.js` `POST /send-bulk-email` — the single worst gap in the whole audit, anyone could mass-email every subscriber.
   - G: `testEmail.routes.js` (all 3 routes) — a leftover unauthenticated debug tool sending real email via production SMTP to a hardcoded personal address; not called by any screen but gated anyway given the severity.
3. **New `GET /api/image-proxy?url=...`** (`src/routes/imageProxy.routes.js` + controller) — the Student Approval screen needs to display a proof-of-enrollment image without a CORS failure. Unlike the Next.js original (which proxied *any* URL — an open proxy), this is restricted to `ik.imagekit.io` only and gated `auth, isAdmin` (student PII).
4. **`getOrderById` fix** — found while wiring the Orders update-status screen to use this single-order endpoint (see the frontend's PROGRESS.md for why). Same bug class as `cancelOrder`'s A4 fix, not caught last session because A4 only asked about `cancelOrder`: checked `req.user.isAdmin` (doesn't exist, only `role`), so an admin viewing any order that wasn't their own got a 403. Now checks `req.user.role !== 'admin'`, plus a null-safe guard for guest orders.

**Decision, `PUT /:id/related` never got built:** the plan initially called for a new backend route so the frontend's "customers also bought" edit screen could save related products. Found that the existing, already-guarded `PUT /api/products/:id` has a generic "apply all other fields" pass that already accepts a `relatedProducts` array in the body — a dedicated route would have just duplicated that. Fixed at the frontend layer instead (point the ported screen at the existing endpoint).

**Not touched this session:** A5 (CORS) — still exactly as left last session, still correctly deferred (see above). `cancelOrder`'s own dead `isAdmin` check — only `getOrderById`'s copy of the same bug got fixed, since that's the one actually blocking a screen being built this session; `cancelOrder`'s copy remains for a future pass. `warehouse_manager`/`marketer` roles exist in the enum per explicit instruction, but no route or screen distinguishes them from `admin` yet — none of the 19 migrated screens map to a warehouse-only or marketing-only resource today.

Verification: `node --check` on every changed file (clean). Live HTTP verification wasn't attempted again this session — the sandbox limitations documented above for the last session apply identically; no new investigation was done to see if they'd changed.

---

## Session: Part B.1 — data model + admin CRUD for Fabric/Category/Color/Product/Inventory/Vendor/Shipment (2026-07-23)

Additive throughout, per the plan reviewed and approved before any code was written (`~/.claude/plans/buzzing-cooking-pretzel.md`) — every new field is optional, every existing field on `Product` is untouched, no existing document needs to change for the app to keep working. Commits in order (`git log`, oldest first): models → Fabric/Category/Vendor CRUD → Color CRUD → Product schema extension → Shipment receive logic → route mounting → gender-check script → variant image upload endpoint.

### New entities
- `src/models/fabric.model.js`, `category.model.js`, `color.model.js`, `vendor.model.js`, `shipment.model.js` — all new, all `.model.js`-suffixed per this repo's convention for new entities.
- `Fabric.composition` has a `pre('validate')` hook enforcing the array sums to 100% (within float tolerance) whenever non-empty — the real safety net behind the frontend's running-total builder.
- Fabric/Category CRUD (`auth, isAdmin` on writes, public GETs) and Color CRUD (same, plus ImageKit title-image upload via the shared `upload.middleware.js` + `imageKitUpload.js` pattern, not a new multer config). **Vendor is gated differently**: every route including GETs requires `auth, authorize('admin', 'warehouse_manager')` — contact info is internal-only, and this is the first real call site for the multi-role `authorize()` factory built in the RBAC session.

### `Product` extensions — all additive
Added `fabric` (ref Fabric), `categoryRef` (ref Category, alongside the untouched `category` string), `colorRefs` (ref Color[], alongside the untouched `colors` array), `attributes` ([{name, iconUrl}]), `variants` ([{color, gender, images}] for per-color-per-gender image sets). `gender` enum narrowed from 5 values to exactly `['Men', 'Women', 'Unisex']`.

**Gender enum narrowing — confirm before you rely on it.** I could not query the live database from this sandbox (same TLS wall as every prior session, see below) to check whether any existing product uses the removed `'Male'`/`'Female'` values. You explicitly chose to narrow the enum anyway rather than keep all 5. I've handed you `src/scripts/checkGenderValues.js` (read-only, lists any offending documents) — **run this yourself before any existing product gets re-saved**, since a `'Male'`/`'Female'` document would now fail validation on its next update. I attempted to run it from here; it failed with the same connectivity error documented below, so it has never actually executed against your real data.

`getProduct`'s query now populates `fabric`, `categoryRef`, `colorRefs` — safe for old documents since populating an absent ref just returns `null`/`[]`. `getImagesForColor(color, gender)` checks `variants` first (matching color + gender when given), then falls back to the pre-existing `colorImages`/`defaultImages` logic — this is the actual mechanism keeping old and new products both working through the same storefront-facing endpoints.

### Shipment receiving — the first atomic inventory-mutation path in this codebase
`POST /api/shipments` creates and receives in one action (no separate draft/receive state, matching the plan). Each line item atomically increments `inventory.$.stock`/`totalStock` if the color/size row exists, or `$push`es a new row if it doesn't — all line items plus the Shipment document wrapped in one Mongoose transaction (`session.withTransaction`), so a bad line item (e.g. a deleted product) rolls back the whole receipt. Gated `auth, authorize('admin', 'warehouse_manager')`, same as Vendor. `deleteShipment` is explicitly a record-only delete — it does not reverse the inventory increment (documented in-code; use the Inventory tab's manual stock edit to undo a bad receipt).

**Not unified:** this repo now has *four* different inventory-mutation code paths (the pre-existing `Product.updateStock` method, the pre-existing `updateInventory` controller, pre-existing inline logic in `createProduct`/`updateProduct`, and this session's new atomic Shipment-receive path). Reconciling them was flagged as explicitly out of scope for this session — the new path is correct for its own purpose, not a fix for the other three.

### New variant-image upload endpoint (added after initial frontend wiring surfaced the gap)
`POST /:id/images/variant/:color/:gender` (`auth, isAdmin`) — writes into `Product.variants`, separate from the existing `colorImages` path. Needed so the frontend's Unisex product flow can upload distinct Men/Women image sets for the same color while inventory stays one shared pool. Rejects with 400 if the product isn't `Unisex` or the gender isn't `Men`/`Women`.

## Sandbox DB connectivity — confirmed dead again this session
Attempted `node src/scripts/checkGenderValues.js` from this sandbox (after confirming you'd pointed me at dev/staging, per your explicit choice). It failed with the same `ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR` TLS-handshake failure against the Atlas cluster documented in every prior session's PROGRESS.md entry — this is a sandbox network-egress characteristic, not a regression or something new to investigate. No live verification (create a Fabric/Color/Product/Shipment, confirm storefront fetch endpoints) was possible here for the same reason. Run the commands below yourself once you're pointed at the real dev/staging database:
```bash
node src/scripts/checkGenderValues.js
```
Then, with the server running (`npm run dev`), exercise the new endpoints for real: create a Fabric (composition summing to 100), a Category, a Color, a Product referencing all three, and a Shipment against that product — confirm `totalStock`/`inventory` update, then hit `GET /api/products/:id` and a pre-existing (pre-B.1) product's `GET /api/products/:id` to confirm both still return successfully.

## Optional backfill — not built
The plan offered a script to link existing products' `category`/`colors` strings to real `Category`/`Color` documents. Not built or requested this session — old products don't need it to keep working (see "additive throughout" above); ask for it explicitly if you want existing catalog data linked up rather than just new products going forward.

Verification: `node --check` on every new/changed file (clean, all of them, first attempt). Manual trace of the Shipment transaction logic against the schema. No live HTTP/DB verification — see above.

---

## Session: Navbar + footer rebuild — issues #23, #24, + B.4 (Gift Cards, Blog) (2026-07-23)

Backend half of a combined frontend+backend session. Confirmed Part B.1 was done (models above) before starting, per your instruction. Commits in order (`git log`, oldest first): GiftCard model+controller+routes+order integration → BlogPost model+controller+routes → `getAllProducts` filter extension.

### GiftCard (`src/models/giftCard.model.js`, `giftCard.controller.js`, `giftCard.routes.js`)
Fields exactly as specced: `code` (unique, `crypto.randomBytes(6).toString('hex').toUpperCase()` default — deliberately unguessable, not this codebase's usual sequential `YYYYMMDD-xxx` ID pattern, since a gift card code is redeemable value and must not be enumerable), `initialBalance`, `currentBalance`, `purchaserId` (nullable, guest purchases allowed), `recipientEmail`, `expiryDate` (1 year from purchase), `isActive`.
- `POST /api/gift-cards/purchase` — public, no auth middleware at all (this codebase has no "optional auth" variant, only two-route guest/logged-in splits like orders use — a basic single-route purchase flow doesn't need that split). Returns the code on-screen; **no email delivery of the code** — there's no generic "send arbitrary email" export in `emailService.js` to reuse cheaply, and it wasn't required for a "basic" flow. Flagging as a deferred nicety, not forgotten.
- `POST /api/gift-cards/validate` — public, non-mutating, checks `isActive`/expiry/balance, returns `{valid, giftCardId, availableBalance}`. Deliberately shaped to look like a future discount-code validation endpoint would, per your "keep the interface similar" instruction — no discount-code system exists yet to actually unify with.
- **Checkout integration** (`order.model.js` + `order.controller.js`'s `createOrder`): added `giftCardCode`/`giftCardAmount` fields to the Order schema. `createOrder` now looks up the gift card by code, re-validates active/not-expired/sufficient-balance server-side (**not** trusting whatever amount the frontend sends, unlike how this function already trusts `discount`/`pointsUsed` as-is from the request body — a gift card carries real transferable balance, so this asymmetry is deliberate), and after the order saves, decrements `currentBalance` (deactivating at 0) as a plain non-transactional step. This matches the existing inventory/points-update pattern in the same function — confirmed there is **no** Mongoose session/transaction anywhere in `createOrder` today (all three writes — inventory, order, points — are already separate non-atomic steps), so this doesn't introduce a new consistency guarantee that wasn't already absent; wrapping the whole flow in a transaction is a bigger, separate decision, not this session's scope.

### BlogPost (`src/models/blogPost.model.js`, `blogPost.controller.js`, `blogPost.routes.js`)
Exactly the 6 fields you specified — `title`, `slug` (unique), `coverImage`, `body`, `publishedAt`, `author` — nothing extra. Full CRUD: `GET /` and `GET /:slug` public, `POST`/`PUT`/`DELETE` gated `auth, isAdmin`. **Admin UI screen deferred, as you invited me to call** — same "backend now, admin screen later" pattern this project already used for Fabric/Category/Color across earlier sessions. Until a future session builds the screen, posts get created via direct API calls (curl/Postman) or a DB script — same as any other content-seeding gap in this project so far.

### `getAllProducts` filter extension (issue #23's real-filtering prerequisite)
Added three new, purely additive filter branches — `categoryRef`, `colorRefs`, `fabric` — read from `req.query` alongside the pre-existing legacy `category`/`gender`/`color` string filters (all untouched). No new route; same `GET /api/products` endpoint, new optional query params. This is what makes the frontend's megamenu "Shop By" links actually filter the product grid instead of just being decorative — see the frontend's PROGRESS.md for the other half (Men's/Women's `Products.jsx` reading these params from the URL).

### Verification
`node --check` on all 10 new/changed files — clean, first attempt (matches every prior session's static-verification bar). Same sandbox DB-connectivity wall as every session so far (`ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR` against Atlas) — no live purchase → validate → checkout → balance-decrement round trip was possible from here. Manually traced the order-creation code path against `order.model.js`'s `pre('save')` total-invariant hook (`total === subtotal - discount + shippingCharges`, 1-cent tolerance) — the frontend folds `giftCardAmount` into the same `discount`/`total` numbers it already computes for points, so the invariant holds; see the frontend's PROGRESS.md for that side.

### What's next
Run a real gift-card purchase → checkout → balance-decrement trip against a real dev/staging DB once one's reachable — same standing ask as every prior session's PROGRESS.md. If gift-card email delivery becomes a real requirement, `emailService.js` will need a generic "send templated email" export first; today's exports are all purpose-built for specific flows (OTP, order confirmation). Blog admin CRUD screen and Affiliate's real request-flow (`AffiliatePartner`/`AffiliateRequest` models) are both still open — the frontend session that triggered this one built a static Affiliate info page only, per your explicit "backend-only, later" instruction.

---

## Session: Checkout/account cluster — issues #18, #20 (2026-07-24)

Confirmed both prerequisites (A1's `updateAccount` fix, A4's cancel-route uncomment + `orderStatus` bugfix) were already done per this file's own earlier entries — no rework needed before starting. Plan mode was used for the `statusHistory` schema change specifically, per your instruction, since it needed an explicit answer on how existing orders without the field would behave.

### `statusHistory` (issue #18) — `order.model.js`, `order.controller.js`
New `statusHistory: [{status, changedAt}]` array on `Order`, populated in three places:
- `createOrder` seeds `[{status: 'Pending', changedAt: now}]` on every new order, so the timeline exists from creation, not just from the first admin update.
- `updateOrderStatus` pushes a new entry whenever the status actually changes (reusing the `statusChanged` boolean already computed there for the email-notification branch).
- `cancelOrder` pushes its own `{status: 'Cancelled', ...}` entry, since it sets `orderStatus` directly and bypasses `updateOrderStatus` entirely.

**No migration script for existing orders, and this was a deliberate decision, not an oversight.** Mongoose hydrates a newly-added array field as `[]` automatically for documents that predate the schema change — `order.statusHistory` is never `undefined`, just empty. `getUserOrders` and `getOrderById` both check for that empty-array case and synthesize a single fallback entry (`{status: order.orderStatus, changedAt: order.createdAt}`) before responding, so an old order shows "current status since order date" instead of a blank timeline. Kept in the two response-shaping functions rather than a schema virtual, specifically to avoid the side effect of enabling `toJSON:{virtuals:true}` schema-wide, which would also silently surface the existing unused `formattedId` virtual in every order response.

**Incidental fix bundled in**: `cancelOrder`'s `!req.user.isAdmin` check was dead code (`isAdmin` doesn't exist on `User`, only `role`) — flagged in an earlier session's entry above as deferred. It didn't actually block a customer cancelling their own order (the broken clause only mattered for the admin-cancels-someone-else's-order path), but since this function was already being edited for the `statusHistory` push, it got the same `req.user.role === 'admin'` fix `getOrderById` received in an earlier session, for consistency.

### `updateAccount` extended to accept a saved address (issue #20)
`updateAccount` previously only handled `username`/`currentPassword`/`newPassword` — it had no concept of `User.addresses` at all despite that field already existing on the schema. Extended to accept an optional `address` object from the checkout "save this address to my profile" flow: if the user already has a default address, it's replaced in place; otherwise a new one is pushed with `isDefault: true`. This treats the checkout form's single address+city as one canonical default address, not an address-book entry — deliberately not accumulating a near-duplicate every time someone leaves the checkbox checked, since the checkout form itself only ever collects one address at a time. Response now also echoes `addresses` back (previously only `username`/`email`/`profilePicUrl`).

### Verification
`node --check` on all three changed files — clean (confirmed earlier in the session; a later re-check attempt hit this machine's own resource contention from several other running apps — VS Code, another AI coding tool, the Claude desktop app itself — timing out on even `wc -l`, unrelated to these files, which hadn't changed since the first successful check). Manually traced all three `statusHistory` push points against the schema's enum and the existing `orderStatus` transitions. Live order-creation → status-walk → cancel round trip wasn't possible from here for the same reason every backend session in this project has hit: this sandbox can't reach the live Atlas cluster, and the real deployed backend doesn't have any of this project's work pushed to it yet.

### What's next
Once a reachable dev/staging backend exists: place a real order, walk it through `Pending → Confirmed → Processing → Shipped → Delivered` via `PUT /api/orders/update-status/:orderId` (admin token), confirm `statusHistory` grows one entry per transition; confirm `cancelOrder` succeeds while `Pending`/`Processing` and 400s once `Shipped`/`Delivered`; confirm the address-save round trip via `GET /api/users/profile` after a checkout with the box checked.

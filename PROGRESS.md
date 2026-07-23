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

## Related-but-out-of-scope findings (flagged, not fixed this session)
- `profileAccessAdmin` (`user.controller.js`, routed unauthenticated at `GET /profile-admin`) has the same hardcoded-id pattern as A1's bug but wasn't named in A1's scope.
- `product.routes.js`'s `PATCH /:id/images/color/:color/:imageId/primary` and `GET /fix-product/:id` are also unguarded mutating/admin-ish routes, not among A2's 6 named routes.
- `cancelOrder`'s `req.user.isAdmin` check is dead code (no such field on `User`, only `role`) — doesn't block A4's required behavior, but worth folding into B.2's real RBAC work.

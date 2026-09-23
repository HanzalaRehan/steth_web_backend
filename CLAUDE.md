# CLAUDE.md — Steth_web_backend

## What this is
Node/Express + Mongoose/MongoDB API for the STETH e-commerce site. Deployed on Render. Auth is JWT + bcrypt, plus Google Sign-In via `google-auth-library` (server-side ID-token verification — this part is done correctly, don't "simplify" it). Images go through **ImageKit**, not Cloudinary or S3 — don't introduce a second image provider.

## Where we are
The active work plan is `stethset-unified-master-plan.md` (ask the user for it if it's not in this repo yet — don't start building features without it). Always check `PROGRESS.md` at the repo root first to see what's already done and what's mid-flight before starting anything. Update `PROGRESS.md` at the end of every session: what changed, what's left in the current section, any decision you made that wasn't spelled out in the plan.

## Run / verify
- `npm run dev` — nodemon dev server (needs a local `.env`, see below — never create or commit one, ask the user for values)
- `npm test` — Jest is configured but **there are currently no test files in the repo**. Any new logic you add to a controller, especially auth/order/inventory logic, should ship with a real Jest test alongside it — don't leave this at zero coverage as you add more surface area.
- Health check: `GET /ping` → `pong`, `GET /` → confirms the server is up.

## Known landmines — read before touching auth or routes
- **Two different, incompatible JWT auth implementations exist.** `middlewares/auth.middleware.js` exports `auth`/`isAdmin`, verifies with `process.env.ACCESS_TOKEN_SECRET`, and expects `decoded.id`. Separately, `user.controller.js` has its *own* `auth` function (used only by `GET /validate-token`) that verifies with `process.env.JWT_SECRET` and expects `decoded.userId` — a field name tokens are never actually signed with. That second one is effectively dead/broken code. **Use the middleware version (`ACCESS_TOKEN_SECRET`, `decoded.id`) as the one source of truth going forward** — don't extend or "fix" the controller version, retire it once nothing depends on it.
- **CORS is currently `app.use(cors())`** — wide open, comment says "during development" but there's no environment gate. Don't add more routes assuming CORS is restrictive; it isn't yet (see the master plan, Part A / A5).
- **Rate limiting is present in the dependencies but commented out** in `server.js` (`express-rate-limit` is installed, the middleware application is commented out "for development"). Same pattern as CORS — flag it, don't assume it's active.
- **Route-level auth is inconsistent and mostly missing on admin-facing routes** (`product.routes.js` write routes, `order.routes.js` admin routes, `user.routes.js` `/update-account`). Don't copy the *unguarded* pattern when adding new admin routes — every new admin/mutating route should get `auth` + `isAdmin` (or the relevant role check once RBAC roles expand) from the start, per Part A/B.2 of the master plan.
- **`updateAccount` in `user.controller.js` has a hardcoded user `_id` literal in it** — this is a live bug (Part A, A1), not a placeholder to preserve. Once fixed, it should read the target user from `req.user` (populated by `auth` middleware), never from a body param or a literal.
- Env vars actually in use (do not invent new names for the same concept — reuse these): `ACCESS_TOKEN_SECRET`, `RESET_TOKEN_SECRET`, `MONGODB_URI`, `GOOGLE_CLIENT_ID`, `IMAGEKIT_PUBLIC_KEY`, `IMAGEKIT_PRIVATE_KEY`, `IMAGEKIT_URL_ENDPOINT`, `BREVO_API_KEY`, `EMAIL_STETH`, `EMAIL_STETH_PASS`, `EMAIL_ADMIN`, `PORT`, `NODE_ENV`. (`JWT_SECRET` also appears but only in the dead-code path above — don't treat it as a real secret to configure.)

## Conventions already in place — follow them, don't reinvent
- Controllers are plain objects/functions exported and wired in `routes/*.routes.js`, not classes.
- Async handlers mostly use manual try/catch (not `express-async-handler` consistently, despite it being a dependency) — match whichever pattern the file you're editing already uses rather than mixing styles in one file.
- Mongoose schemas live in `models/*.model.js` (note: some existing files, like `ColorTile.js`, `HeroImage.js`, `Subscriber.js`, don't follow the `.model.js` suffix — match the existing name for a file you're editing, use `.model.js` for new entities).
- Response shape is inconsistent across controllers (`{success, message, data}` in some, bare `{message}` in others) — don't silently "standardize" this as a side effect of an unrelated change, since the frontend has hardcoded expectations tied to today's shapes in different places; only touch response shape when the task is actually about that endpoint.

## Boundaries
- Don't touch `uploads/` or `temp/` directories' contents directly — they're runtime-generated.
- Don't commit `.env` or anything under it — check `.gitignore` covers it before any commit that touches config.
- Don't add a second caching/queue layer if Redis/BullMQ get added for the analytics pipeline (Part B.3) — reuse that same Redis instance for the caching work in Part B.5 rather than standing up another one.

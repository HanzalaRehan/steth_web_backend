# Steth E-Commerce Backend

A comprehensive backend API for the Steth E-Commerce website built with Node.js, Express, and MongoDB.

## Features

- **User Management**: Authentication, authorization, and profile management
- **Product Management**: CRUD operations for products with inventory management
- **Order Management**: Complete order lifecycle with payment processing
- **Student Verification**: Student discount verification system
- **Image Management**: ImageKit integration for file uploads
- **Email Services**: Automated email notifications
- **Reward Points**: Customer loyalty program

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: MongoDB with Mongoose
- **File Storage**: ImageKit
- **Authentication**: JWT
- **Email**: Nodemailer
- **File Upload**: Multer

## Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
# ImageKit Configuration
IMAGEKIT_PUBLIC_KEY=your_imagekit_public_key
IMAGEKIT_PRIVATE_KEY=your_imagekit_private_key
IMAGEKIT_URL_ENDPOINT=your_imagekit_url_endpoint

# Database
MONGODB_URI=your_mongodb_connection_string

# JWT
JWT_SECRET=your_jwt_secret

# Email (Gmail)
EMAIL_USER=your_gmail_address
EMAIL_PASS=your_gmail_app_password

# Server
PORT=5000
NODE_ENV=development
```

## Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Set up environment variables
4. Start the server:
   ```bash
   npm run dev  # Development mode
   npm start    # Production mode
   ```

## API Endpoints

### Authentication
- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User login
- `POST /api/auth/google` - Google OAuth login

### Users
- `GET /api/users/profile` - Get user profile
- `PUT /api/users/profile` - Update user profile
- `PUT /api/users/profile-picture` - Update profile picture

### Products
- `GET /api/products` - Get all products
- `POST /api/products` - Create product (Admin)
- `PUT /api/products/:id` - Update product (Admin)
- `DELETE /api/products/:id` - Delete product (Admin)

### Orders
- `POST /api/orders/create` - Create order (Authenticated)
- `POST /api/orders/create-guest` - Create guest order
- `GET /api/orders/my-orders` - Get user orders
- `GET /api/orders/all` - Get all orders (Admin)

### Student Verification
- `POST /api/student-verification/submit` - Submit verification
- `GET /api/student-verification/status` - Check status

### Size Recommendation
- `GET /api/size/chart` - Published scrub top/pants size charts
- `POST /api/size/recommend` - "What's My Size?" (public; saves the result if a token is sent)
- `POST /api/size/quiz` - "Take the Size Quiz" (auth; same answer + one-time reward points)
- `GET /api/size/profile` - Saved size, ordered-size history and feedback count (auth)
- `POST /api/size/fit-feedback` - Report how a size fitted / a wrong-size exchange (auth)

Both entry points run the same rule-based engine (`src/utils/sizeRecommendation.js`),
which sizes against the published chart (`src/utils/sizeChart.js`) and returns a
**single size for the whole outfit** - where the chest and waist disagree, the larger
size wins and the response explains why.

Accepted inputs (all optional, but at least `chest`, `waist`, or `height + weight` is
required): `chest`, `waist`, `hip`, `heightInches`, `weightKg`, `fitPreference`
(`regular` | `loose`). A `loose` preference recommends one size up, capped at XL, and
the response always reports both `baseSize` (what the measurements said) and
`recommendedSize` (what the customer is told), so the UI can show the reason.

Every submission and every piece of fit feedback is stored on the customer's
`SizeProfile`. That is deliberate: the rules are a cold-start stand-in, and the
collected data is the training set for the model that will replace them. When it
lands, only `recommendSize()` changes - the response shape is the contract.

### Loyalty Programme (Rewards)
- `GET /api/rewards/catalogue` - Public list of every way to earn points
- `GET /api/rewards/me` - Balance, per-rule status and history (auth)
- `POST /api/rewards/claim` - Claim a self-declared reward (auth)
- `POST /api/rewards/sync` - Re-derive purchase/celebration rewards (auth)
- `POST /api/rewards/birthday` - Save a date of birth (auth)
- `GET /api/rewards/config` - Values in force + pending decisions (admin)

**All point values and PKR thresholds live in `src/config/rewardRules.js` and are
provisional** - they are carried over from the reference programme pending business
sign-off. That file is the only place to change them; nothing else hardcodes a value.

Rules pay out in one of two ways:
- **Claimed** - social follows and subscriptions. These cannot be verified without
  platform APIs, so they are trust-based and strictly one-time.
- **Derived** - purchase milestones, birthday, loyalty anniversary and product
  reviews, all recomputed from orders/products/user data by `POST /sync` (which
  `GET /me` also runs). The sync is idempotent and stateless, so **no cron, queue or
  Redis is required**, and customers are credited retroactively for orders placed
  before the programme launched - no backfill migration needed.

**Joining** pays a one-off `SIGN_UP` reward. It is derived from the account's own
creation date rather than granted by the registration controller, so customers who
signed up before the programme launched are credited the first time they open the
rewards page — no backfill script, and registration is untouched.

**Points expire** after `POINTS_EXPIRY_DAYS` (currently 365). The expiry date is
stamped on each ledger row at award time, so changing the policy later never moves
the goalposts on points already earned. Expired points are swept lazily during the
same sync — no scheduled job — and the sweep writes an `adjust` row so the history
explains the drop. The balance is never driven negative.

The activity feed merges two sources: programme rewards from the ledger, and
per-order points, which `order.controller.js` credits straight to the balance. Order
points are read for display only and deliberately **not** written into the ledger —
doing so would double-credit a balance checkout has already updated.

Double-crediting is prevented by a unique index on
`(user, ruleKey, occurrenceKey)` in `src/models/rewardTransaction.model.js`, not by
check-then-write, so concurrent requests cannot both pay out. `User.rewardPoints`
remains the authoritative spendable balance that checkout reads; the ledger records
how it got there.

## File Storage

This project uses **ImageKit** for file storage and image management. All images (product images, user profile pictures, student verification documents, etc.) are uploaded to ImageKit with organized folder structures:

- `user-profiles/` - User profile pictures
- `products/` - Product images
- `student-verification/` - Student verification documents
- `hero-images/` - Hero/banner images
- `color-tiles/` - Color swatch images
- `order-payment/` - Payment receipts

## Migration from Cloudinary

This project has been migrated from Cloudinary to ImageKit. The migration includes:

- Updated all upload utilities
- Modified database schemas to use ImageKit file IDs
- Updated all controllers to use ImageKit API
- Maintained the same folder structure for organization

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License 
/**
 * Author(s): 1. husnain417
 *            2. Hanzala B. Rehan
 *            3. Zainab Raza
 * Description: Mongoose model for customer and staff accounts. Covers local
 *              and Google auth, OTP/verification state, role-based access,
 *              saved addresses, student status, and the loyalty balance
 *              (rewardPoints) that checkout spends and the rewards programme
 *              credits.
 *
 * Date created: May 7th, 2025
 * Edit(s):
 *   (1): Added dateOfBirth and marketingOptIns for the loyalty programme -
 *        the birthday reward needs a date to pay out on, and the WhatsApp
 *        opt-in reward needs somewhere to record consent and the number.
 * Date last modified: August 3rd, 2026
 * Run: Not directly runnable - imported by the controllers in src/controllers/
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const userSchema = new Schema({
    username: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: {
      type: String,
      required: function () {
        return this.authProvider !== 'google';
      }
    },
    authProvider: {
      type: String,
      enum: ['local', 'google'],
      default: 'local'
    },
    googleId: { type: String },
    // keep the rest of your existing fields...
    otp: String,
    otpExpires: Date,
    isVerified: { type: Boolean, default: false },
    profilePicUrl: String,
    uploadedAt: { type: Date, default: Date.now },
    isStudent: { type: Boolean, default: false },
    studentVerified: { type: Boolean, default: false },
    role: {
      type: String,
      default: 'customer',
      enum: ['customer', 'admin', 'warehouse_manager', 'marketer']
    },
    rewardPoints: { type: Number, default: 0 },
    firstOrderPlaced: { type: Boolean, default: false },
    // Loyalty programme: the birthday reward pays out annually and needs a
    // date to pay out on. Optional - customers who never supply one simply
    // never qualify, and the rewards page prompts them for it.
    dateOfBirth: { type: Date },
    // Consent state for the two subscription rewards. The points are recorded
    // in the reward ledger; this is the actual opt-in flag that marketing
    // reads, kept on the user so it survives independently of the points.
    marketingOptIns: {
      email: { type: Boolean, default: false },
      whatsapp: { type: Boolean, default: false },
      whatsappNumber: { type: String, trim: true }
    },
    addresses: [{
      type: {
        type: String,
        default: 'home',
        enum: ['home', 'work', 'other']
      },
      fullName: String,
      addressLine1: String,
      addressLine2: String,
      city: String,
      state: String,
      postalCode: String,
      country: String,
      phoneNumber: String,
      isDefault: { type: Boolean, default: false }
    }]
  }, { timestamps: true });
  
const User = mongoose.model('User', userSchema);
module.exports = User;
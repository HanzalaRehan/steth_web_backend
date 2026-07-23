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
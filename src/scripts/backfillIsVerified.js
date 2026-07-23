// One-time migration for Part A / A6: grandfather existing users so the new
// isVerified login gate doesn't lock out accounts created before OTP enforcement.
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user.model');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const affected = await User.countDocuments({ isVerified: false });
  console.log(`About to set isVerified:true for ${affected} existing user(s).`);

  const result = await User.updateMany({ isVerified: false }, { $set: { isVerified: true } });
  console.log(`Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`);

  await mongoose.disconnect();
})();

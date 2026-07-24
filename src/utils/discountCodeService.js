const crypto = require('crypto');
const DiscountCode = require('../models/discountCode.model');

// Codes are human-shareable (unlike GiftCard's random secret), so we store
// a SHA-256 lookup hash rather than the plaintext - same security intent as
// GiftCard.model.js's unguessable code, adapted since these are meant to be
// typed in by a customer, not generated unguessably.
const normalizeCode = (code) => code.trim().toUpperCase();

const hashDiscountCode = (plainCode) =>
  crypto.createHash('sha256').update(normalizeCode(plainCode)).digest('hex');

// Looks up an active, non-expired DiscountCode by its plaintext value.
// Returns null if not found/invalid - callers treat that as "no code discount available".
const findValidDiscountCode = async (plainCode) => {
  if (!plainCode) return null;
  const codeHash = hashDiscountCode(plainCode);
  const discountCode = await DiscountCode.findOne({ codeHash, isActive: true });
  if (!discountCode) return null;
  if (discountCode.expiryDate && discountCode.expiryDate < new Date()) return null;
  return discountCode;
};

const computeCodeDiscount = (discountCode, subtotal) => {
  if (!discountCode) return 0;
  return subtotal * (discountCode.percentage / 100);
};

module.exports = {
  hashDiscountCode,
  findValidDiscountCode,
  computeCodeDiscount,
};

// controllers/discount.controller.js
const User = require('../models/user.model');
const Order = require('../models/order.model');
const { calculateDiscount } = require('../utils/discountService'); // Extract to separate service
const { findValidDiscountCode, computeCodeDiscount } = require('../utils/discountCodeService');

const discountController = {
  /**
   * Calculate discounts for a user before checkout
   * This allows showing discount information in the cart
   */
  calculateDiscountPreview: async (req, res) => {
    try {
      const { subtotal, pointsToUse = 0, discountCode = '' } = req.body;
      const userId = req.user._id;

      if (!subtotal) {
        return res.status(400).json({
          success: false,
          message: 'Subtotal is required'
        });
      }

      // Get user for points validation and student status
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      // Validate points usage
      if (pointsToUse > user.rewardPoints) {
        return res.status(400).json({
          success: false,
          message: `Cannot use more points than available. You have ${user.rewardPoints} points.`
        });
      }

      // Automatic discount (first order + student, stack with each other - unchanged)
      const { amount: automaticAmount, reason: automaticReason } = await calculateDiscount(userId, subtotal);

      // Admin-managed discount code, if one was entered
      let codeAmount = 0;
      let matchedDiscountCode = null;
      if (discountCode) {
        matchedDiscountCode = await findValidDiscountCode(discountCode);
        codeAmount = computeCodeDiscount(matchedDiscountCode, subtotal);
      }

      // Decision: mutually exclusive, best-of-two between the automatic
      // discount and an entered code - not additive. Two promotional
      // percentage mechanisms don't stack with each other; gift cards and
      // reward points (below) are unrelated real-balance mechanisms and
      // continue to combine on top of whichever one wins.
      let discountAmount = automaticAmount;
      let discountReason = automaticReason;
      let discountSource = 'automatic';

      if (codeAmount > automaticAmount) {
        discountAmount = codeAmount;
        discountReason = `Discount code: ${matchedDiscountCode.name}`;
        discountSource = 'code';
      }

      if (discountCode && !matchedDiscountCode) {
        discountSource = 'invalid_code';
      }

      // Calculate points value
      const pointsDiscount = pointsToUse; // 1 point = 1 PKR

      // Calculate final total
      const total = subtotal - discountAmount - pointsDiscount;

      // Calculate points that would be earned from this purchase
      const pointsEarned = Math.floor(total / 100); // 1 point for every 100 PKR

      return res.status(200).json({
        success: true,
        subtotal,
        discountAmount,
        discountReason,
        discountSource,
        pointsDiscount,
        pointsToUse,
        pointsEarned,
        total: Math.max(0, total) // Ensure total is not negative
      });
    } catch (error) {
      console.error('Error calculating discount preview:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to calculate discount',
        error: error.message
      });
    }
  }
};

module.exports = discountController;
const DiscountCode = require('../models/discountCode.model');
const { hashDiscountCode } = require('../utils/discountCodeService');

const discountCodeController = {
  getAllDiscountCodes: async (req, res) => {
    try {
      const codes = await DiscountCode.find().sort({ createdAt: -1 });
      return res.status(200).json({ success: true, discountCodes: codes });
    } catch (error) {
      console.error('Error fetching discount codes:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch discount codes', error: error.message });
    }
  },

  // Returns the plaintext code once, at creation time only - it is never
  // recoverable afterwards since only its hash is stored (mirrors how this
  // app already handles secrets it needs to show exactly once).
  createDiscountCode: async (req, res) => {
    try {
      const { code, name, description = '', percentage, expiryDate } = req.body;

      if (!code || !name || !percentage || !expiryDate) {
        return res.status(400).json({
          success: false,
          message: 'code, name, percentage, and expiryDate are required',
        });
      }

      const codeHash = hashDiscountCode(code);
      const existing = await DiscountCode.findOne({ codeHash });
      if (existing) {
        return res.status(400).json({ success: false, message: 'A discount code with this value already exists' });
      }

      const discountCode = await DiscountCode.create({
        name,
        description,
        percentage: Number(percentage),
        expiryDate: new Date(expiryDate),
        codeHash,
      });

      return res.status(201).json({
        success: true,
        message: 'Discount code created',
        discountCode,
        code, // plaintext, shown once
      });
    } catch (error) {
      console.error('Error creating discount code:', error);
      return res.status(500).json({ success: false, message: 'Failed to create discount code', error: error.message });
    }
  },

  updateDiscountCode: async (req, res) => {
    try {
      const { id } = req.params;
      const { name, description, percentage, expiryDate, isActive } = req.body;

      const discountCode = await DiscountCode.findById(id);
      if (!discountCode) {
        return res.status(404).json({ success: false, message: 'Discount code not found' });
      }

      if (name !== undefined) discountCode.name = name;
      if (description !== undefined) discountCode.description = description;
      if (percentage !== undefined) discountCode.percentage = Number(percentage);
      if (expiryDate !== undefined) discountCode.expiryDate = new Date(expiryDate);
      if (isActive !== undefined) discountCode.isActive = isActive;

      await discountCode.save();

      return res.status(200).json({ success: true, message: 'Discount code updated', discountCode });
    } catch (error) {
      console.error('Error updating discount code:', error);
      return res.status(500).json({ success: false, message: 'Failed to update discount code', error: error.message });
    }
  },

  deleteDiscountCode: async (req, res) => {
    try {
      const { id } = req.params;
      const discountCode = await DiscountCode.findByIdAndDelete(id);
      if (!discountCode) {
        return res.status(404).json({ success: false, message: 'Discount code not found' });
      }
      return res.status(200).json({ success: true, message: 'Discount code deleted' });
    } catch (error) {
      console.error('Error deleting discount code:', error);
      return res.status(500).json({ success: false, message: 'Failed to delete discount code', error: error.message });
    }
  },
};

module.exports = discountCodeController;

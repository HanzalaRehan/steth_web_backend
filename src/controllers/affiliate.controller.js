const AffiliateRequest = require('../models/affiliateRequest.model');
const AffiliatePartner = require('../models/affiliatePartner.model');

const affiliateController = {
  // --- Requests ---
  getAllRequests: async (req, res) => {
    try {
      const requests = await AffiliateRequest.find().sort({ createdAt: -1 });
      return res.status(200).json({ success: true, requests });
    } catch (error) {
      console.error('Error fetching affiliate requests:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch affiliate requests', error: error.message });
    }
  },

  // Admin logs a request manually - no public submission endpoint exists yet.
  createRequest: async (req, res) => {
    try {
      const { name, email, message = '' } = req.body;
      if (!name || !email) {
        return res.status(400).json({ success: false, message: 'name and email are required' });
      }
      const request = await AffiliateRequest.create({ name, email, message });
      return res.status(201).json({ success: true, message: 'Affiliate request logged', request });
    } catch (error) {
      console.error('Error creating affiliate request:', error);
      return res.status(500).json({ success: false, message: 'Failed to create affiliate request', error: error.message });
    }
  },

  // Approving creates the AffiliatePartner with a generated referral code.
  approveRequest: async (req, res) => {
    try {
      const { id } = req.params;
      const request = await AffiliateRequest.findById(id);
      if (!request) {
        return res.status(404).json({ success: false, message: 'Affiliate request not found' });
      }
      if (request.status !== 'pending') {
        return res.status(400).json({ success: false, message: `Request already ${request.status}` });
      }

      const partner = await AffiliatePartner.create({
        name: request.name,
        email: request.email,
        sourceRequest: request._id,
      });

      request.status = 'approved';
      request.reviewedAt = new Date();
      request.reviewedBy = req.user._id;
      await request.save();

      return res.status(200).json({ success: true, message: 'Affiliate request approved', request, partner });
    } catch (error) {
      console.error('Error approving affiliate request:', error);
      return res.status(500).json({ success: false, message: 'Failed to approve affiliate request', error: error.message });
    }
  },

  rejectRequest: async (req, res) => {
    try {
      const { id } = req.params;
      const request = await AffiliateRequest.findById(id);
      if (!request) {
        return res.status(404).json({ success: false, message: 'Affiliate request not found' });
      }
      if (request.status !== 'pending') {
        return res.status(400).json({ success: false, message: `Request already ${request.status}` });
      }

      request.status = 'rejected';
      request.reviewedAt = new Date();
      request.reviewedBy = req.user._id;
      await request.save();

      return res.status(200).json({ success: true, message: 'Affiliate request rejected', request });
    } catch (error) {
      console.error('Error rejecting affiliate request:', error);
      return res.status(500).json({ success: false, message: 'Failed to reject affiliate request', error: error.message });
    }
  },

  // --- Partners ---
  getAllPartners: async (req, res) => {
    try {
      const partners = await AffiliatePartner.find().sort({ createdAt: -1 });
      return res.status(200).json({ success: true, partners });
    } catch (error) {
      console.error('Error fetching affiliate partners:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch affiliate partners', error: error.message });
    }
  },

  updatePartnerStatus: async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
      if (!['active', 'inactive'].includes(status)) {
        return res.status(400).json({ success: false, message: 'status must be active or inactive' });
      }
      const partner = await AffiliatePartner.findByIdAndUpdate(id, { status }, { new: true });
      if (!partner) {
        return res.status(404).json({ success: false, message: 'Affiliate partner not found' });
      }
      return res.status(200).json({ success: true, message: 'Partner status updated', partner });
    } catch (error) {
      console.error('Error updating affiliate partner:', error);
      return res.status(500).json({ success: false, message: 'Failed to update affiliate partner', error: error.message });
    }
  },
};

module.exports = affiliateController;

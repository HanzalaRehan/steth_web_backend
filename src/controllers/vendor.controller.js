const Vendor = require('../models/vendor.model');
const { catchAsync } = require('../utils/errorHandler');

exports.getAllVendors = catchAsync(async (req, res) => {
    const vendors = await Vendor.find().sort({ name: 1 });
    res.status(200).json({ success: true, data: vendors });
});

exports.getVendor = catchAsync(async (req, res) => {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) {
        return res.status(404).json({ success: false, message: 'Vendor not found' });
    }
    res.status(200).json({ success: true, data: vendor });
});

exports.createVendor = catchAsync(async (req, res) => {
    const vendor = await Vendor.create(req.body);
    res.status(201).json({ success: true, data: vendor });
});

exports.updateVendor = catchAsync(async (req, res) => {
    const vendor = await Vendor.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true
    });
    if (!vendor) {
        return res.status(404).json({ success: false, message: 'Vendor not found' });
    }
    res.status(200).json({ success: true, data: vendor });
});

exports.deleteVendor = catchAsync(async (req, res) => {
    const vendor = await Vendor.findByIdAndDelete(req.params.id);
    if (!vendor) {
        return res.status(404).json({ success: false, message: 'Vendor not found' });
    }
    res.status(200).json({ success: true, message: 'Vendor deleted successfully' });
});

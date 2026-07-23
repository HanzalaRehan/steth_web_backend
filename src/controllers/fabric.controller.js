const Fabric = require('../models/fabric.model');
const { catchAsync } = require('../utils/errorHandler');

exports.getAllFabrics = catchAsync(async (req, res) => {
    const fabrics = await Fabric.find().sort({ name: 1 });
    res.status(200).json({ success: true, data: fabrics });
});

exports.getFabric = catchAsync(async (req, res) => {
    const fabric = await Fabric.findById(req.params.id);
    if (!fabric) {
        return res.status(404).json({ success: false, message: 'Fabric not found' });
    }
    res.status(200).json({ success: true, data: fabric });
});

exports.createFabric = catchAsync(async (req, res) => {
    const fabric = await Fabric.create(req.body);
    res.status(201).json({ success: true, data: fabric });
});

exports.updateFabric = catchAsync(async (req, res) => {
    const fabric = await Fabric.findById(req.params.id);
    if (!fabric) {
        return res.status(404).json({ success: false, message: 'Fabric not found' });
    }
    Object.assign(fabric, req.body);
    await fabric.save(); // triggers the composition-sum-to-100 validator
    res.status(200).json({ success: true, data: fabric });
});

exports.deleteFabric = catchAsync(async (req, res) => {
    const fabric = await Fabric.findByIdAndDelete(req.params.id);
    if (!fabric) {
        return res.status(404).json({ success: false, message: 'Fabric not found' });
    }
    res.status(200).json({ success: true, message: 'Fabric deleted successfully' });
});

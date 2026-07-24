const Fabric = require('../models/fabric.model');
const { catchAsync } = require('../utils/errorHandler');
const { getOrSetCache, invalidateCache } = require('../utils/cache');

// Part B.5 - small, fixed-key list (no filter/sort variation like
// products), so a single direct cache key is enough; invalidated on write.
const CACHE_KEY = 'cache:fabrics:list';

exports.getAllFabrics = catchAsync(async (req, res) => {
    const responseBody = await getOrSetCache(CACHE_KEY, 300, async () => {
        const fabrics = await Fabric.find().sort({ name: 1 });
        return { success: true, data: fabrics };
    });
    res.status(200).json(responseBody);
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
    await invalidateCache(CACHE_KEY);
    res.status(201).json({ success: true, data: fabric });
});

exports.updateFabric = catchAsync(async (req, res) => {
    const fabric = await Fabric.findById(req.params.id);
    if (!fabric) {
        return res.status(404).json({ success: false, message: 'Fabric not found' });
    }
    Object.assign(fabric, req.body);
    await fabric.save(); // triggers the composition-sum-to-100 validator
    await invalidateCache(CACHE_KEY);
    res.status(200).json({ success: true, data: fabric });
});

exports.deleteFabric = catchAsync(async (req, res) => {
    const fabric = await Fabric.findByIdAndDelete(req.params.id);
    if (!fabric) {
        return res.status(404).json({ success: false, message: 'Fabric not found' });
    }
    await invalidateCache(CACHE_KEY);
    res.status(200).json({ success: true, message: 'Fabric deleted successfully' });
});

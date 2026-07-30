const Color = require('../models/color.model');
const { catchAsync } = require('../utils/errorHandler');
const { uploadToImageKit, deleteFromImageKit } = require('../utils/imageKitUpload');
const { getOrSetCache, invalidateCache } = require('../utils/cache');

// Part B.5 - see fabric.controller.js's identical comment.
const CACHE_KEY = 'cache:colors:list';
// Homepage color-tile carousel integration: a separate cache key for the
// `?featured=true` subset used by the storefront carousel, invalidated
// alongside CACHE_KEY on every mutation below so it never goes stale.
const FEATURED_CACHE_KEY = 'cache:colors:featured';
const invalidateColorCaches = () => Promise.all([invalidateCache(CACHE_KEY), invalidateCache(FEATURED_CACHE_KEY)]);

exports.getAllColors = catchAsync(async (req, res) => {
    if (req.query.featured === 'true') {
        const responseBody = await getOrSetCache(FEATURED_CACHE_KEY, 300, async () => {
            const colors = await Color.find({
                featuredOnHomepage: true,
                titleImageUrl: { $exists: true, $ne: '' }
            }).sort({ name: 1 });
            return { success: true, data: colors };
        });
        return res.status(200).json(responseBody);
    }

    const responseBody = await getOrSetCache(CACHE_KEY, 300, async () => {
        const colors = await Color.find().sort({ name: 1 });
        return { success: true, data: colors };
    });
    res.status(200).json(responseBody);
});

exports.getColor = catchAsync(async (req, res) => {
    const color = await Color.findById(req.params.id);
    if (!color) {
        return res.status(404).json({ success: false, message: 'Color not found' });
    }
    res.status(200).json({ success: true, data: color });
});

exports.createColor = catchAsync(async (req, res) => {
    const { name, hexCode, featuredOnHomepage } = req.body;
    if (!name || !hexCode) {
        return res.status(400).json({ success: false, message: 'name and hexCode are required' });
    }

    const colorData = { name, hexCode };
    if (featuredOnHomepage !== undefined) colorData.featuredOnHomepage = featuredOnHomepage === 'true' || featuredOnHomepage === true;

    if (req.file) {
        const result = await uploadToImageKit(req.file.path, 'colors');
        colorData.titleImageUrl = result.secure_url;
        colorData.imageKitFileId = result.fileId;
    }

    const color = await Color.create(colorData);
    await invalidateColorCaches();
    res.status(201).json({ success: true, data: color });
});

exports.updateColor = catchAsync(async (req, res) => {
    const color = await Color.findById(req.params.id);
    if (!color) {
        return res.status(404).json({ success: false, message: 'Color not found' });
    }

    if (req.body.name) color.name = req.body.name;
    if (req.body.hexCode) color.hexCode = req.body.hexCode;
    if (req.body.featuredOnHomepage !== undefined) {
        color.featuredOnHomepage = req.body.featuredOnHomepage === 'true' || req.body.featuredOnHomepage === true;
    }

    if (req.file) {
        // Replace the title image: upload the new one, then clean up the old
        // ImageKit asset so swatches don't leave orphaned files behind.
        const oldFileId = color.imageKitFileId;
        const result = await uploadToImageKit(req.file.path, 'colors');
        color.titleImageUrl = result.secure_url;
        color.imageKitFileId = result.fileId;
        if (oldFileId) {
            await deleteFromImageKit(oldFileId).catch((err) =>
                console.error('Failed to delete old color image from ImageKit:', err)
            );
        }
    }

    await color.save();
    await invalidateColorCaches();
    res.status(200).json({ success: true, data: color });
});

exports.deleteColor = catchAsync(async (req, res) => {
    const color = await Color.findByIdAndDelete(req.params.id);
    if (!color) {
        return res.status(404).json({ success: false, message: 'Color not found' });
    }
    if (color.imageKitFileId) {
        await deleteFromImageKit(color.imageKitFileId).catch((err) =>
            console.error('Failed to delete color image from ImageKit:', err)
        );
    }
    await invalidateColorCaches();
    res.status(200).json({ success: true, message: 'Color deleted successfully' });
});

const Color = require('../models/color.model');
const { catchAsync } = require('../utils/errorHandler');
const { uploadToImageKit, deleteFromImageKit } = require('../utils/imageKitUpload');
const { getOrSetCache, invalidateCache } = require('../utils/cache');

// Part B.5 - see fabric.controller.js's identical comment.
const CACHE_KEY = 'cache:colors:list';

exports.getAllColors = catchAsync(async (req, res) => {
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
    const { name, hexCode } = req.body;
    if (!name || !hexCode) {
        return res.status(400).json({ success: false, message: 'name and hexCode are required' });
    }

    const colorData = { name, hexCode };

    if (req.file) {
        const result = await uploadToImageKit(req.file.path, 'colors');
        colorData.titleImageUrl = result.secure_url;
        colorData.imageKitFileId = result.fileId;
    }

    const color = await Color.create(colorData);
    await invalidateCache(CACHE_KEY);
    res.status(201).json({ success: true, data: color });
});

exports.updateColor = catchAsync(async (req, res) => {
    const color = await Color.findById(req.params.id);
    if (!color) {
        return res.status(404).json({ success: false, message: 'Color not found' });
    }

    if (req.body.name) color.name = req.body.name;
    if (req.body.hexCode) color.hexCode = req.body.hexCode;

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
    await invalidateCache(CACHE_KEY);
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
    await invalidateCache(CACHE_KEY);
    res.status(200).json({ success: true, message: 'Color deleted successfully' });
});

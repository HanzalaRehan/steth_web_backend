const Category = require('../models/category.model');
const { catchAsync } = require('../utils/errorHandler');
const { getOrSetCache, invalidateCache } = require('../utils/cache');

// Part B.5 - see fabric.controller.js's identical comment.
const CACHE_KEY = 'cache:categories:list';

exports.getAllCategories = catchAsync(async (req, res) => {
    const responseBody = await getOrSetCache(CACHE_KEY, 300, async () => {
        const categories = await Category.find().sort({ name: 1 });
        return { success: true, data: categories };
    });
    res.status(200).json(responseBody);
});

exports.getCategory = catchAsync(async (req, res) => {
    const category = await Category.findById(req.params.id);
    if (!category) {
        return res.status(404).json({ success: false, message: 'Category not found' });
    }
    res.status(200).json({ success: true, data: category });
});

exports.createCategory = catchAsync(async (req, res) => {
    const category = await Category.create(req.body);
    await invalidateCache(CACHE_KEY);
    res.status(201).json({ success: true, data: category });
});

exports.updateCategory = catchAsync(async (req, res) => {
    const category = await Category.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true
    });
    if (!category) {
        return res.status(404).json({ success: false, message: 'Category not found' });
    }
    await invalidateCache(CACHE_KEY);
    res.status(200).json({ success: true, data: category });
});

exports.deleteCategory = catchAsync(async (req, res) => {
    const category = await Category.findByIdAndDelete(req.params.id);
    if (!category) {
        return res.status(404).json({ success: false, message: 'Category not found' });
    }
    await invalidateCache(CACHE_KEY);
    res.status(200).json({ success: true, message: 'Category deleted successfully' });
});

const Category = require('../models/category.model');
const { catchAsync } = require('../utils/errorHandler');

exports.getAllCategories = catchAsync(async (req, res) => {
    const categories = await Category.find().sort({ name: 1 });
    res.status(200).json({ success: true, data: categories });
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
    res.status(200).json({ success: true, data: category });
});

exports.deleteCategory = catchAsync(async (req, res) => {
    const category = await Category.findByIdAndDelete(req.params.id);
    if (!category) {
        return res.status(404).json({ success: false, message: 'Category not found' });
    }
    res.status(200).json({ success: true, message: 'Category deleted successfully' });
});

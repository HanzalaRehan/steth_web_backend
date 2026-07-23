const BlogPost = require('../models/blogPost.model');
const { catchAsync } = require('../utils/errorHandler');

exports.getAllBlogPosts = catchAsync(async (req, res) => {
    const posts = await BlogPost.find().sort({ publishedAt: -1 });
    res.status(200).json({ success: true, data: posts });
});

exports.getBlogPostBySlug = catchAsync(async (req, res) => {
    const post = await BlogPost.findOne({ slug: req.params.slug.toLowerCase() });
    if (!post) {
        return res.status(404).json({ success: false, message: 'Blog post not found' });
    }
    res.status(200).json({ success: true, data: post });
});

exports.createBlogPost = catchAsync(async (req, res) => {
    const post = await BlogPost.create(req.body);
    res.status(201).json({ success: true, data: post });
});

exports.updateBlogPost = catchAsync(async (req, res) => {
    const post = await BlogPost.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true
    });
    if (!post) {
        return res.status(404).json({ success: false, message: 'Blog post not found' });
    }
    res.status(200).json({ success: true, data: post });
});

exports.deleteBlogPost = catchAsync(async (req, res) => {
    const post = await BlogPost.findByIdAndDelete(req.params.id);
    if (!post) {
        return res.status(404).json({ success: false, message: 'Blog post not found' });
    }
    res.status(200).json({ success: true, message: 'Blog post deleted successfully' });
});

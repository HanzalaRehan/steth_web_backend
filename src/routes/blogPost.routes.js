const express = require('express');
const router = express.Router();
const { auth, isAdmin } = require('../middlewares/auth.middleware');
const {
    getAllBlogPosts,
    getBlogPostBySlug,
    createBlogPost,
    updateBlogPost,
    deleteBlogPost
} = require('../controllers/blogPost.controller');

// Public reads (blog list/detail pages), admin-only writes - same pattern as
// Fabric/Category/Color from Part B.1. No admin UI for these writes yet
// (deferred this session, see PROGRESS.md) - posts go in via these routes
// directly (curl/Postman/a script) until that follow-up lands.
router.get('/', getAllBlogPosts);
router.get('/:slug', getBlogPostBySlug);
router.post('/', auth, isAdmin, createBlogPost);
router.put('/:id', auth, isAdmin, updateBlogPost);
router.delete('/:id', auth, isAdmin, deleteBlogPost);

module.exports = router;

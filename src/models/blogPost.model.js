const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const blogPostSchema = new Schema({
    title: {
        type: String,
        required: [true, 'Title is required'],
        trim: true
    },
    slug: {
        type: String,
        required: [true, 'Slug is required'],
        trim: true,
        lowercase: true,
        unique: true
    },
    coverImage: String,
    body: {
        type: String,
        required: [true, 'Body is required']
    },
    publishedAt: {
        type: Date,
        default: Date.now
    },
    author: {
        type: String,
        required: [true, 'Author is required'],
        trim: true
    }
}, { timestamps: true });

module.exports = mongoose.model('BlogPost', blogPostSchema);

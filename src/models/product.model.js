const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const productSchema = new Schema({
    name: {
        type: String,
        required: [true, 'Product name is required'],
        trim: true
    },
    description: {
        type: String,
        required: [true, 'Product description is required']
    },
    price: {
        type: Number,
        required: [true, 'Product price is required'],
        min: [0, 'Price cannot be negative']
    },
    category: {
        type: String,
        required: [true, 'Product category is required'],
    },
    // New, optional reference to the Category collection (Part B.1) - the
    // string field above is untouched and stays the source of truth for
    // every existing read path; this is additive for new admin/relational
    // features only. See Steth_web_backend PROGRESS.md for why this isn't
    // a straight retype of `category`.
    categoryRef: {
        type: Schema.Types.ObjectId,
        ref: 'Category'
    },
    // New, optional reference to the Fabric collection (Part B.1).
    fabric: {
        type: Schema.Types.ObjectId,
        ref: 'Fabric'
    },
    gender: {
        type: String,
        required: [true, 'Gender specification is required'],
        enum: ['Men', 'Women', 'Unisex']
    },
    // Available colors (basic info)
    colors: [{
        name: String,
        code: String, // color hex code
        isAvailable: {
            type: Boolean,
            default: true
        }
    }],
    // New, optional references into the shared Color collection (Part B.1)
    // - `colors` above is untouched, this is additive for admin/relational
    // features (e.g. a future storefront "shop by color" swatch UI).
    colorRefs: [{
        type: Schema.Types.ObjectId,
        ref: 'Color'
    }],
    // Free-form descriptive attributes (Part B.1), e.g. "moisture-wicking".
    // Same {name, iconUrl} shape as Fabric.attributes for consistency.
    attributes: [{
        name: String,
        iconUrl: String
    }],
    // Per-color(+gender, for Unisex products) image sets (Part B.1). New
    // products populate this going forward; old products have an empty
    // array here and keep rendering via defaultImages/colorImages exactly
    // as before - see getImagesForColor below for the fallback logic.
    variants: [{
        color: String, // matches colors[].name convention, not a ref
        gender: String, // only meaningful when this product's gender is 'Unisex'
        images: [{
            url: String,
            alt: String,
            isPrimary: {
                type: Boolean,
                default: false
            },
            fileId: String
        }]
    }],
    // Available sizes (basic info)
    sizes: [{
        name: String,
        isAvailable: {
            type: Boolean,
            default: true
        }
    }],
    // Inventory tracking by color and size
    inventory: [{
        color: String,
        size: String,
        stock: {
            type: Number,
            default: 0
        }
    }],
    // Default product images
    defaultImages: [{
        url: String,
        alt: String,
        fileId: String // ImageKit file ID for asset tracking and deletion
    }],
    
    // Color-specific images
    colorImages: [{
        color: String,
        images: [{
            url: String,
            alt: String,
            isPrimary: {
                type: Boolean,
                default: false
            },
            fileId: String // ImageKit file ID for asset tracking and deletion
        }]
    }],
    // Total stock across all colors and sizes
    totalStock: {
        type: Number,
        default: 0
    },
    discount: {
        percentage: {
            type: Number,
            default: 0,
            min: [0, 'Discount percentage cannot be negative']
        },
        validUntil: Date
    },
    ratings: [{
        userId: {
            type: Schema.Types.ObjectId,
            ref: 'User'
        },
        rating: {
            type: Number,
            min: 1,
            max: 5
        },
        review: String,
        date: {
            type: Date,
            default: Date.now
        }
    }],
    averageRating: {
        type: Number,
        default: 0
    },
    isActive: {
        type: Boolean,
        default: true
    },
    material: {
        type: String
    },
    whatInBox: [{
        name: String,
        image: String
    }],
    relatedProducts: [{
        type: Schema.Types.ObjectId,
        ref: 'Product'
    }],
    // Modified field: boolean flag instead of array of references
    isCustomersAlsoBought: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

// Part B.5 - indexes matching getAllProducts' actual filter/sort
// combinations (audited from product.controller.js, not guessed).
// isActive is always present in the filter (getAllProducts hardcodes it),
// so it leads every compound index below.
productSchema.index({ isActive: 1, createdAt: -1 }); // default: active, newest-first, no other filter
productSchema.index({ isActive: 1, category: 1, createdAt: -1 }); // legacy string category filter
productSchema.index({ isActive: 1, gender: 1, createdAt: -1 }); // Men's/Women's pages
productSchema.index({ isActive: 1, categoryRef: 1 }); // Part B.1 ref-based category filter
productSchema.index({ isActive: 1, fabric: 1 }); // fabric filter
productSchema.index({ colorRefs: 1 }); // multikey - array-contains colorRefs filter
productSchema.index({ isCustomersAlsoBought: 1, isActive: 1 }); // getCustomersAlsoBoughtProducts
productSchema.index({ isActive: 1, totalStock: 1 }); // inStock==='true' filter

// Calculate average rating
productSchema.methods.calculateAverageRating = async function() {
    if (this.ratings.length === 0) {
        this.averageRating = 0;
        return;
    }
    
    const sum = this.ratings.reduce((acc, curr) => acc + curr.rating, 0);
    this.averageRating = sum / this.ratings.length;
    await this.save();
};

productSchema.methods.hasSufficientStock = function(color, size, quantity) {
    const inventoryItem = this.inventory.find(
        item => item.color === color && item.size === size
    );

    return inventoryItem && inventoryItem.stock >= quantity;
};

// Update stock for specific color and size
productSchema.methods.updateStock = async function(color, size, quantity) {
    const inventoryItem = this.inventory.find(
        item => item.color === color && item.size === size
    );
    
    if (!inventoryItem) {
        throw new Error('Color and size combination not found');
    }
    
    if (inventoryItem.stock + quantity < 0) {
        throw new Error('Insufficient stock');
    }
    
    inventoryItem.stock += quantity;
    
    // Update total stock
    this.totalStock += quantity;
    
    await this.save();
};

// Recalculate total stock based on inventory
productSchema.methods.recalculateTotalStock = async function() {
    this.totalStock = this.inventory.reduce((total, item) => total + item.stock, 0);
    await this.save();
};

// Add a new method to get images for a specific color
// `gender` is only relevant for Unisex products with separate per-gender
// variant image sets (Part B.1) - omit it for Men/Women products.
productSchema.methods.getImagesForColor = function(color, gender) {
    if (this.variants && this.variants.length > 0) {
        const variant = this.variants.find(v =>
            v.color === color && (!gender || v.gender === gender)
        );
        if (variant && variant.images && variant.images.length > 0) {
            return variant.images;
        }
    }

    // Fall back to the legacy per-color/default images every existing
    // product already has - keeps old products (and new ones that haven't
    // populated `variants`) rendering exactly as before.
    const colorImageSet = this.colorImages.find(ci => ci.color === color);
    return colorImageSet ? colorImageSet.images : this.defaultImages;
};

// New method: Set product as "Customers Also Bought"
productSchema.methods.setAsCustomersAlsoBought = async function(status = true) {
    this.isCustomersAlsoBought = status;
    await this.save();
    return this;
};

const Product = mongoose.model('Product', productSchema);

// Static method to fetch all products marked as "Customers Also Bought"
Product.getCustomersAlsoBoughtProducts = async function(limit = 10) {
    return await this.find({ isCustomersAlsoBought: true, isActive: true })
                    .limit(limit)
                    .select('name price description defaultImages colors sizes discount averageRating');
};

module.exports = Product;
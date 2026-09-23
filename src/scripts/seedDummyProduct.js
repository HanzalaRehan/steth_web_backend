// One-time seed: this dev DB has zero Products/Categories/Colors/Fabrics
// (confirmed via GET /api/categories, /api/colors, /api/fabrics, /api/products
// all returning empty arrays), which meant every filter/sort/pagination/
// best-sellers feature built this session had nothing real to render
// against. Creates one real, fully-specified dummy product - with a real
// Category, Color (with hex), and Fabric (composition summing to 100%),
// real product photography uploaded through the existing ImageKit pipeline
// (not a placeholder image), inventory across two sizes, and
// isBestSeller:true so the just-built Best Sellers carousel has something
// to show too.
//
// Upserts by name, so re-running this is safe - it won't create duplicates.
//
// Run with: node src/scripts/seedDummyProduct.js
require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const Product = require('../models/product.model');
const Category = require('../models/category.model');
const Fabric = require('../models/fabric.model');
const Color = require('../models/color.model');
const { imagekit } = require('../config/imageKit');

const IMAGE_PATH = path.resolve(
  __dirname,
  '../../../Steth_web_frontend/src/assets/Mens/products/men_product_01_img_01.png'
);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const category = await Category.findOneAndUpdate(
    { name: 'Scrubs' },
    { name: 'Scrubs' },
    { upsert: true, new: true }
  );

  const fabric = await Fabric.findOneAndUpdate(
    { name: 'Performance Stretch Twill' },
    {
      name: 'Performance Stretch Twill',
      composition: [
        { material: 'Polyester', percentage: 72 },
        { material: 'Spandex', percentage: 28 },
      ],
      attributes: [{ name: '4-Way Stretch', iconUrl: '' }],
    },
    { upsert: true, new: true }
  );

  const color = await Color.findOneAndUpdate(
    { name: 'Sunshine Yellow' },
    { name: 'Sunshine Yellow', hexCode: '#F5E050' },
    { upsert: true, new: true }
  );

  const existing = await Product.findOne({ name: 'STETH Classic V-Neck Scrub Top' });
  if (existing) {
    console.log(`Product already exists (id ${existing._id}), not creating a duplicate.`);
    await mongoose.disconnect();
    return;
  }

  if (!fs.existsSync(IMAGE_PATH)) {
    throw new Error(`Image not found at ${IMAGE_PATH}`);
  }

  const uploadResult = await imagekit.upload({
    file: fs.readFileSync(IMAGE_PATH),
    fileName: 'men_product_01_img_01.png',
    folder: 'products/seed-dummy',
    useUniqueFileName: true,
  });

  const product = await Product.create({
    name: 'STETH Classic V-Neck Scrub Top',
    description:
      'Our signature V-neck scrub top - soft, breathable performance twill with a 4-way stretch fit built for long shifts. Features a chest pocket with a reflective STETH tab.',
    price: 3599,
    category: category.name,
    categoryRef: category._id,
    fabric: fabric._id,
    gender: 'Men',
    colors: [{ name: color.name, code: color.hexCode, isAvailable: true }],
    colorRefs: [color._id],
    sizes: [
      { name: 'M', isAvailable: true },
      { name: 'L', isAvailable: true },
    ],
    inventory: [
      { color: color.name, size: 'M', stock: 25 },
      { color: color.name, size: 'L', stock: 18 },
    ],
    defaultImages: [{ url: uploadResult.url, alt: 'STETH Classic V-Neck Scrub Top', fileId: uploadResult.fileId }],
    totalStock: 43,
    isActive: true,
    isBestSeller: true,
  });

  console.log(`Created product ${product._id} - "${product.name}"`);
  console.log(`Category: ${category.name} (${category._id})`);
  console.log(`Fabric: ${fabric.name} (${fabric._id})`);
  console.log(`Color: ${color.name} ${color.hexCode} (${color._id})`);
  console.log(`Image: ${uploadResult.url}`);

  await mongoose.disconnect();
})();

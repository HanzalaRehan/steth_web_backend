// One-time seed for the Homepage/Men's/Women's hero sections: this dev DB
// has zero HeroImage documents for any pageType, which meant the frontend's
// hero fetch (GET /api/hero-images/<page>) returned {success:true,
// data:{web:undefined, mobile:undefined}} - success, but no actual image -
// and the frontend crashed trying to read `.imageUrl` off `undefined`
// (fixed separately in the frontend). This script uploads real, existing
// product photography (from Steth_web_frontend/src/assets - not invented
// placeholders) through the same ImageKit pipeline the admin upload flow
// uses, then writes the matching HeroImage docs - only for
// pageType/viewType combinations that don't already have one, so it never
// overwrites a real admin-uploaded image.
//
// Run with: node src/scripts/seedHeroImages.js
require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const HeroImage = require('../models/HeroImage');
const { imagekit } = require('../config/imageKit');

const ASSETS_DIR = path.resolve(__dirname, '../../../Steth_web_frontend/src/assets');

// One real asset per page - reused for both web/mobile viewTypes (the
// existing Hero components already crop via object-cover/object-center for
// different aspect ratios, matching how every other hero image on this site
// already works).
const SEED_MAP = {
  home: 'final_back.jpg',   // mixed group, wide panoramic - matches the homepage's full-bleed treatment
  mens: 'Scrubs1.jpeg',     // men-forward editorial shot
  womens: 'back2.jpeg',     // women-forward shot
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const existing = await HeroImage.find({ pageType: { $in: Object.keys(SEED_MAP) } });
  const existingKey = (doc) => `${doc.pageType}:${doc.viewType}`;
  const existingSet = new Set(existing.map(existingKey));

  let uploaded = 0;
  let skipped = 0;

  for (const [pageType, filename] of Object.entries(SEED_MAP)) {
    const filePath = path.join(ASSETS_DIR, filename);
    if (!fs.existsSync(filePath)) {
      console.log(`SKIP ${pageType}: asset not found at ${filePath}`);
      continue;
    }

    for (const viewType of ['web', 'mobile']) {
      const key = `${pageType}:${viewType}`;
      if (existingSet.has(key)) {
        console.log(`SKIP ${key}: HeroImage already exists, not overwriting`);
        skipped++;
        continue;
      }

      const result = await imagekit.upload({
        file: fs.readFileSync(filePath),
        fileName: filename,
        folder: `hero-images/${pageType}`,
        useUniqueFileName: true,
      });

      await HeroImage.findOneAndUpdate(
        { pageType, viewType },
        { imageUrl: result.url, imagekitId: result.fileId },
        { upsert: true, new: true }
      );

      console.log(`UPLOADED ${key} <- ${filename} -> ${result.url}`);
      uploaded++;
    }
  }

  console.log(`\nDone. Uploaded ${uploaded}, skipped ${skipped} (already existed).`);
  await mongoose.disconnect();
})();

// One-time migration for "Integrate color tiles with the Color entity":
// folds the old, separate ColorTile collection (which only ever powered the
// homepage carousel) into Color.featuredOnHomepage, so admins stop having
// to enter the same color twice through two different upload flows.
//
// For each ColorTile, finds a Color by case-insensitive name match:
//   - match found, no existing titleImageUrl -> backfill titleImageUrl/
//     imageKitFileId from the tile, set featuredOnHomepage: true
//   - match found, already has an image -> don't overwrite the product
//     swatch image, just set featuredOnHomepage: true
//   - no match -> don't auto-create (Color.hexCode is required and
//     ColorTile never captured one - inventing a placeholder hex would be
//     silently-wrong data). Logged so the admin creates it manually via the
//     Colors screen, where picking a real hex is unavoidable anyway.
//
// Does NOT delete ColorTile docs or drop the collection - review the
// summary output first, then remove ColorTile's model/controller/routes
// separately once the migration looks right.
//
// Run with: node src/scripts/migrateColorTilesToColors.js
require('dotenv').config();
const mongoose = require('mongoose');
const ColorTile = require('../models/ColorTile');
const Color = require('../models/color.model');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const tiles = await ColorTile.find();
  console.log(`Found ${tiles.length} ColorTile document(s) to migrate.`);

  let backfilled = 0;
  let flaggedOnly = 0;
  const needsManualCreation = [];

  for (const tile of tiles) {
    const match = await Color.findOne({ name: new RegExp(`^${tile.colorName.trim()}$`, 'i') });

    if (!match) {
      needsManualCreation.push(tile.colorName);
      continue;
    }

    if (!match.titleImageUrl) {
      match.titleImageUrl = tile.imageUrl;
      match.imageKitFileId = tile.imagekitId;
      match.featuredOnHomepage = true;
      await match.save();
      backfilled += 1;
      console.log(`Backfilled image + featured Color "${match.name}" from ColorTile "${tile.colorName}".`);
    } else {
      match.featuredOnHomepage = true;
      await match.save();
      flaggedOnly += 1;
      console.log(`Color "${match.name}" already had an image - kept it, just flagged featuredOnHomepage.`);
    }
  }

  console.log('\n--- Migration summary ---');
  console.log(`Backfilled (image + flag set): ${backfilled}`);
  console.log(`Flagged only (existing image kept): ${flaggedOnly}`);
  console.log(`Needs manual creation (no matching Color, hexCode required): ${needsManualCreation.length}`);
  if (needsManualCreation.length > 0) {
    console.log('  Create these via the admin Colors screen and mark them featured:');
    needsManualCreation.forEach((name) => console.log(`    - ${name}`));
  }
  console.log('\nColorTile documents were NOT deleted. Review the above, then retire the ColorTile model/controller/routes separately.');

  await mongoose.disconnect();
})();

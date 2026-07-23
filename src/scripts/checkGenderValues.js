// Read-only check for Part B.1's gender enum narrowing
// (['Men','Women','Unisex','Male','Female'] -> ['Men','Women','Unisex']).
// Reports any existing products using the removed 'Male'/'Female' values -
// does not modify anything. Run with: node src/scripts/checkGenderValues.js
require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../models/product.model');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const affected = await Product.find(
    { gender: { $in: ['Male', 'Female'] } },
    { name: 1, gender: 1 }
  );

  if (affected.length === 0) {
    console.log("No products use the removed 'Male'/'Female' gender values. Safe as-is.");
  } else {
    console.log(`${affected.length} product(s) use a removed gender value - these will fail validation if re-saved without first correcting gender to 'Men'/'Women'/'Unisex':`);
    affected.forEach((p) => console.log(`  ${p._id}  "${p.name}"  gender=${p.gender}`));
  }

  await mongoose.disconnect();
})();

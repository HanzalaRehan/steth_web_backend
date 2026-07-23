const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const fabricSchema = new Schema({
    name: {
        type: String,
        required: [true, 'Fabric name is required'],
        trim: true
    },
    composition: [{
        material: { type: String, required: true },
        percentage: { type: Number, required: true, min: 0, max: 100 }
    }],
    attributes: [{
        name: String,
        iconUrl: String
    }]
}, { timestamps: true });

// Composition percentages must sum to 100 (within floating-point tolerance)
// whenever the array is non-empty - matches the running-total builder in the
// admin form, but enforced here too as the real safety net.
fabricSchema.pre('validate', function(next) {
    if (this.composition && this.composition.length > 0) {
        const total = this.composition.reduce((sum, item) => sum + (item.percentage || 0), 0);
        if (Math.abs(total - 100) > 0.01) {
            return next(new Error(`Fabric composition must sum to 100% (currently ${total}%)`));
        }
    }
    next();
});

module.exports = mongoose.model('Fabric', fabricSchema);

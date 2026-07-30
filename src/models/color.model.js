const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const colorSchema = new Schema({
    name: {
        type: String,
        required: [true, 'Color name is required'],
        trim: true,
        unique: true
    },
    hexCode: {
        type: String,
        required: [true, 'Hex code is required']
    },
    titleImageUrl: String,
    imageKitFileId: String, // for asset tracking/deletion, matching Product.defaultImages' fileId convention
    // Homepage color-tile carousel integration: admin opts a color into the
    // carousel here instead of the old separate ColorTile entity/screen.
    featuredOnHomepage: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

module.exports = mongoose.model('Color', colorSchema);

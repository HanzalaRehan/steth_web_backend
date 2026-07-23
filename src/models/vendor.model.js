const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const vendorSchema = new Schema({
    name: {
        type: String,
        required: [true, 'Vendor name is required'],
        trim: true
    },
    contactName: String,
    email: String,
    phone: String,
    address: String
}, { timestamps: true });

module.exports = mongoose.model('Vendor', vendorSchema);

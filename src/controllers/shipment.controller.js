const mongoose = require('mongoose');
const Shipment = require('../models/shipment.model');
const Product = require('../models/product.model');
const { catchAsync } = require('../utils/errorHandler');
const { bumpCacheVersion } = require('../utils/cache');

exports.getAllShipments = catchAsync(async (req, res) => {
    const shipments = await Shipment.find()
        .populate('vendor', 'name')
        .populate('receivedBy', 'username')
        .populate('lineItems.product', 'name')
        .sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: shipments });
});

exports.getShipment = catchAsync(async (req, res) => {
    const shipment = await Shipment.findById(req.params.id)
        .populate('vendor')
        .populate('receivedBy', 'username')
        .populate('lineItems.product', 'name');
    if (!shipment) {
        return res.status(404).json({ success: false, message: 'Shipment not found' });
    }
    res.status(200).json({ success: true, data: shipment });
});

// Receiving a shipment atomically increments matching inventory, creating
// the inventory row if it doesn't exist yet (Part B.1). There's no
// separate draft/receive step in the spec - creating a Shipment IS
// receiving it.
exports.receiveShipment = catchAsync(async (req, res) => {
    const { vendor, lineItems } = req.body;

    if (!vendor || !Array.isArray(lineItems) || lineItems.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'vendor and at least one line item are required'
        });
    }

    for (const item of lineItems) {
        if (!item.product || !item.color || !item.size || !item.pieces || item.pieces < 1) {
            return res.status(400).json({
                success: false,
                message: 'Each line item requires product, color, size, and pieces (>= 1)'
            });
        }
    }

    // Smart shipment ID: SHIP-YYYYMMDD-xxx, same pattern order.controller.js
    // uses for orderId.
    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
    const todayShipmentCount = await Shipment.countDocuments({
        createdAt: { $gte: startOfDay, $lt: endOfDay }
    });
    const shipmentId = `SHIP-${dateStr}-${String(todayShipmentCount + 1).padStart(3, '0')}`;

    const session = await mongoose.startSession();
    let savedShipment;

    try {
        await session.withTransaction(async () => {
            for (const item of lineItems) {
                const { product: productId, color, size, pieces } = item;

                const productExists = await Product.exists({ _id: productId }).session(session);
                if (!productExists) {
                    throw new Error(`Product ${productId} not found`);
                }

                // Try to increment an existing color/size row atomically.
                const incResult = await Product.updateOne(
                    { _id: productId, 'inventory.color': color, 'inventory.size': size },
                    { $inc: { 'inventory.$.stock': pieces, totalStock: pieces } },
                    { session }
                );

                if (incResult.matchedCount === 0) {
                    // No row for this color/size yet - create one atomically
                    // instead (per the spec: "creating the inventory record
                    // if it doesn't exist yet").
                    await Product.updateOne(
                        { _id: productId },
                        {
                            $push: { inventory: { color, size, stock: pieces } },
                            $inc: { totalStock: pieces }
                        },
                        { session }
                    );
                }
            }

            const [shipment] = await Shipment.create(
                [{
                    shipmentId,
                    vendor,
                    lineItems,
                    receivedAt: new Date(),
                    receivedBy: req.user._id
                }],
                { session }
            );
            savedShipment = shipment;
        });
    } finally {
        await session.endSession();
    }

    // Part B.5 - receiving a shipment mutates Product.inventory/totalStock
    // directly (see Product.updateOne calls above), same version-namespace
    // as product.controller.js's cached listings/details.
    await bumpCacheVersion('products');

    res.status(201).json({ success: true, data: savedShipment });
});

exports.deleteShipment = catchAsync(async (req, res) => {
    // Deleting a shipment record does NOT reverse its inventory increment -
    // this is a record-keeping delete only (matches how the rest of this
    // codebase treats historical records - e.g. deleting an Order doesn't
    // exist at all, cancelling one restores stock explicitly instead).
    // If you need to undo a bad shipment's inventory effect, adjust stock
    // manually via the Inventory tab's existing updateInventory endpoint.
    const shipment = await Shipment.findByIdAndDelete(req.params.id);
    if (!shipment) {
        return res.status(404).json({ success: false, message: 'Shipment not found' });
    }
    res.status(200).json({ success: true, message: 'Shipment record deleted (inventory not reversed)' });
});

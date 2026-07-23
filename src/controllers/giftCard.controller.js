const GiftCard = require('../models/giftCard.model');
const { catchAsync } = require('../utils/errorHandler');

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// Guest-purchasable, matching how checkout already supports guest orders.
// This route carries no auth middleware (this codebase has no "populate
// req.user if a token happens to be present, else continue" variant - the
// existing order-creation routes solve the same guest-vs-logged-in split
// with two separate routes instead), so purchaserId is always null for now.
exports.purchaseGiftCard = catchAsync(async (req, res) => {
    const { amount, recipientEmail, note } = req.body;

    if (!amount || Number(amount) < 1) {
        return res.status(400).json({ success: false, message: 'A valid amount is required' });
    }
    if (!recipientEmail) {
        return res.status(400).json({ success: false, message: 'Recipient email is required' });
    }

    const giftCard = await GiftCard.create({
        initialBalance: Number(amount),
        currentBalance: Number(amount),
        purchaserId: req.user ? req.user._id : null,
        recipientEmail,
        expiryDate: new Date(Date.now() + ONE_YEAR_MS)
    });

    res.status(201).json({
        success: true,
        message: 'Gift card purchased successfully',
        data: {
            code: giftCard.code,
            initialBalance: giftCard.initialBalance,
            recipientEmail: giftCard.recipientEmail,
            expiryDate: giftCard.expiryDate,
            note: note || ''
        }
    });
});

// Read-only check, shaped so a future discount-code validation endpoint can
// follow the same {valid, ...} response contract.
exports.validateGiftCard = catchAsync(async (req, res) => {
    const { code } = req.body;

    if (!code) {
        return res.status(400).json({ success: false, message: 'Gift card code is required' });
    }

    const giftCard = await GiftCard.findOne({ code: code.toUpperCase().trim() });

    if (!giftCard) {
        return res.status(200).json({ success: true, valid: false, message: 'Gift card not found' });
    }
    if (!giftCard.isActive) {
        return res.status(200).json({ success: true, valid: false, message: 'Gift card is no longer active' });
    }
    if (giftCard.expiryDate < new Date()) {
        return res.status(200).json({ success: true, valid: false, message: 'Gift card has expired' });
    }
    if (giftCard.currentBalance <= 0) {
        return res.status(200).json({ success: true, valid: false, message: 'Gift card has no remaining balance' });
    }

    res.status(200).json({
        success: true,
        valid: true,
        giftCardId: giftCard._id,
        availableBalance: giftCard.currentBalance
    });
});

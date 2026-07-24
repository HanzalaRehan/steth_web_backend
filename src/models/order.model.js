// models/order.model.js
const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  orderId: {
    type: String,
    unique: true,
    sparse: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false // Allow guest orders
  },
  items: [{
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },
    productName: {
      type: String,
      required: true
    },
    color: {
      type: String,
      required: true
    },
    size: {
      type: String,
      required: true
    },
    quantity: {
      type: Number,
      required: true,
      min: 1
    },
    price: {
      type: Number,
      required: true,
      min: 0
    }
  }],
  shippingAddress: {
    fullName: {
      type: String,
      required: true
    },
    addressLine1: {
      type: String,
      required: true
    },
    addressLine2: {
      type: String
    },
    city: {
      type: String,
      required: true
    },
    state: {
      type: String,
      default: 'N/A'
    },
    postalCode: {
      type: String,
      default: '00000'
    },
    country: {
      type: String,
      default: 'Pakistan'
    },
    phoneNumber: {
      type: String,
      required: true
    }
  },
  subtotal: {
    type: Number,
    required: true,
    min: 0
  },
  discount: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },
  discountCode: {
    type: String,
    default: ''
  },
  giftCardCode: {
    type: String,
    default: ''
  },
  giftCardAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  shippingCharges: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },
  total: {
    type: Number,
    required: true,
    min: 0
  },
  pointsUsed: {
    type: Number,
    default: 0,
    min: 0
  },
  pointsEarned: {
    type: Number,
    default: 0,
    min: 0
  },
  paymentMethod: {
    type: String,
    required: true,
    enum: ['cash-on-delivery', 'bank-transfer', 'card']
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'failed'],
    default: 'pending'
  },
  paymentReceipt: {
    url: String,
    public_id: String,
    uploaded: {
      type: Boolean,
      default: false
    }
  },
  orderStatus: {
    type: String,
    enum: ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'],
    default: 'Pending'
  },
  // Issue #18 - one entry per transition, pushed in createOrder (initial),
  // updateOrderStatus, and cancelOrder. Orders created before this field
  // existed simply hydrate as [] (Mongoose's default array behavior) -
  // getUserOrders/getOrderById synthesize a single fallback entry from
  // orderStatus/createdAt for those, no migration script needed.
  statusHistory: [{
    status: {
      type: String,
      enum: ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled']
    },
    changedAt: {
      type: Date,
      default: Date.now
    }
  }],
  isFirstOrder: {
    type: Boolean,
    default: false
  },
  trackingNumber: {
    type: String
  },
  // Order management admin session - set by the label-generation endpoint,
  // which also auto-advances orderStatus to 'Processing'.
  shippingLabel: {
    url: String,
    generatedAt: Date
  },
  estimatedDelivery: {
    type: Date
  },
  deliveredAt: {
    type: Date
  },
  cancelledAt: {
    type: Date
  },
  cancellationReason: {
    type: String
  },
  customerEmail: {
    type: String,
    required: true
  }
}, {
  timestamps: true
});

// Index for efficient queries
orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ orderStatus: 1 });
orderSchema.index({ paymentStatus: 1 });

// Virtual for formatted order ID
orderSchema.virtual('formattedId').get(function() {
  return `ORD-${this._id.toString().slice(-8).toUpperCase()}`;
});

// Pre-save middleware to validate total calculation
orderSchema.pre('save', function(next) {
  const calculatedTotal = this.subtotal - this.discount + this.shippingCharges;
  
  // Allow small floating point differences (1 cent tolerance)
  if (Math.abs(calculatedTotal - this.total) > 0.01) {
    const err = new Error(`Total amount mismatch. Expected: ${calculatedTotal}, Got: ${this.total}`);
    return next(err);
  }
  
  next();
});

module.exports = mongoose.model('Order', orderSchema);
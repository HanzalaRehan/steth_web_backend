const Order = require('../models/order.model');
const User = require('../models/user.model');
const Product = require('../models/product.model');
const GiftCard = require('../models/giftCard.model');
const StudentVerification = require('../models/student.model');
const { uploadToImageKit } = require('../utils/imageKitUpload');
const { generateLabel } = require('../services/labelService');
const AnalyticsSession = require('../models/analyticsSession.model');
const { findValidDiscountCode, computeCodeDiscount } = require('../utils/discountCodeService');
const { calculateDiscount } = require('../utils/discountService');

const { 
  sendVerificationRequestEmail, 
  sendVerificationResultEmail,
  sendNewOrderEmailToAdmin,
  sendOrderConfirmationToCustomer,
  sendOrderStatusUpdateToCustomer
} = require('../utils/emailService');

const { bumpCacheVersion } = require('../utils/cache');

// Part B.5 - checkout (createOrder) and cancellation (cancelSingleOrder)
// both mutate Product.inventory/totalStock directly, which the cached
// product listings/details (product.controller.js) need to invalidate on -
// same version-namespace as that controller's own invalidateProductCaches.
const invalidateProductCaches = () => bumpCacheVersion('products');

const calculatePoints = (amount) => {
  // 1 point for every 100 PKR
  return Math.floor(amount / 100);
};

// Shared by the single-order updateOrderStatus route and the bulk-update
// route below, so both push the same statusHistory entry and send the same
// email instead of the bulk path silently skipping either (which a raw
// updateMany would do).
const updateSingleOrderStatus = async (orderId, status, trackingNumber) => {
  const order = await Order.findById(orderId).populate('user', 'email');

  if (!order) {
    return { success: false, orderId, message: 'Order not found' };
  }

  if (trackingNumber) {
    order.trackingNumber = trackingNumber;
  }

  const statusChanged = order.orderStatus !== status;
  order.orderStatus = status;

  if (statusChanged) {
    order.statusHistory.push({ status, changedAt: new Date() });
  }

  const updatedOrder = await order.save();

  if (statusChanged) {
    const emailToSend = order.customerEmail || order.user?.email;
    if (emailToSend) {
      try {
        await sendOrderStatusUpdateToCustomer(updatedOrder, emailToSend);
      } catch (emailError) {
        console.log('Status update email failed, but order was updated:', emailError);
      }
    }
  }

  return { success: true, orderId, order: updatedOrder };
};

// Shared by the single-order cancelOrder route and bulkUpdateOrderStatus
// below (when status === 'Cancelled') - cancellation has real side effects
// (inventory return, points reversal) a plain status flip doesn't, so bulk
// cancel needs this exact logic per order, not the generic
// updateSingleOrderStatus helper above.
const cancelSingleOrder = async (orderId, requestingUser) => {
  const order = await Order.findById(orderId).populate('user', 'email');

  if (!order) {
    return { success: false, orderId, status: 404, message: 'Order not found' };
  }

  if (!order.user || (requestingUser.role !== 'admin' && order.user._id.toString() !== requestingUser._id.toString())) {
    return { success: false, orderId, status: 403, message: 'Not authorized to cancel this order' };
  }

  if (!['Pending', 'Processing'].includes(order.orderStatus)) {
    return { success: false, orderId, status: 400, message: `Cannot cancel order with status: ${order.orderStatus}` };
  }

  order.orderStatus = 'Cancelled';
  order.statusHistory.push({ status: 'Cancelled', changedAt: new Date() });

  for (const item of order.items) {
    const product = await Product.findById(item.product);
    if (product) {
      const inventoryItem = product.inventory.find(inv =>
        inv.color === item.color && inv.size === item.size
      );
      if (inventoryItem) {
        inventoryItem.stock += item.quantity;
        product.totalStock += item.quantity;
        await product.save();
      }
    }
  }

  // Part B.5 - cancellation restores stock, which the cached product
  // listings/details (isActive+totalStock filter, etc.) need to reflect.
  // Once per cancellation, not per item - cheap Redis INCR either way.
  if (order.items.length > 0) await invalidateProductCaches();

  if (order.pointsUsed > 0 || order.pointsEarned > 0) {
    const user = await User.findById(order.user._id);
    if (user) {
      user.rewardPoints = user.rewardPoints + order.pointsUsed - order.pointsEarned;
      await user.save();
    }
  }

  const cancelledOrder = await order.save();

  if (order.user && order.user.email) {
    try {
      await sendOrderStatusUpdateToCustomer(cancelledOrder, order.user.email);
    } catch (emailError) {
      console.log('Cancellation email failed, but order was cancelled:', emailError);
    }
  }

  return { success: true, orderId, order: cancelledOrder };
};

const orderController = {
    createOrder: async (req, res) => {
      try {
        let orderData;
        
        // If we have a file upload (for bank transfer), the order data will be in req.body.orderData as JSON string
        if (req.file && req.body.orderData) {
          orderData = JSON.parse(req.body.orderData);
        } else {
          // Regular JSON request (cash on delivery)
          orderData = req.body;
        }
        
        // Extract fields from orderData
        const { 
          customerInfo,
          items,
          shippingAddress,
          subtotal,
          shippingCharges = 0, // ADD THIS LINE - Extract shipping charges
          total,
          discount,
          discountCode = '', // note: unused - retained only for existing request-body shape compat
          discountCodeInput = '', // Part B.4 - plaintext DiscountCode entered at checkout
          discountInfo = {
            amount: 0,
            reasons: [],
            pointsUsed: 0
          },
          giftCardCode = '',
          giftCardAmountApplied = 0,
          paymentMethod
        } = orderData;

        const userId = req.user ? req.user._id : null;

        // Validate items in order
        if (!items || !items.length) {
          return res.status(400).json({
            success: false,
            message: 'No items in order'
          });
        }

        // Gift card: mirrors the reward-points pattern (bounded, checked
        // amount folded into the order's discount math client-side already
        // - see discountInfo.amount) but re-validated here since it's real
        // transferable balance, unlike the points/discount numbers this
        // function otherwise trusts as-is from the request body. Fail fast
        // rather than create an order with a discount that can't actually
        // be redeemed against the card.
        let giftCard = null;
        if (giftCardCode) {
          giftCard = await GiftCard.findOne({ code: giftCardCode.toUpperCase().trim() });
          if (!giftCard || !giftCard.isActive || giftCard.expiryDate < new Date()) {
            return res.status(400).json({
              success: false,
              message: 'Gift card is no longer valid'
            });
          }
          if (Number(giftCardAmountApplied) > giftCard.currentBalance) {
            return res.status(400).json({
              success: false,
              message: 'Gift card balance is lower than the applied amount'
            });
          }
        }

        // Discount code (Part B.4) - real admin-defined value, re-validated
        // server-side the same way the gift card is above rather than
        // trusting discountInfo.amount alone. Only engaged when a code was
        // actually entered; the no-code path below is completely unchanged.
        let matchedDiscountCode = null;
        if (discountCodeInput) {
          matchedDiscountCode = await findValidDiscountCode(discountCodeInput);
          if (!matchedDiscountCode) {
            return res.status(400).json({
              success: false,
              message: 'Discount code is invalid, expired, or no longer active'
            });
          }
        }

        // Get user for points information if user is logged in
        let user = null;
        if (userId) {
          user = await User.findById(userId);
        }
        
        // Validate points usage if user is logged in
        const pointsToUse = Number(discountInfo.pointsUsed) || 0;
        
        if (user && pointsToUse > user.rewardPoints) {
          return res.status(400).json({ 
            success: false, 
            message: `Cannot use more points than available. You have ${user.rewardPoints} points.` 
          });
        }
        
        // Process each item and update inventory
        const processedItems = [];
        
        for (const item of items) {
          const product = await Product.findById(item.product);
          if (!product) {
            return res.status(404).json({
              success: false,
              message: `Product ${item.product} not found`
            });
          }
        
          // Find matching inventory item
          const inventoryItem = product.inventory.find(inv =>
            inv.color === item.color && inv.size === item.size
          );
        
          if (!inventoryItem || inventoryItem.stock < item.quantity) {
            return res.status(400).json({
              success: false,
              message: `${product.name} is out of stock or has insufficient quantity`
            });
          }
        
          // Add to processed items with product name for email purposes
          processedItems.push({
            product: product._id,
            productName: product.name,
            color: item.color,
            size: item.size,
            quantity: item.quantity,
            price: item.price
          });
        
          // Deduct stock from inventory
          inventoryItem.stock -= item.quantity;
          product.totalStock -= item.quantity;

          await product.save();
        }

        // Part B.5 - checkout deducts stock, which cached product
        // listings/details need to reflect. Once per order, not per item.
        if (items.length > 0) await invalidateProductCaches();

        // Calculate points earned from this order (based on the final total price, not subtotal)
        const pointsEarned = calculatePoints(total);
        
        // Determine if this is the first order (only if user is logged in)
        let isFirstOrder = false;
        if (userId) {
          const orderCount = await Order.countDocuments({ user: userId });
          isFirstOrder = orderCount === 0;
        }
        
        // Handle payment receipt for bank transfer
        let receiptData = null;
        if (paymentMethod === 'bank-transfer') {
          // Check if receipt file was uploaded
          if (!req.file) {
            return res.status(400).json({
              success: false,
              message: 'Payment receipt is required for bank transfers'
            });
          }
          
          // Upload receipt to ImageKit
          const imagekitFolder = `order-payment/${userId || 'guest'}`;
          const result = await uploadToImageKit(req.file.path, imagekitFolder);
          
          receiptData = {
            url: result.secure_url,
            public_id: result.public_id,
            uploaded: true
          };
        }
  
        // Generate smart order ID: YYYYMMDD-xxx
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const dateStr = `${year}${month}${day}`;
        
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
        const todayOrderCount = await Order.countDocuments({
          createdAt: { $gte: startOfDay, $lt: endOfDay }
        });
        
        const orderNumber = String(todayOrderCount + 1).padStart(3, '0');
        const orderId = `${dateStr}-${orderNumber}`;

        // Decision (B.4): mutually exclusive, best-of-two between the
        // automatic discount and an entered code - recomputed here (not
        // just trusted from discountInfo.amount) only when a code was
        // actually used, closing the preview/purchase gap if it expired or
        // was deactivated in between. The no-code path is untouched: it
        // keeps trusting `discount`/`discountInfo.reasons` from the client
        // exactly as before.
        let finalDiscountAmount = Number(discount);
        let finalDiscountReason = discountInfo.reasons ? discountInfo.reasons.join(', ') : '';

        if (matchedDiscountCode) {
          const codeAmount = computeCodeDiscount(matchedDiscountCode, Number(subtotal));
          const automaticAmount = userId
            ? (await calculateDiscount(userId, Number(subtotal))).amount
            : 0;

          if (codeAmount > automaticAmount) {
            finalDiscountAmount = codeAmount;
            finalDiscountReason = `Discount code: ${matchedDiscountCode.name}`;
          } else {
            finalDiscountAmount = automaticAmount;
            // automaticAmount winning with a code entered still means no
            // automatic discount applies to guests (automaticAmount is 0)
          }
        }

        // Build order object with all required fields
        const finalOrderData = {
          orderId,
          items: processedItems,
          shippingAddress,
          customerEmail: customerInfo?.email || shippingAddress?.email || null,
          subtotal: Number(subtotal),
          shippingCharges: Number(shippingCharges), // ADD THIS LINE - Include shipping charges
          discount: finalDiscountAmount,
          discountCode: finalDiscountReason,
          total: Number(total),
          pointsUsed: pointsToUse,
          pointsEarned,
          giftCardCode: giftCard ? giftCard.code : '',
          giftCardAmount: giftCard ? Number(giftCardAmountApplied) : 0,
          paymentMethod,
          isFirstOrder,
          paymentReceipt: receiptData,
          // Issue #18 - seed the timeline so every new order has a real
          // history from the start, not just from the first admin update.
          statusHistory: [{ status: 'Pending', changedAt: new Date() }],
        };
        
        // Add user reference if logged in
        if (userId) {
          finalOrderData.user = userId;
        }
        
        // Create the order
        const newOrder = new Order(finalOrderData);
        const savedOrder = await newOrder.save();
        
        // Update user points if logged in
        if (user) {
          user.rewardPoints = user.rewardPoints - pointsToUse + pointsEarned;
          await user.save();
        }

        // Decrement the gift card balance now that the order actually
        // exists - same non-transactional, after-order-save timing as the
        // points update above (this function has no transaction wrapper
        // anywhere; matching its existing pattern rather than introducing
        // a partially-atomic one).
        if (giftCard) {
          giftCard.currentBalance -= Number(giftCardAmountApplied);
          if (giftCard.currentBalance <= 0) {
            giftCard.currentBalance = 0;
            giftCard.isActive = false;
          }
          await giftCard.save();
        }

        // Send email notifications
        try {
          if (customerInfo && customerInfo.email) {
            await sendOrderConfirmationToCustomer(savedOrder, customerInfo.email);
            await sendNewOrderEmailToAdmin(savedOrder, customerInfo.email);
          }
        } catch (emailError) {
          console.log('Email notifications failed, but order was saved:', emailError);
        }

        // Analytics linking (B.3) - additive, best-effort. Links the
        // anonymous session cookie (if present) to this customer at
        // checkout, same as the login-time linking.
        if (userId) {
          try {
            const sessionId = req.cookies?.steth_sid;
            if (sessionId) {
              await AnalyticsSession.findOneAndUpdate(
                { sessionId },
                { $set: { customerId: userId } },
                { upsert: false }
              );
            }
          } catch (analyticsErr) {
            console.error('Analytics session linking failed (non-blocking):', analyticsErr.message);
          }
        }

        return res.status(201).json({
          success: true,
          message: 'Order created successfully',
          order: savedOrder
        });
      } catch (error) {
        console.error('Error creating order:', error);
        return res.status(500).json({
          success: false,
          message: 'Failed to create order',
          error: error.message
        });
      }
    },
// Get all orders for admin
getAllOrders: async (req, res) => {
  try {
    // Pagination
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    
    // Filtering
    const filter = {};
    // Was filter.status - the schema field is orderStatus, so this never
    // actually filtered anything. Blocking bug for the admin tabs, which
    // depend on this query param to scope each tab to one status.
    if (req.query.status) filter.orderStatus = req.query.status;
    
    // Count total documents for pagination
    const totalOrders = await Order.countDocuments(filter);
    
    const orders = await Order.find(filter)
      .populate('user', 'name email')
      .populate('items.product', 'name images')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    
    // Process orders to determine email priority
    const processedOrders = orders.map(order => {
      const orderObj = order.toObject();
      
      // Priority: customerEmail > user.email > null
      let finalEmail = null;
      
      if (orderObj.customerEmail) {
        finalEmail = orderObj.customerEmail;
      } else if (orderObj.user && orderObj.user.email) {
        finalEmail = orderObj.user.email;
      }
      // If both are null, finalEmail remains null
      
      // Add the final email to the order object
      orderObj.email = finalEmail;
      
      return orderObj;
    });
    
    return res.status(200).json({
      success: true,
      count: processedOrders.length,
      total: totalOrders,
      totalPages: Math.ceil(totalOrders / limit),
      currentPage: page,
      orders: processedOrders
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch orders',
      error: error.message
    });
  }
},
  
  // Get user's orders
  getUserOrders: async (req, res) => {
    try {
      const userId = req.user._id;
      // Part B.5 - this was unbounded (no skip/limit). Defaults to a limit
      // generous enough that today's caller (AccountOverlay.jsx, which
      // renders the whole list with no "load more" UI) keeps seeing every
      // order for the overwhelming majority of real accounts, while still
      // capping the true worst case instead of returning an ever-growing
      // result set. page/limit query params are accepted for a future
      // "load more" UI without another backend change.
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;

      const filter = { user: userId };
      const total = await Order.countDocuments(filter);
      const orders = await Order.find(filter)
        .populate('items.product', 'name images price')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit);

      // Issue #18 - orders created before statusHistory existed hydrate as
      // an empty array; give them a single synthesized entry instead of a
      // blank timeline.
      const ordersWithHistory = orders.map(order => {
        const orderObj = order.toObject();
        if (!orderObj.statusHistory || orderObj.statusHistory.length === 0) {
          orderObj.statusHistory = [{ status: orderObj.orderStatus, changedAt: orderObj.createdAt }];
        }
        return orderObj;
      });

      return res.status(200).json({
        success: true,
        count: ordersWithHistory.length,
        total,
        pagination: {
          page,
          pages: Math.ceil(total / limit)
        },
        orders: ordersWithHistory
      });
    } catch (error) {
      console.error('Error fetching user orders:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch your orders',
        error: error.message
      });
    }
  },
  
  // Get a single order by ID
  getOrderById: async (req, res) => {
    try {
      const { orderId } = req.params;
      
      const order = await Order.findById(orderId)
        .populate('user', 'name email')
        .populate('items.product', 'name images description');
      
      if (!order) {
        return res.status(404).json({
          success: false, 
          message: 'Order not found'
        });
      }
      
      // Check if user is authorized to view this order
      if (req.user.role !== 'admin' && (!order.user || order.user._id.toString() !== req.user._id.toString())) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to view this order'
        });
      }

      // Issue #18 - same empty-statusHistory fallback as getUserOrders
      const orderObj = order.toObject();
      if (!orderObj.statusHistory || orderObj.statusHistory.length === 0) {
        orderObj.statusHistory = [{ status: orderObj.orderStatus, changedAt: orderObj.createdAt }];
      }

      return res.status(200).json({
        success: true,
        order: orderObj
      });
    } catch (error) {
      console.error('Error fetching order:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch order',
        error: error.message
      });
    }
  },

// Update order status (admin only)
updateOrderStatus: async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status, trackingNumber } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: 'Status is required'
      });
    }

    const result = await updateSingleOrderStatus(orderId, status, trackingNumber);

    if (!result.success) {
      return res.status(404).json({ success: false, message: result.message });
    }

    return res.status(200).json({
      success: true,
      message: 'Order status updated successfully',
      order: result.order
    });
  } catch (error) {
    console.error('Error updating order status:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update order status',
      error: error.message
    });
  }
},

// Bulk status update (admin only) - powers the tabbed dashboard's bulk
// action bar (bulk Confirm/Cancel/Ship/Deliver). Loops the same
// per-order logic as the single-order route above rather than a raw
// updateMany, so every order still gets its own statusHistory push and
// status-change email.
bulkUpdateOrderStatus: async (req, res) => {
  try {
    const { orderIds, status } = req.body;

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ success: false, message: 'orderIds must be a non-empty array' });
    }
    if (!status) {
      return res.status(400).json({ success: false, message: 'Status is required' });
    }

    const results = [];
    for (const orderId of orderIds) {
      try {
        // Cancellation has side effects (inventory return, points reversal)
        // a plain status flip doesn't - route it through the same logic
        // the single-order cancel route uses, not the generic status setter.
        const result = status === 'Cancelled'
          ? await cancelSingleOrder(orderId, req.user)
          : await updateSingleOrderStatus(orderId, status);
        results.push({ orderId, success: result.success, message: result.message });
      } catch (error) {
        console.error(`Error updating order ${orderId}:`, error);
        results.push({ orderId, success: false, message: error.message });
      }
    }

    return res.status(200).json({ success: true, results });
  } catch (error) {
    console.error('Error in bulk status update:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to bulk update order status',
      error: error.message
    });
  }
},

// Generate a shipping label (admin only) - stub PDF via labelService,
// uploads through the existing ImageKit utility, auto-advances the order
// to Processing. Bypasses updateOrderStatus (like cancelOrder does) since
// this transition carries extra side effects (the label itself) beyond a
// plain status change.
generateOrderLabel: async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await Order.findById(orderId).populate('user', 'email');

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const filePath = await generateLabel(order);
    const uploadResult = await uploadToImageKit(filePath, `shipping-labels/${order._id}`);

    order.shippingLabel = { url: uploadResult.url, generatedAt: new Date() };

    const statusChanged = order.orderStatus !== 'Processing';
    order.orderStatus = 'Processing';
    if (statusChanged) {
      order.statusHistory.push({ status: 'Processing', changedAt: new Date() });
    }

    const updatedOrder = await order.save();

    return res.status(200).json({
      success: true,
      message: 'Label generated successfully',
      order: updatedOrder,
      labelUrl: uploadResult.url
    });
  } catch (error) {
    console.error('Error generating order label:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to generate label',
      error: error.message
    });
  }
},

// Bulk label generation (admin only) - "Print All Labels". No PDF-merging
// into one print job; loops the single-label logic and reports per-order
// success so a partial failure in the batch isn't silently dropped.
bulkGenerateOrderLabels: async (req, res) => {
  try {
    const { orderIds } = req.body;

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ success: false, message: 'orderIds must be a non-empty array' });
    }

    const results = [];
    for (const orderId of orderIds) {
      try {
        const order = await Order.findById(orderId).populate('user', 'email');
        if (!order) {
          results.push({ orderId, success: false, message: 'Order not found' });
          continue;
        }

        const filePath = await generateLabel(order);
        const uploadResult = await uploadToImageKit(filePath, `shipping-labels/${order._id}`);

        order.shippingLabel = { url: uploadResult.url, generatedAt: new Date() };
        const statusChanged = order.orderStatus !== 'Processing';
        order.orderStatus = 'Processing';
        if (statusChanged) {
          order.statusHistory.push({ status: 'Processing', changedAt: new Date() });
        }
        await order.save();

        results.push({ orderId, success: true, url: uploadResult.url });
      } catch (error) {
        console.error(`Error generating label for order ${orderId}:`, error);
        results.push({ orderId, success: false, message: error.message });
      }
    }

    return res.status(200).json({ success: true, results });
  } catch (error) {
    console.error('Error in bulk label generation:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to bulk generate labels',
      error: error.message
    });
  }
},

// Cancel an order
cancelOrder: async (req, res) => {
  try {
    const { orderId } = req.params;
    const result = await cancelSingleOrder(orderId, req.user);

    if (!result.success) {
      return res.status(result.status).json({ success: false, message: result.message });
    }

    return res.status(200).json({
      success: true,
      message: 'Order cancelled successfully',
      order: result.order
    });
  } catch (error) {
    console.error('Error cancelling order:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to cancel order',
      error: error.message
    });
  }
},
  
// Get order statistics for admin dashboard
getOrderStats: async (req, res) => {
    try {
      // Total orders
      const totalOrders = await Order.countDocuments();
      
      // Orders by status
      const ordersByStatus = await Order.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);
  
      // Revenue stats
      const revenueStats = await Order.aggregate([
        { $match: { status: { $ne: 'Cancelled' } } },
        { 
          $group: { 
            _id: null, 
            totalRevenue: { $sum: '$total' },
            averageOrderValue: { $avg: '$total' },
            totalDiscount: { $sum: '$discount' }
          } 
        }
      ]);
  
      // Recent orders
      const recentOrders = await Order.find()
        .populate('user', 'name')
        .sort({ createdAt: -1 })
        .limit(5);
  
      // Count of student users
      const studentUserCount = await User.countDocuments({ isStudent: true });
  
      // Reward points stats (issued and used)
      const rewardStats = await Order.aggregate([
        {
          $group: {
            _id: null,
            totalPointsEarned: { $sum: '$pointsEarned' },
            totalPointsUsed: { $sum: '$pointsUsed' }
          }
        }
      ]);
  
      const totalPointsEarned = rewardStats[0]?.totalPointsEarned || 0;
      const totalPointsUsed = rewardStats[0]?.totalPointsUsed || 0;
  
      // Total student discounts
      const studentDiscounts = await Order.aggregate([
        { 
          $match: { 
            discountCode: "Student Discount (5%)",
            status: { $ne: 'Cancelled' }
          } 
        },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: '$discount' },
            count: { $sum: 1 }
          }
        }
      ]);
  
      // Total first order discounts
      const firstOrderDiscounts = await Order.aggregate([
        { 
          $match: { 
            discountCode: "First Order Discount (10%)",
            status: { $ne: 'Cancelled' }
          } 
        },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: '$discount' },
            count: { $sum: 1 }
          }
        }
      ]);
  
      return res.status(200).json({
        success: true,
        stats: {
          totalOrders,
          ordersByStatus: ordersByStatus.reduce((acc, curr) => {
            acc[curr._id] = curr.count;
            return acc;
          }, {}),
          revenue: revenueStats.length > 0 ? revenueStats[0] : {
            totalRevenue: 0,
            averageOrderValue: 0,
            totalDiscount: 0
          },
          recentOrders,
          studentUserCount,
          totalPointsEarned,
          totalPointsUsed,
          studentDiscounts: {
            totalAmount: studentDiscounts[0]?.totalAmount || 0,
            count: studentDiscounts[0]?.count || 0
          },
          firstOrderDiscounts: {
            totalAmount: firstOrderDiscounts[0]?.totalAmount || 0,
            count: firstOrderDiscounts[0]?.count || 0
          }
        }
      });
    } catch (error) {
      console.error('Error fetching order stats:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch order statistics',
        error: error.message
      });
    }
  },

  getBestSellingProducts: async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 4;
      
      // Aggregate to find products with highest sales
      const bestSellingProducts = await Order.aggregate([
        // Unwind to get individual items
        { $unwind: '$items' },
        // Group by product and sum quantities
        { 
          $group: { 
            _id: '$items.product', 
            totalSold: { $sum: '$items.quantity' },
            totalRevenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } }
          } 
        },
        // Sort by most sold
        { $sort: { totalSold: -1 } },
        // Limit results
        { $limit: limit },
        // Get product details
        { 
          $lookup: {
            from: 'products',
            localField: '_id',
            foreignField: '_id',
            as: 'productDetails'
          }
        },
        // Flatten product details
        { $unwind: '$productDetails' },
        // Project final fields
        { 
          $project: {
            _id: '$_id',
            name: '$productDetails.name',
            unitsSold: '$totalSold',
            revenue: '$totalRevenue',
            image: { $arrayElemAt: ['$productDetails.images', 0] }
          }
        }
      ]);

      return res.status(200).json({
        success: true,
        products: bestSellingProducts
      });
    } catch (error) {
      console.error('Error fetching best selling products:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch best selling products',
        error: error.message
      });
    }
  },

  getRecentStudentVerifications: async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 4;
  
      const recentVerifications = await StudentVerification.find()
        .sort({ createdAt: -1 })
        .populate('user', 'name email profilePicUrl studentVerified isStudent')
        .limit(10); // fetch a few more just in case some are filtered out
  
      const filtered = recentVerifications
        .filter(v => v.user?.isStudent) // only include those with isStudent: true
        .slice(0, limit); // apply limit *after* filtering
  
      const formattedVerifications = filtered.map(v => ({
        _id: v._id,
        name: v.name || 'N/A',
        email: v.user?.email || 'N/A',
        profilePicUrl: v.user?.profilePicUrl || '',
        studentId: v.studentId,
        institutionName: v.institutionName,
        proofDocument: v.proofDocument,
        status: v.status,
        verificationDate: v.createdAt
      }));
  
      return res.status(200).json({
        success: true,
        verifications: formattedVerifications
      });
    } catch (error) {
      console.error('Error fetching student verifications:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch student verifications',
        error: error.message
      });
    }
  }
  
};

// Exposed so the customer support agent can cancel an order through exactly
// the same path as the HTTP route - cancellation restores stock, refunds
// reward points and invalidates the product cache, and duplicating that in
// the agent would eventually drift from this implementation.
orderController.cancelSingleOrder = cancelSingleOrder;

module.exports = orderController;
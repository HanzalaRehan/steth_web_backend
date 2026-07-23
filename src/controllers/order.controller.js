const Order = require('../models/order.model');
const User = require('../models/user.model');
const Product = require('../models/product.model');
const StudentVerification = require('../models/student.model');
const { uploadToImageKit } = require('../utils/imageKitUpload');

const { 
  sendVerificationRequestEmail, 
  sendVerificationResultEmail,
  sendNewOrderEmailToAdmin,
  sendOrderConfirmationToCustomer,
  sendOrderStatusUpdateToCustomer
} = require('../utils/emailService');

const calculatePoints = (amount) => {
  // 1 point for every 100 PKR
  return Math.floor(amount / 100);
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
          discountCode = '',
          discountInfo = {
            amount: 0,
            reasons: [],
            pointsUsed: 0
          },
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

        // Build order object with all required fields
        const finalOrderData = {
          orderId,
          items: processedItems,
          shippingAddress,
          customerEmail: customerInfo?.email || shippingAddress?.email || null,
          subtotal: Number(subtotal),
          shippingCharges: Number(shippingCharges), // ADD THIS LINE - Include shipping charges
          discount: Number(discount),
          discountCode: discountInfo.reasons
            ? discountInfo.reasons.join(', ')
            : '',
          total: Number(total),
          pointsUsed: pointsToUse,
          pointsEarned,
          paymentMethod,
          isFirstOrder,
          paymentReceipt: receiptData,
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
        
        // Send email notifications
        try {
          if (customerInfo && customerInfo.email) {
            await sendOrderConfirmationToCustomer(savedOrder, customerInfo.email);
            await sendNewOrderEmailToAdmin(savedOrder, customerInfo.email);
          }
        } catch (emailError) {
          console.log('Email notifications failed, but order was saved:', emailError);
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
    if (req.query.status) filter.status = req.query.status;
    
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
      
      const orders = await Order.find({ user: userId })
        .populate('items.product', 'name images price')
        .sort({ createdAt: -1 });
      
      return res.status(200).json({
        success: true,
        count: orders.length,
        orders
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
      if (!req.user.isAdmin && order.user._id.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to view this order'
        });
      }
      
      return res.status(200).json({
        success: true,
        order
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
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: 'Status is required'
      });
    }

    const order = await Order.findById(orderId)
      .populate('user', 'email');
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Update tracking number if provided
    if (req.body.trackingNumber) {
      order.trackingNumber = req.body.trackingNumber;
    }

    // Only send notification if status actually changed
    const statusChanged = order.orderStatus !== status; // Changed from order.status
    order.orderStatus = status; // Changed from order.status

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

    return res.status(200).json({
      success: true,
      message: 'Order status updated successfully',
      order: updatedOrder
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

// Cancel an order
cancelOrder: async (req, res) => {
  try {
    const { orderId } = req.params;
    
    const order = await Order.findById(orderId)
      .populate('user', 'email');
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    // Check if user is authorized to cancel this order
    if (!order.user || (!req.user.isAdmin && order.user._id.toString() !== req.user._id.toString())) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to cancel this order'
      });
    }

    // Check if order can be cancelled (only if it's pending or processing)
    if (!['Pending', 'Processing'].includes(order.orderStatus)) {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel order with status: ${order.orderStatus}`
      });
    }

    // Update order status to cancelled
    order.orderStatus = 'Cancelled';
    
    // Return items to inventory
    for (const item of order.items) {
      const product = await Product.findById(item.product);
      if (product) {
        // Find the inventory item
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
    
    // If points were used or earned, adjust user's points
    if (order.pointsUsed > 0 || order.pointsEarned > 0) {
      const user = await User.findById(order.user._id);
      if (user) {
        user.rewardPoints = user.rewardPoints + order.pointsUsed - order.pointsEarned;
        await user.save();
      }
    }
    
    const cancelledOrder = await order.save();
    
    // Send cancellation email
    if (order.user && order.user.email) {
      try {
        await sendOrderStatusUpdateToCustomer(cancelledOrder, order.user.email);
      } catch (emailError) {
        console.log('Cancellation email failed, but order was cancelled:', emailError);
      }
    }
    
    return res.status(200).json({
      success: true,
      message: 'Order cancelled successfully',
      order: cancelledOrder
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

module.exports = orderController;
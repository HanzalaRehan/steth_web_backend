/**
 * Author(s): 1. husnain417
 *            2. Hanzala B. Rehan
 *            3. Zainab Raza
 * Description: Authentication and authorization middleware for the Steth API.
 *              Provides the token gate used by every protected route (`auth`),
 *              the generic role gate behind it (`authorize`, with `isAdmin` as
 *              a backward-compatible alias), the password-reset token gate
 *              (`authenticateResetToken`), and an optional-auth variant
 *              (`attachUserIfPresent`) for endpoints that serve guests and
 *              logged-in customers from the same route.
 *
 * Date created: May 7th, 2025
 * Edit(s):
 *   (1): Added RBAC foundation - authorize() middleware and new roles.
 *   (2): Added attachUserIfPresent for optional authentication, needed by the
 *        public "What's My Size?" endpoint so it can answer guests while still
 *        saving results for logged-in customers.
 * Date last modified: August 3rd, 2026
 * Run: Not directly runnable - imported by the route files in src/routes/
 */

const jwt = require('jsonwebtoken');
const User = require('../models/user.model');

const auth = async (req, res, next) => {
    try {
        const token = req.header('Authorization')?.replace('Bearer ', '');
        
        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
        const user = await User.findById(decoded.id);

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'User not found'
            });
        }

        req.user = user;
        req.token = token;
        next();
    } catch (error) {
        res.status(401).json({
            success: false,
            message: 'Invalid authentication token'
        });
    }
};

// Optional authentication. Populates req.user when a valid token is present
// and otherwise just continues, so a single route can serve both guests and
// logged-in customers. Never rejects - any bad/expired token is treated as
// "this is a guest", so it must NOT be used to protect anything. Routes that
// require a real user still use `auth` above.
//
// Added for the public "What's My Size?" endpoint: guests need an instant
// answer, while a logged-in customer's result should be saved to their size
// profile. Previously the codebase worked around the gap by splitting such
// flows into two routes (see the guest-vs-authenticated order-creation routes,
// and the note in giftCard.controller.js) - this avoids duplicating the same
// handler a third time.
const attachUserIfPresent = async (req, res, next) => {
    try {
        const token = req.header('Authorization')?.replace('Bearer ', '');
        if (!token) return next();

        const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
        const user = await User.findById(decoded.id);
        if (user) {
            req.user = user;
            req.token = token;
        }
    } catch (error) {
        // Deliberately swallowed - fall through as a guest.
    }
    next();
};

// Generic role gate. Must run after `auth` (needs req.user populated).
const authorize = (...allowedRoles) => (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
        return res.status(403).json({
            success: false,
            message: `Access denied. Requires role: ${allowedRoles.join(' or ')}.`
        });
    }
    next();
};

// Backward-compatible alias for existing admin-only routes.
const isAdmin = authorize('admin');

function authenticateResetToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
  
    if (token == null) {
      return res.status(401).json({ message: 'No token provided' });
    }
  
    jwt.verify(token, process.env.RESET_TOKEN_SECRET, async (err, user) => {
      if (err) {
        console.error('Token verification failed:', err.message);
        return res.status(401).json({ message: 'Invalid token' });
      }
  
      req.user = user; 
      next();
    });
  };
  

// const isVerifiedStudent = async (req, res, next) => {
//     try {
//         if (!req.user.studentVerification.isVerified) {
//             return res.status(403).json({
//                 success: false,
//                 message: 'Access denied. Student verification required.'
//             });
//         }
//         next();
//     } catch (error) {
//         res.status(500).json({
//             success: false,
//             message: 'Server error'
//         });
//     }
// };

module.exports = {
    auth,
    attachUserIfPresent,
    isAdmin,
    authorize,
    authenticateResetToken,
    // isVerifiedStudent
};
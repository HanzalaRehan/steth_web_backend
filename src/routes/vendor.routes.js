const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middlewares/auth.middleware');
const {
    getAllVendors,
    getVendor,
    createVendor,
    updateVendor,
    deleteVendor
} = require('../controllers/vendor.controller');

// Vendor management is Admin + Warehouse Manager territory, not admin-only
// (per the master plan's Part B.2 role scoping) - the first real use of
// authorize() with more than one role in this codebase.
const canManageVendors = authorize('admin', 'warehouse_manager');

router.get('/', auth, canManageVendors, getAllVendors);
router.get('/:id', auth, canManageVendors, getVendor);
router.post('/', auth, canManageVendors, createVendor);
router.put('/:id', auth, canManageVendors, updateVendor);
router.delete('/:id', auth, canManageVendors, deleteVendor);

module.exports = router;

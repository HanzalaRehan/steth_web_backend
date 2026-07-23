const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middlewares/auth.middleware');
const {
    getAllShipments,
    getShipment,
    receiveShipment,
    deleteShipment
} = require('../controllers/shipment.controller');

const canManageShipments = authorize('admin', 'warehouse_manager');

router.get('/', auth, canManageShipments, getAllShipments);
router.get('/:id', auth, canManageShipments, getShipment);
router.post('/', auth, canManageShipments, receiveShipment);
router.delete('/:id', auth, canManageShipments, deleteShipment);

module.exports = router;

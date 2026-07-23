const express = require('express');
const router = express.Router();
const { auth, isAdmin } = require('../middlewares/auth.middleware');
const {
    getAllFabrics,
    getFabric,
    createFabric,
    updateFabric,
    deleteFabric
} = require('../controllers/fabric.controller');

router.get('/', getAllFabrics);
router.get('/:id', getFabric);
router.post('/', auth, isAdmin, createFabric);
router.put('/:id', auth, isAdmin, updateFabric);
router.delete('/:id', auth, isAdmin, deleteFabric);

module.exports = router;

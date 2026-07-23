const express = require('express');
const router = express.Router();
const { auth, isAdmin } = require('../middlewares/auth.middleware');
const { upload } = require('../middlewares/upload.middleware');
const {
    getAllColors,
    getColor,
    createColor,
    updateColor,
    deleteColor
} = require('../controllers/color.controller');

router.get('/', getAllColors);
router.get('/:id', getColor);
router.post('/', auth, isAdmin, upload.single('image'), createColor);
router.put('/:id', auth, isAdmin, upload.single('image'), updateColor);
router.delete('/:id', auth, isAdmin, deleteColor);

module.exports = router;

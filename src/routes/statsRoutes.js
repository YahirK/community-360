const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const statsController = require('../controllers/statsController');

// Todos los endpoints analíticos están protegidos con JWT
router.use(authMiddleware);

router.get('/live', statsController.getLive);
router.get('/historical', statsController.getHistorical);
router.get('/users', statsController.listUsers);

module.exports = router;

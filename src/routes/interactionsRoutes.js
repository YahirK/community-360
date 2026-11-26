const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const interactionsController = require('../controllers/interactionsController');

// Todos los endpoints de interacciones están protegidos con JWT (Fases 3 y 4)
router.use(authMiddleware);

router.get('/', interactionsController.listInteractions);
router.get('/:id', interactionsController.getInteractionById);
router.post('/', interactionsController.createInteraction);
router.put('/:id', interactionsController.updateInteraction);
router.delete('/:id', interactionsController.deleteInteraction);

module.exports = router;

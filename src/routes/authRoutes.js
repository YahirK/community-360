const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/auth');

// Limitador de intentos de inicio de sesión para prevenir fuerza bruta
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  limit: 20, // Máximo 20 intentos fallidos por IP en la ventana de tiempo
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Demasiados intentos fallidos. Por favor, espera unos minutos antes de intentar nuevamente.',
  },
});

// Rutas públicas
router.post('/login', loginLimiter, authController.login);

// Rutas protegidas con token JWT
router.get('/verify', authMiddleware, authController.verify);
router.post('/logout', authMiddleware, authController.logout);
router.post('/register', authMiddleware, authController.createAdmin);

module.exports = router;

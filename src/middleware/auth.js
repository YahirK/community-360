const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    console.error('[Auth Error] JWT_SECRET no está configurado en las variables de entorno.');
    return res.status(500).json({
      success: false,
      message: 'Error de configuración de autenticación en el servidor.',
    });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({
      success: false,
      message: 'Acceso no autorizado: No se proporcionó token de autenticación.',
    });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({
      success: false,
      message: 'Formato de token inválido. Debe ser: Bearer <token>',
    });
  }

  const token = parts[1];

  try {
    const decoded = jwt.verify(token, jwtSecret);
    req.admin = decoded; // { id_admin, usuario, iat, exp }
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'La sesión ha expirado. Por favor, inicia sesión nuevamente.',
        expired: true,
      });
    }
    return res.status(401).json({
      success: false,
      message: 'Token de autenticación inválido.',
    });
  }
}

module.exports = authMiddleware;

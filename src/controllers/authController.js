const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db/tidb');

// Login de usuario administrador
async function login(req, res) {
  const { usuario, password } = req.body || {};

  if (!usuario || !password || typeof usuario !== 'string' || typeof password !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'Debe ingresar usuario y contraseña válidos.',
    });
  }

  try {
    const [rows] = await pool.query(
      'SELECT id_admin, usuario, password_hash, activo FROM administradores WHERE LOWER(usuario) = LOWER(?) LIMIT 1',
      [usuario.trim()]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Credenciales incorrectas.',
      });
    }

    const admin = rows[0];

    if (!admin.activo) {
      return res.status(403).json({
        success: false,
        message: 'Acceso denegado: El usuario se encuentra inactivo.',
      });
    }

    const passwordMatch = await bcrypt.compare(password, admin.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Credenciales incorrectas.',
      });
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      console.error('[Auth Error] JWT_SECRET no configurado.');
      return res.status(500).json({
        success: false,
        message: 'Error de configuración de seguridad en el servidor.',
      });
    }

    // Generar token JWT seguro con id_admin entero
    const tokenPayload = {
      id_admin: Number(admin.id_admin),
      usuario: admin.usuario,
    };

    const token = jwt.sign(tokenPayload, jwtSecret, {
      expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    });

    return res.status(200).json({
      success: true,
      message: 'Inicio de sesión exitoso.',
      token,
      usuario: {
        id_admin: Number(admin.id_admin),
        usuario: admin.usuario,
      },
    });
  } catch (error) {
    console.error('[Auth Error] Error en login:', error);
    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor al procesar la autenticación.',
    });
  }
}

// Verificación de token activo
async function verify(req, res) {
  return res.status(200).json({
    success: true,
    message: 'Token válido.',
    admin: req.admin,
  });
}

// Cierre de sesión (del lado servidor)
async function logout(req, res) {
  return res.status(200).json({
    success: true,
    message: 'Sesión finalizada con éxito.',
  });
}

// Registrar o crear nuevo administrador (protegido o para setup inicial)
async function createAdmin(req, res) {
  const { usuario, password } = req.body || {};

  if (!usuario || !password || typeof usuario !== 'string' || typeof password !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'Usuario y contraseña válidos son requeridos.',
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      success: false,
      message: 'La contraseña debe tener al menos 6 caracteres.',
    });
  }

  try {
    const [existing] = await pool.query(
      'SELECT id_admin FROM administradores WHERE usuario = ? LIMIT 1',
      [usuario.trim()]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'El nombre de usuario ya está registrado.',
      });
    }

    // Hashear contraseña con bcrypt (10 rounds)
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);
    const creado_en = new Date();

    const [result] = await pool.query(
      'INSERT INTO administradores (usuario, password_hash, activo, creado_en) VALUES (?, ?, ?, ?)',
      [usuario.trim(), password_hash, 1, creado_en]
    );

    return res.status(201).json({
      success: true,
      message: 'Usuario administrador creado exitosamente.',
      id_admin: result.insertId,
    });
  } catch (error) {
    console.error('[Auth Error] Error al crear administrador:', error);
    return res.status(500).json({
      success: false,
      message: 'Error interno al registrar administrador.',
    });
  }
}

module.exports = {
  login,
  verify,
  logout,
  createAdmin,
};

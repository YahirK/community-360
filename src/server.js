require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const { initTiDB } = require('./db/tidb');
const authRoutes = require('./routes/authRoutes');
const interactionsRoutes = require('./routes/interactionsRoutes');
const statsRoutes = require('./routes/statsRoutes');
const authMiddleware = require('./middleware/auth');

if (!process.env.JWT_SECRET) {
  console.error('❌ [Configuración] Falta la variable de entorno JWT_SECRET en .env');
  process.exit(1);
}

const PORT = Number(process.env.PORT || 3000);
const configuredOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const allowedOrigins = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  ...configuredOrigins,
]);

function isOriginAllowed(origin, hostHeader) {
  if (!origin || allowedOrigins.has('*') || allowedOrigins.has(origin)) {
    return true;
  }
  if (hostHeader && (origin === `http://${hostHeader}` || origin === `https://${hostHeader}`)) {
    return true;
  }
  return false;
}

const app = express();
app.set('trust proxy', 1); // Necesario para despliegues detrás de proxy (Render, Railway, Fly.io)

const server = http.createServer(app);

// Configuración de WebSockets (Socket.io - Fase 5)
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isOriginAllowed(origin, null)) return callback(null, true);
      return callback(null, true); // El handshake de Socket.io además exige token JWT válido en io.use
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  },
});

// Middleware de autenticación JWT en el handshake de WebSockets
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error('Token JWT requerido para conectar al WebSocket.'));
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.admin = decoded;
    return next();
  } catch (err) {
    return next(new Error('Token JWT inválido o expirado.'));
  }
});

// Compartir instancia de Socket.io con los controladores REST
app.set('io', io);

// Middleware global
app.use(
  cors((req, callback) => {
    const origin = req.header('Origin');
    if (isOriginAllowed(origin, req.get('host'))) {
      return callback(null, { origin: true, methods: ['GET', 'POST', 'PUT', 'DELETE'] });
    }
    return callback(new Error('Origen no permitido por la política CORS.'));
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir archivos estáticos del frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// Endpoint de salud (útil para verificación de despliegue en la nube)
app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'ok',
    service: 'Community 360 API',
    timestamp: new Date().toISOString(),
  });
});

// Rutas de autenticación (Fase 3)
app.use('/api/auth', authRoutes);

// Rutas de API REST protegidas (Fase 4)
app.use('/api/interactions', interactionsRoutes);
app.use('/api/stats', statsRoutes);

// Ruta de prueba para verificar protección de endpoints REST
app.get('/api/protected-test', authMiddleware, (req, res) => {
  res.json({
    success: true,
    message: 'Has accedido a un endpoint protegido exitosamente.',
    admin: req.admin,
    timestamp: new Date().toISOString(),
  });
});

// 404 para endpoints de API no encontrados (devuelve JSON)
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Endpoint no encontrado: ${req.method} ${req.originalUrl}`,
  });
});

// Redirección de la raíz al dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

// Manejo de errores no capturados (compatible con Express 5)
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  const status = err.status || (err.message && err.message.includes('CORS') ? 403 : 500);
  console.error('[Server Error]', err.message);
  return res.status(status).json({
    success: false,
    message: status === 500 ? 'Error interno en el servidor.' : err.message,
  });
});

// Eventos de WebSocket
io.on('connection', (socket) => {
  console.log(`[WebSocket] Admin '${socket.admin?.usuario}' conectado (ID: ${socket.id})`);

  socket.on('disconnect', () => {
    console.log(`[WebSocket] Cliente desconectado (ID: ${socket.id})`);
  });
});

if (require.main === module) {
  server.listen(PORT, async () => {
    console.log(`\n======================================================`);
    console.log(`🚀 Servidor ejecutándose en: http://localhost:${PORT}`);
    console.log(`🔒 Sistema de autenticación: http://localhost:${PORT}/login.html`);
    console.log(`📊 Dashboard analítico:      http://localhost:${PORT}/dashboard.html`);
    console.log(`======================================================\n`);
    await initTiDB();
  });
}

module.exports = { app, server, io };

const dns = require('dns');
const net = require('net');
const mysql = require('mysql2/promise');

// Solución para Node.js v20-v24 en Windows: evita que Happy Eyeballs (250ms por defecto)
// aborte con ETIMEDOUT conexiones legítimas hacia TiDB Cloud cuando la latencia ronda ~250ms.
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}
if (typeof net.setDefaultAutoSelectFamily === 'function') {
  net.setDefaultAutoSelectFamily(false);
}
if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
  net.setDefaultAutoSelectFamilyAttemptTimeout(5000);
}

const rawPool = mysql.createPool({
  host: process.env.TIDB_HOST,
  port: Number(process.env.TIDB_PORT || 4000),
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
  waitForConnections: true,
  connectionLimit: 10,
  maxIdle: 2,
  idleTimeout: 45000,
  connectTimeout: 15000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  queueLimit: 0,
});

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'PROTOCOL_CONNECTION_LOST',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
]);

// Reintento automático ante cierre de conexiones inactivas por parte de TiDB Cloud Serverless
const pool = {
  async query(sql, params) {
    try {
      return await rawPool.query(sql, params);
    } catch (err) {
      if (TRANSIENT_CODES.has(err.code) || /closed|connection lost|reset/i.test(err.message || '')) {
        console.warn(`[TiDB] Reconectando tras cierre de socket inactivo (${err.code || err.message})...`);
        return await rawPool.query(sql, params);
      }
      throw err;
    }
  },
  async execute(sql, params) {
    try {
      return await rawPool.execute(sql, params);
    } catch (err) {
      if (TRANSIENT_CODES.has(err.code) || /closed|connection lost|reset/i.test(err.message || '')) {
        return await rawPool.execute(sql, params);
      }
      throw err;
    }
  },
  getConnection: () => rawPool.getConnection(),
  end: () => rawPool.end(),
};

// Asegura que la tabla de administradores exista
async function initTiDB() {
  const query = `
    CREATE TABLE IF NOT EXISTS administradores (
      id_admin      INT AUTO_INCREMENT PRIMARY KEY,
      usuario       VARCHAR(30) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      activo        BOOLEAN NOT NULL DEFAULT TRUE,
      creado_en     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  try {
    await pool.query(query);
    console.log('[TiDB] Conexión a TiDB exitosa y tabla administradores verificada.');
  } catch (error) {
    console.error('[TiDB] Error al inicializar tabla administradores:', error.message);
  }
}

module.exports = {
  pool,
  initTiDB,
};

const { pool } = require('../db/tidb');
const { getLiveMetrics, getHistoricalStats } = require('../services/metricsService');

// GET /api/stats/live (servido desde caché en memoria sincronizada tras escrituras)
async function getLive(req, res) {
  try {
    const metrics = await getLiveMetrics();
    return res.status(200).json({
      success: true,
      data: metrics,
    });
  } catch (error) {
    console.error('[Stats] Error en métricas en vivo:', error);
    return res.status(500).json({
      success: false,
      message: 'Error al calcular los indicadores en tiempo real.',
    });
  }
}

// GET /api/stats/historical
async function getHistorical(req, res) {
  try {
    const [stats, [estatusRows]] = await Promise.all([
      getHistoricalStats(),
      pool.query('SELECT estatus, COUNT(*) AS total FROM usuarios GROUP BY estatus;'),
    ]);

    const conteoEstatus = { activo: 0, en_riesgo: 0, inactivo: 0 };
    for (const row of estatusRows) {
      const k = String(row.estatus || '').toLowerCase();
      if (k in conteoEstatus) {
        conteoEstatus[k] = Number(row.total || 0);
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        ...stats,
        activo: conteoEstatus.activo,
        en_riesgo: conteoEstatus.en_riesgo,
        inactivo: conteoEstatus.inactivo,
        usuarios_estatus: {
          ...conteoEstatus,
          porcentaje_en_riesgo: stats.usuarios_estatus.porcentaje_en_riesgo,
        },
      },
    });
  } catch (error) {
    console.error('[Stats] Error en estadísticas históricas:', error);
    return res.status(500).json({
      success: false,
      message: 'Error al consultar las estadísticas históricas en TiDB Cloud.',
    });
  }
}

// GET /api/stats/users
async function listUsers(req, res) {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 100);
    const offset = Math.max(Number(req.query.offset || 0), 0);

    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM usuarios');
    const [rows] = await pool.query(
      `SELECT u.id_usuario, u.alias, u.fecha_ingreso, u.rango_edad, u.especie_fursona,
              u.interes_principal, u.plataforma_principal, u.es_artista,
              u.mensajes_30d, u.reacciones_30d, u.sentimiento_promedio, u.estatus,
              u.consentimiento_datos, ub.ciudad, ub.estado, ub.pais
       FROM usuarios u
       LEFT JOIN ubicacion ub ON u.id_ubicacion = ub.id_ubicacion
       ORDER BY u.id_usuario ASC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    return res.status(200).json({
      success: true,
      total: Number(total),
      limit,
      offset,
      data: rows,
    });
  } catch (error) {
    console.error('[Stats] Error al listar usuarios:', error);
    return res.status(500).json({
      success: false,
      message: 'Error al consultar usuarios en TiDB Cloud.',
    });
  }
}

module.exports = {
  getLive,
  getHistorical,
  listUsers,
};

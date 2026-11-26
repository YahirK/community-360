const { pool } = require('../db/tidb');
const { getDb, Timestamp, FieldValue } = require('../db/firestore');

// Caché en memoria sincronizada tras cada escritura para proteger la cuota de lecturas de Firestore
let liveMetricsCache = null;

// Serializa un documento de Firestore convirtiendo Timestamps a ISO string
function serializeInteraction(id, data) {
  const toIso = (v) => {
    if (!v) return null;
    if (typeof v.toDate === 'function') return v.toDate().toISOString();
    if (v instanceof Date) return v.toISOString();
    return String(v);
  };

  const texto = data.texto ?? null;

  return {
    id_interaccion: id,
    id_usuario: data.id_usuario ?? null,
    timestamp: toIso(data.timestamp),
    canal: data.canal ?? 'Desconocido',
    tipo: data.tipo ?? 'mensaje',
    texto,
    tema: data.tema ?? 'general',
    sentimiento: typeof data.sentimiento === 'number' ? data.sentimiento : Number(data.sentimiento || 0),
    idioma: data.idioma ?? 'es',
    dispositivo: data.dispositivo ?? 'Desconocido',
    longitud_texto: typeof data.longitud_texto === 'number' ? data.longitud_texto : (texto ? String(texto).length : 0),
    reacciones_recibidas: typeof data.reacciones_recibidas === 'number' ? data.reacciones_recibidas : Number(data.reacciones_recibidas || 0),
    etiquetas: Array.isArray(data.etiquetas) ? data.etiquetas : [],
    ubicacion: data.ubicacion ?? null,
    creado_en: toIso(data.creado_en),
    modificado_en: toIso(data.modificado_en),
  };
}

function classifySentiment(val) {
  if (val > 0.1) return 'Positivo';
  if (val < -0.1) return 'Negativo';
  return 'Neutro';
}

// Persiste los 6 indicadores documentados en la colección `indicadores` de Cloud Firestore
async function persistIndicatorsToFirestore(db, metrics, estatusMap) {
  const ahora = Timestamp.now();
  const indicadoresDocs = [
    {
      id: 'resumen_general',
      definicion: 'N_i = |I|; S̄ = (1 / N_i) * Σ s_k; R = N_i / N_u; r̄ = (1 / N_i) * Σ reacciones_k',
      valor: {
        total_usuarios: metrics.kpis.total_usuarios,
        usuarios_activos: metrics.kpis.usuarios_activos,
        usuarios_en_riesgo: metrics.kpis.usuarios_en_riesgo,
        usuarios_inactivos: metrics.kpis.usuarios_inactivos,
        total_interacciones: metrics.kpis.total_interacciones,
        sentimiento_promedio: metrics.kpis.sentimiento_promedio,
        promedio_reacciones: metrics.kpis.promedio_reacciones,
        tasa_interaccion_usuario: metrics.kpis.tasa_interaccion_usuario,
        porcentaje_positivo: metrics.kpis.porcentaje_positivo,
      },
    },
    {
      id: 'distribucion_sentimiento',
      definicion: 'f(c) = |{k ∈ I : clase(s_k) = c}|, donde Positivo (s > 0.1), Neutro (-0.1 ≤ s ≤ 0.1), Negativo (s < -0.1)',
      valor: {
        Positivo: metrics.distribuciones.sentimiento.Positivo || 0,
        Neutro: metrics.distribuciones.sentimiento.Neutro || 0,
        Negativo: metrics.distribuciones.sentimiento.Negativo || 0,
      },
    },
    {
      id: 'interacciones_por_canal',
      definicion: 'f(canal) = |{k ∈ I : canal_k = canal}| para cada red social registrada',
      valor: { ...metrics.distribuciones.canal },
    },
    {
      id: 'interacciones_por_tipo',
      definicion: 'f(tipo) = |{k ∈ I : tipo_k = tipo}| sobre el catálogo {mensaje, comentario, reaccion, respuesta_encuesta, rsvp_evento}',
      valor: { ...metrics.distribuciones.tipo },
    },
    {
      id: 'mapa_calor_canal_tipo',
      definicion: 'H(c, t) = |{k ∈ I : canal_k = c ∧ tipo_k = t}|, matriz bidimensional de densidad de actividad',
      valor: {
        canales: metrics.heatmap.canales,
        tipos: metrics.heatmap.tipos,
        matriz: metrics.heatmap.matriz,
      },
    },
    {
      id: 'usuarios_estatus',
      definicion: 'E(e) = COUNT(usuarios WHERE estatus = e) para e ∈ {activo, en_riesgo, inactivo} en TiDB Cloud',
      valor: {
        activo: estatusMap.activo,
        en_riesgo: estatusMap.en_riesgo,
        inactivo: estatusMap.inactivo,
        porcentaje_en_riesgo: estatusMap.porcentaje_en_riesgo,
      },
    },
  ];

  const batch = db.batch();
  for (const item of indicadoresDocs) {
    const ref = db.collection('indicadores').doc(item.id);
    batch.set(
      ref,
      {
        definicion: item.definicion,
        valor: item.valor,
        calculado_en: ahora,
        version: FieldValue.increment(1),
      },
      { mergeFields: ['definicion', 'valor', 'calculado_en', 'version'] }
    );
  }
  await batch.commit();
}

// Calcula todos los indicadores dinámicos desde Firestore + TiDB (usa caché en memoria salvo recálculo explícito)
async function getLiveMetrics(options = {}) {
  const { forceRefresh = false, persist = false, dbOverride = null } = options;

  if (!forceRefresh && !persist && liveMetricsCache) {
    return liveMetricsCache;
  }

  const db = dbOverride || getDb();
  const [snap, [estatusRows]] = await Promise.all([
    db.collection('interacciones').get(),
    pool.query('SELECT estatus, COUNT(*) AS total FROM usuarios GROUP BY estatus;'),
  ]);

  const estatusMap = { activo: 0, en_riesgo: 0, inactivo: 0, porcentaje_en_riesgo: 0 };
  let totalUsuarios = 0;
  for (const row of estatusRows) {
    const key = String(row.estatus || '').toLowerCase();
    const count = Number(row.total || 0);
    totalUsuarios += count;
    if (key in estatusMap) {
      estatusMap[key] = count;
    }
  }
  estatusMap.porcentaje_en_riesgo = totalUsuarios > 0
    ? Number(((estatusMap.en_riesgo / totalUsuarios) * 100).toFixed(2))
    : 0;

  const interacciones = [];
  let sumaSentimiento = 0;
  let sumaReacciones = 0;

  const porSentimiento = { Positivo: 0, Neutro: 0, Negativo: 0 };
  const porTipo = {};
  const porCanal = {};
  const porTema = {};
  const porDispositivo = {};
  const heatmap = {};
  const tiposSet = new Set();

  snap.forEach((doc) => {
    const item = serializeInteraction(doc.id, doc.data());
    interacciones.push(item);

    const s = Number.isFinite(item.sentimiento) ? item.sentimiento : 0;
    const r = Number.isFinite(item.reacciones_recibidas) ? item.reacciones_recibidas : 0;

    sumaSentimiento += s;
    sumaReacciones += r;

    const catSent = classifySentiment(s);
    porSentimiento[catSent] = (porSentimiento[catSent] || 0) + 1;

    porTipo[item.tipo] = (porTipo[item.tipo] || 0) + 1;
    porCanal[item.canal] = (porCanal[item.canal] || 0) + 1;
    porTema[item.tema] = (porTema[item.tema] || 0) + 1;
    porDispositivo[item.dispositivo] = (porDispositivo[item.dispositivo] || 0) + 1;

    tiposSet.add(item.tipo);
    if (!heatmap[item.canal]) heatmap[item.canal] = {};
    heatmap[item.canal][item.tipo] = (heatmap[item.canal][item.tipo] || 0) + 1;
  });

  const totalInteracciones = interacciones.length;
  const sentimientoPromedio = totalInteracciones > 0 ? Number((sumaSentimiento / totalInteracciones).toFixed(4)) : 0;
  const promedioReacciones = totalInteracciones > 0 ? Number((sumaReacciones / totalInteracciones).toFixed(2)) : 0;
  const tasaInteraccionUsuario = totalUsuarios > 0 ? Number((totalInteracciones / totalUsuarios).toFixed(4)) : 0;
  const porcentajePositivo = totalInteracciones > 0 ? Number(((porSentimiento.Positivo / totalInteracciones) * 100).toFixed(1)) : 0;

  interacciones.sort((a, b) => {
    const ta = new Date(a.modificado_en || a.timestamp || 0).getTime();
    const tb = new Date(b.modificado_en || b.timestamp || 0).getTime();
    return tb - ta;
  });

  const metrics = {
    actualizado_en: new Date().toISOString(),
    desde_cache: false,
    kpis: {
      total_usuarios: totalUsuarios,
      usuarios_activos: estatusMap.activo,
      usuarios_en_riesgo: estatusMap.en_riesgo,
      usuarios_inactivos: estatusMap.inactivo,
      total_interacciones: totalInteracciones,
      sentimiento_promedio: sentimientoPromedio,
      promedio_reacciones: promedioReacciones,
      tasa_interaccion_usuario: tasaInteraccionUsuario,
      porcentaje_positivo: porcentajePositivo,
    },
    formulas: {
      sentimiento_promedio: 'S̄ = (1 / N_i) * Σ s_k, donde s_k ∈ [-1, 1]',
      tasa_interaccion_usuario: 'R = N_interacciones / N_usuarios',
      promedio_reacciones: 'r̄ = (1 / N_i) * Σ reacciones_k',
      clasificacion_sentimiento: 'Positivo (s > 0.1), Neutro (-0.1 ≤ s ≤ 0.1), Negativo (s < -0.1)',
    },
    distribuciones: {
      sentimiento: porSentimiento,
      tipo: porTipo,
      canal: porCanal,
      tema: porTema,
      dispositivo: porDispositivo,
    },
    heatmap: {
      canales: Object.keys(heatmap).sort(),
      tipos: Array.from(tiposSet).sort(),
      matriz: heatmap,
    },
    recientes: interacciones.slice(0, 15),
  };

  if (persist) {
    await persistIndicatorsToFirestore(db, metrics, estatusMap);
  }

  liveMetricsCache = { ...metrics, desde_cache: true };
  return metrics;
}

// Recalcula métricas desde las fuentes, sincroniza la caché en memoria y actualiza `indicadores` en Firestore
async function recalculateAndPersistMetrics(dbOverride = null) {
  return getLiveMetrics({ forceRefresh: true, persist: true, dbOverride });
}

// Consultas históricas directamente desde TiDB Cloud (sin valores estáticos)
async function getHistoricalStats() {
  const [
    [porPlataforma],
    [porEdad],
    [porInteres],
    [porEspecie],
    [estatusRows],
    [porPais],
    [topCiudades],
    [[resumenTiDB]],
  ] = await Promise.all([
    pool.query(`
      SELECT plataforma_principal AS etiqueta, COUNT(*) AS total
      FROM usuarios
      GROUP BY plataforma_principal
      ORDER BY total DESC
    `),
    pool.query(`
      SELECT rango_edad AS etiqueta, COUNT(*) AS total
      FROM usuarios
      GROUP BY rango_edad
      ORDER BY rango_edad ASC
    `),
    pool.query(`
      SELECT interes_principal AS etiqueta, COUNT(*) AS total
      FROM usuarios
      GROUP BY interes_principal
      ORDER BY total DESC
    `),
    pool.query(`
      SELECT especie_fursona AS etiqueta, COUNT(*) AS total
      FROM usuarios
      GROUP BY especie_fursona
      ORDER BY total DESC
      LIMIT 8
    `),
    pool.query('SELECT estatus, COUNT(*) AS total FROM usuarios GROUP BY estatus;'),
    pool.query(`
      SELECT
        u2.pais AS etiqueta,
        COUNT(*) AS total,
        COUNT(DISTINCT u2.ciudad) AS ciudades,
        SUM(u1.mensajes_30d) AS mensajes_30d,
        ROUND(AVG(u1.sentimiento_promedio), 3) AS sentimiento_medio
      FROM usuarios u1
      INNER JOIN ubicacion u2 ON u1.id_ubicacion = u2.id_ubicacion
      GROUP BY u2.pais
      ORDER BY total DESC
    `),
    pool.query(`
      SELECT
        u2.ciudad,
        u2.estado,
        u2.pais,
        u2.zona_horaria,
        CONCAT(u2.ciudad, ', ', u2.pais) AS etiqueta,
        COUNT(*) AS total,
        ROUND(AVG(u1.sentimiento_promedio), 3) AS sentimiento_medio
      FROM usuarios u1
      INNER JOIN ubicacion u2 ON u1.id_ubicacion = u2.id_ubicacion
      GROUP BY u2.ciudad, u2.estado, u2.pais, u2.zona_horaria
      ORDER BY total DESC
    `),
    pool.query(`
      SELECT
        COUNT(*) AS total_usuarios,
        SUM(CASE WHEN es_artista = 1 THEN 1 ELSE 0 END) AS total_artistas,
        SUM(CASE WHEN consentimiento_datos = 1 THEN 1 ELSE 0 END) AS con_consentimiento,
        ROUND(AVG(sentimiento_promedio), 4) AS sentimiento_historico_promedio,
        SUM(mensajes_30d) AS total_mensajes_30d,
        SUM(reacciones_30d) AS total_reacciones_30d
      FROM usuarios
    `),
  ]);

  const estatusConteo = { activo: 0, en_riesgo: 0, inactivo: 0 };
  for (const r of estatusRows) {
    const key = String(r.estatus || '').toLowerCase();
    if (key in estatusConteo) {
      estatusConteo[key] = Number(r.total || 0);
    }
  }

  const totalUsuarios = Number(resumenTiDB.total_usuarios || 0);
  const porcentajeEnRiesgo = totalUsuarios > 0
    ? Number(((estatusConteo.en_riesgo / totalUsuarios) * 100).toFixed(2))
    : 0;

  return {
    fuente: 'TiDB Cloud (community360)',
    resumen: {
      total_usuarios: totalUsuarios,
      total_artistas: Number(resumenTiDB.total_artistas || 0),
      con_consentimiento: Number(resumenTiDB.con_consentimiento || 0),
      sentimiento_historico_promedio: Number(resumenTiDB.sentimiento_historico_promedio || 0),
      total_mensajes_30d: Number(resumenTiDB.total_mensajes_30d || 0),
      total_reacciones_30d: Number(resumenTiDB.total_reacciones_30d || 0),
      activo: estatusConteo.activo,
      en_riesgo: estatusConteo.en_riesgo,
      inactivo: estatusConteo.inactivo,
      porcentaje_en_riesgo: porcentajeEnRiesgo,
    },
    usuarios_estatus: {
      activo: estatusConteo.activo,
      en_riesgo: estatusConteo.en_riesgo,
      inactivo: estatusConteo.inactivo,
      porcentaje_en_riesgo: porcentajeEnRiesgo,
    },
    por_plataforma: porPlataforma.map((r) => ({ etiqueta: r.etiqueta, total: Number(r.total) })),
    por_edad: porEdad.map((r) => ({ etiqueta: r.etiqueta, total: Number(r.total) })),
    por_interes: porInteres.map((r) => ({ etiqueta: r.etiqueta, total: Number(r.total) })),
    por_especie: porEspecie.map((r) => ({ etiqueta: r.etiqueta, total: Number(r.total) })),
    por_estatus: [
      { etiqueta: 'activo', total: estatusConteo.activo },
      { etiqueta: 'en_riesgo', total: estatusConteo.en_riesgo },
      { etiqueta: 'inactivo', total: estatusConteo.inactivo },
    ],
    por_pais: porPais.map((r) => ({
      etiqueta: r.etiqueta,
      total: Number(r.total),
      ciudades: Number(r.ciudades || 0),
      mensajes_30d: Number(r.mensajes_30d || 0),
      sentimiento_medio: Number(r.sentimiento_medio || 0),
    })),
    top_ciudades: topCiudades.slice(0, 10).map((r) => ({ etiqueta: r.etiqueta, total: Number(r.total) })),
    ciudades_detalle: topCiudades.map((r) => ({
      ciudad: r.ciudad,
      estado: r.estado,
      pais: r.pais,
      zona_horaria: r.zona_horaria,
      etiqueta: r.etiqueta,
      total: Number(r.total),
      sentimiento_medio: Number(r.sentimiento_medio || 0),
    })),
  };
}

module.exports = {
  serializeInteraction,
  getLiveMetrics,
  recalculateAndPersistMetrics,
  getHistoricalStats,
};

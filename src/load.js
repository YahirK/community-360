// ETAPA 8: carga de los registros válidos a TiDB Cloud (relacional) y Cloud Firestore (documental)
// Requiere haber corrido antes: node src/etl.js
// Uso: node src/load.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { parse } = require('csv-parse/sync');
const { pool } = require('./db/tidb');
const { recalculateAndPersistMetrics } = require('./services/metricsService');

const OUT = path.join(__dirname, '..', 'output');
const leerCsv = (f) => parse(fs.readFileSync(path.join(OUT, f), 'utf8'), { columns: true, skip_empty_lines: true });
const leerJsonl = (f) => fs.readFileSync(path.join(OUT, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const nulo = (v) => (v === '' || v === undefined ? null : v);
const requerida = (k) => { if (!process.env[k]) throw new Error(`Falta la variable de entorno ${k}`); return process.env[k]; };

async function cargarTiDB() {
  const cn = await mysql.createConnection({
    host: requerida('TIDB_HOST'),
    port: Number(process.env.TIDB_PORT || 4000),
    user: requerida('TIDB_USER'),
    password: requerida('TIDB_PASSWORD'),
    database: requerida('TIDB_DATABASE'),
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
  });
  try {
    await cn.beginTransaction();

    // 1) ubicacion primero (usuarios depende de ella). Idempotente por UNIQUE(ciudad, estado, pais).
    const ubic = leerCsv('ubicacion_depurado.csv');
    for (const u of ubic) {
      await cn.execute(
        `INSERT INTO ubicacion (id_ubicacion, ciudad, estado, pais, zona_horaria) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE zona_horaria = VALUES(zona_horaria)`,
        [u.id_ubicacion, u.ciudad, u.estado, u.pais, u.zona_horaria]
      );
    }

    // 2) usuarios
    const usuarios = leerCsv('usuarios_depurado.csv');
    const sql = `INSERT INTO usuarios (id_usuario, alias, fecha_ingreso, id_ubicacion, latitud, longitud, rango_edad,
        especie_fursona, interes_principal, plataforma_principal, es_artista, mensajes_30d, reacciones_30d,
        eventos_asistidos, comisiones_compradas, sentimiento_promedio, ultima_actividad, estatus, consentimiento_datos)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE alias=VALUES(alias), id_ubicacion=VALUES(id_ubicacion), latitud=VALUES(latitud),
        longitud=VALUES(longitud), mensajes_30d=VALUES(mensajes_30d), reacciones_30d=VALUES(reacciones_30d),
        eventos_asistidos=VALUES(eventos_asistidos), comisiones_compradas=VALUES(comisiones_compradas),
        sentimiento_promedio=VALUES(sentimiento_promedio), ultima_actividad=VALUES(ultima_actividad),
        estatus=VALUES(estatus), consentimiento_datos=VALUES(consentimiento_datos)`;
    for (const u of usuarios) {
      await cn.execute(sql, [
        u.id_usuario, u.alias, u.fecha_ingreso, nulo(u.id_ubicacion), nulo(u.latitud), nulo(u.longitud), u.rango_edad,
        u.especie_fursona, u.interes_principal, u.plataforma_principal, u.es_artista === 'true' ? 1 : 0,
        Number(u.mensajes_30d), Number(u.reacciones_30d), Number(u.eventos_asistidos), Number(u.comisiones_compradas),
        Number(u.sentimiento_promedio), u.ultima_actividad, u.estatus, u.consentimiento_datos === 'true' ? 1 : 0,
      ]);
    }
    await cn.commit();

    // 3) conteos y verificación de privacidad (esto es lo que se captura como evidencia)
    const [[cu]] = await cn.query('SELECT COUNT(*) AS n FROM usuarios');
    const [[cb]] = await cn.query('SELECT COUNT(*) AS n FROM ubicacion');
    const [[v]] = await cn.query(
      `SELECT COUNT(*) AS n FROM usuarios WHERE consentimiento_datos = 0
       AND (id_ubicacion IS NOT NULL OR latitud IS NOT NULL OR longitud IS NOT NULL)`
    );
    console.log(`[TiDB] ubicacion=${cb.n} | usuarios=${cu.n} | sin consentimiento con datos geográficos=${v.n}`);
    if (v.n !== 0) throw new Error('Verificación de privacidad fallida en TiDB');
  } catch (e) {
    await cn.rollback();
    throw e;
  } finally {
    await cn.end();
  }
}

async function escribirLotes(db, coleccion, docs) {
  // Firestore permite máximo 500 operaciones por lote. set() con ID fijo => idempotente.
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    for (const { id, data } of docs.slice(i, i + 400)) batch.set(db.collection(coleccion).doc(id), data);
    await batch.commit();
  }
}

async function cargarFirestore() {
  const ruta = requerida('GOOGLE_APPLICATION_CREDENTIALS'); // ruta al JSON de la cuenta de servicio (fuera del repositorio)
  if (getApps().length === 0) {
    initializeApp({ credential: cert(JSON.parse(fs.readFileSync(ruta, 'utf8'))) });
  }
  const db = getFirestore();
  const ts = (iso) => Timestamp.fromDate(new Date(iso));
  const ahora = Timestamp.now();

  const inter = leerJsonl('interacciones_firestore.jsonl').map((d) => ({
    id: d.id_interaccion,
    data: (({ id_interaccion, ...r }) => ({ ...r, timestamp: ts(r.timestamp), creado_en: ahora, modificado_en: ahora }))(d),
  }));
  const cuar = leerJsonl('cuarentena_firestore.jsonl').map((d) => ({
    id: `${d.lote_id}_${d.fila_origen}`,
    data: { ...d, detectado_en: ts(d.detectado_en) },
  }));
  const bit = JSON.parse(fs.readFileSync(path.join(OUT, 'bitacora_etl.json'), 'utf8'));
  const bitDoc = [{ id: bit.lote_id, data: { ...bit, ejecutado_en: ts(bit.ejecutado_en) } }];

  await escribirLotes(db, 'interacciones', inter);
  await escribirLotes(db, 'cuarentena', cuar);
  await escribirLotes(db, 'bitacora_etl', bitDoc);

  // Guardado inicial de la colección `indicadores` a partir de TiDB + Firestore
  await recalculateAndPersistMetrics(db);

  // Conteos con agregación count() de las 5 colecciones del proyecto
  for (const c of ['interacciones', 'cuarentena', 'bitacora_etl', 'indicadores', 'auditoria_cambios']) {
    const snap = await db.collection(c).count().get();
    console.log(`[Firestore] ${c} = ${snap.data().count}`);
  }
  // Verificación: ninguna interacción de usuarios sin consentimiento tiene ubicación (ya validado en el ETL;
  // aquí se confirma contra lo guardado). Las interacciones con ubicación nula se cuentan para la evidencia.
  const conUbic = (await db.collection('interacciones').where('ubicacion', '!=', null).count().get()).data().count;
  console.log(`[Firestore] interacciones con ubicación = ${conUbic}`);
}

(async () => {
  try {
    await cargarTiDB();
    await cargarFirestore();
    console.log('Carga completada.');
  } finally {
    await pool.end().catch(() => {});
  }
})().catch((e) => { console.error('ERROR en la carga:', e.details || e.message, e); process.exit(1); });

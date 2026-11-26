const { pool } = require('../db/tidb');
const { getDb, Timestamp } = require('../db/firestore');
const { serializeInteraction, recalculateAndPersistMetrics } = require('../services/metricsService');

const CANALES_CANONICOS = {
  discord: 'Discord',
  facebook: 'Facebook',
  instagram: 'Instagram',
  telegram: 'Telegram',
  tiktok: 'TikTok',
  'twitter/x': 'Twitter/X',
  twitter: 'Twitter/X',
  x: 'Twitter/X',
  youtube: 'YouTube',
  reddit: 'Reddit',
};

const DISPOSITIVOS_CANONICOS = {
  android: 'Android',
  ios: 'iOS',
  escritorio: 'Escritorio',
  web: 'Web',
};

const TIPOS_VALIDOS = ['mensaje', 'comentario', 'reaccion', 'respuesta_encuesta', 'rsvp_evento'];
const ETIQUETAS_PERMITIDAS = ['arte', 'aviso', 'evento', 'humor', 'juegos', 'musica', 'reglas'];

const colapsa = (s) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim());

function normalizeCanal(raw) {
  const c = colapsa(raw);
  if (!c) return '';
  const mapped = CANALES_CANONICOS[c.toLowerCase()];
  if (mapped) return mapped;
  return c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
}

function normalizeDispositivo(raw) {
  const d = colapsa(raw);
  if (!d) return 'Escritorio';
  const mapped = DISPOSITIVOS_CANONICOS[d.toLowerCase()];
  if (mapped) return mapped;
  return d.charAt(0).toUpperCase() + d.slice(1).toLowerCase();
}

function normalizeUbicacion(ubic) {
  if (!ubic || typeof ubic !== 'object' || Array.isArray(ubic)) return null;
  const pais = colapsa(ubic.pais) || null;
  const estado = colapsa(ubic.estado) || null;
  const ciudad = colapsa(ubic.ciudad) || null;
  if (!pais && !estado && !ciudad) return null;
  return { pais, estado, ciudad };
}

function normalizeTexto(rawTexto, tipoNormalizado) {
  if (tipoNormalizado === 'reaccion') return null;
  if (rawTexto === null || rawTexto === undefined) return null;
  const limpio = String(rawTexto).trim();
  return limpio.length > 0 ? limpio : null;
}

function generateInteractionId() {
  const num = Math.floor(1000000 + Math.random() * 8999999);
  return `I${num}`;
}

function getAdminIdFromReq(req) {
  const rawId = req.user?.id_admin ?? req.admin?.id_admin;
  const num = Number(rawId);
  return Number.isInteger(num) ? num : null;
}

// Registra cada operación de escritura en la colección `auditoria_cambios` de Firestore
async function registrarAuditoria(req, { codigo_http, id_interaccion = null, antes = null, despues = null }) {
  try {
    const db = getDb();
    await db.collection('auditoria_cambios').add({
      fecha: Timestamp.now(),
      metodo: req.method,
      ruta: req.originalUrl,
      codigo_http: Number(codigo_http),
      id_interaccion: id_interaccion ? String(id_interaccion) : null,
      antes: antes ?? null,
      despues: despues ?? null,
      id_admin: getAdminIdFromReq(req),
    });
  } catch (auditErr) {
    console.error('[Auditoría] No se pudo guardar registro en auditoria_cambios:', auditErr.message);
  }
}

function validatePayload(body, isUpdate = false) {
  const errors = [];

  if (!isUpdate) {
    if (!body.id_usuario || typeof body.id_usuario !== 'string' || !body.id_usuario.trim()) {
      errors.push('id_usuario es obligatorio y debe ser texto (ej. "U000002").');
    }
    if (!body.canal || typeof body.canal !== 'string' || !body.canal.trim()) {
      errors.push('canal es obligatorio y debe ser texto (ej. "Discord", "Instagram").');
    }
    if (!body.tipo || typeof body.tipo !== 'string' || !body.tipo.trim()) {
      errors.push(`tipo es obligatorio y debe pertenecer a: ${TIPOS_VALIDOS.join(', ')}.`);
    }
    if (body.sentimiento === undefined || body.sentimiento === null || typeof body.sentimiento !== 'number' || Number.isNaN(body.sentimiento)) {
      errors.push('sentimiento es obligatorio y debe ser un número entre -1 y 1.');
    }
  } else {
    if (body.id_usuario !== undefined && (typeof body.id_usuario !== 'string' || !body.id_usuario.trim())) {
      errors.push('id_usuario debe ser un texto no vacío.');
    }
    if (body.canal !== undefined && (typeof body.canal !== 'string' || !body.canal.trim())) {
      errors.push('canal debe ser un texto no vacío.');
    }
  }

  if (body.tipo !== undefined) {
    if (typeof body.tipo !== 'string' || !TIPOS_VALIDOS.includes(colapsa(body.tipo).toLowerCase())) {
      errors.push(`tipo inválido. Valores permitidos: ${TIPOS_VALIDOS.join(', ')}.`);
    }
  }

  if (body.tema !== undefined && body.tema !== null) {
    if (typeof body.tema !== 'string' || !colapsa(body.tema)) {
      errors.push('tema debe ser un texto no vacío.');
    }
  }

  if (body.idioma !== undefined && body.idioma !== null) {
    if (typeof body.idioma !== 'string' || !colapsa(body.idioma)) {
      errors.push('idioma debe ser un código de idioma válido (ej. "es").');
    }
  }

  if (body.sentimiento !== undefined && body.sentimiento !== null) {
    if (typeof body.sentimiento !== 'number' || Number.isNaN(body.sentimiento) || body.sentimiento < -1 || body.sentimiento > 1) {
      errors.push('sentimiento debe estar en el rango [-1, 1].');
    }
  }

  if (body.reacciones_recibidas !== undefined && body.reacciones_recibidas !== null) {
    if (typeof body.reacciones_recibidas !== 'number' || body.reacciones_recibidas < 0 || !Number.isInteger(body.reacciones_recibidas)) {
      errors.push('reacciones_recibidas debe ser un entero mayor o igual a 0.');
    }
  }

  if (body.etiquetas !== undefined) {
    if (!Array.isArray(body.etiquetas) || body.etiquetas.some((t) => typeof t !== 'string')) {
      errors.push('etiquetas debe ser un arreglo de cadenas de texto.');
    } else {
      const invalidTags = body.etiquetas
        .map((t) => t.trim().toLowerCase())
        .filter((t) => !t || !ETIQUETAS_PERMITIDAS.includes(t));
      if (invalidTags.length > 0) {
        errors.push(
          `etiquetas contiene valores fuera del catálogo permitido (${ETIQUETAS_PERMITIDAS.join(', ')}): ${invalidTags.join(', ')}`
        );
      }
    }
  }

  if (body.timestamp !== undefined && body.timestamp !== null) {
    const parsed = new Date(body.timestamp);
    if (Number.isNaN(parsed.getTime())) {
      errors.push('timestamp debe ser una fecha ISO 8601 válida.');
    }
  }

  if (body.ubicacion !== undefined && body.ubicacion !== null) {
    if (typeof body.ubicacion !== 'object' || Array.isArray(body.ubicacion)) {
      errors.push('ubicacion debe ser un objeto { pais, estado, ciudad } o null.');
    }
  }

  return errors;
}

// GET /api/interactions
async function listInteractions(req, res) {
  try {
    const db = getDb();
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 500);
    const { canal, tipo, id_usuario } = req.query;

    const snap = await db.collection('interacciones').get();
    let items = [];

    snap.forEach((doc) => {
      items.push(serializeInteraction(doc.id, doc.data()));
    });

    if (canal) items = items.filter((i) => i.canal.toLowerCase() === String(canal).trim().toLowerCase());
    if (tipo) items = items.filter((i) => i.tipo.toLowerCase() === String(tipo).trim().toLowerCase());
    if (id_usuario) items = items.filter((i) => i.id_usuario === String(id_usuario).trim().toUpperCase());

    items.sort((a, b) => {
      const ta = new Date(a.modificado_en || a.timestamp || 0).getTime();
      const tb = new Date(b.modificado_en || b.timestamp || 0).getTime();
      return tb - ta;
    });

    return res.status(200).json({
      success: true,
      total: items.length,
      limit,
      data: items.slice(0, limit),
    });
  } catch (error) {
    console.error('[Interactions] Error al listar:', error);
    return res.status(500).json({
      success: false,
      message: 'Error al consultar las interacciones en Firestore.',
    });
  }
}

// GET /api/interactions/:id
async function getInteractionById(req, res) {
  try {
    const db = getDb();
    const docId = String(req.params.id || '').trim().toUpperCase();
    const doc = await db.collection('interacciones').doc(docId).get();

    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        message: `Interacción '${docId}' no encontrada.`,
      });
    }

    return res.status(200).json({
      success: true,
      data: serializeInteraction(doc.id, doc.data()),
    });
  } catch (error) {
    console.error('[Interactions] Error al obtener por ID:', error);
    return res.status(500).json({
      success: false,
      message: 'Error al consultar la interacción.',
    });
  }
}

// POST /api/interactions
async function createInteraction(req, res) {
  const body = req.body || {};
  const candidateId = body.id_interaccion && typeof body.id_interaccion === 'string'
    ? body.id_interaccion.trim().toUpperCase()
    : null;

  const errors = validatePayload(body, false);
  if (errors.length > 0) {
    await registrarAuditoria(req, {
      codigo_http: 400,
      id_interaccion: candidateId,
      antes: null,
      despues: null,
    });
    return res.status(400).json({
      success: false,
      message: 'Datos de interacción inválidos.',
      errors,
    });
  }

  try {
    const idUsuarioNorm = body.id_usuario.trim().toUpperCase();

    // Verificar integridad referencial y consentimiento en TiDB Cloud
    const [users] = await pool.query(
      'SELECT id_usuario, consentimiento_datos FROM usuarios WHERE id_usuario = ? LIMIT 1',
      [idUsuarioNorm]
    );

    if (users.length === 0) {
      await registrarAuditoria(req, {
        codigo_http: 400,
        id_interaccion: candidateId,
        antes: null,
        despues: null,
      });
      return res.status(400).json({
        success: false,
        message: `El usuario '${idUsuarioNorm}' no existe en TiDB Cloud.`,
      });
    }

    const tieneConsentimiento = Boolean(users[0].consentimiento_datos);
    const db = getDb();
    const docId = candidateId || generateInteractionId();

    const docRef = db.collection('interacciones').doc(docId);
    const existing = await docRef.get();
    if (existing.exists) {
      await registrarAuditoria(req, {
        codigo_http: 409,
        id_interaccion: docId,
        antes: serializeInteraction(docId, existing.data()),
        despues: null,
      });
      return res.status(409).json({
        success: false,
        message: `Ya existe una interacción con el ID '${docId}'.`,
      });
    }

    const ahora = Timestamp.now();
    const eventTime = body.timestamp ? Timestamp.fromDate(new Date(body.timestamp)) : ahora;
    const tipoNorm = colapsa(body.tipo).toLowerCase();
    const canalNorm = normalizeCanal(body.canal);
    const temaNorm = body.tema ? colapsa(body.tema).toLowerCase() : 'general';
    const idiomaNorm = body.idioma ? colapsa(body.idioma).toLowerCase() : 'es';
    const dispositivoNorm = normalizeDispositivo(body.dispositivo);
    const textoNorm = normalizeTexto(body.texto, tipoNorm);
    const etiquetasNorm = Array.isArray(body.etiquetas)
      ? [...new Set(body.etiquetas.map((t) => t.trim().toLowerCase()))]
      : [];

    // Respetar política de privacidad: si no dio consentimiento, anular ubicación
    const ubicacionFinal = tieneConsentimiento ? normalizeUbicacion(body.ubicacion) : null;

    const nuevoDoc = {
      id_usuario: idUsuarioNorm,
      timestamp: eventTime,
      canal: canalNorm,
      tipo: tipoNorm,
      texto: textoNorm,
      tema: temaNorm,
      sentimiento: Number(body.sentimiento),
      idioma: idiomaNorm,
      dispositivo: dispositivoNorm,
      longitud_texto: textoNorm ? textoNorm.length : 0,
      reacciones_recibidas: body.reacciones_recibidas !== undefined ? Number(body.reacciones_recibidas) : 0,
      etiquetas: etiquetasNorm,
      ubicacion: ubicacionFinal,
      creado_en: ahora,
      modificado_en: ahora,
    };

    await docRef.set(nuevoDoc);

    const interaction = serializeInteraction(docId, nuevoDoc);
    await registrarAuditoria(req, {
      codigo_http: 201,
      id_interaccion: docId,
      antes: null,
      despues: interaction,
    });

    const metrics = await recalculateAndPersistMetrics();

    // Notificar en tiempo real mediante WebSockets
    const io = req.app.get('io');
    if (io) {
      io.emit('interaction:created', {
        event: 'created',
        interaction,
        metrics,
        notificado_en: new Date().toISOString(),
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Interacción creada y notificada en tiempo real.',
      privacidad_ubicacion_aplicada: !tieneConsentimiento && Boolean(body.ubicacion),
      data: interaction,
    });
  } catch (error) {
    console.error('[Interactions] Error al crear:', error);
    await registrarAuditoria(req, {
      codigo_http: 500,
      id_interaccion: candidateId,
      antes: null,
      despues: null,
    });
    return res.status(500).json({
      success: false,
      message: 'Error interno al crear la interacción.',
    });
  }
}

// PUT /api/interactions/:id
async function updateInteraction(req, res) {
  const body = req.body || {};
  const docId = String(req.params.id || '').trim().toUpperCase();
  const errors = validatePayload(body, true);

  if (errors.length > 0) {
    await registrarAuditoria(req, {
      codigo_http: 400,
      id_interaccion: docId || null,
      antes: null,
      despues: null,
    });
    return res.status(400).json({
      success: false,
      message: 'Datos de actualización inválidos.',
      errors,
    });
  }

  let antesSnapshot = null;

  try {
    const db = getDb();
    const docRef = db.collection('interacciones').doc(docId);
    const snap = await docRef.get();

    if (!snap.exists) {
      await registrarAuditoria(req, {
        codigo_http: 404,
        id_interaccion: docId,
        antes: null,
        despues: null,
      });
      return res.status(404).json({
        success: false,
        message: `Interacción '${docId}' no encontrada.`,
      });
    }

    const current = snap.data();
    antesSnapshot = serializeInteraction(docId, current);

    const targetUserId = body.id_usuario
      ? body.id_usuario.trim().toUpperCase()
      : String(current.id_usuario || '').trim().toUpperCase();

    // Verificar usuario y consentimiento en TiDB
    const [users] = await pool.query(
      'SELECT id_usuario, consentimiento_datos FROM usuarios WHERE id_usuario = ? LIMIT 1',
      [targetUserId]
    );
    if (users.length === 0) {
      await registrarAuditoria(req, {
        codigo_http: 400,
        id_interaccion: docId,
        antes: antesSnapshot,
        despues: null,
      });
      return res.status(400).json({
        success: false,
        message: `El usuario '${targetUserId}' no existe en TiDB Cloud.`,
      });
    }

    const tieneConsentimiento = Boolean(users[0].consentimiento_datos);
    const ahora = Timestamp.now();
    const tipoFinal = body.tipo !== undefined
      ? colapsa(body.tipo).toLowerCase()
      : colapsa(current.tipo || 'mensaje').toLowerCase();

    const rawTexto = body.texto !== undefined ? body.texto : current.texto;
    const textoFinal = normalizeTexto(rawTexto, tipoFinal);

    const updates = {
      id_usuario: targetUserId,
      tipo: tipoFinal,
      texto: textoFinal,
      longitud_texto: textoFinal ? textoFinal.length : 0,
      creado_en: current.creado_en instanceof Timestamp ? current.creado_en : ahora,
      modificado_en: ahora,
    };

    if (body.canal !== undefined) updates.canal = normalizeCanal(body.canal);
    if (body.tema !== undefined) updates.tema = colapsa(body.tema).toLowerCase();
    if (body.sentimiento !== undefined) updates.sentimiento = Number(body.sentimiento);
    if (body.idioma !== undefined) updates.idioma = colapsa(body.idioma).toLowerCase();
    if (body.dispositivo !== undefined) updates.dispositivo = normalizeDispositivo(body.dispositivo);
    if (body.reacciones_recibidas !== undefined) updates.reacciones_recibidas = Number(body.reacciones_recibidas);
    if (body.etiquetas !== undefined) {
      updates.etiquetas = [...new Set(body.etiquetas.map((t) => t.trim().toLowerCase()))];
    }
    if (body.timestamp !== undefined) {
      updates.timestamp = Timestamp.fromDate(new Date(body.timestamp));
    }

    if (!tieneConsentimiento) {
      updates.ubicacion = null;
    } else if (body.ubicacion !== undefined) {
      updates.ubicacion = normalizeUbicacion(body.ubicacion);
    }

    await docRef.update(updates);

    const updatedSnap = await docRef.get();
    const interaction = serializeInteraction(docId, updatedSnap.data());

    await registrarAuditoria(req, {
      codigo_http: 200,
      id_interaccion: docId,
      antes: antesSnapshot,
      despues: interaction,
    });

    const metrics = await recalculateAndPersistMetrics();

    // Notificar en tiempo real mediante WebSockets
    const io = req.app.get('io');
    if (io) {
      io.emit('interaction:updated', {
        event: 'updated',
        interaction,
        metrics,
        notificado_en: new Date().toISOString(),
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Interacción actualizada y notificada en tiempo real.',
      data: interaction,
    });
  } catch (error) {
    console.error('[Interactions] Error al actualizar:', error);
    await registrarAuditoria(req, {
      codigo_http: 500,
      id_interaccion: docId,
      antes: antesSnapshot,
      despues: null,
    });
    return res.status(500).json({
      success: false,
      message: 'Error interno al actualizar la interacción.',
    });
  }
}

// DELETE /api/interactions/:id
async function deleteInteraction(req, res) {
  const docId = String(req.params.id || '').trim().toUpperCase();
  let antesSnapshot = null;

  try {
    const db = getDb();
    const docRef = db.collection('interacciones').doc(docId);
    const snap = await docRef.get();

    if (!snap.exists) {
      await registrarAuditoria(req, {
        codigo_http: 404,
        id_interaccion: docId,
        antes: null,
        despues: null,
      });
      return res.status(404).json({
        success: false,
        message: `Interacción '${docId}' no encontrada.`,
      });
    }

    antesSnapshot = serializeInteraction(docId, snap.data());
    await docRef.delete();

    await registrarAuditoria(req, {
      codigo_http: 200,
      id_interaccion: docId,
      antes: antesSnapshot,
      despues: null,
    });

    const metrics = await recalculateAndPersistMetrics();

    // Notificar en tiempo real mediante WebSockets
    const io = req.app.get('io');
    if (io) {
      io.emit('interaction:deleted', {
        event: 'deleted',
        id_interaccion: docId,
        metrics,
        notificado_en: new Date().toISOString(),
      });
    }

    return res.status(200).json({
      success: true,
      message: `Interacción '${docId}' eliminada y notificada en tiempo real.`,
      id_interaccion: docId,
    });
  } catch (error) {
    console.error('[Interactions] Error al eliminar:', error);
    await registrarAuditoria(req, {
      codigo_http: 500,
      id_interaccion: docId,
      antes: antesSnapshot,
      despues: null,
    });
    return res.status(500).json({
      success: false,
      message: 'Error interno al eliminar la interacción.',
    });
  }
}

module.exports = {
  listInteractions,
  getInteractionById,
  createInteraction,
  updateInteraction,
  deleteInteraction,
  CANALES_CANONICOS,
  TIPOS_VALIDOS,
  ETIQUETAS_PERMITIDAS,
};

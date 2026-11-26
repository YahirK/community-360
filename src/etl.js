// ETL Fase 2 - COMMUNITY 360 (etapas 1 a 7: todo local, sin tocar la nube)
// Uso: node src/etl.js
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify: _stringify } = require('csv-stringify/sync');
// booleanos explícitos (por defecto csv-stringify escribe false como celda vacía)
const stringify = (rows, opts) => _stringify(rows, { ...opts, cast: { boolean: (v) => (v ? 'true' : 'false') } });

const VERSION_SCRIPT = '1.0.0';
const DATA = path.join(__dirname, '..', 'data');
const OUT = path.join(__dirname, '..', 'output');
const ARCH_USR = 'comunidad_virtual_usuarios.csv';
const ARCH_INT = 'comunidad_virtual_1000_interacciones.csv';
const LOTE_ID = 'lote_' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

const bitacora = { lote_id: LOTE_ID, version_script: VERSION_SCRIPT, pasos: [] };
const cuarentena = [];
const paso = (etapa, detalle) => {
  bitacora.pasos.push({ etapa, ...detalle });
  console.log(`[Etapa ${etapa}]`, JSON.stringify(detalle));
};

const leer = (archivo) =>
  parse(fs.readFileSync(path.join(DATA, archivo), 'utf8'), {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: false,
  });

// Ubicación que se elimina de los registros enviados a cuarentena
const sinUbicacion = (r) => {
  const c = { ...r };
  for (const k of ['pais', 'estado', 'ciudad', 'zona_horaria', 'latitud', 'longitud', '_fila']) delete c[k];
  return c;
};
const rechazar = (archivo, fila, motivo, registro) =>
  cuarentena.push({
    lote_id: LOTE_ID,
    archivo_origen: archivo,
    fila_origen: fila,
    motivo,
    registro_original: sinUbicacion(registro),
    detectado_en: new Date().toISOString(),
  });

// ---------- ETAPA 1: duplicados ----------
function etapa1(filas, archivo, llave, extra = []) {
  const vistos = new Map();
  const vistosAlias = new Set();
  const vistosContenido = new Set();
  const salida = [];
  let dupId = 0, dupAlias = 0, dupContenido = 0;
  filas.forEach((r, idx) => {
    const fila = idx + 2; // +1 por encabezado, +1 por base 1
    const id = (r[llave] || '').trim().toUpperCase();
    const contenido = JSON.stringify(Object.entries(r).filter(([k]) => k !== llave).map(([, v]) => v));
    if (vistos.has(id)) { dupId++; rechazar(archivo, fila, 'id_duplicado', r); return; }
    if (extra.includes('alias')) {
      const a = (r.alias || '').trim().toLowerCase();
      if (vistosAlias.has(a)) { dupAlias++; rechazar(archivo, fila, 'id_duplicado', r); return; }
      vistosAlias.add(a);
    }
    if (vistosContenido.has(contenido)) { dupContenido++; rechazar(archivo, fila, 'contenido_duplicado', r); return; }
    vistos.set(id, true);
    vistosContenido.add(contenido);
    salida.push({ ...r, _fila: fila });
  });
  paso(1, { archivo, leidos: filas.length, duplicados_por_id: dupId, duplicados_por_alias: dupAlias, duplicados_por_contenido: dupContenido, conservados: salida.length });
  return salida;
}

// ---------- ETAPA 2: vacíos y nulos ----------
const VACIOS = new Set(['', 'null', 'nan', 'n/a', 'na', 'none', 'undefined']);
function etapa2(filas, archivo) {
  const porCampo = {};
  for (const r of filas) {
    for (const k of Object.keys(r)) {
      if (k === '_fila') continue;
      const v = typeof r[k] === 'string' ? r[k].trim() : r[k];
      if (v === null || VACIOS.has(String(v).toLowerCase())) {
        porCampo[k] = (porCampo[k] || 0) + 1;
        r[k] = null;
      } else r[k] = v;
    }
  }
  paso(2, { archivo, nulos_por_campo: porCampo });
  return filas;
}

// ---------- ETAPA 3: estandarizar fechas, categorías y multivaluados ----------
const fechaDMY = (s) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || '');
  if (!m) return null;
  const [_, d, mo, y] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  return dt.getUTCFullYear() === +y && dt.getUTCMonth() === +mo - 1 && dt.getUTCDate() === +d ? `${y}-${mo}-${d}` : null;
};
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const colapsa = (s) => (s == null ? s : s.replace(/\s+/g, ' ').trim());

function etapa3Usuarios(filas) {
  let fechasConvertidas = 0;
  for (const r of filas) {
    r.id_usuario = r.id_usuario.toUpperCase();
    for (const k of ['fecha_ingreso', 'ultima_actividad']) {
      if (r[k] !== null) { const f = fechaDMY(r[k]); if (f) fechasConvertidas++; r[k] = f ?? '__INVALIDA__'; }
    }
    for (const k of ['estatus', 'consentimiento_datos']) r[k] = r[k] === null ? null : r[k].toLowerCase();
    for (const k of ['alias', 'pais', 'estado', 'ciudad', 'zona_horaria', 'rango_edad', 'especie_fursona', 'interes_principal', 'plataforma_principal'])
      r[k] = colapsa(r[k]);
  }
  paso(3, { archivo: ARCH_USR, fechas_dd_mm_aaaa_a_iso: fechasConvertidas });
  return filas;
}
function etapa3Interacciones(filas) {
  let etiquetasSeparadas = 0, tsNormalizados = 0;
  for (const r of filas) {
    r.id_interaccion = r.id_interaccion.toUpperCase();
    r.id_usuario = r.id_usuario.toUpperCase();
    if (r.timestamp !== null) {
      const d = new Date(r.timestamp);
      if (!isNaN(d)) {
        const iso = d.toISOString().replace('.000Z', 'Z');
        if (iso !== r.timestamp) tsNormalizados++;
        r.timestamp = iso;
      } else r.timestamp = '__INVALIDA__';
    }
    for (const k of ['tipo', 'tema', 'idioma']) r[k] = r[k] === null ? null : r[k].toLowerCase();
    for (const k of ['canal', 'dispositivo', 'pais', 'estado', 'ciudad']) r[k] = colapsa(r[k]);
    // multivaluado: "arte|humor" -> ["arte","humor"], vacío -> []
    r.etiquetas = r.etiquetas === null ? [] : [...new Set(r.etiquetas.split('|').map((t) => t.trim().toLowerCase()).filter(Boolean))];
    if (r.etiquetas.length) etiquetasSeparadas++;
  }
  paso(3, { archivo: ARCH_INT, timestamps_normalizados_a_utc: tsNormalizados, filas_con_etiquetas_separadas: etiquetasSeparadas });
  return filas;
}

// ---------- ETAPA 4: validación de tipos ----------
const esEntero = (v) => v !== null && /^-?\d+$/.test(v);
const esFlotante = (v) => v !== null && /^-?\d+(\.\d+)?$/.test(v);
const ENT_NO_NEG_U = ['mensajes_30d', 'reacciones_30d', 'eventos_asistidos', 'comisiones_compradas'];

function validaUsuario(r) {
  const err = [];
  if (!/^U\d{6}$/.test(r.id_usuario)) err.push('id_usuario');
  if (!r.alias) err.push('alias');
  for (const k of ['fecha_ingreso', 'ultima_actividad']) if (r[k] === '__INVALIDA__' || r[k] === null) err.push(k);
  for (const k of ENT_NO_NEG_U) if (!esEntero(r[k]) || +r[k] < 0) err.push(k);
  if (!['0', '1'].includes(r.es_artista)) err.push('es_artista');
  if (!['si', 'no'].includes(r.consentimiento_datos)) err.push('consentimiento_datos');
  if (!esFlotante(r.sentimiento_promedio) || Math.abs(+r.sentimiento_promedio) > 1) err.push('sentimiento_promedio');
  if (r.latitud !== null && (!esFlotante(r.latitud) || Math.abs(+r.latitud) > 90)) err.push('latitud');
  if (r.longitud !== null && (!esFlotante(r.longitud) || Math.abs(+r.longitud) > 180)) err.push('longitud');
  if (!['activo', 'en_riesgo', 'inactivo'].includes(r.estatus)) err.push('estatus');
  return err;
}
function validaInteraccion(r) {
  const err = [];
  if (!/^I\d{7}$/.test(r.id_interaccion)) err.push('id_interaccion');
  if (!/^U\d{6}$/.test(r.id_usuario)) err.push('id_usuario');
  if (r.timestamp === null || r.timestamp === '__INVALIDA__' || !ISO_UTC.test(r.timestamp)) err.push('timestamp');
  if (!r.canal) err.push('canal');
  if (!['mensaje', 'comentario', 'reaccion', 'respuesta_encuesta', 'rsvp_evento'].includes(r.tipo)) err.push('tipo');
  if (!r.tema) err.push('tema');
  if (!esFlotante(r.sentimiento) || Math.abs(+r.sentimiento) > 1) err.push('sentimiento');
  if (!esEntero(r.reacciones_recibidas) || +r.reacciones_recibidas < 0) err.push('reacciones_recibidas');
  if (!esEntero(r.longitud_texto) || +r.longitud_texto < 0) err.push('longitud_texto');
  return err;
}
function etapa4(filas, archivo, validador, convierte) {
  const buenos = [];
  const motivos = {};
  for (const r of filas) {
    const err = validador(r);
    if (err.length) { err.forEach((c) => (motivos[c] = (motivos[c] || 0) + 1)); rechazar(archivo, r._fila, 'valor_invalido', { ...r, campos_invalidos: err }); continue; }
    buenos.push(convierte(r));
  }
  paso(4, { archivo, validos: buenos.length, rechazados_valor_invalido: filas.length - buenos.length, campos_invalidos: motivos });
  return buenos;
}
const convUsuario = (r) => ({
  ...r,
  latitud: r.latitud === null ? null : +r.latitud,
  longitud: r.longitud === null ? null : +r.longitud,
  es_artista: r.es_artista === '1',
  consentimiento_datos: r.consentimiento_datos === 'si',
  mensajes_30d: +r.mensajes_30d, reacciones_30d: +r.reacciones_30d,
  eventos_asistidos: +r.eventos_asistidos, comisiones_compradas: +r.comisiones_compradas,
  sentimiento_promedio: +r.sentimiento_promedio,
  // marca de atípicos: se señalan y no se eliminan
  atipico: +r.reacciones_30d > 500 || +r.mensajes_30d > 300,
});
const convInteraccion = (r) => {
  const texto = r.texto;
  return {
    ...r,
    texto,
    sentimiento: +r.sentimiento,
    reacciones_recibidas: +r.reacciones_recibidas,
    longitud_texto: texto ? texto.length : 0, // se recalcula; 0 sin texto
  };
};

// ---------- ETAPA 5: integridad referencial ----------
function etapa5(inter, usuarios) {
  const padron = new Set(usuarios.map((u) => u.id_usuario));
  const validas = [];
  let huerfanas = 0, huerfanasConUbicacion = 0;
  for (const r of inter) {
    if (!padron.has(r.id_usuario)) {
      huerfanas++;
      if (r.ciudad || r.estado || r.pais) huerfanasConUbicacion++;
      rechazar(ARCH_INT, r._fila, 'usuario_inexistente', { ...r, etiquetas: r.etiquetas.join('|') });
      continue;
    }
    validas.push(r);
  }
  const usuariosConInteracciones = new Set(validas.map((r) => r.id_usuario)).size;
  paso(5, { interacciones_revisadas: inter.length, huerfanas_a_cuarentena: huerfanas, huerfanas_con_ubicacion_eliminada: huerfanasConUbicacion, interacciones_validas: validas.length, usuarios_distintos_con_interacciones: usuariosConInteracciones });
  return validas;
}

// ---------- ETAPA 6: privacidad ----------
function etapa6(usuarios, inter) {
  const sinConsentimiento = new Set();
  let usuariosDepurados = 0, camposAnulados = 0;
  for (const u of usuarios) {
    if (u.consentimiento_datos === false) {
      sinConsentimiento.add(u.id_usuario);
      usuariosDepurados++;
      for (const k of ['pais', 'estado', 'ciudad', 'zona_horaria', 'latitud', 'longitud']) {
        if (u[k] !== null) camposAnulados++;
        u[k] = null;
      }
    }
  }
  let interDepuradas = 0;
  for (const r of inter) {
    if (sinConsentimiento.has(r.id_usuario)) {
      if (r.pais || r.estado || r.ciudad) interDepuradas++;
      r.pais = r.estado = r.ciudad = null;
    }
    r.ubicacion = r.pais || r.estado || r.ciudad ? { pais: r.pais, estado: r.estado, ciudad: r.ciudad } : null;
  }
  paso(6, { usuarios_sin_consentimiento_depurados: usuariosDepurados, campos_geograficos_anulados: camposAnulados, interacciones_de_esos_usuarios: inter.filter((r) => sinConsentimiento.has(r.id_usuario)).length, interacciones_con_ubicacion_eliminada_en_esta_etapa: interDepuradas });
}

// catálogo normalizado de ubicaciones (solo usuarios con consentimiento)
function construirUbicaciones(usuarios) {
  const mapa = new Map();
  for (const u of usuarios) {
    if (!u.ciudad) continue;
    const clave = [u.ciudad, u.estado, u.pais].join('|');
    if (!mapa.has(clave)) mapa.set(clave, { ciudad: u.ciudad, estado: u.estado, pais: u.pais, zona_horaria: u.zona_horaria });
  }
  const lista = [...mapa.values()].sort((a, b) => (a.pais + a.estado + a.ciudad).localeCompare(b.pais + b.estado + b.ciudad)).map((x, i) => ({ id_ubicacion: i + 1, ...x }));
  const idx = new Map(lista.map((x) => [[x.ciudad, x.estado, x.pais].join('|'), x.id_ubicacion]));
  for (const u of usuarios) u.id_ubicacion = u.ciudad ? idx.get([u.ciudad, u.estado, u.pais].join('|')) : null;
  return lista;
}

// ---------- ETAPA 7: exportación ----------
function etapa7(usuarios, ubicaciones, inter, bit) {
  fs.mkdirSync(OUT, { recursive: true });
  const w = (nombre, contenido) => fs.writeFileSync(path.join(OUT, nombre), contenido, 'utf8');
  const colsU = ['id_usuario', 'alias', 'fecha_ingreso', 'id_ubicacion', 'latitud', 'longitud', 'rango_edad', 'especie_fursona', 'interes_principal', 'plataforma_principal', 'es_artista', 'mensajes_30d', 'reacciones_30d', 'eventos_asistidos', 'comisiones_compradas', 'sentimiento_promedio', 'ultima_actividad', 'estatus', 'consentimiento_datos', 'atipico'];
  const colsI = ['id_interaccion', 'id_usuario', 'timestamp', 'canal', 'tipo', 'texto', 'tema', 'sentimiento', 'idioma', 'dispositivo', 'longitud_texto', 'reacciones_recibidas', 'etiquetas', 'pais', 'estado', 'ciudad'];
  w('usuarios_depurado.csv', stringify(usuarios, { header: true, columns: colsU }));
  w('ubicacion_depurado.csv', stringify(ubicaciones, { header: true, columns: ['id_ubicacion', 'ciudad', 'estado', 'pais', 'zona_horaria'] }));
  w('interacciones_depuradas.csv', stringify(inter.map((r) => ({ ...r, etiquetas: r.etiquetas.join('|') })), { header: true, columns: colsI }));
  const cuarCsv = cuarentena.map((c) => ({ ...c, registro_original: JSON.stringify(c.registro_original) }));
  w('cuarentena.csv', stringify(cuarCsv, { header: true, columns: ['lote_id', 'archivo_origen', 'fila_origen', 'motivo', 'registro_original', 'detectado_en'] }));
  // JSONL con la forma final del documento de Firestore
  w('interacciones_firestore.jsonl', inter.map((r) => JSON.stringify({
    id_interaccion: r.id_interaccion, id_usuario: r.id_usuario, timestamp: r.timestamp, canal: r.canal, tipo: r.tipo,
    texto: r.texto, tema: r.tema, sentimiento: r.sentimiento, idioma: r.idioma, dispositivo: r.dispositivo,
    longitud_texto: r.longitud_texto, reacciones_recibidas: r.reacciones_recibidas, etiquetas: r.etiquetas, ubicacion: r.ubicacion,
  })).join('\n') + '\n');
  w('cuarentena_firestore.jsonl', cuarentena.map((c) => JSON.stringify(c)).join('\n') + '\n');
  w('bitacora_etl.json', JSON.stringify(bit, null, 2));
  paso(7, { archivos_generados: fs.readdirSync(OUT).sort(), usuarios: usuarios.length, ubicaciones: ubicaciones.length, interacciones_validas: inter.length, registros_en_cuarentena: cuarentena.length });
}

// ---------- Ejecución ----------
function main() {
  console.log(`== ETL COMMUNITY 360 | ${LOTE_ID} | v${VERSION_SCRIPT} ==`);
  const rawU = leer(ARCH_USR), rawI = leer(ARCH_INT);
  console.log(`Leídos: usuarios=${rawU.length}, interacciones=${rawI.length}`);

  let u = etapa1(rawU, ARCH_USR, 'id_usuario', ['alias']);
  let i = etapa1(rawI, ARCH_INT, 'id_interaccion');
  u = etapa2(u, ARCH_USR); i = etapa2(i, ARCH_INT);
  u = etapa3Usuarios(u); i = etapa3Interacciones(i);
  u = etapa4(u, ARCH_USR, validaUsuario, convUsuario);
  i = etapa4(i, ARCH_INT, validaInteraccion, convInteraccion);
  i = etapa5(i, u);
  etapa6(u, i);
  const ubicaciones = construirUbicaciones(u);

  bitacora.ejecutado_en = new Date().toISOString();
  bitacora.resumen = {
    usuarios: { recibidos: rawU.length, aceptados: u.length },
    interacciones: { recibidas: rawI.length, aceptadas: i.length },
    rechazados_total: cuarentena.length,
    cuarentena_por_motivo: cuarentena.reduce((a, c) => ((a[c.motivo] = (a[c.motivo] || 0) + 1), a), {}),
    atipicos_marcados: u.filter((x) => x.atipico).length,
  };
  etapa7(u, ubicaciones, i, bitacora);

  // Autoverificación de privacidad antes de terminar
  const fuga = u.filter((x) => x.consentimiento_datos === false && (x.id_ubicacion || x.latitud !== null || x.longitud !== null)).length;
  const fugaInter = i.filter((r) => r.ubicacion && u.find((x) => x.id_usuario === r.id_usuario && x.consentimiento_datos === false)).length;
  console.log(`Verificación de privacidad: usuarios sin consentimiento con datos geográficos = ${fuga}; interacciones suyas con ubicación = ${fugaInter}`);
  console.log('Resumen:', JSON.stringify(bitacora.resumen));
  if (fuga || fugaInter) { console.error('ERROR: fuga de datos geográficos'); process.exit(1); }
}
main();

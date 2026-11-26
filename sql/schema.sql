-- Esquema relacional (TiDB Cloud Starter, modo MySQL) según el diccionario de datos de la Fase 1.
-- Si ya creaste las tablas en la Fase 1, NO lo ejecutes otra vez: compara y deja el esquema aprobado.

CREATE TABLE IF NOT EXISTS ubicacion (
  id_ubicacion INT AUTO_INCREMENT PRIMARY KEY,
  ciudad       VARCHAR(30) NOT NULL,
  estado       VARCHAR(30) NOT NULL,
  pais         VARCHAR(30) NOT NULL,
  zona_horaria VARCHAR(40) NOT NULL,
  UNIQUE KEY uq_ubicacion (ciudad, estado, pais)
);

CREATE TABLE IF NOT EXISTS usuarios (
  id_usuario           VARCHAR(7) PRIMARY KEY,
  alias                VARCHAR(20) NOT NULL UNIQUE,
  fecha_ingreso        DATE NOT NULL,
  id_ubicacion         INT NULL,
  latitud              DECIMAL(9,6) NULL,
  longitud             DECIMAL(9,6) NULL,
  rango_edad           VARCHAR(5) NOT NULL,
  especie_fursona      VARCHAR(20) NOT NULL,
  interes_principal    VARCHAR(30) NOT NULL,
  plataforma_principal VARCHAR(20) NOT NULL,
  es_artista           BOOLEAN NOT NULL,
  mensajes_30d         INT NOT NULL,
  reacciones_30d       INT NOT NULL,
  eventos_asistidos    INT NOT NULL,
  comisiones_compradas INT NOT NULL,
  sentimiento_promedio DECIMAL(4,3) NOT NULL,
  ultima_actividad     DATE NOT NULL,
  estatus              VARCHAR(10) NOT NULL,
  consentimiento_datos BOOLEAN NOT NULL,
  CONSTRAINT fk_usuarios_ubicacion FOREIGN KEY (id_ubicacion) REFERENCES ubicacion (id_ubicacion),
  CONSTRAINT chk_privacidad CHECK (
    consentimiento_datos = TRUE OR (id_ubicacion IS NULL AND latitud IS NULL AND longitud IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS administradores (
  id_admin      INT AUTO_INCREMENT PRIMARY KEY,
  usuario       VARCHAR(30) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  activo        BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Verificación posterior a la carga: debe devolver 0
SELECT COUNT(*) AS usuarios_sin_consentimiento_con_ubicacion
FROM usuarios
WHERE consentimiento_datos = FALSE
  AND (id_ubicacion IS NOT NULL OR latitud IS NOT NULL OR longitud IS NOT NULL);

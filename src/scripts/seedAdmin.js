require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, initTiDB } = require('../db/tidb');

async function seed() {
  const usuario = process.argv[2] || 'admin';
  const password = process.argv[3] || 'Admin1234*';

  console.log(`[Seed Admin] Inicializando administrador en TiDB Cloud...`);
  console.log(`[Seed Admin] Usuario: ${usuario}`);

  try {
    await initTiDB();

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);
    const ahora = new Date();

    const query = `
      INSERT INTO administradores (usuario, password_hash, activo, creado_en)
      VALUES (?, ?, 1, ?)
      ON DUPLICATE KEY UPDATE
        password_hash = VALUES(password_hash),
        activo = 1;
    `;

    await pool.query(query, [usuario, password_hash, ahora]);

    console.log(`\n======================================================`);
    console.log(`✅ Administrador configurado exitosamente en TiDB Cloud:`);
    console.log(`   Usuario: ${usuario}`);
    console.log(`   Hash (almacenado): ${password_hash.slice(0, 20)}...`);
    console.log(`======================================================\n`);
  } catch (error) {
    console.error('❌ Error al crear administrador en TiDB:', error);
  } finally {
    await pool.end();
  }
}

seed();

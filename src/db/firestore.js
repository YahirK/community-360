const fs = require('fs');
const path = require('path');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');

let dbInstance = null;

function parseServiceAccountFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;

  try {
    // Intenta parsear como JSON directo
    return JSON.parse(raw);
  } catch {
    // Si falla, intenta decodificar desde Base64
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(decoded);
  }
}

function getDb() {
  if (dbInstance) return dbInstance;

  if (getApps().length === 0) {
    let serviceAccount = parseServiceAccountFromEnv();

    if (!serviceAccount) {
      const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      if (!credPath) {
        throw new Error(
          'Falta configuración de Firebase: define FIREBASE_SERVICE_ACCOUNT o GOOGLE_APPLICATION_CREDENTIALS en .env'
        );
      }
      const resolvedPath = path.isAbsolute(credPath)
        ? credPath
        : path.resolve(process.cwd(), credPath);
      serviceAccount = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    }

    initializeApp({ credential: cert(serviceAccount) });
  }

  dbInstance = getFirestore();
  return dbInstance;
}

module.exports = {
  getDb,
  Timestamp,
  FieldValue,
};

# Community 360 — Observatorio Analítico en Tiempo Real

Plataforma web de inteligencia y analítica comunitaria con arquitectura híbrida en la nube (**TiDB Cloud** relacional + **Google Cloud Firestore** documental), API REST protegida con **JWT**, sincronización bidireccional mediante **WebSockets (`Socket.io`)** y panel analítico en **Chart.js 4**.

## Tecnologías principales
- **Backend:** Node.js (`>= 22`), Express 5, `mysql2/promise`, `firebase-admin` v14, `socket.io`
- **Seguridad:** `bcryptjs`, `jsonwebtoken` (JWT), `express-rate-limit`, CORS con lista blanca
- **Frontend:** HTML5, CSS3 responsivo (modo claro y oscuro), Vanilla JS, Chart.js 4

## Instalación y ejecución local
1. Instalar dependencias:
   ```bash
   npm install
   ```
2. Copiar `.env.example` a `.env` y configurar las credenciales de TiDB Cloud y Firebase.
3. Iniciar el servidor:
   ```bash
   npm start
   ```
4. Abrir en el navegador: `http://localhost:3000/login.html`

## Scripts disponibles
- `npm run etl` — Ejecuta el proceso ETL local (`src/etl.js`)
- `npm run load` — Carga los datos depurados e inicializa indicadores en TiDB Cloud y Firestore (`src/load.js`)
- `npm run seed:admin` — Crea o actualiza usuarios administradores con hash Bcrypt (`src/scripts/seedAdmin.js`)
- `npm start` — Inicia el servidor HTTP + WebSockets (`src/server.js`)

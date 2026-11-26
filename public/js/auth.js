// Utilidades y lógica de autenticación del Frontend (Fase 3)

const TOKEN_KEY = 'c360_auth_token';
const USER_KEY = 'c360_auth_user';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function getUser() {
  const user = localStorage.getItem(USER_KEY);
  try {
    return user ? JSON.parse(user) : null;
  } catch (e) {
    return null;
  }
}

function setSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

// Verifica si la sesión es válida con el backend
async function checkAuth() {
  const token = getToken();
  if (!token) return false;

  try {
    const res = await fetch('/api/auth/verify', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      clearSession();
      return false;
    }

    const data = await res.json();
    return data.success;
  } catch (err) {
    console.error('Error al verificar sesión:', err);
    return false;
  }
}

// Función global de cierre de sesión
async function logout() {
  const token = getToken();
  if (token) {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
    } catch (e) {
      console.warn('Error en llamada a logout:', e);
    }
  }
  clearSession();
  window.location.replace('/login.html');
}

// Proteger vista: redirige al login si no hay token válido y evita flash de contenido
async function requireAuth() {
  if (!getToken()) {
    window.location.replace('/login.html');
    return false;
  }

  const isAuth = await checkAuth();
  if (!isAuth) {
    window.location.replace('/login.html');
    return false;
  }

  const revealDashboard = () => {
    if (document.body) {
      document.body.classList.remove('auth-checking');
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', revealDashboard);
  } else {
    revealDashboard();
  }
  return true;
}

// Si está en la página de login y ya tiene sesión activa, redirige al dashboard
async function redirectIfAuth() {
  const isAuth = await checkAuth();
  if (isAuth) {
    window.location.replace('/dashboard.html');
  }
}

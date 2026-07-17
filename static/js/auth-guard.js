(() => {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  const publicApiPaths = new Set(['/api/health', '/api/auth/config']);
  let client = null;
  let session = null;
  let resolveReady;
  let rejectReady;

  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  window.SuperExcelAuth = {
    ready,
    get client() { return client; },
    get session() { return session; },
  };

  function isProtectedApi(url) {
    return url.origin === window.location.origin
      && url.pathname.startsWith('/api/')
      && !publicApiPaths.has(url.pathname);
  }

  function isGoogleSession(value) {
    const user = value?.user;
    const metadata = user?.app_metadata || {};
    const providers = new Set((metadata.providers || []).map(item => String(item).toLowerCase()));
    const identities = new Set((user?.identities || []).map(item => String(item.provider || '').toLowerCase()));
    return String(metadata.provider || '').toLowerCase() === 'google'
      || providers.has('google')
      || identities.has('google');
  }

  function loginUrl() {
    const next = `${window.location.pathname}${window.location.search}`;
    return `/login?next=${encodeURIComponent(next)}`;
  }

  function redirectToLogin() {
    window.location.replace(loginUrl());
  }

  function displayUser(value) {
    const user = value.user;
    const metadata = user.user_metadata || {};
    const name = metadata.full_name || metadata.name || user.email || 'Usuário';
    const avatar = metadata.avatar_url || metadata.picture || '';

    document.querySelectorAll('[data-auth-name]').forEach(element => {
      element.textContent = name;
    });
    document.querySelectorAll('[data-auth-email]').forEach(element => {
      element.textContent = user.email || '';
    });
    document.querySelectorAll('[data-auth-avatar]').forEach(element => {
      element.src = avatar;
      element.alt = name;
    });
  }

  async function authenticatedFetch(input, init = {}) {
    const requestUrl = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
      window.location.origin
    );

    if (!isProtectedApi(requestUrl)) return nativeFetch(input, init);

    await ready;
    if (!session?.access_token) {
      redirectToLogin();
      throw new Error('Sessão não disponível.');
    }

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers || {}).forEach((value, key) => headers.set(key, value));
    headers.set('Authorization', `Bearer ${session.access_token}`);

    const response = await nativeFetch(input, { ...init, headers });
    if (response.status === 401) {
      session = null;
      redirectToLogin();
    }
    return response;
  }

  window.fetch = authenticatedFetch;

  async function initialize() {
    const configResponse = await nativeFetch('/api/auth/config', { headers: { Accept: 'application/json' } });
    const config = await configResponse.json();
    if (!configResponse.ok) throw new Error(config.error || 'Não foi possível carregar a configuração de login.');

    if (!window.supabase?.createClient) {
      throw new Error(window.__SUPEREXCEL_SUPABASE_LOAD_ERROR__ || 'O cliente de autenticação não foi disponibilizado pelo servidor.');
    }

    client = window.supabase.createClient(config.supabase_url, config.publishable_key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });

    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    session = result.data.session;

    if (!session) {
      redirectToLogin();
      return;
    }

    if (!isGoogleSession(session)) {
      await client.auth.signOut({ scope: 'local' });
      redirectToLogin();
      return;
    }

    displayUser(session);
    document.body.classList.remove('auth-pending');
    resolveReady(session);

    document.querySelectorAll('[data-auth-signout]').forEach(button => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        await client.auth.signOut({ scope: 'local' });
        window.location.replace('/login');
      });
    });

    client.auth.onAuthStateChange((event, nextSession) => {
      session = nextSession;
      if (event === 'SIGNED_OUT' || !nextSession) {
        redirectToLogin();
        return;
      }
      if (isGoogleSession(nextSession)) displayUser(nextSession);
    });
  }

  initialize().catch(error => {
    console.error(error);
    document.body.classList.remove('auth-pending');
    rejectReady(error);
    const message = document.querySelector('[data-auth-error]');
    if (message) message.textContent = error.message;
    else window.alert(error.message);
  });
})();

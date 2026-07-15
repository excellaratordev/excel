(() => {
  'use strict';

  const statusElement = document.querySelector('#callback-status');
  const errorElement = document.querySelector('#callback-error');

  function isGoogleSession(session) {
    const user = session?.user;
    const metadata = user?.app_metadata || {};
    const providers = new Set((metadata.providers || []).map(item => String(item).toLowerCase()));
    const identities = new Set((user?.identities || []).map(item => String(item.provider || '').toLowerCase()));
    return String(metadata.provider || '').toLowerCase() === 'google'
      || providers.has('google')
      || identities.has('google');
  }

  function nextUrl() {
    const requested = sessionStorage.getItem('super-excel-auth-next') || '/files';
    sessionStorage.removeItem('super-excel-auth-next');
    return requested.startsWith('/') && !requested.startsWith('//') ? requested : '/files';
  }

  async function waitForSession(client) {
    const current = await client.auth.getSession();
    if (current.error) throw current.error;
    if (current.data.session) return current.data.session;

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        subscription.unsubscribe();
        reject(new Error('O Google não retornou uma sessão válida. Tente entrar novamente.'));
      }, 12000);

      const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
        if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session) {
          window.clearTimeout(timeout);
          subscription.unsubscribe();
          resolve(session);
        }
      });
    });
  }

  async function initialize() {
    const hashError = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('error_description');
    const queryError = new URLSearchParams(window.location.search).get('error_description');
    if (hashError || queryError) throw new Error(hashError || queryError);

    const response = await fetch('/api/auth/config', { headers: { Accept: 'application/json' } });
    const config = await response.json();
    if (!response.ok) throw new Error(config.error || 'Não foi possível carregar a configuração de login.');
    if (!window.supabase?.createClient) throw new Error('A biblioteca de autenticação não foi carregada.');

    const client = window.supabase.createClient(config.supabase_url, config.publishable_key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });

    const session = await waitForSession(client);
    if (!isGoogleSession(session)) {
      await client.auth.signOut({ scope: 'local' });
      throw new Error('Acesso permitido somente com uma conta Google.');
    }

    statusElement.textContent = 'Acesso confirmado. Abrindo seus arquivos...';
    window.location.replace(nextUrl());
  }

  initialize().catch(error => {
    console.error(error);
    statusElement.textContent = 'Não foi possível concluir o acesso.';
    errorElement.textContent = error.message;
    window.setTimeout(() => window.location.replace('/login'), 3500);
  });
})();

(() => {
  'use strict';

  const button = document.querySelector('#google-login');
  const errorElement = document.querySelector('#login-error');
  const titleElement = document.querySelector('#login-title');
  const descriptionElement = document.querySelector('#login-description');

  function safeNext() {
    const requested = new URLSearchParams(window.location.search).get('next') || '/files';
    return requested.startsWith('/') && !requested.startsWith('//') ? requested : '/files';
  }

  function isGoogleSession(session) {
    const user = session?.user;
    const metadata = user?.app_metadata || {};
    const providers = new Set((metadata.providers || []).map(item => String(item).toLowerCase()));
    const identities = new Set((user?.identities || []).map(item => String(item.provider || '').toLowerCase()));
    return String(metadata.provider || '').toLowerCase() === 'google'
      || providers.has('google')
      || identities.has('google');
  }

  function showError(message) {
    errorElement.textContent = message || '';
    button.disabled = false;
    button.querySelector('span:last-child').textContent = 'Entrar com Google';
  }

  async function initialize() {
    const next = safeNext();
    if (next.startsWith('/invite/')) {
      titleElement.textContent = 'Você recebeu um convite';
      descriptionElement.textContent = 'Entre com sua conta Google para participar do projeto compartilhado no Super Excel.';
    }

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

    const current = await client.auth.getSession();
    if (current.data.session && isGoogleSession(current.data.session)) {
      window.location.replace(next);
      return;
    }

    button.addEventListener('click', async () => {
      button.disabled = true;
      button.querySelector('span:last-child').textContent = 'Abrindo Google...';
      errorElement.textContent = '';
      sessionStorage.setItem('super-excel-auth-next', next);

      const result = await client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
          queryParams: { prompt: 'select_account' },
        },
      });

      if (result.error) showError(result.error.message);
    });
  }

  initialize().catch(error => {
    console.error(error);
    showError(error.message);
  });
})();

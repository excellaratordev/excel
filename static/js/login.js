(() => {
  'use strict';

  const button = document.querySelector('#google-login');
  const errorElement = document.querySelector('#login-error');
  const titleElement = document.querySelector('#login-title');
  const descriptionElement = document.querySelector('#login-description');
  const eyebrowElement = document.querySelector('.login-eyebrow');

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

  function greetingForHour(hour) {
    if (hour < 12) return 'Bom dia';
    if (hour < 18) return 'Boa tarde';
    return 'Boa noite';
  }

  function setButtonLoading(loading, label) {
    button.disabled = loading;
    button.setAttribute('aria-busy', String(loading));
    button.querySelector('span:last-child').textContent = label;
  }

  function showError(message) {
    errorElement.textContent = message || '';
    setButtonLoading(false, 'Entrar com Google');
  }

  function configurePageCopy(next) {
    if (next.startsWith('/invite/')) {
      eyebrowElement.textContent = 'Convite para colaborar';
      titleElement.textContent = 'Você recebeu um convite';
      descriptionElement.textContent = 'Entre com sua conta Google para participar do projeto compartilhado no Super Excel.';
      return;
    }

    const greeting = greetingForHour(new Date().getHours());
    eyebrowElement.textContent = `${greeting} · Bem-vindo de volta`;
  }

  async function initialize() {
    const next = safeNext();
    configurePageCopy(next);

    const response = await fetch('/api/auth/config', { headers: { Accept: 'application/json' } });
    const config = await response.json();
    if (!response.ok) throw new Error(config.error || 'Não foi possível carregar a configuração de login.');
    if (!window.supabase?.createClient) {
      throw new Error(window.__SUPEREXCEL_SUPABASE_LOAD_ERROR__ || 'O cliente de autenticação não foi disponibilizado pelo servidor.');
    }

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

    document.body.classList.add('login-ready');

    button.addEventListener('click', async () => {
      setButtonLoading(true, 'Abrindo Google...');
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
    document.body.classList.add('login-ready');
    showError(error.message);
  });
})();

(function () {
  const baseKey = 'levelup_api_base_url';
  const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  // Set LEVELUP_API_BASE_URL in the page before this file for a separately
  // deployed Worker (for example, https://level-up-api.<account>.workers.dev).
  const defaultBase = window.LEVELUP_API_BASE_URL || (isLocal ? 'http://localhost:8787' : '');
  const stripeKey = 'levelup_stripe_public_key';
  const defaultStripePublicKey = window.LEVELUP_STRIPE_PUBLIC_KEY || 'pk_test_replace_me';

  function getBaseUrl() {
    const stored = localStorage.getItem(baseKey);
    if (stored && stored.trim()) return stored.trim().replace(/\/$/, '');
    return defaultBase;
  }

  function setBaseUrl(url) {
    const normalized = (url || '').trim();
    if (!normalized) return;
    localStorage.setItem(baseKey, normalized.replace(/\/$/, ''));
  }

  function apiUrl(path) {
    const cleanPath = (path || '').startsWith('/') ? path : '/' + path;
    return getBaseUrl() + cleanPath;
  }

  function getStripePublicKey() {
    return localStorage.getItem(stripeKey) || defaultStripePublicKey;
  }

  window.LEVELUP_API = {
    getBaseUrl,
    setBaseUrl,
    apiUrl,
    getStripePublicKey
  };
})();

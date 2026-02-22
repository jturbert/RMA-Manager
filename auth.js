// ============================================================
// RMA Manager - Google Authentication (PKCE Authorization Code Flow)
// ============================================================
// Why PKCE? Google disabled the OAuth 2.0 implicit grant flow for
// all new OAuth client IDs created after October 2021. PKCE is the
// modern, secure replacement for browser-based apps.
//
// Security notes:
//   • PKCE — no client secret is ever used or stored
//   • State parameter prevents CSRF attacks
//   • Access tokens stored in sessionStorage ONLY (cleared on tab close)
//   • All API calls go directly to Google — no third-party servers
//
// Setup: In Google Cloud Console → your OAuth client → Authorized redirect URIs:
//   Add: http://localhost:8080/oauth-callback.html
// ============================================================

const Auth = (() => {
  const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email'
  ].join(' ');

  const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
  const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

  const SESSION_TOKEN_KEY  = 'rma_gtoken';
  const SESSION_EXPIRY_KEY = 'rma_gtoken_exp';
  const PKCE_VERIFIER_KEY  = 'rma_pkce_v';
  const PKCE_STATE_KEY     = 'rma_pkce_s';

  let accessToken  = null;
  let tokenExpiry  = 0;
  let userInfo     = null;
  let onSignInDone = null;

  // Pre-generated PKCE values — ready for synchronous use when user clicks Sign In
  let _verifier  = null;
  let _challenge = null;
  let _state     = null;

  // ---- PKCE helpers (Web Crypto API — available in all modern browsers) ----

  function generateVerifier() {
    const arr = new Uint8Array(64);
    crypto.getRandomValues(arr);
    return btoa(String.fromCharCode(...arr))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  async function generateChallenge(verifier) {
    const bytes  = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  // Pre-generate a fresh set of PKCE + state values for the next sign-in attempt
  async function preparePKCE() {
    _verifier  = generateVerifier();
    _challenge = await generateChallenge(_verifier);
    _state     = generateVerifier().substring(0, 32);
  }

  // Derive the OAuth callback URL from the current page location.
  // Works correctly whether the URL has a trailing slash or not, and whether
  // the current page is index.html or the bare directory URL.
  function getCallbackUrl() {
    const origin = window.location.origin;
    let path = window.location.pathname;
    if (!path.endsWith('/')) {
      const lastSegment = path.substring(path.lastIndexOf('/') + 1);
      if (lastSegment.includes('.')) {
        // Looks like a file (e.g. index.html) — strip it
        path = path.substring(0, path.lastIndexOf('/') + 1);
      } else {
        // Looks like a directory without trailing slash (e.g. /rma-manager) — add one
        path = path + '/';
      }
    }
    return origin + path + 'oauth-callback.html';
  }

  // ---- Public API ----

  function isConfigured() {
    return !!(CONFIG.googleClientId &&
              CONFIG.googleClientId !== 'YOUR_GOOGLE_CLIENT_ID_HERE');
  }

  async function init(onSignIn) {
    onSignInDone = onSignIn || null;
    if (!isConfigured()) return null;

    // Pre-generate PKCE values so signIn() can run fully synchronously
    await preparePKCE();

    // Register the permanent callback message listener
    window.addEventListener('message', _handleMessage);

    // Restore a still-valid token from sessionStorage (survives page refreshes)
    const stored = sessionStorage.getItem(SESSION_TOKEN_KEY);
    const expiry  = parseInt(sessionStorage.getItem(SESSION_EXPIRY_KEY) || '0');
    if (stored && Date.now() < expiry - 60000) {
      accessToken = stored;
      tokenExpiry = expiry;
      await _refreshUserInfo();
      return userInfo;
    }

    return null;
  }

  // MUST be called synchronously from a click event handler (browser popup policy).
  // PKCE values are pre-generated in init() so this function is fully synchronous.
  function signIn() {
    if (!isConfigured()) {
      throw new Error('Enter your Google Client ID in Settings first.');
    }
    if (!_verifier || !_challenge) {
      // Shouldn't happen normally — preparePKCE() runs in init()
      // Recover gracefully: ask user to try again in a moment
      preparePKCE(); // non-blocking, values ready for next click
      if (typeof App !== 'undefined') {
        App.onAuthError('Not ready yet — please try clicking Sign In again in 1 second.');
      }
      return;
    }

    // Consume the pre-generated values (one-time use per sign-in)
    const verifier  = _verifier;
    const challenge = _challenge;
    const state     = _state;
    _verifier = _challenge = _state = null;

    // Store for verification after the popup returns the code
    sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
    sessionStorage.setItem(PKCE_STATE_KEY,    state);

    // Build the Google authorization URL
    const callbackUrl = getCallbackUrl();
    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set('client_id',             CONFIG.googleClientId);
    url.searchParams.set('redirect_uri',          callbackUrl);
    url.searchParams.set('response_type',         'code');
    url.searchParams.set('scope',                 SCOPES);
    url.searchParams.set('state',                 state);
    url.searchParams.set('code_challenge',        challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('access_type',           'online');
    url.searchParams.set('prompt',                'select_account');

    // Open the Google sign-in popup — MUST be synchronous (no await before this)
    const popup = window.open(
      url.toString(),
      'rma_google_auth',
      'width=520,height=660,resizable=yes,scrollbars=yes,status=yes'
    );

    if (!popup || popup.closed) {
      sessionStorage.removeItem(PKCE_VERIFIER_KEY);
      sessionStorage.removeItem(PKCE_STATE_KEY);
      if (typeof App !== 'undefined') {
        App.onAuthError(
          'Popup was blocked. Allow popups for this site in your browser settings, then try again.'
        );
      }
      preparePKCE(); // ready for next attempt
      return;
    }

    // Prepare fresh PKCE values for the next sign-in attempt (runs in background)
    preparePKCE();
  }

  // Receives the authorization code posted by oauth-callback.html
  async function _handleMessage(event) {
    if (event.origin !== window.location.origin) return;
    if (!event.data || event.data.type !== 'rma_oauth_callback') return;

    const { code, error, state } = event.data;

    const savedState   = sessionStorage.getItem(PKCE_STATE_KEY);
    const codeVerifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
    sessionStorage.removeItem(PKCE_STATE_KEY);
    sessionStorage.removeItem(PKCE_VERIFIER_KEY);

    if (error) {
      if (typeof App !== 'undefined') App.onAuthError(error);
      return;
    }

    if (!savedState || state !== savedState) {
      if (typeof App !== 'undefined') {
        App.onAuthError('Security check failed (state mismatch). Please try signing in again.');
      }
      return;
    }

    if (!code || !codeVerifier) {
      if (typeof App !== 'undefined') {
        App.onAuthError('Sign-in incomplete: missing code or verifier. Please try again.');
      }
      return;
    }

    // Exchange the authorization code for an access token
    try {
      const body = new URLSearchParams({
        code,
        client_id:     CONFIG.googleClientId,
        client_secret: CONFIG.googleClientSecret || '',
        redirect_uri:  getCallbackUrl(),
        code_verifier: codeVerifier,
        grant_type:    'authorization_code'
      });

      const res  = await fetch(GOOGLE_TOKEN_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    body.toString()
      });
      const data = await res.json();

      if (data.error) {
        let msg = data.error_description || data.error;
        if (data.error === 'invalid_client' || data.error === 'unauthorized_client') {
          msg = 'Token exchange failed. Make sure the callback URL is listed under '
              + '"Authorized redirect URIs" in your Google Cloud Console OAuth client '
              + '(http://localhost:8080/oauth-callback.html). See SETUP.md for details.';
        }
        if (typeof App !== 'undefined') App.onAuthError(msg);
        return;
      }

      accessToken = data.access_token;
      tokenExpiry = Date.now() + ((data.expires_in || 3600) * 1000);
      sessionStorage.setItem(SESSION_TOKEN_KEY,  accessToken);
      sessionStorage.setItem(SESSION_EXPIRY_KEY, String(tokenExpiry));

      await _refreshUserInfo();
      if (onSignInDone) onSignInDone(userInfo);

    } catch (err) {
      if (typeof App !== 'undefined') {
        App.onAuthError('Network error during sign-in: ' + err.message);
      }
    }
  }

  async function _refreshUserInfo() {
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      userInfo = await res.json();
    } catch (_) {
      userInfo = { name: 'Signed In', email: '' };
    }
  }

  function signOut() {
    if (accessToken) {
      fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(accessToken), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }).catch(() => {});
    }
    accessToken = null;
    tokenExpiry = 0;
    userInfo    = null;
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    sessionStorage.removeItem(SESSION_EXPIRY_KEY);
    // Prepare PKCE for the next sign-in
    preparePKCE();
  }

  async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiry - 60000) return accessToken;
    // Token expired — user must sign in again
    accessToken = null;
    tokenExpiry = 0;
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    sessionStorage.removeItem(SESSION_EXPIRY_KEY);
    throw new Error('Session expired. Please sign in again.');
  }

  function isSignedIn() { return !!accessToken && Date.now() < tokenExpiry; }
  function getAccount()  { return userInfo; }

  return { init, signIn, signOut, getAccessToken, isSignedIn, getAccount, isConfigured };
})();

// =============================================================
// RMA Manager (Web / GitHub Pages version) — Configuration
// =============================================================
// Fill in your Google OAuth Client ID here, OR enter it in
// the app's Settings panel (preferred — no file editing needed).
//
// Your Client ID is NOT a secret. It identifies your app but
// cannot be used to access your data without your Google login.
//
// See SETUP-WEB.md for full instructions.
// =============================================================

const CONFIG = {
  // Your Google OAuth 2.0 Client ID
  // This is safe to commit — it identifies your app but cannot access your data.
  // You can also set it in the app's Settings panel instead of editing this file.
  googleClientId: '936371678924-57pfmcaob4k8je19nhccsded555b3jkl.apps.googleusercontent.com',

  // Your GitHub Pages URL (used as the app's origin in Google Cloud Console)
  // Format: https://jturbert.github.io
  // You do NOT need to put this here for auth to work — it's just a reminder.
  // The important step is adding your GitHub Pages origin in Google Cloud Console.
  appOrigin: 'https://jturbert.github.io'
};

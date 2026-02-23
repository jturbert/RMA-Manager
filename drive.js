// ============================================================
// RMA Manager (Web) — Google Drive Cloud Sync
//
// Stores RMA entries in the user's Google Drive App Data folder.
// This is a private, hidden folder that only this app can access —
// it does not appear anywhere in the user's regular Drive UI.
//
// Only RMA entry records are synced. PDFs remain in IndexedDB
// (local to each browser) and can be re-fetched from Gmail at
// any time using Fetch New Emails.
// ============================================================

const DriveStore = (() => {
  const FILE_NAME  = 'rma-manager-data.json';
  const FILES_API  = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

  let _fileId = null;  // cached for the session

  // ---- Helpers ----

  async function _authHeader() {
    const token = await Auth.getAccessToken();
    return { Authorization: `Bearer ${token}` };
  }

  // Find the existing data file in the app's private Drive folder.
  // Returns the file ID, or null if not yet created.
  async function _findFile() {
    if (_fileId) return _fileId;
    const h   = await _authHeader();
    const url = `${FILES_API}?spaces=appDataFolder&q=name%3D'${FILE_NAME}'&fields=files(id)`;
    const res = await fetch(url, { headers: h });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Drive list failed: ${res.status} ${err.error?.message || ''}`);
    }
    const { files } = await res.json();
    _fileId = (files && files.length) ? files[0].id : null;
    return _fileId;
  }

  // ---- Public API ----

  // Download and return the stored entries array from Drive.
  // Returns null if no file exists yet or on error.
  async function loadEntries() {
    const id = await _findFile();
    if (!id) return null;

    const h   = await _authHeader();
    const res = await fetch(`${FILES_API}/${id}?alt=media`, { headers: h });
    if (!res.ok) return null;

    const data = await res.json();
    return Array.isArray(data.entries) ? data.entries : null;
  }

  // Upload/overwrite the entries file on Drive.
  async function saveEntries(entries) {
    const h    = await _authHeader();
    const body = JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      entries
    });

    const id = await _findFile();

    if (id) {
      // Overwrite the existing file's content
      const res = await fetch(`${UPLOAD_API}/${id}?uploadType=media`, {
        method:  'PATCH',
        headers: { ...h, 'Content-Type': 'application/json' },
        body
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`Drive update failed: ${res.status} ${err.error?.message || ''}`);
      }
    } else {
      // Create the file for the first time in the app data folder.
      // Use multipart upload so we can set the filename and parent in one request.
      const form = new FormData();
      form.append('metadata', new Blob(
        [JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] })],
        { type: 'application/json' }
      ));
      form.append('file', new Blob([body], { type: 'application/json' }));

      const res = await fetch(`${UPLOAD_API}?uploadType=multipart`, {
        method:  'POST',
        headers: h,   // No Content-Type — browser sets it with multipart boundary
        body:    form
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`Drive create failed: ${res.status} ${err.error?.message || ''}`);
      }
      const data = await res.json();
      if (data.id) _fileId = data.id;
    }
  }

  return { loadEntries, saveEntries };
})();

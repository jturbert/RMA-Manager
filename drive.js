// ============================================================
// RMA Manager (Web) — Google Drive Cloud Sync
//
// Stores RMA entries AND PDF files in the user's Google Drive
// App Data folder. This is a private, hidden folder that only
// this app can access — it does not appear in the user's Drive UI.
//
// Entry records are stored in a single JSON file.
// Each PDF is stored as a separate binary file in the same folder.
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

  // Download and return { entries, pdfMeta } from Drive.
  // Returns null if no file exists yet or on error.
  async function loadEntries() {
    const id = await _findFile();
    if (!id) return null;

    const h   = await _authHeader();
    const res = await fetch(`${FILES_API}/${id}?alt=media`, { headers: h });
    if (!res.ok) return null;

    const data = await res.json();
    if (!Array.isArray(data.entries)) return null;

    return {
      entries: data.entries,
      pdfMeta: Array.isArray(data.pdfMeta) ? data.pdfMeta : []
    };
  }

  // Upload/overwrite the entries+pdfMeta file on Drive.
  async function saveEntries(entries, pdfMeta = []) {
    const h    = await _authHeader();
    const body = JSON.stringify({
      version: 2,
      savedAt: new Date().toISOString(),
      entries,
      pdfMeta
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

  // Upload a PDF file to Drive appDataFolder. Returns the Drive file ID.
  async function savePDF(filename, arrayBuffer) {
    const h    = await _authHeader();
    const form = new FormData();
    form.append('metadata', new Blob(
      [JSON.stringify({ name: filename, parents: ['appDataFolder'] })],
      { type: 'application/json' }
    ));
    form.append('file', new Blob([arrayBuffer], { type: 'application/pdf' }));

    const res = await fetch(`${UPLOAD_API}?uploadType=multipart`, {
      method:  'POST',
      headers: h,
      body:    form
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Drive PDF upload failed: ${res.status} ${err.error?.message || ''}`);
    }
    const data = await res.json();
    return data.id;
  }

  // Download a PDF from Drive by its file ID. Returns an ArrayBuffer.
  async function loadPDF(driveFileId) {
    const h   = await _authHeader();
    const res = await fetch(`${FILES_API}/${driveFileId}?alt=media`, { headers: h });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Drive PDF load failed: ${res.status} ${err.error?.message || ''}`);
    }
    return res.arrayBuffer();
  }

  // Delete a PDF from Drive. Non-fatal — logs a warning on failure.
  async function deletePDF(driveFileId) {
    const h   = await _authHeader();
    const res = await fetch(`${FILES_API}/${driveFileId}`, { method: 'DELETE', headers: h });
    if (!res.ok && res.status !== 404) {
      console.warn('[Drive] PDF delete returned:', res.status);
    }
  }

  return { loadEntries, saveEntries, savePDF, loadPDF, deletePDF };
})();

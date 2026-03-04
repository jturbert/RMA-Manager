// ============================================================
// RMA Manager (Web version) - Storage Layer
//   • IndexedDB only — no local file system access needed
//   • PDFs stored in IndexedDB, downloaded on demand
//   • Works in any browser including Safari on iPad
// ============================================================

const Storage = (() => {
  const DB_NAME    = 'RMAManagerDB';
  const DB_VERSION = 2;
  let db = null;

  async function openDB() {
    if (db) return db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('entries')) {
          const s = d.createObjectStore('entries', { keyPath:'id', autoIncrement:true });
          s.createIndex('rmaNumber','rmaNumber',{unique:false});
          s.createIndex('status',   'status',   {unique:false});
          s.createIndex('dealer',   'dealer',   {unique:false});
          s.createIndex('date',     'date',     {unique:false});
          s.createIndex('emailId',  'emailId',  {unique:true });
        }
        if (!d.objectStoreNames.contains('settings')) {
          d.createObjectStore('settings', { keyPath:'key' });
        }
        if (!d.objectStoreNames.contains('pdfs')) {
          const p = d.createObjectStore('pdfs', { keyPath:'id', autoIncrement:true });
          p.createIndex('entryId','entryId',{unique:false});
        }
      };
      req.onsuccess = (e) => { db = e.target.result; resolve(db); };
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  async function idbGet(store, key) {
    const d = await openDB();
    return new Promise((res,rej) => { const r = d.transaction(store,'readonly').objectStore(store).get(key); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
  }
  async function idbPut(store, val) {
    const d = await openDB();
    return new Promise((res,rej) => { const r = d.transaction(store,'readwrite').objectStore(store).put(val); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
  }
  async function idbDelete(store, key) {
    const d = await openDB();
    return new Promise((res,rej) => { const r = d.transaction(store,'readwrite').objectStore(store).delete(key); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); });
  }
  async function idbGetAll(store) {
    const d = await openDB();
    return new Promise((res,rej) => { const r = d.transaction(store,'readonly').objectStore(store).getAll(); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
  }
  async function idbGetByIndex(store, idx, val) {
    const d = await openDB();
    return new Promise((res,rej) => { const r = d.transaction(store,'readonly').objectStore(store).index(idx).get(val); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
  }
  async function idbGetAllByIndex(store, idx, val) {
    const d = await openDB();
    return new Promise((res,rej) => { const r = d.transaction(store,'readonly').objectStore(store).index(idx).getAll(val); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
  }

  // ---- RMA Entries ----
  const saveEntry  = e  => idbPut('entries', e);
  const getEntry   = id => idbGet('entries', id);

  // Active entries only (deleted:true entries are excluded from the main dashboard)
  const getAllEntries = async () => {
    const all = await idbGetAll('entries');
    return all.filter(e => !e.deleted);
  };

  // Deleted/archived entries (shown in Settings > Deleted Entries)
  const getDeletedEntries = async () => {
    const all = await idbGetAll('entries');
    return all.filter(e => !!e.deleted);
  };

  const entryExistsByEmailId = async eid => !!(await idbGetByIndex('entries','emailId',eid));
  const entryByEmailId       = eid => idbGetByIndex('entries','emailId',eid);

  // Look up by RMA number (used to prevent duplicates when re-fetching emails)
  const entryByRmaNumber = rma => idbGetByIndex('entries','rmaNumber', String(rma));

  // Hard-delete: permanently removes the entry and its linked PDFs from IndexedDB.
  // Only called by clearAllData() and truly permanent removal flows.
  async function deleteEntry(id) {
    const pdfs = await getPDFsForEntry(id);
    for (const p of pdfs) await idbDelete('pdfs', p.id);
    return idbDelete('entries', id);
  }

  // ---- Settings ----
  const getSetting = async key => { const r = await idbGet('settings',key); return r ? r.value : null; };
  const setSetting = (key, val) => idbPut('settings', { key, value: val });

  // ---- PDF Storage ----
  async function savePDF(entryId, filename, arrayBuffer, pdfType, driveFileId = null) {
    const rec = { entryId, filename, type: pdfType, data: arrayBuffer, savedAt: new Date().toISOString() };
    if (driveFileId) rec.driveFileId = driveFileId;
    return idbPut('pdfs', rec);
  }

  // Update the driveFileId on an existing PDF record after it has been uploaded to Drive.
  async function updatePDFDriveId(pdfId, driveFileId) {
    const d = await openDB();
    return new Promise((res, rej) => {
      const tx  = d.transaction('pdfs', 'readwrite');
      const st  = tx.objectStore('pdfs');
      const req = st.get(pdfId);
      req.onsuccess = () => {
        const rec = req.result;
        if (!rec) { res(); return; }
        rec.driveFileId = driveFileId;
        st.put(rec).onsuccess = () => res();
      };
      req.onerror = () => rej(req.error);
    });
  }

  const getAllPDFs      = ()       => idbGetAll('pdfs');
  const getPDFsForEntry = entryId => idbGetAllByIndex('pdfs','entryId',entryId);

  async function downloadPDF(pdfRecord) {
    const blob = new Blob([pdfRecord.data], { type:'application/pdf' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = pdfRecord.filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Build a safe filename: {rmaNumber}-{dealer}-{model}-{YYYY-MM-DD}[-INV].pdf
  function buildFilename(rmaNumber, dealer, model, dateStr, isInvoice) {
    const safe = s => (s||'unknown').replace(/[/\\?%*:|"<>]/g,'-').replace(/\s+/g,'-').replace(/-{2,}/g,'-').trim().substring(0,40);
    let date = 'unknown-date';
    try { date = new Date(dateStr).toISOString().split('T')[0]; } catch(_) {}
    return `${safe(rmaNumber)}-${safe(dealer)}-${safe(model)}${isInvoice?'-INV':''}-${date}.pdf`;
  }

  // ---- Clear all data ----
  async function clearAllData() {
    const d = await openDB();
    return new Promise((res,rej) => {
      const tx = d.transaction(['entries','settings','pdfs'],'readwrite');
      tx.objectStore('entries').clear();
      tx.objectStore('settings').clear();
      tx.objectStore('pdfs').clear();
      tx.oncomplete=res; tx.onerror=()=>rej(tx.error);
    });
  }

  // ---- Backup & Restore ----

  // Convert ArrayBuffer → base64 string (chunked to avoid call-stack limits on large PDFs)
  function _ab2b64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary  = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  // Convert base64 string → ArrayBuffer
  function _b642ab(base64) {
    const binary = atob(base64);
    const buf    = new ArrayBuffer(binary.length);
    const bytes  = new Uint8Array(buf);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return buf;
  }

  async function exportBackup() {
    const entries  = await idbGetAll('entries');
    const settings = await idbGetAll('settings');
    const rawPdfs  = await idbGetAll('pdfs');

    // Encode PDF ArrayBuffers as base64 so the whole backup is plain JSON
    const pdfs = rawPdfs.map(p => ({ ...p, data: _ab2b64(p.data) }));

    const backup = {
      version:    1,
      exportedAt: new Date().toISOString(),
      entries,
      settings,
      pdfs
    };

    const blob     = new Blob([JSON.stringify(backup)], { type: 'application/json' });
    const url      = URL.createObjectURL(blob);
    const date     = new Date().toISOString().split('T')[0];
    const filename = `RMA-Backup-${date}.json`;

    // Return the URL for the caller to present — avoids async-click issues on Safari/iOS
    return { url, filename, entryCount: entries.length, pdfCount: pdfs.length };
  }

  async function importBackup(jsonText) {
    let backup;
    try { backup = JSON.parse(jsonText); }
    catch (_) { throw new Error('Invalid backup file — could not parse JSON.'); }

    if (!backup.version || !Array.isArray(backup.entries)) {
      throw new Error('Invalid backup file — missing required fields.');
    }

    // Wipe existing data, then restore with original IDs preserved
    // (IDs are kept so that PDF → entry links remain valid)
    await clearAllData();

    const d = await openDB();

    // Restore entries (original IDs preserved via put())
    await new Promise((res, rej) => {
      const tx = d.transaction('entries', 'readwrite');
      const st = tx.objectStore('entries');
      for (const entry of backup.entries) st.put(entry);
      tx.oncomplete = res;
      tx.onerror    = () => rej(tx.error);
    });

    // Restore settings
    if (Array.isArray(backup.settings) && backup.settings.length) {
      await new Promise((res, rej) => {
        const tx = d.transaction('settings', 'readwrite');
        const st = tx.objectStore('settings');
        for (const s of backup.settings) st.put(s);
        tx.oncomplete = res;
        tx.onerror    = () => rej(tx.error);
      });
    }

    // Restore PDFs (decode base64 → ArrayBuffer)
    if (Array.isArray(backup.pdfs) && backup.pdfs.length) {
      await new Promise((res, rej) => {
        const tx = d.transaction('pdfs', 'readwrite');
        const st = tx.objectStore('pdfs');
        for (const pdf of backup.pdfs) {
          st.put({ ...pdf, data: _b642ab(pdf.data) });
        }
        tx.oncomplete = res;
        tx.onerror    = () => rej(tx.error);
      });
    }

    return {
      entryCount: backup.entries.length,
      pdfCount:   (backup.pdfs || []).length,
      exportedAt: backup.exportedAt || null
    };
  }

  return {
    saveEntry, getEntry, deleteEntry, getAllEntries, getDeletedEntries,
    entryExistsByEmailId, entryByEmailId, entryByRmaNumber,
    getSetting, setSetting,
    savePDF, updatePDFDriveId, getAllPDFs, getPDFsForEntry, downloadPDF, buildFilename,
    clearAllData, exportBackup, importBackup
  };
})();

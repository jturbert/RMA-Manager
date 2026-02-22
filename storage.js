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
  const saveEntry            = e   => idbPut('entries', e);
  const getEntry             = id  => idbGet('entries', id);
  const getAllEntries         = ()  => idbGetAll('entries');
  const entryExistsByEmailId = async eid => !!(await idbGetByIndex('entries','emailId',eid));
  const entryByEmailId       = eid => idbGetByIndex('entries','emailId',eid);

  async function deleteEntry(id) {
    const pdfs = await getPDFsForEntry(id);
    for (const p of pdfs) await idbDelete('pdfs', p.id);
    return idbDelete('entries', id);
  }

  // ---- Settings ----
  const getSetting = async key => { const r = await idbGet('settings',key); return r ? r.value : null; };
  const setSetting = (key, val) => idbPut('settings', { key, value: val });

  // ---- PDF Storage ----
  async function savePDF(entryId, filename, arrayBuffer, pdfType) {
    return idbPut('pdfs', { entryId, filename, type:pdfType, data:arrayBuffer, savedAt:new Date().toISOString() });
  }
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

  return {
    saveEntry, getEntry, deleteEntry, getAllEntries, entryExistsByEmailId, entryByEmailId,
    getSetting, setSetting,
    savePDF, getPDFsForEntry, downloadPDF, buildFilename,
    clearAllData
  };
})();

// ============================================================
// RMA Manager (Web version) - Main Application Controller
// Key differences from desktop version:
//   • No local folder access — PDFs stored in IndexedDB
//   • PDFs downloaded individually via Download buttons
//   • Excel always triggers a browser download
//   • Works on iPad, iPhone, and any modern browser
// ============================================================

const App = (() => {
  let allEntries    = [];
  let currentFilter = 'all';
  let currentSearch = '';
  let sortField     = 'date';
  let sortAsc       = false;
  let editingId     = null;
  let editingPDFs   = [];   // PDF records for the currently-open modal entry
  let drivePdfMeta  = [];   // PDF metadata array from Drive (populated on syncFromDrive)

  // ============================================================
  // INIT
  // ============================================================
  async function init() {
    // Restore saved settings into form fields
    const savedClientId  = await Storage.getSetting('googleClientId');
    const savedExcelName = await Storage.getSetting('excelFilename');

    if (savedClientId) { CONFIG.googleClientId = savedClientId; }
    document.getElementById('s-client-id').value  = savedClientId  || CONFIG.googleClientId || '';
    document.getElementById('s-excel-name').value = savedExcelName || Excel.DEFAULT_FILENAME;

    if (!Auth.isConfigured()) {
      document.getElementById('setup-banner').style.display = 'flex';
    }

    // Init Google auth — callback fires after sign-in popup completes
    const account = await Auth.init(onAuthComplete);
    updateAuthUI(account);

    await refreshTable();

    // If a session was restored from cache (no sign-in popup needed), sync now.
    // When the user signs in fresh, onAuthComplete handles this instead.
    if (account) await syncFromDrive();
  }

  // ============================================================
  // AUTH (Google popup-based — no page redirect)
  // ============================================================
  // Called directly from button click (synchronous start required for popup)
  function handleAuthClick() {
    if (Auth.isSignedIn()) {
      Auth.signOut();
      updateAuthUI(null);
      document.getElementById('fetch-btn').disabled = true;
    } else {
      if (!Auth.isConfigured()) {
        showToast('Enter your Google Client ID in Settings first.', 'error');
        showSection('settings');
        return;
      }
      Auth.signIn(); // triggers Google popup — must be synchronous from click
    }
  }

  // Callback fired by auth.js after the Google popup completes successfully
  async function onAuthComplete(userInfo) {
    updateAuthUI(userInfo);
    document.getElementById('fetch-btn').disabled = false;
    showToast('Signed in as ' + (userInfo?.email || userInfo?.name || 'Google user'), 'success');
    await syncFromDrive();
  }

  // Called by auth.js if sign-in fails
  function onAuthError(msg) {
    showToast('Sign-in failed: ' + msg, 'error');
  }

  function updateAuthUI(account) {
    const btn    = document.getElementById('auth-btn');
    const nameEl = document.getElementById('user-name');
    if (account) {
      btn.textContent    = 'Sign Out';
      nameEl.textContent = account.email || account.name || 'Signed In';
      document.getElementById('fetch-btn').disabled = false;
    } else {
      btn.textContent    = 'Sign In with Google';
      nameEl.textContent = '';
      document.getElementById('fetch-btn').disabled = true;
    }
  }

  // ============================================================
  // SETTINGS
  // ============================================================
  async function saveSettings() {
    const clientId = document.getElementById('s-client-id').value.trim();
    if (!clientId) { showToast('Please enter a Client ID.', 'error'); return; }
    await Storage.setSetting('googleClientId', clientId);
    showToast('Saved. Reloading...', 'success');
    setTimeout(() => location.reload(), 1200);
  }

  async function saveExcelName() {
    let name = document.getElementById('s-excel-name').value.trim();
    if (!name) { showToast('Please enter a filename.', 'error'); return; }
    if (!name.toLowerCase().endsWith('.xlsx')) name += '.xlsx';
    document.getElementById('s-excel-name').value = name;
    await Storage.setSetting('excelFilename', name);
    showToast('Excel filename set to: ' + name, 'success');
  }

  async function saveCopyAs() {
    let name = document.getElementById('s-copy-name').value.trim();
    if (!name) { showToast('Please enter a name for the copy.', 'error'); return; }
    if (!name.toLowerCase().endsWith('.xlsx')) name += '.xlsx';
    const entries = await Storage.getAllEntries();
    if (!entries.length) { showToast('No data to export.', 'error'); return; }
    try {
      await Excel.downloadCopyAs(entries, name);
      showToast('Downloading copy: ' + name, 'success');
      document.getElementById('s-copy-name').value = '';
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  }

  async function confirmClearData() {
    if (!confirm(
      'Delete ALL local RMA entries, stored PDFs and settings in this browser?\n\n' +
      'Cloud-synced entries will be restored next time you sign in.\n\n' +
      'This cannot be undone.'
    )) return;
    await Storage.clearAllData();
    allEntries = [];
    renderTable([]);
    updateStats([]);
    showSyncStatus('off');
    showToast('All local data cleared.', 'success');
  }

  // ============================================================
  // CLOUD SYNC (Google Drive App Data)
  // ============================================================

  // Update the cloud-sync indicator icon in the header.
  // state: 'syncing' | 'synced' | 'error' | 'off'
  function showSyncStatus(state, tooltip) {
    const el = document.getElementById('sync-indicator');
    if (!el) return;
    el.style.display = state === 'off' ? 'none' : 'inline-flex';
    el.title = tooltip ||
      (state === 'syncing' ? 'Syncing with Google Drive…'  :
       state === 'synced'  ? 'Synced with Google Drive'    :
       state === 'error'   ? 'Cloud sync failed — data saved locally' : '');
    el.className = 'sync-indicator sync-' + state;
  }

  // ---- Drive PDF Helpers ----

  // Build the pdfMeta array to store in Drive alongside entry records.
  // Merges locally-uploaded PDFs (that have a driveFileId) with any
  // Drive-only entries from the last sync, so no device accidentally
  // removes another device's PDF references when it pushes.
  async function buildPdfMeta() {
    const allPDFs    = await Storage.getAllPDFs();
    const allEntries = await Storage.getAllEntries();
    const entryById  = new Map(allEntries.map(e => [e.id, e]));

    const localMeta = allPDFs
      .filter(p => p.driveFileId)
      .map(p => {
        const entry = entryById.get(p.entryId);
        return {
          driveFileId:  p.driveFileId,
          filename:     p.filename,
          entryEmailId: entry?.emailId || null,
          type:         p.type,
          savedAt:      p.savedAt
        };
      })
      .filter(m => m.entryEmailId);

    // Preserve Drive-only entries from other devices that aren't local yet
    const localDriveIds = new Set(localMeta.map(m => m.driveFileId));
    const driveOnly = drivePdfMeta.filter(m => !localDriveIds.has(m.driveFileId));

    return [...localMeta, ...driveOnly];
  }

  // Upload all local PDFs that don't yet have a Drive file ID.
  // Called after fetchEmails and after a manual invoice PDF is added.
  async function uploadPendingPDFs() {
    if (!Auth.isSignedIn()) return;
    const allPDFs = await Storage.getAllPDFs();
    const pending = allPDFs.filter(p => !p.driveFileId);
    for (const pdf of pending) {
      try {
        const driveFileId = await DriveStore.savePDF(pdf.filename, pdf.data);
        await Storage.updatePDFDriveId(pdf.id, driveFileId);
      } catch (err) {
        console.warn('[Drive] PDF upload failed:', pdf.filename, err.message);
      }
    }
  }

  // Download any Drive PDFs for this entry that aren't yet stored locally.
  // Called lazily when the edit modal is opened.
  async function syncMissingPDFsForEntry(entryId, localPDFs) {
    if (!Auth.isSignedIn() || !drivePdfMeta.length) return;
    const entry = await Storage.getEntry(entryId);
    if (!entry?.emailId) return;

    const localDriveIds  = new Set(localPDFs.filter(p => p.driveFileId).map(p => p.driveFileId));
    const localFilenames = new Set(localPDFs.map(p => p.filename));

    const toDownload = drivePdfMeta.filter(m =>
      m.entryEmailId === entry.emailId &&
      !localDriveIds.has(m.driveFileId) &&
      !localFilenames.has(m.filename)
    );

    for (const meta of toDownload) {
      try {
        const buffer = await DriveStore.loadPDF(meta.driveFileId);
        await Storage.savePDF(entryId, meta.filename, buffer, meta.type, meta.driveFileId);
      } catch (err) {
        console.warn('[Drive] Could not download PDF from Drive:', meta.filename, err.message);
      }
    }
  }

  // Load entries from Drive and merge into local IndexedDB.
  // Drive is authoritative: local entries are updated from Drive,
  // and local entries deleted on another device are removed here.
  // PDFs are untouched (they live only in IndexedDB).
  async function syncFromDrive() {
    if (!Auth.isSignedIn()) return;
    showSyncStatus('syncing');
    try {
      const driveData = await DriveStore.loadEntries();

      if (!driveData) {
        // No Drive file yet — push local data to create it
        await pushToDrive(false);
        return;
      }

      const { entries: driveEntries, pdfMeta } = driveData;
      drivePdfMeta = pdfMeta;   // cache for lazy PDF downloads when modal is opened

      const localEntries  = await Storage.getAllEntries();
      const localByEmail  = new Map(localEntries.map(e => [e.emailId, e]));
      const driveByEmail  = new Map(driveEntries.map(e => [e.emailId, e]));

      // Update / add entries from Drive
      for (const driveEntry of driveEntries) {
        const local = localByEmail.get(driveEntry.emailId);
        if (local) {
          // Overwrite local fields with Drive values but keep the local id
          // so existing PDF links (by entryId) remain intact
          await Storage.saveEntry({ ...driveEntry, id: local.id });
        } else {
          // Entry exists on Drive but not locally — add it
          // Strip the id so IndexedDB assigns a fresh local one
          const { id: _ignored, ...rest } = driveEntry;
          await Storage.saveEntry(rest);
        }
      }

      // Remove local entries that were deleted on another device
      for (const local of localEntries) {
        if (local.emailId && !driveByEmail.has(local.emailId)) {
          await Storage.deleteEntry(local.id);
        }
      }

      await refreshTable();
      showSyncStatus('synced');
    } catch (err) {
      console.warn('[Drive] Sync from Drive failed:', err.message);
      const needsReauth = err.message.includes('401') || err.message.includes('403');
      const msg = needsReauth
        ? 'Drive sync: sign out and back in to grant Drive access.'
        : 'Drive sync failed — working from local data. (' + err.message + ')';
      showSyncStatus('error', msg);
      showToast(msg, 'error');
    }
  }

  // Push all local entries to Drive (called after any change).
  async function pushToDrive(showIndicator = true) {
    if (!Auth.isSignedIn()) return;
    if (showIndicator) showSyncStatus('syncing');
    try {
      const entries = await Storage.getAllEntries();
      const pdfMeta = await buildPdfMeta();
      await DriveStore.saveEntries(entries, pdfMeta);
      showSyncStatus('synced');
    } catch (err) {
      console.warn('[Drive] Push to Drive failed:', err.message);
      const needsReauth = err.message.includes('401') || err.message.includes('403');
      const msg = needsReauth
        ? 'Drive sync: sign out and back in to grant Drive access.'
        : 'Drive sync failed — change saved locally only.';
      showSyncStatus('error', msg);
      // Only toast on reauth issues (avoid toasting on every save if Drive is unreachable)
      if (needsReauth) showToast(msg, 'error');
    }
  }

  // ============================================================
  // EMAIL FETCH
  // ============================================================
  async function fetchEmails() {
    if (!Auth.isSignedIn()) { showToast('Please sign in first.', 'error'); return; }

    setProgress(0, 'Connecting to Gmail...');
    document.getElementById('fetch-btn').disabled = true;

    try {
      setProgress(5, 'Scanning inbox for RMA emails...');
      const emails = await Email.fetchRMAEmails(msg => setProgress(10, msg));

      if (!emails.length) {
        showToast('No RMA emails found matching the subject pattern.');
        hideProgress(); return;
      }

      const newEmails          = [];
      const missingFieldEmails = []; // Entry exists but lacks model/serial/warranty — re-parse stored PDFs
      const brandFixEntries    = []; // Entry exists with blank brand — quick fix from subject
      const dateFixEntries     = []; // Stored date doesn't match email's actual sent date

      for (const e of emails) {
        const existing = await Storage.entryByEmailId(e.messageId);
        if (!existing) {
          newEmails.push(e);
        } else if (!existing.model || !existing.serialNumber) {
          // Entry is missing key parsed fields — re-parse any stored PDFs
          // (warrantyStatus intentionally excluded: Dune Blue uses visual-only radio buttons
          //  that PDF.js cannot read; warranty must be set manually in the Actions dialog)
          missingFieldEmails.push({ email: e, existing });
        } else if (!existing.make && e.parsed?.brandGuess) {
          // Entry has fields but brand is blank — quick fix from subject line
          brandFixEntries.push({ email: e, existing });
        } else if (e.receivedDateTime && existing.date !== e.receivedDateTime) {
          // Entry is complete but has the wrong date (e.g. was stored as the forwarding date)
          dateFixEntries.push({ email: e, existing });
        }
      }

      if (!newEmails.length && !missingFieldEmails.length && !brandFixEntries.length && !dateFixEntries.length) {
        showToast(`All ${emails.length} RMA email(s) are already imported.`);
        hideProgress(); return;
      }

      let imported    = 0;
      let reprocessed = 0;
      let brandFixed  = 0;
      let dateFixed   = 0;
      const total     = newEmails.length + missingFieldEmails.length;

      // Import brand-new emails
      for (let i = 0; i < newEmails.length; i++) {
        const pct = Math.round(20 + (i / Math.max(total, 1)) * 70);
        setProgress(pct, `Processing RMA #${newEmails[i].parsed.rmaNumber} (${i+1}/${total})...`);
        await processEmail(newEmails[i]);
        imported++;
      }

      // Re-parse stored PDFs for entries missing model/serial/warranty
      for (let i = 0; i < missingFieldEmails.length; i++) {
        const { email: e, existing } = missingFieldEmails[i];
        const pct = Math.round(20 + ((newEmails.length + i) / Math.max(total, 1)) * 70);
        setProgress(pct, `Re-parsing PDFs for RMA #${existing.rmaNumber} (${newEmails.length + i + 1}/${total})...`);
        const updated = await reprocessStoredPDFs(e, existing);
        if (updated.model || updated.serialNumber || updated.warrantyStatus) reprocessed++;
      }

      // Quick-fix brand for entries that have blank make field
      if (brandFixEntries.length) {
        setProgress(92, `Updating brand for ${brandFixEntries.length} existing RMA(s)...`);
        for (const { email: e, existing } of brandFixEntries) {
          existing.make = e.parsed.brandGuess;
          if (e.receivedDateTime) existing.date = e.receivedDateTime;
          await Storage.saveEntry(existing);
          brandFixed++;
        }
      }

      // Fix dates for entries that have everything else correct
      if (dateFixEntries.length) {
        setProgress(95, `Correcting dates for ${dateFixEntries.length} RMA(s)...`);
        for (const { email: e, existing } of dateFixEntries) {
          console.log(`[App] Date fix for RMA #${existing.rmaNumber}: "${existing.date}" → "${e.receivedDateTime}"`);
          existing.date = e.receivedDateTime;
          await Storage.saveEntry(existing);
          dateFixed++;
        }
      }

      setProgress(100, 'Done!');
      const parts = [];
      if (imported)    parts.push(`Imported ${imported} new RMA(s)`);
      if (reprocessed) parts.push(`${reprocessed} PDF(s) re-parsed`);
      if (brandFixed)  parts.push(`${brandFixed} brand(s) auto-detected`);
      if (dateFixed)   parts.push(`${dateFixed} date(s) corrected`);
      showToast((parts.join(', ') || 'No changes') + '.', 'success');
      await refreshTable();
      await uploadPendingPDFs();
      await pushToDrive();

    } catch (err) {
      console.error('[App] Fetch error:', err);
      showToast('Error: ' + err.message, 'error');
    } finally {
      document.getElementById('fetch-btn').disabled = false;
      setTimeout(hideProgress, 2500);
    }
  }

  // Re-parse PDFs already stored in IndexedDB for an entry missing model/serial
  async function reprocessStoredPDFs(emailInfo, existingEntry) {
    const entry = { ...existingEntry };
    const storedPDFs = await Storage.getPDFsForEntry(entry.id);

    let invoiceDate = null;  // set when an invoice PDF contains a parseable purchase date

    for (const pdf of storedPDFs) {
      try {
        const result = await PDFParser.processPDF(pdf.data, pdf.filename);
        if (!result.isInvoice) {
          const f = result.fields || {};
          if (!entry.make             && f.make)             entry.make             = f.make;
          if (!entry.model            && f.model)            entry.model            = f.model;
          if (!entry.serialNumber     && f.serialNumber)     entry.serialNumber     = f.serialNumber;
          if (!entry.issueDescription && f.issueDescription) entry.issueDescription = f.issueDescription;
          if (!entry.warrantyStatus   && f.warrantyStatus)   entry.warrantyStatus   = f.warrantyStatus;
          if (!entry.notes            && f.notes)            entry.notes            = f.notes;
        } else {
          if (result.invoiceDate) invoiceDate = result.invoiceDate;
        }
      } catch (err) {
        console.warn('[App] Re-parse stored PDF error:', err.message);
      }
    }

    // Infer warranty from invoice date when the RMA form didn't provide one.
    if (!entry.warrantyStatus && invoiceDate) {
      const rmaDate = new Date(entry.date);
      if (!isNaN(rmaDate.getTime())) {
        const diffDays = (rmaDate - invoiceDate) / 86400000;
        if (diffDays >= 0 && diffDays <= 730) {
          entry.warrantyStatus = 'Yes';
          console.log(`[App] Warranty inferred from invoice: Yes (${Math.round(diffDays)} days since purchase)`);
        } else if (diffDays > 730) {
          entry.warrantyStatus = 'No';
          console.log(`[App] Warranty inferred from invoice: No (${Math.round(diffDays)} days since purchase)`);
        }
      }
    }

    // Final fallback: if brand still blank, use subject-line guess
    if (!entry.make && emailInfo.parsed?.brandGuess) {
      entry.make = emailInfo.parsed.brandGuess;
    }

    // Always correct the date to the email's actual sent date
    if (emailInfo.receivedDateTime) entry.date = emailInfo.receivedDateTime;

    await Storage.saveEntry(entry);
    return entry;
  }

  async function processEmail(emailInfo) {
    const { messageId, parsed, receivedDateTime, attachments } = emailInfo;
    const dateStr = receivedDateTime || '';

    const entry = {
      emailId: messageId, status: 'Open',
      rmaNumber: parsed.rmaNumber, date: dateStr,
      dealer: parsed.dealer,
      make: '', model: '', serialNumber: '',
      issueDescription: '', issueConfirmed: '',
      warrantyStatus: '', courseOfAction: '',
      dateOfResolution: '', howResolved: '', notes: '',
      importedAt: new Date().toISOString()
    };

    // First pass: download all PDFs and extract fields from form PDFs
    let invoiceDate = null;  // set when an invoice PDF contains a parseable purchase date
    const pdfQueue = [];
    for (const att of (attachments || [])) {
      try {
        const { buffer, filename } = await Email.downloadAttachment(messageId, att.id, att.name);
        const result = await PDFParser.processPDF(buffer, filename);

        if (!result.isInvoice) {
          // Populate entry fields from the RMA form PDF
          const f = result.fields || {};
          if (f.make)             entry.make             = f.make;
          if (f.model)            entry.model            = f.model;
          if (f.serialNumber)     entry.serialNumber     = f.serialNumber;
          if (f.issueDescription) entry.issueDescription = f.issueDescription;
          if (f.warrantyStatus)   entry.warrantyStatus   = f.warrantyStatus;
          if (f.notes)            entry.notes            = f.notes;
        } else {
          if (result.invoiceDate) invoiceDate = result.invoiceDate;
        }

        pdfQueue.push({ buffer, isInvoice: result.isInvoice });
      } catch (err) {
        console.warn('[App] Attachment error:', err.message);
      }
    }

    // Infer warranty from invoice date when the RMA form didn't provide one.
    // Purchase date within 2 years of RMA submission → Yes; older → No.
    if (!entry.warrantyStatus && invoiceDate) {
      const rmaDate = new Date(entry.date);
      if (!isNaN(rmaDate.getTime())) {
        const diffDays = (rmaDate - invoiceDate) / 86400000;
        if (diffDays >= 0 && diffDays <= 730) {
          entry.warrantyStatus = 'Yes';
          console.log(`[App] Warranty inferred from invoice: Yes (${Math.round(diffDays)} days since purchase)`);
        } else if (diffDays > 730) {
          entry.warrantyStatus = 'No';
          console.log(`[App] Warranty inferred from invoice: No (${Math.round(diffDays)} days since purchase)`);
        }
      }
    }

    // Save entry to IndexedDB to obtain its auto-generated ID
    const entryId = await Storage.saveEntry(entry);

    // Second pass: store each PDF in IndexedDB linked to this entry
    // (model is now known after extracting fields above)
    for (const { buffer, isInvoice } of pdfQueue) {
      try {
        const fname = Storage.buildFilename(
          entry.rmaNumber, entry.dealer,
          entry.model || 'unknown', dateStr, isInvoice
        );
        await Storage.savePDF(entryId, fname, buffer, isInvoice ? 'invoice' : 'rma-form');
      } catch (err) {
        console.warn('[App] PDF save error:', err.message);
      }
    }

    return entry;
  }

  // ============================================================
  // TABLE
  // ============================================================
  async function refreshTable() {
    allEntries = await Storage.getAllEntries();
    applyFilterAndRender();
    updateStats(allEntries);
  }

  function applyFilterAndRender() {
    let list = allEntries;
    if (currentFilter === 'open')   list = list.filter(e => e.status === 'Open');
    if (currentFilter === 'closed') list = list.filter(e => e.status === 'Closed');
    if (currentSearch) {
      const q = currentSearch.toLowerCase();
      list = list.filter(e =>
        ['rmaNumber','dealer','make','model','serialNumber','issueDescription','notes']
          .some(k => (e[k]||'').toLowerCase().includes(q))
      );
    }
    list.sort((a,b) => {
      let va = a[sortField]||'', vb = b[sortField]||'';
      if (sortField === 'rmaNumber') { va = parseInt(va)||0; vb = parseInt(vb)||0; }
      return sortAsc ? (va < vb ? -1 : va > vb ? 1 : 0) : (va > vb ? -1 : va < vb ? 1 : 0);
    });
    renderTable(list);
  }

  function warrantyBadge(w) {
    if (!w) return '<span class="warr-badge warr-unknown">—</span>';
    // Accept both new ('Yes'/'No') and legacy ('In Warranty'/'Out of Warranty') values
    if (w === 'Yes' || w === 'In Warranty')     return '<span class="warr-badge warr-in">Yes</span>';
    if (w === 'No'  || w === 'Out of Warranty') return '<span class="warr-badge warr-out">No</span>';
    if (w === 'Expired')                        return '<span class="warr-badge warr-exp">Exp</span>';
    return `<span class="warr-badge warr-unknown">${esc(w)}</span>`;
  }

  function truncate(s, max) {
    if (!s) return '';
    return s.length > max ? esc(s.substring(0, max)) + '…' : esc(s);
  }

  function renderTable(entries) {
    const tbody = document.getElementById('rma-tbody');
    if (!entries.length) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="11"><div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
        <p>${allEntries.length ? 'No records match the filter.' : 'No RMA records yet.'}</p>
        <p class="empty-sub">${allEntries.length ? 'Try adjusting the search or filter.' : 'Sign in and click <strong>Fetch New Emails</strong>.'}</p>
      </div></td></tr>`;
      return;
    }
    tbody.innerHTML = entries.map(e => `<tr>
      <td><span class="badge ${e.status==='Closed'?'badge-closed':'badge-open'}"><span class="badge-dot"></span>${e.status}</span></td>
      <td><span class="rma-num">#${esc(e.rmaNumber)}</span></td>
      <td class="col-date">${esc(e.date)}</td>
      <td><span class="dealer-name">${esc(e.dealer)}</span></td>
      <td>${esc(e.make)}</td>
      <td><span class="model-cell">${esc(e.model)}</span></td>
      <td class="col-serial" title="${esc(e.serialNumber)}">${esc(e.serialNumber)}</td>
      <td class="col-warranty">${warrantyBadge(e.warrantyStatus)}</td>
      <td class="col-truncate" title="${esc(e.issueDescription)}">${truncate(e.issueDescription, 45)}</td>
      <td class="col-truncate" title="${esc(e.notes)}">${truncate(e.notes, 35)}</td>
      <td><div class="action-btns"><button class="btn-icon" title="Edit" onclick="App.openModal(${e.id})">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button></div></td>
    </tr>`).join('');
  }

  function updateStats(entries) {
    document.getElementById('stat-total').textContent  = entries.length;
    document.getElementById('stat-open').textContent   = entries.filter(e=>e.status==='Open').length;
    document.getElementById('stat-closed').textContent = entries.filter(e=>e.status==='Closed').length;
  }

  function setFilter(f, el) {
    currentFilter = f;
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    if (el) el.classList.add('active');
    applyFilterAndRender();
  }
  function onSearch(v) { currentSearch = v.trim(); applyFilterAndRender(); }
  function sortBy(field) {
    sortAsc = sortField === field ? !sortAsc : true;
    sortField = field;
    applyFilterAndRender();
  }

  // ============================================================
  // STATISTICS
  // ============================================================
  function computeStats(entries) {
    const total     = entries.length;
    const open      = entries.filter(e => e.status==='Open').length;
    const closed    = entries.filter(e => e.status==='Closed').length;
    const confirmed = entries.filter(e => e.issueConfirmed==='Yes').length;
    const notConf   = entries.filter(e => e.issueConfirmed==='No').length;
    const pending   = entries.filter(e => !e.issueConfirmed||e.issueConfirmed==='').length;
    const inWarr    = entries.filter(e => e.warrantyStatus==='Yes' || e.warrantyStatus==='In Warranty').length;
    const outWarr   = entries.filter(e => e.warrantyStatus==='No'  || e.warrantyStatus==='Out of Warranty').length;
    const expWarr   = entries.filter(e => e.warrantyStatus==='Expired').length;
    const unknWarr  = total - inWarr - outWarr - expWarr;

    // Group by dealer
    const dealerMap = {};
    for (const e of entries) {
      const k = e.dealer || 'Unknown';
      if (!dealerMap[k]) dealerMap[k] = { open:0, closed:0 };
      e.status==='Closed' ? dealerMap[k].closed++ : dealerMap[k].open++;
    }
    const dealers = Object.entries(dealerMap)
      .map(([name,d]) => ({ name, open:d.open, closed:d.closed, total:d.open+d.closed }))
      .sort((a,b) => b.total-a.total).slice(0,12);

    // Group by make / brand
    const makeMap = {};
    for (const e of entries) {
      const k = e.make || 'Unknown';
      if (!makeMap[k]) makeMap[k] = { open:0, closed:0 };
      e.status==='Closed' ? makeMap[k].closed++ : makeMap[k].open++;
    }
    const makes = Object.entries(makeMap)
      .map(([name,d]) => ({ name, open:d.open, closed:d.closed, total:d.open+d.closed }))
      .sort((a,b) => b.total-a.total).slice(0,12);

    // Group by model
    const modelMap = {};
    for (const e of entries) {
      if (!e.model) continue;
      if (!modelMap[e.model]) modelMap[e.model] = { make: e.make||'', open:0, closed:0 };
      e.status==='Closed' ? modelMap[e.model].closed++ : modelMap[e.model].open++;
    }
    const models = Object.entries(modelMap)
      .map(([name,d]) => ({ name, make:d.make, open:d.open, closed:d.closed, total:d.open+d.closed }))
      .sort((a,b) => b.total-a.total).slice(0,15);

    // Monthly trend (last 12 months)
    const monthly = {};
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const k = d.toISOString().substring(0,7);
      monthly[k] = { label: d.toLocaleDateString('en-US',{month:'short',year:'2-digit'}), count:0 };
    }
    for (const e of entries) {
      if (e.date) {
        const k = e.date.substring(0,7);
        if (monthly[k]) monthly[k].count++;
      }
    }

    return { total, open, closed, confirmed, notConf, pending,
             inWarr, outWarr, expWarr, unknWarr,
             dealers, makes, models, monthly: Object.values(monthly) };
  }

  function renderStats() {
    const s   = computeStats(allEntries);
    const pct = (n, d) => d > 0 ? Math.round((n/d)*100) : 0;

    // Show/hide empty state
    document.getElementById('stats-empty').style.display   = s.total ? 'none'  : 'block';
    document.getElementById('stats-content').style.display = s.total ? 'block' : 'none';
    document.getElementById('stats-subtitle').textContent  =
      s.total ? `Based on ${s.total} entr${s.total===1?'y':'ies'}` : '';
    if (!s.total) return;

    // Overview cards
    document.getElementById('sv-total').textContent    = s.total;
    document.getElementById('sv-open').textContent     = s.open;
    document.getElementById('sv-closed').textContent   = s.closed;
    document.getElementById('sv-confirm').textContent  = pct(s.confirmed,s.total)+'%';
    document.getElementById('sv-warranty').textContent = pct(s.inWarr,s.total)+'%';

    // Stacked bar rows (open + closed)
    const maxTotal   = (arr) => Math.max(...arr.map(x=>x.total), 1);
    const stackedBars = (arr, containerId) => {
      const mx = maxTotal(arr);
      document.getElementById(containerId).innerHTML = arr.map(item => `
        <div class="bar-row">
          <div class="bar-label" title="${esc(item.name)}">${esc(item.name)}</div>
          <div class="bar-track">
            <div class="bar-fill-open"   style="width:${pct(item.open,mx)}%"></div>
            <div class="bar-fill-closed" style="width:${pct(item.closed,mx)}%"></div>
          </div>
          <div class="bar-count">${item.total}</div>
        </div>`).join('') || '<p class="stats-empty">No data</p>';
    };
    stackedBars(s.dealers, 'chart-dealer');
    stackedBars(s.makes,   'chart-brand');

    // Monthly trend columns
    const maxMonth = Math.max(...s.monthly.map(m=>m.count), 1);
    document.getElementById('chart-monthly').innerHTML = `
      <div class="monthly-grid">
        ${s.monthly.map(m => `
          <div class="month-col">
            <div class="month-count">${m.count||''}</div>
            <div class="month-bar-wrap">
              <div class="month-bar" style="height:${pct(m.count,maxMonth)}%"></div>
            </div>
            <div class="month-label">${m.label}</div>
          </div>`).join('')}
      </div>`;

    // Horizontal breakdown bars
    const breakdown = (items, containerId) => {
      const tot = items.reduce((a,x)=>a+x.count,0)||1;
      document.getElementById(containerId).innerHTML = items.map(item => `
        <div class="breakdown-row">
          <div class="breakdown-label">${esc(item.label)}</div>
          <div class="breakdown-track">
            <div class="breakdown-fill" style="width:${pct(item.count,tot)}%;background:${item.color}"></div>
          </div>
          <div class="breakdown-pct">${pct(item.count,tot)}%</div>
          <div class="bar-count">${item.count}</div>
        </div>`).join('');
    };

    breakdown([
      { label:'Yes',     count:s.inWarr,   color:'#16a34a' },
      { label:'No',      count:s.outWarr,  color:'#dc2626' },
      { label:'Expired', count:s.expWarr,  color:'#9ca3af' },
      { label:'Unknown', count:s.unknWarr, color:'#d1d5db' }
    ], 'chart-warranty');

    breakdown([
      { label:'Confirmed',     count:s.confirmed, color:'#2563eb' },
      { label:'Not Confirmed', count:s.notConf,   color:'#dc2626' },
      { label:'Pending',       count:s.pending,   color:'#d1d5db' }
    ], 'chart-confirm');

    // Top models table
    document.getElementById('chart-models').innerHTML = s.models.length ? `
      <table class="model-table-inner">
        <thead><tr><th>#</th><th>Model</th><th>Make</th><th>Total</th><th>Open</th><th>Closed</th></tr></thead>
        <tbody>${s.models.map((m,i) => `
          <tr>
            <td>${i+1}</td>
            <td><strong>${esc(m.name)}</strong></td>
            <td>${esc(m.make)}</td>
            <td>${m.total}</td>
            <td style="color:var(--amber)">${m.open}</td>
            <td style="color:var(--green)">${m.closed}</td>
          </tr>`).join('')}
        </tbody>
      </table>` : '<p class="stats-empty">No model data extracted yet.</p>';
  }

  // ============================================================
  // MODAL
  // ============================================================
  async function openModal(id) {
    const entry = await Storage.getEntry(id);
    if (!entry) return;
    editingId = id;

    document.getElementById('modal-title').textContent  = `RMA #${entry.rmaNumber} — ${entry.dealer}`;
    document.getElementById('m-id').value               = entry.id;
    document.getElementById('m-rma').value              = entry.rmaNumber        || '';
    document.getElementById('m-date').value             = entry.date             || '';
    document.getElementById('m-dealer').value           = entry.dealer           || '';
    document.getElementById('m-make').value             = entry.make             || '';
    document.getElementById('m-model').value            = entry.model            || '';
    document.getElementById('m-serial').value           = entry.serialNumber     || '';
    document.getElementById('m-issue').value            = entry.issueDescription || '';
    document.getElementById('m-confirmed').value        = entry.issueConfirmed   || '';
    // Normalize legacy warranty values so they match the current dropdown options
    const wNorm = entry.warrantyStatus === 'In Warranty'      ? 'Yes'
                : entry.warrantyStatus === 'Out of Warranty'  ? 'No'
                : entry.warrantyStatus || '';
    document.getElementById('m-warranty').value         = wNorm;
    document.getElementById('m-action').value           = entry.courseOfAction   || '';
    document.getElementById('m-resolved-date').value   = entry.dateOfResolution  || '';
    document.getElementById('m-resolved-how').value    = entry.howResolved       || '';
    document.getElementById('m-notes').value            = entry.notes            || '';

    const toggle = document.getElementById('m-status-toggle');
    toggle.checked = entry.status === 'Closed';
    document.getElementById('m-status-label').textContent = entry.status || 'Open';

    // Load PDFs from IndexedDB; download any missing Drive PDFs, then render
    editingPDFs = await Storage.getPDFsForEntry(id);
    await syncMissingPDFsForEntry(id, editingPDFs);
    editingPDFs = await Storage.getPDFsForEntry(id);   // re-fetch after potential downloads
    renderModalFileList();

    document.getElementById('edit-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  // Trigger browser download for a stored PDF
  function downloadPDF(idx) {
    const pdf = editingPDFs[idx];
    if (!pdf) return;
    Storage.downloadPDF(pdf);
    showToast('Downloading: ' + pdf.filename);
  }

  function renderModalFileList() {
    const filesEl = document.getElementById('m-files');
    if (editingPDFs.length) {
      filesEl.innerHTML = editingPDFs.map((pdf, idx) => `
        <div class="file-item">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <span class="file-name">${esc(pdf.filename)}</span>
          <span class="file-type-badge ${pdf.type==='invoice'?'file-type-inv':'file-type-rma'}">${pdf.type==='invoice'?'Invoice':'RMA Form'}</span>
          ${pdf.driveFileId ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2" title="Stored in Google Drive" style="flex-shrink:0"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>` : ''}
          <button class="btn btn-secondary btn-sm" onclick="App.downloadPDF(${idx})">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download
          </button>
        </div>`).join('');
    } else {
      filesEl.innerHTML = '<p class="no-files">No PDF attachments stored for this entry.</p>';
    }
  }

  async function uploadInvoicePDF(input) {
    const file = input.files[0];
    input.value = ''; // reset so the same file can be re-selected if needed
    if (!file || !editingId) return;
    try {
      const buffer = await file.arrayBuffer();
      const entry  = await Storage.getEntry(editingId);
      const fname  = Storage.buildFilename(
        entry.rmaNumber, entry.dealer,
        entry.model || 'unknown', entry.date, true
      );
      await Storage.savePDF(editingId, fname, buffer, 'invoice');
      editingPDFs = await Storage.getPDFsForEntry(editingId);
      renderModalFileList();
      showToast('Invoice PDF saved.', 'success');
      // Upload to Drive and update pdfMeta in the background (non-blocking)
      if (Auth.isSignedIn()) {
        uploadPendingPDFs()
          .then(() => pushToDrive())
          .catch(e => console.warn('[Drive] Invoice PDF Drive upload failed:', e.message));
      }
    } catch (err) {
      showToast('Upload failed: ' + err.message, 'error');
    }
  }

  function closeModal() {
    document.getElementById('edit-modal').style.display = 'none';
    document.body.style.overflow = '';
    editingId   = null;
    editingPDFs = [];
  }
  function closeModalOnBackdrop(e) { if (e.target.id === 'edit-modal') closeModal(); }
  function onStatusToggle(cb) { document.getElementById('m-status-label').textContent = cb.checked ? 'Closed' : 'Open'; }

  async function saveEntry() {
    if (!editingId) return;
    const existing = await Storage.getEntry(editingId);
    if (!existing) return;
    const updated = {
      ...existing,
      status:           document.getElementById('m-status-toggle').checked ? 'Closed' : 'Open',
      date:             document.getElementById('m-date').value,
      dealer:           document.getElementById('m-dealer').value.trim(),
      make:             document.getElementById('m-make').value.trim(),
      model:            document.getElementById('m-model').value.trim(),
      serialNumber:     document.getElementById('m-serial').value.trim(),
      issueDescription: document.getElementById('m-issue').value.trim(),
      issueConfirmed:   document.getElementById('m-confirmed').value,
      warrantyStatus:   document.getElementById('m-warranty').value,
      courseOfAction:   document.getElementById('m-action').value.trim(),
      dateOfResolution: document.getElementById('m-resolved-date').value,
      howResolved:      document.getElementById('m-resolved-how').value.trim(),
      notes:            document.getElementById('m-notes').value.trim()
    };
    await Storage.saveEntry(updated);
    closeModal();
    showToast('Saved.', 'success');
    await refreshTable();
    await pushToDrive();
  }

  async function deleteEntry() {
    if (!editingId) return;
    if (!confirm('Delete this RMA entry and its stored PDFs?\n\nThis cannot be undone.')) return;
    // Remove PDF files from Drive before wiping local records
    if (Auth.isSignedIn()) {
      const pdfsWithDriveId = editingPDFs.filter(p => p.driveFileId);
      if (pdfsWithDriveId.length) {
        const driveIds = new Set(pdfsWithDriveId.map(p => p.driveFileId));
        drivePdfMeta = drivePdfMeta.filter(m => !driveIds.has(m.driveFileId));
        for (const pdf of pdfsWithDriveId) {
          DriveStore.deletePDF(pdf.driveFileId).catch(e =>
            console.warn('[Drive] PDF delete failed:', e.message)
          );
        }
      }
    }
    await Storage.deleteEntry(editingId);   // also removes linked PDFs from IndexedDB
    closeModal();
    showToast('Entry deleted.');
    await refreshTable();
    await pushToDrive();
  }

  // ============================================================
  // BACKUP & RESTORE
  // ============================================================
  let _backupRevokeTimer = null;

  async function exportBackup() {
    const exportBtn = document.getElementById('backup-export-btn');
    const readyDiv  = document.getElementById('backup-ready-link');
    const anchor    = document.getElementById('backup-dl-anchor');
    try {
      if (exportBtn) exportBtn.disabled = true;
      showToast('Preparing backup…');

      const result = await Storage.exportBackup();

      // ── Tappable link (guaranteed to work on iOS Safari) ──────────────────
      if (anchor && readyDiv) {
        anchor.href     = result.url;
        anchor.download = result.filename;
        readyDiv.style.display = 'flex';
        // Revoke the blob URL after 5 minutes to free memory
        if (_backupRevokeTimer) clearTimeout(_backupRevokeTimer);
        _backupRevokeTimer = setTimeout(() => {
          URL.revokeObjectURL(result.url);
          if (readyDiv) readyDiv.style.display = 'none';
        }, 300000);
      }

      // ── Also attempt auto-download for desktop browsers ───────────────────
      // (This is blocked on iOS Safari after async ops, hence the link above)
      try {
        const a = document.createElement('a');
        a.href = result.url; a.download = result.filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      } catch (_) { /* silent — user can tap the link instead */ }

      showToast(
        `Backup ready — ${result.entryCount} entries, ${result.pdfCount} PDF(s).`,
        'success'
      );
    } catch (err) {
      showToast('Backup failed: ' + err.message, 'error');
    } finally {
      if (exportBtn) exportBtn.disabled = false;
    }
  }

  async function importBackup() {
    const input = document.getElementById('backup-file-input');
    const file  = input.files[0];
    if (!file) { showToast('Please choose a backup file first.', 'error'); return; }

    const existing = await Storage.getAllEntries();
    const warning  = existing.length
      ? `Restore from backup?\n\nThis will REPLACE all current data (${existing.length} entr${existing.length === 1 ? 'y' : 'ies'}) with the contents of the backup file.\n\nThis cannot be undone.`
      : 'Import this backup?\n\nAll entries and PDFs in the backup file will be restored.';
    if (!confirm(warning)) { input.value = ''; return; }

    try {
      showToast('Restoring…');
      const text   = await file.text();
      const result = await Storage.importBackup(text);
      input.value  = '';
      allEntries   = [];
      await refreshTable();
      const dateStr = result.exportedAt ? ` (backed up ${result.exportedAt.split('T')[0]})` : '';
      showToast(
        `Restored ${result.entryCount} entries and ${result.pdfCount} PDF(s)${dateStr}.`,
        'success'
      );
      await pushToDrive();
    } catch (err) {
      showToast('Restore failed: ' + err.message, 'error');
    }
  }

  // ============================================================
  // EXCEL EXPORT (always a browser download in the web version)
  // ============================================================
  async function exportExcel() {
    const entries = await Storage.getAllEntries();
    if (!entries.length) { showToast('No entries to export.', 'error'); return; }
    const fn = await Excel.downloadExcel(entries);
    showToast('Downloading: ' + fn + ' — check your Downloads / Files app.', 'success');
  }

  // ============================================================
  // NAVIGATION
  // ============================================================
  function showSection(name, navEl) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    const target = document.getElementById('section-' + name);
    if (target) target.classList.add('active');
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    if (navEl) navEl.classList.add('active');
    if (name === 'stats') renderStats();
  }

  // ============================================================
  // PROGRESS / TOAST / UTILS
  // ============================================================
  function setProgress(pct, label) {
    document.getElementById('progress-wrap').style.display = 'block';
    document.getElementById('progress-bar').style.width = Math.min(100, pct) + '%';
    if (label) document.getElementById('progress-label').textContent = label;
  }
  function hideProgress() { document.getElementById('progress-wrap').style.display = 'none'; }

  let toastTimer = null;
  function showToast(msg, type='') {
    const el = document.getElementById('toast');
    el.textContent   = msg;
    el.className     = 'toast' + (type ? ' toast-'+type : '');
    el.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3500);
  }

  function esc(s) {
    return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  window.addEventListener('DOMContentLoaded', init);

  return {
    handleAuthClick, onAuthComplete, onAuthError,
    saveSettings, saveExcelName, saveCopyAs, confirmClearData,
    fetchEmails, showSection, setFilter, onSearch, sortBy,
    openModal, closeModal, closeModalOnBackdrop, onStatusToggle,
    saveEntry, deleteEntry, downloadPDF, uploadInvoicePDF,
    exportExcel,
    exportBackup, importBackup
  };
})();

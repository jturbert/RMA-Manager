# RMA Manager — Web Version Setup Guide
### Get it online and running on any device, including iPad

This guide walks you through everything from zero to a working app in your browser. It looks long, but each step is just a few clicks. Total time: about 20–25 minutes.

---

## What You'll End Up With

A website at an address like:
```
https://your-github-name.github.io/rma-manager/
```
You can bookmark this on your iPad, Mac, PC, or any device. It works like a regular website — no installation, no server, no thumbdrive required. Your RMA data is stored privately in your browser.

---

## Part 1 — Create a Free GitHub Account

GitHub hosts the app files for free. You only need an account — no programming knowledge required.

1. Go to **[https://github.com](https://github.com)**
2. Click **"Sign up"** (top right)
3. Enter an email, create a password, and choose a username
   - Your username will be part of the app's URL
   - Example: username `jsmith` → app at `https://jsmith.github.io/rma-manager/`
4. Complete verification and confirm your email

---

## Part 2 — Create a Repository

A "repository" is just a folder on GitHub where your app files live.

1. After signing in, click the **"+"** icon (top right) → **"New repository"**

2. Fill in the form:
   - **Repository name:** `rma-manager` *(exact name, lowercase, hyphen)*
   - **Public** — leave this selected (required for free GitHub Pages)
   - Leave everything else as-is

3. Click **"Create repository"**

Keep this tab open — you'll upload files here in Part 4.

---

## Part 3 — Set Up Google Cloud (for Gmail access)

> **If you already set up the desktop version:** You already have a Google Cloud project. Skip to the sub-section **"Add your GitHub Pages URL to the existing credentials"** below.

### New setup (no Google Cloud project yet)

#### 3a — Create a Google Cloud Project

1. Go to **[https://console.cloud.google.com/](https://console.cloud.google.com/)** and sign in with your Google account.

2. Click the **project selector** (top left, next to "Google Cloud").

3. Click **"New Project"**, name it `RMA Manager`, click **"Create"**.

4. Select the new project before continuing.

#### 3b — Enable the Gmail API

1. In the left sidebar: **"APIs & Services"** → **"Library"**
2. Search **"Gmail API"** → click it → click **"Enable"**

#### 3c — Configure the OAuth Consent Screen

1. Go to **"APIs & Services"** → **"OAuth consent screen"**
2. Choose **"External"** → click **"Create"**
3. Fill in:
   - **App name:** `RMA Manager`
   - **User support email:** your email
   - **Developer contact information:** your email
4. Click **"Save and Continue"** through Scopes and Test Users screens.
5. On the **Test Users** screen: click **"+ Add Users"** → add your Gmail address.
   > Required while the app is in Testing mode — only listed addresses can sign in.
6. Click **"Save and Continue"** → **"Back to Dashboard"**

#### 3d — Create OAuth Credentials

1. Go to **"APIs & Services"** → **"Credentials"**
2. Click **"+ Create Credentials"** → **"OAuth client ID"**
3. **Application type:** Web application
4. **Name:** `RMA Manager` (covers both versions)
5. Under **"Authorized redirect URIs"**, click **"+ Add URI"** and add **both**:
   ```
   http://localhost:8080/oauth-callback.html
   https://YOUR-GITHUB-USERNAME.github.io/rma-manager/oauth-callback.html
   ```
   *(Replace YOUR-GITHUB-USERNAME with your actual GitHub username.)*
6. Leave "Authorized JavaScript origins" empty — not needed for this app.
7. Click **"Create"**
8. Copy the **Client ID** — you'll need it shortly.

---

### Add your GitHub Pages callback URL to existing credentials
*(Skip this if you followed the new setup above)*

1. Go to **[https://console.cloud.google.com/](https://console.cloud.google.com/)** → your project
2. **"APIs & Services"** → **"Credentials"**
3. Click the pencil ✏️ next to your existing OAuth 2.0 client
4. Under **"Authorized redirect URIs"**, click **"+ Add URI"** and add:
   ```
   https://YOUR-GITHUB-USERNAME.github.io/rma-manager/oauth-callback.html
   ```
   (Also add `http://localhost:8080/oauth-callback.html` if it's not already there)
5. Click **"Save"**

Now the same Client ID works for both the desktop version and GitHub Pages.

---

## Part 4 — Edit config.js with Your Details

Before uploading, put your GitHub Pages URL and Client ID into the config file.

1. Open the **RMA-Manager-Web** folder on your Mac
2. Open **`config.js`** in a text editor (TextEdit, Notepad, etc.)
3. Replace the placeholder values:
   ```javascript
   const CONFIG = {
     googleClientId: 'PASTE-YOUR-CLIENT-ID-HERE',
     appOrigin: 'https://YOUR-GITHUB-USERNAME.github.io'
   };
   ```
   - **googleClientId:** paste the Client ID you copied in Part 3
   - **appOrigin:** your GitHub Pages base URL *(no trailing slash, no `/rma-manager`)*
4. Save the file

---

## Part 5 — Upload the App Files to GitHub

1. On your GitHub repository page, click **"uploading an existing file"** (link in the middle of the empty repo page)
   - Or click **"Add file"** → **"Upload files"**

2. Open your **RMA-Manager-Web** folder in Finder (Mac) or File Explorer (Windows).

3. Select **all files** inside the folder:
   - Mac: `Cmd + A`  |  Windows: `Ctrl + A`
   - **Important:** Select the files *inside* the folder, not the folder itself

4. Drag all selected files into the GitHub upload area in your browser.

5. You should see these files listed:
   - `index.html`, `app.js`, `auth.js`, `config.js`
   - `email.js`, `excel.js`, `pdf-parser.js`, `storage.js`
   - `styles.css`, `SETUP-WEB.md`

6. Scroll down → **"Commit changes"** → click **"Commit changes"**

---

## Part 6 — Enable GitHub Pages

1. On your repository page, click **"Settings"** tab (near the top)

2. In the left sidebar, click **"Pages"**

3. Under **"Branch"**, click the dropdown (currently "None") → select **"main"**

4. Leave folder as **"/ (root)"** → click **"Save"**

5. Wait about 60 seconds → refresh the page. You'll see:
   ```
   Your site is live at https://YOUR-USERNAME.github.io/rma-manager/
   ```

6. Click that link — your app should open!

---

## Part 7 — Enter Your Client ID in the App

1. Open your GitHub Pages URL in any browser

2. Click the **gear icon (⚙)** → **Settings**

3. Paste your **Google Client ID** into the "Google Client ID" field

4. Click **"Save & Reload"**

> The Client ID is also in `config.js`, so if you filled it in there before uploading, this step may already be done — check whether the setup banner is gone.

---

## Part 8 — Sign In and Test

1. Click **"Sign In with Google"** in the top right

2. A Google sign-in popup appears — sign in with the Gmail account that receives the RMA emails

3. If prompted: click **"Continue"** to allow the app to read your Gmail

4. You're signed in! Click **"Fetch New Emails"**

> **"Google hasn't verified this app"** — This is expected for private apps. Click **"Advanced"** → **"Go to RMA Manager (unsafe)"** to continue. The app only reads your email — it cannot send, delete, or modify anything.

---

## Using on iPad

1. Open **Safari** on your iPad
2. Go to your app URL: `https://your-username.github.io/rma-manager/`
3. Click **"Sign In with Google"** — a popup appears for sign-in
4. To save it to your home screen (like a regular app):
   - Tap the **Share button** (box with arrow pointing up)
   - Tap **"Add to Home Screen"**
   - Tap **"Add"**

**Downloading files on iPad:**
- **PDFs:** Open an RMA entry → tap **Download** next to each PDF → file goes to your **Files app** (iCloud Drive / Downloads)
- **Excel:** Tap **"Download Excel"** on the dashboard → check your **Files app**

---

## Keeping Both Versions in Sync

The desktop version (on your Mac/thumbdrive) and the web version store data **separately** — each has its own local browser database. This is intentional for privacy and simplicity.

**Recommended workflow:**
- Use whichever version is handy
- Click **"Download Excel"** regularly from either version
- The Excel file is your portable, shared record

**To transfer data between versions:**
The Excel spreadsheet contains everything. Download it from one version and keep it as your reference.

---

## Updating the App in the Future

If the app files are ever updated:

1. Download the new files
2. Go to your GitHub repository page
3. Click **"Add file"** → **"Upload files"**
4. Upload the new files (they overwrite the old ones)
5. Click **"Commit changes"**

The live site updates within about a minute.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Site shows a 404 error | Wait 2–3 minutes after enabling Pages and try again |
| "Google credentials not configured" banner | Enter your Client ID in Settings (Part 7) |
| Sign-in popup blocked | Allow popups for your GitHub Pages domain in browser settings |
| "Google hasn't verified this app" | Click "Advanced" → "Go to RMA Manager (unsafe)" — normal for private apps |
| "redirect_uri_mismatch" or "Token exchange failed" | In Google Cloud Console → your OAuth client → "Authorized redirect URIs", confirm `https://YOUR-USERNAME.github.io/rma-manager/oauth-callback.html` is listed exactly (full path). |
| Can't sign in on iPad | Use Safari; allow popups; try clearing site data if needed |
| Settings not saved after reload | Normal — settings live in the browser. Re-enter after clearing browser data |
| No emails found | Verify email subjects match `RMA #NNN from X about Y` exactly |
| Data on Mac not on iPad | Expected — data is per-browser. Use the Excel download as the shared record |
| App doesn't appear on home screen | Use Safari (not Chrome) on iPad to use "Add to Home Screen" |

---

## Privacy & Security

- Your GitHub repository is **public** (anyone can view the code), but it contains no personal data — only the app code
- Your Google Client ID in `config.js` is safe to be public — it is not a secret and cannot be used to impersonate you
- The app requests **read-only** Gmail access. It cannot send, delete, or modify any emails
- Access tokens are stored in **sessionStorage only** — they are automatically deleted when you close the browser tab or window
- All RMA data stays in your browser's private local storage and is never uploaded to GitHub or any server

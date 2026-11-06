// Application State
let currentUser = null;
let currentSessionToken = null;

// DOM Elements
const loginScreen = document.getElementById("loginScreen");
const inboxScreen = document.getElementById("inboxScreen");
const googleLoading = document.getElementById("googleLoading");
const loadingMessage = document.getElementById("loadingMessage");
const loginAlert = document.getElementById("loginAlert");
const googleOAuthBtn = document.getElementById("googleOAuthBtn");

const userAvatar = document.getElementById("userAvatar");
const userName = document.getElementById("userName");
const userEmail = document.getElementById("userEmail");
const logoutBtn = document.getElementById("logoutBtn");

const inboxItemsList = document.getElementById("inboxItemsList");
const inboxLoader = document.getElementById("inboxLoader");
const inboxEmptyState = document.getElementById("inboxEmptyState");
const inboxCounter = document.getElementById("inboxCounter");
const refreshInboxBtn = document.getElementById("refreshInboxBtn");

const openNewTokenModalBtn = document.getElementById("openNewTokenModalBtn");
const newTokenModal = document.getElementById("newTokenModal");
const closeModalBtn = document.getElementById("closeModalBtn");
const cancelModalBtn = document.getElementById("cancelModalBtn");
const createTokenForm = document.getElementById("createTokenForm");

// Initialize on DOM load
window.addEventListener("DOMContentLoaded", () => {
  setupEventListeners();
  checkOAuthRedirectCallback();
  checkExistingSession();
});

function setupEventListeners() {
  googleOAuthBtn.addEventListener("click", initiateGcpGoogleOAuth);
  logoutBtn.addEventListener("click", handleLogout);
  refreshInboxBtn.addEventListener("click", () => {
    if (currentUser) fetchInboxItems(currentUser.sub);
  });

  openNewTokenModalBtn.addEventListener("click", () => {
    newTokenModal.classList.remove("hidden");
  });

  const closeModal = () => newTokenModal.classList.add("hidden");
  closeModalBtn.addEventListener("click", closeModal);
  cancelModalBtn.addEventListener("click", closeModal);

  createTokenForm.addEventListener("submit", handleCreateNewToken);
}

/**
 * 1. Initiate GCP Google OAuth 2.0 Authorization Flow
 */
function initiateGcpGoogleOAuth() {
  if (CONFIG.GOOGLE_CLIENT_ID.includes("YOUR_GCP_GOOGLE_CLIENT_ID")) {
    showAlert("Please configure your GCP Google Client ID in frontend/config.js before signing in.", "info");
    return;
  }

  const state = Math.random().toString(36).substring(2, 15);
  sessionStorage.setItem("oauth_state", state);

  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    redirect_uri: CONFIG.REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "consent",
    state: state
  }).toString();

  window.location.href = authUrl;
}

/**
 * 2. Check and handle redirect callback from GCP Google OAuth
 */
async function checkOAuthRedirectCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get("code");
  const error = urlParams.get("error");

  if (error) {
    showAlert(`Google OAuth failed: ${error}`, "error");
    cleanUrlQuery();
    return;
  }

  if (code) {
    cleanUrlQuery();
    showLoginLoading(true, "Exchanging GCP OAuth authorization code with AWS Lambda...");
    hideAlert();

    try {
      let authData;
      const isMock = CONFIG.MOCK_MODE_IF_NO_API || CONFIG.API_BASE_URL.includes("YOUR_API_ID");

      if (!isMock) {
        const res = await fetch(`${CONFIG.API_BASE_URL}/auth/google`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: code,
            redirect_uri: CONFIG.REDIRECT_URI
          })
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${res.status}: Backend OAuth exchange failed`);
        }

        authData = await res.json();
      } else {
        authData = {
          status: "success",
          user: {
            sub: "gcp-oauth-user-12345",
            email: "developer@example.com",
            name: "Cloud Architect",
            picture: ""
          },
          session_token: "mock-session-" + Date.now(),
          isLocalFallback: true
        };
        showAlert("Logged in locally (configure API_BASE_URL to hit AWS Lambda & KMS).", "info");
      }

      currentUser = authData.user;
      currentSessionToken = authData.session_token;

      localStorage.setItem("cloudsecure_user", JSON.stringify(currentUser));
      localStorage.setItem("cloudsecure_session", currentSessionToken);

      renderAuthenticatedView();
      fetchInboxItems(currentUser.sub, authData.isLocalFallback);

    } catch (err) {
      console.error("GCP OAuth exchange error:", err);
      showAlert(`Authentication error: ${err.message}`, "error");
    } finally {
      showLoginLoading(false);
    }
  }
}

/**
 * 3. Fetch inbox elements from Tier 2/3 (Lambda + DynamoDB + AWS KMS)
 */
async function fetchInboxItems(userId, isLocalFallback = false) {
  inboxLoader.classList.remove("hidden");
  inboxEmptyState.classList.add("hidden");
  inboxItemsList.innerHTML = "";

  try {
    const isMock = isLocalFallback || CONFIG.MOCK_MODE_IF_NO_API || CONFIG.API_BASE_URL.includes("YOUR_API_ID");

    if (isMock) {
      setTimeout(() => {
        const mockItems = [
          {
            itemId: "INBOX#1",
            title: "GCP OAuth 2.0 Access & Refresh Credentials",
            sender: "GCP OAuth 2.0 Service",
            createdAt: new Date().toISOString(),
            status: "Encrypted via AWS KMS",
            ciphertextBlob: "AQICAHhy413e179F93J...[Encrypted via AWS KMS in DynamoDB]...",
            decryptedToken: "ya29.a0AWY7Ckm_GCP_OAuth_Access_Token_Stored_And_Encrypted_Via_KMS"
          },
          {
            itemId: "INBOX#2",
            title: "GCP OAuth Offline Refresh Token",
            sender: "AWS KMS Vault",
            createdAt: new Date(Date.now() - 3600000).toISOString(),
            status: "Encrypted via AWS KMS",
            ciphertextBlob: "AQICAHi8g82K94L1...[Encrypted via AWS KMS in DynamoDB]...",
            decryptedToken: "1//0eabc123-GCP-Offline-Refresh-Token-KMS-Encrypted"
          }
        ];
        renderInbox(mockItems);
        inboxLoader.classList.add("hidden");
      }, 400);
      return;
    }

    const res = await fetch(`${CONFIG.API_BASE_URL}/inbox?userId=${encodeURIComponent(userId)}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${currentSessionToken}`
      }
    });

    if (!res.ok) {
      throw new Error(`Failed to load inbox items: HTTP ${res.status}`);
    }

    const data = await res.json();
    renderInbox(data.items || []);

  } catch (err) {
    console.error("Fetch inbox error:", err);
    inboxItemsList.innerHTML = `<div class="alert alert-error">Failed to load inbox items: ${err.message}</div>`;
  } finally {
    inboxLoader.classList.add("hidden");
  }
}

/**
 * 4. Render inbox items into DOM
 */
function renderInbox(items) {
  inboxCounter.textContent = `${items.length} element${items.length === 1 ? '' : 's'}`;

  if (items.length === 0) {
    inboxEmptyState.classList.remove("hidden");
    return;
  }

  inboxItemsList.innerHTML = items.map((item, index) => {
    const formattedDate = new Date(item.createdAt || Date.now()).toLocaleString();
    const uniqueId = `token_preview_${index}`;

    return `
      <div class="inbox-item">
        <div class="item-header">
          <div>
            <div class="item-subject">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
                <polyline points="22,6 12,13 2,6"></polyline>
              </svg>
              ${escapeHtml(item.title || "GCP OAuth Credential Element")}
            </div>
            <div class="item-sender">Source: <strong>${escapeHtml(item.sender || "GCP OAuth")}</strong></div>
          </div>
          <span class="item-time">${formattedDate}</span>
        </div>

        <div class="token-container">
          <div class="token-label-bar">
            <span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 2px;">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
              Encrypted in DynamoDB with AWS KMS
            </span>
            <button class="btn btn-outline btn-sm" onclick="toggleTokenVisibility('${uniqueId}')">
              Show/Hide Plaintext
            </button>
          </div>

          <div class="ciphertext-preview">
            <strong>KMS Ciphertext (DynamoDB):</strong> ${escapeHtml(item.ciphertextBlob ? item.ciphertextBlob.substring(0, 75) + '...' : 'SSE-KMS Encrypted')}
          </div>

          <div id="${uniqueId}" class="token-value hidden" style="margin-top: 0.5rem;">
            <strong>Decrypted Credential / Token:</strong><br />
            <code>${escapeHtml(item.decryptedToken || item.credentialToken || "No plaintext available")}</code>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

/**
 * 5. Handle creation of new encrypted credential in inbox
 */
async function handleCreateNewToken(e) {
  e.preventDefault();
  const title = document.getElementById("tokenTitle").value.trim();
  const sender = document.getElementById("tokenSender").value.trim();
  const credentialToken = document.getElementById("tokenPayload").value.trim();

  if (!title || !credentialToken) return;

  const isMock = CONFIG.MOCK_MODE_IF_NO_API || CONFIG.API_BASE_URL.includes("YOUR_API_ID");

  try {
    if (isMock) {
      alert("Element saved (Demo Mode). Deploy backend SAM template for actual KMS hardware encryption!");
      newTokenModal.classList.add("hidden");
      createTokenForm.reset();
      fetchInboxItems(currentUser.sub, true);
      return;
    }

    const res = await fetch(`${CONFIG.API_BASE_URL}/inbox`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${currentSessionToken}`
      },
      body: JSON.stringify({
        userId: currentUser.sub,
        title,
        sender,
        credentialToken
      })
    });

    if (!res.ok) {
      throw new Error(`Failed to store credential: HTTP ${res.status}`);
    }

    newTokenModal.classList.add("hidden");
    createTokenForm.reset();
    fetchInboxItems(currentUser.sub);

  } catch (err) {
    alert("Error saving encrypted item: " + err.message);
  }
}

window.toggleTokenVisibility = function(elementId) {
  const el = document.getElementById(elementId);
  if (el) el.classList.toggle("hidden");
};

function renderAuthenticatedView() {
  loginScreen.classList.add("hidden");
  inboxScreen.classList.remove("hidden");

  userName.textContent = currentUser.name || "Authenticated User";
  userEmail.textContent = currentUser.email || "";
  if (currentUser.picture) {
    userAvatar.src = currentUser.picture;
    userAvatar.classList.remove("hidden");
  } else {
    userAvatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.name || 'User')}&background=2563eb&color=fff`;
  }
}

function checkExistingSession() {
  const savedUser = localStorage.getItem("cloudsecure_user");
  const savedSession = localStorage.getItem("cloudsecure_session");
  if (savedUser && savedSession) {
    try {
      currentUser = JSON.parse(savedUser);
      currentSessionToken = savedSession;
      renderAuthenticatedView();
      fetchInboxItems(currentUser.sub);
    } catch (e) {
      handleLogout();
    }
  }
}

function handleLogout() {
  currentUser = null;
  currentSessionToken = null;
  localStorage.removeItem("cloudsecure_user");
  localStorage.removeItem("cloudsecure_session");

  inboxScreen.classList.add("hidden");
  loginScreen.classList.remove("hidden");
}

function cleanUrlQuery() {
  const cleanUrl = window.location.origin + window.location.pathname;
  window.history.replaceState({}, document.title, cleanUrl);
}

function showAlert(message, type = "error") {
  loginAlert.textContent = message;
  loginAlert.className = `alert alert-${type}`;
  loginAlert.classList.remove("hidden");
}

function hideAlert() {
  loginAlert.classList.add("hidden");
}

function showLoginLoading(show, message = "Exchanging GCP OAuth code with AWS Lambda...") {
  if (show) {
    loadingMessage.textContent = message;
    googleLoading.classList.remove("hidden");
    googleOAuthBtn.style.display = "none";
  } else {
    googleLoading.classList.add("hidden");
    googleOAuthBtn.style.display = "inline-flex";
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
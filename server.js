const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DB_PATH = getDatabasePath();
const APP_BASE_URL = String(process.env.APP_BASE_URL || "").replace(/\/+$/, "");
const EMAIL_FROM = String(process.env.EMAIL_FROM || "").trim();
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || process.env.EMAIL_API_KEY || "").trim();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_AUTH_ATTEMPTS = 5;
const MAX_EMAIL_ACTION_ATTEMPTS = 3;
const authAttemptStore = new Map();
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".bat": "text/plain; charset=utf-8",
};

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const database = new DatabaseSync(DB_PATH);
initializeDatabase();

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || `localhost:${PORT}`}`);

  try {
    if (shouldRedirectToHttps(request)) {
      redirectToHttps(request, response);
      return;
    }

    if (await handleDynamicPage(request, response, requestUrl)) {
      return;
    }

    if (requestUrl.pathname.startsWith("/api/")) {
      await handleApi(request, response, requestUrl);
      return;
    }

    serveStaticFile(request, response, requestUrl);
  } catch (error) {
    logError(request, error);
    const statusCode = error?.statusCode || 500;
    sendJson(response, statusCode, { error: error?.message || "Internal server error." });
  }
});

server.listen(PORT, () => {
  console.log(`AthloFit.in server running on http://localhost:${PORT}`);
});

function initializeDatabase() {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      email_verified_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_state (
      user_id INTEGER PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  ensureUserColumns();
  ensureSessionExpiryColumn();
  purgeExpiredSessions();
  purgeExpiredTokenRows();
}

async function handleDynamicPage(request, response, requestUrl) {
  if (request.method === "GET" && requestUrl.pathname === "/verify-email") {
    await handleVerifyEmailPage(response, requestUrl);
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/reset-password") {
    renderHtml(response, 200, buildResetPasswordPage(requestUrl.searchParams.get("token") || ""));
    return true;
  }

  return false;
}

async function handleApi(request, response, requestUrl) {
  purgeExpiredSessions();
  purgeExpiredTokenRows();
  pruneExpiredAuthAttempts();

  if (request.method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      emailConfigured: isEmailDeliveryConfigured(),
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/auth/register") {
    const body = await readJsonBody(request);
    const email = normalizeEmail(body?.email);
    const password = String(body?.password || "");
    validateEmail(email);
    validatePassword(password);
    assertAuthAttemptAllowed(request, email, "register", MAX_AUTH_ATTEMPTS);
    const existing = database.prepare("SELECT id FROM users WHERE email = ?").get(email);

    if (existing) {
      recordFailedAuthAttempt(request, email, "register");
      sendJson(response, 409, { error: "That email already has an account." });
      return;
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password, salt);
    const result = database
      .prepare(
        "INSERT INTO users (email, password_hash, password_salt, email_verified) VALUES (?, ?, ?, 0)",
      )
      .run(email, passwordHash, salt);
    clearAuthAttempts(request, email, "register");

    const sessionToken = createSession(result.lastInsertRowid);
    let verificationDelivery;
    try {
      verificationDelivery = await sendVerificationEmailForUser({
        request,
        requestUrl,
        userId: result.lastInsertRowid,
        email,
      });
    } catch (error) {
      logError(request, error);
      verificationDelivery = {
        sent: false,
        mode: "error",
        message: "Account created, but the verification email could not be delivered right now.",
      };
    }

    sendJson(response, 201, {
      email,
      emailVerified: false,
      sessionToken,
      verificationEmailSent: verificationDelivery.sent,
      emailDeliveryMode: verificationDelivery.mode,
      message: verificationDelivery.message,
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/auth/login") {
    const body = await readJsonBody(request);
    const email = normalizeEmail(body?.email);
    const password = String(body?.password || "");
    validateEmail(email);
    if (!password) {
      throw createHttpError(400, "Enter your password.");
    }
    assertAuthAttemptAllowed(request, email, "login", MAX_AUTH_ATTEMPTS);
    const user = database
      .prepare("SELECT id, email_verified, password_hash, password_salt FROM users WHERE email = ?")
      .get(email);

    if (!user || hashPassword(password, user.password_salt) !== user.password_hash) {
      recordFailedAuthAttempt(request, email, "login");
      sendJson(response, 401, { error: "Incorrect email or password." });
      return;
    }

    clearAuthAttempts(request, email, "login");
    const sessionToken = createSession(user.id);
    sendJson(response, 200, {
      email,
      emailVerified: Boolean(user.email_verified),
      sessionToken,
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/auth/logout") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    database.prepare("DELETE FROM sessions WHERE token = ?").run(session.token);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/auth/me") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    const user = getUserById(session.userId);
    if (!user) {
      sendJson(response, 404, { error: "Account not found." });
      return;
    }

    sendJson(response, 200, {
      email: user.email,
      emailVerified: Boolean(user.email_verified),
      createdAt: user.created_at,
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/auth/resend-verification") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    const user = getUserById(session.userId);
    if (!user) {
      sendJson(response, 404, { error: "Account not found." });
      return;
    }

    if (user.email_verified) {
      sendJson(response, 200, {
        ok: true,
        emailVerified: true,
        message: "Your email is already verified.",
      });
      return;
    }

    assertAuthAttemptAllowed(request, user.email, "resend-verification", MAX_EMAIL_ACTION_ATTEMPTS);
    let delivery;
    try {
      delivery = await sendVerificationEmailForUser({
        request,
        requestUrl,
        userId: user.id,
        email: user.email,
      });
    } catch (error) {
      logError(request, error);
      delivery = {
        sent: false,
        mode: "error",
        message: "We could not send the verification email right now. Please try again shortly.",
      };
    }
    clearAuthAttempts(request, user.email, "resend-verification");
    sendJson(response, 200, {
      ok: true,
      emailVerified: false,
      verificationEmailSent: delivery.sent,
      emailDeliveryMode: delivery.mode,
      message: delivery.message,
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/auth/forgot-password") {
    const body = await readJsonBody(request);
    const email = normalizeEmail(body?.email);

    if (email) {
      validateEmail(email);
      assertAuthAttemptAllowed(request, email, "forgot-password", MAX_EMAIL_ACTION_ATTEMPTS);
      const user = database
        .prepare("SELECT id, email FROM users WHERE email = ?")
        .get(email);

      if (user) {
        try {
          await sendPasswordResetEmailForUser({
            request,
            requestUrl,
            userId: user.id,
            email: user.email,
          });
        } catch (error) {
          logError(request, error);
        }
      }

      clearAuthAttempts(request, email, "forgot-password");
    }

    sendJson(response, 200, {
      ok: true,
      message: "If that email exists, we sent a reset link.",
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/auth/reset-password") {
    const body = await readJsonBody(request);
    const token = String(body?.token || "").trim();
    const password = String(body?.password || "");

    if (!token) {
      throw createHttpError(400, "Reset token is required.");
    }

    validatePassword(password);
    const tokenRecord = getValidTokenRecord("password_reset_tokens", token);
    if (!tokenRecord) {
      throw createHttpError(400, "This reset link is invalid or expired.");
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password, salt);
    database
      .prepare(
        "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?",
      )
      .run(passwordHash, salt, tokenRecord.user_id);
    markTokenUsed("password_reset_tokens", tokenRecord.token_hash);
    deleteTokensForUser("password_reset_tokens", tokenRecord.user_id);
    database.prepare("DELETE FROM sessions WHERE user_id = ?").run(tokenRecord.user_id);

    sendJson(response, 200, {
      ok: true,
      message: "Password reset successful. Please sign in again.",
    });
    return;
  }

  if (requestUrl.pathname === "/api/state") {
    const session = requireSession(request, response);
    if (!session) {
      return;
    }

    if (request.method === "GET") {
      const row = database
        .prepare("SELECT state_json FROM user_state WHERE user_id = ?")
        .get(session.userId);
      sendJson(response, 200, row ? JSON.parse(row.state_json) : getEmptyState());
      return;
    }

    if (request.method === "PUT") {
      const body = await readJsonBody(request);
      const normalized = normalizeState(body);
      database
        .prepare(`
          INSERT INTO user_state (user_id, state_json, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id)
          DO UPDATE SET state_json = excluded.state_json, updated_at = CURRENT_TIMESTAMP
        `)
        .run(session.userId, JSON.stringify(normalized));
      sendJson(response, 200, { ok: true });
      return;
    }
  }

  sendJson(response, 404, { error: "Not found." });
}

function serveStaticFile(request, response, requestUrl) {
  const relativePath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const resolvedPath = path.normalize(path.join(ROOT, relativePath));
  const relativeToRoot = path.relative(ROOT, resolvedPath);

  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (!fs.existsSync(resolvedPath) || fs.statSync(resolvedPath).isDirectory()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const extension = path.extname(resolvedPath).toLowerCase();
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
  });
  fs.createReadStream(resolvedPath).pipe(response);
}

async function handleVerifyEmailPage(response, requestUrl) {
  const token = requestUrl.searchParams.get("token") || "";
  if (!token) {
    renderHtml(
      response,
      400,
      buildMessagePage({
        title: "Missing verification link",
        body: "This email verification link is incomplete. Request a fresh verification email from your account.",
        tone: "warning",
      }),
    );
    return;
  }

  const tokenRecord = getValidTokenRecord("email_verification_tokens", token);
  if (!tokenRecord) {
    renderHtml(
      response,
      400,
      buildMessagePage({
        title: "Verification link expired",
        body: "This verification link is no longer valid. Sign in and request a fresh verification email.",
        tone: "warning",
      }),
    );
    return;
  }

  database
    .prepare("UPDATE users SET email_verified = 1, email_verified_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(tokenRecord.user_id);
  markTokenUsed("email_verification_tokens", tokenRecord.token_hash);
  deleteTokensForUser("email_verification_tokens", tokenRecord.user_id);

  renderHtml(
    response,
    200,
    buildMessagePage({
      title: "Email verified",
      body: "Your AthloFit account is now verified. You can go back to the app and continue training.",
      tone: "success",
    }),
  );
}

function validateEmail(email) {
  if (!email || !email.includes("@")) {
    throw createHttpError(400, "Enter a valid email address.");
  }
}

function validatePassword(password) {
  if (password.length < 8) {
    throw createHttpError(400, "Use a password with at least 8 characters.");
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw createHttpError(400, "Password must include uppercase, lowercase, and a number.");
  }
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function ensureUserColumns() {
  const columns = database.prepare("PRAGMA table_info(users)").all();
  const hasEmailVerified = columns.some((column) => column.name === "email_verified");
  const hasEmailVerifiedAt = columns.some((column) => column.name === "email_verified_at");

  if (!hasEmailVerified) {
    database.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasEmailVerifiedAt) {
    database.exec("ALTER TABLE users ADD COLUMN email_verified_at TEXT");
  }
}

function ensureSessionExpiryColumn() {
  const columns = database.prepare("PRAGMA table_info(sessions)").all();
  const hasExpiryColumn = columns.some((column) => column.name === "expires_at");

  if (!hasExpiryColumn) {
    database.exec("ALTER TABLE sessions ADD COLUMN expires_at TEXT");
    database
      .prepare(
        "UPDATE sessions SET expires_at = ? WHERE expires_at IS NULL OR expires_at = ''",
      )
      .run(toSqliteDateTime(new Date(Date.now() + SESSION_TTL_MS)));
  }
}

function getDatabasePath() {
  if (process.env.DB_PATH) {
    if (process.env.DB_PATH === ":memory:") {
      return process.env.DB_PATH;
    }

    return path.resolve(process.env.DB_PATH);
  }

  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "data.sqlite");
  }

  return path.join(ROOT, "data.sqlite");
}

function createSession(userId) {
  purgeExpiredSessions();
  const token = crypto.randomUUID();
  const expiresAt = toSqliteDateTime(new Date(Date.now() + SESSION_TTL_MS));
  database
    .prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .run(token, userId, expiresAt);
  return token;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function requireSession(request, response) {
  const token = getBearerToken(request);
  if (!token) {
    sendJson(response, 401, { error: "Sign in first." });
    return null;
  }

  const session = database
    .prepare("SELECT token, user_id, expires_at FROM sessions WHERE token = ?")
    .get(token);
  if (!session) {
    sendJson(response, 401, { error: "Your session expired. Sign in again." });
    return null;
  }

  if (session.expires_at <= toSqliteDateTime(new Date())) {
    database.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    sendJson(response, 401, { error: "Your session expired. Sign in again." });
    return null;
  }

  return { token, userId: session.user_id };
}

function getBearerToken(request) {
  const authorization = request.headers.authorization || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

function purgeExpiredSessions() {
  database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(toSqliteDateTime(new Date()));
}

function purgeExpiredTokenRows() {
  const now = toSqliteDateTime(new Date());
  database
    .prepare("DELETE FROM email_verification_tokens WHERE expires_at <= ?")
    .run(now);
  database
    .prepare("DELETE FROM password_reset_tokens WHERE expires_at <= ?")
    .run(now);
}

function assertAuthAttemptAllowed(request, email, action, limit = MAX_AUTH_ATTEMPTS) {
  const key = getAuthAttemptKey(request, email, action);
  const entry = authAttemptStore.get(key);

  if (!entry) {
    return;
  }

  if (Date.now() > entry.expiresAt) {
    authAttemptStore.delete(key);
    return;
  }

  if (entry.count >= limit) {
    throw createHttpError(429, "Too many attempts. Try again in 15 minutes.");
  }
}

function recordFailedAuthAttempt(request, email, action) {
  const key = getAuthAttemptKey(request, email, action);
  const existing = authAttemptStore.get(key);
  const now = Date.now();

  if (!existing || now > existing.expiresAt) {
    authAttemptStore.set(key, {
      count: 1,
      expiresAt: now + RATE_LIMIT_WINDOW_MS,
    });
    return;
  }

  existing.count += 1;
  authAttemptStore.set(key, existing);
}

function clearAuthAttempts(request, email, action) {
  authAttemptStore.delete(getAuthAttemptKey(request, email, action));
}

function pruneExpiredAuthAttempts() {
  const now = Date.now();
  for (const [key, entry] of authAttemptStore.entries()) {
    if (now > entry.expiresAt) {
      authAttemptStore.delete(key);
    }
  }
}

function getAuthAttemptKey(request, email, action) {
  return `${action}:${email}:${getClientIp(request)}`;
}

function getClientIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return request.socket?.remoteAddress || "unknown";
}

async function sendVerificationEmailForUser({ request, requestUrl, userId, email }) {
  const token = createOneTimeToken("email_verification_tokens", userId, EMAIL_VERIFICATION_TTL_MS);
  const verificationUrl = `${getPublicBaseUrl(request, requestUrl)}/verify-email?token=${encodeURIComponent(token)}`;
  const subject = "Verify your AthloFit account";
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111;">
      <h2>Verify your AthloFit account</h2>
      <p>Thanks for creating your account. Click the button below to verify your email and secure recovery for your account.</p>
      <p>
        <a href="${verificationUrl}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#0a8f9f;color:#fff;text-decoration:none;font-weight:700;">
          Verify email
        </a>
      </p>
      <p>If the button does not open, paste this link into your browser:</p>
      <p><a href="${verificationUrl}">${verificationUrl}</a></p>
    </div>
  `;
  const text = `Verify your AthloFit account: ${verificationUrl}`;

  return sendEmailWithFallback({
    request,
    requestUrl,
    userId,
    email,
    subject,
    html,
    text,
    previewLabel: "Verify email",
    previewUrl: verificationUrl,
  });
}

async function sendPasswordResetEmailForUser({ request, requestUrl, userId, email }) {
  const token = createOneTimeToken("password_reset_tokens", userId, PASSWORD_RESET_TTL_MS);
  const resetUrl = `${getPublicBaseUrl(request, requestUrl)}/reset-password?token=${encodeURIComponent(token)}`;
  const subject = "Reset your AthloFit password";
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111;">
      <h2>Reset your AthloFit password</h2>
      <p>We received a request to reset your password. Use the button below to choose a new one.</p>
      <p>
        <a href="${resetUrl}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#0f1418;color:#fff;text-decoration:none;font-weight:700;">
          Reset password
        </a>
      </p>
      <p>This link expires in 30 minutes.</p>
      <p>If the button does not open, paste this link into your browser:</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
    </div>
  `;
  const text = `Reset your AthloFit password: ${resetUrl}`;

  return sendEmailWithFallback({
    request,
    requestUrl,
    userId,
    email,
    subject,
    html,
    text,
    previewLabel: "Reset password",
    previewUrl: resetUrl,
  });
}

async function sendEmailWithFallback({
  request,
  requestUrl,
  userId,
  email,
  subject,
  html,
  text,
  previewLabel,
  previewUrl,
}) {
  if (isEmailDeliveryConfigured()) {
    await sendResendEmail({
      to: email,
      subject,
      html,
      text,
    });
    return {
      sent: true,
      mode: "resend",
      message: previewLabel === "Verify email"
        ? "Verification email sent."
        : "Password reset email sent.",
    };
  }

  console.log(`[Email preview] ${previewLabel} for ${email}: ${previewUrl}`);
  return {
    sent: false,
    mode: "preview",
    message:
      "Email delivery is scaffolded, but this server does not have Resend configured yet. A preview link was written to the server logs.",
  };
}

async function sendResendEmail({ to, subject, html, text }) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [to],
      subject,
      html,
      text,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw createHttpError(502, `Resend email delivery failed: ${body || response.statusText}`);
  }
}

function isEmailDeliveryConfigured() {
  return Boolean(RESEND_API_KEY && EMAIL_FROM);
}

function createOneTimeToken(tableName, userId, ttlMs) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashOpaqueToken(rawToken);
  const expiresAt = toSqliteDateTime(new Date(Date.now() + ttlMs));

  deleteTokensForUser(tableName, userId);
  database
    .prepare(
      `INSERT INTO ${tableName} (token_hash, user_id, expires_at) VALUES (?, ?, ?)`,
    )
    .run(tokenHash, userId, expiresAt);

  return rawToken;
}

function getValidTokenRecord(tableName, rawToken) {
  if (!rawToken) {
    return null;
  }

  const tokenHash = hashOpaqueToken(rawToken);
  const row = database
    .prepare(
      `SELECT token_hash, user_id, expires_at, used_at FROM ${tableName} WHERE token_hash = ?`,
    )
    .get(tokenHash);

  if (!row) {
    return null;
  }

  if (row.used_at || row.expires_at <= toSqliteDateTime(new Date())) {
    return null;
  }

  return row;
}

function markTokenUsed(tableName, tokenHash) {
  database
    .prepare(`UPDATE ${tableName} SET used_at = CURRENT_TIMESTAMP WHERE token_hash = ?`)
    .run(tokenHash);
}

function deleteTokensForUser(tableName, userId) {
  database.prepare(`DELETE FROM ${tableName} WHERE user_id = ?`).run(userId);
}

function hashOpaqueToken(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function getUserById(userId) {
  return database
    .prepare("SELECT id, email, email_verified, email_verified_at, created_at FROM users WHERE id = ?")
    .get(userId);
}

function getPublicBaseUrl(request, requestUrl) {
  if (APP_BASE_URL) {
    return APP_BASE_URL;
  }

  const isProduction = process.env.NODE_ENV === "production";
  const protocol = isProduction
    ? request.headers["x-forwarded-proto"] || "https"
    : requestUrl.protocol.replace(":", "") || "http";
  const host = request.headers.host || `localhost:${PORT}`;
  return `${protocol}://${host}`;
}

function normalizeState(body) {
  const activities = Array.isArray(body?.activities)
    ? body.activities
        .map((activity) => ({
          id: String(activity?.id || ""),
          type: normalizeActivityType(activity?.type),
          date: String(activity?.date || ""),
          distanceKm: Number(activity?.distanceKm || 0),
          movingSeconds: Number(activity?.movingSeconds || activity?.durationSeconds),
          durationSeconds: Number(activity?.durationSeconds || activity?.movingSeconds),
          calories: Number.isFinite(Number(activity?.calories)) ? Number(activity.calories) : null,
          notes: String(activity?.notes || ""),
          source: String(activity?.source || "manual"),
          verified: Boolean(activity?.verified),
        }))
        .filter(
          (activity) =>
            activity.date &&
            Number.isFinite(activity.movingSeconds) &&
            activity.movingSeconds > 0 &&
            Number.isFinite(activity.distanceKm),
        )
    : [];
  const manualRuns = Array.isArray(body?.manualRuns)
    ? body.manualRuns
        .map((run) => ({
          date: String(run?.date || ""),
          distanceKm: Number(run?.distanceKm),
          movingSeconds: Number(run?.movingSeconds),
        }))
        .filter(
          (run) =>
            run.date &&
            Number.isFinite(run.distanceKm) &&
            run.distanceKm > 0 &&
            Number.isFinite(run.movingSeconds) &&
            run.movingSeconds > 0,
        )
    : [];
  const profile = normalizeProfile(body?.profile);

  return {
    profile,
    activities,
    manualRuns,
    bulkRuns: String(body?.bulkRuns || ""),
    forecastMode: body?.forecastMode === "race" ? "race" : "comfort",
    goalDistanceKm: Number.isFinite(Number(body?.goalDistanceKm))
      ? Math.max(1, Number(body.goalDistanceKm))
      : 21.1,
    targetTime: String(body?.targetTime || ""),
    goalDate: String(body?.goalDate || ""),
  };
}

function normalizeProfile(profile) {
  return {
    name: String(profile?.name || ""),
    age: Number.isFinite(Number(profile?.age)) ? Number(profile.age) : null,
    sex: profile?.sex === "male" || profile?.sex === "female" ? profile.sex : "",
    heightCm: Number.isFinite(Number(profile?.heightCm)) ? Number(profile.heightCm) : null,
    weightKg: Number.isFinite(Number(profile?.weightKg)) ? Number(profile.weightKg) : null,
    goalWeightKg: Number.isFinite(Number(profile?.goalWeightKg)) ? Number(profile.goalWeightKg) : null,
    activityLevel: ["sedentary", "light", "moderate", "active", "veryActive"].includes(profile?.activityLevel)
      ? profile.activityLevel
      : "light",
    mainGoal: ["maintain", "fatLoss", "muscleGain", "performance"].includes(profile?.mainGoal)
      ? profile.mainGoal
      : "maintain",
  };
}

function normalizeActivityType(type) {
  return ["run", "walk", "hiit", "hyrox", "strength", "bodybuilding"].includes(type)
    ? type
    : "run";
}

function getEmptyState() {
  return {
    profile: normalizeProfile({}),
    activities: [],
    manualRuns: [],
    bulkRuns: "",
    forecastMode: "comfort",
    goalDistanceKm: 21.1,
    targetTime: "",
    goalDate: "",
  };
}

function shouldRedirectToHttps(request) {
  return (
    process.env.NODE_ENV === "production" &&
    request.headers["x-forwarded-proto"] &&
    request.headers["x-forwarded-proto"] !== "https"
  );
}

function redirectToHttps(request, response) {
  response.writeHead(301, {
    Location: `https://${request.headers.host}${request.url}`,
  });
  response.end();
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function renderHtml(response, statusCode, html) {
  response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw createHttpError(400, "Request body must be valid JSON.");
  }
}

function buildResetPasswordPage(token) {
  const safeToken = escapeHtml(token);
  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Reset Password | AthloFit.in</title>
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            background: linear-gradient(180deg, #fbfefe 0%, #f4f8f9 100%);
            color: #0f1418;
            font-family: Arial, sans-serif;
            padding: 24px;
          }
          .card {
            width: min(460px, 100%);
            background: white;
            border-radius: 24px;
            padding: 28px;
            box-shadow: 0 18px 40px rgba(12, 28, 38, 0.1);
          }
          h1 { margin: 0 0 12px; font-size: 1.8rem; }
          p { color: #61717b; line-height: 1.6; }
          label { display: grid; gap: 8px; margin-top: 18px; font-weight: 700; }
          input {
            padding: 14px;
            border-radius: 14px;
            border: 1px solid rgba(15, 20, 24, 0.12);
            font: inherit;
          }
          button {
            margin-top: 18px;
            width: 100%;
            height: 48px;
            border: none;
            border-radius: 999px;
            background: linear-gradient(135deg, #0f1418 0%, #0a8f9f 100%);
            color: white;
            font-size: 1rem;
            font-weight: 700;
            cursor: pointer;
          }
          .status {
            margin-top: 16px;
            font-weight: 700;
            color: #0a8f9f;
          }
        </style>
      </head>
      <body>
        <main class="card">
          <h1>Choose a new password</h1>
          <p>Use at least 8 characters with uppercase, lowercase, and a number.</p>
          <form id="resetForm">
            <input type="hidden" id="token" value="${safeToken}" />
            <label>
              New password
              <input id="password" type="password" autocomplete="new-password" />
            </label>
            <label>
              Confirm password
              <input id="confirmPassword" type="password" autocomplete="new-password" />
            </label>
            <button type="submit">Reset password</button>
          </form>
          <p id="status" class="status"></p>
        </main>
        <script>
          const form = document.getElementById("resetForm");
          const passwordInput = document.getElementById("password");
          const confirmInput = document.getElementById("confirmPassword");
          const tokenInput = document.getElementById("token");
          const status = document.getElementById("status");

          form.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (!passwordInput.value || !confirmInput.value) {
              status.textContent = "Enter and confirm your new password.";
              return;
            }
            if (passwordInput.value !== confirmInput.value) {
              status.textContent = "Passwords do not match.";
              return;
            }

            status.textContent = "Resetting password...";

            try {
              const response = await fetch("/api/auth/reset-password", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  token: tokenInput.value,
                  password: passwordInput.value,
                }),
              });
              const payload = await response.json();
              if (!response.ok) {
                throw new Error(payload.error || "Reset failed.");
              }
              status.textContent = "Password reset successful. Go back to AthloFit and sign in.";
              form.reset();
            } catch (error) {
              status.textContent = error.message || "Reset failed.";
            }
          });
        </script>
      </body>
    </html>
  `;
}

function buildMessagePage({ title, body, tone }) {
  const accent = tone === "success" ? "#159669" : tone === "warning" ? "#c27800" : "#0a8f9f";
  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtml(title)} | AthloFit.in</title>
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            background: linear-gradient(180deg, #fbfefe 0%, #f4f8f9 100%);
            color: #0f1418;
            font-family: Arial, sans-serif;
            padding: 24px;
          }
          .card {
            width: min(520px, 100%);
            background: white;
            border-radius: 24px;
            padding: 30px;
            box-shadow: 0 18px 40px rgba(12, 28, 38, 0.1);
            border-top: 4px solid ${accent};
          }
          h1 { margin: 0 0 12px; font-size: 2rem; }
          p { color: #61717b; line-height: 1.7; }
          a {
            display: inline-block;
            margin-top: 10px;
            color: ${accent};
            font-weight: 700;
            text-decoration: none;
          }
        </style>
      </head>
      <body>
        <main class="card">
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(body)}</p>
          <a href="/">Return to AthloFit</a>
        </main>
      </body>
    </html>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toSqliteDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function logError(request, error) {
  const timestamp = new Date().toISOString();
  const requestLine = request ? `${request.method || "?"} ${request.url || "?"}` : "unknown request";
  console.error(`[${timestamp}] ${requestLine}`);
  console.error(error);
}

process.on("unhandledRejection", (error) => {
  logError(null, error);
});

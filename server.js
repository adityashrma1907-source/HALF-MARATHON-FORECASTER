const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DB_PATH = getDatabasePath();
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
  try {
    if (request.url.startsWith("/api/")) {
      await handleApi(request, response);
      return;
    }

    serveStaticFile(request, response);
  } catch (error) {
    console.error(error);
    const statusCode = error?.statusCode || 500;
    sendJson(response, statusCode, { error: error?.message || "Internal server error." });
  }
});

server.listen(PORT, () => {
  console.log(`Strava Half Marathon Forecaster running on http://localhost:${PORT}`);
});

function initializeDatabase() {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_state (
      user_id INTEGER PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

async function handleApi(request, response) {
  if (request.method === "GET" && request.url === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && request.url === "/api/auth/register") {
    const body = await readJsonBody(request);
    const { email, password } = validateCredentials(body);
    const existing = database
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(email);

    if (existing) {
      sendJson(response, 409, { error: "That email already has an account." });
      return;
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password, salt);
    const result = database
      .prepare("INSERT INTO users (email, password_hash, password_salt) VALUES (?, ?, ?)")
      .run(email, passwordHash, salt);
    const sessionToken = createSession(result.lastInsertRowid);
    sendJson(response, 201, { email, sessionToken });
    return;
  }

  if (request.method === "POST" && request.url === "/api/auth/login") {
    const body = await readJsonBody(request);
    const { email, password } = validateCredentials(body);
    const user = database
      .prepare("SELECT id, password_hash, password_salt FROM users WHERE email = ?")
      .get(email);

    if (!user || hashPassword(password, user.password_salt) !== user.password_hash) {
      sendJson(response, 401, { error: "Incorrect email or password." });
      return;
    }

    const sessionToken = createSession(user.id);
    sendJson(response, 200, { email, sessionToken });
    return;
  }

  if (request.url === "/api/state") {
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

function serveStaticFile(request, response) {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  const relativePath = pathname === "/" ? "/index.html" : pathname;
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

function validateCredentials(body) {
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");

  if (!email || !email.includes("@")) {
    throw createHttpError(400, "Enter a valid email address.");
  }
  if (password.length < 6) {
    throw createHttpError(400, "Use a password with at least 6 characters.");
  }

  return { email, password };
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
  const token = crypto.randomUUID();
  database.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(token, userId);
  return token;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function requireSession(request, response) {
  const authorization = request.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) {
    sendJson(response, 401, { error: "Sign in first." });
    return null;
  }

  const session = database
    .prepare("SELECT user_id FROM sessions WHERE token = ?")
    .get(token);
  if (!session) {
    sendJson(response, 401, { error: "Your session expired. Sign in again." });
    return null;
  }

  return { userId: session.user_id };
}

function normalizeState(body) {
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

  return {
    manualRuns,
    bulkRuns: String(body?.bulkRuns || ""),
    forecastMode: body?.forecastMode === "race" ? "race" : "comfort",
    goalDate: String(body?.goalDate || ""),
  };
}

function getEmptyState() {
  return {
    manualRuns: [],
    bulkRuns: "",
    forecastMode: "comfort",
    goalDate: "",
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
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

process.on("unhandledRejection", (error) => {
  console.error(error);
});

const express    = require("express");
const http       = require("http");
const aedes      = require("aedes")();
const net        = require("net");
const ws         = require("ws");
const path       = require("path");
const fs         = require("fs");
const bcrypt     = require("bcryptjs");
const jwt        = require("jsonwebtoken");
const { randomUUID } = require("crypto");

const HTTP_PORT  = process.env.PORT       || 3000;
const MQTT_PORT  = process.env.MQTT_PORT  || 1883;
const MQTT_TOPIC = "notifier/demo2026";
const JWT_SECRET = process.env.JWT_SECRET || "superSecretKey_changeMeInProduction!";

// ── JSONBin config (set these in Render environment variables) ────────────
// Sign up free at https://jsonbin.io → API Keys → create key
// Create 3 bins (one for each data type) and paste the IDs below as env vars
const JSONBIN_KEY          = process.env.JSONBIN_KEY          || null; // Master key from JSONBin
const JSONBIN_BIN_CLIENTS  = process.env.JSONBIN_BIN_CLIENTS  || null; // Bin ID for users
const JSONBIN_BIN_ANNS     = process.env.JSONBIN_BIN_ANNS     || null; // Bin ID for announcements
const JSONBIN_BIN_DOCS     = process.env.JSONBIN_BIN_DOCS     || null; // Bin ID for doc requests

const JSONBIN_BASE = "https://api.jsonbin.io/v3/b";

// ── In-memory store (loaded from JSONBin on startup, saved back on writes) ─
let clients       = {};
let announcements = {};
let docRequests   = {};

// ── JSONBin helpers ───────────────────────────────────────────────────────
function jsonbinHeaders() {
    return { "Content-Type": "application/json", "X-Master-Key": JSONBIN_KEY };
}

async function jbGet(binId) {
    const res = await fetch(`${JSONBIN_BASE}/${binId}/latest`, { headers: jsonbinHeaders() });
    if (!res.ok) throw new Error(`JSONBin GET failed: ${res.status}`);
    const json = await res.json();
    return json.record;
}

async function jbSet(binId, data) {
    const res = await fetch(`${JSONBIN_BASE}/${binId}`, {
        method: "PUT",
        headers: jsonbinHeaders(),
        body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`JSONBin PUT failed: ${res.status}`);
}

async function loadAll() {
    if (!JSONBIN_KEY || !JSONBIN_BIN_CLIENTS) {
        console.log("⚠️  JSONBin not configured — data will not persist across restarts");
        console.log("    Set JSONBIN_KEY, JSONBIN_BIN_CLIENTS, JSONBIN_BIN_ANNS, JSONBIN_BIN_DOCS in Render env vars");
        return;
    }
    try {
        [clients, announcements, docRequests] = await Promise.all([
            jbGet(JSONBIN_BIN_CLIENTS),
            jbGet(JSONBIN_BIN_ANNS),
            jbGet(JSONBIN_BIN_DOCS),
        ]);
        console.log(`✅ Loaded from JSONBin — ${Object.keys(clients).length} client(s), ${Object.keys(announcements).length} announcement(s), ${Object.keys(docRequests).length} doc request(s)`);
    } catch (e) {
        console.error("⚠️  JSONBin load failed:", e.message);
    }
}

async function saveClients()       { if (JSONBIN_KEY && JSONBIN_BIN_CLIENTS) await jbSet(JSONBIN_BIN_CLIENTS, clients).catch(e => console.error("Save clients failed:", e.message)); }
async function saveAnnouncements() { if (JSONBIN_KEY && JSONBIN_BIN_ANNS)    await jbSet(JSONBIN_BIN_ANNS, announcements).catch(e => console.error("Save anns failed:", e.message)); }
async function saveDocRequests()   { if (JSONBIN_KEY && JSONBIN_BIN_DOCS)    await jbSet(JSONBIN_BIN_DOCS, docRequests).catch(e => console.error("Save docs failed:", e.message)); }

// ── DB helpers ────────────────────────────────────────────────────────────
const DB = {
    getClient(username)        { return clients[username] || null; },
    async saveClient(u, data)  { clients[u] = data; await saveClients(); },
    clientExists(username)     { return !!clients[username]; },

    getAnnouncements()         { return Object.values(announcements); },
    getAnnouncement(id)        { return announcements[id] || null; },
    async saveAnnouncement(a)  { announcements[a.id] = a; await saveAnnouncements(); },
    async deleteAnnouncement(id) { delete announcements[id]; await saveAnnouncements(); },

    getDocRequests()           { return Object.values(docRequests); },
    getDocRequest(id)          { return docRequests[id] || null; },
    async saveDocRequest(dr)   { docRequests[dr.id] = dr; await saveDocRequests(); },
};

// ── Admin credentials ─────────────────────────────────────────────────────
const ADMIN_USER = "admin";
const ADMIN_PASS = bcrypt.hashSync("admin1234", 10);

const app    = express();
const server = http.createServer(app);

app.set("trust proxy", true);
app.use(express.json());

// ── Auth middleware ───────────────────────────────────────────────────────
function requireClientAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer "))
        return res.status(401).json({ success: false, message: "Not authenticated" });
    try {
        const payload = jwt.verify(auth.slice(7), JWT_SECRET);
        if (payload.role !== "client") throw new Error();
        req.user = payload; next();
    } catch { res.status(401).json({ success: false, message: "Invalid or expired token" }); }
}

function requireAdminAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer "))
        return res.status(401).json({ success: false, message: "Not authenticated" });
    try {
        const payload = jwt.verify(auth.slice(7), JWT_SECRET);
        if (payload.role !== "admin") throw new Error();
        req.user = payload; next();
    } catch { res.status(401).json({ success: false, message: "Invalid or expired token" }); }
}

function publishAnnouncement(ann, callback) {
    const payload = JSON.stringify(ann);
    aedes.publish({ topic: MQTT_TOPIC, payload, qos: 1, retain: false, dup: false }, callback);
}

// ── Pages ─────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.get("/",          (_, res) => res.redirect("/login"));
app.get("/login",     (_, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/register",  (_, res) => res.sendFile(path.join(__dirname, "public", "register.html")));
app.get("/dashboard", (_, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/admin",     (_, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// ── Auth routes ───────────────────────────────────────────────────────────
app.post("/api/register", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
        return res.status(400).json({ success: false, message: "Username and password required" });
    if (username.length < 3)
        return res.status(400).json({ success: false, message: "Username must be at least 3 characters" });
    if (password.length < 6)
        return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    if (DB.clientExists(username))
        return res.status(409).json({ success: false, message: "Username already taken" });
    const data = { passwordHash: await bcrypt.hash(password, 10), createdAt: new Date().toISOString() };
    await DB.saveClient(username, data);
    console.log(`👤 Registered: ${username}`);
    res.json({ success: true, message: "Account created! You can now log in." });
});

app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;
    const user = DB.getClient(username);
    if (!user || !(await bcrypt.compare(password, user.passwordHash)))
        return res.status(401).json({ success: false, message: "Invalid username or password" });
    const token = jwt.sign({ username, role: "client" }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ success: true, token, username });
});

app.post("/api/admin/login", async (req, res) => {
    const { username, password } = req.body;
    if (username !== ADMIN_USER || !(await bcrypt.compare(password, ADMIN_PASS)))
        return res.status(401).json({ success: false, message: "Invalid admin credentials" });
    const token = jwt.sign({ username, role: "admin" }, JWT_SECRET, { expiresIn: "8h" });
    res.json({ success: true, token, username });
});

app.get("/api/verify", requireClientAuth, (req, res) => {
    res.json({ success: true, username: req.user.username });
});

// ── Announcements ──────────────────────────────────────────────────────────
app.get("/api/announcements", requireClientAuth, (req, res) => {
    const list = DB.getAnnouncements().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, announcements: list });
});

app.get("/api/admin/announcements", requireAdminAuth, (req, res) => {
    const list = DB.getAnnouncements().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, announcements: list });
});

app.post("/send", requireAdminAuth, async (req, res) => {
    const { title, message } = req.body;
    if (!title || !message)
        return res.status(400).json({ success: false, message: "Title and message required" });
    const ann = {
        id: randomUUID(), title, message,
        time: new Date().toLocaleString(),
        createdAt: new Date().toISOString(),
        edited: false, editedAt: null, deleted: false
    };
    await DB.saveAnnouncement(ann);
    publishAnnouncement({ ...ann, action: "create" }, (err) => {
        if (err) return res.status(500).json({ success: false, message: "Publish failed" });
        console.log(`📢 Sent: "${ann.title}"`);
        res.json({ success: true, message: "Notification sent!", announcement: ann });
    });
});

app.put("/api/announcement/:id", async (req, res) => {
    const { id } = req.params;
    const { title, message } = req.body;
    const existing = DB.getAnnouncement(id);
    if (!existing) return res.status(404).json({ success: false, message: "Announcement not found" });
    if (!title || !message) return res.status(400).json({ success: false, message: "Title and message required" });
    const updated = { ...existing, title, message, edited: true, editedAt: new Date().toLocaleString() };
    await DB.saveAnnouncement(updated);
    publishAnnouncement({ ...updated, action: "edit" }, (err) => {
        if (err) return res.status(500).json({ success: false, message: "Publish failed" });
        res.json({ success: true, message: "Announcement updated!", announcement: updated });
    });
});

app.delete("/api/announcement/:id", async (req, res) => {
    const { id } = req.params;
    const existing = DB.getAnnouncement(id);
    if (!existing) return res.status(404).json({ success: false, message: "Announcement not found" });
    await DB.deleteAnnouncement(id);
    publishAnnouncement({ id, action: "delete" }, (err) => {
        if (err) return res.status(500).json({ success: false, message: "Publish failed" });
        res.json({ success: true, message: "Announcement deleted!" });
    });
});

// ── Doc Requests ───────────────────────────────────────────────────────────
app.get("/document-request", (_, res) => res.sendFile(path.join(__dirname, "public", "document-request.html")));

app.post("/api/doc-requests", requireClientAuth, async (req, res) => {
    const { docType, purpose } = req.body;
    if (!docType) return res.status(400).json({ success: false, message: "Document type is required" });
    const dr = {
        id: randomUUID(), username: req.user.username, docType,
        purpose: purpose || "", status: "pending", adminNote: "",
        time: new Date().toLocaleString(), createdAt: new Date().toISOString()
    };
    await DB.saveDocRequest(dr);
    console.log(`📄 Doc request: "${docType}" by ${req.user.username}`);
    aedes.publish({ topic: "notifier/doc-requests", payload: JSON.stringify({ ...dr, action: "new" }), qos: 1, retain: false, dup: false }, () => {});
    res.json({ success: true, request: dr });
});

app.get("/api/doc-requests/mine", requireClientAuth, (req, res) => {
    const list = DB.getDocRequests()
        .filter(r => r.username === req.user.username)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, requests: list });
});

app.get("/api/admin/doc-requests", requireAdminAuth, (req, res) => {
    const list = DB.getDocRequests().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, requests: list });
});

app.put("/api/admin/doc-requests/:id", async (req, res) => {
    const { id } = req.params;
    const { status, adminNote } = req.body;
    const existing = DB.getDocRequest(id);
    if (!existing) return res.status(404).json({ success: false, message: "Request not found" });
    const validStatuses = ["pending", "processing", "ready", "rejected"];
    if (!validStatuses.includes(status)) return res.status(400).json({ success: false, message: "Invalid status" });
    const updated = { ...existing, status, adminNote: adminNote || "" };
    await DB.saveDocRequest(updated);
    aedes.publish({ topic: "notifier/doc-requests", payload: JSON.stringify({ ...updated, action: "update" }), qos: 1, retain: false, dup: false }, (err) => {
        if (err) return res.status(500).json({ success: false, message: "Publish failed" });
        res.json({ success: true, request: updated });
    });
});


// ── Cleanup route (removes corrupted/undefined entries) ───────────────────
app.post("/api/admin/cleanup", requireAdminAuth, async (req, res) => {
    let removed = 0;
    for (const [key, ann] of Object.entries(announcements)) {
        if (!ann || !ann.id || !ann.title || !ann.message ||
            ann.title === "undefined" || ann.message === "undefined") {
            delete announcements[key]; removed++;
        }
    }
    await saveAnnouncements();
    for (const [key, dr] of Object.entries(docRequests)) {
        if (!dr || !dr.id || !dr.docType || !dr.username ||
            dr.docType === "undefined" || dr.username === "undefined") {
            delete docRequests[key]; removed++;
        }
    }
    await saveDocRequests();
    console.log(`🧹 Cleanup: removed ${removed} corrupted entries`);
    res.json({ success: true, message: `Cleaned up ${removed} corrupted entries` });
});
// ── WebSocket MQTT ─────────────────────────────────────────────────────────
const wss = new ws.WebSocketServer({
    server, path: "/mqtt",
    handleProtocols: (protocols) => {
        if (protocols.has("mqtt"))     return "mqtt";
        if (protocols.has("mqttv3.1")) return "mqttv3.1";
        return false;
    }
});
wss.on("connection", (socket) => { aedes.handle(ws.createWebSocketStream(socket)); });

const tcpServer = net.createServer(aedes.handle.bind(aedes));
tcpServer.listen(MQTT_PORT, "0.0.0.0", () => console.log(`🔌 MQTT TCP on port ${MQTT_PORT}`));
tcpServer.on("error", (err) => console.warn(`⚠️  MQTT TCP unavailable (${err.message}) — WebSocket MQTT still works.`));

aedes.on("client",           (c) => console.log(`📲 Connected:    ${c.id}`));
aedes.on("clientDisconnect", (c) => console.log(`📴 Disconnected: ${c.id}`));

// ── Start ──────────────────────────────────────────────────────────────────
(async () => {
    await loadAll();
    server.listen(HTTP_PORT, "0.0.0.0", () => {
        console.log(`\n🚀 NotifyMQ running`);
        console.log(`   http://localhost:${HTTP_PORT}/login`);
        console.log(`   http://localhost:${HTTP_PORT}/admin\n`);
    });
})();

process.on("SIGINT", () => aedes.close(() => server.close(() => process.exit(0))));

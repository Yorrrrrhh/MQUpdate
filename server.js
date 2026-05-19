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

// ── File-based databases ──────────────────────────────────────────────────
const DB_FILE   = path.join(__dirname, "clients.json");
const ANN_FILE  = path.join(__dirname, "announcements.json");
const DOC_FILE  = path.join(__dirname, "doc-requests.json");

function loadJSON(file) {
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) { console.error("⚠️  Could not read", file, e.message); }
    return {};
}
function saveJSON(file, data) {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8"); }
    catch (e) { console.error("⚠️  Could not save", file, e.message); }
}

let clients       = loadJSON(DB_FILE);
let announcements = loadJSON(ANN_FILE); // { id: { id, title, message, time, edited, editedAt } }
let docRequests   = loadJSON(DOC_FILE); // { id: { id, username, docType, purpose, status, adminNote, time, createdAt } }

console.log(`📂 Loaded ${Object.keys(clients).length} client(s)`);
console.log(`📂 Loaded ${Object.keys(announcements).length} announcement(s)`);
console.log(`📂 Loaded ${Object.keys(docRequests).length} doc request(s)`);

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

// ── Helper: publish a packet and save to disk ─────────────────────────────
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
    if (clients[username])
        return res.status(409).json({ success: false, message: "Username already taken" });
    clients[username] = { passwordHash: await bcrypt.hash(password, 10), createdAt: new Date().toISOString() };
    saveJSON(DB_FILE, clients);
    console.log(`👤 Registered: ${username}`);
    res.json({ success: true, message: "Account created! You can now log in." });
});

app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;
    const user = clients[username];
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

// ── Get all announcements (client dashboard on load) ──────────────────────
app.get("/api/announcements", requireClientAuth, (req, res) => {
    const list = Object.values(announcements).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, announcements: list });
});

// ── Get all announcements for admin ──────────────────────────────────────
app.get("/api/admin/announcements", requireAdminAuth, (req, res) => {
    const list = Object.values(announcements).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, announcements: list });
});

// ── Send new announcement ─────────────────────────────────────────────────
app.post("/send", requireAdminAuth, (req, res) => {
    const { title, message } = req.body;
    if (!title || !message)
        return res.status(400).json({ success: false, message: "Title and message required" });

    const ann = {
        id:        randomUUID(),
        title,
        message,
        time:      new Date().toLocaleString(),
        createdAt: new Date().toISOString(),
        edited:    false,
        editedAt:  null,
        deleted:   false
    };

    announcements[ann.id] = ann;
    saveJSON(ANN_FILE, announcements);

    publishAnnouncement({ ...ann, action: "create" }, (err) => {
        if (err) return res.status(500).json({ success: false, message: "Publish failed" });
        console.log(`📢 Sent: "${ann.title}"`);
        res.json({ success: true, message: "Notification sent!", announcement: ann });
    });
});

// ── Edit announcement ─────────────────────────────────────────────────────
app.put("/api/announcement/:id", requireAdminAuth, (req, res) => {
    const { id } = req.params;
    const { title, message } = req.body;
    if (!announcements[id])
        return res.status(404).json({ success: false, message: "Announcement not found" });
    if (!title || !message)
        return res.status(400).json({ success: false, message: "Title and message required" });

    announcements[id] = {
        ...announcements[id],
        title,
        message,
        edited:   true,
        editedAt: new Date().toLocaleString()
    };
    saveJSON(ANN_FILE, announcements);

    publishAnnouncement({ ...announcements[id], action: "edit" }, (err) => {
        if (err) return res.status(500).json({ success: false, message: "Publish failed" });
        console.log(`✏️  Edited: "${title}"`);
        res.json({ success: true, message: "Announcement updated!", announcement: announcements[id] });
    });
});

// ── Delete announcement ───────────────────────────────────────────────────
app.delete("/api/announcement/:id", requireAdminAuth, (req, res) => {
    const { id } = req.params;
    if (!announcements[id])
        return res.status(404).json({ success: false, message: "Announcement not found" });

    const title = announcements[id].title;
    delete announcements[id];
    saveJSON(ANN_FILE, announcements);

    publishAnnouncement({ id, action: "delete" }, (err) => {
        if (err) return res.status(500).json({ success: false, message: "Publish failed" });
        console.log(`🗑️  Deleted: "${title}"`);
        res.json({ success: true, message: "Announcement deleted!" });
    });
});

app.get("/document-request", (_, res) => res.sendFile(path.join(__dirname, "public", "document-request.html")));

// ── Doc Request: submit (client) ──────────────────────────────────────────
app.post("/api/doc-requests", requireClientAuth, (req, res) => {
    const { docType, purpose } = req.body;
    if (!docType)
        return res.status(400).json({ success: false, message: "Document type is required" });

    const dr = {
        id:        randomUUID(),
        username:  req.user.username,
        docType,
        purpose:   purpose || "",
        status:    "pending",
        adminNote: "",
        time:      new Date().toLocaleString(),
        createdAt: new Date().toISOString()
    };

    docRequests[dr.id] = dr;
    saveJSON(DOC_FILE, docRequests);
    console.log(`📄 Doc request: "${docType}" by ${req.user.username}`);
    res.json({ success: true, request: dr });
});

// ── Doc Request: get mine (client) ────────────────────────────────────────
app.get("/api/doc-requests/mine", requireClientAuth, (req, res) => {
    const list = Object.values(docRequests)
        .filter(r => r.username === req.user.username)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, requests: list });
});

// ── Doc Request: get all (admin) ──────────────────────────────────────────
app.get("/api/admin/doc-requests", requireAdminAuth, (req, res) => {
    const list = Object.values(docRequests).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, requests: list });
});

// ── Doc Request: update status (admin) ───────────────────────────────────
app.put("/api/admin/doc-requests/:id", requireAdminAuth, (req, res) => {
    const { id } = req.params;
    const { status, adminNote } = req.body;
    if (!docRequests[id])
        return res.status(404).json({ success: false, message: "Request not found" });

    const validStatuses = ["pending", "processing", "ready", "rejected"];
    if (!validStatuses.includes(status))
        return res.status(400).json({ success: false, message: "Invalid status" });

    docRequests[id] = { ...docRequests[id], status, adminNote: adminNote || "" };
    saveJSON(DOC_FILE, docRequests);

    const updated = docRequests[id];
    // Notify via MQTT so the student's page updates in real time
    const payload = JSON.stringify({ ...updated, action: "update" });
    aedes.publish({ topic: "notifier/doc-requests", payload, qos: 1, retain: false, dup: false }, (err) => {
        if (err) return res.status(500).json({ success: false, message: "Publish failed" });
        console.log(`📄 Updated request ${id} → ${status}`);
        res.json({ success: true, request: updated });
    });
});


const wss = new ws.WebSocketServer({
    server, path: "/mqtt",
    handleProtocols: (protocols) => {
        if (protocols.has("mqtt"))     return "mqtt";
        if (protocols.has("mqttv3.1")) return "mqttv3.1";
        return false;
    }
});
wss.on("connection", (socket) => {
    aedes.handle(ws.createWebSocketStream(socket));
});

// TCP MQTT — only used when running locally (Render only exposes HTTP/WS)
const tcpServer = net.createServer(aedes.handle.bind(aedes));
tcpServer.listen(MQTT_PORT, "0.0.0.0", () => console.log(`🔌 MQTT TCP on port ${MQTT_PORT}`));
tcpServer.on("error", (err) => console.warn(`⚠️  MQTT TCP unavailable (${err.message}) — WebSocket MQTT still works.`));

aedes.on("client",           (c) => console.log(`📲 Connected:    ${c.id}`));
aedes.on("clientDisconnect", (c) => console.log(`📴 Disconnected: ${c.id}`));

server.listen(HTTP_PORT, "0.0.0.0", () => {
    console.log(`\n🚀 NotifyMQ running`);
    console.log(`   http://localhost:${HTTP_PORT}/login`);
    console.log(`   http://localhost:${HTTP_PORT}/admin\n`);
});

process.on("SIGINT", () => aedes.close(() => server.close(() => process.exit(0))));

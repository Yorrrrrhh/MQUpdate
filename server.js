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

// ── MongoDB (set MONGO_URI env var on Render to enable persistent storage) ──
const MONGO_URI  = process.env.MONGO_URI || null;

let db = null; // MongoDB database handle (null = use JSON fallback)

// ── File-based fallback databases (used when MONGO_URI is not set) ──────────
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

// In-memory cache (used for JSON fallback mode)
let clients       = loadJSON(DB_FILE);
let announcements = loadJSON(ANN_FILE);
let docRequests   = loadJSON(DOC_FILE);

// ── MongoDB helpers ───────────────────────────────────────────────────────────

async function connectMongo() {
    if (!MONGO_URI) return false;
    try {
        const { MongoClient } = require("mongodb");
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        db = client.db("mqnotifier");
        console.log("✅ Connected to MongoDB — data will persist across restarts");

        // Migrate existing JSON data into MongoDB (runs once; skips if already there)
        await migrateJSONToMongo();
        return true;
    } catch (e) {
        console.error("⚠️  MongoDB connection failed, falling back to JSON files:", e.message);
        db = null;
        return false;
    }
}

async function migrateJSONToMongo() {
    // Clients
    const existingClients = await db.collection("clients").countDocuments();
    if (existingClients === 0) {
        const localClients = loadJSON(DB_FILE);
        if (Object.keys(localClients).length > 0) {
            const docs = Object.entries(localClients).map(([username, data]) => ({ _id: username, ...data }));
            await db.collection("clients").insertMany(docs);
            console.log(`📦 Migrated ${docs.length} client(s) from JSON to MongoDB`);
        }
    }
    // Announcements
    const existingAnns = await db.collection("announcements").countDocuments();
    if (existingAnns === 0) {
        const localAnns = loadJSON(ANN_FILE);
        if (Object.keys(localAnns).length > 0) {
            const docs = Object.values(localAnns).map(a => ({ ...a, _id: a.id }));
            await db.collection("announcements").insertMany(docs);
            console.log(`📦 Migrated ${docs.length} announcement(s) from JSON to MongoDB`);
        }
    }
    // Doc requests
    const existingDocs = await db.collection("docRequests").countDocuments();
    if (existingDocs === 0) {
        const localDocs = loadJSON(DOC_FILE);
        if (Object.keys(localDocs).length > 0) {
            const docs = Object.values(localDocs).map(d => ({ ...d, _id: d.id }));
            await db.collection("docRequests").insertMany(docs);
            console.log(`📦 Migrated ${docs.length} doc request(s) from JSON to MongoDB`);
        }
    }
}

// ── DB abstraction layer (works with both MongoDB and JSON) ──────────────────

const DB = {
    // ── Clients ──
    async getClient(username) {
        if (db) {
            const doc = await db.collection("clients").findOne({ _id: username });
            return doc ? { passwordHash: doc.passwordHash, createdAt: doc.createdAt } : null;
        }
        return clients[username] || null;
    },
    async saveClient(username, data) {
        if (db) {
            await db.collection("clients").updateOne(
                { _id: username },
                { $set: { ...data, _id: username } },
                { upsert: true }
            );
        } else {
            clients[username] = data;
            saveJSON(DB_FILE, clients);
        }
    },
    async clientExists(username) {
        if (db) {
            return !!(await db.collection("clients").findOne({ _id: username }));
        }
        return !!clients[username];
    },

    // ── Announcements ──
    async getAnnouncements() {
        if (db) {
            const docs = await db.collection("announcements").find({}).toArray();
            return docs.map(({ _id, ...rest }) => ({ id: _id, ...rest }));
        }
        return Object.values(announcements);
    },
    async getAnnouncement(id) {
        if (db) {
            const doc = await db.collection("announcements").findOne({ _id: id });
            if (!doc) return null;
            const { _id, ...rest } = doc;
            return { id: _id, ...rest };
        }
        return announcements[id] || null;
    },
    async saveAnnouncement(ann) {
        if (db) {
            await db.collection("announcements").updateOne(
                { _id: ann.id },
                { $set: { ...ann, _id: ann.id } },
                { upsert: true }
            );
        } else {
            announcements[ann.id] = ann;
            saveJSON(ANN_FILE, announcements);
        }
    },
    async deleteAnnouncement(id) {
        if (db) {
            await db.collection("announcements").deleteOne({ _id: id });
        } else {
            delete announcements[id];
            saveJSON(ANN_FILE, announcements);
        }
    },

    // ── Doc Requests ──
    async getDocRequests() {
        if (db) {
            const docs = await db.collection("docRequests").find({}).toArray();
            return docs.map(({ _id, ...rest }) => ({ id: _id, ...rest }));
        }
        return Object.values(loadJSON(DOC_FILE));
    },
    async getDocRequest(id) {
        if (db) {
            const doc = await db.collection("docRequests").findOne({ _id: id });
            if (!doc) return null;
            const { _id, ...rest } = doc;
            return { id: _id, ...rest };
        }
        const fresh = loadJSON(DOC_FILE);
        return fresh[id] || null;
    },
    async saveDocRequest(dr) {
        if (db) {
            await db.collection("docRequests").updateOne(
                { _id: dr.id },
                { $set: { ...dr, _id: dr.id } },
                { upsert: true }
            );
        } else {
            const fresh = loadJSON(DOC_FILE);
            fresh[dr.id] = dr;
            saveJSON(DOC_FILE, fresh);
            docRequests = fresh;
        }
    },
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

// ── Helper: publish a packet ───────────────────────────────────────────────
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
    if (await DB.clientExists(username))
        return res.status(409).json({ success: false, message: "Username already taken" });

    const data = { passwordHash: await bcrypt.hash(password, 10), createdAt: new Date().toISOString() };
    await DB.saveClient(username, data);
    console.log(`👤 Registered: ${username}`);
    res.json({ success: true, message: "Account created! You can now log in." });
});

app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;
    const user = await DB.getClient(username);
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
app.get("/api/announcements", requireClientAuth, async (req, res) => {
    const list = (await DB.getAnnouncements()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, announcements: list });
});

app.get("/api/admin/announcements", requireAdminAuth, async (req, res) => {
    const list = (await DB.getAnnouncements()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, announcements: list });
});

app.post("/send", requireAdminAuth, async (req, res) => {
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

    await DB.saveAnnouncement(ann);

    publishAnnouncement({ ...ann, action: "create" }, (err) => {
        if (err) return res.status(500).json({ success: false, message: "Publish failed" });
        console.log(`📢 Sent: "${ann.title}"`);
        res.json({ success: true, message: "Notification sent!", announcement: ann });
    });
});

app.put("/api/announcement/:id", requireAdminAuth, async (req, res) => {
    const { id } = req.params;
    const { title, message } = req.body;
    const existing = await DB.getAnnouncement(id);
    if (!existing)
        return res.status(404).json({ success: false, message: "Announcement not found" });
    if (!title || !message)
        return res.status(400).json({ success: false, message: "Title and message required" });

    const updated = { ...existing, title, message, edited: true, editedAt: new Date().toLocaleString() };
    await DB.saveAnnouncement(updated);

    publishAnnouncement({ ...updated, action: "edit" }, (err) => {
        if (err) return res.status(500).json({ success: false, message: "Publish failed" });
        console.log(`✏️  Edited: "${title}"`);
        res.json({ success: true, message: "Announcement updated!", announcement: updated });
    });
});

app.delete("/api/announcement/:id", requireAdminAuth, async (req, res) => {
    const { id } = req.params;
    const existing = await DB.getAnnouncement(id);
    if (!existing)
        return res.status(404).json({ success: false, message: "Announcement not found" });

    const title = existing.title;
    await DB.deleteAnnouncement(id);

    publishAnnouncement({ id, action: "delete" }, (err) => {
        if (err) return res.status(500).json({ success: false, message: "Publish failed" });
        console.log(`🗑️  Deleted: "${title}"`);
        res.json({ success: true, message: "Announcement deleted!" });
    });
});

// ── Doc Requests ───────────────────────────────────────────────────────────
app.get("/document-request", (_, res) => res.sendFile(path.join(__dirname, "public", "document-request.html")));

app.post("/api/doc-requests", requireClientAuth, async (req, res) => {
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

    await DB.saveDocRequest(dr);
    console.log(`📄 Doc request: "${docType}" by ${req.user.username}`);
    const payload = JSON.stringify({ ...dr, action: "new" });
    aedes.publish({ topic: "notifier/doc-requests", payload, qos: 1, retain: false, dup: false }, () => {});
    res.json({ success: true, request: dr });
});

app.get("/api/doc-requests/mine", requireClientAuth, async (req, res) => {
    const all = await DB.getDocRequests();
    const list = all
        .filter(r => r.username === req.user.username)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, requests: list });
});

app.get("/api/admin/doc-requests", requireAdminAuth, async (req, res) => {
    const list = (await DB.getDocRequests()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    console.log(`📋 Admin fetched doc requests: ${list.length} total`);
    res.json({ success: true, requests: list });
});

app.put("/api/admin/doc-requests/:id", requireAdminAuth, async (req, res) => {
    const { id } = req.params;
    const { status, adminNote } = req.body;
    const existing = await DB.getDocRequest(id);
    if (!existing)
        return res.status(404).json({ success: false, message: "Request not found" });

    const validStatuses = ["pending", "processing", "ready", "rejected"];
    if (!validStatuses.includes(status))
        return res.status(400).json({ success: false, message: "Invalid status" });

    const updated = { ...existing, status, adminNote: adminNote || "" };
    await DB.saveDocRequest(updated);

    const payload = JSON.stringify({ ...updated, action: "update" });
    aedes.publish({ topic: "notifier/doc-requests", payload, qos: 1, retain: false, dup: false }, (err) => {
        if (err) return res.status(500).json({ success: false, message: "Publish failed" });
        console.log(`📄 Updated request ${id} → ${status}`);
        res.json({ success: true, request: updated });
    });
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
wss.on("connection", (socket) => {
    aedes.handle(ws.createWebSocketStream(socket));
});

// TCP MQTT — only used when running locally (Render only exposes HTTP/WS)
const tcpServer = net.createServer(aedes.handle.bind(aedes));
tcpServer.listen(MQTT_PORT, "0.0.0.0", () => console.log(`🔌 MQTT TCP on port ${MQTT_PORT}`));
tcpServer.on("error", (err) => console.warn(`⚠️  MQTT TCP unavailable (${err.message}) — WebSocket MQTT still works.`));

aedes.on("client",           (c) => console.log(`📲 Connected:    ${c.id}`));
aedes.on("clientDisconnect", (c) => console.log(`📴 Disconnected: ${c.id}`));

// ── Start ──────────────────────────────────────────────────────────────────
(async () => {
    await connectMongo(); // Try MongoDB; falls back to JSON silently

    if (!db) {
        console.log(`📂 Using JSON files — set MONGO_URI env var for persistent storage`);
        console.log(`📂 Loaded ${Object.keys(clients).length} client(s)`);
        console.log(`📂 Loaded ${Object.keys(announcements).length} announcement(s)`);
        console.log(`📂 Loaded ${Object.keys(docRequests).length} doc request(s)`);
    }

    server.listen(HTTP_PORT, "0.0.0.0", () => {
        console.log(`\n🚀 NotifyMQ running`);
        console.log(`   http://localhost:${HTTP_PORT}/login`);
        console.log(`   http://localhost:${HTTP_PORT}/admin\n`);
    });
})();

process.on("SIGINT", () => aedes.close(() => server.close(() => process.exit(0))));

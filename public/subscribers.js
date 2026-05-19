const token    = localStorage.getItem("token");
const username = localStorage.getItem("username");
const role     = localStorage.getItem("role");

if (!token || role !== "client") window.location.href = "/login";

document.getElementById("username-label").textContent = username || "";

function logout() {
    localStorage.removeItem("token");
    localStorage.removeItem("username");
    localStorage.removeItem("role");
    window.location.href = "/login";
}

fetch("/api/verify", { headers: { "Authorization": "Bearer " + token } })
    .then(r => { if (!r.ok) logout(); })
    .catch(() => {});

// ── Load existing announcements from server on page load ──────────────────
async function loadAnnouncements() {
    try {
        const res  = await fetch("/api/announcements", { headers: { "Authorization": "Bearer " + token } });
        if (!res.ok) { logout(); return; }
        const data = await res.json();
        data.announcements.forEach(ann => renderAnnouncement(ann, false));
    } catch {}
}

// ── Render a single announcement ──────────────────────────────────────────
function renderAnnouncement(data, firePopup) {
    const list = document.getElementById("notifications");

    const placeholder = list.querySelector(".notif-empty");
    if (placeholder) placeholder.remove();

    const existing = list.querySelector(`[data-id="${data.id}"]`);

    if (data.action === "delete") {
        if (existing) existing.remove();
        if (list.children.length === 0) {
            const li = document.createElement("li");
            li.className = "notif-empty";
            li.textContent = "No announcements yet. Waiting for messages…";
            list.appendChild(li);
        }
        return;
    }

    const editedBadge = data.edited
        ? `<span class="edited-badge">✏️ Edited · ${data.editedAt}</span>`
        : "";

    const html = `
        <strong>${data.title}</strong>
        <span class="notif-msg">${data.message}</span>
        <small>${data.time}</small>
        ${editedBadge}
    `;

    if (existing) {
        // Update in place
        existing.innerHTML = html;
        existing.classList.add("notif-updated");
        setTimeout(() => existing.classList.remove("notif-updated"), 1500);
    } else {
        const li = document.createElement("li");
        li.setAttribute("data-id", data.id);
        li.innerHTML = html;
        list.prepend(li);
    }

    if (firePopup && Notification.permission === "granted") {
        const label = data.action === "edit" ? `✏️ Edited: ${data.title}` : data.title;
        new Notification(label, { body: data.message });
    }
}

// ── MQTT ──────────────────────────────────────────────────────────────────
const MQTT_TOPIC  = "notifier/demo2026";
const wsProtocol  = window.location.protocol === "https:" ? "wss" : "ws";
const MQTT_BROKER = `${wsProtocol}://${window.location.host}/mqtt`;

const connStatus = document.getElementById("conn-status");

if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
}

const client = mqtt.connect(MQTT_BROKER);

client.on("connect", () => {
    connStatus.textContent = "🟢 Connected";
    connStatus.className   = "badge badge--ok";
    client.subscribe(MQTT_TOPIC, { qos: 1 });
    loadAnnouncements(); // load history after connecting
});

client.on("message", (topic, raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); }
    catch { return; }
    renderAnnouncement(data, true);
});

client.on("error",     () => { connStatus.textContent = "🔴 Error";         connStatus.className = "badge badge--error"; });
client.on("reconnect", () => { connStatus.textContent = "🟡 Reconnecting…"; connStatus.className = "badge badge--warn";  });
client.on("close",     () => { connStatus.textContent = "🔴 Disconnected";  connStatus.className = "badge badge--error"; });

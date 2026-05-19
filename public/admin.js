async function sendNotification() {
    const title   = document.getElementById("title").value.trim();
    const message = document.getElementById("message").value.trim();
    const status  = document.getElementById("status");
    const btn     = document.querySelector(".btn-send");
    const btnText = document.getElementById("btn-text");

    if (!title || !message) {
        status.textContent = "Please fill in both fields.";
        status.style.color = "#f87171";
        return;
    }

    btn.disabled = true;
    btnText.textContent = "Sending…";
    status.textContent = "";

    try {
        const res = await fetch("/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, message })
        });

        const data = await res.json();

        if (data.success) {
            status.textContent = "✅ " + data.message;
            status.style.color = "#4ade80";
            document.getElementById("title").value = "";
            document.getElementById("message").value = "";
        } else {
            status.textContent = "❌ " + data.message;
            status.style.color = "#f87171";
        }
    } catch (err) {
        status.textContent = "❌ Network error. Is the server running?";
        status.style.color = "#f87171";
    } finally {
        btn.disabled = false;
        btnText.textContent = "Send Notification";
    }
}

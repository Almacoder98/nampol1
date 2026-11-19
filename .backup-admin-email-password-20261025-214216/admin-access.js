import { auth } from "./firebase-config.js";

const apiOrigin = () => ["localhost", "127.0.0.1"].includes(window.location.hostname)
    ? `${window.location.protocol}//${window.location.hostname}:8001` : window.location.origin;

async function authRequest(user, path, body) {
    const token = await user.getIdToken(true);
    if (auth.currentUser !== user) throw new Error("Your session changed. Please sign in again.");
    const response = await fetch(`${apiOrigin()}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { "Content-Type": "application/json" } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(30000)
    });
    if (auth.currentUser !== user) throw new Error("Your session changed. Please sign in again.");
    const result = await response.json();
    if (!response.ok) {
        const error = new Error(typeof result.detail === "string" ? result.detail : result.detail?.message || "Administrator access could not be completed. Contact IT.");
        error.code = result.detail?.code || "auth/access-denied";
        throw error;
    }
    return result;
}

function requestActivationCode(submit) {
    return new Promise((resolve, reject) => {
        const dialog = document.createElement("dialog");
        dialog.style.cssText = "max-width:480px;width:92%;padding:24px;border:1px solid #ccc;border-radius:12px";
        const form = document.createElement("form");
        const heading = document.createElement("h2"); heading.textContent = "Activate your IT-provisioned account";
        const explanation = document.createElement("p");
        explanation.textContent = "Enter the single-use activation code delivered privately by IT.";
        const label = document.createElement("label");
        label.textContent = "IT-issued activation code";
        const input = document.createElement("input");
        input.type = "password";
        input.required = true; input.autocomplete = "one-time-code";
        input.pattern = "[A-Za-z0-9_-]{43}";
        input.maxLength = 43;
        input.style.cssText = "display:block;width:100%;margin:8px 0 16px;padding:8px";
        label.append(input);
        const errorBox = document.createElement("p"); errorBox.setAttribute("role", "alert");
        const confirm = document.createElement("button"); confirm.type = "submit"; confirm.textContent = "Verify";
        const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel";
        let busy = false;
        const clear = () => { input.value = ""; dialog.close(); dialog.remove(); };
        const cancelled = () => {
            if (busy) return;
            clear(); reject(new Error("Administrator activation cancelled."));
        };
        cancel.addEventListener("click", cancelled);
        dialog.addEventListener("cancel", event => { event.preventDefault(); cancelled(); });
        form.addEventListener("submit", async event => {
            event.preventDefault();
            if (busy || !form.reportValidity()) return;
            busy = true;
            confirm.disabled = true; cancel.disabled = true; errorBox.textContent = "";
            try {
                const result = await submit(input.value.trim());
                clear(); resolve(result);
            } catch (error) {
                input.value = "";
                errorBox.textContent = error.message || "Activation failed. Contact IT if this continues.";
                busy = false; confirm.disabled = false; cancel.disabled = false; input.focus();
            }
        });
        form.append(heading, explanation);
        form.append(label, errorBox, confirm, cancel); dialog.append(form);
        document.body.append(dialog); dialog.showModal(); input.focus();
    });
}

export async function getAdminSession(user) {
    return (await authRequest(user, "/api/admin/session")).admin;
}

export async function completeAdminAccess(user) {
    try { return await getAdminSession(user); }
    catch (error) {
        if (error.code !== "admin_activation_required") throw error;
        return requestActivationCode(async code => (await authRequest(user, "/api/admin/activate", { code })).admin);
    }
}

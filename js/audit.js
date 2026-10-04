import { db } from "./firebase-config.js";
import {
    collection,
    doc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export function appendAuditEvent(batch, event) {
    const auditRef = doc(collection(db, "auditLogs"));

    batch.set(auditRef, {
        ...event,
        createdAt: serverTimestamp()
    });

    return auditRef.id;
}

import { storage } from './firebase-config.js';
import { 
    ref, 
    uploadBytes, 
    getDownloadURL,
    deleteObject
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

// UPLOAD SINGLE FILE
export async function uploadFile(file, path) {
    try {
        const storageRef = ref(storage, path);
        const snapshot = await uploadBytes(storageRef, file);
        const downloadURL = await getDownloadURL(snapshot.ref);
        return { success: true, url: downloadURL, path: path };
    } catch (error) {
        console.error("Upload error:", error);
        return { success: false, error: error.message };
    }
}

// UPLOAD APPLICATION DOCUMENTS
export async function uploadApplicationDocuments(applicationId, files) {
    try {
        const uploadedFiles = {};
        
        for (const [key, file] of Object.entries(files)) {
            if (file && file instanceof File) {
                const path = `applications/${applicationId}/${key}_${Date.now()}_${file.name}`;
                const result = await uploadFile(file, path);
                if (result.success) {
                    uploadedFiles[key] = result.url;
                }
            }
        }
        
        return { success: true, files: uploadedFiles };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// DELETE FILE
export async function deleteFile(path) {
    try {
        const storageRef = ref(storage, path);
        await deleteObject(storageRef);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// GET FILE URL
export async function getFileUrl(path) {
    try {
        const storageRef = ref(storage, path);
        const url = await getDownloadURL(storageRef);
        return { success: true, url: url };
    } catch (error) {
        return { success: false, error: error.message };
    }
}
// ---------------------------------------------------------------
// Paste your Firebase web config here.
//
// Firebase console → Project settings → General → Your apps → Web app.
// These values are NOT secrets. They ship in every Firebase web app and
// are safe to commit. Your data is protected by firestore.rules, not by
// hiding this file.
//
// Until you replace the placeholders, the whole site runs in DEMO MODE:
// everything works, nothing is shared between visitors.
// ---------------------------------------------------------------

export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID"
};

// Everything lives under this room. Change it to run a second, separate
// window (e.g. "windowsill-test") without touching the first.
export const ROOM = "windowsill";

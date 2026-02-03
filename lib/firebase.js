const admin = require("firebase-admin");

function initFirebase() {
  if (admin.apps.length) return admin;

  const raw = process.env.FIREBASE_CONFIG;
  if (!raw) throw new Error("Missing FIREBASE_CONFIG in env");

  let firebaseConfig;
  try {
    firebaseConfig = JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_CONFIG must be valid JSON string");
  }

  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig),
  });

  return admin;
}

function getDb() {
  return initFirebase().firestore();
}

module.exports = { getDb };

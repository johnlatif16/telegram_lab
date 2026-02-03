// lib/firebase.js
const admin = require("firebase-admin");

function initFirebase() {
  if (admin.apps.length) return admin;

  const raw = process.env.FIREBASE_CONFIG;
  if (!raw) throw new Error("Missing FIREBASE_CONFIG env var");

  let firebaseConfig;
  try {
    firebaseConfig = JSON.parse(raw);
  } catch (e) {
    throw new Error("FIREBASE_CONFIG must be valid JSON string");
  }

  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig),
  });

  return admin;
}

function getDb() {
  const a = initFirebase();
  return a.firestore();
}

module.exports = { getDb };

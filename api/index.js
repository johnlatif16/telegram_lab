// api/index.js
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ✅ static
app.use(express.static(path.join(process.cwd(), "public")));

// ---------- Firebase ----------
function getDb() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_CONFIG;
    if (!raw) throw new Error("Missing FIREBASE_CONFIG");

    const firebaseConfig = JSON.parse(raw);
    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig),
    });
  }
  return admin.firestore();
}

// ---------- JWT helpers ----------
function signToken(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Missing JWT_SECRET");
  return jwt.sign(payload, secret, { expiresIn: "7d" });
}

function verifyToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Missing JWT_SECRET");
  return jwt.verify(token, secret);
}

function authRequired(req, res, next) {
  try {
    const token = req.cookies?.token;
    if (!token) return res.status(401).send("Unauthorized");
    req.user = verifyToken(token);
    next();
  } catch {
    return res.status(401).send("Unauthorized");
  }
}

function normalizePhone(input) {
  return String(input || "").replace(/[^\d]/g, "");
}

// ---------- Telegram sendMessage ----------
async function sendTelegramMessage(chatId, text) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("Missing BOT_TOKEN");

  // Bot API sendMessage
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error("Telegram sendMessage failed: " + err);
  }
  return resp.json();
}

// ---------- Pages ----------
app.get("/", (req, res) => res.redirect("/login"));

app.get("/login", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "login.html"));
});

app.get("/dashboard", authRequired, (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "dashboard.html"));
});

// ---------- Auth API ----------
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;

  const u = process.env.ADMIN_USERNAME;
  const p = process.env.ADMIN_PASSWORD;
  if (!u || !p) return res.status(500).json({ error: "Missing admin env" });

  if (username !== u || password !== p) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = signToken({ role: "admin", username });

const isProd = process.env.NODE_ENV === "production";
res.cookie("token", token, {
  httpOnly: true,
  secure: isProd,
  sameSite: "lax",
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000
});


  return res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie("token", "", { httpOnly: true, secure: isProd, sameSite: "lax", maxAge: 0, path: "/" });
  return res.json({ ok: true });
});

// ---------- Numbers CRUD (JWT protected) ----------
app.get("/api/numbers", authRequired, async (req, res) => {
  const db = getDb();
  const snap = await db.collection("bot_numbers").orderBy("createdAt", "desc").limit(300).get();
  res.json({ items: snap.docs.map((d) => d.data()) });
});

app.post("/api/numbers", authRequired, async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: "Invalid phone" });

  const db = getDb();
  await db.collection("bot_numbers").doc(phone).set({
    phone,
    createdAt: new Date().toISOString(),
  });

  res.json({ ok: true, phone });
});

app.delete("/api/numbers/:phone", authRequired, async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  const db = getDb();
  await db.collection("bot_numbers").doc(phone).delete();
  res.json({ ok: true });
});

// ---------- Manual send (JWT protected) ----------
app.post("/api/send", authRequired, async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const message = String(req.body.message || "").trim();
  if (!phone) return res.status(400).json({ error: "Invalid phone" });
  if (!message) return res.status(400).json({ error: "Message required" });

  const db = getDb();
  const subDoc = await db.collection("telegram_subscribers").doc(phone).get();

  if (!subDoc.exists) {
    return res.status(404).json({
      error: "الرقم لم يراسل البوت بعد، لا يوجد chat_id. لازم صاحب الرقم يفتح البوت ويبعت الرقم مرة واحدة.",
    });
  }

  const { chatId } = subDoc.data();
  if (!chatId) return res.status(404).json({ error: "Missing chatId" });

  await sendTelegramMessage(chatId, message);
  res.json({ ok: true });
});

// ---------- Telegram webhook (public) ----------
app.post("/api/telegram/webhook", async (req, res) => {
  try {
    const update = req.body || {};
    const msg = update.message;
    if (!msg || !msg.text) return res.status(200).json({ ok: true });

    const chatId = msg.chat?.id;
    const text = msg.text;

    const phone = normalizePhone(text);
    if (!phone || phone.length < 7) return res.status(200).json({ ok: true });

    const db = getDb();

    // check if number exists
    const allowed = await db.collection("bot_numbers").doc(phone).get();

    if (allowed.exists) {
      // save chatId mapping for manual sends later
      await db.collection("telegram_subscribers").doc(phone).set(
        { phone, chatId, updatedAt: new Date().toISOString() },
        { merge: true }
      );
      await sendTelegramMessage(chatId, "تم التسجيل ✅");
    } else {
      await sendTelegramMessage(chatId, "هذا الرقم غير مسجل ❌");
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: true });
  }
});

// ✅ مهم: في Vercel لازم نصدّر handler
module.exports = (req, res) => app(req, res);

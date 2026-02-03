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

// static files
app.use(express.static(path.join(process.cwd(), "public")));

// ---------- Firebase ----------
function getDb() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_CONFIG;
    if (!raw) throw new Error("Missing FIREBASE_CONFIG");

    let firebaseConfig;
    try {
      firebaseConfig = JSON.parse(raw);
    } catch {
      throw new Error("FIREBASE_CONFIG must be valid JSON string");
    }

    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig),
    });
  }
  return admin.firestore();
}

// ---------- JWT ----------
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

// ✅ Accept Bearer token OR cookie token
function authRequired(req, res, next) {
  try {
    const cookieToken = req.cookies?.token;

    const auth = req.headers.authorization || "";
    const bearerToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;

    const token = bearerToken || cookieToken;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    req.user = verifyToken(token);
    return next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

function normalizePhone(input) {
  return String(input || "").replace(/[^\d]/g, "");
}

// ---------- Telegram sendMessage ----------
async function sendTelegramMessage(chatId, text) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("Missing BOT_TOKEN");

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

app.get("/dashboard", (req, res) => {
  // حماية الصفحة من غير JWT مش قوية لوحدها (لأنها HTML)
  // بس الـ APIs كلها محمية بـ JWT، فحتى لو فتح الصفحة مش هيقدر يعمل حاجة بدون Token
  res.sendFile(path.join(process.cwd(), "public", "dashboard.html"));
});

// ---------- AUTH API ----------
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};

  const u = process.env.ADMIN_USERNAME;
  const p = process.env.ADMIN_PASSWORD;

  if (!u || !p) return res.status(500).json({ error: "Missing admin env" });

  if (String(username) !== u || String(password) !== p) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = signToken({ role: "admin", username: u });

  // كوكي اختيارية (مش أساسية)
  const isProd = process.env.NODE_ENV === "production";
  res.cookie("token", token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  // ✅ ده المهم
  return res.json({ ok: true, token });
});

app.post("/api/auth/logout", (req, res) => {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie("token", "", {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  return res.json({ ok: true });
});

// ---------- Numbers CRUD (Protected) ----------
// Collection: bot_numbers/{phone}
app.get("/api/numbers", authRequired, async (req, res) => {
  try {
    const db = getDb();
    const snap = await db
      .collection("bot_numbers")
      .orderBy("createdAt", "desc")
      .limit(300)
      .get();

    return res.json({ items: snap.docs.map((d) => d.data()) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error (numbers/get)" });
  }
});

app.post("/api/numbers", authRequired, async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: "Invalid phone" });

    const db = getDb();
    await db.collection("bot_numbers").doc(phone).set({
      phone,
      createdAt: new Date().toISOString(),
    });

    return res.json({ ok: true, phone });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error (numbers/post)" });
  }
});

app.delete("/api/numbers/:phone", authRequired, async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    if (!phone) return res.status(400).json({ error: "Invalid phone" });

    const db = getDb();
    await db.collection("bot_numbers").doc(phone).delete();

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error (numbers/delete)" });
  }
});

// ---------- Manual send (Protected) ----------
// telegram_subscribers/{phone} -> { chatId }
app.post("/api/send", authRequired, async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const message = String(req.body?.message || "").trim();

    if (!phone) return res.status(400).json({ error: "Invalid phone" });
    if (!message) return res.status(400).json({ error: "Message required" });

    const db = getDb();
    const subDoc = await db.collection("telegram_subscribers").doc(phone).get();

    if (!subDoc.exists) {
      return res.status(404).json({
        error:
          "الرقم لم يراسل البوت بعد (لا يوجد chat_id). لازم صاحب الرقم يفتح البوت ويبعت الرقم مرة واحدة.",
      });
    }

    const { chatId } = subDoc.data() || {};
    if (!chatId) return res.status(404).json({ error: "Missing chatId" });

    await sendTelegramMessage(chatId, message);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error (send)" });
  }
});

// ---------- Telegram webhook (Public) ----------
// المستخدم يبعت رقم للبوت -> نتحقق هل موجود في bot_numbers
// لو موجود: نرد تم التسجيل + نخزن chatId في telegram_subscribers
app.post("/api/telegram/webhook", async (req, res) => {
  try {
    const update = req.body || {};
    const msg = update.message;
    if (!msg?.text) return res.status(200).json({ ok: true });

    const chatId = msg.chat?.id;
    const phone = normalizePhone(msg.text);

    if (!phone || phone.length < 7) return res.status(200).json({ ok: true });

    const db = getDb();
    const allowed = await db.collection("bot_numbers").doc(phone).get();

    if (allowed.exists) {
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

module.exports = (req, res) => app(req, res);

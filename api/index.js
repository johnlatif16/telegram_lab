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
app.use(express.static(path.join(process.cwd(), "public")));

// ✅ helper: رجّع error message واضح
function errOut(res, where, e) {
  console.error(`[${where}]`, e);
  return res.status(500).json({
    error: `Server error (${where})`,
    detail: String(e?.message || e),
  });
}

// ---------- Firebase ----------
function getDb() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_CONFIG;
    if (!raw) throw new Error("Missing FIREBASE_CONFIG env var");

    let cfg;
    try {
      cfg = JSON.parse(raw);
    } catch (e) {
      throw new Error("FIREBASE_CONFIG JSON.parse failed: " + e.message);
    }

    // ✅ إصلاح شائع: لو private_key جاية فيها \\n خليه \n
    if (cfg.private_key && typeof cfg.private_key === "string") {
      cfg.private_key = cfg.private_key.replace(/\\n/g, "\n");
    }

    admin.initializeApp({
      credential: admin.credential.cert(cfg),
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

function authRequired(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const bearerToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const cookieToken = req.cookies?.token;

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

// ---------- Telegram ----------
async function sendTelegramMessage(chatId, text) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("Missing BOT_TOKEN env var");

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error("Telegram sendMessage failed: " + t);
  }
  return resp.json();
}

// ---------- Pages ----------
app.get("/", (req, res) => res.redirect("/login"));
app.get("/login", (req, res) =>
  res.sendFile(path.join(process.cwd(), "public", "login.html"))
);
app.get("/dashboard", (req, res) =>
  res.sendFile(path.join(process.cwd(), "public", "dashboard.html"))
);

// ---------- Auth ----------
app.post("/api/auth/login", (req, res) => {
  try {
    const { username, password } = req.body || {};
    const u = process.env.ADMIN_USERNAME;
    const p = process.env.ADMIN_PASSWORD;

    if (!u || !p) return res.status(500).json({ error: "Missing ADMIN env" });

    if (String(username) !== u || String(password) !== p) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = signToken({ role: "admin", username: u });

    const isProd = process.env.NODE_ENV === "production";
    res.cookie("token", token, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({ ok: true, token });
  } catch (e) {
    return errOut(res, "auth/login", e);
  }
});

app.post("/api/auth/logout", (req, res) => {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie("token", "", { httpOnly: true, secure: isProd, sameSite: "lax", maxAge: 0, path: "/" });
  return res.json({ ok: true });
});

// ---------- Numbers (Protected) ----------
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
    return errOut(res, "numbers/post", e);
  }
});

app.get("/api/numbers", authRequired, async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection("bot_numbers").orderBy("createdAt", "desc").limit(300).get();
    return res.json({ items: snap.docs.map((d) => d.data()) });
  } catch (e) {
    return errOut(res, "numbers/get", e);
  }
});

app.delete("/api/numbers/:phone", authRequired, async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const db = getDb();
    await db.collection("bot_numbers").doc(phone).delete();
    return res.json({ ok: true });
  } catch (e) {
    return errOut(res, "numbers/delete", e);
  }
});

// ---------- Manual Send (Protected) ----------
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
        error: "الرقم لم يراسل البوت بعد (لا يوجد chat_id).",
      });
    }

    const { chatId } = subDoc.data() || {};
    if (!chatId) return res.status(404).json({ error: "Missing chatId" });

    await sendTelegramMessage(chatId, message);
    return res.json({ ok: true });
  } catch (e) {
    return errOut(res, "send", e);
  }
});

// ---------- Telegram webhook (Public) ----------
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
    console.error("[telegram/webhook]", e);
    return res.status(200).json({ ok: true });
  }
});

module.exports = (req, res) => app(req, res);

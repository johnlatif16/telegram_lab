const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");

const { getDb } = require("../lib/firebase");
const { sendTelegramMessage } = require("../lib/telegram");
const { signToken, authRequired } = require("../lib/auth");

const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

// static files (html)
app.use("/public", express.static(path.join(process.cwd(), "public")));

// -----------------------------
// صفحات HTML
// -----------------------------
app.get("/", (req, res) => res.redirect("/login"));

app.get("/login", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "login.html"));
});

app.get("/dashboard", authRequired, (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "dashboard.html"));
});

// -----------------------------
// Auth endpoints
// -----------------------------
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;

  const u = process.env.ADMIN_USERNAME;
  const p = process.env.ADMIN_PASSWORD;

  if (!u || !p) return res.status(500).json({ error: "Missing admin env" });

  if (username !== u || password !== p) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = signToken({ role: "admin", username });

  res.cookie("token", token, {
    httpOnly: true,
    secure: true, // على Vercel HTTPS
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });

  return res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  res.cookie("token", "", { httpOnly: true, secure: true, sameSite: "lax", maxAge: 0, path: "/" });
  return res.json({ ok: true });
});

// -----------------------------
// Helpers
// -----------------------------
function normalizePhone(input) {
  return String(input || "").replace(/[^\d]/g, "");
}

// -----------------------------
// Numbers CRUD (Protected)
// Collection: bot_numbers/{phone}
// -----------------------------
app.get("/api/numbers", authRequired, async (req, res) => {
  const db = getDb();
  const snap = await db.collection("bot_numbers").orderBy("createdAt", "desc").limit(200).get();
  const items = snap.docs.map((d) => d.data());
  res.json({ items });
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

// -----------------------------
// Send manual message (Protected)
// Uses telegram_subscribers/{phone} -> { chatId }
// -----------------------------
app.post("/api/send", authRequired, async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const message = String(req.body.message || "").trim();

  if (!phone) return res.status(400).json({ error: "Invalid phone" });
  if (!message) return res.status(400).json({ error: "Message required" });

  const db = getDb();
  const sub = await db.collection("telegram_subscribers").doc(phone).get();

  if (!sub.exists) {
    return res.status(404).json({
      error: "هذا الرقم لم يراسل البوت بعد (لا يوجد chat_id). اطلب منه يفتح البوت ويبعت الرقم مرة واحدة.",
    });
  }

  const { chatId } = sub.data();
  if (!chatId) return res.status(404).json({ error: "Missing chatId" });

  await sendTelegramMessage(chatId, message);
  res.json({ ok: true });
});

// -----------------------------
// Telegram webhook endpoint
// POST /api/telegram/webhook
// -----------------------------
app.post("/api/telegram/webhook", async (req, res) => {
  try {
    const update = req.body || {};
    const msg = update.message;

    if (!msg || !msg.text) return res.status(200).json({ ok: true });

    const chatId = msg.chat?.id;
    const text = msg.text;

    const phone = normalizePhone(text);
    if (!phone || phone.length < 7) {
      // تجاهل أي شيء غير رقم
      return res.status(200).json({ ok: true });
    }

    const db = getDb();

    // هل الرقم مسجل؟
    const allowed = await db.collection("bot_numbers").doc(phone).get();

    if (allowed.exists) {
      // خزّن chat_id لهذا الرقم علشان تبعتله يدويًا لاحقًا
      await db.collection("telegram_subscribers").doc(phone).set(
        { phone, chatId, updatedAt: new Date().toISOString() },
        { merge: true }
      );

      // رد على المستخدم
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

// Vercel handler
module.exports = app;

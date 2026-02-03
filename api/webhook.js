// api/webhook.js
const { Telegraf } = require("telegraf");
const { getDb } = require("../lib/firebase");

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // أي قيمة عشوائية
const ADMIN_TELEGRAM_IDS = (process.env.ADMIN_TELEGRAM_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((x) => Number(x));

if (!BOT_TOKEN) {
  throw new Error("Missing BOT_TOKEN env var");
}

const bot = new Telegraf(BOT_TOKEN);

// ---------- Helpers ----------
function normalizePhone(input) {
  // يخليها أرقام فقط (يشيل + ومسافات وشرطة..)
  const digits = String(input || "").replace(/[^\d]/g, "");
  return digits;
}

function isAdmin(ctx) {
  const id = ctx.from?.id;
  return typeof id === "number" && ADMIN_TELEGRAM_IDS.includes(id);
}

async function ensureAuthorizedWebhook(req) {
  // 1) secret في query: /api/webhook?secret=XXXX
  const secret = req.query?.secret;
  if (!WEBHOOK_SECRET) return true; // لو مش حاطط secret
  return secret === WEBHOOK_SECRET;
}

async function readJsonBody(req) {
  // Vercel أحيانًا بتدي req.body جاهزة، وأحيانًا محتاجين raw
  if (req.body && typeof req.body === "object") return req.body;

  const chunks = [];
  await new Promise((resolve, reject) => {
    req.on("data", (c) => chunks.push(c));
    req.on("end", resolve);
    req.on("error", reject);
  });

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

// ---------- Firestore ops ----------
async function addPhone(phone) {
  const db = getDb();
  await db.collection("bot_numbers").doc(phone).set({
    phone,
    createdAt: new Date().toISOString(),
  });
}

async function deletePhone(phone) {
  const db = getDb();
  await db.collection("bot_numbers").doc(phone).delete();
}

async function phoneExists(phone) {
  const db = getDb();
  const doc = await db.collection("bot_numbers").doc(phone).get();
  return doc.exists;
}

async function listPhones(limit = 50) {
  const db = getDb();
  const snap = await db.collection("bot_numbers").limit(limit).get();
  return snap.docs.map((d) => d.id);
}

// ---------- Bot commands ----------
bot.start(async (ctx) => {
  await ctx.reply(
    "أهلاً 👋\nابعت رقمك (موبايل) للتأكد هل هو مسجل أم لا.\n\nلو أنت أدمن استخدم:\n/add رقم\n/del رقم\n/list"
  );
});

bot.command("add", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("غير مصرح ❌");

  const parts = ctx.message.text.split(" ").slice(1);
  const phone = normalizePhone(parts.join(" "));
  if (!phone) return ctx.reply("اكتب الرقم بعد الأمر: /add 01234567890");

  await addPhone(phone);
  return ctx.reply(`تمت الإضافة ✅\n${phone}`);
});

bot.command("del", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("غير مصرح ❌");

  const parts = ctx.message.text.split(" ").slice(1);
  const phone = normalizePhone(parts.join(" "));
  if (!phone) return ctx.reply("اكتب الرقم بعد الأمر: /del 01234567890");

  await deletePhone(phone);
  return ctx.reply(`تم الحذف ✅\n${phone}`);
});

bot.command("list", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("غير مصرح ❌");

  const phones = await listPhones(50);
  if (!phones.length) return ctx.reply("لا توجد أرقام حالياً.");

  // عرض لطيف
  return ctx.reply("الأرقام (أول 50):\n" + phones.map((p) => `- ${p}`).join("\n"));
});

// أي رسالة نصية: اعتبرها رقم
bot.on("text", async (ctx) => {
  const input = ctx.message.text;
  const phone = normalizePhone(input);

  // لو الرسالة مش رقم (مثلاً كلام) اعتبرها غير مفهومة
  if (!phone || phone.length < 7) {
    return ctx.reply("من فضلك ابعت رقم موبايل صحيح.");
  }

  const exists = await phoneExists(phone);

  if (exists) {
    return ctx.reply("تم التسجيل ✅");
  }
  return ctx.reply("هذا الرقم غير مسجل ❌");
});

// ---------- Vercel handler ----------
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(200).send("OK");
    }

    const ok = await ensureAuthorizedWebhook(req);
    if (!ok) return res.status(401).send("Unauthorized");

    const update = await readJsonBody(req);
    await bot.handleUpdate(update);

    return res.status(200).send("OK");
  } catch (err) {
    console.error(err);
    return res.status(200).send("OK");
  }
};

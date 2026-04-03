const express = require("express");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const { google } = require("googleapis");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const GOOGLE_SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_SA_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
const LINK_SECRET = process.env.TIER_LINK_SECRET;
const RZP_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

const rzp = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const THERAPISTS = {
  "priyanka-varma": {
    name: "Priyanka Varma",
    calendarId: "priyanka@thethoughtco.in",
    availableDays: [1, 2, 3, 4, 5, 6],
    hours: { start: 10, end: 16 },
    tiers: {
      v3: {
        sessions: {
          individual_60: { label: "Individual session", duration: 60, price: 1500 },
          couples_90: { label: "Couples session", duration: 90, price: 2250 },
        },
      },
      v4: {
        sessions: {
          individual_60: { label: "Individual session", duration: 60, price: 2500 },
          couples_90: { label: "Couples session", duration: 90, price: 3750 },
        },
      },
    },
  },
};

const slotLocks = new Map();
const bookings = new Map();
const LOCK_TTL = 15 * 60 * 1000;

async function calendarClient() {
  const auth = new google.auth.JWT(
    GOOGLE_SA_EMAIL, null, GOOGLE_SA_KEY,
    ["https://www.googleapis.com/auth/calendar"]
  );
  return google.calendar({ version: "v3", auth });
}

function isLocked(calId, slot) {
  const k = `${calId}|${slot}`;
  const l = slotLocks.get(k);
  if (!l) return false;
  if (Date.now() - l.lockedAt > LOCK_TTL) { slotLocks.delete(k); return false; }
  return true;
}

function generateLink(therapistId, tier, baseUrl, days = 30) {
  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  const payload = `${therapistId}:${tier}:${exp}`;
  const sig = crypto.createHmac("sha256", LINK_SECRET).update(payload).digest("hex").slice(0, 16);
  return `${baseUrl}/book/${therapistId}?tier=${tier}&exp=${exp}&sig=${sig}`;
}

function verifyLink(therapistId, tier, exp, sig) {
  if (Date.now() / 1000 > parseInt(exp)) return { valid: false, reason: "Link expired" };
  const payload = `${therapistId}:${tier}:${exp}`;
  const expected = crypto.createHmac("sha256", LINK_SECRET).update(payload).digest("hex").slice(0, 16);
  if (expected !== sig) return { valid: false, reason: "Invalid link" };
  return { valid: true };
}

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/admin/generate-link", (req, res) => {
  const { therapistId, tier } = req.query;
  const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;
  const link = generateLink(therapistId, tier, baseUrl);
  res.json({ link });
});

app.get("/book/:therapistId", (req, res) => {
  const { tier, exp, sig } = req.query;
  const { therapistId } = req.params;
  const check = verifyLink(therapistId, tier, exp, sig);
  if (!check.valid) return res.status(403).json({ error: check.reason });
  const t = THERAPISTS[therapistId];
  if (!t) return res.status(404).json({ error: "Therapist not found" });
  const tierData = t.tiers[tier];
  if (!tierData) return res.status(400).json({ error: "Invalid tier" });
  res.json({
    therapistId, name: t.name,
    availableDays: t.availableDays,
    hours: t.hours,
    sessions: tierData.sessions,
  });
});

app.get("/availability", async (req, res) => {
  const { therapistId, sessionKey, date, tier, exp, sig } = req.query;
  const check = verifyLink(therapistId, tier, exp, sig);
  if (!check.valid) return res.status(403).json({ error: check.reason });
  const t = THERAPISTS[therapistId];
  const session = t?.tiers[tier]?.sessions[sessionKey];
  if (!session) return res.status(404).json({ error: "Session not found" });
  try {
    const cal = await calendarClient();
    const dayStart = new Date(`${date}T00:00:00+05:30`);
    const dayEnd = new Date(`${date}T23:59:59+05:30`);
    const fb = await cal.freebusy.query({
      requestBody: { timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(), items: [{ id: t.calendarId }] },
    });
    const busy = fb.data.calendars[t.calendarId]?.busy || [];
    const slots = [];
    const start = new Date(`${date}T${String(t.hours.start).padStart(2,"0")}:00:00+05:30`);
    const end = new Date(`${date}T${String(t.hours.end).padStart(2,"0")}:00:00+05:30`);
    for (let cur = new Date(start); cur < end; cur = new Date(cur.getTime() + 30 * 60000)) {
      const slotEnd = new Date(cur.getTime() + session.duration * 60000);
      if (slotEnd > end) break;
      const iso = cur.toISOString();
      const conflict = busy.some(b => cur < new Date(b.end) && slotEnd > new Date(b.start));
      if (!conflict && !isLocked(t.calendarId, iso)) slots.push(iso);
    }
    res.json({ slots });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Could not fetch availability" });
  }
});

app.post("/create-booking", async (req, res) => {
  const { therapistId, sessionKey, slot, customerName, customerEmail, tier, exp, sig, couponCode } = req.body;
  const check = verifyLink(therapistId, tier, exp, sig);
  if (!check.valid) return res.status(403).json({ error: check.reason });
  const t = THERAPISTS[therapistId];
  const session = t?.tiers[tier]?.sessions[sessionKey];
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (isLocked(t.calendarId, slot)) return res.status(409).json({ error: "Slot just taken — please pick another time." });
  const bookingId = `ttc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  try {
    const cal = await calendarClient();
    const start = new Date(slot);
    const end = new Date(start.getTime() + session.duration * 60000);
    await cal.events.insert({
      calendarId: t.calendarId,
      sendUpdates: "all",
      requestBody: {
        summary: `[${tier.toUpperCase()}] ${customerName} · ${session.label}`,
        description: `Client: ${customerName} (${customerEmail})\nSession: ${session.label}\nTier: ${tier.toUpperCase()} · Fee: ₹${session.price}\nBooking ID: ${bookingId}\nPayment via Razorpay after session.`,
        start: { dateTime: sta

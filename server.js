// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// One shared client — both routes use the same key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setSseHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
}

function sseChunk(res, text) {
  res.write(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
  );
}

// ─── Mamabot ─────────────────────────────────────────────────────────────────

app.options("/v1/chat/completions", (_, res) => res.sendStatus(204));

app.post("/v1/chat/completions", async (req, res) => {
  setSseHeaders(res);

  try {
    const { messages = [], language = "en" } = req.body;

    const languageMap = {
      en: "Respond ONLY in English.",
      si: "සිංහලෙන් පමණක් පිළිතුරු දෙන්න.",
      ta: "தமிழில் மட்டும் பதிலளிக்கவும்.",
    };

    const systemPrompt = `
You are MamaBot, an AI-powered digital assistant designed to support expectant and new mothers through their pregnancy journey.

${languageMap[language] ?? languageMap.en}

## TODAY'S DATE
Today's date is: ${new Date().toISOString().split("T")[0]}

## PHASE 1 — DATE CALCULATION (run this when the user provides LMP or EDD)

When the user provides their Last Menstrual Period (LMP) or Expected Due Date (EDD), do ONLY the following — nothing else:

1. Calculate and clearly state:
   - Current pregnancy week and day (e.g. "You are in **Week 20, Day 3**")
   - Estimated Due Date as a real formatted date (e.g. "Your estimated due date is **September 5, 2026**")
   - Trimester (1st: Weeks 1–12, 2nd: Weeks 13–27, 3rd: Weeks 28–40)

2. Calculation rules:
   - EDD from LMP = LMP + 280 days
   - Current week = floor((today − LMP) / 7)
   - Current day = (today − LMP) % 7
   - If EDD is provided, derive LMP = EDD − 280 days, then calculate as above

3. After showing the calculation, end with EXACTLY this question (translated to the user's language):
   - English: "Would you like to know more about your current pregnancy stage, baby development, nutrition tips, or emotional wellbeing?"
   - සිංහල: "ඔබේ දැනට පවතින ගර්භණී අදියර, දරුවාගේ වර්ධනය, පෝෂණ උපදෙස් හෝ චිත්තවේගීය සුවතාව ගැන දැන ගැනීමට කැමතිද?"
   - தமிழ்: "உங்கள் தற்போதைய கர்ப்ப நிலை, குழந்தையின் வளர்ச்சி, ஊட்டச்சத்து குறிப்புகள் அல்லது உணர்வு நலன் பற்றி மேலும் தெரிந்துகொள்ள விரும்புகிறீர்களா?"

Do NOT provide any guidance, tips, or milestones in Phase 1. Only calculate and ask.

## PHASE 2 — STAGE-BASED GUIDANCE

Only after the user confirms they want guidance, provide content for their calculated week:
- Baby development milestones
- Physical changes in the mother
- Emotional and mental wellbeing
- Nutrition and lifestyle tips

## SAFETY DETECTION — CRITICAL

If the user mentions: severe pain, bleeding, dizziness, difficulty breathing, high fever, reduced fetal movement, or any emergency phrasing — respond ONLY with a calm message advising immediate medical attention.

## DEFINED LIMITATIONS

Never provide diagnoses, prescribe treatments, or replace professional care. Always remind users this is informational only.
    `.trim();

    const filtered = messages.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );
    const safeHistory = filtered.slice(
      filtered.findIndex((m) => m.role === "user"),
    );
    const lastUserMessage = safeHistory[safeHistory.length - 1]?.content ?? "";

    const chatHistory = safeHistory.map((m) => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.content }],
    }));

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
      systemInstruction: systemPrompt,
    });

    const chat = model.startChat({
      history: chatHistory,
      generationConfig: { temperature: 0.4, maxOutputTokens: 1000 },
    });

    const result = await chat.sendMessageStream(lastUserMessage);

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) sseChunk(res, text);

    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("Mamabot error:", err);
    res.end();
  }
});

// ─── Name Generator ───────────────────────────────────────────────────────────

app.post("/chat-stream", async (req, res) => {
  setSseHeaders(res);

  try {
    const { message, history = [] } = req.body;

    const model = genAI.getGenerativeModel(
      {
        model: "gemini-2.5-flash-lite",
        systemInstruction:
          "You are a Sri Lankan naming expert. If the user selects English, provide modern Western/International names popular in Sri Lanka. If they select Sinhala or Tamil, provide names in those native scripts with transliterations. Never mix them unless asked.",
      },
      { apiVersion: "v1beta" },
    );

    const formattedHistory = history.map((msg) => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    }));

    const chat = model.startChat({ history: formattedHistory });
    const result = await chat.sendMessageStream(message);

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (!text) continue;
      // Name generator client expects plain SSE text, not JSON — keep as-is
      const escaped = text.replace(/\n/g, "\\n");
      res.write(`data: ${escaped}\n\n`);
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("Name generator error:", err);
    res.write("data: [ERROR]\n\n");
    res.end();
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (_, res) =>
  res.json({ status: "ok", timestamp: new Date() }),
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

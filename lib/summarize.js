import { openaiChat } from "./router.js";

// Produces a short spoken-friendly summary: one bullet per LinkedIn post,
// or three bullets for a generic page.
export async function summarize(extracted, { apiKey, model }) {
  let instruction, content;
  if (extracted.kind === "linkedin") {
    const n = extracted.posts.length;
    instruction = `Summarize these ${n} LinkedIn posts as exactly ${n} bullets, one per post, in order. Each bullet is one short sentence (max 25 words) naming the author if obvious. Output only lines starting with "- ". No markdown bold.`;
    content = extracted.posts.map((p, i) => `POST ${i + 1}:\n${p}`).join("\n\n");
  } else {
    instruction = `Summarize this web page as exactly 3 bullets, each one short sentence (max 25 words). Output only lines starting with "- ". No markdown bold.`;
    content = `TITLE: ${extracted.title}\n\n${extracted.text}`;
  }
  const data = await openaiChat(
    apiKey,
    {
      model,
      temperature: 0.3,
      messages: [
        { role: "system", content: instruction },
        { role: "user", content },
      ],
    },
    20000
  );
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("The summary came back empty.");
  return text;
}

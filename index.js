export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Discord通知テスト
    // https://あなたのWorkerURL/test-discord
    if (url.pathname === "/test-discord") {
      await sendDiscordWebhook(env, {
        from: "test@example.com",
        to: "mogiten2026@nagito.work",
        subject: "Discord通知テスト",
        summary: "Cloudflare WorkerからDiscord Webhookへの送信テストです。",
      });

      return new Response("Discord test sent", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }

    // Workers AI要約テスト
    // https://あなたのWorkerURL/test-ai
    if (url.pathname === "/test-ai") {
      const summary = await summarizeEmailWithWorkersAI(env, {
        from: "test@example.com",
        to: "mogiten2026@nagito.work",
        subject: "AI要約テスト",
        text: "これはテストメールです。明日の13時までに資料を確認して、問題があれば返信してください。",
      });

      return new Response(summary, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }

    return new Response(
      "Email Summary Discord Worker is running.\nCloudflare Email Routing + Workers AI でメールを要約します。",
      {
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      }
    );
  },

  async email(message, env, ctx) {
    try {
      console.log("Email received");
      console.log("From:", message.from);
      console.log("To:", message.to);
      console.log("Has Discord Secret:", Boolean(env.DISCORD_WEBHOOK_URL));
      console.log("Has AI Binding:", Boolean(env.AI));
      console.log("AI Model:", env.AI_MODEL);

      const rawEmail = await streamToText(message.raw);
      const parsed = parseRawEmail(rawEmail);

      console.log("Subject:", parsed.subject);
      console.log("Text length:", parsed.text.length);

      const summary = await summarizeEmailWithWorkersAI(env, {
        from: message.from,
        to: message.to,
        subject: parsed.subject,
        text: parsed.text,
      });

      await sendDiscordWebhook(env, {
        from: message.from,
        to: message.to,
        subject: parsed.subject,
        summary,
      });

      // 元メールも通常のメールアドレスへ転送したい場合
      // wrangler.toml の [vars] に FORWARD_TO = "your@example.com" を追加
      if (env.FORWARD_TO) {
        await message.forward(env.FORWARD_TO);
      }
    } catch (error) {
      console.error("Email Worker failed:", error);

      try {
        await sendDiscordWebhook(env, {
          from: message.from || "unknown",
          to: message.to || "unknown",
          subject: "メール要約エラー",
          summary:
            "メール処理中にエラーが発生しました。\n\n" +
            String(error && error.message ? error.message : error),
        });
      } catch (discordError) {
        console.error("Failed to notify Discord:", discordError);
      }

      // 基本は受信拒否しない
      // message.setReject("Failed to process email");
    }
  },
};

async function streamToText(stream) {
  const response = new Response(stream);
  return await response.text();
}

function parseRawEmail(raw) {
  const splitIndex = raw.search(/\r?\n\r?\n/);

  let rawHeaders = "";
  let rawBody = "";

  if (splitIndex === -1) {
    rawHeaders = raw;
    rawBody = "";
  } else {
    rawHeaders = raw.slice(0, splitIndex);
    rawBody = raw.slice(splitIndex).replace(/^\r?\n\r?\n/, "");
  }

  const headers = parseHeaders(rawHeaders);

  const subject = decodeMimeHeader(headers["subject"] || "(件名なし)");
  const contentType = headers["content-type"] || "";

  let text = "";

  if (contentType.toLowerCase().includes("multipart/")) {
    text = extractMultipartText(rawBody, contentType);
  } else if (contentType.toLowerCase().includes("text/html")) {
    text = stripHtml(decodeBody(rawBody, headers));
  } else {
    text = decodeBody(rawBody, headers);
  }

  return {
    subject,
    text: cleanText(text),
  };
}

function parseHeaders(rawHeaders) {
  const lines = rawHeaders.split(/\r?\n/);
  const unfolded = [];

  for (const line of lines) {
    if (/^\s/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += " " + line.trim();
    } else {
      unfolded.push(line);
    }
  }

  const headers = {};

  for (const line of unfolded) {
    const index = line.indexOf(":");
    if (index === -1) continue;

    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();

    headers[key] = value;
  }

  return headers;
}

function extractMultipartText(body, contentType) {
  const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);

  if (!boundaryMatch) {
    return body;
  }

  const boundary = boundaryMatch[1];
  const parts = body.split(`--${boundary}`);

  let plainText = "";
  let htmlText = "";

  for (const part of parts) {
    const trimmed = part.trim();

    if (!trimmed || trimmed === "--") {
      continue;
    }

    const splitIndex = trimmed.search(/\r?\n\r?\n/);

    if (splitIndex === -1) {
      continue;
    }

    const partHeadersRaw = trimmed.slice(0, splitIndex);
    const partBody = trimmed.slice(splitIndex).replace(/^\r?\n\r?\n/, "");

    const partHeaders = parseHeaders(partHeadersRaw);
    const partContentType = (partHeaders["content-type"] || "").toLowerCase();

    if (partContentType.includes("multipart/")) {
      const nestedText = extractMultipartText(
        partBody,
        partHeaders["content-type"] || ""
      );

      if (nestedText) {
        plainText += "\n\n" + nestedText;
      }

      continue;
    }

    if (partContentType.includes("text/plain")) {
      plainText += "\n\n" + decodeBody(partBody, partHeaders);
    } else if (partContentType.includes("text/html")) {
      htmlText += "\n\n" + stripHtml(decodeBody(partBody, partHeaders));
    }
  }

  return plainText.trim() || htmlText.trim() || body;
}

function decodeBody(body, headers) {
  const encoding = (headers["content-transfer-encoding"] || "").toLowerCase();

  if (encoding.includes("base64")) {
    return decodeBase64(body);
  }

  if (encoding.includes("quoted-printable")) {
    return decodeQuotedPrintable(body);
  }

  return body;
}

function decodeBase64(input) {
  const normalized = String(input || "").replace(/\s/g, "");

  try {
    const binary = atob(normalized);
    const bytes = stringToBytes(binary);
    return new TextDecoder("utf-8").decode(bytes);
  } catch (error) {
    console.error("Base64 decode failed:", error);
    return input;
  }
}

function decodeQuotedPrintable(input) {
  try {
    const withoutSoftBreaks = String(input || "").replace(/=\r?\n/g, "");

    const decoded = withoutSoftBreaks.replace(
      /=([A-Fa-f0-9]{2})/g,
      function (_match, hex) {
        return String.fromCharCode(parseInt(hex, 16));
      }
    );

    const bytes = stringToBytes(decoded);
    return new TextDecoder("utf-8").decode(bytes);
  } catch (error) {
    console.error("Quoted-printable decode failed:", error);
    return input;
  }
}

function decodeMimeHeader(header) {
  return String(header || "").replace(
    /=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g,
    function (_match, charset, encoding, encodedText) {
      try {
        charset = normalizeCharset(charset);

        if (encoding.toUpperCase() === "B") {
          const binary = atob(encodedText);
          const bytes = stringToBytes(binary);
          return new TextDecoder(charset).decode(bytes);
        }

        const qp = encodedText
          .replace(/_/g, " ")
          .replace(/=([A-Fa-f0-9]{2})/g, function (_m, hex) {
            return String.fromCharCode(parseInt(hex, 16));
          });

        const bytes = stringToBytes(qp);
        return new TextDecoder(charset).decode(bytes);
      } catch (error) {
        console.error("MIME header decode failed:", error);
        return header;
      }
    }
  );
}

function normalizeCharset(charset) {
  const lower = String(charset || "utf-8").toLowerCase();

  if (lower === "utf8") {
    return "utf-8";
  }

  if (lower === "shift_jis" || lower === "sjis") {
    return "shift_jis";
  }

  if (lower === "iso-2022-jp") {
    return "iso-2022-jp";
  }

  return lower;
}

function stringToBytes(str) {
  return new Uint8Array(
    Array.from(String(str || ""), function (c) {
      return c.charCodeAt(0);
    })
  );
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, 7000);
}

async function summarizeEmailWithWorkersAI(env, mail) {
  if (!env.AI) {
    throw new Error(
      "Workers AI binding がありません。Binding name を AI にしてください。"
    );
  }

  const input = `
以下の受信メールを日本語で要約してください。

【絶対に守るルール】
- 出力は日本語のみ
- 英語を出力しない
- 推論過程を出力しない
- 分析手順を出力しない
- 下書きを出力しない
- "Input Email"、"Analyze"、"Drafting"、"Key Information" のような英語見出しを出力しない
- 最終結果だけを出力する
- 箇条書きで簡潔にまとめる

【出力形式】
- 概要:
- 重要度:
- 対応が必要か:
- 期限・日時:
- 返信が必要な場合の返信方針:
- 注意点:

【メール情報】
From: ${mail.from}
To: ${mail.to}
Subject: ${mail.subject}

【本文】
${mail.text || "(本文なし)"}
`.trim();

  const model = env.AI_MODEL || "@cf/openai/gpt-oss-120b";

  const result = await env.AI.run(model, {
    instructions:
      "あなたは日本語専用のメール要約アシスタントです。必ず日本語だけで、最終回答のみを出力してください。英語、推論過程、分析、下書き、内部メモは絶対に出力しないでください。",
    input,
    max_output_tokens: 700,
    temperature: 0.1,
  });

  console.log("Workers AI raw result:", JSON.stringify(result));

  const summary = extractAiText(result);

  if (!summary) {
    return (
      "要約の取得に失敗しました。\n\n" +
      "Workers AIの返却値:\n```json\n" +
      truncate(JSON.stringify(result, null, 2), 1500) +
      "\n```"
    );
  }

  return cleanupSummary(summary);
}

function extractAiText(result) {
  if (!result) return "";

  if (typeof result === "string") {
    return result.trim();
  }

  const candidates = [
    result.output_text,
    result.response,
    result.text,
    result.result?.output_text,
    result.result?.response,
    result.result?.text,
    result.choices?.[0]?.message?.content,
    result.choices?.[0]?.text,
    result.result?.choices?.[0]?.message?.content,
    result.result?.choices?.[0]?.text,
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  try {
    if (Array.isArray(result.output)) {
      const text = result.output
        .flatMap(function (item) {
          return item.content || [];
        })
        .map(function (content) {
          return content.text || content.content || "";
        })
        .join("\n")
        .trim();

      if (text) return text;
    }
  } catch (_error) {}

  try {
    if (Array.isArray(result.result?.output)) {
      const text = result.result.output
        .flatMap(function (item) {
          return item.content || [];
        })
        .map(function (content) {
          return content.text || content.content || "";
        })
        .join("\n")
        .trim();

      if (text) return text;
    }
  } catch (_error) {}

  return "";
}

function cleanupSummary(text) {
  let value = String(text || "").trim();

  // 余計なコードブロックを除去
  value = value
    .replace(/^```[a-zA-Z]*\n?/g, "")
    .replace(/```$/g, "")
    .trim();

  // 日本語の要約開始位置だけ残す
  const startMarkers = [
    "- 概要:",
    "概要:",
    "【出力】",
    "以下が要約です",
    "要約:",
  ];

  for (const marker of startMarkers) {
    const index = value.indexOf(marker);
    if (index !== -1) {
      value = value.slice(index).trim();
      break;
    }
  }

  // 英語の分析文が混ざった場合は、その直前までで切る
  const badMarkers = [
    "Input Email:",
    "Analyze the Input Email",
    "Analyze",
    "Determine the Summary",
    "Drafting",
    "Internal Monologue",
    "Key Information:",
    "Sender:",
    "Recipient:",
    "Subject:",
    "Output:",
    "Final:",
    "The email",
    "This email",
  ];

  for (const marker of badMarkers) {
    const index = value.indexOf(marker);
    if (index !== -1) {
      value = value.slice(0, index).trim();
    }
  }

  // 形式だけ出て中身が空の場合
  const onlyTemplate =
    value.includes("概要:") &&
    value.includes("重要度:") &&
    value.includes("対応が必要か:") &&
    value.length < 80;

  if (!value.includes("概要") || onlyTemplate) {
    value =
      "- 概要: メール内容の要約に失敗しました。\n" +
      "- 重要度: 不明\n" +
      "- 対応が必要か: 不明\n" +
      "- 期限・日時: 不明\n" +
      "- 返信が必要な場合の返信方針: 不明\n" +
      "- 注意点: AIの出力形式が想定と異なりました。";
  }

  return value.slice(0, 3900);
}

async function sendDiscordWebhook(env, data) {
  if (!env.DISCORD_WEBHOOK_URL) {
    throw new Error("DISCORD_WEBHOOK_URL が設定されていません。");
  }

  // シンプルなフィールド抽出（単一行形式を優先）
  function extractFieldLines(summary, keyVariants) {
    if (!summary) return "";
    const lines = summary.split(/\r?\n/).map(l => l.trim());
    for (const line of lines) {
      for (const key of keyVariants) {
        const m = line.match(new RegExp(`^-?\\s*${key}\\s*:\\s*(.+)$`, "i"));
        if (m) return m[1].trim();
      }
    }
    return "";
  }

  const fullSummary = String(data.summary || "要約なし").trim();
  const shortSummary = fullSummary.split(/\r?\n/)[0] || truncate(fullSummary, 200);

  // 抽出キー（複数バリエーション対応）
  const keys = {
    "概要": ["概要"],
    "重要度": ["重要度"],
    "対応が必要か": ["対応が必要か", "対応が必要"],
    "期限・日時": ["期限・日時", "期限"],
    "返信方針": ["返信が必要な場合の返信方針", "返信方針"],
    "注意点": ["注意点"]
  };

  const sections = {};
  for (const k of Object.keys(keys)) {
    sections[k] = extractFieldLines(fullSummary, keys[k]) || "";
  }

  // description が "概要" と重複しないように調整
  const description = sections["概要"]
    ? truncate(data.subject || shortSummary || "(要約なし)", 1024)
    : truncate(shortSummary || "(要約なし)", 1024);
  
  const embed = {
    title: truncate(data.subject || "(件名なし)", 250),
    description: description,
    color: 0x5865f2,
    fields: [],
    timestamp: new Date().toISOString(),
    footer: { text: "Email Summary · Cloudflare Worker" },
  };

  // 順序を保ってフィールド追加（空でなければ追加）
  if (sections["概要"]) {
    embed.fields.push({ name: "概要（要点）", value: truncate(sections["概要"], 1024), inline: false });
  }
  if (sections["重要度"]) {
    embed.fields.push({ name: "重要度", value: truncate(sections["重要度"], 250), inline: true });
  }
  if (sections["対応が必要か"]) {
    embed.fields.push({ name: "対応が必要か", value: truncate(sections["対応が必要か"], 250), inline: true });
  }
  if (sections["期限・日時"]) {
    embed.fields.push({ name: "期限・日時", value: truncate(sections["期限・日時"], 250), inline: true });
  }
  if (sections["返信方針"]) {
    embed.fields.push({ name: "返信方針", value: truncate(sections["返信方針"], 600), inline: false });
  }
  if (sections["注意点"]) {
    embed.fields.push({ name: "注意点", value: truncate(sections["注意点"], 800), inline: false });
  }

  // 常に表示する送り元（最後に）
  embed.fields.push({
    name: "From",
    value: truncate(data.from || "不明", 1000) || "不明",
    inline: false,
  });

  const payload = {
    content: "📩 **新着メールを要約しました**",
    embeds: [embed],
    allowed_mentions: { parse: [] },
  };

  const response = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discord Webhook error: ${response.status} ${errorText}`);
  }
}

function truncate(text, max) {
  const value = String(text || "");

  if (value.length <= max) {
    return value;
  }

  return value.slice(0, max - 3) + "...";
}
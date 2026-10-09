// TrackFyp Backend
// -----------------------------------------------
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const multer = require("multer");
const ffmpegPath = require("ffmpeg-static");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 50 * 1024 * 1024 } });

const PORT = process.env.PORT || 3000;

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
    : null;

const SAFEPAY_PLANS = {
  basic_pkr: "plan_5737def5-02dc-4d37-8569-05bbca09bb63",
  unlimited_pkr: "plan_6ee81df9-8790-4d77-9e8e-099e701574a0",
  basic_usd: "plan_d48cd495-4be1-4359-adc6-ef10c1c080f9",
  unlimited_usd: "plan_0be661f5-72b3-45f6-ac41-a06ec364fdc4",
};

const PLAN_PRICES = {
  basic_pkr: { amount: 299, currency: "PKR" },
  unlimited_pkr: { amount: 499, currency: "PKR" },
  basic_usd: { amount: 2.99, currency: "USD" },
  unlimited_usd: { amount: 4.99, currency: "USD" },
};

const SAFEPAY_BASE_URL = "https://sandbox.api.getsafepay.com";

app.get("/", (req, res) => {
  res.json({ status: "TrackFyp backend is running" });
});

function normalizeUrl(url) {
  if (!url) return url;
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }
  return url;
}

async function fetchTikTokOembed(url) {
  const response = await axios.get("https://www.tiktok.com/oembed", {
    params: { url },
    headers: { "User-Agent": "Mozilla/5.0 (compatible; TrackFyp/1.0)" },
    timeout: 20000,
  });
  return response.data || {};
}

async function fetchTikTokPage(url) {
  const response = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      Referer: "https://www.tiktok.com/",
    },
    maxRedirects: 5,
    timeout: 20000,
  });
  return response.data;
}

function extractJsonScript(html, ids) {
  for (const id of ids) {
    const re = new RegExp('<script[^>]+id=["\\\']' + id + '["\\\'][^>]*>([\\s\\S]*?)<\\/script>', 'i');
    const m = html.match(re);
    if (m) {
      try { return JSON.parse(m[1]); } catch (_) {}
    }
  }
  return null;
}

async function resolveTikTokUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "vt.tiktok.com" || host === "vm.tiktok.com") {
      const response = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, maxRedirects: 5, timeout: 15000 });
      return response.request?.res?.responseUrl || url;
    }
  } catch (err) {
    console.error("TikTok short-link resolve failed:", err.message);
  }
  return url;
}

function getTikTokHandle(profileUrl) {
  try {
    const u = new URL(profileUrl);
    const match = u.pathname.match(/\/@([^/?]+)/);
    return match ? match[1] : "";
  } catch (_) {
    return "";
  }
}

async function fetchScrapeCreatorsProfile(profileUrl) {
  const apiKey = process.env.SCRAPECREATORS_API_KEY;
  const handle = getTikTokHandle(profileUrl);
  if (!apiKey || !handle) return null;
  const response = await axios.get("https://api.scrapecreators.com/v1/tiktok/profile", {
    params: { handle },
    headers: { "x-api-key": apiKey, Accept: "application/json" },
    timeout: 25000,
  });
  const data = response.data || {};
  if (!data.user && !data.stats) throw new Error("ScrapeCreators profile response missing user/stats");
  return { ...data, __scrapeCreators: true };
}

async function fetchScrapeCreatorsVideo(videoUrl) {
  const apiKey = process.env.SCRAPECREATORS_API_KEY;
  if (!apiKey) return null;
  const response = await axios.get("https://api.scrapecreators.com/v2/tiktok/video", {
    params: { url: videoUrl },
    headers: { "x-api-key": apiKey, Accept: "application/json" },
    timeout: 30000,
  });
  const data = response.data || {};
  const detail = data.aweme_detail || data.itemInfo?.itemStruct || data.item || null;
  if (!detail) throw new Error("ScrapeCreators video response missing aweme_detail");
  const st = detail.statistics || detail.stats || {};
  const v = detail.video || {};
  const author = detail.author || {};
  const firstUrl = (x) => Array.isArray(x) ? x[0] : x;
  return {
    ...detail,
    __scrapeCreators: true,
    desc: detail.desc || detail.title || "",
    author: { ...author, uniqueId: author.uniqueId || author.unique_id || author.username || "" },
    authorName: author.nickname || author.nickName || author.name || "",
    stats: {
      playCount: Number(st.play_count ?? st.playCount ?? 0),
      diggCount: Number(st.digg_count ?? st.diggCount ?? st.like_count ?? 0),
      commentCount: Number(st.comment_count ?? st.commentCount ?? 0),
      shareCount: Number(st.share_count ?? st.shareCount ?? 0),
    },
    video: {
      ...v,
      duration: Number(v.duration ?? detail.duration ?? 0),
      playAddr: firstUrl(v.download_no_watermark_addr?.url_list) || firstUrl(v.play_addr?.url_list) || v.playAddr || "",
      downloadAddr: firstUrl(v.download_addr?.url_list) || v.downloadAddr || "",
    },
  };
}

async function fetchTikTokItem(videoUrl) {
  const resolvedUrl = await resolveTikTokUrl(videoUrl);
  if (process.env.SCRAPECREATORS_API_KEY) {
    try {
      const providerItem = await fetchScrapeCreatorsVideo(resolvedUrl);
      if (providerItem) return providerItem;
    } catch (err) {
      console.error("ScrapeCreators video API failed; trying TikTok public page:", err.response?.status || err.message);
    }
  }
  try {
    const html = await fetchTikTokPage(resolvedUrl);
    const jsonData = extractJsonScript(html, [
      "__UNIVERSAL_DATA_FOR_REHYDRATION__",
      "SIGI_STATE",
      "__NEXT_DATA__",
    ]);
    const item =
      jsonData?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct ||
      jsonData?.ItemModule && Object.values(jsonData.ItemModule)[0] ||
      jsonData?.props?.pageProps?.itemInfo?.itemStruct;
    if (item) return item;
  } catch (err) {
    console.error("TikTok page fetch failed:", err.message);
  }

  // TikTok officially exposes oEmbed metadata. It does not expose download URLs,
  // but it gives us reliable public title/creator information for analysis.
  const o = await fetchTikTokOembed(resolvedUrl);
  if (!o || (!o.title && !o.author_name)) throw new Error("NO_VIDEO_DATA");
  return {
    __oembed: true,
    desc: o.title || "",
    author: { uniqueId: (o.author_url || "").split("/@")[1]?.split("/")[0] || "" },
    authorName: o.author_name || "",
    video: {},
    stats: {},
  };
}

async function fetchTikTokProfile(profileUrl) {
  const resolvedUrl = await resolveTikTokUrl(profileUrl);
  try {
    const html = await fetchTikTokPage(resolvedUrl);
    const jsonData = extractJsonScript(html, [
      "__UNIVERSAL_DATA_FOR_REHYDRATION__",
      "SIGI_STATE",
      "__NEXT_DATA__",
    ]);
    let userInfo = jsonData?.__DEFAULT_SCOPE__?.["webapp.user-detail"]?.userInfo || null;
    if (!userInfo && jsonData?.UserModule?.users) {
      const username = Object.keys(jsonData.UserModule.users)[0];
      if (username) {
        userInfo = {
          user: jsonData.UserModule.users[username],
          stats: jsonData.UserModule.stats?.[username] || {},
        };
      }
    }
    if (userInfo) return userInfo;
  } catch (err) {
    console.error("TikTok profile fetch failed:", err.message);
  }

  const o = await fetchTikTokOembed(resolvedUrl);
  if (!o || (!o.author_name && !o.title)) throw new Error("NO_PROFILE_DATA");
  const username = (o.author_url || profileUrl).match(/tiktok\.com\/@([^/?]+)/i)?.[1] || "";
  return {
    __oembed: true,
    user: { uniqueId: username, nickname: o.author_name || "" },
    stats: {},
  };
}

app.get("/api/download", async (req, res) => {
  const videoUrl = normalizeUrl(req.query.url);
  if (!videoUrl || !videoUrl.includes("tiktok.com")) {
    return res.status(400).json({ error: "Sahi TikTok video link daalein." });
  }
  try {
    const item = await fetchTikTokItem(videoUrl);
    const noWatermarkUrl = item.video?.playAddr || item.video?.downloadAddr;
    if (!noWatermarkUrl) {
      return res.status(500).json({ error: "Download link nahi mila." });
    }
    res.json({
      success: true,
      downloadUrl: noWatermarkUrl,
      caption: item.desc || "",
      author: item.author?.uniqueId || "",
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({
      error: "Video process karne mein masla hua. Link check karein ya thodi der baad try karein.",
    });
  }
});

app.get("/api/analyze", async (req, res) => {
  const videoUrl = normalizeUrl(req.query.url);
  if (!videoUrl || !videoUrl.includes("tiktok.com")) {
    return res.status(400).json({ error: "Sahi TikTok video link daalein." });
  }
  try {
    const item = await fetchTikTokItem(videoUrl);

    const stats = item.stats || {};
    const views = Number(stats.playCount || 0);
    const likes = Number(stats.diggCount || 0);
    const comments = Number(stats.commentCount || 0);
    const shares = Number(stats.shareCount || 0);
    const caption = item.desc || "";
    const durationSec = Number(item.video?.duration || 0);
    const hashtagCount = (caption.match(/#/g) || []).length;
    const genericTags = ["fyp", "viral", "foryou", "foryoupage"];
    const hasOnlyGeneric =
      hashtagCount > 0 &&
      genericTags.some((t) => caption.toLowerCase().includes("#" + t)) &&
      hashtagCount <= 2;

    const engagementRate = views > 0 ? ((likes + comments + shares) / views) * 100 : 0;

    const diagnosis = [];
    if (engagementRate < 3) {
      diagnosis.push({ type: "bad", text: "Engagement rate kam hai (" + engagementRate.toFixed(1) + "%). Caption mein clear call-to-action add karein." });
    } else if (engagementRate < 6) {
      diagnosis.push({ type: "warn", text: "Engagement rate theek hai (" + engagementRate.toFixed(1) + "%), lekin behtar ho sakta hai." });
    } else {
      diagnosis.push({ type: "good", text: "Engagement rate achi hai (" + engagementRate.toFixed(1) + "%)." });
    }

    if (durationSec > 0 && durationSec > 60) {
      diagnosis.push({ type: "warn", text: "Video " + durationSec + " second ki hai — 15-45 second wali videos generally behtar retention paati hain." });
    } else if (durationSec > 0) {
      diagnosis.push({ type: "good", text: "Video length (" + durationSec + "s) achi range mein hai." });
    }

    if (hashtagCount === 0) {
      diagnosis.push({ type: "bad", text: "Koi hashtag nahi mila. Hashtag Generator se 3-5 add karein." });
    } else if (hasOnlyGeneric) {
      diagnosis.push({ type: "warn", text: "Sirf generic hashtags (#fyp #viral) use huye hain — niche-specific bhi add karein." });
    } else {
      diagnosis.push({ type: "good", text: "Hashtags ka mix theek lag raha hai." });
    }

    if (caption.replace(/#\S+/g, "").trim().length < 10) {
      diagnosis.push({ type: "warn", text: "Caption bohot chota hai — thora context add karein." });
    }

    let score = 50;
    score += Math.min(engagementRate * 4, 30);
    if (!hasOnlyGeneric && hashtagCount > 0) score += 10;
    if (durationSec > 0 && durationSec <= 45) score += 10;
    score = Math.max(0, Math.min(100, Math.round(score)));

    const title = item.authorName ? `${item.authorName}: ${caption}` : caption;
    res.json({
      success: true,
      source: item.__oembed ? "TikTok oEmbed" : "TikTok public page",
      score,
      title,
      views,
      likes,
      comments,
      shares,
      engagementRate: Number(engagementRate.toFixed(2)),
      durationSec,
      diagnosis,
    });
  } catch (err) {
    console.error(err.message);
    if (err.message === "NO_ITEM_DATA") {
      return res.status(400).json({
        error: "Ye video link nahi lag raha — agar ye profile/channel link hai to 'Channel' tab use karein.",
      });
    }
    res.status(500).json({
      error: "Analysis mein masla hua. Link check karein ya thodi der baad try karein.",
    });
  }
});

// ---- /api/download-file?url=<tiktok video link> ----
// Video ko seedha browser se TikTok CDN se khulwane ki bajaye, backend khud
// fetch karke stream kar deta hai — isse TikTok ka "Access Denied" nahi aata.
app.get("/api/download-file", async (req, res) => {
  const videoUrl = normalizeUrl(req.query.url);
  if (!videoUrl || !videoUrl.includes("tiktok.com")) {
    return res.status(400).send("Sahi TikTok video link daalein.");
  }
  try {
    const item = await fetchTikTokItem(videoUrl);
    const noWatermarkUrl = item.video?.playAddr || item.video?.downloadAddr;
    if (!noWatermarkUrl) return res.status(500).send("Download link nahi mila.");

    const videoStream = await axios.get(noWatermarkUrl, {
      responseType: "stream",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Referer: "https://www.tiktok.com/",
      },
    });

    res.setHeader("Content-Disposition", 'attachment; filename="trackfyp-video.mp4"');
    res.setHeader("Content-Type", "video/mp4");
    videoStream.data.pipe(res);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Video download mein masla hua.");
  }
});

app.get("/api/channel-analyze", async (req, res) => {
  const profileUrl = normalizeUrl(req.query.url);
  if (!profileUrl || !profileUrl.includes("tiktok.com/@")) {
    return res.status(400).json({ error: "Sahi TikTok profile link daalein (jaise tiktok.com/@username)." });
  }
  try {
    let userInfo = null;
    if (process.env.SCRAPECREATORS_API_KEY) {
      try {
        userInfo = await fetchScrapeCreatorsProfile(profileUrl);
      } catch (err) {
        console.error("ScrapeCreators profile API failed; trying TikTok public page:", err.response?.status || err.message);
      }
    }
    if (!userInfo) userInfo = await fetchTikTokProfile(profileUrl);
    const stats = userInfo.stats || userInfo.statsV2 || {};
    const followerCount = Number(stats.followerCount) || 0;
    const followingCount = Number(stats.followingCount) || 0;
    const heartCount = Number(stats.heartCount || stats.heart) || 0;
    const videoCount = Number(stats.videoCount) || 0;

    const avgLikesPerVideo = videoCount > 0 ? Math.round(heartCount / videoCount) : 0;

    const diagnosis = [];
    if (userInfo.__oembed && !videoCount) {
      diagnosis.push({ type: "warn", text: "TikTok ne is public profile ke detailed stats expose nahi kiye. Basic profile information mil gayi hai; detailed stats ke liye TikTok authorization/API access chahiye." });
    } else if (videoCount < 10) {
      diagnosis.push({ type: "warn", text: "Abhi sirf " + videoCount + " videos hain — consistent posting se growth tez ho sakti hai." });
    } else {
      diagnosis.push({ type: "good", text: videoCount + " videos post ki ja chuki hain — achi consistency ka sign hai." });
    }

    if (followerCount > 1000 && avgLikesPerVideo < followerCount * 0.02) {
      diagnosis.push({ type: "bad", text: "Followers ke muqable average likes kam hain — ho sakta hai followers inactive hon ya content unke interest se match na kare." });
    } else if (avgLikesPerVideo > 0) {
      diagnosis.push({ type: "good", text: "Average " + avgLikesPerVideo + " likes per video — followers active lagte hain." });
    }

    if (followingCount > followerCount && followerCount < 1000) {
      diagnosis.push({ type: "warn", text: "Following count, followers se zyada hai — organic growth par focus karein." });
    }

    const user = userInfo.user || userInfo.userInfo || {};
    res.json({
      success: true,
      source: userInfo.__scrapeCreators ? "ScrapeCreators API" : (userInfo.__oembed ? "TikTok oEmbed" : "TikTok public page"),
      username: user.uniqueId || user.unique_id || "",
      name: user.nickname || user.nickName || userInfo.authorName || "",
      followerCount,
      followingCount,
      heartCount,
      videoCount,
      avgLikesPerVideo,
      diagnosis,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({
      error: "Channel analysis mein masla hua. Link check karein ya thodi der baad try karein.",
    });
  }
});

const COUNTRY_MAP = { pk: "PK", in: "IN", ae: "AE", us: "US", uk: "GB", global: "" };
app.get("/api/trending", async (req, res) => {
  const country = COUNTRY_MAP[req.query.country] ?? "";
  try {
    const response = await axios.get(
      "https://ads.tiktok.com/creative_radar_api/v1/popular_trend/hashtag/list",
      {
        params: { page: 1, limit: 10, period: 7, country_code: country, sort_by: "popular" },
        headers: { "User-Agent": "Mozilla/5.0" },
      }
    );
    const list = response.data?.data?.list || [];
    res.json({
      success: true,
      trends: list.map((t) => ({ hashtag: t.hashtag_name, posts: t.video_views || t.publish_cnt || null })),
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({
      error: "Trending data abhi fetch nahi ho saka — TikTok ne format badla ho sakta hai. Thodi der baad try karein.",
    });
  }
});

// ---- /api/shadowban-check?url=<tiktok profile link> ----
// Honest note: ye TikTok ka real internal "shadowban status" nahi de sakta
// (koi bhi website ye nahi de sakti). Ye sirf current public engagement
// ratios se ek estimate banata hai.
app.get("/api/shadowban-check", async (req, res) => {
  const profileUrl = normalizeUrl(req.query.url);
  if (!profileUrl || !profileUrl.includes("tiktok.com/@")) {
    return res.status(400).json({ error: "Sahi TikTok profile link daalein." });
  }
  try {
    let userInfo = null;
    if (process.env.SCRAPECREATORS_API_KEY) {
      try {
        userInfo = await fetchScrapeCreatorsProfile(profileUrl);
      } catch (err) {
        console.error("ScrapeCreators shadowban profile API failed; trying TikTok public page:", err.response?.status || err.message);
      }
    }
    if (!userInfo) userInfo = await fetchTikTokProfile(profileUrl);
    const stats = userInfo.stats || userInfo.statsV2 || {};
    const followerCount = Number(stats.followerCount) || 0;
    const heartCount = Number(stats.heartCount || stats.heart) || 0;
    const videoCount = Number(stats.videoCount) || 0;
    if (userInfo.__oembed && !followerCount && !videoCount) {
      return res.json({ success: true, riskLevel: "Not enough public data", riskReason: "TikTok ne is profile ke public stats expose nahi kiye, is liye reliable shadowban estimate nahi diya ja sakta.", followerCount: 0, avgLikesPerVideo: 0, videoCount: 0 });
    }
    const avgLikesPerVideo = videoCount > 0 ? heartCount / videoCount : 0;
    const likeRatio = followerCount > 0 ? avgLikesPerVideo / followerCount : 0;

    let riskLevel, riskReason;
    if (followerCount < 50) {
      riskLevel = "Low Risk";
      riskReason = "Account chhota hai — abhi reliable estimate ke liye kaafi data nahi.";
    } else if (likeRatio < 0.01) {
      riskLevel = "High Risk";
      riskReason = "Followers ke muqable average likes bohot kam hain — reach suppression ya inactive followers ka sign ho sakta hai.";
    } else if (likeRatio < 0.03) {
      riskLevel = "Medium Risk";
      riskReason = "Engagement ratio normal se thora kam hai — content/posting consistency par dhyan dein.";
    } else {
      riskLevel = "Low Risk";
      riskReason = "Engagement ratio healthy hai — koi suppression ka clear sign nahi mila.";
    }

    res.json({
      success: true,
      riskLevel,
      riskReason,
      followerCount,
      avgLikesPerVideo: Math.round(avgLikesPerVideo),
      videoCount,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({
      error: "Check karne mein masla hua. Link verify karein ya thodi der baad try karein.",
    });
  }
});

async function isActiveSubscriber(email) {
  if (!email) return false;
  if (process.env.ADMIN_EMAIL && email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase()) {
    return true;
  }
  if (!supabase) return false;
  const { data, error } = await supabase
    .from("subscribers")
    .select("status")
    .eq("email", email.toLowerCase())
    .single();
  if (error || !data) return false;
  return data.status === "active";
}

app.post("/api/premium-analyze", upload.single("video"), async (req, res) => {
  const email = req.body.email;
  if (!req.file) return res.status(400).json({ error: "Video file nahi mili." });
  if (!email) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: "Email zaroori hai." }); }

  const allowed = await isActiveSubscriber(email);
  if (!allowed) {
    fs.unlinkSync(req.file.path);
    return res.status(402).json({ error: "Ye email Premium subscriber nahi hai. Pehle subscribe karein." });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "Server par AI key set nahi hai." });
  }

  const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), "frames-"));
  try {
    await new Promise((resolve, reject) => {
      ffmpeg(req.file.path)
        .on("end", resolve)
        .on("error", reject)
        .screenshots({ count: 4, timemarks: ["1%", "15%", "30%", "50%"], folder: framesDir, filename: "frame-%i.png" });
    });

    const frameFiles = fs.readdirSync(framesDir).filter((f) => f.endsWith(".png"));
    const imageParts = frameFiles.map((f) => ({
      inline_data: { mime_type: "image/png", data: fs.readFileSync(path.join(framesDir, f)).toString("base64") },
    }));

    const prompt = `Aap ek TikTok content expert hain. Ye video ke shuruati frames hain (pehle 5 second). Ye batayein (Roman Urdu mein, JSON format mein):
1. "score": 0-100 ke beech ek virality score
2. "hook_feedback": pehle 3 second ka hook kaisa hai, ek chhota sentence
3. "suggestions": array of 2-3 chhote, actionable Roman Urdu suggestions
Sirf JSON return karein, kuch aur text nahi.`;

    const geminiRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }, ...imageParts] }] }
    );

    const rawText = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const cleaned = rawText.replace(/```json|```/gi, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("GEMINI_JSON_MISSING");
    const result = JSON.parse(jsonMatch[0]);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "AI analysis mein masla hua. Dobara try karein." });
  } finally {
    fs.rmSync(framesDir, { recursive: true, force: true });
    fs.unlinkSync(req.file.path);
  }
});


// ---- /api/ai-text ----
app.post("/api/ai-text", async (req, res) => {
  const { email, task, topic, caption, duration, goal } = req.body || {};
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "Server par AI key set nahi hai." });
  if (!topic) return res.status(400).json({ error: "Topic zaroori hai." });
  if (email) {
    const allowed = await isActiveSubscriber(email);
    if (!allowed) return res.status(402).json({ error: "Premium email active nahi hai. Pehle subscribe karein." });
  }
  const taskMap = {
    hooks: `Generate 8 strong TikTok hooks for the topic: ${topic}. Return concise Roman Urdu/English-friendly hooks. Avoid fake guarantees.`,
    script: `Write a TikTok script for ${topic}. Duration: ${duration || "30 seconds"}. Structure: hook, value, CTA. Keep it practical and natural.`,
    planner: `Create a 30-day TikTok content plan for niche ${topic}. Goal: ${goal || "grow followers"}. Give day number, idea, hook angle and CTA in a compact list.`,
    seo: `Optimize TikTok SEO for topic ${topic}. Existing caption: ${caption || "none"}. Return primary keyword, 5 related keywords, a description, 8 hashtags and a CTA.`,
    cta: `Generate 10 natural TikTok CTAs for topic ${topic}, optimized for ${goal || "engagement"}.`
  };
  const prompt = taskMap[task] || `Help a TikTok creator with topic ${topic}.`;
  try {
    const geminiRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] }
    );
    const text = geminiRes.data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n") || "";
    if (!text) return res.status(500).json({ error: "AI ne empty response diya." });
    res.json({ success: true, text });
  } catch (err) {
    console.error("AI text error:", JSON.stringify(err.response?.data || err.message));
    res.status(500).json({ error: "AI response mein masla hua. Thodi der baad try karein." });
  }
});

app.post("/api/create-checkout", async (req, res) => {
  const { email, plan } = req.body;
  const planId = SAFEPAY_PLANS[plan];
  const priceInfo = PLAN_PRICES[plan];

  if (!email || !planId || !priceInfo) {
    return res.status(400).json({ error: "Email aur valid plan zaroori hai." });
  }
  if (!process.env.SAFEPAY_SECRET_KEY || !process.env.SAFEPAY_PUBLIC_KEY) {
    return res.status(500).json({ error: "Payment system abhi set nahi hai." });
  }

  try {
    const amountInMinorUnits = Math.round(priceInfo.amount * 100);

    const initRes = await axios.post(
      `${SAFEPAY_BASE_URL}/order/v1/init`,
      {
        client: process.env.SAFEPAY_PUBLIC_KEY,
        amount: amountInMinorUnits,
        currency: priceInfo.currency,
        environment: "sandbox",
        order_id: `${plan}-${Date.now()}`,
        metadata: { email, plan_id: planId, plan },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.SAFEPAY_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("Safepay init response:", JSON.stringify(initRes.data));

    // Try every likely field name for the actual checkout URL/token Safepay returns
    const trackerToken = initRes.data?.data?.tracker?.token || initRes.data?.data?.token || initRes.data?.tracker;
    const directUrl =
      initRes.data?.data?.checkout_url ||
      initRes.data?.data?.url ||
      initRes.data?.data?.redirect_url ||
      initRes.data?.checkout_url;

    let checkoutUrl = directUrl;
    if (!checkoutUrl && trackerToken) {
      checkoutUrl = `https://sandbox.getsafepay.com/checkout?beacon=${trackerToken}`;
    }

    if (!checkoutUrl) {
      console.error("No checkout URL/token found in response:", JSON.stringify(initRes.data));
      return res.status(500).json({ error: "Checkout session nahi ban saki — Render logs check karein." });
    }

    if (supabase) {
      await supabase.from("subscribers").upsert({
        email: email.toLowerCase(),
        plan_id: planId,
        status: "pending",
        updated_at: new Date().toISOString(),
      });
    }

    res.json({ success: true, checkoutUrl });
  } catch (err) {
    console.error("Safepay error:", JSON.stringify(err.response?.data || err.message));
    res.status(500).json({ error: "Checkout banane mein masla hua. Thodi der baad try karein." });
  }
});

app.post("/api/safepay-webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("Safepay webhook received:", JSON.stringify(event));

    const email = event?.data?.metadata?.email || event?.data?.customer_email;
    const status = event?.data?.state === "TRACKER_ENDED" || event?.status === "success" ? "active" : "inactive";

    if (email && supabase) {
      await supabase.from("subscribers").upsert({
        email: email.toLowerCase(),
        status,
        updated_at: new Date().toISOString(),
      });
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Webhook process nahi hua." });
  }
});

app.get("/api/check-subscription", async (req, res) => {
  const email = req.query.email;
  const active = await isActiveSubscriber(email);
  res.json({ active });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "trackfyp-backend", time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`TrackFyp backend running on port ${PORT}`);
});

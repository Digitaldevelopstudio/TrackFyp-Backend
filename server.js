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

const SAFEPAY_BASE_URL = (process.env.SAFEPAY_HOST || "https://sandbox.api.getsafepay.com").replace(/\/+$/, "");

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

function isSupportedTikTokLink(value) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return host === "tiktok.com" || host.endsWith(".tiktok.com") || host === "tt.site" || host.endsWith(".tt.site");
  } catch (_) {
    return false;
  }
}

function normalizeProfileInput(value) {
  if (!value) return "";
  let input = String(value).trim();
  // Accept a plain username or @username, as well as a full profile URL.
  if (/^@?[A-Za-z0-9._]{2,50}$/.test(input)) {
    input = input.replace(/^@/, "");
    return "https://www.tiktok.com/@" + input;
  }
  return normalizeUrl(input);
}

async function resolveTikTokUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const looksShort = (host === "vt.tiktok.com" || host === "vm.tiktok.com" || host === "tt.site") || /\/(t|share)\//i.test(parsed.pathname);
    if (looksShort) {
      const response = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36" },
        maxRedirects: 10,
        timeout: 20000,
        validateStatus: status => status >= 200 && status < 400,
      });
      const finalUrl = response.request?.res?.responseUrl || response.request?._redirectable?._currentUrl || response.config?.url;
      if (finalUrl && isSupportedTikTokLink(finalUrl)) return finalUrl;
    }
  } catch (err) {
    console.error("TikTok short-link resolve failed:", err.response?.status || err.message);
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
  if (!videoUrl || !isSupportedTikTokLink(videoUrl)) {
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
  if (!videoUrl || !isSupportedTikTokLink(videoUrl)) {
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
    let durationSec = Number(item.video?.duration || 0);
    if (durationSec > 1000) durationSec = durationSec / 1000;
    durationSec = Math.round(durationSec * 10) / 10;
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
  if (!videoUrl || !isSupportedTikTokLink(videoUrl)) {
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
  const profileUrl = normalizeProfileInput(req.query.url);
  if (!profileUrl || !isSupportedTikTokLink(profileUrl) || !getTikTokHandle(profileUrl)) {
    return res.status(400).json({ error: "TikTok username ya profile link daalein (jaise @username ya tiktok.com/@username)." });
  }
  try {
    const resolvedProfileUrl = await resolveTikTokUrl(profileUrl);
    let userInfo = null;
    if (process.env.SCRAPECREATORS_API_KEY) {
      try {
        userInfo = await fetchScrapeCreatorsProfile(resolvedProfileUrl);
      } catch (err) {
        console.error("ScrapeCreators profile API failed; trying TikTok public page:", err.response?.status || err.message);
      }
    }
    if (!userInfo) userInfo = await fetchTikTokProfile(resolvedProfileUrl);
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

const COUNTRY_MAP = {"af":"AF","al":"AL","dz":"DZ","as":"AS","ad":"AD","ao":"AO","ai":"AI","aq":"AQ","ag":"AG","ar":"AR","am":"AM","aw":"AW","au":"AU","at":"AT","az":"AZ","bs":"BS","bh":"BH","bd":"BD","bb":"BB","by":"BY","be":"BE","bz":"BZ","bj":"BJ","bm":"BM","bt":"BT","bo":"BO","bq":"BQ","ba":"BA","bw":"BW","bv":"BV","br":"BR","io":"IO","bn":"BN","bg":"BG","bf":"BF","bi":"BI","cv":"CV","kh":"KH","cm":"CM","ca":"CA","ky":"KY","cf":"CF","td":"TD","cl":"CL","cn":"CN","cx":"CX","cc":"CC","co":"CO","km":"KM","ck":"CK","cr":"CR","hr":"HR","cu":"CU","cw":"CW","cy":"CY","cz":"CZ","dk":"DK","dj":"DJ","dm":"DM","do":"DO","cd":"CD","ec":"EC","eg":"EG","sv":"SV","gq":"GQ","er":"ER","ee":"EE","sz":"SZ","et":"ET","fk":"FK","fo":"FO","fj":"FJ","fi":"FI","fr":"FR","gf":"GF","pf":"PF","tf":"TF","ga":"GA","gm":"GM","ge":"GE","de":"DE","gh":"GH","gi":"GI","gr":"GR","gl":"GL","gd":"GD","gp":"GP","gu":"GU","gt":"GT","gg":"GG","gn":"GN","gw":"GW","gy":"GY","ht":"HT","hm":"HM","va":"VA","hn":"HN","hk":"HK","hu":"HU","is":"IS","in":"IN","id":"ID","ir":"IR","iq":"IQ","ie":"IE","im":"IM","il":"IL","it":"IT","ci":"CI","jm":"JM","jp":"JP","je":"JE","jo":"JO","kz":"KZ","ke":"KE","ki":"KI","kw":"KW","kg":"KG","la":"LA","lv":"LV","lb":"LB","ls":"LS","lr":"LR","ly":"LY","li":"LI","lt":"LT","lu":"LU","mo":"MO","mg":"MG","mw":"MW","my":"MY","mv":"MV","ml":"ML","mt":"MT","mh":"MH","mq":"MQ","mr":"MR","mu":"MU","yt":"YT","mx":"MX","fm":"FM","md":"MD","mc":"MC","mn":"MN","me":"ME","ms":"MS","ma":"MA","mz":"MZ","mm":"MM","na":"NA","nr":"NR","np":"NP","nl":"NL","nc":"NC","nz":"NZ","ni":"NI","ne":"NE","ng":"NG","nu":"NU","nf":"NF","kp":"KP","mk":"MK","mp":"MP","no":"NO","om":"OM","pk":"PK","pw":"PW","ps":"PS","pa":"PA","pg":"PG","py":"PY","pe":"PE","ph":"PH","pn":"PN","pl":"PL","pt":"PT","pr":"PR","qa":"QA","cg":"CG","ro":"RO","ru":"RU","rw":"RW","re":"RE","bl":"BL","sh":"SH","kn":"KN","lc":"LC","mf":"MF","pm":"PM","vc":"VC","ws":"WS","sm":"SM","st":"ST","sa":"SA","sn":"SN","rs":"RS","sc":"SC","sl":"SL","sg":"SG","sx":"SX","sk":"SK","si":"SI","sb":"SB","so":"SO","za":"ZA","gs":"GS","kr":"KR","ss":"SS","es":"ES","lk":"LK","sd":"SD","sr":"SR","sj":"SJ","se":"SE","ch":"CH","sy":"SY","tw":"TW","tj":"TJ","tz":"TZ","th":"TH","tl":"TL","tg":"TG","tk":"TK","to":"TO","tt":"TT","tn":"TN","tr":"TR","tm":"TM","tc":"TC","tv":"TV","ug":"UG","ua":"UA","ae":"AE","gb":"GB","us":"US","um":"UM","uy":"UY","uz":"UZ","vu":"VU","ve":"VE","vn":"VN","vg":"VG","vi":"VI","wf":"WF","eh":"EH","ye":"YE","zm":"ZM","zw":"ZW","ax":"AX","global":"","afghanistan":"AF","albania":"AL","algeria":"DZ","american samoa":"AS","andorra":"AD","angola":"AO","anguilla":"AI","antarctica":"AQ","antigua and barbuda":"AG","argentina":"AR","armenia":"AM","aruba":"AW","australia":"AU","austria":"AT","azerbaijan":"AZ","bahamas":"BS","bahrain":"BH","bangladesh":"BD","barbados":"BB","belarus":"BY","belgium":"BE","belize":"BZ","benin":"BJ","bermuda":"BM","bhutan":"BT","bolivia":"BO","bonaire, sint eustatius and saba":"BQ","bosnia and herzegovina":"BA","botswana":"BW","bouvet island":"BV","brazil":"BR","british indian ocean territory":"IO","brunei":"BN","bulgaria":"BG","burkina faso":"BF","burundi":"BI","cabo verde":"CV","cambodia":"KH","cameroon":"CM","canada":"CA","cayman islands":"KY","central african republic":"CF","chad":"TD","chile":"CL","china":"CN","christmas island":"CX","cocos (keeling) islands":"CC","colombia":"CO","comoros":"KM","cook islands":"CK","costa rica":"CR","croatia":"HR","cuba":"CU","curaçao":"CW","cyprus":"CY","czechia":"CZ","denmark":"DK","djibouti":"DJ","dominica":"DM","dominican republic":"DO","dr congo":"CD","ecuador":"EC","egypt":"EG","el salvador":"SV","equatorial guinea":"GQ","eritrea":"ER","estonia":"EE","eswatini":"SZ","ethiopia":"ET","falkland islands (malvinas)":"FK","faroe islands":"FO","fiji":"FJ","finland":"FI","france":"FR","french guiana":"GF","french polynesia":"PF","french southern territories":"TF","gabon":"GA","gambia":"GM","georgia":"GE","germany":"DE","ghana":"GH","gibraltar":"GI","greece":"GR","greenland":"GL","grenada":"GD","guadeloupe":"GP","guam":"GU","guatemala":"GT","guernsey":"GG","guinea":"GN","guinea-bissau":"GW","guyana":"GY","haiti":"HT","heard island and mcdonald islands":"HM","holy see (vatican city state)":"VA","honduras":"HN","hong kong":"HK","hungary":"HU","iceland":"IS","india":"IN","indonesia":"ID","iran":"IR","iraq":"IQ","ireland":"IE","isle of man":"IM","israel":"IL","italy":"IT","ivory coast":"CI","jamaica":"JM","japan":"JP","jersey":"JE","jordan":"JO","kazakhstan":"KZ","kenya":"KE","kiribati":"KI","kuwait":"KW","kyrgyzstan":"KG","laos":"LA","latvia":"LV","lebanon":"LB","lesotho":"LS","liberia":"LR","libya":"LY","liechtenstein":"LI","lithuania":"LT","luxembourg":"LU","macao":"MO","madagascar":"MG","malawi":"MW","malaysia":"MY","maldives":"MV","mali":"ML","malta":"MT","marshall islands":"MH","martinique":"MQ","mauritania":"MR","mauritius":"MU","mayotte":"YT","mexico":"MX","micronesia":"FM","moldova":"MD","monaco":"MC","mongolia":"MN","montenegro":"ME","montserrat":"MS","morocco":"MA","mozambique":"MZ","myanmar":"MM","namibia":"NA","nauru":"NR","nepal":"NP","netherlands":"NL","new caledonia":"NC","new zealand":"NZ","nicaragua":"NI","niger":"NE","nigeria":"NG","niue":"NU","norfolk island":"NF","north korea":"KP","north macedonia":"MK","northern mariana islands":"MP","norway":"NO","oman":"OM","pakistan":"PK","palau":"PW","palestine":"PS","panama":"PA","papua new guinea":"PG","paraguay":"PY","peru":"PE","philippines":"PH","pitcairn":"PN","poland":"PL","portugal":"PT","puerto rico":"PR","qatar":"QA","republic of the congo":"CG","romania":"RO","russia":"RU","rwanda":"RW","réunion":"RE","saint barthélemy":"BL","saint helena, ascension and tristan da cunha":"SH","saint kitts and nevis":"KN","saint lucia":"LC","saint martin (french part)":"MF","saint pierre and miquelon":"PM","saint vincent and the grenadines":"VC","samoa":"WS","san marino":"SM","sao tome and principe":"ST","saudi arabia":"SA","senegal":"SN","serbia":"RS","seychelles":"SC","sierra leone":"SL","singapore":"SG","sint maarten (dutch part)":"SX","slovakia":"SK","slovenia":"SI","solomon islands":"SB","somalia":"SO","south africa":"ZA","south georgia and the south sandwich islands":"GS","south korea":"KR","south sudan":"SS","spain":"ES","sri lanka":"LK","sudan":"SD","suriname":"SR","svalbard and jan mayen":"SJ","sweden":"SE","switzerland":"CH","syria":"SY","taiwan":"TW","tajikistan":"TJ","tanzania":"TZ","thailand":"TH","timor-leste":"TL","togo":"TG","tokelau":"TK","tonga":"TO","trinidad and tobago":"TT","tunisia":"TN","turkey":"TR","turkmenistan":"TM","turks and caicos islands":"TC","tuvalu":"TV","uganda":"UG","ukraine":"UA","united arab emirates":"AE","united kingdom":"GB","united states":"US","united states minor outlying islands":"UM","uruguay":"UY","uzbekistan":"UZ","vanuatu":"VU","venezuela":"VE","vietnam":"VN","virgin islands, british":"VG","virgin islands, u.s.":"VI","wallis and futuna":"WF","western sahara":"EH","yemen":"YE","zambia":"ZM","zimbabwe":"ZW","åland islands":"AX","qatar / gcc":"QA","gcc":"AE","united states of america":"US","uk":"GB","usa":"US","czech republic":"CZ","uae":"AE"};
app.get("/api/trending", async (req, res) => {
  const rawCountry = String(req.query.country || "global").trim().toLowerCase();
  const country = COUNTRY_MAP[rawCountry] !== undefined ? COUNTRY_MAP[rawCountry] : (rawCountry.length === 2 ? rawCountry.toUpperCase() : "");
  const niche = String(req.query.niche || "short-form video content").trim().slice(0, 160);
  try {
    const response = await axios.get("https://ads.tiktok.com/creative_radar_api/v1/popular_trend/hashtag/list", {
      params: { page: 1, limit: 12, period: 7, country_code: country, sort_by: "popular" },
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }, timeout: 12000
    });
    const list = response.data?.data?.list || response.data?.data?.hashtags || [];
    const trends = list.map(t => ({ hashtag: String(t.hashtag_name || t.name || t.hashtag || "").replace(/^#/, "#"), posts: t.video_views || t.publish_cnt || t.video_count || null, description: "Public trend signal from TikTok Creative Center" })).filter(t => t.hashtag);
    if (trends.length) return res.json({ success: true, source: "TikTok public trend signals", trends, disclaimer: "Public signals can change and do not guarantee reach." });
    console.warn("TikTok trend source returned no usable rows for country:", country || "global");
  } catch (err) {
    console.error("TikTok trend source unavailable:", err.response?.status || err.message);
  }
  // Honest fallback: useful AI ideas, explicitly not represented as live trend data.
  if (!process.env.GEMINI_API_KEY) return res.json({ success: true, source: "No live trend data available", trends: [], ideas: [], disclaimer: "Public trend data was unavailable and GEMINI_API_KEY is not configured." });
  try {
    const prompt = `Create 8 specific short-form video content opportunities for the market ${country || "worldwide"} and niche ${niche}. These are evergreen/AI-generated ideas, NOT verified live trends. Return only valid JSON array. Each item: {"title":"short angle","description":"why it may interest this audience","hook":"one opening hook","action":"one practical filming/publishing action"}. Do not claim current trend status, statistics, or viral guarantees. Use concise English.`;
    const ai = await geminiGenerate([{ parts: [{ text: prompt }] }], 30000);
    const raw = ai.data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n") || "";
    const clean = raw.replace(/```json|```/gi, "").trim();
    const match = clean.match(/\[[\s\S]*\]/);
    const ideas = match ? JSON.parse(match[0]) : [];
    return res.json({ success: true, source: "AI-generated content opportunities (not live trends)", trends: [], ideas, disclaimer: "These are AI-generated ideas, not verified live trending topics." });
  } catch (err) {
    console.error("Trend AI fallback failed:", err.response?.status || err.message);
    return res.json({ success: true, source: "No trend data available", trends: [], ideas: [], disclaimer: "Live public trend data and AI fallback are temporarily unavailable. Try again later." });
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
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return false;
  if (process.env.ADMIN_EMAIL && normalizedEmail === process.env.ADMIN_EMAIL.trim().toLowerCase()) return true;
  if (!supabase) return false;
  const { data, error } = await supabase
    .from("subscribers")
    .select("status, updated_at")
    .eq("email", normalizedEmail)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("Subscriber lookup failed:", error.message);
    return false;
  }
  const record = Array.isArray(data) ? data[0] : data;
  return String(record?.status || "").toLowerCase() === "active";
}

async function geminiGenerate(contents, timeout = 45000) {
  const preferred = String(process.env.GEMINI_MODEL || "gemini-3.8-flash").replace(/^models\//, "").trim();
  const models = [...new Set([preferred, "gemini-3.8-flash"])];
  let lastError;
  for (let i = 0; i < models.length; i++) {
    try {
      return await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${models[i]}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        { contents },
        { timeout }
      );
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      const detail = String(err.response?.data?.error?.message || err.message || "").toLowerCase();
      const modelProblem = status === 404 || (status === 400 && /model|not found|unsupported/.test(detail));
      if (!modelProblem || i === models.length - 1) throw err;
      console.warn(`Gemini model ${models[i]} rejected; trying fallback model.`);
    }
  }
  throw lastError || new Error("Gemini request failed");
}

function geminiUserError(err) {
  const status = err.response?.status;
  const detail = String(err.response?.data?.error?.message || err.response?.data?.error || err.message || "");
  console.error("Gemini API error:", status || "network", detail);
  if (!process.env.GEMINI_API_KEY) return "Render Environment mein GEMINI_API_KEY set nahi hai.";
  if (status === 400 || status === 404) return "Gemini model/request reject hua. Render logs mein Gemini ka exact error check karein.";
  if (status === 401 || status === 403) return "Gemini API key invalid hai ya API access enabled nahi. Render mein GEMINI_API_KEY verify karein.";
  if (status === 429) return "Gemini API quota/rate limit complete hai. Google AI Studio mein quota/billing check karein.";
  if (!status) return "Gemini API tak connection nahi hua. Render logs aur network status check karein.";
  return "Gemini AI request fail hui (HTTP " + status + "). Render logs mein details maujood hain.";
}

app.post("/api/premium-channel-analyze", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const profileUrl = normalizeProfileInput(req.body?.url);
  if (!email) return res.status(400).json({ error: "Subscription email zaroori hai." });
  if (!await isActiveSubscriber(email)) return res.status(402).json({ error: "Is email par active Premium nahi mila. Safepay wali email use karein." });
  if (!profileUrl || !isSupportedTikTokLink(profileUrl) || !getTikTokHandle(profileUrl)) {
    return res.status(400).json({ error: "TikTok profile URL ya @username sahi enter karein." });
  }
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: "Render Environment mein GEMINI_API_KEY set nahi hai." });
  try {
    const resolvedProfileUrl = await resolveTikTokUrl(profileUrl);
    let userInfo = null;
    if (process.env.SCRAPECREATORS_API_KEY) {
      try { userInfo = await fetchScrapeCreatorsProfile(resolvedProfileUrl); }
      catch (err) { console.error("Premium channel ScrapeCreators error:", err.response?.status || err.message); }
    }
    if (!userInfo) userInfo = await fetchTikTokProfile(resolvedProfileUrl);
    const stats = userInfo.stats || userInfo.statsV2 || {};
    const followers = Number(stats.followerCount) || 0;
    const following = Number(stats.followingCount) || 0;
    const likes = Number(stats.heartCount || stats.heart) || 0;
    const videos = Number(stats.videoCount) || 0;
    const avgLikes = videos > 0 ? Math.round(likes / videos) : 0;
    const user = userInfo.user || userInfo.userInfo || {};
    const username = user.uniqueId || user.unique_id || getTikTokHandle(resolvedProfileUrl) || "";
    const name = user.nickname || user.nickName || userInfo.authorName || username;
    const prompt = `You are a professional short-form video growth strategist. Audit this public TikTok profile and return a useful Premium-level report in clear Roman Urdu. Do not invent data. If metrics are missing, say so.\nProfile: @${username}; display name: ${name}; followers: ${followers}; following: ${following}; total likes: ${likes}; videos: ${videos}; approximate average likes per video (total likes divided by videos, not per-post observed average): ${avgLikes}.\nProvide: (1) executive summary, (2) 3 evidence-based strengths, (3) 3 likely growth bottlenecks, (4) 5 prioritized actions for the next 7 days, (5) 3 content series tailored to this profile, (6) engagement/follower ratio interpretation with clear limitations. No guaranteed viral claims. Keep headings and concise bullet points.`;
    const geminiRes = await geminiGenerate([{ parts: [{ text: prompt }] }], 45000);
    const analysis = geminiRes.data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n").trim() || "";
    if (!analysis) return res.status(502).json({ error: "Gemini ne analysis return nahi ki. Render logs check karein." });
    res.json({ success: true, source: userInfo.__scrapeCreators ? "ScrapeCreators API" : (userInfo.__oembed ? "TikTok oEmbed" : "TikTok public page"), username, name, metrics: { followers, following, likes, videos, avgLikes }, analysis });
  } catch (err) {
    const status = err.response?.status || 500;
    console.error("Premium channel analysis failed:", JSON.stringify(err.response?.data || err.message));
    if (err.response?.status) return res.status(status >= 500 ? 502 : status).json({ error: geminiUserError(err) });
    return res.status(500).json({ error: "Profile fetch ya AI audit fail hua. Render logs mein exact cause check karein." });
  }
});

app.post("/api/premium-analyze", (req, res, next) => {
  upload.single("video")(req, res, (err) => {
    if (err) {
      const message = err.code === "LIMIT_FILE_SIZE" ? "Video 50 MB se chhoti honi chahiye." : (err.message || "Video upload fail hua.");
      return res.status(400).json({ error: message });
    }
    next();
  });
}, async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!req.file) return res.status(400).json({ error: "Video file nahi mili." });
  if (!email) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: "Email zaroori hai." }); }

  const allowed = await isActiveSubscriber(email);
  if (!allowed) {
    fs.unlinkSync(req.file.path);
    return res.status(402).json({ error: "Ye email Premium subscriber nahi hai. Pehle subscribe karein." });
  }
  if (!process.env.GEMINI_API_KEY) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(503).json({ error: "Render Environment mein GEMINI_API_KEY set nahi hai." });
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

    const geminiRes = await geminiGenerate([{ parts: [{ text: prompt }, ...imageParts] }], 60000);

    const rawText = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const cleaned = rawText.replace(/```json|```/gi, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("GEMINI_JSON_MISSING");
    const result = JSON.parse(jsonMatch[0]);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Premium video analysis error:", JSON.stringify(err.response?.data || err.message));
    if (err.response?.status) return res.status(err.response.status === 429 ? 429 : 502).json({ error: geminiUserError(err) });
    res.status(500).json({ error: "Video frames ya AI analysis process nahi ho saka. Render logs check karein." });
  } finally {
    fs.rmSync(framesDir, { recursive: true, force: true });
    fs.unlinkSync(req.file.path);
  }
});


// ---- /api/ai-text ----
app.post("/api/ai-text", async (req, res) => {
  const { email, task, topic, caption, duration, goal, videoUrl } = req.body || {};
  if (!email) return res.status(400).json({ error: "Subscription email zaroori hai." });
  if (!await isActiveSubscriber(email)) return res.status(402).json({ error: "Is email par active Premium nahi mila. Safepay wali email use karein." });
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: "Render Environment mein GEMINI_API_KEY set nahi hai." });
  if (!topic && !(task === "seo" && videoUrl)) return res.status(400).json({ error: "Topic ya public TikTok video link zaroori hai." });
  let videoContext = "";
  if (task === "seo" && videoUrl) {
    const normalizedVideoUrl = normalizeUrl(String(videoUrl).trim());
    if (!isSupportedTikTokLink(normalizedVideoUrl)) return res.status(400).json({ error: "Valid public TikTok video link enter karein." });
    try {
      const item = await fetchTikTokItem(normalizedVideoUrl);
      const stats = item.stats || item.statistics || {};
      const author = item.author || {};
      videoContext = `\nPublic TikTok video context (metadata only; no claim that visual content was watched): URL=${normalizedVideoUrl}; creator=@${author.uniqueId || author.unique_id || "unknown"}; caption/title=${String(item.desc || item.title || "").slice(0, 1500)}; views=${stats.playCount ?? stats.play_count ?? "unavailable"}; likes=${stats.diggCount ?? stats.digg_count ?? "unavailable"}; comments=${stats.commentCount ?? stats.comment_count ?? "unavailable"}; shares=${stats.shareCount ?? stats.share_count ?? "unavailable"}.`;
    } catch (err) {
      console.error("Video SEO metadata lookup failed:", err.response?.status || err.message);
      return res.status(502).json({ error: "TikTok link ka public metadata fetch nahi ho saka. Public full video URL try karein ya topic/caption manually enter karein." });
    }
  }
  const topicForPrompt = topic || "the linked TikTok video";
  const taskMap = {
    hooks: `Generate 8 strong TikTok hooks for the topic: ${topic}. Return concise Roman Urdu/English-friendly hooks. Avoid fake guarantees.`,
    script: `Write a TikTok script for ${topic}. Duration: ${duration || "30 seconds"}. Structure: hook, value, CTA. Keep it practical and natural.`,
    planner: `Create a 30-day TikTok content plan for niche ${topic}. Goal: ${goal || "grow followers"}. Give day number, idea, hook angle and CTA in a compact list.`,
    seo: `Act as a TikTok SEO strategist. Optimize the linked video/topic ${topicForPrompt}. Existing caption: ${caption || "none"}.${videoContext} Return: observed metadata summary (only if available), primary search keyword, 5 related keywords, SEO-friendly caption/description, 8 relevant hashtags, a CTA, 3 specific growth improvements, and a short note explaining that metadata-only analysis cannot judge visuals or retention. Do not invent unavailable metrics or claim to have watched the video.`,
    cta: `Generate 10 natural TikTok CTAs for topic ${topic}, optimized for ${goal || "engagement"}.`,
    ideas: `Create 15 differentiated TikTok content ideas for niche ${topic}. For each idea include a short title, hook angle, format, and CTA. Avoid generic repeats and fake trends.`,
    trends: `For niche ${topic}, suggest 10 trend-inspired short-form content angles that can be adapted to the creator's own style. Do not claim these are live trending topics unless current data is provided.`
  };
  const prompt = taskMap[task] || `Help a TikTok creator with topic ${topic}.`;
  try {
    const geminiRes = await geminiGenerate([{ parts: [{ text: prompt }] }], 45000);
    const text = geminiRes.data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n") || "";
    if (!text) return res.status(500).json({ error: "AI ne empty response diya." });
    res.json({ success: true, text });
  } catch (err) {
    res.status(err.response?.status === 429 ? 429 : 502).json({ error: geminiUserError(err) });
  }
});

app.post("/api/create-checkout", async (req, res) => {
  const { email, plan } = req.body || {};
  const planId = SAFEPAY_PLANS[plan];
  const priceInfo = PLAN_PRICES[plan];

  if (!email || !planId || !priceInfo) {
    return res.status(400).json({ error: "Email aur valid plan zaroori hai." });
  }
  if (!process.env.SAFEPAY_SECRET_KEY) {
    return res.status(500).json({ error: "Safepay Secret Key Render par set nahi hai." });
  }

  try {
    // Safepay recurring subscriptions use a short-lived auth token and the
    // /checkout/auth/login URL. They do not use /order/v1/init or a tracker fallback.
    const authRes = await axios.post(
      `${SAFEPAY_BASE_URL}/client/passport/v1/token`,
      {},
      {
        headers: {
          "X-SFPY-MERCHANT-SECRET": process.env.SAFEPAY_SECRET_KEY,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      }
    );

    const authToken = authRes.data?.data;
    if (!authToken || typeof authToken !== "string") {
      console.error("Safepay auth token response did not contain data:", JSON.stringify(authRes.data));
      return res.status(502).json({ error: "Safepay checkout token nahi mila. Render logs check karein." });
    }

    const frontendUrl =
      (process.env.FRONTEND_URL || process.env.APP_URL || "https://digitaldevelopstudio.github.io/TrackFyp")
        .trim()
        .replace(/\/+$/, "");
    const safepayEnvironment = (process.env.SAFEPAY_ENV || "sandbox").trim().toLowerCase();
    // Use Safepay's documented checkout hosts; do not trust a stale/mistyped host env var.
    const checkoutHost =
      safepayEnvironment === "production"
        ? "https://getsafepay.com"
        : "https://sandbox.api.getsafepay.com";

    const params = new URLSearchParams({
      plan_id: planId,
      auth_token: authToken,
      env: safepayEnvironment,
      redirect_url: `${frontendUrl}/?subscription=success`,
      cancel_url: `${frontendUrl}/?subscription=cancelled`,
    });

    const checkoutUrl = `${checkoutHost}/checkout/auth/login?${params.toString()}`;

    // Save pending status for UI/history only. Premium access must be granted
    // only after Safepay confirms subscription.payment.succeeded via webhook.
    if (supabase) {
      const { error: dbError } = await supabase.from("subscribers").upsert({
        email: email.toLowerCase(),
        plan_id: planId,
        status: "pending",
        updated_at: new Date().toISOString(),
      });
      if (dbError) {
        console.error("Could not save pending subscriber:", dbError.message);
      }
    }

    res.json({ success: true, checkoutUrl });
  } catch (err) {
    console.error("Safepay subscription checkout error:", JSON.stringify(err.response?.data || err.message));
    res.status(500).json({
      error: "Safepay subscription checkout nahi ban saki. Render logs mein error check karein.",
    });
  }
});

app.post("/api/safepay-webhook", async (req, res) => {
  try {
    const event = req.body || {};
    const eventType = String(event.type || event.event_type || "").toLowerCase();
    const data = event.data || {};
    console.log("Safepay webhook received:", JSON.stringify({ type: eventType, data }));

    // Safepay subscription events identify the customer with customer_email.
    // Never activate access from a checkout redirect or subscription.created alone.
    const email = String(data.metadata?.email || data.customer_email || "").trim().toLowerCase();
    let status = null;

    if (eventType === "subscription.payment.succeeded") {
      status = "active";
    } else if (
      eventType === "subscription.payment.failed" ||
      eventType === "subscription.cancelled" ||
      eventType === "subscription.canceled" ||
      eventType === "subscription.ended" ||
      eventType === "subscription.paused"
    ) {
      status = "inactive";
    } else if (eventType === "subscription.created") {
      // The initial subscription may be INCOMPLETE until payment is authorized.
      status = String(data.status || "").toUpperCase() === "ACTIVE" ? "active" : "pending";
    }

    if (email && status && supabase) {
      const { error } = await supabase.from("subscribers").upsert({
        email,
        status,
        updated_at: new Date().toISOString(),
      }, { onConflict: "email" });
      if (error) {
        console.error("Could not update subscriber from Safepay webhook:", error.message);
        return res.status(500).json({ error: "Subscriber record update nahi hua." });
      }
    } else if (!email) {
      console.warn("Safepay webhook has no customer email; cannot map it to a TrackFyp account.");
    } else if (!status) {
      console.log("Safepay event does not change Premium access:", eventType || "unknown event");
    } else if (!supabase) {
      console.error("Supabase is not configured; Premium access cannot be updated.");
      return res.status(500).json({ error: "Database configured nahi hai." });
    }

    res.status(200).json({ received: true, eventType, status: status || "ignored" });
  } catch (err) {
    console.error("Safepay webhook error:", err.message);
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
